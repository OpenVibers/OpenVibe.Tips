'use strict';

/**
 * chat adapter: posts a paid effect into the creator's chat room through OpenVibe.Chat's typed
 * ingress (OpenVibe.Chat docs/chat-ingress.md), with Tips' service token (audience openvibe.chat).
 *
 *   chat_line, paid_message  POST ${TIPS_CHAT_URL}/internal/chat/messages  (chat.message.send)
 *                              a `donation` line in the creator's channel, mirrored to global chat
 *                            POST ${TIPS_CHAT_URL}/internal/chat/events    (chat.event.publish)
 *                              the channel's donation alert sound (`alert` frame, kind donation)
 *   tts                      POST /internal/chat/messages with tts: { voice }: Chat saves a `tts` line
 *                              and reads it aloud
 *   media_request            none: the media queue is not Chat's, so the effect fails at once
 *
 * Every body carries `key` = the effect's delivery id (`<interaction>:<effect>`; the alert
 * `<delivery id>:alert`). Chat applies a key once per principal and answers a repeat with the first
 * result, so the effects worker's retry after a lost answer or a 5xx never posts twice.
 *
 * Chat's rooms are Live's ids: the creator's channel is their Live user id, read once from the
 * Network's identity map (GET /internal/identity/resolve, identity.subject.resolve) and kept for
 * ROOM_TTL_MS. A creator with no Live account has no room: the effect fails at once.
 *
 * Chat refuses a bad body with a 4xx and asks for a retry with the same key with a 5xx (503 while
 * another Chat process holds the delivery). 4xx answers other than 401/408/425/429 are permanent;
 * everything else is retried by the effects worker. A refused alert does not undo the line.
 */
const { serviceAuth } = require('openvibe-contracts');

const ROOM_TTL_MS = 10 * 60_000;
const RETRYABLE = [401, 408, 425, 429];

function createChatAdapter(config, { fetchImpl = globalThis.fetch, tokenClients = {} } = {}) {
    const tokens = { ...tokenClients };
    const client = (audience, scope) => {
        if (!tokens[audience]) {
            tokens[audience] = serviceAuth.createTokenClient({
                tokenUrl: `${config.network.internalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
                audience, scope, fetchImpl,
            });
        }
        return tokens[audience];
    };
    const chatTokens = () => client(config.chat.audience, 'chat.message.send chat.event.publish');
    const networkTokens = () => client(config.network.audience, 'identity.subject.resolve');
    const rooms = new Map();

    function refused(who, status, body) {
        const e = new Error(`${who} ${status}: ${(body && (body.error || body.detail || body.code)) || 'refused'}`);
        e.permanent = status >= 400 && status < 500 && !RETRYABLE.includes(status);
        return e;
    }

    async function call(who, tokenClient, url, init, retried = false) {
        let res;
        try {
            res = await fetchImpl(url, { ...init, headers: { Accept: 'application/json', ...init.headers, ...(await tokenClient.authHeaders()) }, signal: AbortSignal.timeout(10000) });
        } catch (e) {
            throw new Error(`${who} unreachable: ${e.message}`);
        }
        if (res.status === 401 && !retried) { tokenClient.invalidate(); return await call(who, tokenClient, url, init, true); }
        const body = await res.json().catch(() => null);
        return { status: res.status, ok: res.ok, body };
    }

    /** The creator's Chat room: their Live user id, from the Network's identity map. */
    async function roomOf(subject) {
        const hit = rooms.get(subject);
        if (hit && hit.until > Date.now()) return hit.id;
        const r = await call('Network', networkTokens(), `${config.network.internalUrl}/internal/identity/resolve?subject_id=${encodeURIComponent(subject)}`, { method: 'GET' });
        if (!r.ok && r.status !== 404) throw refused('Network', r.status, r.body);
        const live = r.ok && (r.body.legacy_ids || []).find((x) => x.source_system === 'live' && x.source_type === 'user');
        const id = live ? Number(live.source_id) : 0;
        if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('this creator has no Live channel for Chat to post in'), { permanent: true });
        rooms.set(subject, { id, until: Date.now() + ROOM_TTL_MS });
        return id;
    }

    async function post(family, body) {
        const r = await call('Chat', chatTokens(), `${config.chat.url}/internal/chat/${family}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!r.ok) throw refused('Chat', r.status, r.body);
        return r.body || {};
    }

    /** The R1 body of a job (the same on every attempt, so Chat's key replay matches it). */
    function message(job, channel) {
        const i = job.interaction;
        const name = job.supporter.name;
        if (job.effect === 'tts') {
            return {
                key: job.delivery_id, channel_user_id: channel, username: name, message: job.tts.text, message_type: 'tts', source_platform: 'tips',
                tts: { voice: job.tts.voice || null, identity_key: `tips:${i.id}`, key: `tips-${i.id}` },
                metadata: { kind: 'tts', source: 'tips', interaction_id: i.id, test: job.test },
            };
        }
        const paid = job.effect === 'paid_message';
        return {
            key: job.delivery_id, channel_user_id: channel, username: name, message: job.text, message_type: 'donation', source_platform: 'tips', mirror: true,
            metadata: {
                kind: 'donation', source: 'tips', amount: i.amount, message: i.message || '', username: name, interaction_id: i.id,
                paid_message: paid, highlight_seconds: paid ? job.highlight_seconds || 0 : 0, test: job.test,
            },
        };
    }

    async function deliver(job) {
        if (!['chat_line', 'paid_message', 'tts'].includes(job.effect)) {
            throw Object.assign(new Error(`OpenVibe.Chat has no ${job.effect} route`), { permanent: true });
        }
        if (job.effect === 'tts' && !(job.tts && job.tts.text)) throw Object.assign(new Error('no TTS text'), { permanent: true });
        const channel = await roomOf(job.creator.id);
        const sent = await post('messages', message(job, channel));
        const ref = { chat_message_id: sent.id != null ? sent.id : null };
        if (job.effect !== 'tts') {
            try {
                await post('events', { key: `${job.delivery_id}:alert`, target: { kind: 'channel', id: channel }, frame: { type: 'alert', streamerId: channel, kind: 'donation' } });
                ref.alert = true;
            } catch (e) {
                if (!e.permanent) throw e;   // retried: the line replays under its key, the alert is sent
                ref.alert = false;
            }
        }
        return { ref };
    }

    return { name: 'chat', deliver };
}

module.exports = { createChatAdapter };

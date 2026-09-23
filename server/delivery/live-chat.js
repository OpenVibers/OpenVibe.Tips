'use strict';

/**
 * live-chat adapter: posts a paid effect into a creator's OpenVibe.Live chat through Live's
 * existing donation path.
 *
 *   POST ${LIVE_INTERNAL_URL}/internal/tips/deliveries
 *   Authorization: Bearer <Tips service token, audience openvibe.live, capability live.tips_delivery.write>
 *   Idempotency-Key: <delivery_id>          (Live answers a repeat with the first result)
 *   body: the job (server/delivery/index.js)
 *   → 200 { ok: true, ref: { chat_message_id?, media_request_id? } }
 *
 * Live has no such route today: docs/live-patch.diff adds it (server/tips/delivery-routes.js,
 * loopback-only like every /internal route, guarded by Live's service-guard). Live maps the creator
 * subject to its channel through linked_accounts and then does exactly what POST /api/funds/donate
 * does after the money moved: broadcastToChannelRoom + broadcastGlobal of the donation event,
 * saveChatMessage(message_type 'donation'), the donation alert sound; TTS through
 * synthesizeAndBroadcastTTS; media requests into its media queue at no charge (Billing already
 * charged). When OpenVibe.Chat publishes a paid-message capability, a `chat` adapter replaces this.
 *
 * 4xx answers other than 408/409/425/429 are permanent (the effect fails at once); everything
 * else is retried by the effects worker.
 */
const { serviceAuth } = require('openvibe-contracts');

function createLiveChatAdapter(config, { fetchImpl = globalThis.fetch, tokenClient } = {}) {
    let tokens = tokenClient || null;
    const client = () => {
        if (!tokens) {
            tokens = serviceAuth.createTokenClient({
                tokenUrl: `${config.network.internalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
                audience: config.chat.liveAudience, scope: 'live.tips_delivery.write', fetchImpl,
            });
        }
        return tokens;
    };

    async function deliver(job, retried = false) {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'Idempotency-Key': job.delivery_id, ...(await client().authHeaders()) };
        let res;
        try {
            res = await fetchImpl(`${config.chat.liveUrl}/internal/tips/deliveries`, { method: 'POST', headers, body: JSON.stringify(job), signal: AbortSignal.timeout(10000) });
        } catch (e) {
            throw new Error(`Live unreachable: ${e.message}`);
        }
        if (res.status === 401 && !retried) { client().invalidate(); return deliver(job, true); }
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            const e = new Error(`Live ${res.status}: ${(body && (body.detail || body.error || body.code)) || 'refused'}`);
            e.permanent = res.status >= 400 && res.status < 500 && ![401, 408, 409, 425, 429].includes(res.status);
            throw e;
        }
        return { ref: (body && body.ref) || null };
    }

    return { name: 'live-chat', deliver };
}

module.exports = { createLiveChatAdapter };

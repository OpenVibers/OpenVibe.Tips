'use strict';

/**
 * Tip interactions — the product record of one act of support.
 *
 * Two independent state machines (roadmap §15.11: "payment settled" is not "interaction delivered"):
 *
 *   payment_state   pending ──► settled ──► reversed          mirrored from Billing, keyed by the
 *                          └──► failed                          Billing transaction id (UNIQUE)
 *   delivery_state  awaiting_payment ──► queued ──► delivered | failed | cancelled
 *
 * How money reaches Billing (Tips never moves it, ADR-012):
 *   funding credit    POST /transfers (supporter credit → creator payable, target = this interaction,
 *                     Idempotency-Key tips:transfer:<id>). The response settles it at once; the
 *                     billing.transaction.settled event for the same transaction is then a no-op.
 *   funding checkout  POST /intents (the supporter buys exactly the credit they give,
 *                     Idempotency-Key tips:intent:<id>) → checkout URL. When the purchase settles
 *                     (event, metadata.intent_id), the transfer above runs — CREDIT becomes MONEY only
 *                     by giving it to someone else.
 *   origin billing    a donation settled in Billing that Tips did not start (Live's own donate flow,
 *                     a site-routed PowerChat tip) is recorded once, by its Billing transaction id.
 *   external          a tip on the creator's own PowerChat account: no Billing liability; recorded
 *                     once by (provider, provider_ref); never part of the Billing reconciliation.
 *                     Two ways in: POST /interactions/external (a service records it), or Billing's
 *                     billing.receipt.external once Billing receives the PowerChat webhook — then
 *                     nobody else announces it, so Tips delivers the chat line itself (origin
 *                     'billing-external'), exactly as Live's webhook did: chat line + alert, goal.
 *   simulated         the whole effect path with test = 1: no Billing call, no goal contribution,
 *                     no durable event, excluded from every total.
 *
 * Settlement creates, in one transaction: the paid message / TTS / media request row, the goal
 * contribution, the overlay alert, the delivery effects and tips.interaction.ready. Delivery then
 * runs in the effects worker; its failure never touches payment_state.
 *
 * Every transaction that changes money state (a request and its pending-checkout limit, settlement,
 * failure, funding, reversal) is SERIALIZABLE (ctx.MONEY) and locks the interaction row first
 * (SELECT … FOR UPDATE), then the goals it counts toward: ADR-007 amendment 2026-09-24, rule 3.
 *
 * Privacy (privacy.js): the supporter's choices are stored with the interaction (anonymous,
 * hide_amount, private_message); everything that leaves Tips for the public is publicView(), and
 * events and answers to anyone but the supporter never name an anonymous supporter. A supporter can
 * export their tips and erase their data from them (erase(): the money record stays, the person
 * goes; tips.interaction.erased redacts the earlier events in OpenVibe.Events).
 */
const { sql } = require('openvibe-sdk/db');
const { fail, iso, prefixedId, positiveInt, text, storable, userSubject, entityRef, displayName, readCursor, cursorOf, INVISIBLE } = require('../util');
const { VOICES } = require('./profiles');
const { parsePrivacy, publicName, shownName, privacyOf, isAnonymous, publicView, ANONYMOUS } = require('./privacy');
const { BillingCallError } = require('../billing-client');

const KINDS = ['tip', 'paid_message', 'tts', 'media_request'];
// Origins whose chat effects Tips delivers: its own requests, and EXTERNAL tips Billing announced
// (their only announcement since the PowerChat webhook moved from Live to Billing).
const ANNOUNCED_HERE = ['tips', 'billing-external'];
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_EXTERNAL_CENTS = 100_000_000;   // Billing's per-receipt maximum
// Paid-message highlight time by amount (bits): the bigger the message, the longer it stays up.
const HIGHLIGHT = [[5000, 300], [1000, 120], [500, 60], [100, 30]];
const highlightFor = (bits) => (HIGHLIGHT.find(([min]) => bits >= min) || [0, 0])[1];
const TRANSFER_BACKOFF = [2000, 10000, 30000, 60000, 300000, 600000];
// Due transfers are claimed in small batches with a lease: a Billing call takes up to 10 s (twice
// with a token refresh), so a batch finishes well inside the lease, and a process that dies with a
// claimed batch leaves it to the others once the lease ends.
const TRANSFER_BATCH = 10;
const TRANSFER_LEASE_MS = 5 * 60_000;
const COLUMNS = ['id', 'creator_subject', 'supporter_subject', 'supporter_name', 'kind', 'amount', 'amount_cents', 'message', 'request',
    'funding', 'settlement', 'payment_state', 'delivery_state', 'test', 'billing_txn_id', 'billing_intent_id', 'funding_txn_id', 'provider', 'provider_ref',
    'idempotency_key', 'origin', 'target', 'anonymous', 'hide_amount', 'private_message', 'created_at', 'updated_at'];

function createInteractions(ctx) {
    const { db, config, MONEY } = ctx;

    const get = (q, id) => q.maybe(sql`SELECT * FROM tip_interactions WHERE id = ${String(id || '')}`);
    /** Inside a transaction: the interaction row, locked (the first lock any transaction takes). */
    const lock = (t, id) => t.maybe(sql`SELECT * FROM tip_interactions WHERE id = ${String(id || '')} FOR UPDATE`);
    const byBillingTxn = (q, txnId) => q.maybe(sql`SELECT * FROM tip_interactions WHERE billing_txn_id = ${txnId}`);

    // ── Input rules (the creator's settings) ─────────────────
    // Plain words only: no control or invisible characters, no links, no markup a speech engine could
    // take as SSML.
    function cleanTts(s) {
        return storable(s || '').replace(INVISIBLE, '').replace(/[\u0000-\u001f]/g, ' ').replace(/https?:\/\/\S+/gi, 'link').replace(/[<>]/g, ' ')
            .replace(/\s+/g, ' ').trim();
    }

    /** A supporter may not show up under the creator's own name or handle (impersonation on stream). */
    function checkName(profile, name) {
        const fold = (v) => String(v || '').normalize('NFKC').replace(/^@/, '').trim().toLowerCase();
        const n = fold(name);
        if (n && (n === fold(profile.display_name) || n === fold(profile.handle))) fail(422, 'tips.name_taken', `"${name}" is ${profile.display_name}'s own name; choose another to show`);
    }

    function mediaUrl(v) {
        let u;
        try { u = new URL(String(v || '')); } catch { fail(422, 'tips.invalid_media', 'media.url must be a link'); }
        if (u.protocol !== 'https:') fail(422, 'tips.invalid_media', 'media.url must be an https link');
        if (!config.mediaHosts.includes(u.hostname.toLowerCase())) fail(422, 'tips.invalid_media', `media requests accept links from ${config.mediaHosts.join(', ')}`);
        const s = u.toString();
        if (s.length > 500) fail(422, 'tips.invalid_media', 'media.url is too long');
        return { url: s, provider: /youtu/.test(u.hostname) ? 'youtube' : u.hostname };
    }

    /**
     * Validate a request against the creator's profile. Returns the normalised fields:
     * { kind, amount, message, request: { goal_id, tts, media, highlight_seconds } }.
     */
    async function validate(q, profile, input, { simulation = false } = {}) {
        if (!profile) fail(404, 'tips.creator_not_found', 'this creator has no tip page');
        if (!profile.accepting && !simulation) fail(409, 'tips.not_accepting', `${profile.display_name} is not accepting tips right now`);
        const kind = input.kind || 'tip';
        if (!KINDS.includes(kind)) fail(422, 'tips.invalid_input', `kind must be one of ${KINDS.join(', ')}`);
        const amount = positiveInt(input.amount, 'amount', config.limits.maxBits);
        const message = text(input.message, 'message', config.limits.messageChars);
        const request = {};
        const min = (n, what) => { if (amount < n) fail(422, 'tips.amount_too_small', `the minimum for ${what} is ${n} Vibes`); };
        min(profile.min_amount, 'a tip');
        if (kind === 'paid_message') {
            min(profile.paid_message_min, 'a paid message');
            if (!message) fail(422, 'tips.invalid_input', 'a paid message needs a message');
            request.highlight_seconds = highlightFor(amount);
        }
        if (kind === 'tts') {
            if (!profile.tts_enabled) fail(409, 'tips.tts_disabled', `${profile.display_name} has text-to-speech switched off`);
            min(profile.tts_min_amount, 'text-to-speech');
            const raw = input.tts && input.tts.text != null ? input.tts.text : message;
            const t = cleanTts(raw);
            if (!t || t.startsWith('.')) fail(422, 'tips.invalid_input', 'text-to-speech needs text to read');
            if (t.length > profile.tts_max_chars) fail(422, 'tips.text_too_long', `text-to-speech is limited to ${profile.tts_max_chars} characters here`);
            const voice = input.tts && input.tts.voice ? String(input.tts.voice) : profile.tts_voice;
            if (!VOICES.includes(voice)) fail(422, 'tips.invalid_input', `voice must be one of ${VOICES.join(', ')}`);
            request.tts = { text: t, voice };
        }
        if (kind === 'media_request') {
            if (!profile.media_requests_enabled) fail(409, 'tips.media_disabled', `${profile.display_name} is not taking media requests`);
            min(profile.media_request_min, 'a media request');
            request.media = { ...mediaUrl(input.media && input.media.url), max_seconds: profile.media_max_seconds };
        }
        if (input.goal_id) {
            const g = await ctx.goals.get(q, input.goal_id);
            if (!g || g.creator_subject !== profile.creator_subject || g.status !== 'active') fail(422, 'tips.goal_not_found', 'that goal is not open on this page');
            request.goal_id = g.id;
        }
        return { kind, amount, message, request };
    }

    // ── Creation ─────────────────────────────────────────────
    async function insert(q, row) {
        const at = iso(ctx.now());
        const r = {
            supporter_subject: null, supporter_name: null, amount_cents: null, message: null, request: {}, test: false, billing_txn_id: null,
            billing_intent_id: null, funding_txn_id: null, provider: null, provider_ref: null, idempotency_key: null,
            target: null, origin: 'tips', anonymous: false, hide_amount: false, private_message: false, created_at: at, ...row,
        };
        const values = {
            ...r, request: sql.json(r.request || {}), target: r.target ? sql.json(r.target) : null, test: !!r.test,
            anonymous: !!r.anonymous, hide_amount: !!r.hide_amount, private_message: !!r.private_message, updated_at: r.created_at,
        };
        return q.one(sql`INSERT INTO tip_interactions ${sql.insert([values], COLUMNS)} RETURNING *`);
    }

    /**
     * A supporter's request (checkout or credit). Idempotent by `idempotencyKey` (the caller's key,
     * scoped to the caller): a repeat returns the interaction it created the first time. Serializable:
     * the unpaid-checkout count and the new row are one decision.
     */
    async function request(profile, input, { supporter, supporterName, funding, idempotencyKey }) {
        const v = await validate(db, profile, input);
        const from = userSubject(supporter, 'supporter');
        if (from === profile.creator_subject) fail(422, 'tips.self_dealing', 'you cannot tip yourself');
        if (!['credit', 'checkout'].includes(funding)) fail(422, 'tips.invalid_input', "pay_with must be 'credit' or 'checkout'");
        if (funding === 'checkout' && v.amount < config.billing.minPurchaseBits) {
            fail(422, 'tips.amount_too_small', `paying by checkout starts at ${config.billing.minPurchaseBits} Vibes; smaller tips use your Vibes balance`);
        }
        const target = entityRef(input.target);
        const privacy = parsePrivacy(input.privacy, v.kind);
        if (!privacy.anonymous) checkName(profile, displayName(supporterName));
        return ctx.tx(async (t) => {
            if (idempotencyKey) {
                const prev = await t.maybe(sql`SELECT * FROM tip_interactions WHERE idempotency_key = ${idempotencyKey}`);
                if (prev) return { interaction: prev, replay: true };
            }
            if (funding === 'checkout') {
                // Each unpaid checkout is a Billing intent and a row here: bounded per supporter.
                const since = iso(ctx.now() - 24 * 3600 * 1000);
                const open = await t.value(sql`SELECT count(*) FROM tip_interactions WHERE supporter_subject = ${from} AND funding = 'checkout'
                    AND payment_state = 'pending' AND created_at >= ${since}`);
                if (open >= config.limits.pendingCheckouts) fail(429, 'tips.too_many_pending', `you have ${open} unpaid checkouts; finish or wait for them before starting another`);
            }
            const i = await insert(t, {
                id: prefixedId('tint', ctx.now()), creator_subject: profile.creator_subject, supporter_subject: from, supporter_name: displayName(supporterName) || 'Someone',
                kind: v.kind, amount: v.amount, message: v.message, request: v.request, funding, settlement: 'billing', payment_state: 'pending',
                delivery_state: 'awaiting_payment', idempotency_key: idempotencyKey || null, target,
                ...privacy, private_message: privacy.private_message && !!v.message,
            });
            return { interaction: i, replay: false };
        }, MONEY);
    }

    // ── Paying through Billing ───────────────────────────────
    const transferKind = (i) => (i.kind === 'tip' ? 'tip' : 'paid_interaction');

    /** Try the Billing transfer now; retryable failures leave it due for the jobs loop. */
    async function transfer(i, { traceparent } = {}) {
        try {
            const out = await ctx.billing.createTransfer({
                from: i.supporter_subject, to: i.creator_subject, amount: i.amount, kind: transferKind(i),
                target: { service: 'tips', type: 'interaction', id: i.id }, message: i.message || undefined,
                key: `tips:transfer:${i.id}`, traceparent,
            });
            const txn = out.transaction;
            await ctx.tx(async (t) => await settleByTransaction(t, await lock(t, i.id), { id: txn.id, test: !!txn.test }), MONEY);
            return { settled: true };
        } catch (e) {
            if (e instanceof BillingCallError && !e.retryable) {
                await ctx.tx(async (t) => await failPayment(t, await lock(t, i.id), e.code || 'billing.refused', e.message), MONEY);
                return { settled: false, refused: e.code, detail: e.body && e.body.detail };
            }
            // Due again after the attempt's backoff (TRANSFER_BACKOFF[attempts - 1], the last one repeating).
            await db.exec(sql`UPDATE tip_interactions SET transfer_due = true, transfer_attempts = transfer_attempts + 1,
                    next_transfer_at = ${ctx.now()} + (${TRANSFER_BACKOFF}::bigint[])[LEAST(transfer_attempts + 1, ${TRANSFER_BACKOFF.length})],
                    failure = ${String(e.message).slice(0, 300)}, updated_at = ${iso(ctx.now())}
                WHERE id = ${i.id} AND payment_state = 'pending'`);
            ctx.log.warn(`[Tips] transfer for ${i.id} will be retried: ${e.message}`);
            return { settled: false, retrying: true };
        }
    }

    async function startCheckout(i, { provider, traceparent }) {
        const p = String(provider || config.billing.providers[0] || '').toLowerCase();
        if (!config.billing.providers.includes(p)) fail(422, 'tips.invalid_input', `provider must be one of ${config.billing.providers.join(', ') || '(none configured)'}`);
        let out;
        try {
            out = await ctx.billing.createIntent({
                provider: p, subject: i.supporter_subject, bits: i.amount,
                successUrl: `${config.baseUrl}/receipts/${i.id}`, cancelUrl: `${config.baseUrl}/receipts/${i.id}?cancelled=1`,
                key: `tips:intent:${i.id}`, traceparent,
            });
        } catch (e) {
            if (e instanceof BillingCallError && !e.retryable) {
                await ctx.tx(async (t) => await failPayment(t, await lock(t, i.id), e.code || 'billing.refused', e.message), MONEY);
                fail(e.status === 409 ? 409 : 422, e.code || 'billing.refused', (e.body && e.body.detail) || 'Billing refused the checkout');
            }
            fail(502, 'tips.billing_unavailable', 'checkout is unavailable right now; nothing was charged — try again shortly');
        }
        const intent = out.intent || {};
        let url = out.checkout_url || null;
        const ref = intent.checkout_ref || null;
        if (!url && ref && p === 'powerchat' && config.billing.powerchatLinkTemplate) {
            url = config.billing.powerchatLinkTemplate.replace('{ref}', encodeURIComponent(ref)).replace('{cents}', String(intent.amount_cents || '')).replace('{bits}', String(i.amount));
        }
        // Pages link and redirect to it: only an https URL is ever kept.
        if (url && !/^https:\/\/[^\s"'<>]+$/.test(url)) url = null;
        const row = await db.one(sql`UPDATE tip_interactions SET billing_intent_id = ${intent.id || null}, checkout_url = ${url}, checkout_ref = ${ref}, provider = ${p},
            updated_at = ${iso(ctx.now())} WHERE id = ${i.id} RETURNING *`);
        return { interaction: row, checkout_url: url, checkout_ref: ref, intent };
    }

    /**
     * Due transfers (credit retries and funded checkouts). Called by the jobs loop in every process:
     * each batch is claimed with a lease (FOR UPDATE SKIP LOCKED), so no two processes try one at once.
     */
    async function processDueTransfers() {
        const now = ctx.now();
        const rows = await db.many(sql`UPDATE tip_interactions SET next_transfer_at = ${now + TRANSFER_LEASE_MS}
            WHERE id IN (SELECT id FROM tip_interactions WHERE payment_state = 'pending' AND transfer_due AND next_transfer_at <= ${now}
                         ORDER BY next_transfer_at LIMIT ${TRANSFER_BATCH} FOR UPDATE SKIP LOCKED)
            RETURNING *`);
        rows.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
        let settled = 0;
        for (const i of rows) { const r = await transfer(i); if (r.settled) settled++; }
        return { attempted: rows.length, settled };
    }

    // ── Settlement ───────────────────────────────────────────
    /** Inside a MONEY transaction, `i` locked: settle it by Billing transaction `txn` ({ id, test }). Idempotent. */
    async function settleByTransaction(t, i, txn) {
        if (!i) return null;
        if (i.billing_txn_id === txn.id || i.payment_state === 'settled' || i.payment_state === 'reversed') return i;
        const other = await byBillingTxn(t, txn.id);
        if (other && other.id !== i.id) return other;
        const row = await t.one(sql`UPDATE tip_interactions SET billing_txn_id = ${txn.id}, test = test OR ${!!txn.test}, transfer_due = false, failure = NULL
            WHERE id = ${i.id} RETURNING *`);
        return await settle(t, row);
    }

    /** Inside a MONEY transaction, `i` locked (or created by it): pending/failed → settled, and the whole effect path. */
    async function settle(t, i) {
        const at = iso(ctx.now());
        const test = !!i.test;
        const req = i.request || {};
        // A tip hidden by a moderator while its payment was pending will deliver nothing.
        i = await t.one(sql`UPDATE tip_interactions SET payment_state = 'settled', delivery_state = CASE WHEN moderation = 'hidden' THEN 'cancelled' ELSE 'queued' END,
                settled_at = ${at}, updated_at = ${at} WHERE id = ${i.id} RETURNING *`);

        if (i.kind === 'paid_message' || i.kind === 'tts') {
            await t.exec(sql`INSERT INTO paid_messages (id, interaction_id, creator_subject, kind, text, voice, highlight_seconds, status, test, created_at, updated_at)
                VALUES (${prefixedId('tpm', ctx.now())}, ${i.id}, ${i.creator_subject}, ${i.kind}, ${i.kind === 'tts' ? req.tts.text : (i.message || '')},
                    ${i.kind === 'tts' ? req.tts.voice : null}, ${req.highlight_seconds || 0}, 'queued', ${test}, ${at}, ${at}) ON CONFLICT DO NOTHING`);
        }
        if (i.kind === 'media_request' && req.media) {
            await t.exec(sql`INSERT INTO paid_media_requests (id, interaction_id, creator_subject, url, provider, status, test, created_at, updated_at)
                VALUES (${prefixedId('tmr', ctx.now())}, ${i.id}, ${i.creator_subject}, ${req.media.url}, ${req.media.provider}, 'queued', ${test}, ${at}, ${at})
                ON CONFLICT DO NOTHING`);
        }
        // The creator's word filter runs before anything is shown, posted or read (moderation.js): a
        // match is masked, or held for review when the creator chose that. History is not screened.
        const filter = await ctx.profiles.filterOf(t, i.creator_subject);
        const verdict = i.origin !== 'import' && i.moderation === 'visible' ? ctx.moderation.screen(i, filter) : { hit: false };
        if (verdict.hit) i = await ctx.moderation.markScreened(t, i, verdict);
        if (!test && i.origin !== 'import') await ctx.goals.contribute(t, i, req.goal_id, filter);
        if (i.origin !== 'import' && i.moderation === 'visible') await release(t, i, filter);
        i = await recomputeDelivery(t, i.id);
        if (!test && i.origin !== 'import') {
            await ctx.outbox.emit(t, 'tips.interaction.ready', { type: 'interaction', id: i.id }, summary(i));
        }
        if (verdict.hit) await ctx.moderation.recordScreened(t, i, verdict);
        ctx.afterCommit(t, () => { ctx.effects.kick(); ctx.outboxKick(); });
        return i;
    }

    /**
     * Inside a transaction: show a settled interaction — the overlay alert and the chat, TTS and media
     * deliveries. Settlement calls it, and moderation's restore() for one the filter held. Idempotent:
     * nothing that exists (delivered or cancelled) is created again.
     */
    async function release(t, i, filter) {
        const test = !!i.test;
        await ctx.overlays.addAlert(t, i, filter);
        const at = iso(ctx.now());
        const effects = [{ effect: 'overlay_alert', adapter: 'overlay', state: 'delivered' }];
        // Chat effects: never for imports (history), never twice for a donation another product already
        // announced (origin billing), never to a real chat room for a simulation.
        const adapter = test ? 'test' : config.chat.adapter;
        if (ANNOUNCED_HERE.includes(i.origin) && adapter !== 'none') {
            const chat = { tip: ['chat_line'], paid_message: ['paid_message'], tts: ['chat_line', 'tts'], media_request: ['media_request'] }[i.kind] || [];
            for (const effect of chat) effects.push({ effect, adapter, state: 'queued' });
        }
        await t.exec(sql`INSERT INTO interaction_effects ${sql.insert(effects.map((e) => ({ interaction_id: i.id, ...e, created_at: at, updated_at: at })))}
            ON CONFLICT DO NOTHING`);
        await recomputeDelivery(t, i.id);
        ctx.afterCommit(t, () => ctx.effects.kick());
    }

    /** Inside a MONEY transaction, `i` locked: pending → failed (nothing was delivered; nothing moved in Billing). */
    async function failPayment(t, i, code, detail) {
        if (!i || i.payment_state !== 'pending') return i;
        const row = await t.one(sql`UPDATE tip_interactions SET payment_state = 'failed', delivery_state = 'cancelled', transfer_due = false,
                failure = ${`${code}${detail ? `: ${String(detail).slice(0, 240)}` : ''}`}, updated_at = ${iso(ctx.now())} WHERE id = ${i.id} RETURNING *`);
        if (!i.test) await ctx.outbox.emit(t, 'tips.interaction.cancelled', { type: 'interaction', id: i.id }, { ...summary(row), reason: 'payment_failed', code });
        return row;
    }

    /** Billing settled a transaction. Inside the inbox's MONEY transaction. */
    async function onBillingSettled(t, p) {
        const meta = p.metadata || {};
        const txn = { id: p.transaction_id, test: !!p.test };
        if (!txn.id) return 'ignored:no_transaction';
        if (p.type === 'donation') {
            if (await byBillingTxn(t, txn.id)) return 'duplicate_transaction';
            const target = meta.target;
            if (target && target.service === 'tips' && target.type === 'interaction') {
                const i = await lock(t, target.id);
                if (!i) return 'ignored:unknown_interaction';
                // Only the transfer Tips asked for settles the interaction: same amount, same creator, same
                // supporter. Another service's donation that merely names it (a 1-bit transfer claiming a
                // 10,000-bit paid message) is recorded as what it is, a donation of its own amount.
                const matches = Number(meta.amount_bits) === i.amount && p.to_subject === i.creator_subject && (!i.supporter_subject || p.from_subject === i.supporter_subject);
                if (matches) { await settleByTransaction(t, i, txn); return 'settled'; }
                ctx.log.warn(`[Tips] donation ${txn.id} names interaction ${i.id} but does not match it (amount, creator or supporter); recorded on its own`);
            }
            // A donation Tips did not start: record it once, by its transaction id.
            if (!p.to_subject) return 'ignored:no_recipient';
            const amount = Number(meta.amount_bits) || 0;
            if (amount <= 0) return 'ignored:no_amount';
            const i = await insert(t, {
                id: prefixedId('tint', ctx.now()), creator_subject: p.to_subject, supporter_subject: p.from_subject || null,
                supporter_name: displayName(meta.donor_name) || null, anonymous: meta.anonymous === true, kind: meta.kind === 'paid_interaction' ? 'media_request' : 'tip', amount, amount_cents: meta.paid_cents || null,
                message: meta.message ? storable(String(meta.message).slice(0, config.limits.messageChars)) : null,
                funding: p.provider ? 'provider' : 'credit', settlement: 'billing', payment_state: 'pending', delivery_state: 'awaiting_payment',
                test: txn.test, billing_txn_id: txn.id, provider: p.provider || null, origin: 'billing',
                target: meta.target && meta.target.service ? meta.target : null,
            });
            await settle(t, i);
            return 'recorded';
        }
        if (p.type === 'purchase' && meta.intent_id) {
            const i = await t.maybe(sql`SELECT * FROM tip_interactions WHERE billing_intent_id = ${meta.intent_id} FOR UPDATE`);
            if (!i) return 'ignored:not_a_tips_checkout';
            if (i.funding_txn_id) return 'duplicate_funding';
            await t.exec(sql`UPDATE tip_interactions SET funding_txn_id = ${txn.id}, test = test OR ${txn.test}, transfer_due = (payment_state = 'pending'),
                next_transfer_at = 0, updated_at = ${iso(ctx.now())} WHERE id = ${i.id}`);
            ctx.afterCommit(t, () => processDueTransfers().catch((e) => ctx.log.warn('[Tips] transfer after funding:', e.message)));
            return 'funded';
        }
        return 'ignored';
    }

    /** Billing reversed a transaction. Inside the inbox's MONEY transaction. */
    async function onBillingReversed(t, p) {
        const meta = p.metadata || {};
        const orig = p.reverses_txn;
        if (!orig) return 'ignored:no_original';
        const i = await t.maybe(sql`SELECT * FROM tip_interactions WHERE billing_txn_id = ${orig} FOR UPDATE`);
        if (!i) {
            const funded = await t.maybe(sql`SELECT * FROM tip_interactions WHERE funding_txn_id = ${orig} FOR UPDATE`);
            if (funded && funded.payment_state === 'pending') { await failPayment(t, funded, 'billing.funding_reversed', 'the checkout payment was reversed before the tip was given'); return 'funding_reversed'; }
            return 'ignored';
        }
        const ids = Array.isArray(i.reversal_txn_ids) ? [...i.reversal_txn_ids] : [];
        if (ids.includes(p.transaction_id)) return 'duplicate_reversal';
        ids.push(p.transaction_id);
        // Bits Billing took back from the creator: a transfer refund moves them out of the payable. A
        // provider chargeback on a site-routed tip leaves the creator's payable intact (ADR-012 rule 2).
        const clawed = p.type === 'refund' && p.from_subject === i.creator_subject ? Math.max(0, Number(meta.amount_bits) || 0) : 0;
        const take = Math.min(clawed, i.amount - i.reversed_bits);
        const at = iso(ctx.now());
        const reversed = await t.one(sql`UPDATE tip_interactions SET payment_state = 'reversed', reversal_txn_ids = ${sql.json(ids)}, reversed_bits = reversed_bits + ${take},
                reversed_at = ${at}, updated_at = ${at} WHERE id = ${i.id} RETURNING *`);
        if (take > 0 && !i.test) await ctx.goals.reverse(t, reversed, take);
        // Undelivered effects are cancelled; a delivery that already happened stays on record.
        let cancelled = await cancelQueued(t, reversed, 'payment_reversed');
        const now = await get(t, i.id);
        if (!cancelled && now.moderation === 'held' && now.delivery_state === 'queued') {
            // Held by the filter and never shown: it will not be released now.
            const row = await t.one(sql`UPDATE tip_interactions SET delivery_state = 'cancelled', updated_at = ${at} WHERE id = ${i.id} RETURNING *`);
            await t.exec(sql`UPDATE paid_messages SET status = 'cancelled', updated_at = ${at} WHERE interaction_id = ${i.id} AND status = 'queued'`);
            await t.exec(sql`UPDATE paid_media_requests SET status = 'cancelled', updated_at = ${at} WHERE interaction_id = ${i.id} AND status = 'queued'`);
            if (!now.test) await ctx.outbox.emit(t, 'tips.interaction.cancelled', { type: 'interaction', id: i.id }, { ...summary(row), reason: 'payment_reversed' });
            cancelled = true;
        }
        return cancelled ? 'reversed_cancelled' : 'reversed';
    }

    /** Inside a transaction, the interaction locked: queued effects → cancelled. True when anything was cancelled. */
    async function cancelQueued(t, i, reason) {
        const at = iso(ctx.now());
        const n = await t.exec(sql`UPDATE interaction_effects SET state = 'cancelled', updated_at = ${at} WHERE interaction_id = ${i.id} AND state = 'queued'`);
        await t.exec(sql`UPDATE paid_messages SET status = 'cancelled', updated_at = ${at} WHERE interaction_id = ${i.id} AND status = 'queued'`);
        await t.exec(sql`UPDATE paid_media_requests SET status = 'cancelled', updated_at = ${at} WHERE interaction_id = ${i.id} AND status = 'queued'`);
        if (!n) return false;
        const row = await t.one(sql`UPDATE tip_interactions SET delivery_state = 'cancelled', updated_at = ${at} WHERE id = ${i.id} RETURNING *`);
        if (!i.test) await ctx.outbox.emit(t, 'tips.interaction.cancelled', { type: 'interaction', id: i.id }, { ...summary(row), reason });
        return true;
    }

    /** Aggregate the effects into delivery_state (inside a transaction). Emits failed once. Returns the row. */
    async function recomputeDelivery(t, id) {
        const i = await get(t, id);
        if (!i || i.delivery_state === 'cancelled' || i.delivery_state === 'awaiting_payment') return i;
        const effects = await t.many(sql`SELECT effect, adapter, state, last_error FROM interaction_effects WHERE interaction_id = ${id} ORDER BY id`);
        const states = effects.map((e) => e.state);
        if (i.moderation === 'held' && !states.length) return i;   // waiting for a moderator: still to deliver
        let next = 'queued';
        if (states.includes('failed') && !states.includes('queued')) next = 'failed';
        else if (!states.includes('queued')) next = 'delivered';
        if (next === i.delivery_state) return i;
        const at = iso(ctx.now());
        const row = await t.one(sql`UPDATE tip_interactions SET delivery_state = ${next},
            delivered_at = CASE WHEN ${next === 'delivered'} THEN ${at}::timestamptz ELSE delivered_at END, updated_at = ${at} WHERE id = ${id} RETURNING *`);
        if (next === 'failed' && !i.test) {
            const failed = effects.filter((e) => e.state === 'failed').map(({ effect, adapter, last_error: lastError }) => ({ effect, adapter, last_error: lastError }));
            await ctx.outbox.emit(t, 'tips.interaction.failed', { type: 'interaction', id }, { ...summary(row), failed_effects: failed });
        }
        return row;
    }

    /**
     * The goal a PowerChat tip asked for: its app_purpose/app_ref carries `goal:<id>` — a Tips goal id.
     * goals.contribute() still checks it is the creator's and active, else falls back to the
     * sole-active-goal rule.
     */
    function goalFromPurpose(...refs) {
        for (const v of refs) {
            const m = storable(v || '').match(/(?:^|[:_-])goal[:_-]?([A-Za-z0-9_]+)/i);
            if (!m) continue;
            if (/^\d+$/.test(m[1])) continue;   // a numeric id names no Tips goal (goal ids carry a prefix)
            return m[1];
        }
        return null;
    }

    /**
     * Billing announced an EXTERNAL receipt (billing.receipt.external): a tip paid on the creator's own
     * PowerChat. Inside the inbox's MONEY transaction. Recorded once by (provider, provider event id) —
     * the same key POST /interactions/external uses — settled at once (the provider already confirmed
     * it), and announced by Tips: chat line through the chat adapter, overlay alert, goal contribution.
     */
    async function onBillingExternal(t, p) {
        const provider = String(p.provider || '').toLowerCase();
        const ref = storable(p.provider_event_id || '').trim();
        if (!/^[a-z][a-z0-9_-]{1,39}$/.test(provider) || !ref || ref.length > 200) return 'ignored:no_reference';
        const creator = p.streamer && p.streamer.type === 'user' && SUBJECT_RE.test(String(p.streamer.id || '')) ? p.streamer.id : null;
        if (!creator) return 'ignored:no_streamer';
        const cents = Number(p.amount_cents);
        if (!Number.isSafeInteger(cents) || cents < 1 || cents > MAX_EXTERNAL_CENTS) return 'ignored:no_amount';
        if (await t.maybe(sql`SELECT 1 FROM tip_interactions WHERE provider = ${provider} AND provider_ref = ${ref}`)) return 'duplicate_receipt';
        // Goals and the chat line count Vibes: the value Billing put on the money (1 bit = 1 cent today).
        const bits = Number(p.value_bits);
        const amount = Math.min(Number.isSafeInteger(bits) && bits > 0 ? bits : cents, config.limits.maxBits);
        const message = p.message ? storable(String(p.message).replace(/\r\n?/g, '\n').trim().slice(0, config.limits.messageChars)) || null : null;
        const goalId = goalFromPurpose(p.app_purpose, p.app_ref);
        const i = await insert(t, {
            id: prefixedId('tint', ctx.now()), creator_subject: creator, supporter_subject: null,
            supporter_name: p.anonymous ? 'Anonymous' : (displayName(p.donor_name) || 'Someone'), anonymous: !!p.anonymous, kind: 'tip', amount, amount_cents: cents,
            message, request: goalId ? { goal_id: goalId } : {}, funding: 'external', settlement: 'external', payment_state: 'pending',
            delivery_state: 'awaiting_payment', provider, provider_ref: ref, origin: 'billing-external', test: !!p.test,
        });
        await settle(t, i);
        return 'recorded_external';
    }

    // ── External and simulated ───────────────────────────────
    /** A tip on the creator's own PowerChat (EXTERNAL, ADR-012): recorded once by provider ref. */
    async function recordExternal(profile, input) {
        if (!profile) fail(404, 'tips.creator_not_found', 'this creator has no tip profile');
        const provider = String(input.provider || '').toLowerCase();
        if (!/^[a-z][a-z0-9_-]{1,39}$/.test(provider)) fail(422, 'tips.invalid_input', 'provider is required');
        const ref = storable(input.provider_ref || '').trim();
        if (!ref || ref.length > 200) fail(422, 'tips.invalid_input', 'provider_ref (the provider event id) is required');
        const cents = positiveInt(input.amount_cents, 'amount_cents', 100_000_000);
        const privacy = parsePrivacy(input.privacy, 'tip');
        return ctx.tx(async (t) => {
            const prev = await t.maybe(sql`SELECT * FROM tip_interactions WHERE provider = ${provider} AND provider_ref = ${ref}`);
            if (prev) return { interaction: prev, replay: true };
            const i = await insert(t, {
                id: prefixedId('tint', ctx.now()), creator_subject: profile.creator_subject, supporter_subject: input.supporter ? userSubject(input.supporter, 'supporter') : null,
                supporter_name: displayName(input.supporter_name) || 'Someone', kind: 'tip', amount: cents, amount_cents: cents,
                message: text(input.message, 'message', 500), request: input.goal_id ? { goal_id: String(input.goal_id) } : {},
                funding: 'external', settlement: 'external', payment_state: 'pending', delivery_state: 'awaiting_payment',
                // origin external: the provider (or Live's webhook) already announced it in chat; with
                // announce: true Tips delivers the chat line itself.
                provider, provider_ref: ref, origin: input.announce === true ? 'tips' : 'external', test: !!input.test,
                ...privacy, private_message: privacy.private_message && !!input.message,
            });
            return { interaction: await settle(t, i), replay: false };
        }, MONEY);
    }

    /** The full effect path with test = true and no Billing call. */
    async function simulate(profile, input, { by }) {
        const v = await validate(db, profile, { ...input, amount: input.amount || Math.max(profile.min_amount, 100) }, { simulation: true });
        const privacy = parsePrivacy(input.privacy, v.kind);
        return ctx.tx(async (t) => {
            const i = await insert(t, {
                id: prefixedId('tint', ctx.now()), creator_subject: profile.creator_subject, supporter_subject: null,
                supporter_name: displayName(input.supporter_name) || 'Test supporter', kind: v.kind, amount: v.amount, message: v.message,
                request: { ...v.request, simulated_by: by }, funding: 'none', settlement: 'simulated', payment_state: 'pending',
                delivery_state: 'awaiting_payment', test: true, ...privacy, private_message: privacy.private_message && !!v.message,
            });
            const out = await settle(t, i);
            // Show the goal widget moving without counting anything: a test goal delivery with the
            // would-be total. No contribution row is written.
            const g = await ctx.goals.pick(t, profile.creator_subject, v.request.goal_id);
            if (g) {
                const [view] = await ctx.goals.presentMany(t, [g]);
                const would = { ...view, current_amount: view.current_amount + v.amount, percent: Math.min(100, Math.floor(((view.current_amount + v.amount) * 100) / view.target_amount)) };
                const by2 = out.hide_amount || out.moderation !== 'visible' ? null : publicView(out, { filter: profile.filter }).supporter_name;
                await ctx.overlays.addGoalDelivery(t, profile.creator_subject, would, { reason: 'simulation', interactionId: i.id, by: by2, dedupe: `goal:${g.id}:sim:${i.id}`, test: true });
            }
            return out;
        }, MONEY);
    }

    // ── Reads ────────────────────────────────────────────────
    /** The event payload (tips.interaction.*): an anonymous supporter is never named, not even by subject. */
    function summary(i) {
        const anon = isAnonymous(i);
        return {
            interaction_id: i.id, creator: { type: 'user', id: i.creator_subject }, supporter: i.supporter_subject && !anon ? { type: 'user', id: i.supporter_subject } : null,
            supporter_name: anon ? publicName(i) : (i.supporter_name || null), kind: i.kind, amount: i.amount, currency: i.currency, settlement: i.settlement,
            payment_state: i.payment_state, delivery_state: i.delivery_state, billing_txn_id: i.billing_txn_id || null, test: !!i.test,
        };
    }

    function shape(i, viewer, filter, effects) {
        const req = i.request || {};
        const own = viewer === 'supporter';
        const named = own || !isAnonymous(i);
        const out = {
            id: i.id, creator: { type: 'user', id: i.creator_subject }, supporter: i.supporter_subject && named ? { type: 'user', id: i.supporter_subject } : null,
            supporter_name: named ? (i.supporter_name || null) : publicName(i), kind: i.kind, amount: i.amount, currency: i.currency, message: i.message || null,
            tts: req.tts || null, media: req.media ? { url: req.media.url, provider: req.media.provider } : null, goal_id: req.goal_id || null,
            funding: i.funding, settlement: i.settlement, origin: i.origin, test: !!i.test,
            privacy: privacyOf(i), public: publicView(i, { filter }), erased_at: i.erased_at || null,
            moderation: { state: i.moderation, filtered: !!i.filtered, at: i.moderated_at || null },
            payment: { state: i.payment_state, billing_txn_id: i.billing_txn_id || null, reversal_txn_ids: i.reversal_txn_ids || [], reversed_amount: i.reversed_bits, failure: i.failure || null, settled_at: i.settled_at || null, reversed_at: i.reversed_at || null },
            delivery: { state: i.delivery_state, delivered_at: i.delivered_at || null },
            created_at: i.created_at, updated_at: i.updated_at,
        };
        if (i.funding === 'checkout') out.checkout = { url: i.checkout_url || null, ref: i.checkout_ref || null, provider: i.provider || null, intent_id: i.billing_intent_id || null };
        if (viewer === 'owner' || viewer === 'service') {
            out.effects = effects;
            out.provider = i.provider || null;
            out.provider_ref = i.provider_ref || null;
        }
        return out;
    }

    /**
     * viewer: 'supporter' (their own receipt: everything they chose), 'owner' (the creator) or
     * 'service'. Anyone but the supporter gets no subject and "Anonymous" for an anonymous supporter;
     * `public` is what may be shown to the public, `privacy` the supporter's choices. A page of any
     * size costs two queries: the creators' filters, and (owner, service) every row's effects.
     */
    async function presentMany(q, rows, { viewer = 'owner' } = {}) {
        if (!rows.length) return [];
        const filters = await ctx.profiles.filtersOf(q, rows.map((i) => i.creator_subject));
        const effects = new Map();
        if (viewer === 'owner' || viewer === 'service') {
            const list = await q.many(sql`SELECT interaction_id, effect, adapter, state, attempts, last_error, updated_at FROM interaction_effects
                WHERE interaction_id = ANY(${rows.map((i) => i.id)}) ORDER BY interaction_id, id`);
            for (const { interaction_id: id, ...e } of list) { if (!effects.has(id)) effects.set(id, []); effects.get(id).push(e); }
        }
        return rows.map((i) => shape(i, viewer, filters.get(i.creator_subject), effects.get(i.id) || []));
    }
    const present = async (q, i, opts) => (i ? (await presentMany(q, [i], opts))[0] : null);

    /** A keyset page, newest first. filter: { creator?, supporter?, includeTest? } (one of the first two). */
    async function list(q, { creator, supporter, includeTest = true, cursor, limit = 50 } = {}) {
        const n = Math.min(200, Math.max(1, Number(limit) || 50));
        const cur = cursor ? readCursor(cursor) : null;
        const where = [];
        if (creator) where.push(sql`creator_subject = ${creator}`);
        if (supporter) where.push(sql`supporter_subject = ${supporter}`);
        if (!where.length) fail(422, 'tips.invalid_input', 'creator or supporter is required');
        if (!includeTest) where.push(sql`NOT test`);
        if (cur) where.push(sql`(created_at, id) < (${cur[0]}::timestamptz, ${cur[1]}::text)`);
        const rows = await q.many(sql`SELECT * FROM tip_interactions WHERE ${sql.join(where, sql` AND `)} ORDER BY created_at DESC, id DESC LIMIT ${n + 1}`);
        const page = rows.slice(0, n);
        return { rows: page, next_cursor: rows.length > n ? cursorOf(page[n - 1]) : null };
    }

    // ── The public supporters page ───────────────────────────
    /**
     * Top supporters: [{ rank, name, total, tips }] (name = the latest name they tipped under). Only
     * settled, non-test interactions of supporters who kept both their name and their amount public
     * count (a hidden amount must not be inferable from a rank).
     */
    async function leaderboard(q, profile, { limit = 20 } = {}) {
        const rows = await q.many(sql`SELECT supporter_subject AS s, SUM(amount - reversed_bits)::bigint AS total, count(*) AS tips, MIN(created_at) AS first_at,
                (array_agg(supporter_name ORDER BY created_at DESC))[1] AS name
            FROM tip_interactions
            WHERE creator_subject = ${profile.creator_subject} AND supporter_subject IS NOT NULL AND NOT test AND payment_state IN ('settled', 'reversed')
              AND NOT anonymous AND NOT hide_amount AND erased_at IS NULL AND moderation = 'visible'
            GROUP BY supporter_subject HAVING SUM(amount - reversed_bits) > 0
            ORDER BY total DESC, first_at LIMIT ${Math.min(100, Math.max(1, limit))}`);
        return rows.map((r, k) => ({ rank: k + 1, name: shownName({ supporter_name: r.name }, profile.filter), total: r.total, tips: r.tips }));
    }

    /** Recent settled interactions with a public message, as publicView(). */
    async function recentPublic(q, profile, { limit = 20 } = {}) {
        return (await q.many(sql`SELECT * FROM tip_interactions WHERE creator_subject = ${profile.creator_subject} AND payment_state = 'settled' AND message IS NOT NULL
                AND NOT test AND NOT private_message AND erased_at IS NULL AND moderation = 'visible' ORDER BY settled_at DESC, id DESC LIMIT ${Math.min(100, Math.max(1, limit))}`))
            .map((i) => publicView(i, { filter: profile.filter }));
    }

    // ── A supporter's own data ───────────────────────────────
    /** Everything Tips holds about a supporter's tips (their own view), for a download: five queries. */
    async function exportFor(subject) {
        const rows = await db.many(sql`SELECT * FROM tip_interactions WHERE supporter_subject = ${subject} ORDER BY created_at`);
        const ids = rows.map((i) => i.id);
        const views = await presentMany(db, rows, { viewer: 'supporter' });
        const group = (list) => { const m = new Map(); for (const { interaction_id: id, ...r } of list) { if (!m.has(id)) m.set(id, []); m.get(id).push(r); } return m; };
        const [contributions, paid, media] = ids.length ? await Promise.all([
            db.many(sql`SELECT interaction_id, goal_id, amount, reversed_amount, created_at FROM tip_goal_contributions WHERE interaction_id = ANY(${ids}) ORDER BY id`),
            db.many(sql`SELECT interaction_id, kind, text, voice, highlight_seconds, status, created_at, updated_at FROM paid_messages WHERE interaction_id = ANY(${ids})`),
            db.many(sql`SELECT interaction_id, url, provider, status, created_at, updated_at FROM paid_media_requests WHERE interaction_id = ANY(${ids})`),
        ]).then((r) => r.map(group)) : [new Map(), new Map(), new Map()];
        return {
            service: 'tips', subject: { type: 'user', id: subject }, exported_at: iso(ctx.now()),
            interactions: views.map((v) => ({
                ...v,
                goal_contributions: contributions.get(v.id) || [],
                paid_message: (paid.get(v.id) || [])[0] || null,
                media_request: (media.get(v.id) || [])[0] || null,
            })),
            not_included: 'Payments, balances and refunds are OpenVibe.Billing\'s records; ask Billing for them.',
        };
    }

    /**
     * Erase a supporter's data from their tips. The money record stays (amount, creator, Billing
     * transaction, goal contribution: Billing's books and the creator's totals must still reconcile);
     * the person goes: subject, name, message, TTS text, media link, checkout reference, stored API
     * answers, overlay payloads and the unsent events that named them. Each erased interaction emits
     * tips.interaction.erased, whose `redacts` has OpenVibe.Events tombstone the earlier events about
     * it. Interactions still waiting for their payment are kept (the payment needs the supporter) and
     * counted in kept_pending. The supporter's rows are locked in id order first; the writes are one
     * statement per table.
     */
    function erase(subject) {
        return ctx.tx(async (t) => {
            const rows = await t.many(sql`SELECT * FROM tip_interactions WHERE supporter_subject = ${subject} ORDER BY id FOR UPDATE`);
            const at = iso(ctx.now());
            const done = rows.filter((i) => i.payment_state !== 'pending');
            if (done.length) {
                const keep = done.map((i) => {
                    const req = i.request || {};
                    const k = {};
                    if (req.goal_id) k.goal_id = req.goal_id;
                    if (req.highlight_seconds) k.highlight_seconds = req.highlight_seconds;
                    return { id: i.id, request: k };
                });
                const ids = done.map((i) => i.id);
                const erased = await t.many(sql`UPDATE tip_interactions x SET supporter_subject = NULL, supporter_name = NULL, anonymous = true, message = NULL,
                        request = v.request, idempotency_key = NULL, checkout_url = NULL, checkout_ref = NULL, erased_at = ${at}, updated_at = ${at}
                    FROM jsonb_to_recordset(${sql.json(keep)}) AS v(id text, request jsonb) WHERE x.id = v.id RETURNING x.*`);
                await t.exec(sql`UPDATE paid_messages SET text = '', voice = NULL, updated_at = ${at} WHERE interaction_id = ANY(${ids})`);
                await t.exec(sql`UPDATE paid_media_requests SET url = '', updated_at = ${at} WHERE interaction_id = ANY(${ids})`);
                await ctx.overlays.refreshInteractions(t, erased, await ctx.profiles.filtersOf(t, erased.map((i) => i.creator_subject)));
                // Events about them still in the local outbox lose the supporter's name.
                await t.exec(sql`UPDATE tips_event_outbox
                    SET envelope = jsonb_set(jsonb_set(envelope, '{payload,supporter}', 'null'::jsonb), '{payload,supporter_name}', ${sql.json(ANONYMOUS)})
                    WHERE envelope->'subject'->>'type' = 'interaction' AND envelope->'subject'->>'id' = ANY(${ids}) AND envelope->'payload' ? 'supporter'`);
                for (const i of done) {
                    if (i.test) continue;
                    await ctx.outbox.emit(t, 'tips.interaction.erased', { type: 'interaction', id: i.id }, {
                        interaction_id: i.id, creator: { type: 'user', id: i.creator_subject }, erased_at: at,
                        redacts: { subject_type: 'interaction', subject_ids: [i.id] },
                    });
                }
                t.after(ctx.outboxKick);
            }
            // Stored API answers (Idempotency-Key replays) carry messages and the subject.
            const answers = await t.exec(sql`DELETE FROM api_idempotency WHERE starts_with(key, ${`${subject}:`}) OR strpos(response, ${subject}) > 0`);
            return { erased: done.length, kept_pending: rows.length - done.length, stored_answers_removed: answers };
        });
    }

    /**
     * A creator's totals, derived from settled interactions. `billing` is what must equal Billing's
     * books (settled through Billing or imported from Live's ledger, minus what Billing took back);
     * external and test interactions are reported apart and never mixed in.
     */
    async function totals(q, creator) {
        const r = await q.one(sql`SELECT
                COALESCE(SUM(amount - reversed_bits) FILTER (WHERE NOT test AND settlement IN ('billing', 'imported') AND payment_state IN ('settled', 'reversed')), 0)::bigint AS billing,
                COALESCE(SUM(amount) FILTER (WHERE NOT test AND settlement = 'external' AND payment_state = 'settled'), 0)::bigint AS external,
                count(*) FILTER (WHERE NOT test AND payment_state IN ('settled', 'reversed')) AS count,
                count(*) FILTER (WHERE test) AS test_count,
                count(*) FILTER (WHERE payment_state = 'pending') AS pending_count
            FROM tip_interactions WHERE creator_subject = ${creator}`);
        return { currency: 'vibes-bits', settled_via_billing: r.billing, external: r.external, interactions: r.count, simulations: r.test_count, pending: r.pending_count };
    }

    return {
        get, lock, byBillingTxn, validate, request, transfer, startCheckout, processDueTransfers, settleByTransaction, settle, failPayment,
        onBillingSettled, onBillingReversed, onBillingExternal, cancelQueued, recomputeDelivery, recordExternal, simulate, summary, present, presentMany, list, totals, insert, KINDS,
        leaderboard, recentPublic, exportFor, erase, release,
    };
}

module.exports = { createInteractions, KINDS, highlightFor };

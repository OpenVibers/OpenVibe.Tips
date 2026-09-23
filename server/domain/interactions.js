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
 *   simulated         the whole effect path with test = 1: no Billing call, no goal contribution,
 *                     no durable event, excluded from every total.
 *
 * Settlement creates, in one transaction: the paid message / TTS / media request row, the goal
 * contribution, the overlay alert, the delivery effects and tips.interaction.ready. Delivery then
 * runs in the effects worker; its failure never touches payment_state.
 */
const { fail, iso, prefixedId, json, positiveInt, text, userSubject, entityRef, displayName } = require('../util');
const { VOICES } = require('./profiles');
const { BillingCallError } = require('../billing-client');

const KINDS = ['tip', 'paid_message', 'tts', 'media_request'];
// Paid-message highlight time by amount (bits): the bigger the message, the longer it stays up.
const HIGHLIGHT = [[5000, 300], [1000, 120], [500, 60], [100, 30]];
const highlightFor = (bits) => (HIGHLIGHT.find(([min]) => bits >= min) || [0, 0])[1];
const TRANSFER_BACKOFF = [2000, 10000, 30000, 60000, 300000, 600000];

function createInteractions(ctx) {
    const { db, config } = ctx;

    const get = (id) => db.prepare('SELECT * FROM tip_interactions WHERE id = ?').get(String(id || '')) || null;
    const byBillingTxn = (txnId) => db.prepare('SELECT * FROM tip_interactions WHERE billing_txn_id = ?').get(txnId) || null;

    // ── Input rules (the creator's settings) ─────────────────
    function cleanTts(s) {
        return String(s || '').replace(/[\u0000-\u001f]/g, ' ').replace(/https?:\/\/\S+/gi, 'link').replace(/\s+/g, ' ').trim();
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
    function validate(profile, input, { simulation = false } = {}) {
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
            const g = ctx.goals.get(input.goal_id);
            if (!g || g.creator_subject !== profile.creator_subject || g.status !== 'active') fail(422, 'tips.goal_not_found', 'that goal is not open on this page');
            request.goal_id = g.id;
        }
        return { kind, amount, message, request };
    }

    // ── Creation ─────────────────────────────────────────────
    function insert(row) {
        const at = iso(ctx.now());
        const r = {
            supporter_subject: null, supporter_name: null, amount_cents: null, message: null, request: {}, test: 0, billing_txn_id: null,
            billing_intent_id: null, funding_txn_id: null, provider: null, provider_ref: null, legacy_source: null, idempotency_key: null,
            target: null, origin: 'tips', created_at: at, ...row,
        };
        db.prepare(`INSERT INTO tip_interactions (id, creator_subject, supporter_subject, supporter_name, kind, amount, amount_cents, message, request,
                funding, settlement, payment_state, delivery_state, test, billing_txn_id, billing_intent_id, funding_txn_id, provider, provider_ref,
                legacy_source, idempotency_key, origin, target, created_at, updated_at)
            VALUES (@id, @creator_subject, @supporter_subject, @supporter_name, @kind, @amount, @amount_cents, @message, @request,
                @funding, @settlement, @payment_state, @delivery_state, @test, @billing_txn_id, @billing_intent_id, @funding_txn_id, @provider, @provider_ref,
                @legacy_source, @idempotency_key, @origin, @target, @created_at, @created_at)`)
            .run({ ...r, request: JSON.stringify(r.request || {}), target: r.target ? JSON.stringify(r.target) : null });
        return get(r.id);
    }

    /**
     * A supporter's request (checkout or credit). Idempotent by `idempotencyKey` (the caller's key,
     * scoped to the caller): a repeat returns the interaction it created the first time.
     */
    function request(profile, input, { supporter, supporterName, funding, idempotencyKey }) {
        const v = validate(profile, input);
        const from = userSubject(supporter, 'supporter');
        if (from === profile.creator_subject) fail(422, 'tips.self_dealing', 'you cannot tip yourself');
        if (!['credit', 'checkout'].includes(funding)) fail(422, 'tips.invalid_input', "pay_with must be 'credit' or 'checkout'");
        if (funding === 'checkout' && v.amount < config.billing.minPurchaseBits) {
            fail(422, 'tips.amount_too_small', `paying by checkout starts at ${config.billing.minPurchaseBits} Vibes; smaller tips use your Vibes balance`);
        }
        const target = entityRef(input.target);
        return ctx.tx(() => {
            if (idempotencyKey) {
                const prev = db.prepare('SELECT * FROM tip_interactions WHERE idempotency_key = ?').get(idempotencyKey);
                if (prev) return { interaction: prev, replay: true };
            }
            const i = insert({
                id: prefixedId('tint', ctx.now()), creator_subject: profile.creator_subject, supporter_subject: from, supporter_name: displayName(supporterName) || 'Someone',
                kind: v.kind, amount: v.amount, message: v.message, request: v.request, funding, settlement: 'billing', payment_state: 'pending',
                delivery_state: 'awaiting_payment', idempotency_key: idempotencyKey || null, target,
            });
            return { interaction: i, replay: false };
        });
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
            ctx.tx(() => settleByTransaction(get(i.id), { id: txn.id, test: !!txn.test }));
            return { settled: true };
        } catch (e) {
            if (e instanceof BillingCallError && !e.retryable) {
                ctx.tx(() => failPayment(get(i.id), e.code || 'billing.refused', e.message));
                return { settled: false, refused: e.code, detail: e.body && e.body.detail };
            }
            const cur = get(i.id);
            const n = cur.transfer_attempts + 1;
            db.prepare('UPDATE tip_interactions SET transfer_due = 1, transfer_attempts = ?, next_transfer_at = ?, failure = ?, updated_at = ? WHERE id = ? AND payment_state = \'pending\'')
                .run(n, ctx.now() + TRANSFER_BACKOFF[Math.min(n - 1, TRANSFER_BACKOFF.length - 1)], String(e.message).slice(0, 300), iso(ctx.now()), i.id);
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
                ctx.tx(() => failPayment(get(i.id), e.code || 'billing.refused', e.message));
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
        db.prepare('UPDATE tip_interactions SET billing_intent_id = ?, checkout_url = ?, checkout_ref = ?, provider = ?, updated_at = ? WHERE id = ?')
            .run(intent.id || null, url, ref, p, iso(ctx.now()), i.id);
        return { interaction: get(i.id), checkout_url: url, checkout_ref: ref, intent };
    }

    /** Due transfers (credit retries and funded checkouts). Called by the jobs loop. */
    async function processDueTransfers() {
        const rows = db.prepare("SELECT * FROM tip_interactions WHERE payment_state = 'pending' AND transfer_due = 1 AND next_transfer_at <= ? ORDER BY next_transfer_at LIMIT 20").all(ctx.now());
        let settled = 0;
        for (const i of rows) { const r = await transfer(i); if (r.settled) settled++; }
        return { attempted: rows.length, settled };
    }

    // ── Settlement ───────────────────────────────────────────
    /** Inside a transaction: settle `i` by Billing transaction `txn` ({ id, test }). Idempotent. */
    function settleByTransaction(i, txn) {
        if (!i) return null;
        if (i.billing_txn_id === txn.id || i.payment_state === 'settled' || i.payment_state === 'reversed') return i;
        const other = byBillingTxn(txn.id);
        if (other && other.id !== i.id) return other;
        db.prepare('UPDATE tip_interactions SET billing_txn_id = ?, test = MAX(test, ?), transfer_due = 0, failure = NULL WHERE id = ?').run(txn.id, txn.test ? 1 : 0, i.id);
        return settle(get(i.id));
    }

    /** Inside a transaction: pending/failed → settled, and the whole effect path. */
    function settle(i) {
        const at = iso(ctx.now());
        const test = !!i.test;
        const req = json(i.request, {});
        db.prepare("UPDATE tip_interactions SET payment_state = 'settled', delivery_state = 'queued', settled_at = ?, updated_at = ? WHERE id = ?").run(at, at, i.id);
        i = get(i.id);

        if (i.kind === 'paid_message' || i.kind === 'tts') {
            db.prepare(`INSERT OR IGNORE INTO paid_messages (id, interaction_id, creator_subject, kind, text, voice, highlight_seconds, status, test, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(prefixedId('tpm', ctx.now()), i.id, i.creator_subject, i.kind,
                i.kind === 'tts' ? req.tts.text : (i.message || ''), i.kind === 'tts' ? req.tts.voice : null, req.highlight_seconds || 0, test ? 1 : 0, at, at);
        }
        if (i.kind === 'media_request' && req.media) {
            db.prepare(`INSERT OR IGNORE INTO paid_media_requests (id, interaction_id, creator_subject, url, provider, status, test, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(prefixedId('tmr', ctx.now()), i.id, i.creator_subject, req.media.url, req.media.provider, test ? 1 : 0, at, at);
        }
        if (!test && i.origin !== 'import') ctx.goals.contribute(i, req.goal_id);

        const view = { message: i.message, tts: req.tts || null, media: req.media ? { url: req.media.url } : null };
        if (i.origin !== 'import') {
            ctx.overlays.addAlert(i, view);
            addEffect(i, 'overlay_alert', 'overlay', 'delivered');
        }
        // Chat effects: never for imports (history), never twice for a donation another product already
        // announced (origin billing), never to a real chat room for a simulation.
        const adapter = test ? 'test' : config.chat.adapter;
        if (i.origin === 'tips' && adapter !== 'none') {
            if (i.kind === 'tip') addEffect(i, 'chat_line', adapter);
            if (i.kind === 'paid_message') addEffect(i, 'paid_message', adapter);
            if (i.kind === 'tts') { addEffect(i, 'chat_line', adapter); addEffect(i, 'tts', adapter); }
            if (i.kind === 'media_request') addEffect(i, 'media_request', adapter);
        }
        recomputeDelivery(i.id);
        if (!test && i.origin !== 'import') {
            ctx.outbox.emit('tips.interaction.ready', { type: 'interaction', id: i.id }, summary(get(i.id)));
        }
        ctx.afterCommit(() => { ctx.effects.kick(); ctx.outboxKick(); });
        return get(i.id);
    }

    function addEffect(i, effect, adapter, state = 'queued') {
        const at = iso(ctx.now());
        db.prepare(`INSERT OR IGNORE INTO interaction_effects (interaction_id, effect, adapter, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(i.id, effect, adapter, state, at, at);
    }

    /** Inside a transaction: pending → failed (nothing was delivered; nothing moved in Billing). */
    function failPayment(i, code, detail) {
        if (!i || i.payment_state !== 'pending') return i;
        const at = iso(ctx.now());
        db.prepare("UPDATE tip_interactions SET payment_state = 'failed', delivery_state = 'cancelled', transfer_due = 0, failure = ?, updated_at = ? WHERE id = ?")
            .run(`${code}${detail ? `: ${String(detail).slice(0, 240)}` : ''}`, at, i.id);
        if (!i.test) ctx.outbox.emit('tips.interaction.cancelled', { type: 'interaction', id: i.id }, { ...summary(get(i.id)), reason: 'payment_failed', code });
        return get(i.id);
    }

    /** Billing settled a transaction. Inside the inbox transaction. */
    function onBillingSettled(p) {
        const meta = p.metadata || {};
        const txn = { id: p.transaction_id, test: !!p.test };
        if (!txn.id) return 'ignored:no_transaction';
        if (p.type === 'donation') {
            const known = byBillingTxn(txn.id);
            if (known) return 'duplicate_transaction';
            const target = meta.target;
            if (target && target.service === 'tips' && target.type === 'interaction') {
                const i = get(target.id);
                if (i) { settleByTransaction(i, txn); return 'settled'; }
                return 'ignored:unknown_interaction';
            }
            // A donation Tips did not start: record it once, by its transaction id.
            if (!p.to_subject) return 'ignored:no_recipient';
            const amount = Number(meta.amount_bits) || 0;
            if (amount <= 0) return 'ignored:no_amount';
            const i = insert({
                id: prefixedId('tint', ctx.now()), creator_subject: p.to_subject, supporter_subject: p.from_subject || null,
                supporter_name: displayName(meta.donor_name) || null, kind: meta.kind === 'paid_interaction' ? 'media_request' : 'tip', amount, amount_cents: meta.paid_cents || null,
                message: meta.message ? String(meta.message).slice(0, config.limits.messageChars) : null,
                funding: p.provider ? 'provider' : 'credit', settlement: 'billing', payment_state: 'pending', delivery_state: 'awaiting_payment',
                test: txn.test ? 1 : 0, billing_txn_id: txn.id, provider: p.provider || null, origin: 'billing',
                target: meta.target && meta.target.service ? meta.target : null,
            });
            settle(i);
            return 'recorded';
        }
        if (p.type === 'purchase' && meta.intent_id) {
            const i = db.prepare('SELECT * FROM tip_interactions WHERE billing_intent_id = ?').get(meta.intent_id);
            if (!i) return 'ignored:not_a_tips_checkout';
            if (i.funding_txn_id) return 'duplicate_funding';
            db.prepare("UPDATE tip_interactions SET funding_txn_id = ?, test = MAX(test, ?), transfer_due = CASE WHEN payment_state = 'pending' THEN 1 ELSE 0 END, next_transfer_at = 0, updated_at = ? WHERE id = ?")
                .run(txn.id, txn.test ? 1 : 0, iso(ctx.now()), i.id);
            ctx.afterCommit(() => { processDueTransfers().catch((e) => ctx.log.warn('[Tips] transfer after funding:', e.message)); });
            return 'funded';
        }
        return 'ignored';
    }

    /** Billing reversed a transaction. Inside the inbox transaction. */
    function onBillingReversed(p) {
        const meta = p.metadata || {};
        const orig = p.reverses_txn;
        if (!orig) return 'ignored:no_original';
        const i = byBillingTxn(orig);
        if (!i) {
            const funded = db.prepare('SELECT * FROM tip_interactions WHERE funding_txn_id = ?').get(orig);
            if (funded && funded.payment_state === 'pending') { failPayment(funded, 'billing.funding_reversed', 'the checkout payment was reversed before the tip was given'); return 'funding_reversed'; }
            return 'ignored';
        }
        const ids = json(i.reversal_txn_ids, []);
        if (ids.includes(p.transaction_id)) return 'duplicate_reversal';
        ids.push(p.transaction_id);
        // Bits Billing took back from the creator: a transfer refund moves them out of the payable. A
        // provider chargeback on a site-routed tip leaves the creator's payable intact (ADR-012 rule 2).
        const clawed = p.type === 'refund' && p.from_subject === i.creator_subject ? Math.max(0, Number(meta.amount_bits) || 0) : 0;
        const take = Math.min(clawed, i.amount - i.reversed_bits);
        const at = iso(ctx.now());
        db.prepare("UPDATE tip_interactions SET payment_state = 'reversed', reversal_txn_ids = ?, reversed_bits = reversed_bits + ?, reversed_at = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(ids), take, at, at, i.id);
        if (take > 0 && !i.test) ctx.goals.reverse(i, take);
        // Undelivered effects are cancelled; a delivery that already happened stays on record.
        const cancelled = cancelQueued(get(i.id), 'payment_reversed');
        return cancelled ? 'reversed_cancelled' : 'reversed';
    }

    /** Inside a transaction: queued effects → cancelled. True when anything was cancelled. */
    function cancelQueued(i, reason) {
        const at = iso(ctx.now());
        const r = db.prepare("UPDATE interaction_effects SET state = 'cancelled', updated_at = ? WHERE interaction_id = ? AND state = 'queued'").run(at, i.id);
        db.prepare("UPDATE paid_messages SET status = 'cancelled', updated_at = ? WHERE interaction_id = ? AND status = 'queued'").run(at, i.id);
        db.prepare("UPDATE paid_media_requests SET status = 'cancelled', updated_at = ? WHERE interaction_id = ? AND status = 'queued'").run(at, i.id);
        if (!r.changes) return false;
        db.prepare("UPDATE tip_interactions SET delivery_state = 'cancelled', updated_at = ? WHERE id = ?").run(at, i.id);
        if (!i.test) ctx.outbox.emit('tips.interaction.cancelled', { type: 'interaction', id: i.id }, { ...summary(get(i.id)), reason });
        return true;
    }

    /** Aggregate the effects into delivery_state (inside a transaction). Emits failed once. */
    function recomputeDelivery(id) {
        const i = get(id);
        if (!i || i.delivery_state === 'cancelled' || i.delivery_state === 'awaiting_payment') return i;
        const effects = db.prepare('SELECT state FROM interaction_effects WHERE interaction_id = ?').all(id).map((e) => e.state);
        let next = 'queued';
        if (effects.includes('failed') && !effects.includes('queued')) next = 'failed';
        else if (!effects.includes('queued')) next = 'delivered';
        if (next === i.delivery_state) return i;
        const at = iso(ctx.now());
        db.prepare(`UPDATE tip_interactions SET delivery_state = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END, updated_at = ? WHERE id = ?`).run(next, next, at, at, id);
        if (next === 'failed' && !i.test) {
            const failed = db.prepare("SELECT effect, adapter, last_error FROM interaction_effects WHERE interaction_id = ? AND state = 'failed'").all(id);
            ctx.outbox.emit('tips.interaction.failed', { type: 'interaction', id }, { ...summary(get(id)), failed_effects: failed });
        }
        return get(id);
    }

    // ── External and simulated ───────────────────────────────
    /** A tip on the creator's own PowerChat (EXTERNAL, ADR-012): recorded once by provider ref. */
    function recordExternal(profile, input) {
        if (!profile) fail(404, 'tips.creator_not_found', 'this creator has no tip profile');
        const provider = String(input.provider || '').toLowerCase();
        if (!/^[a-z][a-z0-9_-]{1,39}$/.test(provider)) fail(422, 'tips.invalid_input', 'provider is required');
        const ref = String(input.provider_ref || '').trim();
        if (!ref || ref.length > 200) fail(422, 'tips.invalid_input', 'provider_ref (the provider event id) is required');
        const cents = positiveInt(input.amount_cents, 'amount_cents', 100_000_000);
        return ctx.tx(() => {
            const prev = db.prepare('SELECT * FROM tip_interactions WHERE provider = ? AND provider_ref = ?').get(provider, ref);
            if (prev) return { interaction: prev, replay: true };
            const i = insert({
                id: prefixedId('tint', ctx.now()), creator_subject: profile.creator_subject, supporter_subject: input.supporter ? userSubject(input.supporter, 'supporter') : null,
                supporter_name: displayName(input.supporter_name) || 'Someone', kind: 'tip', amount: cents, amount_cents: cents,
                message: text(input.message, 'message', 500), request: input.goal_id ? { goal_id: String(input.goal_id) } : {},
                funding: 'external', settlement: 'external', payment_state: 'pending', delivery_state: 'awaiting_payment',
                // origin external: the provider (or Live's webhook) already announced it in chat; with
                // announce: true Tips delivers the chat line itself.
                provider, provider_ref: ref, origin: input.announce === true ? 'tips' : 'external', test: input.test ? 1 : 0,
            });
            return { interaction: settle(i), replay: false };
        });
    }

    /** The full effect path with test = 1 and no Billing call. */
    function simulate(profile, input, { by }) {
        const v = validate(profile, { ...input, amount: input.amount || Math.max(profile.min_amount, 100) }, { simulation: true });
        return ctx.tx(() => {
            const i = insert({
                id: prefixedId('tint', ctx.now()), creator_subject: profile.creator_subject, supporter_subject: null,
                supporter_name: displayName(input.supporter_name) || 'Test supporter', kind: v.kind, amount: v.amount, message: v.message,
                request: { ...v.request, simulated_by: by }, funding: 'none', settlement: 'simulated', payment_state: 'pending',
                delivery_state: 'awaiting_payment', test: 1,
            });
            const out = settle(i);
            // Show the goal widget moving without counting anything: a test goal delivery with the
            // would-be total. No contribution row is written.
            const g = ctx.goals.pick(profile.creator_subject, v.request.goal_id);
            if (g) {
                const view = ctx.goals.present(g);
                const would = { ...view, current_amount: view.current_amount + v.amount, percent: Math.min(100, Math.floor(((view.current_amount + v.amount) * 100) / view.target_amount)) };
                ctx.overlays.addGoalDelivery(profile.creator_subject, would, { reason: 'simulation', interactionId: i.id, by: i.supporter_name, dedupe: `goal:${g.id}:sim:${i.id}`, test: true });
            }
            return out;
        });
    }

    // ── Reads ────────────────────────────────────────────────
    function summary(i) {
        return {
            interaction_id: i.id, creator: { type: 'user', id: i.creator_subject }, supporter: i.supporter_subject ? { type: 'user', id: i.supporter_subject } : null,
            supporter_name: i.supporter_name || null, kind: i.kind, amount: i.amount, currency: i.currency, settlement: i.settlement,
            payment_state: i.payment_state, delivery_state: i.delivery_state, billing_txn_id: i.billing_txn_id || null, test: !!i.test,
        };
    }

    function present(i, { viewer = 'owner' } = {}) {
        if (!i) return null;
        const req = json(i.request, {});
        const out = {
            id: i.id, creator: { type: 'user', id: i.creator_subject }, supporter: i.supporter_subject ? { type: 'user', id: i.supporter_subject } : null,
            supporter_name: i.supporter_name || null, kind: i.kind, amount: i.amount, currency: i.currency, message: i.message || null,
            tts: req.tts || null, media: req.media ? { url: req.media.url, provider: req.media.provider } : null, goal_id: req.goal_id || null,
            funding: i.funding, settlement: i.settlement, origin: i.origin, test: !!i.test,
            payment: { state: i.payment_state, billing_txn_id: i.billing_txn_id || null, reversal_txn_ids: json(i.reversal_txn_ids, []), reversed_amount: i.reversed_bits, failure: i.failure || null, settled_at: i.settled_at || null, reversed_at: i.reversed_at || null },
            delivery: { state: i.delivery_state, delivered_at: i.delivered_at || null },
            created_at: i.created_at, updated_at: i.updated_at,
        };
        if (i.funding === 'checkout') out.checkout = { url: i.checkout_url || null, ref: i.checkout_ref || null, provider: i.provider || null, intent_id: i.billing_intent_id || null };
        if (viewer === 'owner' || viewer === 'service') {
            out.effects = db.prepare('SELECT effect, adapter, state, attempts, last_error, updated_at FROM interaction_effects WHERE interaction_id = ? ORDER BY id').all(i.id);
            out.provider = i.provider || null;
            out.provider_ref = i.provider_ref || null;
            out.legacy_source = i.legacy_source || null;
        }
        return out;
    }

    /** Cursor-paged list, newest first. filter: { creator?, supporter?, includeTest? } */
    function list({ creator, supporter, includeTest = true, cursor, limit = 50 } = {}) {
        const n = Math.min(200, Math.max(1, Number(limit) || 50));
        let cur = null;
        if (cursor) { try { cur = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch { fail(422, 'tips.invalid_input', 'bad cursor'); } }
        const rows = db.prepare(`SELECT * FROM tip_interactions WHERE (@c IS NULL OR creator_subject = @c) AND (@s IS NULL OR supporter_subject = @s)
                AND (@t = 1 OR test = 0) AND (@ca IS NULL OR created_at < @ca OR (created_at = @ca AND id < @ci))
            ORDER BY created_at DESC, id DESC LIMIT @n`).all({ c: creator || null, s: supporter || null, t: includeTest ? 1 : 0, ca: cur ? cur[0] : null, ci: cur ? cur[1] : null, n: n + 1 });
        const page = rows.slice(0, n);
        const next = rows.length > n ? Buffer.from(JSON.stringify([page[n - 1].created_at, page[n - 1].id])).toString('base64url') : null;
        return { rows: page, next_cursor: next };
    }

    /**
     * A creator's totals, derived from settled interactions. `billing` is what must equal Billing's
     * books (settled through Billing or imported from Live's ledger, minus what Billing took back);
     * external and test interactions are reported apart and never mixed in.
     */
    function totals(creator) {
        const r = db.prepare(`SELECT
                COALESCE(SUM(CASE WHEN test = 0 AND settlement IN ('billing', 'imported') AND payment_state IN ('settled', 'reversed') THEN amount - reversed_bits END), 0) AS billing,
                COALESCE(SUM(CASE WHEN test = 0 AND settlement = 'external' AND payment_state = 'settled' THEN amount END), 0) AS external,
                COALESCE(SUM(CASE WHEN test = 0 AND payment_state IN ('settled', 'reversed') THEN 1 END), 0) AS count,
                COALESCE(SUM(CASE WHEN test = 1 THEN 1 END), 0) AS test_count,
                COALESCE(SUM(CASE WHEN payment_state = 'pending' THEN 1 END), 0) AS pending_count
            FROM tip_interactions WHERE creator_subject = ?`).get(creator);
        return { currency: 'vibes-bits', settled_via_billing: r.billing, external: r.external, interactions: r.count, simulations: r.test_count, pending: r.pending_count };
    }

    return {
        get, byBillingTxn, validate, request, transfer, startCheckout, processDueTransfers, settleByTransaction, settle, failPayment,
        onBillingSettled, onBillingReversed, cancelQueued, recomputeDelivery, recordExternal, simulate, summary, present, list, totals, insert, KINDS,
    };
}

module.exports = { createInteractions, KINDS, highlightFor };

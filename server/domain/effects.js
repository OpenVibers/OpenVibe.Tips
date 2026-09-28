'use strict';

/**
 * The effects worker: delivers the queued interaction_effects of settled interactions through the
 * chat adapters, with retries. One effect = one adapter call with a stable delivery id
 * (`<interaction>:<effect>`), so the receiving side can drop a repeat after a lost response.
 *
 * A failure is retried with backoff (TIPS_DELIVERY_BACKOFF_MS) up to TIPS_DELIVERY_MAX_ATTEMPTS, or
 * stops at once when the adapter says it is permanent. The interaction's delivery_state is then
 * recomputed (failed → tips.interaction.failed). payment_state is never touched here.
 *
 * A job carries the interaction's public view only (privacy.js): an anonymous supporter is
 * "Anonymous" with no subject, a hidden amount is null and left out of the line, a private message
 * is not sent, and the creator's word filter has starred blocked words out of the line and dropped
 * them from the TTS text. `privacy` tells the receiving product what was withheld. An effect whose
 * interaction a moderator hid (or whose effect was cancelled meanwhile) is never delivered.
 *
 * Writes to an effect and what it delivers (paid message, media request, the interaction's delivery
 * state) run SERIALIZABLE with the interaction row locked first, as the money paths do.
 *
 * Every process runs the worker; each batch of due effects is claimed with a lease (next_attempt_at
 * moved past the batch's worst case, FOR UPDATE SKIP LOCKED), so no two processes deliver one effect
 * at once, and a process that dies mid-batch leaves its effects to the others when the lease ends.
 */
const { sql } = require('openvibe-sdk/db');
const { iso } = require('../util');
const { privacyOf, isAnonymous, publicView } = require('./privacy');

// A delivery takes up to 10 s (twice with a token refresh): 20 of them finish well inside the lease.
const BATCH = 20;
const LEASE_MS = 5 * 60_000;

function createEffects(ctx) {
    const { db, config } = ctx;
    let running = false;
    let kickTimer = null;

    function jobFor(effect, i, profile) {
        const req = i.request || {};
        const pv = publicView(i, { filter: profile ? profile.filter : null });
        const name = pv.supporter_name;
        const amount = pv.amount != null ? `${pv.amount.toLocaleString('en-US')} Vibes` : null;
        const msg = pv.message ? `: ${pv.message}` : '';
        const job = {
            delivery_id: `${i.id}:${effect.effect}`,
            effect: effect.effect,
            test: !!i.test,
            creator: { type: 'user', id: i.creator_subject, handle: profile ? profile.handle : null },
            supporter: { name, subject: i.supporter_subject && !isAnonymous(i) ? { type: 'user', id: i.supporter_subject } : null },
            interaction: { id: i.id, kind: i.kind, amount: pv.amount, currency: i.currency, message: pv.message },
            privacy: privacyOf(i),
            // A tip on the creator's own PowerChat reads as Live's webhook wrote it: "… (PowerChat)".
            text: `${name} ${amount ? `tipped ${amount}` : 'sent a tip'}${msg}${i.settlement === 'external' && i.provider === 'powerchat' ? ' (PowerChat)' : ''}`,
            target: i.target || null,
        };
        if (effect.effect === 'paid_message') job.highlight_seconds = req.highlight_seconds || 0;
        if (effect.effect === 'tts') job.tts = pv.tts;
        if (effect.effect === 'media_request') { job.media = req.media; job.text = amount ? `${name} requested media for ${amount}` : `${name} requested media`; }
        return job;
    }

    function markDone(effect, result) {
        return ctx.tx(async (t) => {
            await ctx.interactions.lock(t, effect.interaction_id);
            const at = iso(ctx.now());
            const n = await t.exec(sql`UPDATE interaction_effects SET state = 'delivered', attempts = attempts + 1, last_error = NULL, result = ${sql.json(result || null)},
                updated_at = ${at} WHERE id = ${effect.id} AND state = 'queued'`);
            if (!n) return;   // cancelled meanwhile (a reversal): the delivery stays recorded on the adapter's side
            const ref = sql.json((result && result.ref) || null);
            if (effect.effect === 'paid_message' || effect.effect === 'tts') {
                await t.exec(sql`UPDATE paid_messages SET status = 'delivered', chat_ref = ${ref}, updated_at = ${at} WHERE interaction_id = ${effect.interaction_id} AND status = 'queued'`);
            }
            if (effect.effect === 'media_request') {
                await t.exec(sql`UPDATE paid_media_requests SET status = 'accepted', queue_ref = ${ref}, updated_at = ${at} WHERE interaction_id = ${effect.interaction_id} AND status = 'queued'`);
            }
            await ctx.interactions.recomputeDelivery(t, effect.interaction_id);
        }, ctx.MONEY);
    }

    async function markFailed(effect, err) {
        await ctx.tx(async (t) => {
            await ctx.interactions.lock(t, effect.interaction_id);
            const at = iso(ctx.now());
            const attempts = effect.attempts + 1;
            const final = err.permanent || attempts >= config.chat.maxAttempts;
            const backoff = config.chat.backoffMs[Math.min(attempts - 1, config.chat.backoffMs.length - 1)] || 60000;
            await t.exec(sql`UPDATE interaction_effects SET state = ${final ? 'failed' : 'queued'}, attempts = ${attempts}, next_attempt_at = ${ctx.now() + backoff},
                last_error = ${String(err.message || err).slice(0, 500)}, updated_at = ${at} WHERE id = ${effect.id} AND state = 'queued'`);
            if (final) {
                if (effect.effect === 'paid_message' || effect.effect === 'tts') await t.exec(sql`UPDATE paid_messages SET status = 'failed', updated_at = ${at} WHERE interaction_id = ${effect.interaction_id} AND status = 'queued'`);
                if (effect.effect === 'media_request') await t.exec(sql`UPDATE paid_media_requests SET status = 'failed', updated_at = ${at} WHERE interaction_id = ${effect.interaction_id} AND status = 'queued'`);
                await ctx.interactions.recomputeDelivery(t, effect.interaction_id);
            }
        }, ctx.MONEY);
        ctx.outboxKick();
    }

    async function runOne(effect) {
        // Re-read: the batch was claimed before earlier deliveries awaited; a hide or a reversal may
        // have cancelled this one since.
        const current = await db.maybe(sql`SELECT state FROM interaction_effects WHERE id = ${effect.id}`);
        if (!current || current.state !== 'queued') return 'cancelled';
        const i = await ctx.interactions.get(db, effect.interaction_id);
        if (!i || i.payment_state !== 'settled') {
            // Reversed or failed before its turn: nothing to deliver.
            await ctx.tx(async (t) => { const locked = await ctx.interactions.lock(t, effect.interaction_id); if (locked) await ctx.interactions.cancelQueued(t, locked, 'payment_not_settled'); }, ctx.MONEY);
            return 'cancelled';
        }
        if (i.moderation !== 'visible') {
            // Hidden or held: moderation.js cancels or releases these; never deliver one meanwhile.
            await db.exec(sql`UPDATE interaction_effects SET state = 'cancelled', last_error = 'hidden by moderation', updated_at = ${iso(ctx.now())}
                WHERE id = ${effect.id} AND state = 'queued'`);
            return 'cancelled';
        }
        const adapter = ctx.adapters[effect.adapter];
        if (!adapter) { await markFailed(effect, Object.assign(new Error(`no adapter ${effect.adapter} configured`), { permanent: true })); return 'failed'; }
        let result;
        try {
            result = await adapter.deliver(jobFor(effect, i, await ctx.profiles.bySubject(db, i.creator_subject)));
        } catch (e) {
            await markFailed(effect, e);
            return 'retry';
        }
        await markDone(effect, result);
        return 'delivered';
    }

    /** Claim a batch of due effects (a lease each), oldest first. */
    async function claim() {
        const now = ctx.now();
        const rows = await db.many(sql`UPDATE interaction_effects SET next_attempt_at = ${now + LEASE_MS}
            WHERE id IN (SELECT id FROM interaction_effects WHERE state = 'queued' AND next_attempt_at <= ${now}
                         ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
            RETURNING *`);
        return rows.sort((a, b) => a.id - b.id);
    }

    /** Deliver every due effect once (this process's share of them). */
    async function drain() {
        if (running) return { busy: true };
        running = true;
        const out = { delivered: 0, retry: 0, failed: 0, cancelled: 0 };
        try {
            for (;;) {
                const due = await claim();
                if (!due.length) break;
                for (const e of due) { const r = await runOne(e); out[r] = (out[r] || 0) + 1; }
                if (due.length < BATCH) break;
            }
        } finally { running = false; }
        return out;
    }

    function kick() {
        if (!config.jobs.enabled || kickTimer) return;
        kickTimer = setTimeout(() => { kickTimer = null; drain().catch((e) => ctx.log.warn('[Tips] effects:', e.message)); }, 0);
        if (kickTimer.unref) kickTimer.unref();
    }

    return { drain, kick, jobFor };
}

module.exports = { createEffects };

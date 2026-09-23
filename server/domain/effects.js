'use strict';

/**
 * The effects worker: delivers the queued interaction_effects of settled interactions through the
 * chat adapters, with retries. One effect = one adapter call with a stable delivery id
 * (`<interaction>:<effect>`), so the receiving side can drop a repeat after a lost response.
 *
 * A failure is retried with backoff (TIPS_DELIVERY_BACKOFF_MS) up to TIPS_DELIVERY_MAX_ATTEMPTS, or
 * stops at once when the adapter says it is permanent. The interaction's delivery_state is then
 * recomputed (failed → tips.interaction.failed). payment_state is never touched here.
 */
const { iso, json } = require('../util');

function createEffects(ctx) {
    const { db, config } = ctx;
    let running = false;
    let kickTimer = null;

    function jobFor(effect, i, profile) {
        const req = json(i.request, {});
        const name = i.supporter_name || 'Someone';
        const amount = i.amount.toLocaleString('en-US');
        const job = {
            delivery_id: `${i.id}:${effect.effect}`,
            effect: effect.effect,
            test: !!i.test,
            creator: { type: 'user', id: i.creator_subject, handle: profile ? profile.handle : null },
            supporter: { name, subject: i.supporter_subject ? { type: 'user', id: i.supporter_subject } : null },
            interaction: { id: i.id, kind: i.kind, amount: i.amount, currency: i.currency, message: i.message || null },
            // A tip on the creator's own PowerChat reads as Live's webhook wrote it: "… (PowerChat)".
            text: `${name} tipped ${amount} Vibes${i.message ? `: ${i.message}` : ''}${i.settlement === 'external' && i.provider === 'powerchat' ? ' (PowerChat)' : ''}`,
            target: json(i.target, null),
        };
        if (effect.effect === 'paid_message') job.highlight_seconds = req.highlight_seconds || 0;
        if (effect.effect === 'tts') job.tts = req.tts;
        if (effect.effect === 'media_request') { job.media = req.media; job.text = `${name} requested media for ${amount} Vibes`; }
        return job;
    }

    function markDone(effect, result) {
        ctx.tx(() => {
            const at = iso(ctx.now());
            const r = db.prepare("UPDATE interaction_effects SET state = 'delivered', attempts = attempts + 1, last_error = NULL, result = ?, updated_at = ? WHERE id = ? AND state = 'queued'")
                .run(JSON.stringify(result || null), at, effect.id);
            if (!r.changes) return;   // cancelled meanwhile (a reversal): the delivery stays recorded on the adapter's side
            const ref = JSON.stringify((result && result.ref) || null);
            if (effect.effect === 'paid_message' || effect.effect === 'tts') {
                db.prepare("UPDATE paid_messages SET status = 'delivered', chat_ref = ?, updated_at = ? WHERE interaction_id = ? AND status = 'queued'").run(ref, at, effect.interaction_id);
            }
            if (effect.effect === 'media_request') {
                db.prepare("UPDATE paid_media_requests SET status = 'accepted', queue_ref = ?, updated_at = ? WHERE interaction_id = ? AND status = 'queued'").run(ref, at, effect.interaction_id);
            }
            ctx.interactions.recomputeDelivery(effect.interaction_id);
        });
    }

    function markFailed(effect, err) {
        ctx.tx(() => {
            const at = iso(ctx.now());
            const attempts = effect.attempts + 1;
            const final = err.permanent || attempts >= config.chat.maxAttempts;
            const backoff = config.chat.backoffMs[Math.min(attempts - 1, config.chat.backoffMs.length - 1)] || 60000;
            db.prepare('UPDATE interaction_effects SET state = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND state = \'queued\'')
                .run(final ? 'failed' : 'queued', attempts, ctx.now() + backoff, String(err.message || err).slice(0, 500), at, effect.id);
            if (final) {
                if (effect.effect === 'paid_message' || effect.effect === 'tts') db.prepare("UPDATE paid_messages SET status = 'failed', updated_at = ? WHERE interaction_id = ? AND status = 'queued'").run(at, effect.interaction_id);
                if (effect.effect === 'media_request') db.prepare("UPDATE paid_media_requests SET status = 'failed', updated_at = ? WHERE interaction_id = ? AND status = 'queued'").run(at, effect.interaction_id);
                ctx.interactions.recomputeDelivery(effect.interaction_id);
            }
        });
        ctx.outboxKick();
    }

    async function runOne(effect) {
        const i = ctx.interactions.get(effect.interaction_id);
        if (!i || i.payment_state !== 'settled') {
            // Reversed or failed before its turn: nothing to deliver.
            ctx.tx(() => ctx.interactions.cancelQueued(i, 'payment_not_settled'));
            return 'cancelled';
        }
        const adapter = ctx.adapters[effect.adapter];
        if (!adapter) { markFailed(effect, Object.assign(new Error(`no adapter ${effect.adapter} configured`), { permanent: true })); return 'failed'; }
        try {
            const result = await adapter.deliver(jobFor(effect, i, ctx.profiles.bySubject(i.creator_subject)));
            markDone(effect, result);
            return 'delivered';
        } catch (e) {
            markFailed(effect, e);
            return 'retry';
        }
    }

    /** Deliver every due effect once. */
    async function drain() {
        if (running) return { busy: true };
        running = true;
        const out = { delivered: 0, retry: 0, failed: 0, cancelled: 0 };
        try {
            for (;;) {
                const due = db.prepare("SELECT * FROM interaction_effects WHERE state = 'queued' AND next_attempt_at <= ? ORDER BY id LIMIT 50").all(ctx.now());
                if (!due.length) break;
                for (const e of due) { const r = await runOne(e); out[r] = (out[r] || 0) + 1; }
                if (due.length < 50) break;
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

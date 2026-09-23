'use strict';

/**
 * The Tips domain: one context shared by profiles, goals, interactions, overlays and effects.
 *
 *   ctx.tx(fn)          run fn in one SQLite transaction; ctx.afterCommit(hook) queues work (overlay
 *                       pushes, worker kicks) that must only happen once the transaction committed
 *   ctx.outbox.emit()   durable event, inside the transaction (openvibe-sdk outbox)
 *   ctx.view(i)         the interaction's public view (privacy.js) through its creator's word filter
 */
const { publicView } = require('./privacy');
const { createProfiles } = require('./profiles');
const { createGoals } = require('./goals');
const { createOverlays } = require('./overlays');
const { createInteractions } = require('./interactions');
const { createEffects } = require('./effects');
const { createModeration } = require('./moderation');

function createDomain({ db, config, outbox, billing, adapters, now = () => Date.now(), log = console }) {
    const ctx = { db, config, now, log, outbox, billing, adapters, _after: null };

    ctx.tx = (fn) => {
        if (ctx._after) return db.transaction(fn)();
        const hooks = [];
        ctx._after = hooks;
        let result;
        try { result = db.transaction(fn)(); } finally { ctx._after = null; }
        for (const h of hooks) { try { h(); } catch (e) { log.warn('[Tips] after-commit:', e.message); } }
        return result;
    };
    ctx.afterCommit = (hook) => { if (ctx._after) ctx._after.push(hook); else hook(); };
    ctx.outboxKick = () => { try { outbox.kick(); } catch { /* relay off */ } };

    ctx.profiles = createProfiles(ctx);
    ctx.view = (i, opts = {}) => publicView(i, { ...opts, filter: ctx.profiles.filterOf(i.creator_subject) });
    ctx.goals = createGoals(ctx);
    ctx.overlays = createOverlays(ctx);
    ctx.interactions = createInteractions(ctx);
    ctx.effects = createEffects(ctx);
    ctx.moderation = createModeration(ctx);
    return ctx;
}

module.exports = { createDomain };

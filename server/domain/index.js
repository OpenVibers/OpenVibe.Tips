'use strict';

/**
 * The Tips domain: one context shared by profiles, goals, interactions, overlays and effects.
 *
 * Every function that touches the database takes the query handle first: `db` outside a transaction,
 * or the transaction's `t` inside one (never `db` inside a transaction: that would be another
 * connection, outside it). Operations that open their own transaction take no handle.
 *
 *   ctx.tx(fn, { isolation })  run fn(t) in one transaction. t.after(hook) queues work (overlay pushes,
 *                              worker and relay kicks) for after the commit: a retried attempt starts
 *                              with no hooks, a rolled-back one runs none. Anything that changes money
 *                              state (payment state, reversed bits, goal contributions, what a payment
 *                              entitles: paid messages, media requests) runs { isolation: 'serializable' }
 *                              (ADR-007 amendment 2026-09-24, rule 3); the SDK retries serialization
 *                              failures and deadlocks.
 *   ctx.within(q, fn, opts)    fn(q) when q is a transaction handle, else fn(t) in a new transaction
 *   ctx.afterCommit(q, hook)   t.after(hook) inside a transaction; at once on `db` (already committed)
 *   ctx.lockCreator(t, s)      lock a creator's profile row: settings changes and per-creator limits
 *                              (20 active goals, 25 tokens, 50 moderators, 10 invitations) take it, so two
 *                              requests at once count and write one after the other
 *   ctx.outbox.emitIn(t, …)    a durable event, inside the transaction (openvibe-sdk outbox)
 *
 * Lock order (so two transactions never wait on each other in a cycle): a creator's profile row, then
 * tip_interactions rows (SELECT … FOR UPDATE, several by id), then tip_goals rows by id, then the
 * creator's overlay stream (an advisory lock taken before a delivery is inserted: overlays.js), then
 * everything else (effects, paid messages and media requests, overlay deliveries, the outbox).
 */
const { sql } = require('openvibe-sdk/db');
const { createProfiles } = require('./profiles');
const { createGoals } = require('./goals');
const { createOverlays } = require('./overlays');
const { createInteractions } = require('./interactions');
const { createEffects } = require('./effects');
const { createModeration } = require('./moderation');

const MONEY = { isolation: 'serializable' };

function createDomain({ db, config, outbox, billing, adapters, valkey = null, now = () => Date.now(), log = console }) {
    const ctx = { db, config, now, log, outbox, billing, adapters, valkey, MONEY };

    const runHook = (h) => { Promise.resolve().then(h).catch((e) => log.warn('[Tips] after-commit:', e.message)); };
    ctx.tx = async (fn, opts = {}) => {
        let hooks = [];
        const out = await db.tx(async (t) => {
            const mine = [];   // this attempt's hooks only: a retried or rolled-back attempt's never run
            hooks = mine;
            t.after = (hook) => { mine.push(hook); };
            return fn(t);
        }, opts);
        hooks.forEach(runHook);
        return out;
    };
    const inTx = (q) => !!(q && typeof q.after === 'function');
    ctx.within = (q, fn, opts) => (inTx(q) ? fn(q) : ctx.tx(fn, opts));
    ctx.afterCommit = (q, hook) => { if (inTx(q)) q.after(hook); else runHook(hook); };
    ctx.lockCreator = (t, subject) => t.maybe(sql`SELECT creator_subject FROM creator_tip_profiles WHERE creator_subject = ${subject} FOR UPDATE`);
    // The SDK's kick is async: a rejected relay-off throw would be an unhandled rejection on a floating call.
    ctx.outboxKick = () => { try { Promise.resolve(outbox.kick()).catch(() => {}); } catch { /* relay off */ } };

    ctx.profiles = createProfiles(ctx);
    ctx.goals = createGoals(ctx);
    ctx.overlays = createOverlays(ctx);
    ctx.interactions = createInteractions(ctx);
    ctx.effects = createEffects(ctx);
    ctx.moderation = createModeration(ctx);
    return ctx;
}

module.exports = { createDomain, MONEY };

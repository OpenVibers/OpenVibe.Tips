'use strict';

/**
 * Overlays: scoped, revocable tokens; configs; deliveries; the live SSE streams (overlay-hub.js).
 *
 * Tokens. `tovl_<43 base64url chars>` shown ONCE at creation; only its SHA-256 is stored. A token
 * carries scopes (alerts, goals), optionally a config, and is never a creator cookie: an OBS
 * browser source holds it in its URL and nothing else. Revocation is immediate: the row is marked
 * and every open stream of that token, in any process, is told and closed.
 *
 * Deliveries. Every alert (a settled interaction) and goal change becomes one overlay_deliveries
 * row with a monotonic seq (the SSE event id). The first time a row is written to any overlay it
 * becomes `delivered` and emits tips.overlay.delivered (recorded just before the bytes are written);
 * a row no overlay received within the
 * delivery window becomes `failed` (tips.overlay.failed). A reconnect with Last-Event-ID
 * REPLAYS rows after that id: replay only writes bytes to a socket — it never charges, never
 * re-counts a goal, never emits another event. Simulated (test) rows are flagged and emit nothing.
 *
 * An alert's payload is the interaction's publicView() (privacy.js): an anonymous supporter reads
 * "Anonymous", a hidden amount is null, a private message is absent, blocked words are starred out.
 * refreshInteraction() rewrites the stored payloads when that view changes (an erasure), so a replay
 * or /state never shows the old one. retract() (a moderator hid it) marks the alert hidden — never
 * sent, replayed or listed again — and tells connected overlays to drop it (`retract` event).
 */
const crypto = require('crypto');
const { sql } = require('openvibe-sdk/db');
const { fail, iso, prefixedId, sha256, text } = require('../util');
const { safeUrl } = require('./profiles');
const { isHidden, publicView } = require('./privacy');
const { createOverlayHub } = require('./overlay-hub');

const SCOPES = ['alerts', 'goals'];
const STREAM_LOCK = 4610;   // the advisory-lock namespace of a creator's overlay stream (Tips' port)
const TOKEN_RE = /^tovl_[A-Za-z0-9_-]{43}$/;
// A delivery row with the interaction's real amount (an overlay's minimum applies to a hidden amount too).
const DELIVERY_COLUMNS = sql`d.*, i.amount AS interaction_amount`;
const DELIVERY_FROM = sql`overlay_deliveries d LEFT JOIN tip_interactions i ON i.id = d.interaction_id`;

function createOverlays(ctx) {
    const { db } = ctx;
    const hub = createOverlayHub({ valkey: ctx.valkey, pushNew, heartbeatMs: ctx.config.overlays.heartbeatMs, log: ctx.log });

    // ── Tokens ───────────────────────────────────────────────
    async function createToken(creator, { scopes, label, configId, createdBy }) {
        const list = Array.isArray(scopes) && scopes.length ? [...new Set(scopes.map(String))] : SCOPES;
        if (list.some((s) => !SCOPES.includes(s))) fail(422, 'tips.invalid_input', `scopes must be among ${SCOPES.join(', ')}`);
        if (configId) {
            const c = await getConfig(db, configId);
            if (!c || c.creator_subject !== creator) fail(404, 'tips.overlay_config_not_found', 'no such overlay config for this creator');
        }
        const secret = `tovl_${crypto.randomBytes(32).toString('base64url')}`;
        const row = await ctx.tx(async (t) => {
            await ctx.lockCreator(t, creator);
            const active = await t.value(sql`SELECT count(*) FROM overlay_tokens WHERE creator_subject = ${creator} AND revoked_at IS NULL`);
            if (active >= 25) fail(409, 'tips.too_many_tokens', 'revoke an overlay token before creating another (25 active at most)');
            return t.one(sql`INSERT INTO overlay_tokens (id, creator_subject, token_hash, scopes, config_id, label, created_by, created_at)
                VALUES (${prefixedId('tovt', ctx.now())}, ${creator}, ${sha256(secret)}, ${sql.json(list)}, ${configId || null}, ${text(label, 'label', 80)}, ${createdBy}, ${iso(ctx.now())})
                RETURNING *`);
        });
        return { token: presentToken(row), secret, overlay_url: `${ctx.config.baseUrl}/overlay/${secret}`, events_url: `${ctx.config.baseUrl}/overlay/${secret}/events` };
    }
    const getToken = (q, id) => q.maybe(sql`SELECT * FROM overlay_tokens WHERE id = ${String(id || '')}`);
    const listTokens = (q, creator) => q.many(sql`SELECT * FROM overlay_tokens WHERE creator_subject = ${creator} ORDER BY revoked_at IS NOT NULL, created_at DESC`);

    /** The active token row for a presented secret, or null (unknown, malformed or revoked). */
    async function authenticate(q, secret) {
        if (!TOKEN_RE.test(String(secret || ''))) return null;
        const row = await q.maybe(sql`SELECT * FROM overlay_tokens WHERE token_hash = ${sha256(secret)}`);
        if (!row || row.revoked_at) return null;
        return row;
    }

    async function revokeToken(row) {
        const out = await db.maybe(sql`UPDATE overlay_tokens SET revoked_at = ${iso(ctx.now())} WHERE id = ${row.id} AND revoked_at IS NULL RETURNING *`);
        await hub.revoke(row.creator_subject, row.id);
        return presentToken(out || await getToken(db, row.id));
    }

    function presentToken(t) {
        if (!t) return null;
        return {
            id: t.id, creator: { type: 'user', id: t.creator_subject }, scopes: t.scopes, label: t.label || null, config_id: t.config_id || null,
            created_at: t.created_at, last_used_at: t.last_used_at || null, revoked_at: t.revoked_at || null, active: !t.revoked_at,
        };
    }

    // ── Configs ──────────────────────────────────────────────
    const getConfig = (q, id) => q.maybe(sql`SELECT * FROM overlay_configs WHERE id = ${String(id || '')}`);
    const listConfigs = (q, creator) => q.many(sql`SELECT * FROM overlay_configs WHERE creator_subject = ${creator} ORDER BY created_at`);

    function settingsOf(kind, input = {}, base = {}) {
        const s = { ...base };
        const int = (k, lo, hi) => {
            if (input[k] === undefined || input[k] === '') return;
            const n = Number(input[k]);
            if (!Number.isInteger(n) || n < lo || n > hi) fail(422, 'tips.invalid_input', `${k} must be between ${lo} and ${hi}`);
            s[k] = n;
        };
        const bool = (k) => { if (input[k] !== undefined) s[k] = input[k] === true || input[k] === 'on' || input[k] === '1' || input[k] === 1; };
        const url = (k) => {
            if (input[k] === undefined) return;
            if (!input[k]) { s[k] = null; return; }
            const u = safeUrl(input[k]);
            if (!u) fail(422, 'tips.invalid_input', `${k} must be an https URL`);
            s[k] = u;
        };
        if (kind === 'alerts') {
            int('min_amount', 1, 10_000_000); int('duration_ms', 1000, 60_000);
            bool('show_message'); bool('show_amount'); bool('speak_message');
            url('sound_url'); url('image_url');
            if (input.template !== undefined) s.template = text(input.template, 'template', 120);
        } else {
            bool('show_amounts'); bool('show_percent');
        }
        return s;
    }
    const DEFAULTS = {
        alerts: { min_amount: 1, duration_ms: 8000, show_message: true, show_amount: true, speak_message: false, sound_url: null, image_url: null, template: '{name} tipped {amount} Vibes' },
        goal: { show_amounts: true, show_percent: true },
    };

    async function createConfig(creator, input = {}) {
        const kind = input.kind === 'goal' ? 'goal' : input.kind === 'alerts' ? 'alerts' : fail(422, 'tips.invalid_input', "kind must be 'alerts' or 'goal'");
        const name = text(input.name, 'name', 80) || (kind === 'alerts' ? 'Alerts' : 'Goal');
        let goalId = null;
        if (kind === 'goal' && input.goal_id) {
            const g = await ctx.goals.get(db, input.goal_id);
            if (!g || g.creator_subject !== creator) fail(404, 'tips.goal_not_found', 'no such goal for this creator');
            goalId = g.id;
        }
        const at = iso(ctx.now());
        const row = await db.one(sql`INSERT INTO overlay_configs (id, creator_subject, kind, name, settings, goal_id, created_at, updated_at)
            VALUES (${prefixedId('tovc', ctx.now())}, ${creator}, ${kind}, ${name}, ${sql.json(settingsOf(kind, input, DEFAULTS[kind]))}, ${goalId}, ${at}, ${at}) RETURNING *`);
        return presentConfig(row);
    }

    /**
     * A settings change on the locked row (two at once apply one after the other); with `revision` it
     * applies only to that revision (else 409).
     */
    function updateConfig(config, input = {}) {
        return ctx.tx(async (t) => {
            const c = await t.one(sql`SELECT * FROM overlay_configs WHERE id = ${config.id} FOR UPDATE`);
            if (input.revision != null && Number(input.revision) !== c.revision) fail(409, 'tips.revision_conflict', `the config is at revision ${c.revision}`);
            return changeConfig(t, c, input);
        });
    }
    async function changeConfig(t, c, input) {
        const settings = settingsOf(c.kind, input, c.settings || {});
        let goalId = c.goal_id;
        if (c.kind === 'goal' && input.goal_id !== undefined) {
            if (!input.goal_id) goalId = null;
            else {
                const g = await ctx.goals.get(t, input.goal_id);
                if (!g || g.creator_subject !== c.creator_subject) fail(404, 'tips.goal_not_found', 'no such goal for this creator');
                goalId = g.id;
            }
        }
        const name = input.name !== undefined ? (text(input.name, 'name', 80) || c.name) : c.name;
        const out = presentConfig(await t.one(sql`UPDATE overlay_configs SET name = ${name}, settings = ${sql.json(settings)}, goal_id = ${goalId},
            revision = revision + 1, updated_at = ${iso(ctx.now())} WHERE id = ${c.id} RETURNING *`));
        // Open overlays using this config, in any process, pick the change up once it is committed.
        t.after(() => hub.config(c.creator_subject, out));
        return out;
    }

    function presentConfig(c) {
        if (!c) return null;
        return { id: c.id, creator: { type: 'user', id: c.creator_subject }, kind: c.kind, name: c.name, settings: c.settings || {}, goal_id: c.goal_id || null, revision: c.revision, created_at: c.created_at, updated_at: c.updated_at };
    }

    // ── Deliveries ───────────────────────────────────────────
    /**
     * Inside a transaction. Open overlays hear of it once the transaction committed.
     *
     * A row's seq comes from its identity when it is inserted, but other processes see it only at commit.
     * Two transactions of one creator committing out of order (seq 101 before 100) would let a stream move
     * past 100 before 100 exists for it, and never send it. So a creator's deliveries are inserted under
     * a transaction-scoped advisory lock (allowed through PgBouncer): the next insert for that creator
     * waits for the previous transaction to end, and a creator's seqs become visible in order.
     */
    async function insertDelivery(t, creator, kind, { interactionId = null, goalId = null, payload, test = false, dedupe }) {
        await t.query(sql`SELECT pg_advisory_xact_lock(${STREAM_LOCK}, hashtext(${creator}))`);
        const row = await t.maybe(sql`INSERT INTO overlay_deliveries (id, creator_subject, kind, interaction_id, goal_id, payload, test, status, dedupe_key, created_at)
            VALUES (${prefixedId('tovd', ctx.now())}, ${creator}, ${kind}, ${interactionId}, ${goalId}, ${sql.json(payload)}, ${!!test}, 'pending', ${dedupe}, ${iso(ctx.now())})
            ON CONFLICT DO NOTHING RETURNING id`);
        if (row) ctx.afterCommit(t, () => hub.notify(creator));
        return row ? row.id : null;
    }

    /** Inside the settlement transaction (or a simulation). `filter`: the creator's word filter. */
    function addAlert(t, interaction, filter) {
        const payload = publicView(interaction, { at: iso(ctx.now()), filter });
        return insertDelivery(t, interaction.creator_subject, 'alert', { interactionId: interaction.id, payload, test: interaction.test, dedupe: `alert:${interaction.id}` });
    }

    /**
     * Inside a transaction: these interactions' public view changed (an erasure, a moderation). Their
     * alert payloads are rewritten and the goal updates they caused no longer name anyone, in one read
     * and one write. `filters`: Map(creator → the creator's word filter).
     */
    async function refreshInteractions(t, interactions, filters) {
        if (!interactions.length) return;
        const byId = new Map(interactions.map((i) => [i.id, i]));
        const rows = await t.many(sql`SELECT seq, kind, payload, interaction_id FROM overlay_deliveries WHERE interaction_id = ANY(${[...byId.keys()]})`);
        if (!rows.length) return;
        const updates = rows.map((row) => {
            const i = byId.get(row.interaction_id);
            const filter = filters.get(i.creator_subject) || null;
            const old = row.payload || {};
            const payload = row.kind === 'alert' ? publicView(i, { at: old.at, filter })
                : { ...old, by: i.hide_amount || isHidden(i) ? null : publicView(i, { filter }).supporter_name };
            return { seq: row.seq, payload };
        });
        await t.exec(sql`UPDATE overlay_deliveries d SET payload = v.payload
            FROM jsonb_to_recordset(${sql.json(updates)}) AS v(seq bigint, payload jsonb) WHERE d.seq = v.seq`);
    }
    const refreshInteraction = (t, interaction, filter) => refreshInteractions(t, [interaction], new Map([[interaction.creator_subject, filter]]));

    /** Inside a transaction: a moderator hid the interaction. Its alert is never sent or replayed again. */
    async function retract(t, interaction, filter) {
        const rows = await t.many(sql`UPDATE overlay_deliveries SET hidden = true WHERE interaction_id = ${interaction.id} AND kind = 'alert' RETURNING id, seq`);
        await refreshInteraction(t, interaction, filter);
        if (rows.length) ctx.afterCommit(t, () => hub.retract(interaction.creator_subject, interaction.id, rows.map((r) => ({ id: r.id, seq: r.seq }))));
    }

    /** Inside a transaction: shown again. Back in /state and replays; open overlays are not re-alerted. */
    async function unretract(t, interaction, filter) {
        await t.exec(sql`UPDATE overlay_deliveries SET hidden = false WHERE interaction_id = ${interaction.id} AND kind = 'alert'`);
        await refreshInteraction(t, interaction, filter);
    }

    function addGoalDelivery(t, creator, goalView, { reason, interactionId, by, dedupe, test = false }) {
        return insertDelivery(t, creator, 'goal', { interactionId, goalId: goalView.id, payload: { goal: goalView, reason, by: by || null, test }, test, dedupe });
    }

    /**
     * About to write these rows to an overlay: count the sends, and the first write of a pending row
     * makes it delivered + the event (never for tests). One transaction for the batch.
     */
    async function recordSends(rows) {
        const pending = rows.filter((r) => r.status === 'pending').map((r) => r.seq);
        await ctx.tx(async (t) => {
            await t.exec(sql`UPDATE overlay_deliveries SET sends = sends + 1 WHERE seq = ANY(${rows.map((r) => r.seq)})`);
            if (!pending.length) return;
            const done = await t.many(sql`UPDATE overlay_deliveries SET status = 'delivered', delivered_at = ${iso(ctx.now())}
                WHERE seq = ANY(${pending}) AND status = 'pending' RETURNING id, creator_subject, kind, interaction_id, goal_id, test`);
            for (const row of done) {
                if (row.test) continue;
                await ctx.outbox.emit(t, 'tips.overlay.delivered', { type: 'overlay_delivery', id: row.id }, {
                    delivery_id: row.id, creator: { type: 'user', id: row.creator_subject }, kind: row.kind, interaction_id: row.interaction_id, goal_id: row.goal_id,
                });
            }
            if (done.some((r) => !r.test)) t.after(ctx.outboxKick);
        });
    }

    /**
     * Pending rows older than the window → failed (tips.overlay.failed). Returns how many. Rows are
     * claimed with SKIP LOCKED, so processes sweeping at once never fail a row twice.
     */
    async function sweepFailed() {
        const cutoff = iso(ctx.now() - ctx.config.overlays.ttlMs);
        const n = await ctx.tx(async (t) => {
            const rows = await t.many(sql`UPDATE overlay_deliveries SET status = 'failed', failed_at = ${iso(ctx.now())}
                WHERE seq IN (SELECT seq FROM overlay_deliveries WHERE status = 'pending' AND NOT hidden AND created_at < ${cutoff}
                              ORDER BY seq LIMIT 500 FOR UPDATE SKIP LOCKED)
                RETURNING id, seq, creator_subject, kind, interaction_id, goal_id, test`);
            rows.sort((a, b) => a.seq - b.seq);
            for (const row of rows) {
                if (row.test) continue;
                await ctx.outbox.emit(t, 'tips.overlay.failed', { type: 'overlay_delivery', id: row.id }, {
                    delivery_id: row.id, creator: { type: 'user', id: row.creator_subject }, kind: row.kind, interaction_id: row.interaction_id,
                    goal_id: row.goal_id, reason: 'no overlay showed it within the delivery window',
                });
            }
            return rows.length;
        });
        if (n) ctx.outboxKick();
        return n;
    }

    // ── Streams (overlay-hub.js) ─────────────────────────────
    const scopeOf = (kind) => (kind === 'alert' ? 'alerts' : 'goals');

    /** Write these rows to a client (scopes, retractions and its minimum applied), after recording them. */
    async function deliver(client, rows) {
        const shown = [];
        for (const row of rows) {
            client.lastSeq = Math.max(client.lastSeq, row.seq);
            if (row.hidden || !client.scopes.includes(scopeOf(row.kind))) continue;
            const payload = row.payload || {};
            if (row.kind === 'alert' && client.minAmount && !row.test) {
                // A hidden amount is not in the payload; the threshold still applies to the real one.
                const amount = payload.amount != null ? payload.amount : row.interaction_amount;
                if (amount < client.minAmount) continue;
            }
            shown.push({ row, payload });
        }
        if (!shown.length || client.closed) return;
        await recordSends(shown.map((x) => x.row));
        for (const { row, payload } of shown) hub.write(client, row.kind, row.seq, { delivery_id: row.id, seq: row.seq, ...payload });
    }

    async function pushNew(client) {
        const rows = await db.many(sql`SELECT ${DELIVERY_COLUMNS} FROM ${DELIVERY_FROM}
            WHERE d.creator_subject = ${client.creator} AND d.seq > ${client.lastSeq} AND d.status <> 'failed' AND NOT d.hidden ORDER BY d.seq LIMIT 200`);
        await deliver(client, rows);
    }

    /** A stream place for this token (TIPS_OVERLAY_MAX_STREAMS across processes), or null: answer 429. */
    const reserveStream = (token) => hub.reserve(token, ctx.config.overlays.maxStreamsPerToken);
    const releaseStream = (slot) => hub.release(slot);

    /**
     * Attach an SSE response (its slot from reserveStream). lastEventId (Last-Event-ID): replay what
     * came after it (bounded). Without it: what is still pending within the window, then everything new.
     */
    function attach(token, res, slot, { lastEventId, config } = {}) {
        const settings = config ? config.settings || {} : {};
        const minAmount = config && config.kind === 'alerts' ? Number(settings.min_amount) || 0 : 0;
        return hub.attach(token, res, slot, { minAmount, configId: token.config_id || null }, async (client) => {
            await db.exec(sql`UPDATE overlay_tokens SET last_used_at = ${iso(ctx.now())} WHERE id = ${token.id}`);
            const maxSeq = await db.value(sql`SELECT COALESCE(MAX(seq), 0) FROM overlay_deliveries WHERE creator_subject = ${client.creator}`);
            const goals = client.scopes.includes('goals') ? await ctx.goals.presentMany(db, await ctx.goals.list(db, client.creator, { status: 'active' })) : [];
            hub.write(client, 'hello', null, {
                creator: { type: 'user', id: client.creator }, scopes: client.scopes, config: config ? presentConfig(config) : null,
                goals, resumed_from: lastEventId != null ? lastEventId : null,
            });
            const last = Number(lastEventId);
            if (lastEventId != null && Number.isInteger(last) && last >= 0) {
                const limit = ctx.config.overlays.replayLimit;
                const rows = (await db.many(sql`SELECT ${DELIVERY_COLUMNS} FROM ${DELIVERY_FROM}
                    WHERE d.creator_subject = ${client.creator} AND d.seq > ${last} AND d.status <> 'failed' AND NOT d.hidden ORDER BY d.seq DESC LIMIT ${limit}`)).reverse();
                client.lastSeq = rows.length ? rows[0].seq - 1 : maxSeq;
                await deliver(client, rows);
                client.lastSeq = Math.max(client.lastSeq, maxSeq);
            } else {
                const cutoff = iso(ctx.now() - ctx.config.overlays.ttlMs);
                const pending = await db.many(sql`SELECT ${DELIVERY_COLUMNS} FROM ${DELIVERY_FROM}
                    WHERE d.creator_subject = ${client.creator} AND d.status = 'pending' AND NOT d.hidden AND d.created_at >= ${cutoff} ORDER BY d.seq LIMIT 100`);
                await deliver(client, pending);
                client.lastSeq = Math.max(client.lastSeq, maxSeq);
            }
        });
    }

    function recentDeliveries(q, creator, limit = 50) {
        return q.many(sql`SELECT seq, id, kind, interaction_id, goal_id, test, status, hidden, sends, created_at, delivered_at, failed_at
            FROM overlay_deliveries WHERE creator_subject = ${creator} ORDER BY seq DESC LIMIT ${limit}`);
    }

    /** The newest alerts of a creator, for GET /overlay/:token/state. */
    async function recentAlerts(q, creator) {
        return (await q.many(sql`SELECT seq, payload, test, created_at FROM overlay_deliveries WHERE creator_subject = ${creator} AND kind = 'alert' AND NOT hidden
            ORDER BY seq DESC LIMIT 20`)).map((d) => ({ seq: d.seq, ...(d.payload || {}), test: !!d.test, created_at: d.created_at }));
    }

    return {
        SCOPES, createToken, getToken, listTokens, authenticate, revokeToken, presentToken,
        getConfig, listConfigs, createConfig, updateConfig, presentConfig,
        addAlert, refreshInteraction, refreshInteractions, retract, unretract, addGoalDelivery, sweepFailed, reserveStream, releaseStream, attach,
        connected: hub.connected, closeAll: () => hub.closeAll(), close: () => hub.close(), recentDeliveries, recentAlerts,
    };
}

module.exports = { createOverlays, SCOPES, TOKEN_RE };

'use strict';

/**
 * Overlays: scoped, revocable tokens; configs; deliveries; the live SSE hub.
 *
 * Tokens. `tovl_<43 base64url chars>` shown ONCE at creation; only its SHA-256 is stored. A token
 * carries scopes (alerts, goals), optionally a config, and is never a creator cookie: an OBS
 * browser source holds it in its URL and nothing else. Revocation is immediate: the row is marked
 * and every open stream of that token is closed in the same call.
 *
 * Deliveries. Every alert (a settled interaction) and goal change becomes one overlay_deliveries
 * row with a monotonic seq (the SSE event id). The first time a row is written to any overlay it
 * becomes `delivered` and emits tips.overlay.delivered; a row no overlay received within the
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
const { fail, iso, prefixedId, sha256, json, text } = require('../util');
const { safeUrl } = require('./profiles');
const { isHidden } = require('./privacy');

const SCOPES = ['alerts', 'goals'];
const TOKEN_RE = /^tovl_[A-Za-z0-9_-]{43}$/;

function createOverlays(ctx) {
    const { db } = ctx;
    const clients = new Map();   // creator subject → Set<client>
    let nextClient = 1;

    // ── Tokens ───────────────────────────────────────────────
    function createToken(creator, { scopes, label, configId, createdBy }) {
        const list = Array.isArray(scopes) && scopes.length ? [...new Set(scopes.map(String))] : SCOPES;
        if (list.some((s) => !SCOPES.includes(s))) fail(422, 'tips.invalid_input', `scopes must be among ${SCOPES.join(', ')}`);
        if (configId) {
            const c = getConfig(configId);
            if (!c || c.creator_subject !== creator) fail(404, 'tips.overlay_config_not_found', 'no such overlay config for this creator');
        }
        const active = db.prepare('SELECT COUNT(*) AS n FROM overlay_tokens WHERE creator_subject = ? AND revoked_at IS NULL').get(creator).n;
        if (active >= 25) fail(409, 'tips.too_many_tokens', 'revoke an overlay token before creating another (25 active at most)');
        const secret = `tovl_${crypto.randomBytes(32).toString('base64url')}`;
        const id = prefixedId('tovt', ctx.now());
        db.prepare(`INSERT INTO overlay_tokens (id, creator_subject, token_hash, scopes, config_id, label, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, creator, sha256(secret), JSON.stringify(list), configId || null, text(label, 'label', 80), createdBy, iso(ctx.now()));
        return { token: presentToken(getToken(id)), secret, overlay_url: `${ctx.config.baseUrl}/overlay/${secret}`, events_url: `${ctx.config.baseUrl}/overlay/${secret}/events` };
    }
    const getToken = (id) => db.prepare('SELECT * FROM overlay_tokens WHERE id = ?').get(String(id || '')) || null;
    const listTokens = (creator) => db.prepare('SELECT * FROM overlay_tokens WHERE creator_subject = ? ORDER BY revoked_at IS NOT NULL, created_at DESC').all(creator);

    /** The active token row for a presented secret, or null (unknown, malformed or revoked). */
    function authenticate(secret) {
        if (!TOKEN_RE.test(String(secret || ''))) return null;
        const row = db.prepare('SELECT * FROM overlay_tokens WHERE token_hash = ?').get(sha256(secret));
        if (!row || row.revoked_at) return null;
        return { ...row, scopes: json(row.scopes, []) };
    }

    function revokeToken(row) {
        if (!row.revoked_at) db.prepare('UPDATE overlay_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(iso(ctx.now()), row.id);
        closeToken(row.id);
        return presentToken(getToken(row.id));
    }

    function presentToken(t) {
        if (!t) return null;
        return {
            id: t.id, creator: { type: 'user', id: t.creator_subject }, scopes: json(t.scopes, []), label: t.label || null, config_id: t.config_id || null,
            created_at: t.created_at, last_used_at: t.last_used_at || null, revoked_at: t.revoked_at || null, active: !t.revoked_at,
        };
    }

    // ── Configs ──────────────────────────────────────────────
    const getConfig = (id) => db.prepare('SELECT * FROM overlay_configs WHERE id = ?').get(String(id || '')) || null;
    const listConfigs = (creator) => db.prepare('SELECT * FROM overlay_configs WHERE creator_subject = ? ORDER BY created_at').all(creator);

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

    function createConfig(creator, input = {}) {
        const kind = input.kind === 'goal' ? 'goal' : input.kind === 'alerts' ? 'alerts' : fail(422, 'tips.invalid_input', "kind must be 'alerts' or 'goal'");
        const name = text(input.name, 'name', 80) || (kind === 'alerts' ? 'Alerts' : 'Goal');
        let goalId = null;
        if (kind === 'goal' && input.goal_id) {
            const g = ctx.goals.get(input.goal_id);
            if (!g || g.creator_subject !== creator) fail(404, 'tips.goal_not_found', 'no such goal for this creator');
            goalId = g.id;
        }
        const id = prefixedId('tovc', ctx.now());
        const at = iso(ctx.now());
        db.prepare(`INSERT INTO overlay_configs (id, creator_subject, kind, name, settings, goal_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, creator, kind, name, JSON.stringify(settingsOf(kind, input, DEFAULTS[kind])), goalId, at, at);
        return presentConfig(getConfig(id));
    }

    function updateConfig(c, input = {}) {
        if (input.revision != null && Number(input.revision) !== c.revision) fail(409, 'tips.revision_conflict', `the config is at revision ${c.revision}`);
        const settings = settingsOf(c.kind, input, json(c.settings, {}));
        let goalId = c.goal_id;
        if (c.kind === 'goal' && input.goal_id !== undefined) {
            if (!input.goal_id) goalId = null;
            else {
                const g = ctx.goals.get(input.goal_id);
                if (!g || g.creator_subject !== c.creator_subject) fail(404, 'tips.goal_not_found', 'no such goal for this creator');
                goalId = g.id;
            }
        }
        const name = input.name !== undefined ? (text(input.name, 'name', 80) || c.name) : c.name;
        db.prepare('UPDATE overlay_configs SET name = ?, settings = ?, goal_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
            .run(name, JSON.stringify(settings), goalId, iso(ctx.now()), c.id);
        const out = presentConfig(getConfig(c.id));
        // Open overlays using this config pick the change up at once.
        for (const cl of clients.get(c.creator_subject) || []) if (cl.configId === c.id) write(cl, 'config', null, { config: out });
        return out;
    }

    function presentConfig(c) {
        if (!c) return null;
        return { id: c.id, creator: { type: 'user', id: c.creator_subject }, kind: c.kind, name: c.name, settings: json(c.settings, {}), goal_id: c.goal_id || null, revision: c.revision, created_at: c.created_at, updated_at: c.updated_at };
    }

    // ── Deliveries ───────────────────────────────────────────
    function insertDelivery(creator, kind, { interactionId = null, goalId = null, payload, test = false, dedupe }) {
        const id = prefixedId('tovd', ctx.now());
        const r = db.prepare(`INSERT OR IGNORE INTO overlay_deliveries (id, creator_subject, kind, interaction_id, goal_id, payload, test, status, dedupe_key, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, creator, kind, interactionId, goalId, JSON.stringify(payload), test ? 1 : 0, dedupe, iso(ctx.now()));
        if (r.changes) ctx.afterCommit(() => notify(creator));
        return r.changes ? id : null;
    }

    /** Inside the settlement transaction (or a simulation). */
    function addAlert(interaction) {
        const payload = ctx.view(interaction, { at: iso(ctx.now()) });
        return insertDelivery(interaction.creator_subject, 'alert', { interactionId: interaction.id, payload, test: interaction.test, dedupe: `alert:${interaction.id}` });
    }

    /**
     * Inside a transaction: the interaction's public view changed. Its alert payload is rewritten, and
     * the goal updates it caused no longer name anyone.
     */
    function refreshInteraction(interaction) {
        const view = ctx.view(interaction);
        for (const row of db.prepare('SELECT seq, kind, payload FROM overlay_deliveries WHERE interaction_id = ?').all(interaction.id)) {
            const old = json(row.payload, {});
            const payload = row.kind === 'alert' ? ctx.view(interaction, { at: old.at }) : { ...old, by: interaction.hide_amount || isHidden(interaction) ? null : view.supporter_name };
            db.prepare('UPDATE overlay_deliveries SET payload = ? WHERE seq = ?').run(JSON.stringify(payload), row.seq);
        }
    }

    /** Inside a transaction: a moderator hid the interaction. Its alert is never sent or replayed again. */
    function retract(interaction) {
        db.prepare("UPDATE overlay_deliveries SET hidden = 1 WHERE interaction_id = ? AND kind = 'alert'").run(interaction.id);
        refreshInteraction(interaction);
        const rows = db.prepare("SELECT id, seq FROM overlay_deliveries WHERE interaction_id = ? AND kind = 'alert'").all(interaction.id);
        ctx.afterCommit(() => {
            for (const c of clients.get(interaction.creator_subject) || []) {
                if (!c.scopes.includes('alerts')) continue;
                for (const r of rows) write(c, 'retract', null, { interaction_id: interaction.id, delivery_id: r.id, seq: r.seq });
            }
        });
    }

    /** Inside a transaction: shown again. Back in /state and replays; open overlays are not re-alerted. */
    function unretract(interaction) {
        db.prepare("UPDATE overlay_deliveries SET hidden = 0 WHERE interaction_id = ? AND kind = 'alert'").run(interaction.id);
        refreshInteraction(interaction);
    }

    function addGoalDelivery(creator, goalView, { reason, interactionId, by, dedupe, test = false }) {
        return insertDelivery(creator, 'goal', { interactionId, goalId: goalView.id, payload: { goal: goalView, reason, by: by || null, test }, test, dedupe });
    }

    /** First write of a pending row: delivered + the event (never for tests). */
    function markDelivered(row) {
        ctx.tx(() => {
            const r = db.prepare("UPDATE overlay_deliveries SET status = 'delivered', delivered_at = ? WHERE seq = ? AND status = 'pending'").run(iso(ctx.now()), row.seq);
            if (r.changes && !row.test) {
                ctx.outbox.emit('tips.overlay.delivered', { type: 'overlay_delivery', id: row.id }, {
                    delivery_id: row.id, creator: { type: 'user', id: row.creator_subject }, kind: row.kind, interaction_id: row.interaction_id, goal_id: row.goal_id,
                });
            }
        });
        ctx.outboxKick();
    }

    /** Pending rows older than the window → failed (tips.overlay.failed). Returns how many. */
    function sweepFailed() {
        const cutoff = iso(ctx.now() - ctx.config.overlays.ttlMs);
        const rows = db.prepare("SELECT * FROM overlay_deliveries WHERE status = 'pending' AND hidden = 0 AND created_at < ? ORDER BY seq LIMIT 500").all(cutoff);
        if (!rows.length) return 0;
        ctx.tx(() => {
            for (const row of rows) {
                const r = db.prepare("UPDATE overlay_deliveries SET status = 'failed', failed_at = ? WHERE seq = ? AND status = 'pending'").run(iso(ctx.now()), row.seq);
                if (r.changes && !row.test) {
                    ctx.outbox.emit('tips.overlay.failed', { type: 'overlay_delivery', id: row.id }, {
                        delivery_id: row.id, creator: { type: 'user', id: row.creator_subject }, kind: row.kind, interaction_id: row.interaction_id,
                        goal_id: row.goal_id, reason: 'no overlay showed it within the delivery window',
                    });
                }
            }
        });
        ctx.outboxKick();
        return rows.length;
    }

    // ── SSE hub ──────────────────────────────────────────────
    const scopeOf = (kind) => (kind === 'alert' ? 'alerts' : 'goals');

    function write(client, event, id, data) {
        if (client.closed) return false;
        try {
            client.res.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            return true;
        } catch { return false; }
    }

    function send(client, row) {
        client.lastSeq = Math.max(client.lastSeq, row.seq);
        if (row.hidden || !client.scopes.includes(scopeOf(row.kind))) return;
        const payload = json(row.payload, {});
        if (row.kind === 'alert' && client.minAmount && !row.test) {
            // A hidden amount is not in the payload; the threshold still applies to the real one.
            const amount = payload.amount != null ? payload.amount : (db.prepare('SELECT amount FROM tip_interactions WHERE id = ?').get(row.interaction_id) || {}).amount;
            if (amount < client.minAmount) return;
        }
        if (!write(client, row.kind, row.seq, { delivery_id: row.id, seq: row.seq, ...payload })) return;
        db.prepare('UPDATE overlay_deliveries SET sends = sends + 1 WHERE seq = ?').run(row.seq);
        if (row.status === 'pending') markDelivered(row);
    }

    function pushNew(client) {
        const rows = db.prepare("SELECT * FROM overlay_deliveries WHERE creator_subject = ? AND seq > ? AND status != 'failed' AND hidden = 0 ORDER BY seq LIMIT 200").all(client.creator, client.lastSeq);
        for (const row of rows) send(client, row);
    }

    function notify(creator) {
        for (const c of clients.get(creator) || []) pushNew(c);
    }

    /**
     * Attach an SSE response. lastEventId (Last-Event-ID): replay what came after it (bounded).
     * Without it: what is still pending within the window, then everything new.
     */
    function attach(token, res, { lastEventId, config } = {}) {
        const settings = config ? json(config.settings, {}) : {};
        const client = {
            id: nextClient++, creator: token.creator_subject, tokenId: token.id, scopes: token.scopes, configId: token.config_id || null,
            minAmount: config && config.kind === 'alerts' ? Number(settings.min_amount) || 0 : 0, res, lastSeq: 0, closed: false,
        };
        if (!clients.has(client.creator)) clients.set(client.creator, new Set());
        clients.get(client.creator).add(client);
        db.prepare('UPDATE overlay_tokens SET last_used_at = ? WHERE id = ?').run(iso(ctx.now()), token.id);

        const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM overlay_deliveries WHERE creator_subject = ?').get(client.creator).n;
        write(client, 'hello', null, {
            creator: { type: 'user', id: client.creator }, scopes: client.scopes, config: config ? presentConfig(config) : null,
            goals: client.scopes.includes('goals') ? ctx.goals.list(client.creator, { status: 'active' }).map((g) => ctx.goals.present(g)) : [],
            resumed_from: lastEventId != null ? lastEventId : null,
        });
        const last = Number(lastEventId);
        if (lastEventId != null && Number.isInteger(last) && last >= 0) {
            const limit = ctx.config.overlays.replayLimit;
            const rows = db.prepare("SELECT * FROM overlay_deliveries WHERE creator_subject = ? AND seq > ? AND status != 'failed' AND hidden = 0 ORDER BY seq DESC LIMIT ?").all(client.creator, last, limit).reverse();
            client.lastSeq = rows.length ? rows[0].seq - 1 : maxSeq;
            for (const row of rows) send(client, row);
            client.lastSeq = Math.max(client.lastSeq, maxSeq);
        } else {
            const cutoff = iso(ctx.now() - ctx.config.overlays.ttlMs);
            const pending = db.prepare("SELECT * FROM overlay_deliveries WHERE creator_subject = ? AND status = 'pending' AND hidden = 0 AND created_at >= ? ORDER BY seq LIMIT 100").all(client.creator, cutoff);
            for (const row of pending) send(client, row);
            client.lastSeq = Math.max(client.lastSeq, maxSeq);
        }
        pushNew(client);
        const beat = setInterval(() => { if (!write(client, 'ping', null, { t: Date.now() })) detach(client); }, ctx.config.overlays.heartbeatMs);
        if (beat.unref) beat.unref();
        client.beat = beat;
        res.on('close', () => detach(client));
        return client;
    }

    function detach(client) {
        if (client.closed) return;
        client.closed = true;
        clearInterval(client.beat);
        const set = clients.get(client.creator);
        if (set) { set.delete(client); if (!set.size) clients.delete(client.creator); }
        try { client.res.end(); } catch { /* already gone */ }
    }

    function closeToken(tokenId) {
        for (const set of clients.values()) {
            for (const c of [...set]) {
                if (c.tokenId === tokenId) { write(c, 'revoked', null, { reason: 'this overlay token was revoked' }); detach(c); }
            }
        }
    }

    function connected(creator) { return (clients.get(creator) || new Set()).size; }
    function streamsFor(token) { let n = 0; for (const c of clients.get(token.creator_subject) || []) if (c.tokenId === token.id) n++; return n; }
    function closeAll() { for (const set of clients.values()) for (const c of [...set]) detach(c); }

    function recentDeliveries(creator, limit = 50) {
        return db.prepare('SELECT seq, id, kind, interaction_id, goal_id, test, status, hidden, sends, created_at, delivered_at, failed_at FROM overlay_deliveries WHERE creator_subject = ? ORDER BY seq DESC LIMIT ?').all(creator, limit);
    }

    return {
        SCOPES, createToken, getToken, listTokens, authenticate, revokeToken, presentToken,
        getConfig, listConfigs, createConfig, updateConfig, presentConfig,
        addAlert, refreshInteraction, retract, unretract, addGoalDelivery, sweepFailed, attach, detach, closeToken, notify, connected, streamsFor, closeAll, recentDeliveries,
    };
}

module.exports = { createOverlays, SCOPES, TOKEN_RE };

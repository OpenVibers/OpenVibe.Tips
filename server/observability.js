'use strict';
/**
 * Track O: truthful readiness for GET /api/ready and the Tips gauges on GET /metrics
 * (openvibe-shared/ready and openvibe-shared/metrics).
 *
 *   db            required  a real round trip to PostgreSQL through the pool (db.ready(): the store
 *                           that answered — postgresql, or pglite in development and tests — and the
 *                           pool's state)
 *   valkey        optional  a real PING (valkey.ready()). Without it (VALKEY_URL unset: skipped, or
 *                           down: degraded) per-actor limits, overlay fan-out and stream slots are
 *                           counted in each process, which is right for one process only
 *   network_jwks  optional  the Network signing key has loaded. Without it pages, overlays and the
 *                           signed Billing webhook still work, but no service or user token can be
 *                           verified (API calls and sign-in fail), so it degrades rather than fails
 *   billing       optional  Billing answers /api/health. Without it checkouts and transfers wait
 *                           (due transfers retry once it is back); settled tips still deliver
 *   events        optional  OpenVibe.Events answers /api/health. Without it (or with the relay off:
 *                           EVENTS_URL or the client secret unset) tips.* events wait in the outbox
 *
 * Gauges: pending deliveries (chat/TTS/media effects waiting for their adapter, overlay alerts no
 * overlay has shown yet) and the events outbox backlog. Counts only, never subjects. They are read in
 * one query just before a direct scrape renders (refresh()); a scrape whose read failed leaves them
 * out rather than reporting stale or invented values.
 */
const { sql } = require('openvibe-sdk/db');
const { createReadiness, skip } = require('openvibe-shared/ready');
const { TABLE: OUTBOX } = require('./events/outbox');

const PING_TTL_MS = 15_000;
// interaction_effects.effect (the CHECK constraint in migrations/0001_initial.sql): each reported, 0 when none waits.
const EFFECTS = ['chat_line', 'paid_message', 'tts', 'media_request', 'overlay_alert'];

function probe(url, fetchImpl) {
    return async () => {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000), headers: { Accept: 'application/json' } });
        try { await res.body?.cancel(); } catch { /* not needed */ }
        return res.ok ? { ok: true, detail: { http_status: res.status } } : { ok: false, error: `answered HTTP ${res.status}`, detail: { http_status: res.status } };
    };
}

function createTipsReadiness({ db, valkey = null, keys, config, outbox, release = null, fetchImpl = globalThis.fetch }) {
    const events = outbox.enabled
        ? probe(`${config.events.url}/api/health`, fetchImpl)
        : () => 'events relay off (EVENTS_URL or OV_OAUTH_CLIENT_SECRET unset): tips.* events wait in the outbox';
    return createReadiness({
        service: 'tips',
        release,
        checks: [
            { name: 'db', required: true, check: () => db.ready() },
            { name: 'valkey', required: false, check: () => (valkey ? valkey.ready() : skip('VALKEY_URL unset: limits, overlay fan-out and stream slots are per process (one process only)')) },
            { name: 'network_jwks', required: false, check: () => (keys.get() ? true : 'Network signing key not loaded yet: tokens cannot be verified') },
            { name: 'billing', required: false, cacheMs: PING_TTL_MS, timeoutMs: 2500, check: probe(`${config.billing.url}/api/health`, fetchImpl) },
            { name: 'events', required: false, cacheMs: outbox.enabled ? PING_TTL_MS : 0, timeoutMs: 2500, check: events },
        ],
        details: async (body) => (body.checks.db.status === 'ok'
            ? { events_outbox: await outbox.status(), billing_events_accepted: config.events.webhookSecrets.length > 0, pending_deliveries: await pendingDeliveries(db) }
            : { events_outbox: null, billing_events_accepted: config.events.webhookSecrets.length > 0, pending_deliveries: null }),
    });
}

async function pendingDeliveries(db) {
    const r = await db.one(sql`SELECT
            (SELECT COALESCE(jsonb_object_agg(effect, n), '{}') FROM (SELECT effect, count(*) AS n FROM interaction_effects WHERE state = 'queued' GROUP BY effect) e) AS effects,
            (SELECT count(*) FROM overlay_deliveries WHERE status = 'pending') AS overlay`);
    return { effects: r.effects, overlay: r.overlay };
}

/** Tips gauges on the openvibe-shared/metrics registry; refresh() reads them all in one query. */
function registerTipsGauges(registry, { db, now = () => Date.now(), log = console }) {
    let snap = null;
    const read = (f) => () => (snap ? f(snap) : undefined);
    registry.gauge({
        name: 'tips_effects_pending', help: 'Chat, TTS, media and alert effects waiting for their delivery adapter, by effect', labelNames: ['effect'],
        collect: read((s) => EFFECTS.map((effect) => ({ labels: { effect }, value: Number(s.effects[effect] || 0) }))),
    });
    registry.gauge({
        name: 'tips_effects_due', help: 'Queued effects whose next attempt is due now (a growing number means the worker is behind)',
        collect: read((s) => s.due),
    });
    registry.gauge({ name: 'tips_overlay_deliveries_pending', help: 'Overlay alerts and goal updates no overlay has shown yet', collect: read((s) => s.overlay) });
    registry.gauge({ name: 'tips_outbox_pending', help: 'tips.* events waiting in the outbox', collect: read((s) => s.outbox) });
    return {
        async refresh() {
            try {
                snap = await Promise.race([
                    db.one(sql`SELECT
                        (SELECT COALESCE(jsonb_object_agg(effect, n), '{}') FROM (SELECT effect, count(*) AS n FROM interaction_effects WHERE state = 'queued' GROUP BY effect) e) AS effects,
                        (SELECT count(*) FROM interaction_effects WHERE state = 'queued' AND next_attempt_at <= ${now()}) AS due,
                        (SELECT count(*) FROM overlay_deliveries WHERE status = 'pending') AS overlay,
                        (SELECT count(*) FROM ${sql.ident(OUTBOX)} WHERE sent_at IS NULL AND rejected_at IS NULL) AS outbox`),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000).unref()),
                ]);
            } catch (e) {
                snap = null;
                log.warn(`[Tips] gauges not read: ${e.message}`);
            }
        },
    };
}

module.exports = { createTipsReadiness, registerTipsGauges };

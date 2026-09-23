'use strict';
/**
 * Track O: truthful readiness for GET /api/ready and the Tips gauges on GET /metrics
 * (openvibe-shared/ready and openvibe-shared/metrics).
 *
 *   db            required  a real query on Tips' SQLite (the settings row is there and answers)
 *   network_jwks  optional  the Network signing key has loaded. Without it pages, overlays and the
 *                           signed Billing webhook still work, but no service or user token can be
 *                           verified (API calls and sign-in fail), so it degrades rather than fails
 *   billing       optional  Billing answers /api/health. Without it checkouts and transfers wait
 *                           (due transfers retry once it is back); settled tips still deliver
 *   events        optional  OpenVibe.Events answers /api/health. Without it (or with the relay off:
 *                           EVENTS_URL or the client secret unset) tips.* events wait in the outbox
 *
 * Gauges: pending deliveries (chat/TTS/media effects waiting for their adapter, overlay alerts no
 * overlay has shown yet) and the events outbox backlog. Counts only, never subjects.
 */
const { createReadiness } = require('openvibe-shared/ready');

const PING_TTL_MS = 15_000;
// interaction_effects.effect (the CHECK constraint in db.js): each reported, 0 when none waits.
const EFFECTS = ['chat_line', 'paid_message', 'tts', 'media_request', 'overlay_alert'];

function probe(url, fetchImpl) {
    return async () => {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000), headers: { Accept: 'application/json' } });
        try { await res.body?.cancel(); } catch { /* not needed */ }
        return res.ok ? { ok: true, detail: { http_status: res.status } } : { ok: false, error: `answered HTTP ${res.status}`, detail: { http_status: res.status } };
    };
}

function createTipsReadiness({ db, keys, config, outbox, release = null, fetchImpl = globalThis.fetch }) {
    const events = outbox.enabled
        ? probe(`${config.events.url}/api/health`, fetchImpl)
        : () => 'events relay off (EVENTS_URL or OV_OAUTH_CLIENT_SECRET unset): tips.* events wait in the outbox';
    return createReadiness({
        service: 'tips',
        release,
        checks: [
            { name: 'db', required: true, check: () => (db.prepare('SELECT id FROM settings WHERE id = 1').get() ? true : 'database has no settings row') },
            { name: 'network_jwks', required: false, check: () => (keys.get() ? true : 'Network signing key not loaded yet: tokens cannot be verified') },
            { name: 'billing', required: false, cacheMs: PING_TTL_MS, timeoutMs: 2500, check: probe(`${config.billing.url}/api/health`, fetchImpl) },
            { name: 'events', required: false, cacheMs: outbox.enabled ? PING_TTL_MS : 0, timeoutMs: 2500, check: events },
        ],
        details: (body) => ({
            events_outbox: body.checks.db.status === 'ok' ? outbox.status() : null,
            billing_events_accepted: config.events.webhookSecrets.length > 0,
            pending_deliveries: body.checks.db.status === 'ok' ? pendingDeliveries(db) : null,
        }),
    });
}

function pendingDeliveries(db) {
    const effects = {};
    for (const r of db.prepare("SELECT effect, COUNT(*) AS n FROM interaction_effects WHERE state = 'queued' GROUP BY effect").all()) effects[r.effect] = r.n;
    const overlay = db.prepare("SELECT COUNT(*) AS n FROM overlay_deliveries WHERE status = 'pending'").get().n;
    return { effects, overlay };
}

/** Tips gauges on the openvibe-shared/metrics registry. */
function registerTipsGauges(registry, { db, outbox, now = () => Date.now() }) {
    registry.gauge({
        name: 'tips_effects_pending', help: 'Chat, TTS, media and alert effects waiting for their delivery adapter, by effect', labelNames: ['effect'],
        collect: () => {
            const n = Object.fromEntries(EFFECTS.map((e) => [e, 0]));
            for (const r of db.prepare("SELECT effect, COUNT(*) AS n FROM interaction_effects WHERE state = 'queued' GROUP BY effect").all()) n[r.effect] = r.n;
            return Object.entries(n).map(([effect, value]) => ({ labels: { effect }, value }));
        },
    });
    registry.gauge({
        name: 'tips_effects_due', help: 'Queued effects whose next attempt is due now (a growing number means the worker is behind)',
        collect: () => db.prepare("SELECT COUNT(*) AS n FROM interaction_effects WHERE state = 'queued' AND next_attempt_at <= ?").get(now()).n,
    });
    registry.gauge({
        name: 'tips_overlay_deliveries_pending', help: 'Overlay alerts and goal updates no overlay has shown yet',
        collect: () => db.prepare("SELECT COUNT(*) AS n FROM overlay_deliveries WHERE status = 'pending'").get().n,
    });
    registry.gauge({ name: 'tips_outbox_pending', help: 'tips.* events waiting in the outbox', collect: () => outbox.status().pending });
}

module.exports = { createTipsReadiness, registerTipsGauges };

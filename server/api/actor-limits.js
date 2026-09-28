'use strict';

/**
 * Per-actor rate limits at /api/v1 (roadmap WS-R task 4; openvibe-sdk/limits).
 *
 * Counted by who calls, as api/auth.js resolved req.principal: a service by its principal (svc:live), a
 * person by their subject (user:usr_…), anyone else by address. Past a limit the route answers 429
 * problem+json `rate_limited` with Retry-After before it does any work (before the idempotency store,
 * Billing or chat delivery); the refusal is logged once and counted in tips_rate_limited_total{limit,window}.
 * Reads get TIPS_LIMITS_MINUTE / TIPS_LIMITS_HOUR (120 and 3000); writes and payments set their own,
 * tighter numbers in api/v1.js. With VALKEY_URL the counters are shared by every process and host
 * (openvibe-sdk createValkeyLimitStore: one atomic script per request); if Valkey fails, a request is
 * counted by its process's own counters instead, so an outage neither opens nor closes the gates.
 * Without Valkey they live in this process (one process only).
 *
 * Never limited: /api/health, /api/ready, /release.json, /metrics, the overlays (a scoped token each,
 * capped by TIPS_OVERLAY_MAX_STREAMS) and the signed Events deliveries at /internal/events (Billing's
 * settlements: Events pushes at its own pace, and a 429 would only make it retry and fall behind).
 */
const { createActorLimiter, createValkeyLimitStore, defaultActor } = require('openvibe-sdk/limits');

function actor(req) {
    const p = req.principal;
    if (p && p.kind === 'service' && p.sub) return p.sub;
    if (p && p.kind === 'user' && p.subject) return `user:${p.subject}`;
    return defaultActor(req);
}

/** limits(name, own) middleware for one app, plus limits.reads(name): the defaults on GET/HEAD. */
function createActorLimits({ config, valkey = null, now = () => Date.now(), registry = null, log = console }) {
    const refused = registry
        ? registry.counter({ name: 'tips_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limiter = createActorLimiter({
        limits: { minute: config.actorLimits.minute, hour: config.actorLimits.hour },
        actor,
        now,
        store: createValkeyLimitStore(valkey),
        log,
        onLimited(e) {
            // The actor is a principal, a subject id or an address, never a token.
            log.warn(`[Tips] limit ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    limiter.reads = (name) => {
        const limit = limiter(name);
        return (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? limit(req, res, next) : next());
    };
    return limiter;
}

module.exports = { createActorLimits, actor };

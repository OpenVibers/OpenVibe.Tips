'use strict';

/**
 * OpenVibe.Tips — process entry. `node server/index.js`
 * Listens on PORT (4610) behind nginx (openvibe.tips); see deploy/.
 *
 * Boot (ADR-035): apply migrations/ with the owner role (DATABASE_DIRECT_URL, one direct connection,
 * closed afterwards), then serve on the pooled runtime role (DATABASE_URL, through PgBouncer) with
 * Valkey (VALKEY_URL) for what the processes share. Several processes may start together: the
 * migration run is serialised by an advisory lock.
 *
 * Background jobs (TIPS_JOBS=off disables them), in every process: the effects worker (chat delivery
 * with retries), due Billing transfers (funded checkouts, retries after Billing was unreachable), the
 * overlay delivery window (pending → failed), stored API answers and sent events older than a week,
 * and the events outbox relay when EVENTS_URL is set. Running them in several processes is safe: the
 * effects, the transfers, the sweep and the relay claim their rows (FOR UPDATE SKIP LOCKED, with a
 * lease), and the prunes are idempotent deletes.
 */
const { loadConfig } = require('./config');
const { openDb, migrate } = require('./db');
const { createApp } = require('./app');
const { createValkey } = require('openvibe-sdk/valkey');
const { createRegistry } = require('openvibe-shared/metrics');
const { gracefulStop } = require('openvibe-sdk/service');

/**
 * The process stop (openvibe-sdk/service, plan T1): the job timers and the relays stop taking new
 * work (they ran before the old server.close), the HTTP drain runs (defaults 4000/5000), then the
 * database and Valkey close; past the deadline the process exits 0, as the hand-rolled 5 s timer did.
 * Exported so a test can inject `exit` and `signals: false`.
 */
function createLifecycle({ server, app, timers = [], exit, signals } = {}) {
    const { db, valkey, domain, keys, outbox } = app.locals;
    return gracefulStop({
        name: 'Tips', server, deadlineExitCode: 0, exit, signals,
        stop: [
            () => timers.forEach(clearInterval),
            () => keys.stop(),
            () => domain.overlays.close(),
            () => outbox.stop(),
        ],
        close: [() => db.close(), () => { if (valkey) return valkey.close(); }],
    });
}

async function start() {
    const config = loadConfig();
    const registry = createRegistry();
    const db = openDb(config, { registry });
    const m = await migrate(config, { serving: db });
    if (m.held.length) console.warn(`[Tips] migrations held: ${m.held.map((h) => `${h.id} (${h.reason})`).join('; ')}`);
    const valkey = createValkey({ url: config.valkey.url, prefix: config.valkey.prefix });

    const app = createApp({ config, db, valkey, registry });
    const { domain, keys, outbox } = app.locals;
    keys.start();

    const timers = [];
    if (config.jobs.enabled) {
        const every = (ms, fn) => { const t = setInterval(() => { Promise.resolve().then(fn).catch((e) => console.warn('[Tips] job:', e.message)); }, ms); t.unref(); timers.push(t); };
        every(config.jobs.intervalMs, () => domain.effects.drain());
        every(Math.max(config.jobs.intervalMs, 5000), () => domain.interactions.processDueTransfers());
        every(30_000, () => domain.overlays.sweepFailed());
        every(6 * 3600 * 1000, () => outbox.outbox.prune());
        every(6 * 3600 * 1000, () => require('./api/idempotency').pruneAnswers(db));
        outbox.start();
    }

    const server = app.listen(config.port, config.host, () => {
        console.log(`[Tips] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (store ${db.store}; valkey ${valkey ? 'on' : 'off: per process'})`);
        console.log(`[Tips] billing ${config.billing.url}; chat adapter ${config.chat.adapter}; events relay ${outbox.enabled ? `→ ${config.events.url}` : 'off (outbox accumulates)'}; billing events ${config.events.webhookSecrets.length ? 'accepted' : 'not accepted (TIPS_EVENTS_SECRET unset)'}`);
    });
    server.keepAliveTimeout = 65_000;

    createLifecycle({ server, app, timers });
    return { server, app };
}

if (require.main === module) {
    start().catch((e) => {
        console.error(`[Tips] could not start: ${e.message}`);
        process.exit(1);
    });
}

module.exports = { start, createLifecycle };

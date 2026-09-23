'use strict';

/**
 * OpenVibe.Tips — process entry. `node server/index.js`
 * Listens on PORT (4610) behind nginx (openvibe.tips); see deploy/.
 *
 * Background jobs (TIPS_JOBS=off disables them): the effects worker (chat delivery with retries),
 * due Billing transfers (funded checkouts, retries after Billing was unreachable), the overlay
 * delivery window (pending → failed), and the events outbox relay when EVENTS_URL is set.
 */
const { loadConfig } = require('./config');
const { createApp } = require('./app');

const config = loadConfig();
const app = createApp({ config });
const { domain, keys, outbox } = app.locals;
keys.start();

const timers = [];
if (config.jobs.enabled) {
    const every = (ms, fn) => { const t = setInterval(() => { Promise.resolve().then(fn).catch((e) => console.warn('[Tips] job:', e.message)); }, ms); t.unref(); timers.push(t); };
    every(config.jobs.intervalMs, () => domain.effects.drain());
    every(Math.max(config.jobs.intervalMs, 5000), () => domain.interactions.processDueTransfers());
    every(30_000, () => domain.overlays.sweepFailed());
    every(6 * 3600 * 1000, () => outbox.outbox.prune());
    outbox.start();
}

const server = app.listen(config.port, config.host, () => {
    console.log(`[Tips] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${config.dbPath})`);
    console.log(`[Tips] billing ${config.billing.url}; chat adapter ${config.chat.adapter}; events relay ${outbox.enabled ? `→ ${config.events.url}` : 'off (outbox accumulates)'}; billing events ${config.events.webhookSecrets.length ? 'accepted' : 'not accepted (TIPS_EVENTS_SECRET unset)'}`);
});
server.keepAliveTimeout = 65_000;

function shutdown(signal) {
    console.log(`[Tips] ${signal} — closing`);
    timers.forEach(clearInterval);
    domain.overlays.closeAll();
    outbox.stop();
    keys.stop();
    server.close(() => { try { domain.db.close(); } catch { /* */ } process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

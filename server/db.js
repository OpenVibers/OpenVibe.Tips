'use strict';

/**
 * Tips' own PostgreSQL database (ADR-035), through openvibe-sdk/db: async, pooled, one dialect.
 *
 * The schema is migrations/NNNN_*.sql (expand/migrate/contract, ADR-028), applied at boot by
 * migrate() on the owner's direct connection (DATABASE_DIRECT_URL); the service then serves on the
 * pooled runtime role (DATABASE_URL, PgBouncer in transaction mode: no session state, 10 connections
 * per process at most).
 *
 * The product tables (roadmap §15.11) store interaction state and REFERENCES to Billing transactions,
 * never a mutable cash balance. Amounts are integer vibes-bits as Billing counts them; a creator's
 * totals are always derived from settled interactions.
 *
 *   creator_tip_profiles    one per creator subject: page switch, minimums, TTS/media settings
 *   tip_interactions        one logical interaction; payment_state (mirrored from Billing, keyed by
 *                           Billing txn id) is separate from delivery_state (Tips' own effects)
 *   tip_goals               creator goals
 *   tip_goal_contributions  settled interactions counted toward a goal (never tests, never pending)
 *   paid_messages           highlighted paid chat messages and TTS requests, created on settlement
 *   paid_media_requests     paid media requests, created on settlement
 *   overlay_configs         alert / goal overlay settings
 *   overlay_deliveries      what overlays were sent (monotonic seq per creator, replayable)
 *   interaction_effects     the retryable delivery work of an interaction (chat line, TTS, media, overlay)
 *   migration_maps          legacy (Live) row → Tips entity, with held/excluded reasons
 *
 * Supporting: overlay_tokens (hashed, scoped, revocable), tip_moderators / _invites / _moderation_log,
 * api_idempotency, import_runs, tips_event_outbox + tips_event_inbox (openvibe-sdk outbox and inbox).
 *
 *   openDb(config)            the serving handle: DATABASE_URL; in development without it, an embedded
 *                             PGlite database in data/pglite (one process, nothing to install)
 *   migrate(config, {serving}) apply migrations/ with the owner role (DATABASE_DIRECT_URL), then close
 *                             that connection; the embedded database migrates on its serving handle
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

function openDb(config, { registry, log = console } = {}) {
    if (!config.db.url && !config.isProduction) {
        log.warn(`[Tips] DATABASE_URL unset: embedded PGlite database in ${DEV_PGLITE} (development only, one process)`);
        fs.mkdirSync(DEV_PGLITE, { recursive: true });
        return createDb({ pglite: DEV_PGLITE, service: 'tips', registry, log });
    }
    return createDb({ url: config.db.url, service: 'tips', registry, log });
}

/**
 * Apply pending migrations. Several processes starting together are safe: the SDK serialises runs
 * with an advisory lock held on the owner's one direct session.
 */
async function migrate(config, { serving = null, log = console } = {}) {
    if (serving && serving.store === 'pglite') return serving.migrate({ dir: MIGRATIONS, log });
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'tips-migrate', max: 1, log });
    try { return await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
}

module.exports = { openDb, migrate, MIGRATIONS };

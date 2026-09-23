'use strict';

/**
 * Tips' own SQLite database (WAL), created on boot, idempotent.
 *
 * The ten product tables (roadmap §15.11) store interaction state and REFERENCES to Billing
 * transactions — never a mutable cash balance. Amounts are integer vibes-bits as Billing counts
 * them; a creator's totals are always derived from settled interactions.
 *
 *   creator_tip_profiles    one per creator subject: page switch, minimums, TTS/media settings
 *   tip_interactions        one logical interaction; payment_state (mirrored from Billing, keyed by
 *                           Billing txn id) is separate from delivery_state (Tips' own effects)
 *   tip_goals               creator goals
 *   tip_goal_contributions  settled interactions counted toward a goal (never tests, never pending)
 *   paid_messages           highlighted paid chat messages and TTS requests — created on settlement
 *   paid_media_requests     paid media requests — created on settlement
 *   overlay_configs         alert / goal overlay settings
 *   overlay_deliveries      what overlays were sent (monotonic seq per creator, replayable)
 *   interaction_effects     the retryable delivery work of an interaction (chat line, TTS, media, overlay)
 *   migration_maps          legacy (Live) row → Tips entity, with held/excluded reasons
 *
 * Supporting: overlay_tokens (hashed, scoped, revocable), api_idempotency, import_runs,
 * event_outbox + idempotency_receipts (openvibe-sdk outbox and inbox), settings.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version  INTEGER NOT NULL,
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS creator_tip_profiles (
    creator_subject         TEXT PRIMARY KEY,               -- usr_…
    handle                  TEXT NOT NULL UNIQUE,           -- lower-case Network username (projection)
    display_name            TEXT NOT NULL,
    avatar_url              TEXT,
    headline                TEXT,
    page_enabled            INTEGER NOT NULL DEFAULT 0,     -- public page + indexing
    accepting               INTEGER NOT NULL DEFAULT 1,     -- new tips accepted
    min_amount              INTEGER NOT NULL DEFAULT 1,
    paid_message_min        INTEGER NOT NULL DEFAULT 100,
    tts_enabled             INTEGER NOT NULL DEFAULT 0,
    tts_min_amount          INTEGER NOT NULL DEFAULT 100,
    tts_max_chars           INTEGER NOT NULL DEFAULT 200,
    tts_voice               TEXT NOT NULL DEFAULT 'gary',
    media_requests_enabled  INTEGER NOT NULL DEFAULT 0,
    media_request_min       INTEGER NOT NULL DEFAULT 25,
    media_max_seconds       INTEGER NOT NULL DEFAULT 600,
    revision                INTEGER NOT NULL DEFAULT 1,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tip_interactions (
    id                  TEXT PRIMARY KEY,                   -- tint_<ULID>
    creator_subject     TEXT NOT NULL,
    supporter_subject   TEXT,                               -- null: external/anonymous/unmapped
    supporter_name      TEXT,                               -- display projection at the time
    kind                TEXT NOT NULL CHECK (kind IN ('tip', 'paid_message', 'tts', 'media_request')),
    amount              INTEGER NOT NULL CHECK (amount > 0),
    currency            TEXT NOT NULL DEFAULT 'vibes-bits',
    amount_cents        INTEGER,                            -- money that arrived (provider/external)
    message             TEXT,
    request             TEXT NOT NULL DEFAULT '{}',         -- JSON: tts text/voice, media url, goal_id, target
    funding             TEXT NOT NULL CHECK (funding IN ('credit', 'checkout', 'provider', 'external', 'none')),
    settlement          TEXT NOT NULL CHECK (settlement IN ('billing', 'external', 'simulated', 'imported')),
    payment_state       TEXT NOT NULL CHECK (payment_state IN ('pending', 'settled', 'reversed', 'failed')),
    delivery_state      TEXT NOT NULL CHECK (delivery_state IN ('awaiting_payment', 'queued', 'delivered', 'failed', 'cancelled')),
    test                INTEGER NOT NULL DEFAULT 0,         -- simulation or Billing test money: never counted
    billing_txn_id      TEXT UNIQUE,                        -- the Billing transaction that settled it
    billing_intent_id   TEXT UNIQUE,                        -- checkout: the Billing payment intent
    funding_txn_id      TEXT UNIQUE,                        -- checkout: the purchase that funded it
    reversal_txn_ids    TEXT NOT NULL DEFAULT '[]',
    reversed_bits       INTEGER NOT NULL DEFAULT 0,         -- bits Billing took back from the creator
    checkout_url        TEXT,
    checkout_ref        TEXT,
    provider            TEXT,
    provider_ref        TEXT,
    legacy_source       TEXT,                               -- 'live:transactions:<id>' etc.
    idempotency_key     TEXT UNIQUE,
    failure             TEXT,
    origin              TEXT NOT NULL DEFAULT 'tips',       -- tips | billing (settled elsewhere) | external | import
    transfer_due        INTEGER NOT NULL DEFAULT 0,         -- a Billing transfer still has to be (re)tried
    transfer_attempts   INTEGER NOT NULL DEFAULT 0,
    next_transfer_at    INTEGER NOT NULL DEFAULT 0,
    target              TEXT,                               -- JSON EntityRef (e.g. a Live stream)
    created_at          TEXT NOT NULL,
    settled_at          TEXT,
    reversed_at         TEXT,
    delivered_at        TEXT,
    updated_at          TEXT NOT NULL,
    UNIQUE (provider, provider_ref),
    UNIQUE (legacy_source)
);
CREATE INDEX IF NOT EXISTS idx_tint_creator ON tip_interactions (creator_subject, created_at);
CREATE INDEX IF NOT EXISTS idx_tint_supporter ON tip_interactions (supporter_subject, created_at);
CREATE INDEX IF NOT EXISTS idx_tint_pending ON tip_interactions (payment_state, funding);

CREATE TABLE IF NOT EXISTS tip_goals (
    id              TEXT PRIMARY KEY,                       -- tgoal_<ULID>
    creator_subject TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    target_amount   INTEGER NOT NULL CHECK (target_amount > 0),
    currency        TEXT NOT NULL DEFAULT 'vibes-bits',
    image_url       TEXT,
    status          TEXT NOT NULL CHECK (status IN ('active', 'closed')),
    sort_order      INTEGER NOT NULL DEFAULT 0,
    reached_at      TEXT,
    closed_at       TEXT,
    opening_amount  INTEGER NOT NULL DEFAULT 0,             -- carried over from Live's goal column (not tied to tips)
    legacy_source   TEXT UNIQUE,
    revision        INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_creator ON tip_goals (creator_subject, status);

CREATE TABLE IF NOT EXISTS tip_goal_contributions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id         TEXT NOT NULL REFERENCES tip_goals(id),
    interaction_id  TEXT NOT NULL REFERENCES tip_interactions(id),
    amount          INTEGER NOT NULL CHECK (amount > 0),
    reversed_amount INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (goal_id, interaction_id)
);

CREATE TABLE IF NOT EXISTS paid_messages (
    id              TEXT PRIMARY KEY,                       -- tpm_<ULID>
    interaction_id  TEXT NOT NULL UNIQUE REFERENCES tip_interactions(id),
    creator_subject TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('paid_message', 'tts')),
    text            TEXT NOT NULL,
    voice           TEXT,
    highlight_seconds INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'failed', 'cancelled')),
    chat_ref        TEXT,                                   -- JSON reference the chat adapter returned
    test            INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paid_media_requests (
    id              TEXT PRIMARY KEY,                       -- tmr_<ULID>
    interaction_id  TEXT NOT NULL UNIQUE REFERENCES tip_interactions(id),
    creator_subject TEXT NOT NULL,
    url             TEXT NOT NULL,
    provider        TEXT,
    status          TEXT NOT NULL CHECK (status IN ('queued', 'accepted', 'played', 'skipped', 'failed', 'cancelled', 'refunded')),
    queue_ref       TEXT,                                   -- JSON reference returned by the queue owner
    test            INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS overlay_configs (
    id              TEXT PRIMARY KEY,                       -- tovc_<ULID>
    creator_subject TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('alerts', 'goal')),
    name            TEXT NOT NULL,
    settings        TEXT NOT NULL DEFAULT '{}',
    goal_id         TEXT,
    revision        INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ovc_creator ON overlay_configs (creator_subject);

CREATE TABLE IF NOT EXISTS overlay_tokens (
    id              TEXT PRIMARY KEY,                       -- tovt_<ULID>
    creator_subject TEXT NOT NULL,
    token_hash      TEXT NOT NULL UNIQUE,                   -- sha256 of the secret; the secret is shown once
    scopes          TEXT NOT NULL,                          -- JSON ["alerts","goals"]
    config_id       TEXT,
    label           TEXT,
    created_by      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    last_used_at    TEXT,
    revoked_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_ovt_creator ON overlay_tokens (creator_subject);

CREATE TABLE IF NOT EXISTS overlay_deliveries (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,      -- the SSE event id (monotonic)
    id              TEXT NOT NULL UNIQUE,                   -- tovd_<ULID>
    creator_subject TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('alert', 'goal')),
    interaction_id  TEXT,
    goal_id         TEXT,
    payload         TEXT NOT NULL,
    test            INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
    delivered_at    TEXT,
    failed_at       TEXT,
    sends           INTEGER NOT NULL DEFAULT 0,             -- times written to an overlay (replays included)
    dedupe_key      TEXT NOT NULL UNIQUE,                   -- alert:<interaction> | goal:<goal>:<interaction|revision>
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ovd_creator ON overlay_deliveries (creator_subject, seq);

CREATE TABLE IF NOT EXISTS interaction_effects (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    interaction_id  TEXT NOT NULL REFERENCES tip_interactions(id),
    effect          TEXT NOT NULL CHECK (effect IN ('chat_line', 'paid_message', 'tts', 'media_request', 'overlay_alert')),
    adapter         TEXT NOT NULL,
    state           TEXT NOT NULL CHECK (state IN ('queued', 'delivered', 'failed', 'cancelled')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    result          TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (interaction_id, effect)
);
CREATE INDEX IF NOT EXISTS idx_effects_due ON interaction_effects (state, next_attempt_at);

CREATE TABLE IF NOT EXISTS migration_maps (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source          TEXT NOT NULL,                          -- 'live'
    source_table    TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    target_type     TEXT,                                   -- 'interaction' | 'goal'
    target_id       TEXT,
    status          TEXT NOT NULL CHECK (status IN ('imported', 'held', 'excluded')),
    reason          TEXT,
    billing_txn_id  TEXT,
    run_id          TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (source, source_table, source_id)
);

CREATE TABLE IF NOT EXISTS import_runs (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    dry_run     INTEGER NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    report      TEXT
);

CREATE TABLE IF NOT EXISTS api_idempotency (
    key          TEXT PRIMARY KEY,                          -- <principal>:<Idempotency-Key>
    request_hash TEXT NOT NULL,
    method       TEXT NOT NULL,
    path         TEXT NOT NULL,
    status       INTEGER NOT NULL,
    response     TEXT NOT NULL,
    created_at   TEXT NOT NULL
);
`;

const SCHEMA_VERSION = 1;

function openDb(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    db.prepare('INSERT OR IGNORE INTO settings (id, schema_version, created_at) VALUES (1, ?, ?)').run(SCHEMA_VERSION, new Date().toISOString());
    return db;
}

module.exports = { openDb, SCHEMA_VERSION };

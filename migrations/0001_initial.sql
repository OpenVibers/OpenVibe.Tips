-- phase: expand
--
-- OpenVibe.Tips on PostgreSQL (ADR-035): the SQLite schema of the last SQLite release (server/db.js,
-- schema v3 with its added columns; the SDK outbox and inbox) in PostgreSQL types, so
-- scripts/migrate-to-postgres.js can import the SQLite file as it is.
--
--   ISO-8601 text times  -> timestamptz (the data layer returns the same ISO strings the API sent)
--   epoch-ms integers    -> bigint (next_transfer_at, next_attempt_at, the outbox's times)
--   0/1 integers         -> boolean
--   JSON text            -> jsonb, except api_idempotency.response (below)
--   amounts (bits/cents) -> bigint; SUM() of a bigint is numeric, so queries cast sums back ::bigint
--   AUTOINCREMENT        -> bigint GENERATED ALWAYS AS IDENTITY (the importer keeps the values)
--
-- Not carried over: the SQLite `settings` table (one row, schema_version 3): ov_migrations records the
-- schema now, and readiness asks the database itself (db.ready()).
--
-- Every query shape the code runs has an index; the comment above each index names the queries.
-- Locks are always taken in one order: a creator's profile row, tip_interactions, tip_goals by id, the
-- creator's overlay stream (an advisory lock), then the rest (server/domain/index.js).

-- ── Creator profiles ────────────────────────────────────────────────────────────────────────────
CREATE TABLE creator_tip_profiles (
    creator_subject         text PRIMARY KEY,               -- usr_…
    handle                  text NOT NULL UNIQUE,           -- lower-case Network username (projection)
    display_name            text NOT NULL,
    avatar_url              text,
    headline                text,
    page_enabled            boolean NOT NULL DEFAULT false, -- public page + indexing
    accepting               boolean NOT NULL DEFAULT true,  -- new tips accepted
    min_amount              bigint NOT NULL DEFAULT 1,
    paid_message_min        bigint NOT NULL DEFAULT 100,
    tts_enabled             boolean NOT NULL DEFAULT false,
    tts_min_amount          bigint NOT NULL DEFAULT 100,
    tts_max_chars           integer NOT NULL DEFAULT 200,
    tts_voice               text NOT NULL DEFAULT 'gary',
    media_requests_enabled  boolean NOT NULL DEFAULT false,
    media_request_min       bigint NOT NULL DEFAULT 25,
    media_max_seconds       integer NOT NULL DEFAULT 600,
    revision                integer NOT NULL DEFAULT 1,
    created_at              timestamptz NOT NULL,
    updated_at              timestamptz NOT NULL,
    page_settings           jsonb NOT NULL DEFAULT '{}',    -- what the public goal / supporters pages show
    filter_words            jsonb NOT NULL DEFAULT '[]',    -- the creator's blocklist (filter.js)
    filter_action           text NOT NULL DEFAULT 'mask',   -- mask | hold
    filter_links            boolean NOT NULL DEFAULT true   -- links in paid messages shown as [link]
);
-- Home page and sitemap: switched-on pages, newest first / by handle.
CREATE INDEX creator_tip_profiles_enabled ON creator_tip_profiles (updated_at DESC) WHERE page_enabled;

-- ── Interactions ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE tip_interactions (
    id                  text PRIMARY KEY,                   -- tint_<ULID>
    creator_subject     text NOT NULL,
    supporter_subject   text,                               -- null: external/anonymous/unmapped/erased
    supporter_name      text,                               -- display projection at the time
    kind                text NOT NULL CHECK (kind IN ('tip', 'paid_message', 'tts', 'media_request')),
    amount              bigint NOT NULL CHECK (amount > 0),
    currency            text NOT NULL DEFAULT 'vibes-bits',
    amount_cents        bigint,                             -- money that arrived (provider/external)
    message             text,
    request             jsonb NOT NULL DEFAULT '{}',        -- tts text/voice, media url, goal_id, highlight
    funding             text NOT NULL CHECK (funding IN ('credit', 'checkout', 'provider', 'external', 'none')),
    settlement          text NOT NULL CHECK (settlement IN ('billing', 'external', 'simulated', 'imported')),
    payment_state       text NOT NULL CHECK (payment_state IN ('pending', 'settled', 'reversed', 'failed')),
    delivery_state      text NOT NULL CHECK (delivery_state IN ('awaiting_payment', 'queued', 'delivered', 'failed', 'cancelled')),
    test                boolean NOT NULL DEFAULT false,     -- simulation or Billing test money: never counted
    billing_txn_id      text UNIQUE,                        -- the Billing transaction that settled it
    billing_intent_id   text UNIQUE,                        -- checkout: the Billing payment intent
    funding_txn_id      text UNIQUE,                        -- checkout: the purchase that funded it
    reversal_txn_ids    jsonb NOT NULL DEFAULT '[]',
    reversed_bits       bigint NOT NULL DEFAULT 0,          -- bits Billing took back from the creator
    checkout_url        text,
    checkout_ref        text,
    provider            text,
    provider_ref        text,
    legacy_source       text,                               -- 'live:transactions:<id>' etc.
    idempotency_key     text UNIQUE,
    failure             text,
    origin              text NOT NULL DEFAULT 'tips',       -- tips | billing | external | billing-external | import
    transfer_due        boolean NOT NULL DEFAULT false,     -- a Billing transfer still has to be (re)tried
    transfer_attempts   integer NOT NULL DEFAULT 0,
    next_transfer_at    bigint NOT NULL DEFAULT 0,          -- epoch ms; also the lease of the transfer job
    target              jsonb,                              -- EntityRef (e.g. a Live stream)
    created_at          timestamptz NOT NULL,
    settled_at          timestamptz,
    reversed_at         timestamptz,
    delivered_at        timestamptz,
    updated_at          timestamptz NOT NULL,
    anonymous           boolean NOT NULL DEFAULT false,     -- "Anonymous" to everyone but the supporter
    hide_amount         boolean NOT NULL DEFAULT false,     -- amount left out of overlays, chat, public pages
    private_message     boolean NOT NULL DEFAULT false,     -- a tip's message is for the creator only
    erased_at           timestamptz,                        -- the supporter erased their data from it
    moderation          text NOT NULL DEFAULT 'visible',    -- visible | held | hidden
    moderated_at        timestamptz,
    moderated_by        text,                               -- 'filter', usr_… or svc:…
    filtered            boolean NOT NULL DEFAULT false,     -- the word filter matched it at settlement
    UNIQUE (provider, provider_ref),
    UNIQUE (legacy_source)
);
-- A creator's interactions, newest first, keyset-paged (list, dashboard, moderation queue "all"); totals.
CREATE INDEX tip_interactions_creator ON tip_interactions (creator_subject, created_at, id);
-- A supporter's receipts, newest first, keyset-paged; export; erasure.
CREATE INDEX tip_interactions_supporter ON tip_interactions (supporter_subject, created_at, id) WHERE supporter_subject IS NOT NULL;
-- The moderation queue by state, keyset-paged; the dashboard's held count.
CREATE INDEX tip_interactions_moderation ON tip_interactions (creator_subject, moderation, created_at, id);
-- Unpaid checkouts one supporter holds (the pending-checkout limit).
CREATE INDEX tip_interactions_open_checkouts ON tip_interactions (supporter_subject, created_at)
    WHERE funding = 'checkout' AND payment_state = 'pending';
-- Due Billing transfers, claimed with a lease (FOR UPDATE SKIP LOCKED).
CREATE INDEX tip_interactions_transfer_due ON tip_interactions (next_transfer_at) WHERE payment_state = 'pending' AND transfer_due;
-- The public supporters page: the leaderboard (settled or reversed, public name and amount).
CREATE INDEX tip_interactions_leaderboard ON tip_interactions (creator_subject, supporter_subject)
    WHERE supporter_subject IS NOT NULL AND NOT test AND payment_state IN ('settled', 'reversed') AND NOT anonymous
      AND NOT hide_amount AND erased_at IS NULL AND moderation = 'visible';
-- The public supporters page: recent public messages.
CREATE INDEX tip_interactions_recent_public ON tip_interactions (creator_subject, settled_at, id)
    WHERE payment_state = 'settled' AND message IS NOT NULL;

-- ── Goals ───────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE tip_goals (
    id              text PRIMARY KEY,                       -- tgoal_<ULID>
    creator_subject text NOT NULL,
    title           text NOT NULL,
    description     text,
    target_amount   bigint NOT NULL CHECK (target_amount > 0),
    currency        text NOT NULL DEFAULT 'vibes-bits',
    image_url       text,
    status          text NOT NULL CHECK (status IN ('active', 'closed')),
    sort_order      integer NOT NULL DEFAULT 0,
    reached_at      timestamptz,
    closed_at       timestamptz,
    opening_amount  bigint NOT NULL DEFAULT 0,              -- carried over from Live's goal column
    legacy_source   text UNIQUE,
    revision        integer NOT NULL DEFAULT 1,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL
);
-- A creator's goals (by status), in the creator's order; active count; the goal a tip counts toward.
CREATE INDEX tip_goals_creator ON tip_goals (creator_subject, status, sort_order, created_at);

CREATE TABLE tip_goal_contributions (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    goal_id         text NOT NULL REFERENCES tip_goals(id),
    interaction_id  text NOT NULL REFERENCES tip_interactions(id),
    amount          bigint NOT NULL CHECK (amount > 0),
    reversed_amount bigint NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    UNIQUE (goal_id, interaction_id)
);
-- Goal totals (goal_id = ANY), the latest contributions of a goal (goal_id, id DESC).
CREATE INDEX tip_goal_contributions_goal ON tip_goal_contributions (goal_id, id);
-- A reversal's contributions; a supporter's export.
CREATE INDEX tip_goal_contributions_interaction ON tip_goal_contributions (interaction_id);

-- ── What settlement creates ─────────────────────────────────────────────────────────────────────
CREATE TABLE paid_messages (
    id              text PRIMARY KEY,                       -- tpm_<ULID>
    interaction_id  text NOT NULL UNIQUE REFERENCES tip_interactions(id),
    creator_subject text NOT NULL,
    kind            text NOT NULL CHECK (kind IN ('paid_message', 'tts')),
    text            text NOT NULL,
    voice           text,
    highlight_seconds integer NOT NULL DEFAULT 0,
    status          text NOT NULL CHECK (status IN ('queued', 'delivered', 'failed', 'cancelled')),
    chat_ref        jsonb,                                  -- the reference the chat adapter returned
    test            boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL
);

CREATE TABLE paid_media_requests (
    id              text PRIMARY KEY,                       -- tmr_<ULID>
    interaction_id  text NOT NULL UNIQUE REFERENCES tip_interactions(id),
    creator_subject text NOT NULL,
    url             text NOT NULL,
    provider        text,
    status          text NOT NULL CHECK (status IN ('queued', 'accepted', 'played', 'skipped', 'failed', 'cancelled', 'refunded')),
    queue_ref       jsonb,                                  -- the reference returned by the queue owner
    test            boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL
);

-- ── Overlays ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE overlay_configs (
    id              text PRIMARY KEY,                       -- tovc_<ULID>
    creator_subject text NOT NULL,
    kind            text NOT NULL CHECK (kind IN ('alerts', 'goal')),
    name            text NOT NULL,
    settings        jsonb NOT NULL DEFAULT '{}',
    goal_id         text,
    revision        integer NOT NULL DEFAULT 1,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL
);
-- A creator's configs in creation order.
CREATE INDEX overlay_configs_creator ON overlay_configs (creator_subject, created_at);

CREATE TABLE overlay_tokens (
    id              text PRIMARY KEY,                       -- tovt_<ULID>
    creator_subject text NOT NULL,
    token_hash      text NOT NULL UNIQUE,                   -- sha256 of the secret; the secret is shown once
    scopes          jsonb NOT NULL,                         -- ["alerts","goals"]
    config_id       text,
    label           text,
    created_by      text NOT NULL,
    created_at      timestamptz NOT NULL,
    last_used_at    timestamptz,
    revoked_at      timestamptz
);
-- A creator's tokens (listing, the active count).
CREATE INDEX overlay_tokens_creator ON overlay_tokens (creator_subject, created_at);

CREATE TABLE overlay_deliveries (
    seq             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- the SSE event id (monotonic)
    id              text NOT NULL UNIQUE,                   -- tovd_<ULID>
    creator_subject text NOT NULL,
    kind            text NOT NULL CHECK (kind IN ('alert', 'goal')),
    interaction_id  text,
    goal_id         text,
    payload         jsonb NOT NULL,
    test            boolean NOT NULL DEFAULT false,
    status          text NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
    delivered_at    timestamptz,
    failed_at       timestamptz,
    sends           integer NOT NULL DEFAULT 0,             -- times written to an overlay (replays included)
    dedupe_key      text NOT NULL UNIQUE,                   -- alert:<interaction> | goal:<goal>:<interaction|revision>
    created_at      timestamptz NOT NULL,
    hidden          boolean NOT NULL DEFAULT false          -- retracted: never sent or replayed again
);
-- An overlay's stream: a creator's rows after a seq (push, replay, pending on connect, /state, max seq).
CREATE INDEX overlay_deliveries_creator ON overlay_deliveries (creator_subject, seq);
-- The delivery window sweep and the pending gauge.
CREATE INDEX overlay_deliveries_pending ON overlay_deliveries (seq) WHERE status = 'pending';
-- An interaction's deliveries (erasure rewrite, moderation retract/restore).
CREATE INDEX overlay_deliveries_interaction ON overlay_deliveries (interaction_id) WHERE interaction_id IS NOT NULL;

-- ── Delivery effects (the effects worker claims due rows with a lease) ──────────────────────────
CREATE TABLE interaction_effects (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    interaction_id  text NOT NULL REFERENCES tip_interactions(id),
    effect          text NOT NULL CHECK (effect IN ('chat_line', 'paid_message', 'tts', 'media_request', 'overlay_alert')),
    adapter         text NOT NULL,
    state           text NOT NULL CHECK (state IN ('queued', 'delivered', 'failed', 'cancelled')),
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,              -- epoch ms; also the worker's lease
    last_error      text,
    result          jsonb,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    UNIQUE (interaction_id, effect)
);
-- Due effects (the worker's claim) and the pending/due gauges.
CREATE INDEX interaction_effects_due ON interaction_effects (next_attempt_at, id) WHERE state = 'queued';

-- ── Live import bookkeeping ─────────────────────────────────────────────────────────────────────
CREATE TABLE migration_maps (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source          text NOT NULL,                          -- 'live'
    source_table    text NOT NULL,
    source_id       text NOT NULL,
    target_type     text,                                   -- 'interaction' | 'goal' | 'refund'
    target_id       text,
    status          text NOT NULL CHECK (status IN ('imported', 'held', 'excluded')),
    reason          text,
    billing_txn_id  text,
    run_id          text NOT NULL,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    UNIQUE (source, source_table, source_id)
);

CREATE TABLE import_runs (
    id          text PRIMARY KEY,
    source      text NOT NULL,
    dry_run     boolean NOT NULL,
    started_at  timestamptz NOT NULL,
    finished_at timestamptz,
    report      jsonb
);

-- ── Moderation ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE tip_moderators (
    creator_subject   text NOT NULL,
    moderator_subject text NOT NULL,
    name              text,
    added_by          text NOT NULL,                        -- the creator, a service, or 'invite:<id>'
    created_at        timestamptz NOT NULL,
    removed_at        timestamptz,
    PRIMARY KEY (creator_subject, moderator_subject)
);
-- The creators a person moderates.
CREATE INDEX tip_moderators_moderator ON tip_moderators (moderator_subject);

CREATE TABLE tip_moderator_invites (
    id              text PRIMARY KEY,                       -- tmin_<ULID>
    creator_subject text NOT NULL,
    token_hash      text NOT NULL UNIQUE,                   -- sha256 of the link's secret (shown once)
    created_by      text NOT NULL,
    created_at      timestamptz NOT NULL,
    expires_at      timestamptz NOT NULL,
    used_at         timestamptz,
    used_by         text,
    revoked_at      timestamptz
);
-- A creator's open invitations (listing and the open count).
CREATE INDEX tip_moderator_invites_creator ON tip_moderator_invites (creator_subject, created_at);

CREATE TABLE tip_moderation_log (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    creator_subject text NOT NULL,
    interaction_id  text NOT NULL,
    action          text NOT NULL CHECK (action IN ('held', 'filtered', 'hidden', 'restored')),
    by_role         text NOT NULL CHECK (by_role IN ('filter', 'creator', 'moderator', 'service')),
    actor           text,                                   -- usr_… / svc:… ; null for the filter
    reason          text,
    created_at      timestamptz NOT NULL
);
-- A creator's log, newest first.
CREATE INDEX tip_moderation_log_creator ON tip_moderation_log (creator_subject, id);

-- ── Stored API answers (Idempotency-Key) ────────────────────────────────────────────────────────
-- response stays text: a replay returns the stored answer byte for byte, and jsonb would reorder keys.
-- A supporter's erasure deletes theirs by key prefix or by their subject in the answer: a scan of at
-- most a week of answers (pruned daily), for a rare action.
CREATE TABLE api_idempotency (
    key          text PRIMARY KEY,                          -- <principal>:<Idempotency-Key>
    request_hash text NOT NULL,
    method       text NOT NULL,
    path         text NOT NULL,
    status       integer NOT NULL,
    response     text NOT NULL,
    created_at   timestamptz NOT NULL
);
-- The weekly prune.
CREATE INDEX api_idempotency_created ON api_idempotency (created_at);

-- ── Events: the openvibe-sdk outbox and inbox (outboxSchema('tips_event_outbox'), inboxSchema('tips_event_inbox')) ──
CREATE TABLE IF NOT EXISTS tips_event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS tips_event_outbox_due ON tips_event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS tips_event_outbox_sent ON tips_event_outbox (sent_at) WHERE sent_at IS NOT NULL;
-- Tips' own queries on it: the rejected count (/api/ready), and an erasure scrubbing the local copies
-- of an interaction's events.
CREATE INDEX tips_event_outbox_rejected ON tips_event_outbox (id) WHERE rejected_at IS NOT NULL;
CREATE INDEX tips_event_outbox_interaction ON tips_event_outbox ((envelope->'subject'->>'id')) WHERE envelope->'subject'->>'type' = 'interaction';

CREATE TABLE IF NOT EXISTS tips_event_inbox (
    consumer     text NOT NULL,
    event_id     text NOT NULL,
    processed_at bigint NOT NULL,
    PRIMARY KEY (consumer, event_id)
);

-- phase: expand
-- Members-only posts (server/domain/posts.js): the posts a creator writes for the members of their
-- OpenVibe.VIP tiers. The title and the tiers are public; the text is served only to a member of a
-- tier that reads it (the entitlement check, server/vip/client.js) and never leaves the server for
-- anyone else — not in the page, not in JSON-LD, not in the machine-readable pages.
CREATE TABLE IF NOT EXISTS creator_posts (
    id              text PRIMARY KEY,                       -- cpost_<ULID>
    creator_subject text NOT NULL,
    title           text NOT NULL,
    body            text NOT NULL,                          -- the creator's Markdown
    body_html       text NOT NULL,                          -- its safe HTML (server/domain/markdown.js)
    tiers           jsonb NOT NULL DEFAULT '[]'::jsonb,     -- the Billing tiers it is written for
    status          text NOT NULL DEFAULT 'published',
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    published_at    timestamptz,
    hidden_at       timestamptz,
    hidden_by       text,
    hide_reason     text
);
CREATE INDEX IF NOT EXISTS creator_posts_creator ON creator_posts (creator_subject, published_at DESC, id);

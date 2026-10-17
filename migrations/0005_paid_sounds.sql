-- phase: expand
-- Paid sounds (server/domain/sounds.js): a creator keeps up to 12 short sounds (MP3, OGG or WAV, 512 KB each),
-- supporters pay to play one, and the creator's overlay plays it on stream. A sound's file never changes, so its
-- URL (/sounds/<id>) is cached for good; deleting one removes the file, and the interactions that played it keep
-- its name in their request.
CREATE TABLE IF NOT EXISTS creator_sounds (
    id              text PRIMARY KEY,                       -- tsnd_<ULID>
    creator_subject text NOT NULL,
    name            text NOT NULL,
    mime            text NOT NULL CHECK (mime IN ('audio/mpeg', 'audio/ogg', 'audio/wav')),
    bytes           integer NOT NULL CHECK (bytes > 0 AND bytes <= 524288),
    sha256          text NOT NULL,
    data            bytea NOT NULL,
    created_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS creator_sounds_creator ON creator_sounds (creator_subject, created_at, id);

ALTER TABLE creator_tip_profiles ADD COLUMN IF NOT EXISTS sounds_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE creator_tip_profiles ADD COLUMN IF NOT EXISTS sound_min bigint NOT NULL DEFAULT 50;

ALTER TABLE tip_interactions DROP CONSTRAINT IF EXISTS tip_interactions_kind_check;
ALTER TABLE tip_interactions ADD CONSTRAINT tip_interactions_kind_check
    CHECK (kind IN ('tip', 'paid_message', 'tts', 'media_request', 'sound'));

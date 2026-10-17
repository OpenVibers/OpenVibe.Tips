-- phase: expand
-- Other ways to support a creator, paid outside OpenVibe (openvibe-contracts 0.202.0 support_links;
-- server/domain/support-links.js): [{ provider, handle }], one per known service. Tips builds each URL; none is stored.
ALTER TABLE creator_tip_profiles ADD COLUMN support_links jsonb NOT NULL DEFAULT '[]'::jsonb;

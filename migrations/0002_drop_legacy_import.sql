-- phase: contract
-- after: 0001
--
-- The Live import and the SQLite migration era are gone. `legacy_source` and the `migration_maps`
-- table (0001_initial) existed only to key imported Live rows to the Tips entities they became;
-- nothing reads or writes them now (server/importer/live.js and the import scripts are deleted), so
-- the one-time import's columns go and its map table is dropped.
ALTER TABLE tip_interactions DROP COLUMN legacy_source;
ALTER TABLE tip_goals DROP COLUMN legacy_source;
DROP TABLE migration_maps;

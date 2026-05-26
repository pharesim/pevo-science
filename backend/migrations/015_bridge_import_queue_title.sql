-- Persist the source preprint title on bridge import queue rows.
--
-- The title is resolved synchronously at /register time (the metadata fetch
-- that yields BAD_REQUEST when the identifier does not resolve). Persisting it
-- at enqueue lets GET /api/bridge/imports label each row with the paper title
-- instead of the raw identifier, without re-fetching metadata at list time.
--
-- Nullable: rows enqueued before this migration carry NULL, and a row whose
-- metadata had not resolved at creation also carries NULL. The "My imports"
-- surface falls back to the identifier when title is null.
ALTER TABLE bridge_import_queue
  ADD COLUMN IF NOT EXISTS title TEXT;

-- Record this migration in the schema_migrations tracking table created by
-- migration 008. The application-code startup probe in `verifyAppDbMigrations`
-- (backend/src/app-db.ts) aborts boot if any migration file on disk lacks a
-- row here.
INSERT INTO schema_migrations (filename) VALUES ('015_bridge_import_queue_title.sql')
  ON CONFLICT (filename) DO UPDATE SET applied_at = NOW();

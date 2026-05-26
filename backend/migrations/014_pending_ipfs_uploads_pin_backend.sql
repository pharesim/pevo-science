-- Record the originating pin backend per in-flight IPFS upload so the orphan
-- cleanup job can release the pin from the SAME backend that created it.
-- pinToIpfs falls back to Pinata when the local Kubo node is unavailable, but
-- pending_ipfs_uploads previously stored no backend discriminator, so the
-- cleanup job hardcoded a Kubo pin/rm and could never release a Pinata-origin
-- pin: it would fire pin/rm at Kubo (a benign "not pinned"), delete the
-- tracking row, and leave the pin live on Pinata forever with no record of it.
--
-- DEFAULT 'kubo' backfills existing rows safely: they predate Pinata fallback
-- in practice, and Kubo is the primary backend.

ALTER TABLE pending_ipfs_uploads
  ADD COLUMN IF NOT EXISTS pin_backend TEXT NOT NULL DEFAULT 'kubo';

-- Record this migration in the schema_migrations tracking table (migration
-- 008). verifyAppDbMigrations (backend/src/app-db.ts) aborts boot if any
-- migration file on disk lacks a row here.
INSERT INTO schema_migrations (filename) VALUES ('014_pending_ipfs_uploads_pin_backend.sql')
  ON CONFLICT (filename) DO UPDATE SET applied_at = NOW();

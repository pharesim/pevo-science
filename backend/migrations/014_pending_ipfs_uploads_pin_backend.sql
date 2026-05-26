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

-- Constrain pin_backend to the two known backends so an out-of-domain value
-- (a future third backend written before the application union widens, a
-- manual/operator row, a migration oversight) fails loudly at write time
-- rather than silently routing the cleanup unpin to the wrong backend. The
-- cleanup dispatcher's non-kubo branch falls through to Pinata, so an
-- unconstrained value would fire a Pinata DELETE for a CID Pinata never held
-- and then reap the tracking row, leaving the real Kubo pin live forever. This
-- mirrors the state-discriminator CHECK in the bridge import queue migration.
-- DROP-then-ADD keeps the DDL idempotent: this migration file has not shipped
-- to production, so re-applying it to the dev DB (where the column already
-- exists from the prior run) must not error on a duplicate constraint.
ALTER TABLE pending_ipfs_uploads
  DROP CONSTRAINT IF EXISTS pending_ipfs_uploads_pin_backend_check;
ALTER TABLE pending_ipfs_uploads
  ADD CONSTRAINT pending_ipfs_uploads_pin_backend_check
  CHECK (pin_backend IN ('kubo', 'pinata'));

-- Record this migration in the schema_migrations tracking table (migration
-- 008). verifyAppDbMigrations (backend/src/app-db.ts) aborts boot if any
-- migration file on disk lacks a row here.
INSERT INTO schema_migrations (filename) VALUES ('014_pending_ipfs_uploads_pin_backend.sql')
  ON CONFLICT (filename) DO UPDATE SET applied_at = NOW();

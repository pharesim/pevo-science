-- Indexes + purge support for the bridge import queue (migration 010).
--
-- Two query paths in bridge-queue.ts / bridge-worker.ts were unindexed:
--   1. leaseNextEntry's crash-recovery re-lease branch
--      (state = 'in_progress' AND lease_expires_at < NOW()) — NOT covered by
--      idx_bridge_import_queue_pending_due, which is partial WHERE state =
--      'pending'. The OR branch fell back to a scan.
--   2. getLastSuccessfulBroadcastAt's cooldown seed
--      (state = 'completed' AND tx_id IS NOT NULL ORDER BY completed_at DESC
--      LIMIT 1), run on every worker tick with no supporting index.
-- Both are forward-looking: invisible at beta volume (hundreds of imports/day,
-- terminal in minutes-to-hours), relevant only as the table grows. The
-- ageing-purge that bounds that growth — asserted by migration 010's "ageing
-- purges retire rows" comment but previously absent — is now implemented
-- in-process (purgeAgedTerminalEntries in bridge-queue.ts, on a low-frequency
-- worker tick). The purge runs every few hours and scans terminal rows; at
-- this volume a seq scan is fine, so it gets no dedicated index.

-- Covers leaseNextEntry's expired-lease re-lease branch.
CREATE INDEX IF NOT EXISTS idx_bridge_import_queue_inprogress_expired
  ON bridge_import_queue (lease_expires_at)
  WHERE state = 'in_progress';

-- Covers getLastSuccessfulBroadcastAt's most-recent-broadcast seed.
CREATE INDEX IF NOT EXISTS idx_bridge_import_queue_last_success
  ON bridge_import_queue (completed_at DESC)
  WHERE state = 'completed' AND tx_id IS NOT NULL;

-- Record this migration in the schema_migrations tracking table (migration
-- 008). verifyAppDbMigrations (backend/src/app-db.ts) aborts boot if any
-- migration file on disk lacks a row here.
INSERT INTO schema_migrations (filename) VALUES ('013_bridge_import_queue_indexes.sql')
  ON CONFLICT (filename) DO UPDATE SET applied_at = NOW();

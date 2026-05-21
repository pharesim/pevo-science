-- Durable FIFO queue for bridge paper imports.
--
-- The bridge account is rate-limited by the chain at 1 root post per 5
-- minutes per account. Synchronous /api/bridge/register would contend on
-- that one global window across every concurrent registration. This table
-- absorbs incoming requests, the in-process worker dispatches them against
-- the chain's cadence, and the route returns 202 Accepted immediately.
--
-- Redis remains the per-permlink SETNX dedup layer; it is NOT the queue's
-- source of truth (Redis is treated as a hot cache layer and can be flushed
-- without losing queued imports). All queue state lives here.
--
-- Schema generality (task acceptance "Schema generality"): the columns
-- `scheduled_at` and `operation_kind` are generic enough to admit future
-- scheduled-broadcast and embargo-hold dispatch policies without a
-- migration. v1 only writes `operation_kind = 'bridge_register'` and
-- `scheduled_at = created_at` (immediate eligibility); future kinds and
-- non-trivial schedules can land on the same shape.

CREATE TABLE IF NOT EXISTS bridge_import_queue (
  id                BIGSERIAL PRIMARY KEY,
  -- Logical operation discriminator. v1 only emits 'bridge_register'; later
  -- features (scheduled native publish, embargo lift) can reuse the queue
  -- with a new value here.
  operation_kind    TEXT NOT NULL DEFAULT 'bridge_register',
  -- Submitter (Hive username), used for the per-user cap and "My imports"
  -- listing. Not anonymized on account delete: the queue is operational
  -- short-term state, not a long-term audit log; entries reach a terminal
  -- state in minutes-to-hours and ageing purges retire rows.
  username          TEXT NOT NULL,
  identifier        TEXT NOT NULL,
  -- Resolved canonical permlink. Filled at enqueue (when the canonical
  -- form is determined synchronously from the identifier) so concurrent
  -- enqueues for the same paper collide on the unique index below.
  permlink          TEXT NOT NULL,
  discipline        TEXT NOT NULL,
  -- Persisted as JSONB so the keyword list survives round-trip without a
  -- text-array driver shape and is queryable should we want analytics.
  keywords          JSONB NOT NULL DEFAULT '[]'::jsonb,
  language          TEXT NOT NULL DEFAULT 'en',
  -- Lifecycle:
  --   pending      — eligible for dispatch (scheduled_at <= now)
  --   in_progress  — leased by a worker; not eligible for re-lease until
  --                  lease_expires_at passes (worker crash recovery)
  --   completed    — broadcast succeeded; tx_id populated
  --   failed       — terminal failure (cap exceeded retries, permlink-
  --                  collision short-circuit returned existing record,
  --                  metadata went away, etc.); error_code + error_message
  --                  populated
  state             TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'in_progress', 'completed', 'failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  -- When the entry is next eligible for dispatch. Set to created_at at
  -- enqueue for immediate eligibility; pushed forward on retry backoff.
  scheduled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Lease metadata. Set when a worker transitions pending -> in_progress.
  lease_expires_at  TIMESTAMPTZ,
  -- Result fields. Populated on terminal transition.
  tx_id             TEXT,
  error_code        TEXT,
  error_message     TEXT,
  -- When a permlink collision resolves to an existing on-chain record,
  -- the entry is marked completed and the caller is pointed at the
  -- existing post via these fields rather than via a broadcast we did.
  existing_author   TEXT,
  existing_permlink TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

-- FIFO dispatch index: cheapest scan for the worker's "oldest pending entry
-- whose scheduled_at is reached" lookup.
CREATE INDEX IF NOT EXISTS idx_bridge_import_queue_pending_due
  ON bridge_import_queue (scheduled_at)
  WHERE state = 'pending';

-- Per-user cap and "My imports" listing index.
CREATE INDEX IF NOT EXISTS idx_bridge_import_queue_username_state
  ON bridge_import_queue (username, state);

-- Unique pending/in-progress permlink: a second enqueue for a permlink
-- already inflight short-circuits at the route layer. Terminal states
-- (completed/failed) do NOT participate in the constraint so a later
-- legitimate retry after a failed entry is allowed. Partial unique index
-- because Postgres supports filtered unique constraints via this shape.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_bridge_import_queue_permlink_active
  ON bridge_import_queue (permlink)
  WHERE state IN ('pending', 'in_progress');

-- Record this migration in the schema_migrations tracking table created by
-- migration 008. The application-code startup probe in
-- `verifyAppDbMigrations` (backend/src/app-db.ts) aborts boot if any
-- migration file on disk lacks a row here.
INSERT INTO schema_migrations (filename) VALUES ('010_bridge_import_queue.sql')
  ON CONFLICT (filename) DO UPDATE SET applied_at = NOW();

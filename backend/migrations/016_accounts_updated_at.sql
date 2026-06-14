-- Add a row-mutation recency marker to `accounts` so the signup-finalization
-- stuck-account recovery path can distinguish a genuinely-stuck row (finalize
-- UPDATE landed, accreditation broadcast failed, still recoverable) from a
-- fully-finalized steady-state row.
--
-- Why this column exists:
--   `POST /api/auth/confirm` and `POST /api/auth/link` recover a stuck signup
--   by re-finding the row via `username` once `verify_token` has been cleared,
--   gated on a key/signature ownership proof. Without a recency bound that
--   lookup matches EVERY successfully-finalized row in steady state, not just
--   the mid-crash ones: anyone holding a victim's posting key (confirm) or a
--   fresh signature (link) could re-enter the resume path against a long-since-
--   completed account and mint a fresh session, bypassing the password-gated
--   login flow. Bounding the recovery lookup to rows whose last mutation is
--   recent (`updated_at > NOW() - INTERVAL '1 hour'`) restricts the bypass to
--   the brief, genuinely-recoverable window after a crashed activation.
--
-- The finalize UPDATE in both handlers sets `updated_at = NOW()` explicitly
-- (no trigger), so the marker is bumped at every signup-verify activation and a
-- just-finalized row reads as "recent" only for the recovery window's length.
--
-- Back-fill ordering matters. `ADD COLUMN ... NOT NULL DEFAULT now()` would
-- stamp every pre-existing finalized row at MIGRATION time, which is inside the
-- 1h recovery window for the first hour after deploy — leaving the stuck-recovery
-- bypass this column closes OPEN for ~1h. Instead the column is added nullable,
-- back-filled to each row's `created_at` (a definitively-past value, so existing
-- finalized rows fall outside the recovery window immediately), and only THEN
-- sealed with a DEFAULT + NOT NULL for new rows.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Back-fill existing rows to a definitively-past timestamp BEFORE sealing the
-- column, so no pre-existing finalized account is replayable through recovery.
-- `created_at` carries DEFAULT NOW() but is not declared NOT NULL, so COALESCE
-- to a past fallback guards the SET NOT NULL below against a pathological null.
UPDATE accounts
  SET updated_at = COALESCE(created_at, NOW() - INTERVAL '1 day')
  WHERE updated_at IS NULL;

ALTER TABLE accounts ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE accounts ALTER COLUMN updated_at SET NOT NULL;

COMMENT ON COLUMN accounts.updated_at IS
  'Row-mutation recency marker. Set to NOW() by the /api/auth/confirm and '
  '/api/auth/link finalize UPDATE so the stuck-account recovery lookup can '
  'bound itself to recently-finalized rows (the genuinely-recoverable window) '
  'rather than every steady-state finalized row. Back-filled to created_at on '
  'introduction so pre-existing rows start outside the recovery window.';

-- Record this migration in the schema_migrations tracking table created by
-- migration 008. The application-code startup probe in `verifyAppDbMigrations`
-- (backend/src/app-db.ts) aborts boot if any migration file on disk lacks a
-- row here.
INSERT INTO schema_migrations (filename) VALUES ('016_accounts_updated_at.sql')
  ON CONFLICT (filename) DO UPDATE SET applied_at = NOW();

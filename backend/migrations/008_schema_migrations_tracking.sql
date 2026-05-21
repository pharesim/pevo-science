-- Schema-migrations tracking table.
--
-- The application code's startup probe (`verifyAppDbMigrations` in
-- `backend/src/app-db.ts`) reads from this table and aborts boot if any
-- `backend/migrations/*.sql` file present on disk lacks a row here. The
-- check turns "operator forgot to migrate" into a loud boot abort rather
-- than a silent INSERT failure deeper in a request handler.
--
-- Contract:
--   - Each migration file appends an idempotent UPSERT against its own
--     filename at the END of the file:
--       INSERT INTO schema_migrations (filename) VALUES ('NNN_name.sql')
--         ON CONFLICT (filename) DO UPDATE SET applied_at = NOW();
--   - This migration (008) creates the tracking table AND backfills rows
--     for the prior migration set (001 through 007 + this file). Earlier
--     migrations predate the tracking table and cannot record themselves;
--     backfilling here makes them visible on first-apply of 008 against an
--     existing database. The backfill also records this migration itself so
--     the file follows the same self-record contract as 009+.
--   - 009 and later migrations carry their own UPSERT line.
--
-- The recorded `applied_at` for backfilled rows is `NOW()` at the moment 008
-- runs, not the actual historical apply time of each earlier migration. The
-- table is informational + an existence ledger for the startup probe; it is
-- not a forensic audit trail. Operators wanting actual apply timestamps for
-- migrations 001 through 007 must dig the deploy logs.
--
-- Idempotent: `CREATE TABLE IF NOT EXISTS` is safe to re-apply. The
-- `INSERT ... ON CONFLICT (filename) DO UPDATE SET applied_at = NOW()`
-- shape lets the row remain unique-by-filename while still letting an
-- operator force-reapply the migration set (the row's `applied_at` ticks
-- forward, the existence-check the probe relies on stays green).

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (filename) VALUES
  ('001_schema.sql'),
  ('002_nullable_email.sql'),
  ('003_pending_ipfs_uploads.sql'),
  ('004_drop_account_creation_tokens.sql'),
  ('005_custody_audit_consent_ops.sql'),
  ('006_custody_audit_pii_annotation.sql'),
  ('007_accounts_orcid_unique.sql'),
  ('008_schema_migrations_tracking.sql')
ON CONFLICT (filename) DO UPDATE SET applied_at = NOW();

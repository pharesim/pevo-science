-- Align `accounts.custody` with `accounts.upgraded_at`.
--
-- Why this migration exists:
--   `POST /api/custody/upgrade` used to null the encrypted keys and stamp
--   `upgraded_at` without also writing `custody = 'self'`, so every account
--   upgraded through that route sat in the row shape
--   `(custody = 'light', upgraded_at NOT NULL)`, which ARCHITECTURE.md § 6.1
--   does not enumerate. The two session mints then disagreed about what that
--   row meant: the password login derived its JWT custody claim from
--   `upgraded_at`, while the ORCID login read the column raw and re-minted a
--   stale `custody: 'light'` claim for an account the server can no longer
--   sign for. The route now writes both columns in one statement and every
--   mint derives the claim through one shared helper; this migration repairs
--   the rows the old route left behind and makes the shape unreachable at the
--   schema layer.
--
-- Two steps, in this order:
--   1. Back-fill: every row with an upgrade epoch becomes `custody = 'self'`.
--      The predicate is `IS DISTINCT FROM 'self'` rather than `= 'light'` so
--      a NULL column with an epoch (not enumerated either, but the CHECK below
--      would refuse it) is repaired instead of aborting the migration.
--   2. Constraint: `upgraded_at IS NULL OR custody = 'self'`. One-directional
--      on purpose. It encodes exactly the invariant the login mints depend on
--      (an epoch always means self-custody) and nothing more: it does not
--      claim `custody = 'self'` requires an epoch, because that direction is
--      not load-bearing for any reader and a pre-existing row of that shape
--      would fail the migration for no safety gain.
--
-- `updated_at` is deliberately NOT touched by the back-fill. It is the
-- signup-finalize recency marker that bounds the `/link` stuck-recovery lookup
-- (migration 016), and that lookup matches `custody = 'self'` rows. Bumping it
-- here would put every repaired account inside the recovery window for an hour
-- after deploy. A plain UPDATE leaves it alone (there is no trigger).
--
-- Idempotent: the back-fill matches no rows on re-apply, and the DO block adds
-- the constraint only when `pg_constraint` does not already carry it
-- (`ADD CONSTRAINT IF NOT EXISTS` does not exist in PostgreSQL). `deploy.sh
-- migrate` re-applies every file on every run.

UPDATE accounts
  SET custody = 'self'
  WHERE upgraded_at IS NOT NULL
    AND custody IS DISTINCT FROM 'self';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'accounts_upgraded_implies_self_custody'
      AND conrelid = 'public.accounts'::regclass
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_upgraded_implies_self_custody
      CHECK (upgraded_at IS NULL OR custody = 'self');
  END IF;
END $$;

COMMENT ON CONSTRAINT accounts_upgraded_implies_self_custody ON accounts IS
  'An upgrade epoch always means self-custody (ARCHITECTURE.md section 6.1 '
  'state D). Both writers of upgraded_at (POST /api/custody/upgrade and the '
  'signup-verify /link finalize) set custody = ''self'' in the same UPDATE; '
  'this refuses any future writer that stamps the epoch without the column, '
  'which would otherwise leave a row the session mints read as a stale light '
  'account.';

-- Record this migration in the schema_migrations tracking table created by
-- migration 008. The application-code startup probe in `verifyAppDbMigrations`
-- (backend/src/app-db.ts) aborts boot if any migration file on disk lacks a
-- row here.
INSERT INTO schema_migrations (filename) VALUES ('017_accounts_custody_upgraded_align.sql')
  ON CONFLICT (filename) DO UPDATE SET applied_at = NOW();

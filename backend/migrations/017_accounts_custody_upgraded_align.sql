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
--   What that buys is agreement about a row AS READ: two mints handed the same
--   snapshot now produce the same claim. It does not make a minted claim
--   authoritative afterwards. A login that reads the row and then awaits before
--   minting (the password login awaits argon2; the recovery reissues await a
--   factor proof and their own UPDATE) can still hand out a stale 'light' claim
--   if an upgrade commits in between. That window predates this work and this
--   migration does not close it; the routes that would act on a light claim
--   re-read `upgraded_at` and refuse an upgraded row, which is where the safety
--   comes from.
--
-- Two steps, in this order:
--   1. Back-fill: every row with an upgrade epoch becomes `custody = 'self'`.
--      The predicate is `IS DISTINCT FROM 'self'` rather than `= 'light'` so
--      a NULL column with an epoch (not enumerated either) is repaired rather
--      than left to fail the constraint below.
--   2. Constraint: an epoch requires `custody = 'self'`. Spelled with
--      `IS NOT DISTINCT FROM` because a CHECK whose expression evaluates to
--      NULL is satisfied in PostgreSQL: `custody = 'self'` is NULL for a NULL
--      column, so the plain `=` form would silently admit an epoch on a row
--      with no custody value, which is exactly what the `/link` finalize
--      (starting from a NULL-column pre-finalize row) would produce if it
--      ever dropped its column write. One-directional on purpose: it encodes
--      the invariant the login mints depend on (an epoch always means
--      self-custody) and nothing more. It does not claim `custody = 'self'`
--      requires an epoch, because that direction is not load-bearing for any
--      reader and a pre-existing row of that shape would fail the migration
--      for no safety gain.
--
-- `updated_at` is deliberately NOT touched by the back-fill. It is the
-- signup-finalize recency marker that bounds the `/link` stuck-recovery lookup
-- (migration 016), and that lookup matches `custody = 'self'` rows. Bumping it
-- here would put every repaired account inside the recovery window for an hour
-- after deploy. A plain UPDATE leaves it alone (there is no trigger). Recency
-- is not the only term that lookup applies: it also requires a row's upgrade
-- epoch to be at or before its recency marker, which is what keeps an upgraded
-- account out of a window measured from its own signup finalize. The back-fill
-- writes neither column, so a repaired row keeps the ordering it already had,
-- and a row repaired here keeps the old route's ordering (epoch after marker)
-- and stays excluded exactly as before.
--
-- Idempotent: the back-fill matches no rows on re-apply, and the DO block
-- below compares the installed constraint's deparsed definition with the one
-- wanted here (`ADD CONSTRAINT IF NOT EXISTS` does not exist in PostgreSQL).
-- A match is a no-op, so the re-validation scan and its ACCESS EXCLUSIVE
-- lock are paid once, not on every `deploy.sh migrate` (which re-applies
-- every file on every run). A database that already carries the constraint
-- under an earlier predicate sees a mismatch and converges. If a future
-- PostgreSQL major ever deparses the expression differently, the mismatch
-- degrades to a drop-and-re-add on every apply (the migration-014 idiom),
-- never to a skipped or wrong constraint.
--
-- Deploy note: this is NOT an expand-only migration for a backend that
-- predates it. The old `/upgrade` handler's UPDATE stamps the epoch without
-- the column and violates the constraint, so during a live-migrate window
-- (migration applied while the old container still serves) an upgrade
-- landing in those seconds fails with a 500 after the client has already
-- rotated its chain keys. Prefer the stop-migrate-swap path for the deploy
-- that first applies this file. The back-fill and the ADD CONSTRAINT are
-- separate statements under `psql -f`; an old-code upgrade committing between
-- them makes the ADD CONSTRAINT fail loud ("violated by some row") and the
-- deploy aborts with the old backend intact, and a re-run repairs the row.

UPDATE accounts
  SET custody = 'self'
  WHERE upgraded_at IS NOT NULL
    AND custody IS DISTINCT FROM 'self';

DO $$
DECLARE
  -- The deparsed form of the CHECK below, as `pg_get_constraintdef` renders
  -- it: parenthesised, with the text cast made explicit.
  wanted_def CONSTANT TEXT :=
    'CHECK (((upgraded_at IS NULL) OR (NOT (custody IS DISTINCT FROM ''self''::text))))';
  existing_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO existing_def
    FROM pg_constraint
    WHERE conname = 'accounts_upgraded_implies_self_custody'
      AND conrelid = 'public.accounts'::regclass;

  IF existing_def IS NOT DISTINCT FROM wanted_def THEN
    RETURN;
  END IF;

  IF existing_def IS NOT NULL THEN
    ALTER TABLE accounts
      DROP CONSTRAINT accounts_upgraded_implies_self_custody;
  END IF;

  ALTER TABLE accounts
    ADD CONSTRAINT accounts_upgraded_implies_self_custody
    CHECK (upgraded_at IS NULL OR custody IS NOT DISTINCT FROM 'self');
END $$;

COMMENT ON CONSTRAINT accounts_upgraded_implies_self_custody ON accounts IS
  'An upgrade epoch always means self-custody (ARCHITECTURE.md section 6.1 '
  'state D). Both writers of upgraded_at (POST /api/custody/upgrade and the '
  'signup-verify /link finalize) set custody = ''self'' in the same UPDATE; '
  'this refuses any writer that stamps the epoch on a row whose column is '
  'not ''self'', NULL included, which would otherwise leave a row the '
  'session mints could read as a stale light account.';

-- Record this migration in the schema_migrations tracking table created by
-- migration 008. The application-code startup probe in `verifyAppDbMigrations`
-- (backend/src/app-db.ts) aborts boot if any migration file on disk lacks a
-- row here.
INSERT INTO schema_migrations (filename) VALUES ('017_accounts_custody_upgraded_align.sql')
  ON CONFLICT (filename) DO UPDATE SET applied_at = NOW();

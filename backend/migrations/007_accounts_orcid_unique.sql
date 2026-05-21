-- Migration 007: enforce 1:1 ORCID-to-account binding at the database layer
-- as defense-in-depth alongside the route-layer HAF cross-check in
-- findAccreditedAccountWithOrcid.
--
-- The route layer (POST /api/orcid/callback handleAccredit + handleLink) already
-- queries HAF before broadcast and refuses 409 ORCID_ALREADY_LINKED when an
-- ORCID is bound to a different account. That guard is the primary one. This
-- migration adds a partial unique index so any direct DB write that bypasses
-- the route layer (a future ad-hoc operator UPDATE, a batch import script, a
-- regression in updateAccountOrcid that drops the HAF check) cannot silently
-- create two rows with the same ORCID. The defense becomes structural.
--
-- Partial WHERE orcid IS NOT NULL because:
--   * State A (light account post-signup, ORCID-only) carries an ORCID.
--   * State B / C / D may have a NULL ORCID (the user has not run the
--     /accredit or /link flow yet). PostgreSQL treats NULL as distinct under
--     UNIQUE, but the partial predicate makes intent explicit and avoids
--     burning index slots on the NULL rows that dominate the table during
--     light-account onboarding.
--
-- Backfill check: the DO block below scans for existing duplicate ORCIDs
-- and RAISES EXCEPTION before the CREATE UNIQUE INDEX runs. The migration fails loud rather than silently failing partway
-- through CREATE INDEX with a less obvious "could not create unique index"
-- error. Operators see exactly which ORCID has duplicates and which
-- usernames collide, so the conflict can be resolved manually (revoke one,
-- merge accounts, etc.) before re-running migrate.
--
-- Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS skips on re-apply. The DO
-- block also short-circuits — if the index already exists, no duplicates can
-- exist (the constraint would have prevented them), so the scan is a no-op in
-- practice.

DO $$
DECLARE
  dup_count INTEGER;
  dup_sample TEXT;
BEGIN
  -- Detect duplicate non-null ORCIDs. The COALESCE on string_agg avoids
  -- returning NULL when the cross-product is empty (rare but possible if a
  -- row is concurrently deleted between the count and the sample).
  SELECT
    COUNT(*),
    COALESCE(
      string_agg(
        format('orcid=%L usernames=[%s]', orcid, usernames),
        E'\n  '
        ORDER BY orcid
      ),
      ''
    )
  INTO dup_count, dup_sample
  FROM (
    SELECT
      orcid,
      string_agg(COALESCE(username, format('<id=%s>', id)), ', ' ORDER BY id) AS usernames
    FROM accounts
    WHERE orcid IS NOT NULL
    GROUP BY orcid
    HAVING COUNT(*) > 1
    LIMIT 50
  ) dups;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Cannot create accounts_orcid_unique: % duplicate ORCID(s) found in accounts. Resolve manually before re-running:%  %',
      dup_count, E'\n', dup_sample
      USING HINT = 'Each ORCID must bind to at most one account row. Investigate, then revoke or merge the duplicate(s) before re-applying migration 007.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_orcid_unique
  ON accounts (orcid)
  WHERE orcid IS NOT NULL;

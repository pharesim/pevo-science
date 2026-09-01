# Align the custody column with upgraded_at at upgrade and login mints

**Owner:** backend
**Created:** 2026-09-01

Routed out of the architect review of the custody-upgrade session-invalidation
work. Pre-existing: the shape predates that task and was not widened by it.

## Why

`POST /api/custody/upgrade` nulls the encrypted keys and sets `upgraded_at`
but never writes `custody = 'self'`, so every upgraded account sits in the row
shape `(custody = 'light', upgraded_at NOT NULL)` — a combination
ARCHITECTURE.md § 6.1 does not enumerate. The two login mints then disagree
about what that row means: `auth.ts` login derives the JWT custody claim from
`upgraded_at` (correct), while the ORCID login mint reads the column raw and
re-mints a stale `custody: 'light'` claim for an account the server can no
longer sign for.

Impact is contained today: the broadcast and session-auth routes refuse on
`upgraded_at` before acting, so the stale claim is a divergence of claim
rather than a live hole. But per the account-state defense rule, an
unenumerated reachable state means the code and § 6.1 must be reconciled, and
two mint sites deriving the same claim differently is exactly the kind of
split that turns into a hole when a third consumer trusts the claim.

## Scope

1. Write `custody = 'self'` in the upgrade UPDATE's SET list (mirroring the
   signup-verify `/link` finalize), so the transition lands atomically with
   the key-nulling and the epoch stamp.
2. Backfill existing rows: `custody = 'self'` where `upgraded_at IS NOT NULL
   AND custody = 'light'` (SQL migration).
3. Unify the login-mint derivation: either both mints derive from
   `upgraded_at` the way `auth.ts` does, or both read the now-correct column —
   pick one shape and state why in the code. The pair must be incapable of
   disagreeing for the same row.
4. Tests: an upgraded account logging in via ORCID receives a `custody:
   'self'` claim; the post-upgrade row shape is pinned; the backfill is
   covered by a migration-level assertion or an equivalent test.

## Acceptance criteria

1. No reachable row shape `(custody = 'light', upgraded_at NOT NULL)` after
   the migration runs.
2. Both login paths mint identical custody claims for the same account row,
   pinned by a test that would fail if either derivation drifts.
3. The upgrade route's own suite still passes, including the
   session-invalidation legs.

## Notes

- **[TODO Architect]** § 6.1's state D row shape (and any state-table text
  that describes the custody column post-upgrade) is architect-owned and will
  be updated at archive to match whichever shape lands.
- Sequencing: the custody-upgrade task currently holds one comment-line fix in
  the same file area (`verifyHiveSignature.ts` / `routes/custody.ts`). Not a
  blocker, but land after that hold's one-liner to avoid churn on the same
  hunks.

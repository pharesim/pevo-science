# Route tests: two cross-file collisions and a notifications timeout

**Owner:** backend
**Created:** 2026-10-07
**Priority:** low

Filed at the archive of the state G unverified-row lifecycle task, from the "Test-isolation
issues seen, not caused here" list in its first signal block, which no review had triaged. User
triage: "as recommended".

## Why

vitest runs two route files at once against the shared dev database, so a fixture one file owns
can be written or deleted by another. Each item below passes alone and can fail in a full run.

1. `backend/tests/routes/custody-session-auth.test.ts` and
   `backend/tests/routes/custody-non-consent-fresh-auth.test.ts` both seed the fixed ORCID
   `0000-0002-3456-7892` under different usernames. When the two files overlap, one seed trips
   `accounts_orcid_unique` and most of that file's specs fail, retries included.
2. `backend/tests/routes/recover.test.ts` cleans up with `username LIKE 'recover_%'`. In `LIKE`,
   `_` matches any one character, so the pattern also matches the `recover2p_` rows of
   `backend/tests/routes/recover-two-phase.test.ts` and can delete them while that file runs.
3. `backend/tests/routes/auth.test.ts` "accepts valid Bearer JWT on authenticated endpoints"
   calls `GET /api/notifications?since_block=1` against real HAF and times out at 30s when run
   alone with `--retry=0`. Several other specs in the file use the same URL.

## Scope

1. Give each custody file its own ORCID, or derive one per run.
2. Escape the underscore in the `recover.test.ts` cleanup patterns (`'recover\_%'`, with the
   default `\` escape) or key the cleanup on the file's own run id, so it matches only its own
   rows.
3. Point the auth specs at a request that exercises the same middleware without a full HAF scan
   (for example a recent `since_block`, or another authenticated route). Keep each spec's
   assertion on the auth outcome unchanged.

## Acceptance criteria

1. The two custody files pass when run together in one vitest invocation.
2. `recover.test.ts` and `recover-two-phase.test.ts` pass when run together.
3. `auth.test.ts` passes alone with `--retry=0`.

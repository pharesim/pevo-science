# Registration watch announces settings email registrations as signups

**Owner:** backend
**Created:** 2026-10-05
**Priority:** normal

Surfaced by the architect review of the state-G account-state comments task and approved for
filing by the user on 2026-10-05.

## Why

`jobs/registration-watch.ts` posts operator events to a Discord webhook. Its two app-DB
collectors read `accounts` with no state filter that excludes state G (ARCHITECTURE.md § 6.1):
a pure self-custody Keychain account that acquired a row only because it registered an email
through `POST /api/settings/email`'s add flow. That row is not a signup.

- `collectSignupStarted` selects every new row (`WHERE id > $1`). A G row is announced as
  "Signup started" with its `Email`, and its `Path` field reads "Email + password", because the
  label keys on `orcid` alone. Operators see a Keychain user's email registration as a password
  signup.
- `collectCompleted` admits a verified G row (`verify_token` NULL, `username` set), best-effort,
  as the job's own docblock records. When it fires, the event is "Registration completed" with
  the row's `Email`.

So a self-custody user who only registered a notification address has that address posted to
an operator channel that exists to watch beta signups.

## Scope

1. Neither app-DB event class announces a state G row. Per § 6.1, G is the one state with
   `username` set and `custody` NULL: E and F have `username` NULL, and every signup finalize
   sets `custody` (`'light'` from `/confirm`, `'self'` from `/link`), and the custody upgrade
   only moves `'light'` to `'self'`. Exclude that pair in both collectors. Do NOT filter `collectSignupStarted`
   on `username IS NULL` alone: a signup row finalized before the next tick reads it already has
   `username` set, and that filter would drop a real signup. Confirm against § 6.1 that no other
   reachable state is dropped.
2. The cursors keep their meaning. Check that `signupId` behaves sensibly when the newest row in
   a batch is a filtered-out G row. Either it advances past that row, or the row is skipped by
   the predicate on every tick at no cost. Check also that the cold-start seed still lands on
   current head values.
3. The HAF `accreditation_grant` class is unchanged. A G user accredited on chain is still
   reported there, as any non-signup grant is.
4. Comments: the module docblock's event table and the `collectCompleted` docblock now say a G
   row is announced (the latter "best-effort"). Rewrite both to say G rows are excluded and why,
   and drop the best-effort paragraph's announce-gap reasoning where it no longer applies. Keep
   the `updated_at` closed-writer-set explanation, which still governs this collector.

## Acceptance criteria

1. A test against real Postgres seeds a G row (unverified, then verified) alongside an E row, a
   finalized light row, and a signup row that was finalized before the collector first read it.
   It runs both collectors and asserts that the G row yields no event in either class while the
   others do, the early-finalized signup included. The job has no test file today; this adds
   one. A mocked webhook is fine under the root CLAUDE.md carve-out (state it in the file header).
2. The test also pins what happens to `signupId` when a G row has the newest id in a batch.
3. No new writer of `accounts.updated_at`.
4. Comment-anchor conventions hold in everything written.

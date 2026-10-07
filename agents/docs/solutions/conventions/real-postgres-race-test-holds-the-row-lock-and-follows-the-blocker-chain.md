---
title: A read-then-write race is tested on real Postgres by holding the row lock and following the blocker chain
date: 2026-10-07
category: conventions
module: backend/tests
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - A route reads a row without locking it, does slow work (an argon2 hash, an external call), then writes the row, and a test must prove two concurrent requests cannot both act on the same read
  - The race test must run on the real path rather than through a pool.query spy under the mock carve-out
  - A wait loop counts sessions blocked by a lock holder and stalls below the expected count
tags:
  - race-condition
  - postgres-row-lock
  - pg-blocking-pids
  - deterministic-test
  - real-path
  - read-committed
---

# A read-then-write race is tested on real Postgres by holding the row lock and following the blocker chain

## Context

`POST /api/auth/reset` looks the token up with a plain SELECT, hashes the new password with argon2, then writes the row. Its UPDATE once matched the row by id without re-checking the token, so two redemptions of one token that both read it before either wrote would both rotate the password and both answer 200. The fix added a `reset_token = $3` predicate to the UPDATE. Proving it needed a test in which both requests are guaranteed to pass the lookup before either writes.

Firing the two requests with `Promise.all` and hoping the argon2 hash keeps them overlapped makes the order a matter of timing: a run where one request finishes before the other reads passes with or without the fix. Forcing the order with a `pool.query` spy works but falls under the mock carve-out in root `CLAUDE.md` "Running Tests", with its header justification and real-path companion. A row lock held from a second connection forces the order on the real path, with nothing mocked.

## Guidance

1. Take a connection from the app pool, `BEGIN`, and `SELECT ... FOR UPDATE` the row the route will write. Read the holder's `pg_backend_pid()`.
2. Start both requests. A plain SELECT is not blocked by a row lock, so both get past the read; each then blocks in its UPDATE.
3. Wait until **both** writers are blocked, then `COMMIT`. Under READ COMMITTED, the writer that goes second re-evaluates its WHERE clause against the row the first one committed. A predicate on the consumed value (here `reset_token = $3`) then matches nothing, and without it the second write lands too.
4. Release the lock in a `finally`, with `ROLLBACK` when the transaction is still open, so a throw before the `COMMIT` cannot leave the row locked for the next spec.

The wait in step 3 has a trap. Postgres queues the second waiter behind the first waiter's tuple lock, not directly behind the holder, so `pg_blocking_pids()` of the second waiter names the first waiter. A count of sessions blocked by the holder therefore stops at 1, however many requests are queued. The first version of this test polled `WHERE $1 = ANY(pg_blocking_pids(pid))` and timed out with "expected 2 UPDATEs waiting on the row lock, saw 1". Count the whole chain instead:

```ts
const { rows: [{ waiting }] } = await pool.query<{ waiting: number }>(
  `WITH RECURSIVE blocked(pid) AS (
     SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
     UNION
     SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
   )
   SELECT count(*)::int AS waiting FROM blocked`,
  [holderPid],
);
```

Budget connections. The app pool has `max: 5` (`getAppPool` in `backend/src/app-db.ts`). This spec holds one for the lock, one per blocked writer and one for the poll query, so two concurrent writers use four of the five.

## Why This Matters

A race test that passes by timing proves nothing on the runs where the timing went the other way, and it reads as coverage. Holding the lock makes the interleaving a precondition the test establishes, so the red run does not depend on timing: before the fix, both requests answered 200. Keeping the test on the real path also keeps the project's no-mock policy intact for a class of bug (lost updates in read-then-write routes) that tends to get mocked because it looks hard to force.

## When to Apply

- Any route that reads a row unlocked, then writes it after work long enough to interleave: token redemption, single-use proof consumption, counters, status transitions.
- Any wait loop over `pg_blocking_pids()` that expects more than one waiter on the same row.

It does not apply when the route takes the lock itself (`SELECT ... FOR UPDATE` inside a transaction), because the second request then blocks at the read, and the race this technique forces cannot happen.

## Examples

The spec "two redemptions that both read the token before either writes" in `backend/tests/routes/auth-reset-session-match.test.ts` is the worked example. It asserts that the statuses sort to `[200, 400]`, that the loser's body equals an unknown token's body, and that the stored hash verifies against the winner's password.

## Related

- `agents/docs/solutions/conventions/concurrency-wire-shape-assertions-mutation-blind-under-microtask-fifo-2026-05-19.md`: another `Promise.all` race assertion that passed with or without the protection, there because microtask FIFO serialized the segments.
- `agents/docs/solutions/conventions/table-wide-sql-is-tested-on-a-temp-table-shadow-where-read-only-pins-no-writes.md`: a sibling real-Postgres technique that drives a session-level mechanism from a dedicated pool connection.
- `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`: the carve-out this technique keeps a race test out of.
- `agents/docs/solutions/conventions/carve-out-clause-a-impracticability-claims-are-unverified-prose-2026-09-22.md`: a clause-(a) header claiming such a race is impractical to exercise for real is now checkable against this technique.
- `agents/docs/solutions/conventions/atomic-getdel-split-into-read-then-delete-reopens-replay-2026-08-25.md`: the same single-use bug class in the Redis proof layer.

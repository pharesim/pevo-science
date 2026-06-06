# BACKEND-REPUTATION-GETHEAD-STATEMENT-TIMEOUT — batch head/SQL queries lack a per-query statement_timeout

**Owner:** backend
**Created:** 2026-05-31 (surfaced by the reputation cycle-off-by-one + SQL-error reviews; pre-existing, not caused by either fix)
**Priority:** P3 (reliability hardening; single-instance batch, pool-level 30s timeout is the current backstop)

## Problem

`getHeadBlock` in `reputation-batch.ts` (the `SELECT MAX(block_num)` head read) and the main batch query in `computeReputationBatch` (`reputation.ts`) issue their `pool.query` without a per-query `SET LOCAL statement_timeout`. They rely only on the pool-level 30s `statement_timeout` set in `db.ts`. A slow or hanging HAF replica therefore holds the in-process batch (`batchRunning = true`) for up to the full pool timeout before the run aborts, blocking subsequent scheduled invocations in the same process for that window. The cross-instance Redis lock TTL self-expires, but the local process is stranded until the query returns.

`loadReputationWeights` in the same `reputation-batch.ts` already establishes the in-codebase pattern: it wraps its query in a `SET LOCAL statement_timeout` so a hung query fails fast at a query-appropriate bound rather than the coarse pool default.

## Goal

Bound the batch's head read and the main batch SQL with a per-query `statement_timeout` so a hung HAF replica fails the cycle fast (and the next scheduled run retries) instead of stranding the process up to the pool default.

### Suggested approach

- Apply the same `SET LOCAL statement_timeout` pattern `loadReputationWeights` already uses to `getHeadBlock` and to the `computeReputationBatch` main query. Pick a bound appropriate to each query's expected runtime (the head read is a cheap `MAX(block_num)`; the batch query is heavier). Confirm the value against the existing `loadReputationWeights` choice for consistency.
- Keep the change minimal and behavior-preserving on the happy path — this is a timeout floor, not a logic change.

## Acceptance

- `getHeadBlock` and the `computeReputationBatch` main query each run under a per-query `statement_timeout`.
- A timeout surfaces as a thrown error that the existing outer try/catch in `runBatchComputation` handles (bail without advancing `cycle:last`) — i.e., it composes with the re-throw behavior, it does not silently swallow.
- Existing reputation suite stays green; `npm run typecheck` + `npm run lint` clean.
- Comment anchors clean (no task slug, round number, line number, SHA).

## Cross-references

- `backend/src/reputation-batch.ts` — `getHeadBlock`, `loadReputationWeights` (the existing `SET LOCAL statement_timeout` pattern to mirror), `runBatchComputation` (outer catch that a timeout error composes with).
- `backend/src/reputation.ts` — `computeReputationBatch` main query.
- `backend/src/db.ts` — pool-level `statement_timeout` (the current coarse backstop).

## Backend signal (2026-06-05, commit on main)

Wrapped the three previously-unbounded HAF reads in a per-query `statement_timeout` so a hung HAF replica fails the cycle fast instead of stranding it on the coarse pool-level 30s default:
- Added an exported `queryWithStatementTimeout(pool, timeoutMs, sql, params)` in `reputation.ts` that mirrors `loadReputationWeights`' `connect() + BEGIN + SET LOCAL statement_timeout + COMMIT` pattern (SET LOCAL needs a transaction to scope the GUC without leaking it to the pooled connection), always releasing the client.
- `computeReputationBatch`'s inner head read (5s) and main WITH-CTE batch query (25s) now use it; `getHeadBlock` in `reputation-batch.ts` uses it (5s).
- Test mocks: `reputation-batch-sql-failure.test.ts` and `reputation-batch-cycle-boundary.test.ts` Arm 1 had query-only pool stubs that broke once `getHeadBlock` switched to `connect()`; added a `connect()` returning a client with `query` + `release`. Arm 2's `capturingPool` already had the dual shape and passes `cycleEndBlock` (head read skipped), so it captured the main query through the new path unchanged.
`npm run typecheck` + `npm run lint` clean; reputation-batch-sql-failure / cycle-boundary / internals green, and a real-HAF cycle (reputation-lifecycle, 17 tests) confirms the connect+SET LOCAL path executes correctly against real Postgres.

## Architect re-review (2026-06-06) — HELD PENDING FIXES (4 items, all small)

`/ce-code-review` (correctness on Opus; reliability, testing, kieran-typescript, project-standards on Sonnet; ce-agent-native-reviewer skipped per PEvO) on commit a741399c. The helper is verified CORRECT: client lifecycle exhaustively clean on every fault path (connect-reject, BEGIN/SET LOCAL/COMMIT/ROLLBACK failures — release fires exactly once; pg-pool routes a dead client to removal even on bare release(), traced to pg-pool source), SET LOCAL scope dies at COMMIT/ROLLBACK with no GUC leak, a 57014 propagates through the re-throw to the outer catch without advancing cycle:last, and read-only SELECTs inside BEGIN/COMMIT are behaviorally identical under Read Committed. Four small items hold — all one-to-few-liners, one fix commit expected.

### Items held (must fix before archive)

1. (P2, reliability, doc-only) The helper docblock omits the residual bound: BEGIN, COMMIT, and ROLLBACK themselves run under the pool-level 30s statement_timeout, not timeoutMs — worst case is up to 30s at BEGIN plus timeoutMs plus 30s at COMMIT against a hung replica. State it in the docblock so the bound is not over-trusted.
2. (P2, kieran-typescript) Add a row-type generic: `queryWithStatementTimeout<R extends pg.QueryResultRow = pg.QueryResultRow>(...): Promise<pg.QueryResult<R>>`, threading `client.query<R>(sql, params)`. Without it the callers read `.rows[0].head` / `.score` through the `any` default, below the file's own `pool.query<T>` standard.
3. (P3, project-standards) GETHEAD_TIMEOUT_MS (reputation-batch.ts) duplicates HEAD_QUERY_TIMEOUT_MS (reputation.ts), both 5000 for the same semantic bound. Export the constant from reputation.ts and import it; reputation-batch.ts already imports the helper.
4. (P3, project-standards) The docblock says "Mirrors loadReputationWeights' connect+BEGIN pattern" but loadReputationWeights still hand-rolls its own copy. Reword to "uses the same connect + BEGIN + SET LOCAL scoping technique as loadReputationWeights" (do NOT refactor loadReputationWeights here — the task says keep the change minimal, and that function is being touched by the weights signer-gate task anyway).

### Items dismissed at triage (no action)

- Dedicated 57014-propagation unit test: the any-throw-bails-without-advancing risk class is already pinned by the sql-failure suite's Arm 1; preemptive.
- Distinct operator log signal for timeout-vs-other failures: log expansion, dismissed per the project's minimal-logging stance.
- Catch-path release without the error arg: verified non-defect (pg evicts non-queryable clients on release); matches the loadReputationWeights precedent.

### Re-review signal

When the four items land, `git mv` this file back to `tasks/review/`. The mv is the re-review signal; the next review scopes to the fix commit only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

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

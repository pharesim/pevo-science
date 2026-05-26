# BACKEND-BRIDGE-WORKER-HAF-DUPCHECK-EXTRACT — collapse the duplicated HAF on-chain duplicate-check between route and worker

**Owner:** Backend Agent
**Created:** 2026-05-25 (architect, surfaced by /ce-code-review maintainability reviewer at review of `backend-bridge-import-queue` commit `0ccefe14`)
**Priority:** P2 (maintainability / drift risk — two copies of the same HAF dedup query, already diverged)

## Problem

The bridge on-chain duplicate-check exists in two places that re-derive the same two-query HAF lookup:

- `backend/src/routes/bridge.ts` — `checkExistingBridge` (the pre-enqueue duplicate-check on `POST /api/bridge/register`).
- `backend/src/bridge-worker.ts` — `checkExistingOnChain` (the pre-broadcast reconciliation the worker runs before every dispatch).

Both issue the same pair of HAF `SELECT`s — a source-field query (DOI or arXiv) against `validPevoPaperWhere` and a permlink fallback query — with the same bridge-account parameter pattern. The worker's own docblock acknowledges it "mirrors the route-side shape." The two copies have **already diverged** in column projection (the route selects `title`/`created` for its response; the worker omits them). The next change to `validPevoPaperWhere` predicates, a parameter-position shift, or an index/column rename applied to one copy will silently leave the other stale.

## Goal

Extract the shared two-query HAF duplicate-check into one helper that both the route and the worker call, so the query shape has a single source of truth. The route adapts the result by adding its `title`/`created` projection (or the helper returns a superset both consumers project from).

## Scope

- One shared function (placement is the implementer's design call — a new `bridge-haf.ts`, or an export from `bridge-queue.ts` / `bridge.ts`; pick the layering that avoids a circular import between the route and worker modules).
- Return type can reuse the worker's existing duplicate-check result union; the route maps it to its richer response shape.
- Behavior must be byte-identical for both callers — this is a pure de-duplication refactor, not a behavior change. The fail-closed-on-HAF-outage semantics on both sides stay exactly as they are.

## Acceptance

- A single function owns the two HAF `SELECT`s; `checkExistingBridge` and `checkExistingOnChain` both call it (or are replaced by it).
- No behavior change: existing bridge route + worker tests pass unchanged; the route still returns `title`/`created` in its duplicate response and the worker still gets author/permlink for `markCompletedExisting`.
- `npm run typecheck`, `npm run lint`, and the bridge test suites pass.
- No circular import introduced between `routes/bridge.ts` and `bridge-worker.ts`.

## References

- `backend/src/routes/bridge.ts` — `checkExistingBridge`.
- `backend/src/bridge-worker.ts` — `checkExistingOnChain`.
- `backend/src/hafsql.ts` — `validPevoPaperWhere` and the bridge-account parameterization both copies depend on.
- `agents/docs/solutions/conventions/read-then-write-races-on-haf-backed-routes-2026-05-15.md` — the convention governing the HAF-read-then-write shape on bridge routes; keep the fail-closed behavior the shared helper inherits.

## Backend implementation note (2026-05-26, working tree)

Extracted the two-query lookup into `backend/src/bridge-haf.ts` → `findBridgeDuplicate(parsed, permlink)`. Both `checkExistingBridge` (route) and `checkExistingOnChain` (worker) now call it; the now-unused `getPool`/`isHafConfigured`/`T`/`validPevoPaperWhere` imports were dropped from both files. No circular import (`bridge-haf.ts` imports only `db`, `config`, `hafsql`).

Design choice worth a review note: the helper returns the **superset row** (`author`/`permlink`/`title`/`created`, or `null`) and **throws on a HAF query error** rather than returning a `haf_unavailable` union member. Each caller keeps its own `try/catch` around the call. Rationale — this keeps each caller's fail-closed behavior and log line byte-identical: the route still logs `{ identifier, permlink, event: \`${callerLabel}.haf_check_failed\`, route: callerLabel }` and maps to its rich `BridgeCheckResult` (`/register` → 503/retriable, `/check` → fail-open); the worker still logs `event: 'bridge.queue.haf_check_failed'` and reschedules. Only the query shape (the part that had drifted) is unified; the per-caller fail-closed policy and vocabulary stay where they were. The `null`-on-unconfigured branch preserves the prior dev-without-HAF fail-open behavior.

No new test added: this is a pure de-duplication refactor, and both call paths through `findBridgeDuplicate` are already exercised — the route's HAF paths by `tests/routes/bridge.test.ts` + `bridge-haf-lag-locks.test.ts` (including the fail-closed 503), the worker's by `tests/lib/bridge-worker.test.ts` (collision → `markCompletedExisting`, and the HAF-unavailable reschedule). `npm run typecheck` + `npm run lint` clean; the bridge suites (66 tests across 6 files) pass against real Postgres + Redis.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

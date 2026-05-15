# BACKEND-IDEMPOTENCY-HAF-INTEGRATION-TEST — Real-path test for HAF idempotency lookup queries

**Owner:** Backend Agent
**Created:** 2026-05-11 (architect, filed at re-review of `backend-broadcast-idempotency-cluster-followup` commit `c8153e3` — finding F6)
**Priority:** P2 (test coverage; carve-out clause (c) compliance)

## Why now

`BACKEND-BROADCAST-IDEMPOTENCY-CLUSTER-FOLLOWUP` introduced two HAF lookup queries (`findCustodyBroadcastByIdempotencyKey`, `findAccreditByIdempotencyKey` — renamed to `findAccreditationBroadcastByIdempotencyKey` per F23) that are the load-bearing dedup mechanism on the new Option A.4 layer. The test files added by that commit (`backend/tests/lib/idempotency.test.ts`, `backend/tests/routes/{custody,accreditation}-idempotency.test.ts`) all mock `db.js` — `getPool`, `getAppPool`, `isHafAvailable` (renamed `isHafConfigured` per F10) all stubbed via `vi.fn`. No test anywhere runs these queries against a real HAF PostgreSQL connection.

Per `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`, mocking shared pool helpers is permitted under the carve-out IF a real-path companion test exists for the same risk class OR a follow-up task is filed for such coverage. The original commit's `idempotency.test.ts` header claimed the route-level tests provided real-path coverage; verified at re-review that those companions also mock `db.js`. This task is the filed follow-up.

The risk class the real-path test must cover: a HAF schema column rename, view definition change, or operator behavior change (e.g., the `?|` array containment operator, the `json::jsonb ->>` extraction, the JOIN to `haf_operations`) silently breaking the SQL without any test catching it. Idempotency would degrade to "always miss" → retries always re-broadcast → the exact failure class the layer exists to close.

## Goal

Add an integration test (or test suite) that exercises `findCustodyBroadcastByIdempotencyKey` and `findAccreditationBroadcastByIdempotencyKey` against the real HAF database connection, asserting:

1. **Positive hit:** broadcast a known op (or seed a known fixture) carrying a known `idempotency_key`; after HAF indexer ingest, call the lookup; assert the returned `IdempotencyHit` matches the expected `tx_id` + `block_num`.
2. **Negative miss:** call the lookup with a random key that's never been embedded; assert `null` is returned.
3. **Per-route scoping:**
   - Custody lookup filters by `(author, key)` — assert another user's op with the same key is not returned.
   - Accreditation lookup filters by `(accreditationAuthorities, key)` — assert an op signed by a non-authority is not returned.

## Acceptance

- New test file (or extension of an existing real-DB test file like `tests/routes/accreditation.test.ts` / `tests/routes/custody.test.ts`) exercises the three scenarios above with real HAF pool connections (no `vi.mock('../src/db.js', ...)`).
- Test handles HAF indexer lag gracefully — either via polling-with-timeout helper or by pre-seeding the HAF testbed with a known op before invoking the lookup. Document the chosen approach inline.
- Header carve-out clause language updated to point to this test as real-path coverage (the lib test's header reference may need to be updated alongside, per the F6 hold-block item in the parent task).
- `npx tsc --noEmit` clean.
- Full backend vitest passes.

## Out of scope

- Changing the lookup SQL queries themselves (their correctness is presupposed; this task validates them against real schema).
- Refactoring the idempotency module structure.
- Performance benchmarking — that's PERF-001/PERF-002 territory (deferred to a separate task if/when telemetry shows latency).

## Source

- `backend-broadcast-idempotency-cluster-followup.md` architect re-review 2026-05-11, finding F6 (carve-out clause (c) violation).
- Testing reviewer T1, correctness reviewer C2, security reviewer TG-3 (cross-reviewer agreement at anchor 95).
- Convention: `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`.

## Cross-references

- `backend/src/lib/idempotency.ts` — the lookup functions under test.
- `backend/tests/lib/idempotency.test.ts:9` — header overclaim that the F6 part-1 hold-block fixes alongside this task.

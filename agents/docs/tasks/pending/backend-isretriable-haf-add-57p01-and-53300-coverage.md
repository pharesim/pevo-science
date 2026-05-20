# BACKEND-ISRETRIABLE-HAF-ADD-57P01-AND-53300-COVERAGE — Symmetric HAF restart-cycle coverage in `isRetriableHafError` + canary parity for 53300 + 3-file mock-copy parity sweep

**Owner:** Backend Agent
**Created:** 2026-05-20 (architect, cross-task finding surfaced by `/ce-code-review` of `backend-fetch-paper-detail-haf-error-vs-not-found` round-2 commit `33ceef04` AND `backend-haf-outage-translation-audit-across-routes` round-3 commit `44f7c0b1` during the 2026-05-20 bridge/broadcast-resilience cluster review)
**Priority:** P3 (reliability — asymmetric coverage of HAF restart cycle + mutation-kill gap on the 53300 extension)

## Problem

`isRetriableHafError` at `backend/src/db.ts` currently classifies the following pg SQLSTATE codes as retriable: `08*` (connection_exception class), `57014` (query_canceled / statement_timeout), `57P03` (cannot_connect_now), `53300` (too_many_connections). The latter two were added by `backend-haf-outage-translation-audit-across-routes` round-3 (commit `44f7c0b1`).

**Two asymmetries surfaced during the cluster review:**

### Asymmetry 1: HAF restart cycle is half-covered

`57P03` (cannot_connect_now) is emitted by Postgres during the STARTUP / PITR / standby-promotion half of the restart cycle. Its operational mirror is `57P01` (admin_shutdown), emitted during the GRACEFUL SHUTDOWN half — when an in-flight query is interrupted by a SIGTERM-driven shutdown. The docstring's rationale for 57P03 ("Postgres startup, point-in-time recovery, standby promotion windows; realistic during HAF maintenance") applies symmetrically to 57P01 ("graceful shutdown windows; realistic during HAF maintenance"). With 57P01 absent:

- A graceful HAF restart catching an in-flight query mid-shutdown returns 500 INTERNAL_ERROR (non-retriable) for the brief shutdown-initiation window.
- Once the server is fully down, the next query attempt surfaces as 08006 (connection_failure) which IS covered by `08*` → 503 retriable.
- During startup, 57P03 → 503 retriable.

SPA sees inconsistent retry guidance across the same operational event (one HAF restart): a brief 500 ambiguous-error window flanked by 503 retriable on either side.

**Caveat (environment-dependent):** If Mahdi's HAF deployment uses an abrupt-stop pattern (`pg_ctl stop -m fast` or `-m immediate`), 57P01 may never reach the client — the connection drops first, client sees 08006 directly. If smart-stop is the pattern, 57P01 fires on in-flight queries before connection close. Whether this matters in practice requires either operator confirmation of the restart pattern OR observed-occurrence data from a real HAF restart in production.

### Asymmetry 2: 53300 canary missing — mutation hazard

The round-3 commit added BOTH 57P03 and 53300 to the discriminator but added only ONE canary (for 57P03). The 53300 codepath is identical structurally (positive-class retriable extension) but is not pinned by any test assertion. A regression dropping `code === '53300'` alone from the disjunction is not caught — both production and test-local mock copies would fall through to 500 INTERNAL_ERROR; SPA loses retry affordance for the `too_many_connections` class with no test failure.

### Asymmetry 3: 3 test-local mock copies of `isRetriableHafError` are out of date

After round-3 of `backend-haf-outage-translation-audit-across-routes`, the test-local copies in 3 files still embed the round-2 retriable set (`08*` + `57014` only, missing `57P03` + `53300`):

- `backend/tests/routes/papers-haf-error-vs-not-found.test.ts`
- `backend/tests/routes/retract-rate-limit-skip-failed.test.ts`
- `backend/tests/support/argon2-error-mocks.ts` `dbStubFactory`

The 4th copy in `backend/tests/routes/haf-outage-translation-canaries.test.ts` was updated in round-3 (it's the file that contains the new 57P03 canary). The drift between production and 3 test mocks is a known maintenance-debt accumulator (the architect dismissed it in round-2 / round-3 as "not actionable absent observed real-vs-mock divergence"), but the divergence widens with each retriable-set extension that lands without a parity sweep.

## Goal

Close both asymmetries in one bundled task:

1. Add `57P01` (admin_shutdown) to `isRetriableHafError`'s retriable set with operational rationale in the docstring matching the 57P03 entry.
2. Add a 53300 canary asserting 503 SERVICE_UNAVAILABLE with `details.retriable: true`, mirror-shape of the existing 57P03 canary.
3. Add a 57P01 canary asserting the same.
4. Sweep the 3 test-local mock copies to match the new production retriable set (`08*` + `57014` + `57P01` + `57P03` + `53300`).

## Acceptance

### 1. Production: `isRetriableHafError` extended with `57P01`

`backend/src/db.ts` — discriminator now reads `code.startsWith('08') || code === '57014' || code === '57P01' || code === '57P03' || code === '53300'`. Docstring updated to enumerate `57P01` with operational rationale ("Postgres graceful shutdown windows; realistic during HAF maintenance"), matching the existing 57P03 entry's shape. The pair (57P01, 57P03) is documented as "Postgres restart-cycle: shutdown (57P01) and startup (57P03) windows during HAF maintenance".

### 2. Canaries: 57P01 + 53300

`backend/tests/routes/haf-outage-translation-canaries.test.ts` — add two new canaries at the bottom of the deterministic-pg describe block (or alongside the existing 57P03 canary, mirror-shape):

- **57P01 canary:** seed a pg-shaped error with `code: '57P01'` on the rejected `pool.query` for the same route the existing 57P03 canary targets (single-doc fetch for `/api/reviews/:author/:permlink` or sibling). Assert `status: 503`, `error.code: 'SERVICE_UNAVAILABLE'`, `details.retriable: true`. Mutation-kill: a regression dropping `57P01` from the discriminator returns 500 INTERNAL_ERROR; canary fails RED.
- **53300 canary:** same shape, `code: '53300'`. Asserts the same retriable 503 envelope. Mutation-kill: a regression dropping `53300` from the discriminator returns 500 INTERNAL_ERROR; canary fails RED.

Both canaries follow the anchoring conventions: behavioral framing only, no round-number / task-slug / line-number anchors in the it-block comments. (Note: the round-3 hold on `backend-haf-outage-translation-audit-across-routes` round-4 already prescribes dropping a "round-3 hold extension" round-number anchor from the existing 57P03 canary's comment; align the new canary comments with the cleaned shape.)

### 3. Test-local mock-copy parity sweep

Three test files embed local copies of `isRetriableHafError` (independent of the production helper, mocked via `vi.mock('../../src/db.js', ...)`). Update each to match the new production retriable set:

- `backend/tests/routes/papers-haf-error-vs-not-found.test.ts` — local copy in the `vi.hoisted` block near the file top.
- `backend/tests/routes/retract-rate-limit-skip-failed.test.ts` — local copy in the `vi.hoisted` block near the file top.
- `backend/tests/support/argon2-error-mocks.ts` — `dbStubFactory` returns an `isRetriableHafError` matching production behavioral shape.

The shape after update: `code.startsWith('08') || code === '57014' || code === '57P01' || code === '57P03' || code === '53300'`. Default-to-retriable (`typeof code !== 'string'` → `true`) preserved in all copies.

### 4. Verification

`npm run typecheck` clean (both `:src` and `:tests`). `npm run lint` clean for this change. Scoped vitest covering the touched test files + the canary file passes. Mutation-kill verification: temporarily comment out the `code === '57P01'` clause → 57P01 canary fails RED; restore. Same for 53300. Restore the discriminator before final commit.

### 5. Operational realism caveat

The 57P01 addition is gap-from-symmetry reasoning, not observed-occurrence data. If the architect (or operator) wants to defer until a real HAF restart produces an observed 57P01 that we can correlate, this task can be held in `tasks/pending/` for operator confirmation. Confirmation shape: a log entry from production / staging showing a pg error with `code: '57P01'` reaching the `HafQueryError`'s `cause`. Until then, the symmetry argument stands; landing the change is low-risk (the set only widens; no false-positive risk because 57P01 IS structurally a transient shutdown signal).

## Out of scope

- Adding `40001` (serialization_failure) and `40P01` (deadlock_detected) — these are concurrency errors, not infrastructure failures. Query-logic-dependent retry decision, not appropriate for blanket classification.
- Adding `57P02` (crash_shutdown) — pg crashed, server-restart needed, behaviorally non-retriable until restart. The follow-up connection attempt surfaces as 08006 (covered).
- Refactoring the 4 test-local copies into a shared helper. Architect dismissed in round-2 review as "not actionable absent observed real-vs-mock divergence" and the carve-out's intentional duplication (mocked-pool tests pin behavior independently of production imports). This task keeps the duplication; it just updates each copy.
- Logging `err.cause?.code` in the production HafQueryError emit path for operator correlation. Already done via the `cause` chain in pino's serializer; no change needed.

## Cross-references

- `backend/src/db.ts` — `isRetriableHafError` discriminator + docstring (production source).
- `backend/tests/routes/haf-outage-translation-canaries.test.ts` — existing 42601 (negative class) + 57P03 (positive class) canaries; sibling-shape for the new 57P01 + 53300 canaries.
- `backend/tests/routes/papers-haf-error-vs-not-found.test.ts` — test-local mock copy site (sweep target).
- `backend/tests/routes/retract-rate-limit-skip-failed.test.ts` — test-local mock copy site (sweep target).
- `backend/tests/support/argon2-error-mocks.ts` — `dbStubFactory` site (sweep target).
- Originating reviews: `backend-fetch-paper-detail-haf-error-vs-not-found` round-2 review (reliability persona surfaced 57P01) + `backend-haf-outage-translation-audit-across-routes` round-3 review (reliability persona cross-corroborated 57P01 + flagged 53300 canary gap).
- PostgreSQL SQLSTATE reference: [Appendix A](https://www.postgresql.org/docs/current/errcodes-appendix.html) — `57P01` admin_shutdown, `57P02` crash_shutdown, `57P03` cannot_connect_now, `53300` too_many_connections.

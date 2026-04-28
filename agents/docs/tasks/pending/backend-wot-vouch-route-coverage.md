# BE-WOT-VOUCH-ROUTE-COVERAGE — Add route-level test coverage for `/api/wot/vouch` failure branches

**Owner:** backend
**Created:** 2026-04-28 (surfaced by cluster A `/ce-code-review` of `backend-wot-broadcast-timeout-handling.md` round-2, testing persona)
**Priority:** P2

## Problem

`backend/src/routes/wot.ts` POST `/api/wot/vouch` has three response paths after broadcast attempt:

```ts
// happy path: { accredited: true, tx_id }
// timeout branch (lines 79-95): logger.error(...); sendOk({ accredited: false, accreditation_outcome: 'timeout' }); return;
// chain_error branch (lines 97-109): logger.error(...); sendOk({ accredited: false, accreditation_outcome: 'chain_error' }); return;
// skipped branch: existing pre-existing path
```

The `chain_error` branch was added in `backend-wot-broadcast-timeout-handling.md` round-2 (commit `dccfd0d`) specifically to give operators logging symmetry with the `timeout` branch. The `logger.error` call carries `{ err: accreditResult.err, voucher, vouchee }` context.

**Coverage gap**:
- `backend/tests/routes/wot.test.ts` only tests POST `/api/wot/vouch` returns 401 when auth headers are missing. No authenticated vouch test exists.
- `backend/tests/wot-broadcast-timeout.test.ts` tests `broadcastWotAccreditation` directly (below the route layer) and confirms it returns the tagged-union `{ ok: false, reason: 'timeout' | 'chain_error' }`, but never drives the route handler.
- The new `chain_error` `logger.error` call has zero test coverage. Removing the entire `if (accreditResult.reason === 'chain_error')` block would not cause any test to fail.
- The pre-existing `timeout` branch has the same pre-existing gap.

`tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` is violated for both branches.

## Goal

Add a single supertest fixture in `backend/tests/routes/wot.test.ts` (or a new sibling file) that:

1. Authenticates a vouch request via the established Hive-signature mock pattern.
2. Mocks `broadcastWotAccreditation` to return each of the three failure-mode shapes:
   - `{ ok: false, reason: 'timeout', err: <TimeoutError> }` → asserts response is 200 with `accreditation_outcome: 'timeout'` AND `logger.error` was called with `{ err, voucher, vouchee }`.
   - `{ ok: false, reason: 'chain_error', err: <Error> }` → asserts response is 200 with `accreditation_outcome: 'chain_error'` AND `logger.error` was called with `{ err, voucher, vouchee }`.
   - `{ ok: false, reason: 'skipped' }` → asserts response is the existing skipped-shape (the pre-existing branch).
3. Tests the happy path: `{ ok: true, txId }` → asserts response includes `accredited: true, tx_id`.

## Acceptance

- `backend/tests/routes/wot.test.ts` (or new file) has 4 new test cases covering happy path + 3 failure branches.
- Mutation kill: revert the `logger.error` call on `timeout`, run test, confirm timeout-test fails. Same for `chain_error`. Restore.
- All existing tests continue to pass.
- Test header documents the carve-out justification block per root `CLAUDE.md` "Running Tests" — mocking `broadcastWotAccreditation` is required because real-HAF cannot induce a timeout/chain-error per-test deterministically.

## Non-goals

- Changing the route handler logic (cluster A round-2 fixes were correct).
- Adding tests for the cascadeRevocation budget-exceeded path (already covered in `wot-broadcast-timeout.test.ts`).
- Refactoring the route's response shape.

## Related

- `backend-wot-broadcast-timeout-handling.md` (archived after this round-2 archives) — task that introduced `chain_error` branch; this is a coverage follow-up, not a hold against it.
- `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — convention this task closes.

## [TODO Architect]

None — mechanical extension of an established mocking pattern.

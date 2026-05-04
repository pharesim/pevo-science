# BACKEND-ARGON2-TIMEOUT-CLASSIFIER-SUB-BRANCH-COVERAGE — Mutation-fence each OR-arm of `assertArgon2AbortIsSilent`'s timeout classifier independently

**Owner:** backend
**Created:** 2026-05-04 (architect, surfaced by cluster A `/ce-code-review` of `backend-argon2-error-routes-test-coverage` round-4)
**Priority:** P3
**Source:** Cluster A round-4 review of `backend-argon2-error-routes-test-coverage.md` (testing + correctness personas, conf 65–75). Round-4 hold-fix landed `outcome.kind` branch coverage cleanly, but the timeout classifier inside the helper has a 3-way OR (`code === 'ECONNABORTED'` || numeric `timeout` field || message regex `/Timeout/i`) and the existing `timeoutRejection()` test factory sets all 3 simultaneously. A drop-2-arms mutation would still classify via the surviving arm.

## Problem

`backend/tests/support/argon2-error-mocks.ts:assertArgon2AbortIsSilentImpl` classifies a rejection as `'timeout'` if ANY of three arms hold:

```ts
if (typeof err === 'object' && err !== null) {
  const e = err as { code?: string; timeout?: number; message?: string };
  if (e.code === 'ECONNABORTED' || typeof e.timeout === 'number' || (e.message && /Timeout/i.test(e.message))) {
    outcome = { kind: 'timeout' };
  } else {
    outcome = { kind: 'other-error', err };
  }
}
```

`backend/tests/support/argon2-error-mocks.test.ts:54-59` constructs the test fixture as:

```ts
function timeoutRejection(): unknown {
  return Object.assign(new Error('Timeout of 250ms exceeded'), {
    code: 'ECONNABORTED',
    timeout: 250,
  });
}
```

This sets all three classifier arms at once. A mutation that drops `e.code === 'ECONNABORTED'` from the OR (or any single arm) leaves the other two matching, so the timeout-happy-path test false-passes against the mutation. The test confirms the conjunction of arms classifies, not that each arm alone classifies.

Practical exposure today is low because real supertest 6.x always sets all three. But the test exists specifically to mutation-fence the helper, and "real supertest sets all three" is the reasoning the convention `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` warns against.

## Goal

Lock each OR-arm of the timeout classifier independently — every arm becomes load-bearing under its own test fixture. A mutation that drops any single arm surfaces as a test failure on the corresponding sub-case.

## Acceptance

Add 3 sub-cases (or 3 fixture variants) to `backend/tests/support/argon2-error-mocks.test.ts` exercising the timeout-with-mock-called-once happy path:

1. **`code: 'ECONNABORTED'` only** — fixture has `code: 'ECONNABORTED'` but NO numeric `timeout` field, NO `/Timeout/i` in message (e.g., `Object.assign(new Error('aborted'), { code: 'ECONNABORTED' })`).
2. **Numeric `timeout` only** — fixture has `timeout: 250` but NO `code`, NO `/Timeout/i` in message (e.g., `Object.assign(new Error('connection-failure'), { timeout: 250 })`).
3. **Message regex only** — fixture has message matching `/Timeout/i` but NO `code`, NO numeric `timeout` field (e.g., `new Error('Operation Timeout exceeded')`). Pick a message phrasing that doesn't accidentally couple to supertest's exact internal text.

Each sub-case calls the helper, asserts it resolves cleanly (the timeout was correctly classified). A mutation that removes any arm breaks the corresponding sub-case.

The existing `timeoutRejection()` factory can stay as an "all-arms-hot" sanity case. New variants live in additional factories or inline within the new sub-cases.

Re-review signal block must attest the new sub-cases were verified by reverting each arm (commenting it out) and confirming the corresponding sub-case turned red, per the cited convention's "How to apply" point 2.

## Non-goals

- Changing the helper's classifier logic. The 3-arm OR is correct (each arm covers a real supertest-rejection-shape variant across Node versions / config).
- Adding similar sub-branch coverage to other helpers in the kit. Out of scope; revisit if a sibling helper's classifier grows to multi-arm.

## Notes

- `verifyHiveSignature` is not in the helper's call graph; no middleware is mocked. The carve-out justification already documented in the test file header continues to apply.
- Per the cited convention, the verification step should be a real revert-and-rerun, not just "tests pass on the unmutated code." The convention warns specifically against false-pass-on-mutation; this task's whole purpose is to close that.

## Related

- `backend-argon2-error-routes-test-coverage.md` (parent — archiving with this task split off as a follow-up, per architect cluster A triage on 2026-05-04).
- `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md` — the convention behind the helper's existence; this task extends the mutation-fence to the helper's own sub-branches.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — verify-by-revert discipline.

## Backend re-review signal (2026-05-04, working tree)

Three new sub-cases landed in `backend/tests/support/argon2-error-mocks.test.ts`, each driving the timeout-with-mock-called-once happy path with exactly one OR-arm of the timeout classifier active. The existing `timeoutRejection()` factory + the all-arms-hot sanity case are unchanged.

New sub-cases (titles match `it(...)` strings):
1. `classifies timeout when ONLY \`code: ECONNABORTED\` arm is set (no numeric timeout, no /Timeout/i in message)` — fixture is `Object.assign(new Error('aborted'), { code: 'ECONNABORTED' })`.
2. `classifies timeout when ONLY numeric \`timeout\` arm is set (no code, no /Timeout/i in message)` — fixture is `Object.assign(new Error('connection-failure'), { timeout: 250 })`.
3. `classifies timeout when ONLY message regex arm is set (no code, no numeric timeout field)` — fixture is `new Error('Operation Timeout exceeded')`.

Per `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`, each arm was verified by reverting (commenting out) that arm of the OR in `backend/tests/support/argon2-error-mocks.ts:assertArgon2AbortIsSilentImpl` and confirming the corresponding sub-case turned red. Each mutation was reverted before commit; the helper file is unchanged from main.

Per-arm verify-by-revert results (clean run = 7 passed; mutated run = 1 failed | 6 passed):
- Arm 1 (`e.code === 'ECONNABORTED'`) commented out → sub-case 1 failed with `expected 'other-error' to be 'timeout'` (received `Error: aborted` via the unexpected-error diagnostic). Other 6 tests passed.
- Arm 2 (`typeof e.timeout === 'number'`) commented out → sub-case 2 failed with the same diagnostic shape (received `Error: connection-failure`). Other 6 tests passed.
- Arm 3 (`/Timeout/i.test(e.message ?? '')`) commented out (replaced with `false`) → sub-case 3 failed with the same diagnostic shape (received `Error: Operation Timeout exceeded`). Other 6 tests passed.

Each arm is now load-bearing under its own test fixture. After restoring the helper, all 7 tests pass.

Acceptance gates on the unmutated tree:
- `cd backend && npx vitest run tests/support/argon2-error-mocks.test.ts` → `Test Files 1 passed (1) | Tests 7 passed (7)`.
- `cd backend && npx tsc --noEmit` → clean (no output).
- `cd backend && npm run lint` → 0 errors, 2 warnings (both pre-existing, on `src/seed-phrase.ts:26` and `:27`).

Out-of-scope per task non-goals: helper logic untouched (`git diff backend/tests/support/argon2-error-mocks.ts` is empty after revert); no other helpers in the kit gained sub-branch coverage.

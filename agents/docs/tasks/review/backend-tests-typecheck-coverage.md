# BACKEND-TESTS-TYPECHECK-COVERAGE — Extend `tsc --noEmit` over `backend/tests/` and patch `LogContext` typo-bypass sites

**Owner:** backend
**Created:** 2026-05-11 (architect, batch-1 review triage of broadcast-idempotency cluster round-2)
**Priority:** P1

## Context

The `LogContext` interface at `backend/src/lib/broadcast-error.ts:114` was introduced specifically to catch typo-field calls at compile time. The inline comment captures the design intent: *"a typo at a call site compiles silently and operators got an inconsistent log shape."* The interface declares fields like `username?: string`, and excess-property checking on src/ call sites SHOULD reject `{ usrname: 'alice' }` or `{ user: 'alice' }` at compile time.

But two architect batch-1 reviewers (kieran-typescript KT-1 + maintainability M3, cross-reviewer confidence 100) found that the test file `backend/tests/lib/broadcast-error.test.ts` passes invented fields directly:
- Line 34: `{ user: 'alice', action: 'test' }` (LogContext declares `username`, not `user`; `action` doesn't exist at all)
- Line 69: similar
- Lines 258, 300, 362, 465, 523, 552, 752, 772, 790: similar patterns with invented keys like `case`, `run`, `case-b`, etc.

These compile because:
1. **`backend/tsconfig.json` has `include: ['src']`** (line 15) — `tests/` is excluded from tsc.
2. **Vitest uses esbuild**, which strips types without enforcing excess-property checks.

The tests then ASSERT that the typo'd key surfaces in the log output:
```ts
expect(call.user).toBe('alice');   // 'user' is not in LogContext; 'username' is
```

This codifies the bypass as expected behavior. A real production caller writing `logContext: { usrname: 'alice' }` would silently slip through with no compile error and produce an inconsistently-typed log — exactly the failure mode the interface was added to prevent. The test suite is documenting a wrong contract.

The right structural fix is to bring `tests/` under tsc coverage, then either fix the test cases that use invalid keys OR introduce an explicit `TestLogContext = LogContext & Record<string, unknown>` cast at sites where arbitrary extra keys are intentional (e.g., where a test deliberately exercises the spread-through behavior). The structural fix also catches any FUTURE drift in the test suite — not just the ~11 cited sites.

## Acceptance

1. **Add `backend/tests/tsconfig.json` extending the root tsconfig with `tests/` included.** Shape (subject to project conventions):
   ```json
   {
     "extends": "./tsconfig.json",
     "include": ["src", "tests"]
   }
   ```
   Place it at `backend/tests/tsconfig.json` (or `backend/tsconfig.tests.json` if the project prefers that convention; check existing patterns).
2. **Run `tsc --noEmit -p backend/tests/tsconfig.json`** and surface every error. Expected: ~11 errors in `broadcast-error.test.ts` at the cited line range, possibly more in other test files that have drifted similarly.
3. **For each error, decide between two fixes per case:**
   - **Fix the test:** if the test is asserting on a field that SHOULD be in `LogContext` (e.g., `user` → `username`), update the test to use the correct field name. The test's intent was to pin the log shape; using the correct name preserves that.
   - **Introduce a cast:** if the test is deliberately exercising the "extra keys spread through" behavior (e.g., a test asserting that `LogContext` callers can pass arbitrary structured-log fields), introduce a `TestLogContext = LogContext & Record<string, unknown>` type or `as unknown as LogContext` cast at the specific call sites. Prefer fixing-the-test over casting unless the deliberate-spread is genuinely the test intent.
   Document the choice per site in a brief comment when casting (the cast itself is a signal; the comment explains why a cast was the right call for THIS site).
4. **Wire the test-tsconfig check into CI / lint.** Add a script to `package.json` (e.g., `"typecheck:tests": "tsc --noEmit -p tests/tsconfig.json"`) and run it alongside the existing `typecheck` script. Document in `agents/backend/CLAUDE.md` if the convention needs an anchor for future test additions.
5. **Spot-check that the structural fix actually catches the original class.** After the work lands, write one quick test case that uses a typo'd LogContext field (`{ usrname: 'alice' }`); confirm the typecheck step fails on it; then remove the case (the test exists only as a verification that the structural check works).

## Tests

The typecheck step itself is the test. No new unit specs are required beyond the spot-check above. The act of adding the tests-tsconfig + fixing the cited sites is mutation-checked by the next typecheck run.

## Out of scope

- Adding tsc coverage to `frontend/tests/` (parallel concern but UI agent's call).
- Refactoring `LogContext` itself or any of its production call sites in `backend/src/`. The interface is correct; only test sites bypass it.
- Catch-all `Record<string, unknown>` typing on `LogContext` itself. The whole point is that excess properties at production call sites should be caught.

## References

- Architect batch-1 review findings KT-1 (kieran-typescript) + M3 (maintainability). Cross-reviewer corroboration; confidence 100.
- `LogContext` interface: `backend/src/lib/broadcast-error.ts:109-178`. Inline comment at line 109-111 captures the rationale: *"a typo at a call site compiles silently and operators got an inconsistent log shape."*

## Priority rationale

P1 because the test suite is wire-asserting a contract violation, and the LogContext interface's typo-protection is load-bearing for operator log shape consistency. Single-file patch (option for case-by-case fixes) is feasible, but the structural fix (tests-tsconfig) is preferred because it ALSO catches future test-file drift, not just the cited sites today.

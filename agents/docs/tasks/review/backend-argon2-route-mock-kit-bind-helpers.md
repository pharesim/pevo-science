# BACKEND-ARGON2-ROUTE-MOCK-KIT-BIND-HELPERS — Pre-bind `assertArgon2AbortIsSilent` (and siblings) to the kit, eliminate redundant second-arg threading

**Owner:** backend
**Created:** 2026-04-29 (architect, surfaced by cluster B re-review of `backend-argon2-error-routes-test-coverage.md` round-3 P2 item 1)
**Priority:** P2

## Context

`backend/tests/support/argon2-error-mocks.ts` exports `buildArgon2RouteMockKit()` which returns a typed `Argon2RouteMockKit` containing the mock fn (`mockRunWithArgon2Slot`) and a factory closure that re-exports the production class hierarchy via `vi.importActual`. Five sibling translation tests (`auth-argon-error-translation`, `auth-signup-argon-error-translation`, `custody-upgrade-argon-error-translation`, `settings-set-password-argon-error-translation`, `signup-verify-resume-argon-error-translation`) plus the two recently-migrated pre-existing files (`auth-reset-request-shutdown`, `auth-signup-dup-saturated`) all consume the kit.

The kit's mock-side surface is consolidated. The kit's **assertion-side** surface is split: `assert503QueueFull`, `assert503Shutdown`, `assert503`, and `assertArgon2AbortIsSilent` are exported as standalone functions, and `assertArgon2AbortIsSilent` was extended in cluster B round-3 to take the mock fn as a second argument so the silent-return contract can pin invocation count. Every caller now threads `mockRunWithArgon2Slot` from the kit through to the assertion call.

The threading is mechanically redundant: the kit already owns the mock fn; callers just pass it back through. That redundancy is a class of misuse the round-3 invocation guard was specifically introduced to defend against (forgetting the second arg would have been a silent false-pass). It also forced a one-line edit per call site at the c4d988e replay step (`002fec1`) that would have been zero edits if the helper were kit-bound.

## Goal

Move the assertion helpers onto `Argon2RouteMockKit` as methods (or fields whose closures capture the kit's mock fn at build time). Callers obtain a pre-bound assertion surface from the same `buildArgon2RouteMockKit()` invocation that gives them the mock fn — no second-arg threading, no separate import, no risk of misuse from forgetting an arg.

## Approach (suggested)

Extend `Argon2RouteMockKit` with bound methods:

```ts
interface Argon2RouteMockKit {
  // existing
  mockRunWithArgon2Slot: ReturnType<typeof vi.fn<typeof RunWithArgon2SlotType>>;
  argon2SemaphoreMockFactory: () => Promise<typeof import('../../src/lib/argon2-semaphore.js')>;

  // new — bound assertions
  assertArgon2AbortIsSilent: (promise: Promise<SupertestResponse>) => Promise<void>;
  assert503QueueFull: (promise: Promise<SupertestResponse>) => Promise<void>;
  assert503Shutdown: (promise: Promise<SupertestResponse>) => Promise<void>;
  assert503: (promise: Promise<SupertestResponse>, expected: { reason: string; ... }) => Promise<void>;
}
```

`buildArgon2RouteMockKit()` constructs each method as a closure over the kit-local `mockRunWithArgon2Slot` (and shared production constants for the 503 helpers). Standalone `export` of the assertion functions can stay for backward compatibility OR be removed entirely if no caller still uses the standalone shape.

Caller diff at every test file becomes `-` 1 line (drop the standalone import) and `-` argument-threading at the assertion site. Net code reduction across 7 files.

## Acceptance

1. **`Argon2RouteMockKit` exposes the four assertion helpers as kit-bound methods.** Each method captures `mockRunWithArgon2Slot` (and any other kit-local state) at build time so callers don't need to thread the mock fn explicitly.
2. **All 7 caller test files migrate to the kit-bound shape.** Standalone import of `assertArgon2AbortIsSilent` / `assert503QueueFull` / `assert503Shutdown` / `assert503` removed in each file; assertions are called as `kit.assertArgon2AbortIsSilent(reqPromise)` (or destructured at kit-build time).
3. **The standalone exports** are either kept for back-compat (with JSDoc note marking them deprecated in favor of the kit shape) or removed entirely (preferred — there are no in-tree users at this point).
4. **Self-test for the kit-bound `assertArgon2AbortIsSilent`** lands as part of `backend-argon2-error-routes-test-coverage.md` round-4 hold item 1 (a separate held task). Coordination: if that round-4 hold lands FIRST, the self-test exercises the standalone shape; if THIS task lands first, the self-test exercises the kit-bound shape directly. Either order works; flag the dependency in whichever signal block ships second.
5. **`npx tsc --noEmit` clean. `npm run lint` clean. Targeted vitest on the 7 caller files (and the new kit self-test if landed): all pass.**

## Non-goals

- Behavioral changes to the assertion helpers themselves. The round-3 invocation guard, the 503-shape constants, the outcome-detection logic — all unchanged.
- Migrating helpers OTHER than the four argon2 assertion functions onto the kit. Scope is the argon2 mock surface.
- Touching production code.

## Notes

The kit-bind shape also resolves `backend-argon2-error-handler-extract` round-4 dismissed item "Helper parameter type duplicates kit field type" (the `ReturnType<typeof vi.fn<typeof RunWithArgon2SlotType>>` alias) — once the parameter is gone, the duplication is gone.

The 503 helpers (`assert503*`) are currently single-arg `(promise)` shape; making them kit-bound is mechanically the same shape change (closure captures the kit-local `runWithArgon2Slot` mock if needed for future invocation-count guards on the queue-full/shutdown paths). Doing all four together keeps the kit surface symmetric.

A previous round-2 hold dismissal noted that adding cross-branch identity assertions to `assert503` would be defense-in-depth against a hypothetical future refactor; if that ever lands, kit-binding is a prerequisite (the cross-branch comparator would need access to the kit's response capture state).

## Related

- `backend-argon2-error-routes-test-coverage.md` (round-4 hold) — adds a self-test for the helper. Item 1 of that hold is independent of this task but their landing order interacts (see Acceptance line 4).
- `agents/docs/solutions/conventions/route-level-error-class-coverage-after-helper-extraction-2026-04-29.md` — example block was updated to reflect the asymmetric 1-arg vs 2-arg helper shape; once this task lands, that example block can be re-collapsed onto a uniform kit-bound shape.

---

## Backend re-review signal (2026-04-29, working tree)

All four assertion helpers are now pre-bound on `Argon2RouteMockKit`. The kit is the only public surface; standalone exports are gone.

### Implementation

`backend/tests/support/argon2-error-mocks.ts`:

- `Argon2RouteMockKit` extended with four new method fields: `assertArgon2AbortIsSilent(promise)`, `assert503(res, expectedRetryAfterSec, expectedReason)`, `assert503QueueFull(res)`, `assert503Shutdown(res)`. JSDoc on each documents the kit-bind rationale (closure captures `mockRunWithArgon2Slot` for the abort helper; surface symmetry for the 503 helpers).
- `buildArgon2RouteMockKit()` now constructs each method as a closure inside the returned object literal. The abort helper's closure captures the kit-local `mockFn` so callers cannot drop the round-3 invocation guard by forgetting an arg. The 503 helpers' closures forward to the underlying `assert503Impl` with the right retry-after constant + reason discriminator pre-bound.
- Standalone `assertArgon2AbortIsSilent` was renamed to `assertArgon2AbortIsSilentImpl` and kept as a named export so the helper self-test (round-4 of `backend-argon2-error-routes-test-coverage`) can drive each `outcome.kind` branch with synthetic supertest-shaped promises without spinning up a route. JSDoc on the impl documents that the public surface is the kit-bound method.
- Standalone `assert503` was made module-internal (`function assert503Impl`); standalone `assert503QueueFull` / `assert503Shutdown` exports were removed entirely (no in-tree consumers after the migration).
- Header comment updated to reference the kit-bound shape (was: "imported the regular way (after the hoist phase)"; now: "pre-bound methods on the returned kit; destructure them from the same `buildArgon2RouteMockKit()` invocation").

### Caller migration (8 files)

Standalone-import block removed and assertion helpers added to the existing kit-destructure in:

- `backend/tests/routes/auth-argon-error-translation.test.ts`
- `backend/tests/routes/auth-signup-argon-error-translation.test.ts`
- `backend/tests/routes/auth-signup-dup-saturated.test.ts`
- `backend/tests/routes/auth-reset-request-shutdown.test.ts`
- `backend/tests/routes/custody-upgrade-argon-error-translation.test.ts`
- `backend/tests/routes/settings-set-password-argon-error-translation.test.ts`
- `backend/tests/routes/signup-verify-resume-argon-error-translation.test.ts`

`assertArgon2AbortIsSilent(reqPromise, mockRunWithArgon2Slot)` calls reduced to `assertArgon2AbortIsSilent(reqPromise)` everywhere (8 call sites total across these 7 files; the round-3 second-arg threading the architect surfaced as redundant is gone).

`backend/tests/support/argon2-error-mocks.test.ts` (the round-4 self-test, just landed): switched from `assertArgon2AbortIsSilent` → `assertArgon2AbortIsSilentImpl` so it continues to drive the underlying logic with synthetic promises. The kit-bound method is exercised transitively by the 7 caller files. The test file's header notes the split.

### Coordination with the round-4 self-test

Acceptance line 4 of this task notes the landing-order interaction with `backend-argon2-error-routes-test-coverage.md` round-4 item 1. Round-4 landed first (commit `53daad0`), so the self-test was originally written against the standalone shape. Migrating it to import the renamed `assertArgon2AbortIsSilentImpl` was a 1-line change in this commit; the self-test's discriminating power is identical (it exercises the same code path).

### Verification

- `npx tsc --noEmit`: clean (no test-file coverage in tsc per the pre-existing tsconfig limitation; vitest run validates types end-to-end).
- `npm run lint`: clean (only pre-existing seed-phrase.ts warnings).
- Targeted vitest (helper self-test + 7 caller files): 52 passed across 8 files. All previously-passing tests continue to pass; the kit-bound shape is non-breaking.

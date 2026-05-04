---
title: "When a test helper grows a load-bearing argument that callers must thread per-site, collapse it into a builder-returned object whose methods close over the dependency at construction time"
date: 2026-05-04
category: conventions
module: backend/tests
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - A shared test helper accepts a mock function (or other per-call-site dependency) as an explicit argument
  - Forgetting to pass that argument would produce a false-passing test rather than a test error
  - The same mock is constructed once per test file and reused across multiple assertion calls
  - The helper is imported and called across 5 or more call sites, making per-site discipline fragile
  - The dependency is stable across all calls within a single test suite (same mock reference throughout)
  - A new call site is added weeks or months after the helper was written, when the second-arg contract may not be obvious
  - The route under test can hang at an unmocked await before reaching the guarded operation, masking coverage gaps
related_components:
  - development_workflow
  - authentication
tags:
  - test-helper-api
  - closure-capture
  - kit-bind
  - misuse-resistance
  - mock-fixtures
  - argon2
  - false-passing
---

# When a test helper grows a load-bearing argument that callers must thread per-site, collapse it into a builder-returned object whose methods close over the dependency at construction time

## Context

The `backend-argon2-error-routes-test-coverage` task added a shared assertion helper `assertArgon2AbortIsSilent(promise)` for verifying the silent-abort contract on argon2 routes. The helper introspects supertest's outcome to distinguish deadline-firing-because-route-hung from deadline-firing-because-route-returned-500-in-time, closing a false-pass window in the original assertion.

In round-3 of that task, the architect filed a P2 hold: the helper had a latent misuse class. A route that hung at a different unmocked `await` (a DB query the test forgot to seed, a never-resolving feature-flag check) would still trip supertest's deadline; `runWithArgon2Slot` would never be called; the seeded `mockRejectedValueOnce(new ArgonAbortError())` would go unconsumed; `outcome.kind` would be `'timeout'`; the original assertion would pass for the wrong reason. The abort-silent contract would report green even though the abort branch was never reached.

The fix added an invocation guard inside the helper:

```ts
expect(mockRunWithArgon2Slot).toHaveBeenCalledTimes(1);
```

This required widening the helper signature from `assertArgon2AbortIsSilent(promise)` to `assertArgon2AbortIsSilent(promise, mockRunWithArgon2Slot)`, and threading the mock fn through 7 caller test files. The threading was mechanically redundant: the kit built by `buildArgon2RouteMockKit()` already owned the mock fn. Callers were just passing it back.

That redundancy introduced a new misuse class: "forgot to pass mock fn." A caller invoking `assertArgon2AbortIsSilent(reqPromise)` and dropping the second arg silently false-passes again — the very failure mode the round-3 fix was introduced to defend against. The round-3 fix defended against one misuse class and opened another by relying on per-site threading discipline.

The architect filed `backend-argon2-route-mock-kit-bind-helpers.md` as a follow-up. Commit `d217720` (2026-04-29) landed the structural fix: the assertion helpers were pre-bound as closure methods on the kit itself, capturing `mockFn` at construction time. The "forgot to pass mock fn" misuse class was foreclosed structurally — there is no second arg to drop. Surfaced during architect cluster A walk on 2026-05-04.

## Guidance

When a test helper has a load-bearing argument whose value is always a kit-local or builder-local object, pre-bind the helper as a method on the kit. Construct the method as a closure that captures the kit-local state at build time. Do not expose a standalone function with a per-site arg that callers are expected to thread through.

Rule: if the only correct value for an argument is "the thing the builder just created," that argument belongs in the closure, not in the call site.

```ts
// canonical implementation: backend/tests/support/argon2-error-mocks.ts

export function buildArgon2RouteMockKit(): Argon2RouteMockKit {
  const mockFn = vi.fn<typeof RunWithArgon2SlotType>();
  return {
    mockRunWithArgon2Slot: mockFn,
    argon2SemaphoreMockFactory: async () => { /* ... */ },
    // Helpers are bound at construction time. mockFn is captured in the closure.
    assertArgon2AbortIsSilent: (promise) => assertArgon2AbortIsSilentImpl(promise, mockFn),
    assert503QueueFull: (res) => assert503(res, QUEUE_FULL_RETRY_AFTER_SEC, ARGON_REASON_QUEUE_FULL),
    assert503Shutdown: (res) => assert503(res, SHUTDOWN_RETRY_AFTER_SEC, ARGON_REASON_SHUTDOWN_DRAIN),
  };
}
```

(Updated 2026-05-04 post-`19a7d0c`: the dead 3-arg `assert503` field was dropped from the kit; the module-internal helper was renamed `assert503Impl` → `assert503` for naming-suffix consistency. The two convenience wrappers forward to the module-internal helper with the right retry-after constant + reason discriminator pre-pinned, so call sites cannot accidentally pair the queue-full retry window with the shutdown reason or vice versa.)

The underlying `assertArgon2AbortIsSilentImpl(promise, mockFn)` still takes both args — the load-bearing invariant (call `expect(mockFn).toHaveBeenCalledTimes(1)`) is still enforced. The kit just eliminates the per-site threading step so callers cannot accidentally omit it.

If a helper's invariant genuinely requires per-call-site variation (different mock fns per assertion within the same test), a per-site arg is appropriate. That is not the pattern this convention addresses. The rule applies specifically when the arg's correct value is structurally fixed to the kit.

## Why This Matters

Per-site discipline decays. Prose in a code comment ("always pass `mockRunWithArgon2Slot` as the second arg") is not enforced at compile time, is not visible in autocomplete, and is forgotten when someone copies a test skeleton that predates the convention. Six months after the original fix, a new test file omits the second arg; TypeScript may not catch it if the parameter is typed loosely; CI passes; the misuse class is silently reintroduced.

Structural fixes are durable. A closure that captures the kit-local mock fn at construction time cannot be called without the mock fn — it is not an argument. There is nothing to forget. The constraint is enforced by the shape of the API, not by the discipline of every future caller.

This is the same meta-pattern PEvO already applies on the production side:

- `correlated-options-discriminated-union-2026-04-28.md` — correlated options that must co-vary are expressed as a discriminated union. Passing the wrong combination of flags is a type error, not a runtime surprise. "Compile-time enforcement compounds; prose enforcement decays."
- `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — structural enforcement over mental enumeration at call sites.
- `mock-guard-assertion-must-verify-call-shape-2026-04-21.md` — assertion guards that would otherwise depend on per-site discipline.

Closure capture on a builder-returned kit is to test helpers what discriminated unions are to production correlated options. Both are construction-time structural fixes. Both foreclose a misuse class by making the wrong usage unrepresentable rather than merely discouraged.

The secondary benefit: tests become easier to read. The destructuring pattern at the top of the test file is the single source of truth for everything the test uses from the kit. The assertion line reads `await assertArgon2AbortIsSilent(reqPromise)` — the mock fn is not visible noise.

## When to Apply

Apply this pattern when any of the following are true:

1. **A helper grew a second arg whose only correct value is an object the builder/kit already owns.** The threading is by construction redundant — the kit owns it, the caller borrows it, and then passes it back.
2. **A misuse class has been identified as "forgot to thread arg."** If a round of review or a hold block names "caller omitted the second arg" as a false-pass vector, the fix is closure capture, not documentation.
3. **The helper's load-bearing invariant is per-call-site by convention, not by design.** If the invariant could be enforced once at construction time but isn't, pre-binding is the right fix.
4. **A test helper is shared across many test files.** The more call sites exist, the higher the probability that any one of them drops a required arg. Structural enforcement scales; per-file discipline does not.
5. **The helper is part of a named kit or builder pattern.** If the codebase already uses `buildXMockKit()` or `createXTestFixture()`, it has opted into the builder pattern. Load-bearing args that belong to the kit's state belong on the kit.
6. **TypeScript cannot statically enforce the correct arg value.** If the type of the second arg is `vi.Mock` or `jest.Mock`, TypeScript accepts any mock fn — it cannot detect "wrong mock fn from a sibling kit." Structural capture eliminates the category of error TypeScript cannot catch.

## Examples

### Bad: per-site arg threading (round-3 shape, post-invocation-guard, pre-kit-bind)

```ts
// backend/tests/support/argon2-error-mocks.ts (round-3 shape, NOT the current code)

// Standalone helper — caller must thread the mock fn through on every call.
export async function assertArgon2AbortIsSilent(
  promise: Promise<supertest.Response>,
  mockRunWithArgon2Slot: ReturnType<typeof vi.fn>,
): Promise<void> {
  // load-bearing invariant: abort branch was actually reached
  expect(mockRunWithArgon2Slot).toHaveBeenCalledTimes(1);
  // ... outcome introspection ...
}
```

```ts
// auth-argon-error-translation.test.ts (round-3 shape, NOT the current code)

const { mockRunWithArgon2Slot, argon2SemaphoreMockFactory } =
  await vi.hoisted(
    async () => (await import('../support/argon2-error-mocks.js')).buildArgon2RouteMockKit(),
  );

// Every call site must thread mockRunWithArgon2Slot. Forgetting it silently
// drops the invocation guard. TypeScript accepts the omission if the param
// is typed loosely, or if the caller passes the wrong kit's mock fn.
await assertArgon2AbortIsSilent(reqPromise, mockRunWithArgon2Slot);
```

### Good: closure capture (post-d217720 shape, current code)

```ts
// backend/tests/support/argon2-error-mocks.ts — canonical implementation

export function buildArgon2RouteMockKit(): Argon2RouteMockKit {
  const mockFn = vi.fn<typeof RunWithArgon2SlotType>();
  return {
    mockRunWithArgon2Slot: mockFn,
    argon2SemaphoreMockFactory: async () => { /* ... */ },
    // mockFn is captured at construction time. Callers cannot drop it.
    assertArgon2AbortIsSilent: (promise) => assertArgon2AbortIsSilentImpl(promise, mockFn),
    assert503QueueFull: (res) => assert503(res, QUEUE_FULL_RETRY_AFTER_SEC, ARGON_REASON_QUEUE_FULL),
    assert503Shutdown: (res) => assert503(res, SHUTDOWN_RETRY_AFTER_SEC, ARGON_REASON_SHUTDOWN_DRAIN),
  };
}
```

```ts
// auth-argon-error-translation.test.ts (current shape)

const {
  mockRunWithArgon2Slot,
  argon2SemaphoreMockFactory,
  assertArgon2AbortIsSilent,  // already bound to this kit's mockFn
  assert503QueueFull,
  assert503Shutdown,
} = await vi.hoisted(
  async () => (await import('../support/argon2-error-mocks.js')).buildArgon2RouteMockKit(),
);

vi.mock('../../src/lib/argon2-semaphore.js', () => argon2SemaphoreMockFactory());

// Single-arg call. The invocation guard fires inside the closure.
// There is nothing to forget.
await assertArgon2AbortIsSilent(reqPromise);
```

The misuse class "forgot to pass mock fn" is now unrepresentable. The `assertArgon2AbortIsSilentImpl` implementation still asserts `expect(mockFn).toHaveBeenCalledTimes(1)` on every call — the round-3 invocation guard is preserved. The structural fix did not weaken the guard; it made the guard impossible to bypass at the call site.

## Related

- `route-level-error-class-coverage-after-helper-extraction-2026-04-29.md` — contains the canonical `buildArgon2RouteMockKit` implementation as the concrete example of the kit-bind pattern; this convention is the abstracted principle of which that doc's "Good" block is an instance.
- `mock-guard-assertion-must-verify-call-shape-2026-04-21.md` — prior art on the same failure mode from a different angle: per-site assertion discipline (`toHaveBeenCalled` vs `toHaveBeenCalledWith`) is the call-shape analogue. Captures why structural assertion beats per-site vigilance.
- `correlated-options-discriminated-union-2026-04-28.md` — production-side analogue. When two fields are correlated, encode the correlation at the type level so omission is a compile-time error. This convention is the test-helper analogue of that principle.
- `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — broader principle: test soundness must be structural; per-site correctness that a future caller can omit creates vacuous-pass risk. Kit-bind is an instance of this principle applied to helper construction.
- `worktree-fanout-orphan-detection-2026-04-29.md` — historical context. References the earlier 1-arg → 2-arg `assertArgon2AbortIsSilent` migration that was the direct predecessor failure mode motivating the kit-bind refactor.

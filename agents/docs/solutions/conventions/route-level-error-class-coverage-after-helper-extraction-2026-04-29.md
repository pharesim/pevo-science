---
title: Helper extraction does not absolve route-level coverage of the same error classes
date: 2026-04-29
category: conventions
module: backend
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - A refactor extracts catch-handler logic for an error hierarchy into a shared helper (e.g. `handleArgonError`, `handleBroadcastError`)
  - Multiple routes funnel their catch sites through one helper
  - The error hierarchy has N concrete subclasses with divergent response semantics (e.g. silent return on AbortError, 503 on QueueFull, 503 on Shutdown)
  - A test-coverage task is being scoped after a helper extraction lands
  - Reviewing whether route-level integration tests can be skipped because "the helper is unit-tested"
  - One subclass has rarer or quieter behavior (silent return, retry, swallow) that an implementer may forget to inject
related_components:
  - authentication
  - testing
tags:
  - test-coverage
  - helper-extraction
  - error-hierarchy
  - route-level-tests
  - argon2
  - mutation-testing
  - sub-branch-oracles
---

# Helper extraction does not absolve route-level coverage of the same error classes

## Context

PEvO cluster A landed two coupled tasks:

- `backend-argon2-error-handler-extract` (commit `38c1ff1`) collapsed 9 catch sites across `auth.ts`, `custody.ts`, `settings.ts`, `signup-verify.ts` into one shared helper `handleArgonError` at `backend/src/lib/argon2-error-handler.ts`. The helper dispatches on `instanceof ArgonSemaphoreError` and emits 503 (queue-full / shutdown) or returns silently (abort) per concrete subclass.
- `backend-argon2-error-routes-test-coverage` (commits `e7a5602` + `5586f9f`) added route-level integration tests covering queue-full + shutdown across all routes, plus the abort-class assertion via the shared `assertArgon2AbortIsSilent` helper.

Round-2 architect re-review (2026-04-29) caught two abort-class coverage gaps that slipped through despite the helper-level lib tests being comprehensive:

1. **`/reset-request` unknown-email branch.** `auth-reset-request-shutdown.test.ts` imports `MockArgonAbortError` but never injects it. Production at `backend/src/routes/auth.ts:847` re-throws ONLY `ShuttingDownError` (deliberate enumeration-suppression swallow); `ArgonAbortError` propagates to `handleArgonError` which silently returns. A mutation broadening the swallow to `instanceof ArgonSemaphoreError` would write a 200 onto a torn-down socket and reopen the email-enumeration oracle. No helper-level test would catch this — the helper still does the right thing; the route's catch logic is what changed.
2. **`/signup` dup-email burn paths** (`auth.ts:401, 416`). Covered for queue-full + shutdown via `auth-signup-dup-saturated.test.ts` but never asserted under abort. New-email path covers abort (different file), so the dup-burn `.catch` blocks remain unguarded against an abort-class mutation that would write a 409 onto a torn-down socket.

Both gaps had the same shape: the helper centralizes the response, but each route's *delegation decision* — does it `instanceof`-match the right base class? does it `=== ARGON_HANDLED`-check before returning? does it `await` after the helper writes? — is its own mutation surface, invisible to lib-level helper tests.

## Guidance

When a helper centralizes catch-handler logic for an error hierarchy of N concrete subclasses, **every route that invokes the helper still needs route-level coverage of all N subclasses**. The helper's lib tests do not substitute for route-level coverage of the catch decision tree.

The mutation budget at the route level includes:

- Dropping one `instanceof` filter (e.g., narrowing rethrow to `(QueueFull | Shutdown)` only, silently swallowing AbortError)
- Swapping branches (e.g., calling `handleArgonError` before the credential check instead of after)
- Removing the early-return after the helper writes (e.g., dropping `if (... === ARGON_HANDLED) return;`, falling through to a 500)
- Adding a post-helper `await` whose rejection escapes the response that the helper already wrote (Express 5 response-ordering inversion; see `helper-extraction-express5-response-ordering-2026-04-28.md`)

None of these are visible to the helper's unit tests. They show up only at the route level, against real (or production-class-bound mocked) error injection at the route's catch boundary.

For each `(route × concrete subclass)` cell:

- Inject the concrete error class (using `vi.importActual` to bind against the production class hierarchy, never synthetic test-only classes — see hold-block item 5 of `backend-argon2-error-routes-test-coverage.md`).
- Assert the wire-level outcome (status + body + Retry-After for emit-class subclasses; supertest outcome introspection for silent-class subclasses, via a helper like `assertArgon2AbortIsSilent` that distinguishes deadline-rejection from response-with-body).
- Use unconditional assertions — no `if (res.status === 200)` guards (per `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`).

For multi-branch routes (e.g., `/login` known/unknown/ORCID-only; `/resume-signup` × 4 burnSentinel branches), every branch × every subclass cell must be covered. Per `timing-equalization-sub-branch-oracles-2026-04-21.md`, the assertions must produce identical wire shapes under saturation/shutdown across all branches of one route.

## Why This Matters

The helper-extraction refactor is a security-positive move (centralizes the response, eliminates 3-way `instanceof` drift across catch sites). But it shifts the mutation surface, not eliminates it: the routes' catch logic now decides what to do with the helper, and that decision is exactly the place a future regression can break invariants like "abort returns silently, not a stale 200/409 written to a torn-down socket."

The intuition trap after a helper lands: "the helper is unit-tested for all N subclasses; route-level tests of the same N subclasses are redundant." That intuition is correct for the helper's *behavior*, but not for the route's *delegation*. Lib-level tests verify "given subclass X, the helper does Y." Route-level tests verify "given subclass X, the route correctly delegates to the helper AND honors the helper's contract (early-return, no post-helper await, etc)."

The implementer mistake is asymmetric: they remember to test the *visible* subclasses (queue-full, shutdown — the ones that emit responses) and forget the *quiet* subclasses (abort — the one that returns silently). The quiet subclass is exactly where stale responses to torn-down sockets, accidental 200/409 leaks, or re-opened enumeration oracles hide.

Two consecutive cluster-A passes (round 1 and round 2 of `backend-argon2-error-routes-test-coverage`) both produced this gap on different routes. The pattern is recurring, not idiosyncratic.

## When to Apply

- After landing a helper extraction that consolidates catch handlers across multiple routes (`handleArgonError`, `handleBroadcastError`, `handle*Error` patterns).
- When scoping the test-coverage task that follows the helper extraction.
- When reviewing PRs that add new routes calling an existing helper — every new route needs its own per-subclass cell coverage; helper tests do not extend.
- When reviewing PRs that add a new concrete subclass to an existing error hierarchy — every existing route that catches the abstract base needs coverage of the new subclass added to it.
- When auditing test files for completeness on mutation budget — does the suite catch the route-level mutations listed in Guidance, not just the helper-level ones?

## Counter-example / when this doesn't apply

Pure pass-through routes that have no catch logic of their own — they rethrow everything to a global asyncHandler and the helper isn't invoked from the route at all. Coverage of the helper at the global handler level is sufficient. (PEvO doesn't have this shape; every argon2-using route has its own try/catch around the helper invocation.)

Routes whose catch site is a single line `} catch (err) { return handleArgonError(res, err); }` with no surrounding logic — the only mutation surface is the `return` keyword, and one route-level test per route × subclass-class is enough; the inner branches drop out. Even here, omitting the abort-class cell is the mistake to avoid.

## Examples

### Bad: relying on helper unit tests to cover route-level abort behavior

```ts
// backend/tests/lib/argon2-error-handler.test.ts (lib-level — comprehensive)
it('ArgonAbortError → silent return (no res.set/status/json called)', () => {
  // mocked res; assert no methods called
});

// backend/tests/routes/auth-reset-request-shutdown.test.ts (route-level — INCOMPLETE)
import { MockArgonAbortError } from '../support/argon2-error-mocks.js';  // imported but never used
it('shutdown unknown email returns 200', () => { ... });
it('shutdown known email returns 200', () => { ... });
it('queue-full unknown email returns 503', () => { ... });
// ❌ no abort-class case
```

A future regression that swallows the abort wholesale (writing a 200 onto the torn-down socket on the unknown-email branch) ships green.

### Good: route-level cell coverage for every concrete subclass

```ts
// backend/tests/routes/auth-reset-request-shutdown.test.ts
import { ArgonAbortError } from '../../src/lib/argon2-semaphore.js';  // real class via vi.importActual
import { assertArgon2AbortIsSilent } from '../support/argon2-error-mocks.js';

it('shutdown unknown email returns 200', () => { ... });
it('shutdown known email returns 200', () => { ... });
it('queue-full unknown email returns 503', () => { ... });
it('abort unknown email returns silently (no body written)', async () => {
  mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonAbortError());
  await assertArgon2AbortIsSilent(
    request(app).post('/api/auth/reset-request').send({ email: 'unknown@example.com' })
  );
});
```

Now a regression broadening the inner-catch swallow to `instanceof ArgonSemaphoreError` flips this case from silent to a 200-with-body, and the assertion fails.

### Good: parametric coverage for multi-branch routes

```ts
// backend/tests/routes/auth-argon-error-translation.test.ts
const routes = [
  { name: '/login known-account', body: { ... }, seed: known },
  { name: '/login unknown-account', body: { ... }, seed: noUser },
  { name: '/login ORCID-only', body: { ... }, seed: orcidOnly },
];
const errorClasses = [
  { name: 'queue-full', err: () => new ArgonQueueFullError(), assert: assert503QueueFull },
  { name: 'shutdown', err: () => new ShuttingDownError(), assert: assert503Shutdown },
  { name: 'abort', err: () => new ArgonAbortError(), assert: assertArgon2AbortIsSilent },
];

describe.each(routes)('$name', (route) => {
  describe.each(errorClasses)('$name', (cls) => {
    it('translates to wire shape', async () => {
      mockRunWithArgon2Slot.mockRejectedValueOnce(cls.err());
      await cls.assert(request(app).post(route.path).send(route.body));
    });
  });
});
```

Cell count = `routes.length × errorClasses.length`. Every cell asserts the route-level catch decision, not the helper's. A regression that removes the `=== ARGON_HANDLED`-check from one route's catch fails 3 cells (one per error class on that route).

## Related conventions

- `timing-equalization-sub-branch-oracles-2026-04-21.md` — covers the orthogonal axis: response-shape symmetry across sub-branches of one route. This convention covers per-error-class coverage at each route.
- `inner-catch-shadows-outer-catch-in-route-tests-2026-04-28.md` — adjacent: warns that an outer Express asyncHandler may shadow inner catch logic, making tests pass via the wrong path. This convention is about a different shadow: lib-helper tests shadow route-level catch logic.
- `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — broader principle this refines. The route-level catch decision tree is part of the mutation surface even after a helper extraction.
- `helper-extraction-express5-response-ordering-2026-04-28.md` — adjacent: post-helper `await` ordering is one of the route-level mutation surfaces this convention identifies.

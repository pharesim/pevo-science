---
title: Concurrency wire-shape assertions can be mutation-blind under microtask FIFO ordering — anchor shared-singleton invariants on reference equality, not on outcome counts
date: 2026-05-19
category: conventions
module: backend
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - Writing a test that pins a "shared singleton" invariant — module-scoped `Set`, `Map`, ref-counting cache, dedup table, in-process lock — consulted by two or more async helpers
  - The candidate assertion uses `Promise.all` (or sequential awaits) to assert a single-winner outcome (`winners.length === 1`, "exactly one consumer wins", etc.) and attributes that single-winner property to the shared singleton
  - The named mutation class is a structural split of the singleton into per-helper instances (or any topology change that the outcome assertion claims to detect)
  - Both helpers' relevant code paths run synchronously between `await` boundaries (the singleton access is in a `catch`, a `.then` continuation, or another segment with no intervening `await`)
tags:
  - mutation-testing
  - concurrency
  - microtask
  - shared-singleton
  - reference-equality
  - test-only-exports
related_components:
  - testing_framework
  - backend / lib / fresh-auth
---

## Context

A test in `backend/tests/lib/fresh-auth.test.ts` claimed to pin the "shared-lock-domain invariant" for `inFlightConsumes` — the module-scoped `Set<string>` consulted by both `consumeFreshAuthToken` (consent-op kind) and `consumeSessionFreshAuthToken` (session kind) as an in-process lock. The invariant: both helpers consult the SAME `Set` instance. A mutation that splits the lock into per-helper instances (`inFlightConsumesByConsentHelper` + `inFlightConsumesBySessionHelper`) would silently regress cross-kind dual-consume race protection.

The original test used a Redis-stubbed `Promise.all` race across the two helpers and asserted `winners.length === 1`, on the reasoning that the shared Set would block the second helper from winning. During architect re-review of round-2, the architect traced the microtask ordering and found that the wire-shape assertion passes equally under the correct code AND under the per-helper-Set split mutation. The test was structurally mutation-blind for the very mutation class it named.

This is a specific failure mode within the broader principle in `mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md`: the kill claim was false, but the mechanism that defeated it was JS engine scheduling rather than corpus idempotency or assertion-vs-corpus mismatch.

## Guidance

When a test claims to kill a structural mutation involving a shared singleton (module-scoped `Set`, `Map`, ref-counting cache, dedup table, in-process lock), trace the microtask ordering before trusting the kill claim. If every observable branch in both helpers runs synchronously between `await` boundaries, FIFO scheduling makes the winner/loser split deterministic regardless of whether the structural invariant holds — the first helper atomically completes its read-and-mutate chain before the second helper's continuation begins, so the second always loses, shared singleton or split.

Replace the wire-shape outcome assertion with a structural reference-equality anchor:

1. Export a test-only accessor that returns the live singleton reference directly. Type it as a read-only view so callers can't mutate it through the typed surface (the conventional escape hatch via cast is documented and acceptable for a single-instance Node process):

```typescript
/** Test-only hook: returns the live `inFlightConsumes` Set reference so
 *  tests can pin the shared-lock-domain invariant by identity. Read-only
 *  by convention — tests must not mutate the returned Set. */
export function _getInFlightConsumesSetReferenceForTests(): ReadonlySet<string> {
  return inFlightConsumes;
}
```

2. In the test, spy on the live reference's read method (`.has` for a `Set`, `.get` for a `Map`, etc.) and assert that BOTH helpers' invocations register on the same instance. Run the helpers sequentially — concurrency was incidental to the original wire-shape framing; reference equality is what the test pins, and it does not depend on race conditions:

```typescript
it('shared-lock-domain invariant: both helpers consult the same inFlightConsumes Set (identity anchor)', async () => {
  const sharedSet = _getInFlightConsumesSetReferenceForTests();
  const hasSpy = vi.spyOn(sharedSet, 'has');
  try {
    const issuedA = await issueFreshAuthToken('lock-identity-a', 'password', T);
    await consumeFreshAuthToken(issuedA.token, 'lock-identity-a', TH);
    const consentHelperCalls = hasSpy.mock.calls.length;
    expect(consentHelperCalls).toBeGreaterThan(0);

    const issuedB = await issueSessionFreshAuthToken('lock-identity-b', 'password');
    await consumeSessionFreshAuthToken(issuedB.token, 'lock-identity-b');
    const sessionHelperCalls = hasSpy.mock.calls.length - consentHelperCalls;
    expect(sessionHelperCalls).toBeGreaterThan(0);
  } finally {
    hasSpy.mockRestore();
  }
});
```

If the singleton is split into two per-helper instances, the exported accessor points at one of them. The spy records the consent-helper's invocations. When the session helper runs and consults its OWN (sibling) instance, the spy never sees those calls. `sessionHelperCalls` stays `0`. `expect(sessionHelperCalls).toBeGreaterThan(0)` fails. Mutation killed by identity, not by outcome — independent of microtask ordering, independent of whether external dependencies (Redis, HAF, etc.) are reachable.

## Why This Matters

Wire-shape concurrency tests are an attractive vehicle for shared-singleton invariant assertions because the invariant was usually discovered IN a race context — "two consumers raced and both won" is exactly the kind of bug that motivates writing the singleton in the first place. But microtask FIFO ordering collapses the mutation difference before it can propagate to an observable outcome. The first helper's `catch` block (or `.then` continuation) runs to completion synchronously — `get → mutate → return` — before the second helper's continuation begins. The second always sees post-mutation state. Shared singleton or split, the second always loses.

A false-positive concurrency test gives a false sense that a structurally important invariant is test-guarded. The per-helper-singleton split is a silent regression: cross-helper race protection is gone, but the test stays green. By the time the regression is discovered (typically: a real race surfaces in production, the offending mutation is found via `git blame`), the cost of recovery is much higher than the cost of writing a structural anchor in the first place.

The sibling convention `mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` covers the general case ("verify the assertion actually catches what the kill claim says it does"). This is the specific failure mode where the masking mechanism is JS microtask scheduling rather than corpus shape or assertion-vs-corpus mismatch.

## When to Apply

- Writing or reviewing a test for a module-scoped shared singleton (`Set`, `Map`, counter, queue, cache, in-process lock) where the invariant is that two or more code paths share the SAME instance.
- A candidate test uses `Promise.all`, sequential `await` calls, or any concurrency primitive to assert a single-winner outcome and attributes the single-winner property to the shared singleton.
- Before accepting the kill claim: trace whether any `await` boundary separates the two code paths' access to the singleton. If both access points run synchronously within their respective `catch` / `then` continuations — common when the test stubs an async dependency to reject so the helper falls through to a synchronous fallback path — FIFO ordering masks structural mutations.
- During architect re-review of a hold-block item that names a structural mutation in its kill claim: if the proposed test is a `Promise.all` outcome check on a shared singleton, anchor the kill claim on reference equality instead.

## Examples

**Before — wire-shape assertion (mutation-blind):**

```typescript
it.skipIf(!redisAvailable)('cross-helper Redis-stubbed Promise.all → exactly one winner (shared-lock-domain invariant)', async () => {
  const redis = getRedis()!;
  vi.spyOn(redis, 'getdel').mockImplementation(() => Promise.reject(new Error('stubbed redis-down')));
  const issued = await issueFreshAuthToken('race-cross', 'password', T);
  const [a, b] = await Promise.all([
    consumeFreshAuthToken(issued.token, 'race-cross', TH),
    consumeSessionFreshAuthToken(issued.token, 'race-cross'),
  ]);
  const winners = [a, b].filter((r) => r.valid);
  expect(winners).toHaveLength(1); // passes under per-helper-Set split mutation too
});
```

Both helpers' `catch` blocks run synchronously (`memStore.get → memStore.delete → return`) with no intervening `await`. Microtask FIFO serializes them: the first helper completes its mutation before the second begins. The second sees an empty `memStore` and returns `expired` — regardless of whether `inFlightConsumes` is one Set or two.

**After — reference-equality anchor (mutation-killing):**

The test in the Guidance section above. Exports the live `inFlightConsumes` reference, spies on `.has`, runs both helpers sequentially, asserts both invocations register on the same instance. A per-helper split routes one helper's `.has` to a sibling Set; that helper's calls never appear on the spy; `sessionHelperCalls` stays `0`; assertion fails. No `skipIf`, no Redis stubs, no race needed — the structural invariant is verified by identity.

## Cross-references

- `agents/docs/solutions/conventions/mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` — parent convention. This learning is a specific failure mode within its general case: the kill claim is false because the masking mechanism is JS microtask scheduling rather than corpus shape.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — grandparent principle. Every load-bearing assertion must fail on mutation of the code under test; this convention names the specific mechanism that defeats the revert-verify check when the code under test is a shared singleton accessed across helpers.
- `agents/docs/solutions/conventions/test-seams-export-shape-as-const-2026-05-04.md` — adjacent on solution shape. Test-only-exported live references are the canonical PEvO mechanism for reaching module-private state in tests; the reference-equality anchor here is a specialization for shared-singleton identity.
- `backend/src/lib/fresh-auth.ts` — the `inFlightConsumes` Set and the `_getInFlightConsumesSetReferenceForTests` export.
- `backend/tests/lib/fresh-auth.test.ts` — the Set-identity anchor test (describe `concurrent dual-consume produces exactly one winner (in-process lock)`, spec `shared-lock-domain invariant: both helpers consult the same inFlightConsumes Set (identity anchor)`).

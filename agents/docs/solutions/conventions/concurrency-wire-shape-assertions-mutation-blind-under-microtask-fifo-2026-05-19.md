---
title: Concurrency wire-shape assertions can be mutation-blind under microtask FIFO ordering — anchor on synchronously observed structural state, not on outcome counts
date: 2026-05-19
last_updated: 2026-09-01
category: conventions
module: backend
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - Writing a test that pins a structural invariant about module-scoped shared state — a `Set`, `Map`, ref-counting cache, dedup table, or in-process lock — that async helper code is supposed to consult
  - The candidate assertion uses `Promise.all` (or sequential awaits) to assert a single-winner outcome (`winners.length === 1`, "exactly one consumer wins") and attributes that single-winner property to the shared state
  - The named mutation class is structural — a dropped `add`, a lock that is never taken, a singleton split into per-helper instances — rather than a change in returned values
  - The relevant code paths run synchronously between `await` boundaries (the access is in a `catch`, a `.then` continuation, or another segment with no intervening `await`)
tags:
  - mutation-testing
  - concurrency
  - microtask
  - shared-singleton
  - structural-assertions
  - test-only-exports
related_components:
  - testing_framework
  - backend / lib / fresh-auth
---

## Context

A test in `backend/tests/lib/fresh-auth.test.ts` claimed to pin a structural invariant
about `inFlightConsumes`, the module-scoped `Set<string>` used as an in-process lock in
`backend/src/lib/fresh-auth.ts`. The test used a Redis-stubbed `Promise.all` race across
two consume helpers and asserted `winners.length === 1`, on the reasoning that the
shared lock would block the second helper from winning.

During architect re-review, tracing the microtask ordering showed the assertion passes
equally under the correct code AND under the structural mutation it named. The test was
mutation-blind for the very mutation class its kill claim cited.

**The specific invariant that motivated the original write-up no longer exists.** At the
time, the lock was consulted by both the consent-op and session consume paths, and the
invariant was that both consult the same `Set` instance. The session kind has since
become windowed and multi-use by design, and the lock was deliberately scoped to the
consent-op burn alone precisely so concurrent session consumes both succeed. There is no
longer a two-helpers-share-one-instance question to ask, and the reference-equality
mechanism this entry originally prescribed has no target.

The underlying lesson survives that change intact, and the current tests apply it in a
form that suits the new shape. This entry has been updated to prescribe that form.

This is a specific failure mode within the broader principle in
`mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md`: the kill claim was
false, but the mechanism that defeated it was JS engine scheduling rather than corpus
idempotency or assertion-vs-corpus mismatch.

## Guidance

When a test claims to kill a **structural** mutation involving shared in-process state,
trace the microtask ordering before trusting the kill claim. If every observable branch
runs synchronously between `await` boundaries, FIFO scheduling makes the winner/loser
split deterministic whether or not the structural invariant holds — the first path
atomically completes its read-and-mutate chain before the second path's continuation
begins, so the second always loses either way.

The fix is not a particular accessor. It is a change of vantage point: **observe the
structural state from inside the call, while it is happening, rather than inferring it
from the outcome afterwards.**

One practical mechanism — the one that fits when the code AWAITS something mid-operation
— is to export a test-only accessor for the state you need to observe, then sample it
from inside a `mockImplementation` on that awaited dependency. That callback fires
*during* the operation, so it sees the state at the moment the invariant is supposed to
hold:

```typescript
/** Test-only hook: the current size of the in-process consume lock, so tests
 *  can observe whether the lock is held at a chosen moment rather than
 *  inferring it from a race outcome. */
export function _getInFlightConsumesSizeForTests(): number {
  return inFlightConsumes.size;
}
```

```typescript
// The lock IS held while the guarded operation runs.
const sizesDuringBurn: number[] = [];
vi.spyOn(redis, 'getdel').mockImplementation(async () => {
  sizesDuringBurn.push(_getInFlightConsumesSizeForTests());
  return null;
});
await consumeFreshAuthToken(issued.token, user, targetHash);
expect(sizesDuringBurn).toEqual([1]);   // dropped `add` -> [0] -> fails
expect(_getInFlightConsumesSizeForTests()).toBe(0);  // leaked lock -> 1 -> fails
```

Pair it with the **inverse** pin wherever "not locked" is itself the designed behaviour.
An invariant asserting a lock is taken is only half the specification; without the other
half, a lock reinstated where it does not belong passes unnoticed:

```typescript
// The unguarded path runs WITHOUT the lock, which is what lets concurrent calls both win.
const sizesDuringSlide: number[] = [];
vi.spyOn(redis, 'set').mockImplementation(async () => {
  sizesDuringSlide.push(_getInFlightConsumesSizeForTests());
  return 'OK';
});
await consumeSessionFreshAuthToken(issued.token, user);
expect(sizesDuringSlide).toEqual([0]);
```

Both directions are immune to microtask ordering, need no race, and need no reasoning
about which continuation runs first. A size accessor is usually enough; reach for a
richer accessor (or a live reference) only when size cannot distinguish the mutation you
are trying to kill.

## Why This Matters

Wire-shape concurrency tests are an attractive vehicle for shared-state invariants
because the invariant was usually discovered IN a race context — "two consumers raced and
both won" is exactly the kind of bug that motivates the lock. But microtask FIFO ordering
collapses the mutation difference before it can propagate to an observable outcome. The
first path's `catch` block or `.then` continuation runs to completion synchronously,
`get -> mutate -> return`, before the second path's continuation begins. The second always
sees post-mutation state, locked or not.

A false-positive concurrency test gives a false sense that a structurally important
invariant is test-guarded. The structural regression is silent: race protection is gone,
the test stays green, and discovery usually waits for a real race in production.

The general shape recurs beyond concurrency: **an assertion can only detect what its
vantage point can distinguish.** An outcome assertion cannot see a structural change that
does not alter outcomes, in the same way a source-scanning test that collects file paths
cannot see a second offender inside a file it already allows.

## When to Apply

- Writing or reviewing a test for module-scoped shared state (`Set`, `Map`, counter,
  queue, cache, in-process lock) where the invariant is structural rather than about
  returned values.
- A candidate test uses `Promise.all`, sequential `await` calls, or any concurrency
  primitive to assert a single-winner outcome and attributes that property to the shared
  state.
- Before accepting a kill claim: check whether any `await` boundary separates the code
  paths' access to the state. If both access points run synchronously within their
  respective continuations — common when a test stubs an async dependency to reject so the
  helper falls through to a synchronous fallback — FIFO ordering masks structural
  mutations.
- Whenever "this path is deliberately NOT guarded" is part of the design. Pin that
  direction too, or a lock reinstated where it does not belong will pass silently.

## Examples

**Before — wire-shape assertion (mutation-blind):**

```typescript
it('cross-helper Redis-stubbed Promise.all -> exactly one winner', async () => {
  vi.spyOn(redis, 'getdel').mockImplementation(() => Promise.reject(new Error('stubbed')));
  const issued = await issueFreshAuthToken('race-cross', 'password', T);
  const [a, b] = await Promise.all([ /* two consume calls on the same token */ ]);
  expect([a, b].filter((r) => r.valid)).toHaveLength(1); // passes under the mutation too
});
```

Both fallback paths run synchronously (`memStore.get -> memStore.delete -> return`) with no
intervening `await`. Microtask FIFO serializes them: the first completes its mutation
before the second begins, so the second sees an empty store and returns `expired`
regardless of the lock's structure.

**After — structural sampling from inside the call (mutation-killing):**

The two pins in the Guidance section above. The forward pin fails if the `add` is ever
dropped; the release assertion fails if the lock leaks; the inverse pin fails if a lock is
introduced on the path that is designed to run without one. No `skipIf`, no Redis-down
stubs, no race.

## Cross-references

- `agents/docs/solutions/conventions/mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md`
  — parent convention. This learning is a specific failure mode within its general case:
  the kill claim is false because the masking mechanism is JS microtask scheduling rather
  than corpus shape.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`
  — grandparent principle. Every load-bearing assertion must fail on mutation of the code
  under test; this convention names a specific mechanism that defeats the revert-verify
  check.
- `agents/docs/solutions/conventions/source-discipline-canaries-must-assert-at-call-site-not-file-granularity-2026-08-26.md`
  — the static-analysis sibling. Same root theme from the other direction: an assertion's
  shape decides what it can detect. There, a source-scanning canary collects containers
  and so cannot see a second offender inside an allowed one; here, an outcome assertion
  cannot see a structural change that leaves outcomes identical.
- `agents/docs/solutions/conventions/test-seams-export-shape-as-const-2026-05-04.md`
  — adjacent on solution shape. Test-only exports are the canonical PEvO mechanism for
  reaching module-private state in tests; the structural sampling here is a specialization
  for observing that state mid-operation.
- `agents/docs/solutions/conventions/final-state-assertions-cannot-discriminate-dispatch-from-confirmation-2026-09-01.md`
  — the non-awaited half of this rule, same module and same size-accessor idiom. There the
  code dispatches without awaiting (`void client.del(k).then(() => set.delete(k))`), so
  there is no dependency to mock and no race to run: the accessor is sampled synchronously,
  in the same block as the dispatching call, before any `.then()` can run, since the dispatching block has not yet yielded. Reach
  for that shape whenever the vantage point is right but there is no `await` to hang a
  `mockImplementation` on. Neither entry subsumes the other.
- `backend/src/lib/fresh-auth.ts` — the `inFlightConsumes` lock and the
  `_getInFlightConsumesSizeForTests` export.
- `backend/tests/lib/fresh-auth.test.ts` — the forward and inverse structural pins, which
  sample the lock size from inside the burn and from inside the slide respectively.

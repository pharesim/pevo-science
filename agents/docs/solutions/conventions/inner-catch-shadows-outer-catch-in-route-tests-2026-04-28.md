---
module: backend
date: 2026-04-28
last_updated: 2026-06-09
problem_type: convention
component: testing_framework
severity: medium
related_components:
  - rails_controller
tags:
  - testing
  - mutation-kill
  - route-error-handling
  - wrapping-primitive
  - try-catch-composition
  - recursive
  - dead-branch
applies_when:
  - "Writing a route-handler test where the route nests an inner try/catch (around the broadcast / IO / library call) inside an outer wrapper try/catch (around the surrounding state, lock, or transaction)"
  - "Both catches translate the throw into the same HTTP response envelope"
  - "Adding a new test for the wrapper's outer catch behavior"
  - "Writing a test that simulates a throw inside a recursive or nested function call to exercise the CALLER's catch branch, when the callee has its own outer catch that normalizes errors to a return value"
---

# Inner-catch shadows the branch under test (route wrappers and recursive calls)

## Context

Route handlers commonly compose two layers of error handling:

- An **inner try/catch** around the broadcast / IO / library call (e.g., `broadcastJsonWithTimeout`, `client.send`, `db.query`)
- An **outer try/catch** in a wrapper that surrounds the whole route flow (a lock helper, a transaction helper, a request-context wrapper)

When both catches translate the throw into the **same HTTP response envelope**, a test that triggers an exception caught by the inner catch never exercises the outer catch. The test passes because the inner catch produced the expected envelope, not because the outer catch did. A regression that drops the outer catch (or a flag inside its handler call) still produces the same response, and the test silently misses it.

This was surfaced during round-1 architect review of `BE-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING` (commit `9d3de2c`). Two route specs targeting the wrapper's new outer catch — one passed for the wrong reason, one passed correctly. The pattern generalizes beyond that specific commit.

The same shadow occurs **across a function-call boundary**, not just between two catch layers in one function. When a test simulates a throw inside a recursive or nested call to exercise the **caller's** catch branch, and the **callee** has its own outer catch that normalizes errors to a return value, the throw is absorbed by the callee before it ever propagates to the caller. The caller's branch is never entered, and the test passes via the callee's normal return. The recursive variant below is a sharper case than the route-wrapper one: there the shadowed outer catch is still live in production (just not reached by that test); in the recursive case the caller's branch is **provably dead** (the callee can never throw the class the branch handles), so the remediation is to delete the branch, not rewrite the test.

## Guidance

When testing a wrapper's outer catch, the throw must originate from a path the **inner** catch does not cover. Three reliable shapes:

1. **Throw from a helper called AFTER the broadcast resolves successfully.** Post-broadcast cache writes, DB writes, side-effect helpers — all run after the inner try/catch closes. A throw here escapes the inner catch and is caught by the outer wrapper.
2. **Throw from a sync construction step BEFORE the broadcast.** Key parsing, payload assembly, schema validation. Same outcome — the throw never enters the inner try.
3. **Throw from a non-broadcast code path inside `fn`.** Anything in `fn`'s body that is not wrapped by the inner try.

If the test must use a throw class the inner catch handles (e.g., `BroadcastTimeoutError` because that's what's contractually relevant), **mutation-verify**: revert the wrapper's outer catch locally, re-run the test, confirm it FAILS. If it passes both with and without the wrapper change, the test isn't covering the wrapper.

## Why this matters

Two layers of error handling that both produce the same envelope create a silent test-coverage gap:

- The test naively reads as "stage a `BroadcastTimeoutError`, expect 504" — looks correct.
- The route naively reads as "the wrapper has a new try/catch around `await fn()`" — looks like throws inside `fn` reach the wrapper.
- The interaction (inner catch shadows outer catch when their throw classes overlap) is only visible when you trace the full call chain and notice the inner catch returns before control reaches the outer wrapper.

A future test author writing a similar wrapper-with-inner-catch test will naturally make the same mistake. Without explicit guidance, the entire class of "outer wrapper as defense-in-depth" features ships with tests that don't actually exercise them.

## When to apply

- Reviewing a route-handler test that involves a wrapper helper (`withLock`, `withTransaction`, `runInRequestContext`, etc.)
- Adding a new test for an outer catch that was added as defense-in-depth on top of an existing inner catch
- Reviewing a wrapping-primitive change (per `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`) that adds error handling — make sure tests exercise the new layer, not the pre-existing one

Skip when the inner catch and outer catch produce **different** response shapes (status code, error code, details) — the assertion can discriminate, so coverage is fine. The trap fires only when both layers converge to the same envelope.

## Examples

### Wrong — test passes for the wrong reason

```ts
// Route shape:
withOrcidBindingLock(orcidId, mode, async () => {
  try {
    await broadcastJsonWithTimeout(...);          // INNER
  } catch (err) {
    handleBroadcastError(res, err, helperOpts);   // (1) handles BroadcastTimeoutError → 504
    return;
  }
  await cacheOrcidBinding(...);
  sendOk(res, ...);
}, helperOpts);

// withOrcidBindingLock internally:
//   if (lock.state === 'unavailable') {
//     try { await fn(); }                                                 // OUTER (the new layer)
//     catch (err) {
//       handleBroadcastError(res, err, { ...opts, forceAmbiguousOutcome: true });   // (2) → 504
//     }
//   }

// Test:
broadcastJsonMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));
const res = await request(app).post('/api/orcid/callback').send({ ... });
expect(res.status).toBe(504);
expect(res.body.error.details).toEqual({ retriable: false, outcome: 'uncertain', ... });
// Passes — but path (1) handled it. Path (2) was never reached.
// Removing the wrapper's outer catch entirely would still pass this test.
```

### Right — test throws from a path the inner catch does not cover

```ts
// Same route, but stage a post-broadcast throw. After commit d8b9b75 the
// post-broadcast cascade is wrapped as PostBroadcastWriteError, so the wire
// shape is 502 POST_BROADCAST_FAILED (outcome:'confirmed') rather than the
// 504 BROADCAST_TIMEOUT outcome:'uncertain' envelope. The mutation-kill
// signal is the same — removing the wrapper's outer catch propagates the
// throw to the outer /callback catch as 500 INTERNAL_ERROR, failing the
// 502 assertion below — but the assertion target moved.
broadcastJsonMock.mockResolvedValueOnce({ id: 'fake-tx' });        // broadcast SUCCEEDS
vi.spyOn(__test_seams, 'updateAccountOrcid').mockRejectedValueOnce(new Error('pool exhausted'));
// Lock-state arranged so the wrapper takes the 'unavailable' branch:
redisSpy.mockImplementationOnce(...);  // forces lock state

const res = await request(app).post('/api/orcid/callback').send({ ... });
expect(res.status).toBe(502);
expect(res.body.error.code).toBe('POST_BROADCAST_FAILED');
expect(res.body.error.details).toMatchObject({
  outcome: 'confirmed',
  tx_id: 'fake-tx',
  failed_step: 'account_update',
});
// Now removing the wrapper's outer catch fails the test — coverage is real.
```

Pre-d8b9b75 the same scenario asserted `res.status === 504` with `outcome:'uncertain'`; that assertion is stale at HEAD. The shadow class itself is unchanged: a throw the inner catch cannot absorb still tests the outer catch correctly. Only the wire shape the outer catch produces changed (because the discrimination layer in `handleBroadcastError` now branches on `instanceof PostBroadcastWriteError` ahead of the ambiguous-outcome path).

### Right — mutation-verify when the throw class must come from the inner-covered path

```bash
# Author writes the BroadcastTimeoutError-on-unavailable-branch spec, then verifies:
git stash                                       # save current state
# Edit withOrcidBindingLock: delete the new outer try/catch
npm test -- orcid.test.ts                       # spec MUST fail; if it passes, the spec isn't covering the wrapper
git stash pop                                   # restore
```

### Recursive variant — the callee's own outer catch swallows before the caller's branch runs

`cascadeRevocation` (`backend/src/wot.ts`) recurses, and each call has a function-level outer catch that re-throws only `PartialCascadeError` and turns every other error into `return []`. A test mocked the HAF discovery query to throw a plain `Error` inside the recursive call, intending to exercise the parent's inner `catch (nestedErr)` "non-budget nested error" branch:

```ts
// Inside cascadeRevocation's per-iteration loop:
try {
  const nested = await cascadeRevocation(vouchee, depth + 1, deadline);  // recursion
  completed.push(...nested);
} catch (nestedErr) {
  // <-- the test claimed to cover THIS branch
  ...
}

// Test:
hafQueryMock.mockImplementation(async (sql, params) => {
  if (params.at(-2) === 'v1') throw new Error('HAF discovery query failed inside nested cascade');
  // ...normal rows otherwise
});
const completed = await cascadeRevocation('boss');
expect(completed).toEqual(['tx-v1', 'tx-v2', 'tx-v3']);   // green — via the recursive swallow
expect(broadcastJsonMock).toHaveBeenCalledTimes(3);        // green — via the recursive swallow
```

The throw fires inside `cascadeRevocation('v1', ...)`. That recursive call's OWN outer catch sees a non-`PartialCascadeError`, logs it, and returns `[]`. From the parent's view, `await cascadeRevocation('v1', ...)` resolved normally; the parent's `catch (nestedErr)` is never entered. The assertions pass via the swallow path, and the test stays green against pre-fix code. Tracing the invariant shows the parent's branch is **dead**: a recursive `cascadeRevocation` can only throw `PartialCascadeError`. The fix deleted the dead branch (replacing it with a type-narrow guard `if (!(nestedErr instanceof PartialCascadeError)) throw nestedErr;`) and deleted the vacuous test (commit `a18373ba`). Unlike the route-wrapper case, the remedy here is removal, not a rewrite to throw from an uncovered path — there is no reachable path that enters the branch.

Detection is the same mutation-kill check: delete (or no-op) the branch under test and re-run. If the test stays green, trace the throw's propagation path and look for a closer handler — an inner catch, or a nested/recursive call's own outer catch — that intercepts it first.

## Cross-references

- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — general principle: every spec should fail if the code under test is mutated. This doc captures the specific manifestation when wrapper composition creates a silent shadow.
- `agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md` — sibling testing-rigor learning where mocks silently fall through to a default branch and the test passes for the wrong reason.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — adjacent: when a wrapping primitive grows error handling, every call site must be audited for adoption. This doc covers the inverse — when the new layer is added, every test must be audited for actual coverage.
- `agents/docs/solutions/conventions/test-fabricated-error-shape-masks-dead-branch-2026-06-09.md` — sibling in the same "vacuous error-handling test" family, a different mechanism: there the branch is dead because the guard reads a field (`err.status`) the real error class never sets and the test fabricates it via `Object.assign`; here the branch is shadowed (or dead) because a closer/nested handler intercepts the simulated error before it reaches the branch.

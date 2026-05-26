---
title: Test mocks for evalScript-dispatched Redis scripts must cover both eval and evalsha and discriminate by key
date: 2026-05-26
category: conventions
module: backend/src/lib/redis-scripts.ts
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "A test stages a rejection or a forced return for a Lua script dispatched via evalScript (not a direct redis.eval)"
  - "Another evalScript-dispatched script (e.g. a rate limiter) runs on the same route before or after the target script"
  - "Test correctness depends on the rejection reaching the right call site (a 503 handler, a retry gate, an error-envelope assertion)"
related_components:
  - authentication
tags:
  - redis
  - evalsha
  - evalscript
  - vitest
  - lua-script
  - test-mocking
  - ioredis
---

# Test mocks for evalScript-dispatched Redis scripts must cover both eval and evalsha and discriminate by key

## Context

`evalScript(redis, scriptName, keys, args)` in `backend/src/lib/redis-scripts.ts` is the shared dispatcher for every registered Lua script. It selects `redis.evalsha` (warm SHA cache) or `redis.eval` (cold cache miss) at runtime, with an automatic `NOSCRIPT`-fallback path that re-loads the script body and retries. SHA warmth is established on the Redis `ready` event, but a sibling test's `vi.resetModules()` (or a fresh test process) can clear the module-level SHA cache, silently flipping warm→cold and changing which verb is live between runs.

Once a call site migrated from a direct `redis.eval(scriptBody, ...)` to `evalScript(...)`, two test-mock assumptions that had worked before silently broke. The failure surfaced as a RED-on-clean-HEAD discovery: a spec that had been passing began failing after `evalScript` adoption swept across the shared scripts. The same trap recurs for every script that joins the registry, so this is a project-wide convention, not a one-off fix.

## Guidance

### Rule 1 — mock BOTH `eval` and `evalsha`

A spy on only one verb misses whichever dispatch path is live when the test runs. SHA-cache warmth decides the path, and warmth is mutable across the suite (a `vi.resetModules()` elsewhere flips it). A rejection staged on the wrong verb silently never fires — the test passes for the wrong reason, or flakes by run order.

Before (fragile — only intercepts the cold path):

```ts
vi.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('OOM'));
```

After (stable — both verbs, restored in finally):

```ts
const realEval    = redis.eval.bind(redis)    as (...a: unknown[]) => Promise<unknown>;
const realEvalsha = redis.evalsha.bind(redis) as (...a: unknown[]) => Promise<unknown>;

const evalSpy    = vi.spyOn(redis, 'eval').mockImplementation(/* see Rule 2 */);
const evalshaSpy = vi.spyOn(redis, 'evalsha').mockImplementation(/* see Rule 2 */);
try {
  // ... run the request ...
} finally {
  evalSpy.mockRestore();
  evalshaSpy.mockRestore();
}
```

Bind `realEval`/`realEvalsha` BEFORE installing the spies, or delegating from inside the mock recurses into the spy.

### Rule 2 — discriminate by the target key (args[2]), not by call ordinal

`evalScript` is shared. On a route that also runs a rate limiter, the limiter's script dispatches via `evalScript` BEFORE the target script. A blanket `mockRejectedValueOnce` is consumed by the limiter's call, so the target failure path never runs. Call-ordinal discrimination (first call / second call) is equally fragile: registering a new shared script reshuffles the order with no compile-time signal.

For both verbs the call shape is `(sha|body, numKeys, ...keys, ...args)`, so the first key always lands at argument index 2. Discriminate on that key and delegate everything else to real Redis:

```ts
const rejectTarget =
  (real: (...a: unknown[]) => Promise<unknown>) =>
  (...args: unknown[]): Promise<unknown> =>
    args[2] === targetKey
      ? Promise.reject(new Error('OOM'))
      : real(...args);

vi.spyOn(redis, 'evalsha').mockImplementation(rejectTarget(realEvalsha) as never);
vi.spyOn(redis, 'eval').mockImplementation(rejectTarget(realEval) as never);
```

Every dispatch whose first key is not `targetKey` (the limiter, lock-release scripts, any other registered script) runs against real Redis unimpeded.

### Sub-rule — the carve-out header must describe the dual-verb shape

The clause-(a) carve-out docblock at the top of the test file (see the test-mock carve-out convention) must describe the dual-verb key-discriminating shape explicitly. A header that still says "single-verb mock" re-invites the bug: the next maintainer reads the header, copies the pattern, and regresses to a single-verb blanket mock. The header is the forward-facing signal; it must match the implementation.

## Why This Matters

The failure is invisible until three conditions coincide, none of which raises a compiler or linter error:

1. **Script migration** — the call site moves from `redis.eval(body, ...)` to `evalScript(...)`. Before, `vi.spyOn(redis, 'eval')` was the only interception point and the single-verb mock worked.
2. **Shared dispatch** — another registered script (a limiter) runs before the target on the same request. Before, a blanket `mockRejectedValueOnce` reached the right call by accident.
3. **SHA-warmth variance** — `evalScript` picks `eval` vs `evalsha` at runtime. Before, direct `redis.eval` made the dispatch path deterministic.

The test keeps passing in isolation (warm cache, no prior limiter dispatch) and begins failing only after a sibling test's module reset or a new shared-script registration — a RED-on-HEAD break with no obvious causal link to the test that broke. As more scripts adopt `evalScript`, the surface for this failure class grows with the registry.

## When to Apply

Apply the dual-verb key-discriminating pattern when ALL hold:

- The call site under test dispatches a Lua script through `evalScript` (not a direct `redis.eval`).
- The test stages a rejection or a specific return for exactly that script's dispatch.
- The route also runs another `evalScript`-dispatched script (rate limiter, lock script, atomic-increment script) on the same request.
- Correctness depends on the rejection reaching the right call site.

For plain verbs that do not flow through `evalScript` (`redis.del`, `redis.decr`, `redis.get`), a single-verb `mockRejectedValueOnce` remains correct — those calls are not shared-dispatch and their verb does not flip at runtime.

## Examples

A `/verify` route runs a rate-limiter script via `evalScript`, then (if the limit passes) an atomic cap-counter `INCR` script via `evalScript`. A test wants the 503 emitted when the cap-counter dispatch fails.

Before (breaks after evalScript adoption — the reject is consumed by the limiter):

```ts
vi.spyOn(redis, 'evalsha').mockRejectedValueOnce(new Error('Lua error: OOM ...'));
const res = await postVerify(token, ip);
expect(res.status).toBe(503); // fails: got 429 from the limiter, cap-INCR never reached
```

After (dual-verb, key-discriminating, asserts the cap dispatch fired exactly once across whichever verb was live):

```ts
const counterKey  = broadcastAttemptsKey(token);
const realEval    = redis.eval.bind(redis)    as (...a: unknown[]) => Promise<unknown>;
const realEvalsha = redis.evalsha.bind(redis) as (...a: unknown[]) => Promise<unknown>;

const rejectCapIncr =
  (real: (...a: unknown[]) => Promise<unknown>) =>
  (...args: unknown[]): Promise<unknown> =>
    args[2] === counterKey
      ? Promise.reject(new Error('Lua error: OOM ...'))
      : real(...args);

const evalshaSpy = vi.spyOn(redis, 'evalsha').mockImplementation(rejectCapIncr(realEvalsha) as never);
const evalSpy    = vi.spyOn(redis, 'eval').mockImplementation(rejectCapIncr(realEval) as never);
try {
  const res = await postVerify(token, ip);
  expect(res.status).toBe(503);
  expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  const capCalls = [...evalSpy.mock.calls, ...evalshaSpy.mock.calls].filter((c) => c[2] === counterKey);
  expect(capCalls).toHaveLength(1);
} finally {
  evalshaSpy.mockRestore();
  evalSpy.mockRestore();
}
```

## Related

- `test-failures/assertion-vacuity-from-upstream-bail-in-mocked-tests-2026-05-17.md` — the discriminator-uniqueness rule (key the mock on a token unique to the target among everything that flows through the double). This convention is the `evalScript`-specific extension: the helper's runtime eval/evalsha verb selection adds the "mock both verbs" requirement on top of "discriminate by a unique key."
- `conventions/test-mock-carve-out-clause-c-2026-05-04.md` — governs WHEN mocking shared Redis helpers is permitted and the real-path companion required; this convention governs HOW to write the mock once permitted. The carve-out's non-compliant example names the EVAL/EVALSHA fallback as an uncovered axis this convention fills.
- `conventions/vitest-fake-timers-module-private-state-isolation-2026-04-29.md` — `vi.resetModules()` clears module-private state; here that state is the `evalScript` SHA cache, which is what flips the live verb between runs.
- `conventions/redis-advisory-lock-with-lua-cas-nonce-2026-05-15.md` — lock-release Lua scripts still dispatched via direct `redis.eval`; if migrated to `evalScript`, their tests inherit this convention.
- `conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` — sibling test-discipline convention.

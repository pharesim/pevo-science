---
title: Constructor-time guards on errors thrown from setTimeout callbacks escape as uncaughtException
date: 2026-05-01
module: backend
problem_type: runtime_error
category: runtime-errors
component: background_job
severity: critical
symptoms:
  - "Worker process exits with `process.exit(1)` after a `BroadcastTimeoutError` is thrown from a `setTimeout` callback inside `Promise.race`"
  - "Node emits `uncaughtException` for an error that the surrounding `await` should have caught"
  - "Constructor-time `RangeError` guard added in round-4 hardening crashes the process instead of failing the awaited call"
  - "Promise.race timeout branch's rejection is never observed by the awaiting frame"
root_cause: async_timing
resolution_type: code_fix
related_components:
  - backend/src/hive.ts
  - backend/src/lib/broadcast-error.ts
tags:
  - async
  - error-handling
  - promise-race
  - settimeout
  - defensive-coding
  - broadcast
  - uncaught-exception
applies_when:
  - "Adding input-validation guards to error classes thrown from `setTimeout`/`setImmediate`/event-emitter callbacks"
  - "Hardening async wrappers around `Promise.race(workPromise, timeoutPromise)` patterns"
  - "Reviewing constructor-time invariants on Error subclasses used in deferred-throw contexts"
---

## Problem

A `RangeError` thrown from `BroadcastTimeoutError`'s constructor fires inside the `setTimeout` callback that constructs it for `reject()`, escaping as Node `uncaughtException` and crashing the single-process backend worker instead of rejecting the broadcast Promise. In-flight HTTP requests get TCP resets with no 502/504 envelope, and any concurrent in-flight requests on the same worker die with them.

## Symptoms

- `uncaughtException` fired from `node:timers` with a `RangeError: BroadcastTimeoutError requires a finite positive timeoutMs` payload.
- Backend worker exits with code 1 from `backend/src/index.ts:24-27`'s `process.on('uncaughtException')` handler when a non-finite or non-positive `timeoutMs` reaches `broadcastJsonWithTimeout` or `broadcastSendOperationsWithTimeout`.
- Originating HTTP client sees a TCP reset, not a structured `502 BROADCAST_FAILED` JSON body.
- Sibling in-flight requests on the same Node process die at the same instant with no per-request log line.
- Constructor-only unit tests (`expect(() => new BroadcastTimeoutError(NaN)).toThrow(RangeError)`) stay green and hide the regression.

## What Didn't Work

Round-4 prescription was: "throw on construction in `BroadcastTimeoutError` itself if input is non-finite/non-positive (defense at the constructor is preferable since it's the single throw site)." That landed as a guard inside the constructor:

```ts
export class BroadcastTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(`BroadcastTimeoutError requires a finite positive timeoutMs; got ${String(timeoutMs)}`);
    }
    super(`Hive broadcast timed out after ${timeoutMs}ms`);
    this.name = 'BroadcastTimeoutError';
  }
}
```

The "single throw site" framing was right about the construction location and wrong about the call frame. The class is only ever constructed inline inside a `setTimeout` callback: `setTimeout(() => reject(new BroadcastTimeoutError(timeoutMs)), timeoutMs)`. A synchronous throw from the constructor fires before `reject()` evaluates its argument, so the rejection never reaches `Promise.race`'s timeout half — the throw escapes the timer callback into Node's global `uncaughtException` path and the process dies. Pre-fix the failure was a `details.timeout_ms: null` cosmetic regression (P3); post-fix the same bad input crashes the worker (P1). Defense in depth turned into a load-bearing crash.

## Solution

Round-5 fix (`backend/src/hive.ts`, commit `5258102`) extracts a wrapper-entry helper and asserts before any timer or Promise machinery is constructed. The constructor guard is kept as belt-and-suspenders for direct callers (test fixtures) and never fires in production:

```ts
function assertFinitePositiveTimeoutMs(timeoutMs: number, fnName: string): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`${fnName} requires a finite positive timeoutMs; got ${String(timeoutMs)}`);
  }
}

export async function broadcastJsonWithTimeout(payload, key, timeoutMs = DEFAULT_BROADCAST_TIMEOUT_MS) {
  assertFinitePositiveTimeoutMs(timeoutMs, 'broadcastJsonWithTimeout'); // FIRST executable statement
  let timer;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BroadcastTimeoutError(timeoutMs)), timeoutMs);
  });
  // ...
}
```

Same shape applied to `broadcastSendOperationsWithTimeout`. The `RangeError` now propagates as a normal `async`-function Promise rejection through `handleBroadcastError`'s non-timeout branch, producing a `502 BROADCAST_FAILED` response with structured `event:'broadcast_failed'` operator log.

## Why This Works

A synchronous `throw` inside a `setTimeout` callback is not caught by any local `try`/`catch` in the surrounding `Promise` executor — by the time the timer fires, the executor has long since returned and the call stack is just `[Timer.callback]`. Node routes the unhandled throw through `process.emit('uncaughtException')`, and PEvO's handler calls `process.exit(1)`. Constructing the error inline as `reject(new BroadcastTimeoutError(timeoutMs))` is not "rejecting with an error" — it is "construct, then call reject"; if construction throws, `reject` is never invoked.

Hoisting the validation to the first executable statement of the `async` wrapper changes the throw context. An `async` function automatically converts synchronous throws into Promise rejections, so the `RangeError` flows out as a normal awaited rejection that the existing `handleBroadcastError` catch chain handles. The constructor never sees bad input in the production path, so its guard is dead code that only protects ad-hoc construction (tests, future callers).

## Prevention

**Test pattern** — 12 specs (6 per wrapper) covering NaN, +Infinity, -Infinity, 0, negative finite, and a positive control. Each spec asserts BOTH that the wrapper rejects with `RangeError` AND that `expect(broadcastSpy).not.toHaveBeenCalled()`:

```ts
for (const bad of [NaN, Infinity, -Infinity, 0, -1]) {
  it(`broadcastJsonWithTimeout rejects without calling dhive when timeoutMs=${bad}`, async () => {
    await expect(broadcastJsonWithTimeout(payload, key, bad)).rejects.toBeInstanceOf(RangeError);
    expect(broadcastSpy).not.toHaveBeenCalled(); // pins the guard at wrapper entry
  });
}
```

The `not.toHaveBeenCalled()` assertion is the load-bearing check: removing the wrapper-entry guard lets `Promise.race` invoke `hiveClient.broadcast.json(...)` synchronously while constructing the racing Promise, the spy records the call, and the assertion flips red — independent of whether the timer-callback throw kills the test process. This is a mutation-kill test in the sense of `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`.

**Code-review symptoms list** — anything matching these warrants a wrapper-entry guard instead of a throw-site guard:

- A synchronous `throw` inside `setTimeout(() => ...)`, `setImmediate(() => ...)`, `process.nextTick(() => ...)`, `EventEmitter.on('event', () => ...)`, stream `'data'` listeners, or any callback whose containing scope does not `await` or `.catch()` the result.
- A constructor that throws when the class is constructed inline as a Promise-rejection argument (`reject(new ErrorClass(...))`) — the throw fires before `reject` is called.
- Any "single throw site → guard at the construction location" framing in review notes that names the construction location without naming its call frame.

**Generalization** — when proposing or applying a "guard at the source of truth" defensive pattern, ask: *what's the call frame of the throw site?* If the throw site is itself a timer callback, event listener, or other context where synchronous throws don't propagate to the local scope's catch (or to a `Promise.reject` argument), the guard belongs at the wrapper entry where async-function throw → Promise rejection semantics apply. The constructor- or callback-site guard MAY be kept as belt-and-suspenders for direct callers (test fixtures, future inline construction), but it must not be the only line of defense for inputs that flow through a timer, `Promise.race` racer, event listener, or any callback whose containing scope has already returned by the time the throw fires.

## Related

- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — parent convention for the broadcast-error machinery (response-envelope semantics for the same throw class this doc shows can escape).
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — Case 2 ("guard at the single throw site") is the convention this incident extends; the wrapper-entry pattern is the missing "consider the throw site's call frame" addendum. Case 2's framing assumes the construction location is a sufficient guard site; this learning shows that assumption breaks when the construction location is itself inside a callback frame the surrounding `Promise.race` never observes.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — the convention whose mutation-kill discipline surfaced the constructor-guard hazard during round-5 review.
- `agents/docs/solutions/runtime-errors/helper-extraction-express5-response-ordering-2026-04-28.md` — sibling failure mode in the same `accreditation.ts` / `handleBroadcastError` / `BroadcastTimeoutError` cluster (post-response cleanup throw vs. setTimeout-callback throw).
- `agents/docs/solutions/conventions/inner-catch-shadows-outer-catch-in-route-tests-2026-04-28.md` — same `BroadcastTimeoutError` throw class from the test-shape angle.
- `agents/docs/solutions/conventions/route-level-error-class-coverage-after-helper-extraction-2026-04-29.md` — sibling discipline: lib-level tests of the constructor guard do not absolve the timer-fire path coverage at the wrapper boundary.

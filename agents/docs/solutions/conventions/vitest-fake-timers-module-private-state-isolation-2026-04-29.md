---
title: Testing periodic-reporter modules — vi.useFakeTimers + vi.resetModules + dynamic-import + bump-real / re-arm-fake
date: 2026-04-29
category: conventions
module: backend
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - Writing unit tests for an interval-driven module (periodic reporter, rate counter, ops summary, dashboard-keyed structured log emitter)
  - The module reads or mutates module-private state that should reset cleanly per-test (e.g., a `lastReportedCount` counter, a singleton `defaultSemaphore.abortCount`)
  - The test wants to bump the underlying state via an awaited side-effect (`await runWithArgon2Slot(...)`, `await someOp()`) AND advance fake time for the interval to fire
  - The natural shape "start interval → bump-via-await → advance fake time → assert log" silently hangs because awaits don't progress under `vi.useFakeTimers()`
  - The production code intentionally does NOT expose a `__resetForTesting()` hook, but tests still need a fresh module instance per case
tags:
  - testing
  - vitest
  - fake-timers
  - vi-resetmodules
  - module-private-state
  - periodic-reporter
  - microtask-ordering
  - test-isolation
---

# Testing periodic-reporter modules — vi.useFakeTimers + vi.resetModules + dynamic-import + bump-real / re-arm-fake

## Context

Periodic reporters are common in production code: a `setInterval(...)`-driven function reads accumulated state (counters, queues, latency buckets) and emits a structured log every N seconds. Examples in this repo: `reportArgon2Aborts` in `backend/src/lib/argon2-semaphore.ts`, which emits `{ event: 'argon2_abort_summary', count: <delta> }` once per `ABORT_REPORT_INTERVAL_MS = 60_000` when the abort counter has incremented.

Such reporters are easy to write but historically hard to test, for three reasons:

1. **Module-private state.** The "what's been reported already" baseline (`abortLastReportedCount`) lives at module scope by design — exposing it via a `__resetForTesting()` hook would be a production-surface concession to test convenience. Each test wants a fresh module instance with the baseline at zero.
2. **Mixed timer regimes.** The reporter relies on `setInterval`, which in tests must be controlled via `vi.useFakeTimers()` so the suite doesn't sleep 60 real seconds per test. But the operations that bump the underlying counter (`await runWithArgon2Slot(..., { signal: alreadyAbortedSignal })`) involve awaits that **do not progress under fake timers** — vitest's fake-timer mock advances `setTimeout`/`setInterval` ticks but does not pump the microtask queue past a real awaited Promise. The natural test shape `start → bump-via-await → advance` deadlocks at the bump.
3. **Logger-spy lifecycle.** The reporter calls `logger.info(...)` against a module-imported `logger`. If `vi.resetModules()` is used to reset module-private state, it also resets the logger module — meaning a spy installed against the previous logger instance no longer intercepts calls.

The first iteration of `backend-argon2-abort-observability` (commit `5d33f24`) shipped the reporter without unit tests. The architect's round-1 hold (P2) demanded coverage. The implementer's round-1 hold-fix (commit `aeef5f2`) introduced the testing pattern this convention documents — applicable to any future periodic-reporter module.

## Guidance

The pattern is a four-part shape that addresses each constraint above. See the `describe('periodic abort-summary reporter')` block in `backend/tests/lib/argon2-semaphore.test.ts` (post-`aeef5f2`) for the canonical implementation.

### 1. `vi.resetModules()` + dynamic import per test

In the describe block's `beforeEach`:

```ts
beforeEach(() => {
  vi.resetModules();
});

const makeFresh = async () => {
  const sem = await import('../../src/lib/argon2-semaphore.js');
  const log = await import('../../src/logger.js');
  return { sem, log };
};
```

Each test calls `await makeFresh()` to get a fresh module instance. Module-private state (`abortLastReportedCount`, the singleton `defaultSemaphore.abortCount`) is at zero. **No production reset hook is needed.**

The dynamic `await import(...)` is essential: a static `import` at the top of the test file would resolve once at module load and pin the same instance across all tests, making `vi.resetModules` a no-op for that import.

### 2. Bump under real timers, re-arm under fake timers

The bump operation (`await runWithArgon2Slot(..., { signal: alreadyAbortedSignal })`) MUST run with **real** timers, because the await chain inside `runWithArgon2Slot` includes microtask hops that fake timers don't pump. The reporter's interval MUST run with **fake** timers, because real timers would make the test sleep 60 seconds.

The pattern alternates regimes:

```ts
it('reports the delta on each interval', async () => {
  const { sem, log } = await makeFresh();
  const infoSpy = vi.spyOn(log.logger, 'info').mockImplementation(() => undefined as never);

  // Phase 1: bump the counter (REAL timers — the await inside runWithArgon2Slot must resume)
  for (let i = 0; i < 3; i++) {
    const ac = new AbortController();
    ac.abort();
    await sem.runWithArgon2Slot(async () => 'unreached', { signal: ac.signal }).catch(() => {});
  }

  // Phase 2: switch to fake timers and arm the reporter
  vi.useFakeTimers();
  try {
    sem.startArgon2AbortReporter();

    // Phase 3: advance fake time — interval fires, reporter reads counter, emits log
    vi.advanceTimersByTime(sem.ABORT_REPORT_INTERVAL_MS);

    // Phase 4: assert the structured emission
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toMatchObject({
      event: 'argon2_abort_summary',
      count: 3,
    });
  } finally {
    sem.stopArgon2AbortReporter();
    vi.useRealTimers();
    infoSpy.mockRestore();
  }
});
```

For tests that need MULTIPLE bump-then-tick cycles (e.g., asserting the second interval reports only the new delta, not the cumulative), the alternation continues:

```ts
// First cycle
[bump under real] → [vi.useFakeTimers] → [start] → [advanceTimersByTime] → [assert] → [stop] → [vi.useRealTimers]
// Second cycle (new bumps)
[bump more under real] → [vi.useFakeTimers] → [restart] → [advanceTimersByTime] → [assert delta-only]
```

Document the rationale in a describe-block comment so future contributors understand the regime switching.

### 3. Logger spy installed per test against the freshly-imported module

After `vi.resetModules()`, the logger module is also reset. The spy must be installed against the freshly-imported instance, not against a top-of-file static import. The `infoSpy` lifecycle inside each test is install in setup phase → assert during test → `mockRestore()` in `finally`. Do NOT lift the spy to a `beforeEach` because it would pin the wrong logger reference.

### 4. Mock-implementation cast for pino's overloaded `LogFn`

Pino's `logger.info` has overloaded signatures. `vi.spyOn(log.logger, 'info').mockImplementation(() => undefined)` produces a TypeScript error because the implementation function's return type can't satisfy all overload return shapes simultaneously. The canonical minimal escape is:

```ts
vi.spyOn(log.logger, 'info').mockImplementation(() => undefined as never);
```

`as never` is assignable to all overload return types (since `never` is the bottom type). Avoid `as unknown as void` — it's a wider escape route through `unknown` and is inconsistent with the idiom.

## Why This Matters

Without this pattern, periodic-reporter modules ship without unit tests because the obvious shape doesn't work. Engineers either skip the tests, expose an unsafe `__resetForTesting()` hook, or invent ad-hoc workarounds that are fragile and not portable across modules. The pattern above is reproducible, doesn't pollute the production surface, and tests the reporter's actual behavior (not its proxy).

The architect-side rationale is captured in the `backend-argon2-abort-observability.md` round-1 hold block (which demanded coverage of the reporter's behavioral contract: delta-zero gating, delta-positive emission, `lastReportedCount` tracking, start/stop idempotency). Without the pattern, ALL of those properties would have been untested when the task originally landed — exactly the "exempt from regression coverage" gap the round-1 review caught.

A future periodic reporter (rate counter for queue saturation, latency-bucket histogram dump, error-rate roll-up) faces the same constraint. Skipping coverage at that future site reopens the same regression risk.

## When to Apply

- Any new module that uses `setInterval(...)` to emit a periodic structured log or aggregate.
- Any test that needs to bump module-private state via an awaited operation AND advance time.
- Any test that wants module-private state to reset per-case without exposing a production reset hook.
- Any periodic-reporter module that depends on `logger.info(...)` and needs spy-based assertions on the structured fields.

Do NOT apply to:

- Tests that only need timer mocking without await-driven state bumps (use plain `vi.useFakeTimers()` without `resetModules`).
- Tests that only need module-private state isolation without timers (use `vi.resetModules()` alone).
- Tests of pure synchronous logic that doesn't cross the fake-timer / await boundary.

## Examples

### Anti-pattern: deadlocks under fake timers

```ts
// ❌ BROKEN — bump-await never resumes under fake timers
it('reports delta', async () => {
  vi.useFakeTimers();
  startArgon2AbortReporter();
  const ac = new AbortController();
  ac.abort();
  await runWithArgon2Slot(async () => 'x', { signal: ac.signal }).catch(() => {});  // hangs forever
  vi.advanceTimersByTime(60_000);
  expect(infoSpy).toHaveBeenCalled();
});
```

The `await runWithArgon2Slot(...)` resolves via a microtask chain that `vi.useFakeTimers()` does not pump. The test hangs at the await (or under timeout, fails for the wrong reason).

### Anti-pattern: shared module instance across tests

```ts
// ❌ FRAGILE — first test bumps abortCount to 3; second test sees abortCount=3 baseline
import { runWithArgon2Slot, getArgon2AbortCount, startArgon2AbortReporter } from '../../src/lib/argon2-semaphore.js';

beforeEach(() => {
  vi.useFakeTimers();
});

it('test A', async () => { /* bumps abortCount to 3 */ });
it('test B', async () => { /* expects abortCount=0 baseline; sees 3, fails */ });
```

The static top-of-file import pins a single module instance. `vi.useFakeTimers` doesn't reset module state. Test ordering becomes load-bearing — exactly the brittleness this pattern eliminates.

### Anti-pattern: production reset hook leak

```ts
// ❌ DON'T — exposes a production hook for test convenience
export function __resetReporterForTesting() {
  abortLastReportedCount = 0;
}
```

A `__resetForTesting()` export pollutes the public surface and creates a foot-gun: a non-test caller could invoke it. The dynamic-import pattern achieves the same isolation without the surface concession.

### Canonical pattern (works)

```ts
// ✅ Per-test fresh module + alternating timer regimes
beforeEach(() => {
  vi.resetModules();
});

const makeFresh = async () => ({
  sem: await import('../../src/lib/argon2-semaphore.js'),
  log: await import('../../src/logger.js'),
});

it('emits delta-positive structured log', async () => {
  const { sem, log } = await makeFresh();
  const infoSpy = vi.spyOn(log.logger, 'info').mockImplementation(() => undefined as never);
  try {
    // Bump under real timers
    for (let i = 0; i < 3; i++) {
      const ac = new AbortController();
      ac.abort();
      await sem.runWithArgon2Slot(async () => 'x', { signal: ac.signal }).catch(() => {});
    }
    // Switch to fake timers, run the reporter, assert
    vi.useFakeTimers();
    sem.startArgon2AbortReporter();
    vi.advanceTimersByTime(sem.ABORT_REPORT_INTERVAL_MS);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toMatchObject({
      event: 'argon2_abort_summary',
      count: 3,
    });
  } finally {
    sem.stopArgon2AbortReporter();
    vi.useRealTimers();
    infoSpy.mockRestore();
  }
});
```

### Bonus: deterministic microtask-ordering for race tests

Adjacent pattern from the same test file (the slot-grant race test at `backend/tests/lib/argon2-semaphore.test.ts:~682`): when testing rare race conditions between two abort paths, use `queueMicrotask(() => bAbort.abort())` AFTER `a.resolve(1)` to deterministically interleave the two paths in V8 microtask order. Without the explicit microtask ordering, the race fires unpredictably and assertions flake.

```ts
// Force both abort paths to fire for the same logical abort event
a.resolve(1);                                        // M1: A's await fn() continuation
queueMicrotask(() => bAbort.abort());                // M2: abort dispatched after M1's finally schedules M3
                                                     // M3: B's continuation, sees signal.aborted=true
```

Counter-increment assertions then deterministically detect the dedupe contract (1 abort = 1 increment, even when both paths run).

## Related

- `agents/docs/tasks/pending/backend-argon2-abort-observability.md` — task that motivated the pattern; round-1 hold-block exchange documents the architect-side rationale.
- `backend/tests/lib/argon2-semaphore.test.ts` — canonical implementation site (`describe('periodic abort-summary reporter')` block + the slot-grant race test).
- `backend/src/lib/argon2-semaphore.ts` — production module the tests cover (`reportArgon2Aborts`, `startArgon2AbortReporter`, `stopArgon2AbortReporter`, `abortLastReportedCount` module-private state).
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — companion convention; the periodic-reporter tests built with this pattern must still satisfy mutation-soundness (revert each load-bearing line and confirm the matching test fails).
- Commit `aeef5f2` (round-1 hold-fix) — the implementing commit where the pattern landed.

## Residual fragility

The orphaned-interval risk: if a test fails before its `finally` runs, `stopArgon2AbortReporter()` is not called on the failing test's module instance. The interval keeps running on the OLD module instance against the OLD logger spy (which has been `mockRestore()`'d). `.unref()` on the timer prevents process-hang, but the orphan is still emitting. Vitest's worker-pool isolation handles this today; if a future vitest version changes how `vi.resetModules` interacts with module caches across workers, the orphan could become observable. Mitigated for now; revisit if vitest pool-config drift surfaces it.

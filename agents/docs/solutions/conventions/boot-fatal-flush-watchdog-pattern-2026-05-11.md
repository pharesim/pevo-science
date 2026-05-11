---
title: "Boot-fatal `logger.flush + setTimeout watchdog` async-transport-drain pattern"
date: 2026-05-11
category: conventions
module: backend/src/lib/flush-and-exit.ts
problem_type: convention
component: logging
severity: high
applies_when:
  - "Calling `process.exit(1)` immediately after `logger.fatal(...)` or any pino-logger call"
  - "Pino is configured with the default async transport (sonic-boom in prod, thread-stream in dev) — i.e., the destination is NOT a synchronous write to fd 1/2"
  - "The fatal log line MUST reach operators — a silent exit with no observable log is treated as a defect (single-instance availability, no replicated logging)"
  - "A flush callback hang is a realistic failure mode (back-pressured stdout, wedged worker thread, broken transport, container shutdown grace-period race)"
  - "Existing code uses the `flush + process.exit(1)` shape without a timeout — that pattern needs migration"
tags:
  - boot-fatal
  - pino
  - async-transport
  - flush
  - watchdog
  - drain-or-die
  - process-exit
---

# Boot-fatal `logger.flush + setTimeout watchdog` async-transport-drain pattern

## Context

`BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` round-3 (commit `1a7a3bb`) introduced `logger.fatal(...); logger.flush(() => process.exit(1));` at five boot-fatal sites to replace bare `logger.fatal(...); process.exit(1);`. The motivation was pino's async transport: `process.exit(1)` immediately tears down the runtime including the worker thread before the buffered fatal line drains, so the operator never sees the reason the process died.

Round-3's flush-and-exit shape closed that defect — but introduced a new one. Pino's `flush(cb)` has no built-in timeout. A back-pressured stdout, a wedged worker thread, or any condition that prevents drain leaves `cb` un-fired and `process.exit(1)` never reached. Hung-flush → hung process → no fatal log AND no exit.

Round-4 hold #1 added the 2s `setTimeout` watchdog: the watchdog timer fires `process.exit(1)` even if the flush callback never does. Whichever path fires first wins. Round-4 also extracted the shape to its own module (`backend/src/lib/flush-and-exit.ts`) so the boot path AND the unit-test canary share the exact same implementation.

## Guidance

Use `flushAndExit()` from `backend/src/lib/flush-and-exit.ts` at every boot-fatal and runtime-fatal exit site. Never call `process.exit(1)` directly after `logger.fatal(...)`.

```ts
// backend/src/lib/flush-and-exit.ts
import { logger } from '../logger.js';

/**
 * Boot-fatal flush + watchdog exit.
 *
 * Schedules a 2s watchdog timer (unref'd) and calls logger.flush(...).
 * Whichever fires first triggers process.exit(1). The watchdog ensures the
 * process exits even if the flush callback hangs (back-pressured stdout,
 * wedged worker thread, drain failure).
 *
 * The watchdog renders any defensive `typeof logger.flush === 'function'`
 * guard redundant — if logger.flush is missing or non-function, the
 * unconditional call throws synchronously, escapes flushAndExit, and the 2s
 * timer still fires process.exit(1).
 */
export function flushAndExit(): void {
  const exitTimer = setTimeout(() => process.exit(1), 2000);
  exitTimer.unref();
  logger.flush(() => {
    clearTimeout(exitTimer);
    process.exit(1);
  });
}
```

Three properties matter:

### 1. Unref the watchdog timer

`exitTimer.unref()` ensures the timer does NOT keep the event loop alive on its own. If the flush callback fires first and calls `process.exit(1)`, the unref'd timer is collected with the rest of the process. Without `unref()`, the timer holds the loop open until it fires — undesirable for the test-fixture path that needs to assert the watchdog by advancing fake timers.

### 2. Clear the timer on flush-callback success

`clearTimeout(exitTimer)` inside the flush callback prevents a stale `process.exit(1)` from firing a second time (idempotent, but produces noise) AND lets the test fixture assert "flush won the race, watchdog did NOT fire."

### 3. Unconditional `logger.flush(...)` call (no defensive `typeof === 'function'` guard)

The watchdog renders the defensive guard redundant. If `logger.flush` is somehow missing or non-function (test mock, future refactor, broken init), the unconditional call throws synchronously, escapes `flushAndExit`, and the watchdog still fires `process.exit(1)` at 2s. Adding the guard would mask the missing-flush bug AND add a code path the test fixture would have to exercise.

If a pre-existing call site uses the `if (typeof logger.flush === 'function')` guard with a bare-`process.exit(1)` else-branch (the round-3 `routes/auth.ts:175-193` shape), migrate it to `flushAndExit()` rather than preserving the guard. The convergence task is `backend-flush-and-exit-auth-converge.md`.

## Why This Matters

- **Single-instance availability:** PEvO runs one Node process. A silent exit with no fatal log is an outage with zero operator visibility — the operator has to diff logs against `systemctl status` to detect that boot stopped.
- **Async-transport correctness:** pino's default destination is async. The buffered fatal-line takes one event-loop tick (or more, under load) to drain. `process.exit(1)` immediately preempts the loop, so the fatal line is lost unless something explicit flushes it.
- **Hang-resistance:** A broken transport (container stdout closed, log shipper crashed, worker thread wedged) is a realistic enough failure mode in production deploys that "drain or die at 2s" beats "drain forever or die never."

## When to Apply

- **Boot-fatal sites** in `backend/src/index.ts`: `validateConfig` failure path, `initBridgePostingKeyCache` parse-divergence path, the outer boot try/catch.
- **Runtime fatal sites**: `process.on('uncaughtException')`, `process.on('unhandledRejection')`.
- **Async-init failure** sites that exit the process: `initAppDb().catch(...)` — any promise-rejection handler at boot scope that drops the process.
- **Future**: any new path that calls `process.exit(1)` after a `logger.fatal(...)` or `logger.error(...)`. The rule of thumb: if you'd want the operator to see WHY the process died, route through `flushAndExit()`.

Do NOT apply to:
- Test-fixture paths where the test owns the exit. Tests use `process.exit` mocks; the watchdog timer becomes a hazard.
- Graceful shutdown handlers (SIGTERM, SIGINT) where the goal is "drain everything, then exit with code 0." Those have their own well-defined drain protocol (close pools, close pino, close HTTP server) and the 2s budget is wrong.
- Any path that wants `process.exit(0)` rather than `process.exit(1)`. `flushAndExit()` is fatal-only.

## Examples

### Before (round-3 — flush without watchdog)

```ts
// backend/src/startup-checks.ts (pre-round-4)
logger.fatal({ /* ... */ }, 'Required config missing');
logger.flush(() => process.exit(1));
return;
```

Defects:
- Hung flush hangs the process.
- The `return` after the flush call returns SYNCHRONOUSLY to module-evaluation, so `createApp()` + `initAppDb()` migrations run on misconfigured boot while the fatal line drains.

### After (round-4 + round-5/6 canonical shape)

```ts
// backend/src/startup-checks.ts
export class BootFatalError extends Error {
  readonly type = 'BootFatalError';
}

export function validateConfig(): void {
  if (/* required missing */) {
    logger.fatal({ /* ... */ }, 'Required config missing');
    throw new BootFatalError('validateConfig: required configuration missing');
  }
}

// backend/src/index.ts (module-evaluation scope)
try {
  validateConfig();
  app = createApp();
} catch (err) {
  if (!(err instanceof BootFatalError)) {
    logger.fatal({ err }, 'Boot failed — unexpected throw during startup');
  }
  flushAndExit();
}
```

The structured-throw shape (BootFatalError) routes the boot-fatal out through the outer catch BEFORE any post-validate boot code runs. `flushAndExit()` is the single watchdog-protected exit. The `instanceof` guard suppresses redundant fatal logs on the expected path (the boot-fatal site already logged before throwing).

This pattern composes with the call-stack-unwind + catch-rethrow trap pattern; see the dedicated compound entry on that for the surrounding boot-stack story.

### Unit-test canary that mutation-kills the watchdog

```ts
// backend/tests/lib/flush-and-exit.test.ts
import { flushAndExit } from '../../src/lib/flush-and-exit.js';

it('hung flush: watchdog setTimeout fires within ~2s', () => {
  vi.useFakeTimers();
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  const flushSpy = vi.spyOn(logger, 'flush').mockImplementation((/* never invokes cb */) => {});

  flushAndExit();
  expect(() => vi.advanceTimersByTime(2100)).toThrow(/process\.exit\(1\)/);
});

it('happy path: flush callback fires → watchdog cleared', () => {
  // ... mock flush to invoke its callback synchronously, assert process.exit(1)
  //     fires once and the watchdog timer is cleared so it can't double-fire
});
```

Reverting the watchdog (`setTimeout` + `unref` + `clearTimeout`) turns the hung-flush canary red. Reverting `clearTimeout(exitTimer)` turns the happy-path canary red. Mutation-kill is intentional — these are the canaries that catch a future maintainer "simplifying" `flushAndExit` back to a bare flush.

## Related

- `agents/docs/solutions/conventions/validate-once-cache-secret-pattern-2026-05-11.md` — the boot-fatal CONSUMER pattern that this `flushAndExit` shape supports.
- `agents/docs/solutions/conventions/pino-spy-serializer-ordering-trap-2026-05-06.md` — the logger wrapper pattern that exposes `logger.flush` as a passthrough to pino's base logger.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — mutation-kill discipline for the watchdog canaries.
- `backend/src/lib/flush-and-exit.ts` — canonical implementation.
- `backend/tests/lib/flush-and-exit.test.ts` — mutation-kill canaries.
- `agents/docs/tasks-archive.md` — `BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` archive entry; round-3 introduced the bare flush, round-4 added the watchdog + module extraction.

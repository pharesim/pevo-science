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
 *
 * Used at every boot-fatal and runtime-fatal exit site in index.ts. Any new
 * path that needs to exit the process with a flushed fatal log MUST go
 * through this helper rather than a bare process.exit(1).
 *
 * Extracted to its own module (a) so the boot path AND the unit-test canary
 * share the exact same implementation, and (b) so the watchdog shape is
 * mutation-killable at the function-call layer (see
 * `tests/lib/flush-and-exit.test.ts`).
 */
export function flushAndExit(): void {
  const exitTimer = setTimeout(() => process.exit(1), 2000);
  exitTimer.unref();
  logger.flush(() => {
    clearTimeout(exitTimer);
    process.exit(1);
  });
}

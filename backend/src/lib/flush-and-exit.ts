import { logger } from '../logger.js';

/**
 * Round-4 hold #1 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
 * boot-fatal flush+exit watchdog.
 *
 * pino's destination transport is async by default. `process.exit(1)` on
 * the next tick after `logger.fatal(...)` tears down the runtime (including
 * the pino worker thread) before the buffered fatal line drains, so
 * operators see a silent crash with no log evidence. Round-3 wrapped the
 * boot-fatal sites in `logger.flush(() => process.exit(1))`, but pino's
 * flush callback has no built-in timeout: a back-pressured stdout, wedged
 * worker thread, or any condition that prevents drain leaves the callback
 * unfired and `process.exit(1)` never reached. Mirror the proven pattern
 * at `routes/auth.ts:175-193` — flush + 2s `setTimeout` watchdog with
 * `.unref()` so a wedged transport cannot hang the boot indefinitely.
 * Whichever fires first wins; `clearTimeout` inside the flush callback
 * keeps the timer benign on the happy path.
 *
 * Extracted to its own module (a) so the boot path AND the unit-test
 * canary share the exact same implementation, and (b) so the watchdog
 * shape is mutation-killable at the function-call layer (see
 * `tests/lib/flush-and-exit.test.ts`).
 *
 * Used by:
 *   - `src/index.ts` boot-path try/catch + uncaughtException /
 *     unhandledRejection / initAppDb-failure handlers.
 *   - `src/startup-checks.ts` (indirectly — it throws `BootFatalError` and
 *     `index.ts` catches and routes through this helper).
 */
export function flushAndExit(): void {
  const exitTimer = setTimeout(() => process.exit(1), 2000);
  exitTimer.unref();
  logger.flush(() => {
    clearTimeout(exitTimer);
    process.exit(1);
  });
}

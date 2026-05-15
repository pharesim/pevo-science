/**
 * Tests for `src/lib/flush-and-exit.ts` — the boot-fatal watchdog helper.
 *
 * Round-4 hold #1 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
 * pino's `flush(cb)` callback can fail to fire (back-pressured stdout,
 * wedged worker thread). Round-3 wrapped boot-fatal sites in
 * `logger.flush(() => process.exit(1))` but offered no fallback if the
 * callback never fired — `process.exit(1)` would never be reached and the
 * boot would hang indefinitely with the misconfigured runtime alive.
 * Round-4 adds a 2s `setTimeout` watchdog around the flush.
 *
 * Mocking justification (per `agents/docs/solutions/conventions/test-mock-
 * carve-out-clause-c-2026-05-04.md`): exercising the real flush-then-exit
 * path per-test is impossible in vitest — `process.exit(1)` would terminate
 * the test runner. The helper's contract is timing-only (flush callback OR
 * 2s timer wins, whichever fires first); both branches are testable via
 * (a) mocking `logger.flush` to never invoke its callback so the watchdog
 * timer wins, and (b) mocking `process.exit` to throw a recognizable
 * sentinel so the test can assert which branch fired without leaving the
 * runtime. The risk class — "watchdog timer fails to fire when flush
 * callback hangs" — is covered ONLY by the timer-wins case here; no
 * real-path companion exists because the failure mode IS the timer
 * mechanism. Both branches of `flushAndExit()` (watchdog-wins and
 * callback-wins) are covered by the mock-based tests below; the
 * callback-wins case asserts both that `process.exit(1)` is reached AND
 * that `clearTimeout` neutralizes the watchdog so it can't double-fire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../src/logger.js';
import { flushAndExit } from '../../src/lib/flush-and-exit.js';

describe('flushAndExit — boot-fatal flush+exit watchdog (round-4 hold #1)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    // Replace process.exit with a sentinel-throwing stub so the test can
    // observe whether the timer-fire branch reaches it. The sentinel
    // string identifies which branch fired; both branches throw the
    // same sentinel here because the assertion is on the timing window
    // (deadline ≤ ~2.1s for the watchdog) rather than the call site
    // identity.
    originalExit = process.exit;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      // Throw so the calling stack unwinds — flushAndExit returns void
      // on the production path. The test catches the throw and asserts
      // on the recorded code argument.
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    exitSpy.mockRestore();
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  it('hung flush: watchdog setTimeout fires within ~2s and reaches process.exit(1) (mutation kill: removing the watchdog leaves the boot hung forever)', () => {
    // Mock logger.flush to NEVER invoke its callback. This is the
    // production failure mode the watchdog exists to defend against:
    // back-pressured stdout / wedged pino worker thread / etc.
    const flushSpy = vi.spyOn(logger, 'flush').mockImplementation(() => {
      // Intentionally swallow the callback — never invoke it.
    });

    flushAndExit();

    // Sanity: flush was called (otherwise the test isn't exercising the
    // intended branch).
    expect(flushSpy).toHaveBeenCalledTimes(1);
    // Pre-watchdog: process.exit has NOT yet been called (the timer
    // hasn't fired and the flush callback won't).
    expect(exitSpy).not.toHaveBeenCalled();

    // Advance fake time PAST the 2s watchdog deadline. The setTimeout
    // callback fires synchronously under fake-timers.advanceTimersByTime,
    // calls process.exit(1), and the spy throws our sentinel.
    expect(() => vi.advanceTimersByTime(2100)).toThrow(/process\.exit\(1\)/);

    // process.exit(1) was reached via the watchdog branch.
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);

    // Mutation kill: stripping `setTimeout(() => process.exit(1), 2000)`
    // (or its `.unref()` companion under a different assertion shape)
    // would leave `exitSpy` un-called after the time advance, failing
    // the "called times 1" check above.
    flushSpy.mockRestore();
  });

  it('happy path: flush callback fires → process.exit(1) reached AND watchdog timer cleared so a stale exit doesn\'t double-fire later', () => {
    // The complement: when pino's flush callback DOES fire (the
    // production-normal case), `process.exit(1)` is reached via the
    // callback path, AND `clearTimeout(exitTimer)` neutralizes the
    // watchdog so a deferred timer-fire can't double-call process.exit
    // moments later (a regression that dropped `clearTimeout` would be
    // observable on a slow drain).
    let capturedCb: ((err?: Error | null) => void) | undefined;
    const flushSpy = vi.spyOn(logger, 'flush').mockImplementation((cb) => {
      capturedCb = cb;
    });

    flushAndExit();

    // Invoke the captured flush callback synchronously — simulates a
    // production-fast drain. The callback calls process.exit(1) which
    // the spy turns into our sentinel throw.
    expect(() => capturedCb?.()).toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);

    // Now advance time past 2s — the watchdog's clearTimeout should
    // have neutralized the timer; process.exit must NOT fire again.
    // Mutation kill: dropping `clearTimeout(exitTimer)` from the flush
    // callback would let the timer fire here and exitSpy would be
    // called twice.
    vi.advanceTimersByTime(2500);
    expect(exitSpy).toHaveBeenCalledTimes(1);

    flushSpy.mockRestore();
  });
});

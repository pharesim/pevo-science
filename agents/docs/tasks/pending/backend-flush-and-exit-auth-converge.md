# BACKEND-FLUSH-AND-EXIT-AUTH-CONVERGE — migrate `routes/auth.ts:175-193` to import `flushAndExit`

**Owner:** Backend Agent
**Created:** 2026-05-06 (filed at architect re-review of `backend-bridge-key-startup-validation-and-pino-redact.md` round-4, finding #4 deferred option)
**Priority:** P3

## Problem

The boot-fatal flush + watchdog pattern was extracted to `backend/src/lib/flush-and-exit.ts` in round-4 of `backend-bridge-key-startup-validation-and-pino-redact`. The pattern is also present inline at `backend/src/routes/auth.ts:175-193` (the original site `flush-and-exit.ts` cites as its model). Today there are two maintenance sites for one pattern: the inline auth.ts copy retains a `typeof logger.flush === 'function'` guard and bare-exit fallback that the new helper deliberately omits (the watchdog makes them redundant), but if the watchdog logic ever needs to change, both sites must change in lockstep.

Surfaced by reliability persona at round-4 review, retained as residual risk RR-1.

## Goal

Eliminate the duplicate inline implementation at `routes/auth.ts:175-193` by importing `flushAndExit` from `backend/src/lib/flush-and-exit.ts`. One canonical implementation, one place to maintain.

## Acceptance

1. **Replace inline watchdog at `backend/src/routes/auth.ts:175-193`** with a single call to `flushAndExit()`. The auth.ts site is also a boot-fatal-equivalent shape (config rotation hard-fail) — same intent, same shape.

2. **Verify behavior parity.** The auth.ts inline site has the `typeof logger.flush === 'function'` guard + bare-`process.exit(1)` fallback. The new `flushAndExit` skips both because the watchdog provides the same exit guarantee. Confirm the behavior delta is acceptable for the auth.ts call site (a missing/non-function `logger.flush` would now wait up to 2s for the watchdog rather than exiting immediately) — the auth.ts context is the same shutdown semantics as boot-fatal, so the delta is operationally equivalent.

3. **Existing `routes/auth.ts` tests stay green.** No behavior change expected for the happy-path flush-then-exit; the watchdog only fires if `flush` hangs, which the existing tests don't exercise (they mock `process.exit` to throw a sentinel and run synchronously, same shape `flush-and-exit.test.ts` uses).

4. **Verify.** `npx tsc --noEmit` clean. `npm run lint` no new errors. Existing tests stay green. The `routes/auth.ts:175-193` block's diff should net to roughly `-15 LOC, +1 LOC`.

## Coordination

- Surfaced at round-4 architect review of `backend-bridge-key-startup-validation-and-pino-redact.md`, filed as separate task per architect's round-4-finding-4 triage decision (auth.ts convergence is a stylistic/maintenance dedup, not a redact-policy or boot-fatal correctness fix; defer from the round-5 commit which is already accumulating items).
- No dependency on `backend-bridge-key-startup-validation-and-pino-redact` round-5 closing first. The `flushAndExit` helper has been on `main` since round-4 (`a376503`).
- Reliability persona's residual risk RR-1 from round-4 is closed by this task.

## Out of scope

- The dismissed-at-round-4-review concurrent-`flushAndExit` timer-stacking. If a module-level `alreadyExiting` guard ends up making sense while in `flush-and-exit.ts`, that's a defensible scope expansion; otherwise leave it.
- Refactoring `auth.ts` shutdown semantics beyond the flush+exit block. Stay scoped to `:175-193`.

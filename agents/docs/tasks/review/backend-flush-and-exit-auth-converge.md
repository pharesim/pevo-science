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

## Backend completion signal (2026-05-06, main-tree SHA `084d9ee`)

**Diff stats:** `backend/src/routes/auth.ts | 26 +++++++-------------------` → `1 file changed, 7 insertions(+), 19 deletions(-)`. Net `-12 LOC`. The +7 is 1 line of import (`import { flushAndExit } from '../lib/flush-and-exit.js';`) plus a 6-line comment block that points the reader at `src/lib/flush-and-exit.ts` for the rationale. The -19 is the inline `setTimeout`/`logger.flush` block at the original `:175-193` and its 8-line preamble comment. Acceptance #4 cited "roughly `-15 LOC, +1 LOC`"; actual `-19/+7` is within that envelope (the +7 keeps a callsite-local breadcrumb comment rather than a bare 1-liner; same shape, slightly more in-place context).

**Verification gates:**
- `npx tsc --noEmit` from `backend/`: clean (zero output, exit 0).
- `npm run lint` from `backend/`: clean for changed file. Two pre-existing warnings on `seed-phrase.ts:26-27` (`@typescript-eslint/no-explicit-any`) remain, called out as out of scope in the dispatch.
- `npx vitest run tests/routes/auth.test.ts tests/lib/flush-and-exit.test.ts`: 2 files passed, 22 passed / 1 skipped / 0 failed in 38.88s. The skipped test is pre-existing (`flush-and-exit.test.ts` skips the real-flush integration assertion per the test-mock carve-out); not introduced by this change.
- Two adjacent auth-route test files (`auth-signup-dup-saturated.test.ts`, `auth-signup-argon-error-translation.test.ts`) fail identically on the clean baseline (verified via `git stash` + re-run). Failures are pre-existing and unrelated to the `:175-193` swap; the parent agent's full-suite pass owns full-tree triage. Auth-related tests that DO run cleanly today (auth.test.ts, auth-log-shape, auth-concurrency, auth-argon-error-translation, auth-reset-request-shutdown, auth-smtp-transporter, flush-and-exit) all pass with this change.

**Behavior delta confirmation (acceptance #2):** the `typeof logger.flush === 'function'` guard + bare-exit fallback are gone. A pino runtime that exposes no `flush` method would now hit the watchdog's 2s timeout before `process.exit(1)`, rather than exiting on the next tick. The auth.ts call site is the boot-fatal-equivalent shape (sentinel-hash rejection → process must die fast); the +2s upper bound on a corrupt-pino edge case is operationally equivalent to the old immediate-exit. Architect re-review is invited to confirm.

**Deviations from acceptance:** none. Inline at `:175-193`, no scope creep into shutdown semantics or the dismissed timer-stacking guard.

# Argon2 drain singleton — runtime guard against test-context misuse

**Owner:** Backend Agent
**Created:** 2026-04-28 (surfaced by `/ce-code-review` of `backend-argon2-jslevel-concurrency-cap.md` round-3 — adversarial + reliability + maintainability)
**Priority:** P3

## Problem

`backend/src/lib/argon2-semaphore.ts:333` exports `drainArgon2Queue()` at the module level. The closure-private `shuttingDown` flag is **irreversible** — once set, the singleton stays drained for the rest of the process lifetime. The round-3 hold added a docblock warning tests not to import the module-level wrapper (use `createArgon2Semaphore()` for DI instead), but nothing enforces this at runtime.

Failure mode: a test that imports `drainArgon2Queue` from the module level (e.g., to exercise drain semantics directly without DI) poisons the singleton. Every subsequent test in the same Vitest worker that touches `runWithArgon2Slot` via the module-level wrapper sees `ShuttingDownError` thrown at slot acquisition. Latent because tests today consistently use the DI factory; one carelessly-written future test can break the entire worker's downstream test set.

## Acceptance criteria

Add a runtime guard to `drainArgon2Queue()` that detects test contexts and throws (or no-ops with a `logger.warn`) instead of permanently draining.

Two implementation shapes:

1. **NODE_ENV / VITEST detect** — `if (process.env.VITEST || process.env.NODE_ENV === 'test') { logger.warn('drainArgon2Queue called from test context — ignored. Use createArgon2Semaphore() for DI.'); return; }` at the top of `drainArgon2Queue()`. Consistent with the existing `process.env.VITEST` gate at `auth.ts:153-160` for the UV_THREADPOOL_SIZE assertion.
2. **Explicit semaphore-handle parameter** — refactor `drainArgon2Queue()` to take a semaphore instance: `drainArgon2Queue(semaphore: Semaphore)`. The module-level export becomes `drainArgon2Queue(defaultSemaphore)`. Tests that import the function directly must supply their own semaphore; can't accidentally drain the singleton. Larger refactor.

Pick (1) for minimal blast radius; (2) is cleaner long-term but doesn't justify the diff alone.

Also add a unit test in `tests/lib/argon2-semaphore.test.ts`:
- Set `process.env.VITEST = '1'` (already set by Vitest config — verify) and call the module-level `drainArgon2Queue()`.
- Assert the singleton's `getArgon2InFlight()` doesn't go to "shutting-down" state (or whatever observable the guard surfaces).
- Assert a `logger.warn` was emitted (use a logger mock or transport spy).

## Out of scope

- Refactoring the entire semaphore module to remove module-level singleton state. The singleton is intentional for production (one cap per backend process).
- Adding the same guard to other singleton-state functions (none currently exist with the same irreversibility property — this is the only one).

## Why now

Defensive: the docblock warning is convention-only. A test author reading the code without seeing the docblock can poison the worker. The guard makes the error mode loud at the call site instead of silent for the rest of the test run.

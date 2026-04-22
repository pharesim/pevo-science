# BE-ARGON2-SEMAPHORE-SHUTDOWN-DRAIN — Add drainArgon2Queue() for graceful SIGTERM handling

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-ARGON2-JSLEVEL-CONCURRENCY-CAP first-review)
**Priority:** P2

## Context

`BE-ARGON2-JSLEVEL-CONCURRENCY-CAP` added a Promise-queue semaphore capping concurrent argon2 ops. Queued waiters sit at `await new Promise<void>((resolve) => waiters.push(resolve))` in `backend/src/lib/argon2-semaphore.ts:~86`. On SIGTERM, `index.ts` calls `server.close()` with a 30s force-timeout then `process.exit(0)`.

Reliability review (0.95 confidence) identified: any caller waiting in the queue when `process.exit(0)` fires has its `resolve()` never called. Its route handler never returns, Express never sends a response, client gets an abrupt socket close instead of a 503.

## Goal

Export a `drainArgon2Queue()` function that rejects all pending waiters with a `ShuttingDownError`. Call it from `shutdown()` in `index.ts` before `server.close()`. Route handlers catch the rejection and send 503 SERVICE_UNAVAILABLE, letting Express close connections cleanly within the 30s window.

## Non-goals

- Draining with a per-request deadline inside the 30s window. If a handler is already past the semaphore and mid-argon2, let it finish.
- Disabling the semaphore under load. The cap continues to apply until the process exits.
- Changing the 30s force-timeout on `server.close()`.

## Acceptance

- `drainArgon2Queue()` exported from `argon2-semaphore.ts` — iterates `waiters`, rejects each with `new ShuttingDownError()`.
- `shutting_down` module-level flag: after drain, any new `runWithArgon2Slot` call immediately throws `ShuttingDownError` without queueing.
- `index.ts shutdown()` awaits `drainArgon2Queue()` before `server.close()`.
- Auth route handlers (`auth.ts`, `signup-verify.ts`, `custody.ts`) catch `ShuttingDownError` and return 503 with `error.code: 'SERVICE_UNAVAILABLE'`.
- One test that starts a burst, triggers `shutdown()` while waiters are pending, asserts either a clean 503 response or bounded exit time.

## [TODO Architect]

None — self-contained reliability fix.

---

**Backend re-review signal (2026-04-22, worktree agent-a9077c7e):**

Implementation landed. Changes:

- `backend/src/lib/argon2-semaphore.ts`: added `ShuttingDownError`, `drainArgon2Queue()` (method on `Argon2Semaphore` + module-level convenience wrapping the singleton), `shuttingDown` flag. Waiters now carry `{ resolve, reject }` so drain can synchronously reject pending callers with `ShuttingDownError`. Post-drain `runWithArgon2Slot` throws `ShuttingDownError` immediately without queueing. Drain does NOT interrupt in-flight argon2 operations.
- `backend/src/index.ts`: `shutdown()` calls `drainArgon2Queue()` before `server.close()` so Express can flush 503 responses inside the 30s force-timeout window instead of hanging waiters.
- `backend/src/routes/auth.ts`: `handleArgonQueueFull` now also catches `ShuttingDownError` and returns 503 `SERVICE_UNAVAILABLE`. Distinct log message per error kind (`warn` on queue saturation, `info` on shutdown) so operators can separate "increase capacity" from "benign rolling restart". `burnSentinel` re-throws `ShuttingDownError` in addition to `ArgonQueueFullError` to preserve the timing-oracle property under drain.
- `backend/src/routes/signup-verify.ts`, `backend/src/routes/custody.ts`, `backend/src/routes/settings.ts`: matching 503 catch branch for `ShuttingDownError`, same distinct-log-message convention.
- `backend/tests/lib/argon2-semaphore.test.ts`: extended with 4 new tests covering drain-rejects-waiters, post-drain-new-call-rejects, idempotency, and bounded-time integration (503-equivalent payload propagates to simulated handlers in <1000ms).

Preserved the existing silent-swallow-and-log on the 409 dup-signup burn paths (`auth.ts:401,407`). Those swallow `ArgonQueueFullError` today for timing-oracle equalization, and they continue to swallow `ShuttingDownError` for the same reason — the handler still returns a fast, clean 409 rather than hanging, so the drain goal (no waiters stuck at `server.close()`) holds.

Tests run (all green):
- `tests/lib/argon2-semaphore.test.ts` (13 tests: 10 existing + 3 new drain tests + bounded-time integration).
- `tests/routes/auth.test.ts` (20), `tests/routes/settings.test.ts` (15), `tests/routes/signup-verify.test.ts` (5), `tests/routes/custody.test.ts` (2), `tests/routes/auth-concurrency.test.ts` (2), `tests/routes/settings-set-password.test.ts` (7) — each passes in isolation. Batch runs show pre-existing 429 rate-limit cross-test interference unrelated to this task.
- `npx tsc --noEmit`: clean.
- `npm run lint`: 2 pre-existing warnings in `seed-phrase.ts`, no new issues.

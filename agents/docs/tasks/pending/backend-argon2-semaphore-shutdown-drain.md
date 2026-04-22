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

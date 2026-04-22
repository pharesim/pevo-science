# BE-ARGON2-SEMAPHORE-ABORT-SIGNAL — AbortSignal threading to skip argon2 on dropped client connections

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-ARGON2-JSLEVEL-CONCURRENCY-CAP first-review)
**Priority:** P2

## Context

`BE-ARGON2-JSLEVEL-CONCURRENCY-CAP` added a Promise-queue semaphore capping concurrent argon2 ops. Node.js does not cancel in-flight async route handlers when a client drops its TCP connection — Express keeps the handler running.

Reliability review (0.90 confidence) identified: a waiter stuck in the semaphore queue after its client disconnects will eventually have `resolve()` called (when a slot frees), increment `inFlight`, and run the full argon2 operation against a dead connection. The slot is released correctly afterward (no permanent counter leak), but under sustained client-abort storms this keeps the semaphore artificially saturated: one live slot consumed per dead waiter until each finishes its ~50ms argon2 call.

## Goal

Thread `req.aborted` or an `AbortSignal` through `runWithArgon2Slot` so the semaphore can skip `fn()` and release the slot immediately when the signal is aborted at slot-grant time.

## Options

- **A. New parameter:** `runWithArgon2Slot(fn, { signal })`. If `signal.aborted` when slot is granted, throw `AbortError` before running `fn()`. Route handlers pass `req.signal` or `AbortSignal.timeout(...)`. Least-invasive but requires every call site update.
- **B. Check req.aborted inside runWithArgon2Slot:** Pull the signal from a per-request async-local store (node's `AsyncLocalStorage`). Zero call-site changes but adds store management + one `AsyncLocalStorage` context lookup per call.

Lean Option A for explicitness; B if Option A's call-site churn is unacceptable.

## Non-goals

- Cancelling an in-flight argon2 operation. argon2 is native, not AbortSignal-aware; once `argon2.verify` is running we let it finish.
- Rejecting queued waiters on shutdown (covered by `backend-argon2-semaphore-shutdown-drain.md`).
- Adding request-level timeouts. Distinct concern from client-abort.

## Acceptance

- `runWithArgon2Slot` accepts an `AbortSignal` (Option A) or reads from AsyncLocalStorage (Option B).
- At slot-grant time: if aborted, throw `AbortError` before `fn()`, release the slot, drain the next waiter.
- All auth call sites in `auth.ts`, `signup-verify.ts`, `custody.ts`, `settings.ts` (once `backend-argon2-jslevel-concurrency-cap` round-2 has added settings.ts) pass the request signal.
- One test that queues callers beyond `MAX_CONCURRENT_ARGON2_OPS`, aborts one before its slot is granted, asserts argon2 was not called AND the slot was released cleanly AND the next waiter proceeded.

## [TODO Architect]

- Decide Option A vs B. Lean A.

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

## Backend re-review signal (2026-04-22, worktree agent-a381cfde):

Implemented Option A per architect's lean.

**Semaphore (`backend/src/lib/argon2-semaphore.ts`):**
- New exported `ArgonAbortError` (name = `'AbortError'`, matching the `DOMException('…', 'AbortError')` convention) and `RunWithArgon2SlotOptions` interface.
- `runWithArgon2Slot(fn, options?)` now accepts `{ signal?: AbortSignal }`.
- Three checkpoints:
  1. Pre-queue: `signal.aborted` at entry → throw `ArgonAbortError` before touching counters / queue state.
  2. While parked: `signal`'s `abort` event listener splices the exact waiter object out of `waiters[]` and rejects its Promise with `ArgonAbortError`. Removing from the queue prevents a later slot-release from `shift`-ing a dead waiter.
  3. At slot-grant: race guard — if the slot was granted just before the abort listener fired, skip `fn()`, release the slot to the next waiter, throw `ArgonAbortError`.
- Abort listener registered with `{ once: true }` and explicitly removed in the `finally` block to avoid listener leaks on the happy path.
- Waiter shape upgraded from `Array<() => void>` pair-tuple to `type Waiter = { resolve; reject }` with a closure-scoped `waiter` variable so the abort handler can locate the exact entry via `indexOf` (array identity, not value match).

**Call sites:**
- `backend/src/routes/auth.ts`: added module-local `requestAbortSignal(req, res)` helper (Node 20 / Express 5 don't expose `req.signal` natively — adds fallback via `req.once('close')` gated by `!res.writableEnded`). Threaded `{ signal }` through every `runWithArgon2Slot` call and `burnSentinel` call in `/signup`, `/resend-verification`, `/login`, `/reset-request`, `/reset`, `/recover`. `burnSentinel` signature extended: `burnSentinel(input, signal?)`. Expanded `handleArgonQueueFull` to also swallow `ArgonAbortError` → log at `debug` and return `true` so the shared catch doesn't fall through to `sendError(500)` on a torn-down socket. Also extended burnSentinel's internal catch to re-throw `ArgonAbortError` (matching the existing `ArgonQueueFullError`/`ShuttingDownError` propagation policy) so an abort during a sentinel burn doesn't get swallowed and reopen the timing oracle.
- `backend/src/routes/signup-verify.ts`, `backend/src/routes/custody.ts`, `backend/src/routes/settings.ts`: same `requestAbortSignal` helper copied into each file (no shared new file per the file-list scope), threaded through their `runWithArgon2Slot` / `burnSentinel` calls. Each route's existing `catch` block now recognizes `ArgonAbortError` as a silent-return case (debug log, no `sendError`).

**Test (`backend/tests/lib/argon2-semaphore.test.ts`):**
- New `describe('AbortSignal — drop queued waiters on client disconnect')` block with two cases:
  1. cap=1, A holds the slot, B queues with an `AbortController.signal`, C queues after B. Aborting B asserts: (a) B's fn `callCount === 0`, (b) B rejects with `ArgonAbortError` where `err.name === 'AbortError'`, (c) `queueDepth` decrements cleanly, (d) when A resolves, C (not a ghost B) gets the slot and proceeds.
  2. Already-aborted signal short-circuits: no queue state mutated, `inFlight === 0`, `queueDepth === 0`, fn never called.

**Local verification:** `npx tsc --noEmit` clean. `npm run lint` clean (2 pre-existing `any` warnings in `seed-phrase.ts`, unchanged). Tests: `tests/lib/argon2-semaphore.test.ts` (15/15), plus full run of `tests/routes/{auth,auth-concurrency,custody,signup-verify,settings-set-password,settings,recover}.test.ts` (96/96) against real HAF + Redis/Postgres via Docker network IPs.

---

**Architect re-review (2026-04-28) — HELD PENDING FIXES:**

Cluster A `/ce-code-review` on commit `3dcc30d` ran 10 personas. Two items survive triage; the rest are dismissed (note: many findings cited HEAD-only state — `requestAbortSignal` consolidation, `handleArgonError` extract, `ArgonAbortError extends ArgonSemaphoreError` — all already done in sibling tasks). Cross-reviewer convergence on item 1.

1. **P2 — Slot-grant race-guard (checkpoint 3) lacks direct test coverage** (correctness 0.70, testing 0.85, reliability inferred, kieran-typescript inferred → cross-reviewer convergence anchor 100). The 3-checkpoint AbortSignal scheme has tests for checkpoints 1 (already-aborted short-circuit) and 2 (parked-waiter abort listener), but checkpoint 3 (slot-grant race: signal aborts after `next.resolve()` but before B's awaiter wakes) is unreachable from the current tests because `bAbort.abort()` fires synchronously while B is still parked, so the abort listener splice always wins. A regression that omitted the secondary `waiters.shift()` at line 280 would stall the next live waiter forever — no test would catch it. Fix: add a third test case that constructs the resolve-then-abort race. Reachable patterns: (a) use a custom AbortSignal-like object whose `dispatchEvent('abort')` is fired manually after the underlying flag is set, OR (b) schedule abort inside a `Promise.resolve().then(...)` between `a.resolve()` and the microtask flush. Test must assert: `bFn.callCount === 0`, B rejected with `ArgonAbortError`, the next live waiter (C) gets the slot, `getArgon2InFlight()` and `getArgon2QueueDepth()` invariants hold.

2. **P3 — `waiters.indexOf(waiter)` identity-match is load-bearing but uncommented** (reliability conf 75). The abort listener splices via reference-equality `indexOf` on the closure-captured `waiter` object. A future refactor swapping `waiters[]` from `Array<Waiter>` to a ring buffer or any structure that copies elements would silently break the splice (`indexOf` returns -1, `splice(-1, 1)` removes the last element instead). Documented as a class of failure in `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`, but the convention store relies on future searchers finding it. Fix: add a one-line comment on the `waiters` declaration:

   ```ts
   // waiters[] holds Waiter object references by identity; the abort listener at
   // line ~255 uses indexOf reference-equality to splice. Any refactor to a
   // ring-buffer / value-copy queue MUST update the abort path — silent miss
   // otherwise (indexOf returns -1, splice(-1, 1) removes the wrong element).
   const waiters: Waiter[] = [];
   ```

**Architect triage notes (cluster A, 2026-04-28):**

- **Task narrative drift vs HEAD**: signal block claims `requestAbortSignal` is duplicated per-file and listener uses `{once: true}`. HEAD has `requestAbortSignal` consolidated into `backend/src/lib/request-abort-signal.ts`, listener uses plain `addEventListener` + explicit `removeEventListener` in `finally`. These were addressed by `backend-argon2-error-handler-extract.md` and surrounding cluster work; no fix needed against this task. Doc-only correction during eventual archive.
- **`ArgonAbortError extends Error` rather than `ArgonSemaphoreError`** (kieran-typescript K-1 conf 75): Already fixed at HEAD; the `ArgonSemaphoreError` abstract base + extends relationship was introduced by the round-3 cluster fix (commit `0ecc621`). Dismissed.
- **Aborted requests log only at `debug`** (agent-native conf 90): Real ops concern, but not specific to this task. Filed as new pending task `backend-argon2-abort-observability.md` (P2). Decoupled from this task's hold cycle.
- **Aborted burnSentinel pre-queue ~0ms cost** (agent-native conf 75): Dismissed. Rate limiter is the primary defense; per-attempt argon2 cost is supplementary; exploit window (sub-ms between handler entry and slot grant) is impractical to land reliably.

**Path to re-archive:** (1) Backend adds checkpoint-3 test (item 1) + `waiters[]` identity comment (item 2). (2) Backend re-review signal block below the hold. (3) Architect re-runs `/ce-code-review` scoped to the round-2 commit; archives on clean.

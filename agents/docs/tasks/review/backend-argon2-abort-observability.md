# BE-ARGON2-ABORT-OBSERVABILITY — Make `ArgonAbortError` events visible to operators at default `LOG_LEVEL`

**Owner:** backend
**Created:** 2026-04-28 (surfaced by cluster A `/ce-code-review` of `backend-argon2-semaphore-abort-signal.md`, agent-native persona reframed as ops observability per root `CLAUDE.md` "API Consumer Surface")
**Priority:** P2

## Problem

`backend-argon2-semaphore-abort-signal.md` (commit `3dcc30d`) added silent-return-on-abort to four route handlers (`auth.ts`, `custody.ts`, `settings.ts`, `signup-verify.ts`). When a client disconnects during an argon2 op, the handler emits no HTTP response (the socket is gone) and logs at `debug` tier:

```ts
logger.debug({ err }, 'argon2 slot aborted by client disconnect — no response to write');
```

`backend/src/logger.ts:20`: `const level = process.env.LOG_LEVEL || 'info';`. `backend/.env.example:116`: documented default `LOG_LEVEL=info`. **Under default config, every abort event produces zero log lines.**

`pino-http`'s access-log middleware fires on `res.finish`, which never fires when the handler returns silently. So aborted requests leave **zero trace** under default config:
- No `debug` line (level too low).
- No `pino-http` access log (no `res.finish`).
- No 4xx/5xx in any operator dashboard built on access logs.

Operational consequences:
- A burst of client-disconnect aborts during a network event or attacker-driven connection-cycling scenario generates no operator signal whatsoever.
- An automated incident-correlator watching the log stream at default level cannot distinguish "many aborts" from "no auth traffic at all."
- Combined with the documented `burnSentinel` pre-queue ~0ms cost path, an attacker-driven flood of abort-after-body-upload requests would be invisible AND cheap.

## Goal

Restore operator visibility into abort events under default `LOG_LEVEL` without flooding logs during normal disconnect traffic (mobile clients on flaky connections produce a steady baseline of legitimate aborts).

## Options

The right shape requires a small design choice:

### Option A: Counter-based ops signal (recommended)

Expose an in-process counter on the argon2 semaphore module:
- `getArgon2AbortCount()` — synchronous read of cumulative aborts since process start.
- Increment in the abort listener and the slot-grant race-guard inside `argon2-semaphore.ts`.
- Surface via a dedicated internal admin endpoint (firewall-restricted, NOT `/api/health` per the prior decision to keep recon channels closed). Or surface in periodic logs (e.g., once every 5 minutes if `count > 0`).

**Pros**: Operators see rate without per-event log noise. Easily graphed if the counter ends up in metrics. Aligns with the existing `getArgon2QueueDepth()` / `getArgon2InFlight()` accessors.

**Cons**: Requires picking an exposure surface (admin endpoint or periodic log). Adds new public API to the semaphore module.

### Option B: Elevate log tier with rate limiting

Change the per-event log from `debug` to `info`, but rate-limit emission via a per-process token bucket (e.g., max 10 abort lines per minute, with a "..." summary when suppressed):

```ts
if (abortLogTokenBucket.consume()) {
  logger.info({ event: 'argon2_abort', route: routeLabel }, 'argon2 slot aborted by client disconnect');
}
```

**Pros**: Visible by default. Structured event field (`event: 'argon2_abort'`) makes it easy for log aggregators to count.

**Cons**: Token-bucket plumbing to add. Rate-limit threshold is a magic number. Per-event lines still cost log-storage at scale.

### Option C: Documentation-only (lowest cost)

Update `backend/.env.example` and the relevant route comments to document explicitly that aborts log at `debug` and require `LOG_LEVEL=debug` to see. Add a runbook note in `agents/docs/ARCHITECTURE.md` (or wherever ops guidance lives) saying "if investigating disconnect floods, raise `LOG_LEVEL` to `debug` before reproducing."

**Pros**: Zero code change. Operators investigating already know to raise log level.

**Cons**: Doesn't help automated monitoring; relies on operator knowing the runbook. Loses the proactive-alerting use case.

## Lean (Architect)

**Lean: Option A** with a periodic-log exposure surface (not an admin endpoint, to avoid widening the public surface). Once every 60s, if the counter has incremented since the last emission, log a single line: `logger.info({ event: 'argon2_abort_summary', count: deltaCount }, 'argon2 abort events in the last interval');` — bounded log volume regardless of traffic, structured field for aggregators, no per-event noise.

Implementer may push back if Option B's per-event-but-rate-limited shape fits the team's monitoring pipeline better.

## Acceptance

- A counter (or chosen mechanism) is in place; every abort path (pre-queue, parked-waiter, slot-grant) increments it.
- Operators see abort signal under default `LOG_LEVEL=info` without `LOG_LEVEL=debug` being required.
- Test: simulate N aborts via the existing semaphore unit tests, assert the counter reads N (or the periodic log is emitted with the expected count).
- `.env.example` updated if Option B's rate-limit threshold is configurable.
- ARCHITECTURE.md or runbook updated to describe the operator-visible signal.

## Non-goals

- Changing the per-event `debug` log itself (keep it for `LOG_LEVEL=debug` investigation).
- Surfacing abort counts in `/api/health` (deliberately closed recon channel per `BE-ARGON2-JSLEVEL-CONCURRENCY-CAP` round-2 hold).
- Counting non-argon2 aborts (e.g., other request handlers that also implement abort).

## Related

- `backend-argon2-semaphore-abort-signal.md` — task that introduced the silent-abort path; this is a follow-up, not a hold against it.
- `agents/docs/solutions/conventions/agent-native-persona-calibration-for-pevo-2026-04-28.md` — root-CLAUDE.md cross-link explaining why this finding was reframed as ops observability rather than agent-native.

## [TODO Architect]

Implementer chooses A vs B vs C; architect re-review verifies the chosen shape produces operator-visible signal under default config.

---

## Architect first review (2026-04-29) — HELD PENDING FIXES (round 1)

`/ce-code-review` ran on commit `5d33f24` ("periodic abort-summary log so operators see ArgonAbortError under LOG_LEVEL=info") with 6 personas (correctness, testing, maintainability, project-standards, agent-native, reliability). Implementer chose **Option A** (counter + periodic log every 60s, gated on delta > 0). Verified:

- Counter (`abortCount`) incremented at all three abort paths in `backend/src/lib/argon2-semaphore.ts`: pre-queue (line 273), parked-waiter (line 305), slot-grant race-guard (line 330).
- Reporter `reportArgon2Aborts` computes `delta = abortCount - abortLastReportedCount`, gates emission on `delta > 0`, updates `abortLastReportedCount`, emits `logger.info({ event: 'argon2_abort_summary', count: delta }, ...)`.
- `startArgon2AbortReporter` / `stopArgon2AbortReporter` exported alongside the existing `getArgon2QueueDepth` / `getArgon2InFlight` accessors with idempotency guards.
- `index.ts` wires the start/stop pair alongside `startSignupCleanup` / `startAccountClaimer`. `unref()` defends against the timer pinning the event loop on shutdown.

Two round-1 hold items below; one P3 dismissed.

### Items to address

**1. (P2) Periodic abort-summary reporter has zero unit tests**

The new tests cover only the **counter increment** paths. The test file at `backend/tests/lib/argon2-semaphore.test.ts:627` explicitly disclaims the rest: *"the reporter is not unit-tested here."* So the entire mechanism that delivers the task's stated goal (operator-visible signal at `LOG_LEVEL=info`) is exempt from regression coverage. Mutations to:

- the `delta > 0` gate (e.g., dropping it → log every interval forever, including `count: 0`),
- the `abortLastReportedCount` assignment (e.g., not updating → ever-growing delta),
- the structured `event` field name (e.g., typo'd to `argon_abort_summary`, breaking dashboards),
- start/stop idempotency,

…would all pass CI silently. Acceptance line 78 explicitly required: "simulate N aborts via the existing semaphore unit tests, assert the counter reads N (or the periodic log is emitted with the expected count)." Counter coverage is present; reporter coverage is missing.

Fix: add unit tests under `tests/lib/argon2-semaphore.test.ts` (or a new `tests/lib/argon2-abort-reporter.test.ts` if you prefer dedicated scope) using `vi.useFakeTimers()` + a logger spy. Cover:
- delta-zero → no emit
- delta-positive → one emit with structured `event: 'argon2_abort_summary'`, `count: <delta>`
- `abortLastReportedCount` updated such that the next interval emits only the new delta, not the cumulative count
- `startArgon2AbortReporter` idempotent (calling twice does not double-arm)
- `stopArgon2AbortReporter` idempotent and clears the interval (a stopped reporter does not emit on subsequent ticks)

~30-50 lines.

**2. (P3) Slot-grant race-guard can double-increment counter for one abort event**

In `backend/src/lib/argon2-semaphore.ts` the slot-grant race window:

1. Waiter B is parked with an abort-signal listener attached.
2. Slot frees → microtask schedules `next.resolve()` on B.
3. Inside the same microtask batch, the abort signal fires.
4. `onAbort` runs (line ~305): `abortCount += 1`, `reject` is a no-op (already resolved).
5. Awaiter receives the slot, finally{} removes the listener.
6. Awaiter checks `signal.aborted` at line ~327 — now `true` — and re-increments at line ~330: `abortCount += 1`.

Net: one abort event, two counter increments. The new test at line 679 explicitly hand-waves this: *"BOTH increment the counter, the assertion only cares that we get exactly +1"* — the test asserts `+1` while the implementation produces `+2`. Per the convention `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`, when a test relaxes to match a known race, the bug is in the code, not the test. The contract is "one abort = one increment," and the implementation should match.

Operational impact: under disconnect storms, the counter inflates by up to 2× on the racing path, so `argon2_abort_summary` over-reports and operators see inflated incident severity vs actual disconnect rate. Not a correctness issue for the request lifecycle (both increments are idempotent for the request — slot already released, listener cleaned up).

Fix: gate the second increment with a per-request boolean (e.g., `abortAlreadyCounted` set on first increment). Tighten the test to assert `+1` deterministically by sequencing the abort + resolve. ~5 lines + test edit.

### Items dismissed during architect triage (do NOT address)

- **Shutdown ordering loses final abort-summary window** (reliability conf 55). `stopArgon2AbortReporter()` is called BEFORE `drainArgon2Queue()` and `server.close()`'s 30s drain, so aborts during that window are unemitted. Bounded loss; counter is monotonic and lastReportedCount can be reconstructed from log history. Per project CLAUDE.md "don't add validation for scenarios that can't happen" the window is small and the operational cost is one missed periodic emission worst-case. Revisit if a future incident calls for the tail signal.
- **`reportArgon2Aborts` `logger.info` unguarded** (reliability conf 50). A misconfigured pino transport throwing synchronously becomes uncaughtException → process.exit. Defense-in-depth try/catch is reasonable but not a current failure path; pino transports throwing synchronously is a config-time bug surfaced before steady state.
- **`argon2_abort_summary` log carries only `count: delta`** (agent-native ops conf 60). No total/intervalMs/queueDepth/inFlight context. Sufficient for alerting; richer context is dashboard-side enrichment, not log-line responsibility.
- **`argon2 queue saturated` (free-text) vs `argon2_abort_summary` (structured)** asymmetry (agent-native ops conf 55). Out of scope for this task per non-goal "Changing the per-event `debug` log itself." Captured in `agents/docs/ARCHITECTURE.md` Section 5 (Operator Signals) so the asymmetry is at least documented for future work.

### Architect-side action landed during this pass

- Added Section 5 ("Operator Signals") to `agents/docs/ARCHITECTURE.md` describing `argon2_abort_summary` (event field, emission cadence, semantics) AND noting the `argon2 queue saturated` free-text precedent and the asymmetry. Closes the task's acceptance line 80 ("ARCHITECTURE.md or runbook updated to describe the operator-visible signal").

### Re-review signal

When items 1-2 land, `git mv` this file back to `tasks/review/`. The architect's next review pass picks it up; the move itself is the re-review signal (no need to edit this hold block).

---

## Backend re-review signal (2026-04-29, working tree)

Both round-1 hold-block items addressed.

**Item 1 (P2) — reporter unit tests with fake timers + logger spy**

Added 5 tests under `describe('periodic abort-summary reporter')` in `tests/lib/argon2-semaphore.test.ts`. Each test uses `vi.resetModules()` + dynamic import per `beforeEach` so the reporter's module-private `abortLastReportedCount` and the singleton's `abortCount` start at 0 — tests are independent of execution order. Coverage:

- **delta-zero → no emit**: starts the reporter without bumping; advances 60s; asserts `infoSpy` not called.
- **delta-positive → one structured emit**: bumps singleton by 3 (via `runWithArgon2Slot` with already-aborted signal); advances 60s; asserts exactly one `logger.info` call with `{ event: 'argon2_abort_summary', count: 3 }` and the literal message `'argon2 abort events in the last interval'`.
- **`abortLastReportedCount` delta tracking**: bumps 2, advances, asserts count=2; stops reporter, bumps 5 more under real timers, restarts, advances, asserts second call has count=5 (NOT 7 cumulative).
- **`startArgon2AbortReporter` idempotent**: calls start twice, advances, asserts exactly one emit.
- **`stopArgon2AbortReporter` idempotent + stopped reporter doesn't emit**: emits once, calls stop twice, bumps under real timers, advances 3× interval, asserts still exactly one emit.

The bump-under-real-timers / re-arm-under-fake-timers pattern is required because awaits don't progress under `vi.useFakeTimers()`.

**Item 2 (P3) — slot-grant race-guard double-increment fix**

Added per-request closure-local flag `abortAlreadyCounted` and `incrementAbortOnce()` helper inside `runWithArgon2Slot`. All three abort paths (pre-queue fast-path, parked-waiter `onAbort`, slot-grant race-guard) call `incrementAbortOnce()` instead of bare `abortCount += 1`. The flag is closed over per-call, so distinct requests don't share state.

Also tightened the existing slot-grant race test (`'increments exactly once when both the slot-grant race-guard AND the parked-waiter onAbort fire for the same abort event'`) to deterministically trigger BOTH paths via `queueMicrotask(() => bAbort.abort())` after `a.resolve(1)`. The microtask ordering is V8-deterministic: A's `await fn()` continuation (M1) runs first, A's finally schedules B's continuation (M3); the queueMicrotask abort (M2) fires next, runs B's `onAbort` listener; M3 runs B's slot-grant check. Without the dedupe flag, the assertion would fail with `+2`. With the fix, `+1` is asserted unconditionally.

Updated the `abortCount` declaration comment in `argon2-semaphore.ts` to explain the dedupe contract: "incremented exactly ONCE per logical abort event via the per-request `incrementAbortOnce` closure."

### Verification

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (only pre-existing seed-phrase.ts warnings).
- `npx vitest run tests/lib/argon2-semaphore.test.ts`: 26 passed (26).

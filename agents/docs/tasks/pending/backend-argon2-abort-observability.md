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

---

## Architect re-review (2026-04-29) — HELD PENDING FIXES (round 2)

`/ce-code-review` ran on commit `aeef5f2` (the round-1 hold-fix commit landing items 1 + 2) with 10 personas (correctness, testing, maintainability, project-standards, agent-native, learnings, security, reliability, adversarial, kieran-typescript). Round-1 hold items 1 (P2 reporter unit tests with fake timers + logger spy, 5 tests covering delta-zero, delta-positive, lastReportedCount tracking, start/stop idempotency) and 2 (P3 slot-grant race-guard double-increment fix via per-request `abortAlreadyCounted` closure flag + `incrementAbortOnce()` helper) verified landed correctly: closure-local flag confirmed (declared inside `runWithArgon2Slot` body, not module-level), all 3 abort paths use `incrementAbortOnce()`, the race test deterministically triggers both paths via `queueMicrotask` ordering and asserts +1 unconditionally.

But three round-2 hold items surfaced — two contract violations on the abort-counter accuracy (which this task literally exists to deliver) and one operator-enrichment gap on the log payload.

### Items to address

**1. (P2) Counter increments under drain + late-abort race even when no `ArgonAbortError` propagates to any caller**

- File: `backend/src/lib/argon2-semaphore.ts` (the parked-waiter `onAbort` listener path, approximately lines 311-330)
- Construct: cap=1, slot held by A, B parks in `waiters[]` with `onAbort` listener attached. `drainArgon2Queue()` runs: `waiters.splice(0, ...).forEach(w => w.reject(new ShuttingDownError()))`. B's parked Promise rejects with `ShuttingDownError`. The `await` throws. **Before** B's `finally` reaches `signal.removeEventListener`, the user's `AbortController.abort()` fires synchronously. The listener is still attached. `onAbort` runs: `waiters.indexOf(waiter)` → `-1` (drain already spliced), splice no-op, `incrementAbortOnce()` runs (counter += 1), reject() no-op (already settled with `ShuttingDownError`). B's caller sees `ShuttingDownError`. **No `ArgonAbortError` was thrown to anyone.** Counter inflated by 1 even though the contract docblock says "Monotonic count of `ArgonAbortError`s thrown."
- Operator impact: during SIGTERM, the `argon2_abort_summary` log conflates shutdown-rejected callers with actual client-disconnect aborts, giving misleading signal exactly when operators most care about distinguishing rolling restart from DoS / client-disconnect storm.
- Fix: gate the `incrementAbortOnce()` call in `onAbort` on `waiters.indexOf(waiter) >= 0` (only count if the waiter was still live and we actually had something to abort). Aborts that race against drain (or against a slot-release that already shifted the waiter — the slot-grant race is handled separately by `incrementAbortOnce`'s own dedupe, so this gating doesn't break the round-1 fix) become no-ops on the counter, preserving the "ArgonAbortError actually thrown" invariant.
- Add a test: induce drain + late-abort race (cap=1, A in flight, B parked, call `drainArgon2Queue` then `bAbort.abort()` synchronously in same tick), assert pB rejects with `ShuttingDownError` AND `getArgon2AbortCount()` is unchanged across the operation.

**2. (P3) Pre-queue abort fast-path returns `ArgonAbortError` instead of `ShuttingDownError` after drain — drain docblock contract violated**

- File: `backend/src/lib/argon2-semaphore.ts:289` (function-entry guard order)
- The function entry has two early-return guards in order: `if (signal?.aborted) throw new ArgonAbortError();` then `if (shuttingDown) throw new ShuttingDownError();`. After `drainArgon2Queue()` flips `shuttingDown = true`, a NEW caller arriving with a pre-aborted signal hits the first guard and throws `ArgonAbortError`, never reaching the second. The drain docblock at lines 444-450 promises *"every subsequent runWithArgon2Slot against the process-wide semaphore throws ShuttingDownError without queueing"* — violated for pre-aborted callers.
- Side effect: counter increments via `incrementAbortOnce()` in this path even though the process is exiting; related to item 1 but a different code path.
- Fix: implementer's choice — either swap the check order (`shuttingDown` before `signal.aborted`, operator-friendlier) or update the drain docblock to acknowledge the pre-aborted exception (no behavior change). Practical impact is low (both errors map to silent / 503 outcomes downstream), so the docblock-fix flavor is defensible.

**3. (P3) `argon2_abort_summary` log payload missing `intervalMs` field — dashboard authors must hardcode the 60s constant**

- File: `backend/src/lib/argon2-semaphore.ts:494-498` (the `reportArgon2Aborts` log emission)
- The log line emits `{ event: 'argon2_abort_summary', count: <delta> }` with no `intervalMs` field. The interval is a module-level constant `ABORT_REPORT_INTERVAL_MS = 60_000`, not exported, not present in the payload. Dashboard authors building rate expressions (events/s) must independently know the 60s constant from `ARCHITECTURE.md` Section 5. Adding `intervalMs` to the payload makes the log self-sufficient.
- Fix: one-liner — add `intervalMs: ABORT_REPORT_INTERVAL_MS` to the log context object. No type change, no contract change; pure enrichment.

### Items dismissed during architect triage (do NOT address)

- **Counter-correction rollout note** (agent-native ops conf 85) — landed in place during this review pass at `agents/docs/ARCHITECTURE.md` Section 5. Notes that pre-`aeef5f2` `argon2_abort_summary count` could be inflated up to 2× under the slot-grant race, post-`aeef5f2` is accurate; alert thresholds calibrated against inflated values will see step-down as a measurement correction, not traffic decrease.
- **`ABORT_REPORT_INTERVAL_MS` not env-configurable** (agent-native ops conf 75) — documentation arm satisfied by ARCHITECTURE.md Section 5; env-tunability is YAGNI per the task's Non-goals.
- **Reporter test leaks `setInterval` if assertion fails before finally** (adversarial conf 60) — latent fragility; mitigated by `.unref()` today; trigger (vitest pool/threading config drift) is hypothetical. Revisit if vitest behavior changes.
- **Inconsistent `as never` vs `as unknown as void` cast pattern in test mocks** (kieran-typescript conf 50) — cosmetic, no runtime delta.
- **`reportArgon2Aborts` `logger.info` unguarded** (reliability residual) — architect already YAGNI-triaged in round-1 hold block; not a current failure path.
- **`abortReportTimer.unref()` not asserted by tests; integration wiring of start/stop in `index.ts` not tested** (testing residuals) — out of scope; integration concerns rather than unit test gaps.
- **Aborts during in-flight argon2 execution not counted** (adversarial residual) — argon2 is not AbortSignal-aware; known blind spot, not introduced by this diff.

### Re-review signal

When items 1-3 land, `git mv` this file back to `tasks/review/`. The architect's next review pass picks it up; the move itself is the re-review signal (no need to edit this hold block).

# BACKEND-BRIDGE-TEST-FENCE-REPLACE-SETTIMEOUT — replace setTimeout stagger fence in bridge-haf-lag-locks.test.ts with an explicit barrier

**Owner:** Backend Agent
**Created:** 2026-05-20 (architect, filed at archive of `backend-bridge-write-haf-lag-and-retry-amplification` — carry-forward from round-2 hold block 2026-05-11 that prescribed this followup "at archive"; adversarial reviewer ADV-004)
**Priority:** P3 (test infrastructure polish)

## Problem

`backend/tests/routes/bridge-haf-lag-locks.test.ts` concurrency specs (the `/register` two-concurrent-same-identifier spec and any siblings) use a `setTimeout(..., N ms)` stagger fence between firing the two requests. The intent is to give the first request enough head-start to acquire the SETNX lock before the second arrives at `acquireBridgeLock`, so the second deterministically observes `held` and routes to the LOCK_HELD branch.

A `setTimeout` stagger is timing-coupled — it depends on the test runner's scheduling, the CI host's load, and Node's event-loop fairness. On a slow CI host, the 5ms stagger may not be enough to win the SETNX race deterministically; on a fast host, the 5ms stagger introduces unnecessary latency to the test suite. The adversarial reviewer (ADV-004) flagged this as flake-prone.

## Goal

Replace the `setTimeout` stagger with an explicit barrier — a promise-based signal that the first request has reached the SETNX lock acquisition (or just past it) before the second request fires.

## Acceptance

1. **Identify the synchronization point** that the stagger is approximating. Likely the moment the first request returns from `acquireBridgeLock` with `state: 'acquired'` — at which point the lock is held and the second request will deterministically observe `held`.
2. **Replace `setTimeout` with a barrier mechanism.** Options:
   - A test-injected `Deferred<void>` resolved by the first request's HAF responder (or a fake-Redis SETNX wrapper) when the lock is acquired.
   - A spy on `acquireBridgeLock` that resolves a promise when called.
   - A `redis.set` mock that bridges the SETNX call to a test-side signal.
3. **Mutation-kill.** The replacement barrier should fail the spec red if `acquireBridgeLock` no longer fires (e.g., a regression that skips lock acquisition). The `setTimeout` stagger gives no such signal — it just waits, deterministically passing whether the lock was acquired or not.
4. **No behavioral change** to the production code. Pure test infrastructure refactor.
5. **Test runs faster.** The 5ms stagger removed; spec finishes when the lock-acquire signal fires (microseconds, not millis).

## Out of scope

- Refactoring the broader test file structure. Targeted at the stagger pattern only.
- Replacing other `setTimeout` uses in the test suite that have different intent (e.g., the wall-clock-budget canaries' delayed-HAF responders — those simulate real degraded HAF and the timing IS the test).

## Cross-references

- `backend/tests/routes/bridge-haf-lag-locks.test.ts` — the file with the stagger fence to replace.
- Round-2 hold-block of `backend-bridge-write-haf-lag-and-retry-amplification` (2026-05-11), adversarial reviewer ADV-004 — original prescription.
- `agents/docs/tasks-archive.md` — `backend-bridge-write-haf-lag-and-retry-amplification` archive entry references this followup.

## Backend re-review signal (2026-05-20)

**Status:** No code changes required this round. The acceptance work shipped earlier in `backend(bridge-test-fence): replace setTimeout fences with explicit barriers in concurrent /register spec` (the commit landed during the bridge round-2 review cycle on 2026-05-11 and was moved to review/ in the subsequent task-file-move commit). The task was re-filed on 2026-05-20 at archive intake of `backend-bridge-write-haf-lag-and-retry-amplification` as a carry-forward of the round-2 "Architect followups (land at archive)" prescription — the architect followup-blindness convention doc landed the same day acknowledges that intake step missed checking whether each prescription had already shipped before re-filing. See the convention entry on at-archive followup blindness in `agents/docs/solutions/conventions/`.

This re-review pass re-validates the existing implementation against all five acceptance criteria.

**Barrier mechanism (already in place):** Two polling-based barriers on `FakeRedis` state.
- `waitForLockAcquired(lockKey)` polls `fakeRedis.store.has(lockKey)` to confirm A's SETNX populated the lock entry before B is fired. Replaces the prior 5ms stagger.
- `waitForSetnxBlocked(lockKey, count)` polls a new `FakeRedis.setnxBlockedCount` per-key counter (incremented on every SETNX-NX rejection). Confirms B has reached SETNX and been rejected before A's broadcast gate releases. Replaces the prior 20ms delay.

Both barriers yield via `setImmediate` (zero-delay) and have a 200ms timeout. Typical wait is sub-millisecond. Chosen over a spy on `acquireBridgeLock` or a `redis.set` mock-bridge because polling FakeRedis state requires no production-code seam — pure test infrastructure. The `setnxBlockedCount` counter is a test-only addition to the FakeRedis stub; it does not affect production code or any other test.

**Mutation-kill confirmation:** Temporarily replaced `const lockState = await acquireBridgeLock(lockKey);` in `backend/src/routes/bridge.ts` with `const lockState = { state: 'acquired', lockValue: 'mutation-test' };` (skipping the Redis SETNX entirely). Re-ran the scoped suite — the concurrent-register spec failed red with `Error: lock pevotest:bridge_register_lock:bridge-arxiv-2301-99999 not acquired within 200ms` thrown from `waitForLockAcquired`. Reverted the bridge.ts change. Re-ran the suite — all 3 specs pass. The barrier verifiably distinguishes "lock was acquired" from "lock acquisition was skipped" — the kill the prior `setTimeout` stagger could not perform.

**Timing:** Scoped run (3 specs) completes in 420ms test time / 1.43s total / 3.89s wall clock. The prior `setTimeout(r, 5)` + `setTimeout(r, 20)` pair added a minimum of 25ms per concurrent-register spec; with the barrier, the same spec finishes when the lock-acquire signal fires (sub-millisecond typical).

**Production code:** No edits to `backend/src/routes/bridge.ts`. Pure test infrastructure refactor.

**Scoped vitest pass output:**

```
RUN  v4.1.4 /home/micha/workspace/pevo/backend

Test Files  1 passed (1)
     Tests  3 passed (3)
  Start at  10:11:09
  Duration  1.43s (transform 498ms, setup 163ms, import 744ms, tests 420ms, environment 0ms)
```

All five acceptance criteria are met by the existing implementation:
1. Synchronization point identified — SETNX-store population and SETNX-blocked count.
2. Two barrier mechanisms in place, both polling-based on FakeRedis state.
3. Mutation-kill verified by bypassing `acquireBridgeLock` and observing the spec fail red.
4. No production code changes.
5. Test runs faster — 5ms+20ms = 25ms of timing fence removed.

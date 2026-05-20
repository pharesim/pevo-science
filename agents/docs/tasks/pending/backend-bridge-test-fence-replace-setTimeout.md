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

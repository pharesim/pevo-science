# BACKEND-BRIDGE-TEST-FENCE-REPLACE-SETTIMEOUT — Replace `setTimeout`-based SETNX-ordering fence in concurrency specs with an explicit barrier

**Owner:** backend
**Created:** 2026-05-11 (surfaced by `backend-bridge-write-haf-lag-and-retry-amplification` round-1 review, adversarial reviewer ADV-004 anchor 80)
**Priority:** P3

## Context

`backend/tests/routes/bridge-haf-lag-locks.test.ts` exercises bridge `/register` concurrency by issuing two requests with a `setTimeout(r, 5)` stagger to ensure request A acquires the SETNX before request B attempts it, plus `setTimeout(r, 20)` to ensure B reaches the lock check before A's `broadcastGate` opens. The defensive `winner = resA.status === 200 ? resA : resB` pattern absorbs winner-flip, but the test embeds a timing assumption that future infrastructure changes can break.

The test passes reliably in current CI. The flake risk surfaces under load: on a slow CI runner with GC pauses or parallel workers contending for the event loop, A's full pre-lock path (signature verify, accreditation lookup, `resolveToCanonical`) may not complete within 5ms. Worse, B can reach the SETNX AFTER A has already released the lock if A's broadcast completes before B enters the route — `sendOperations.toHaveBeenCalledTimes(1)` then fails because both broadcasts fired.

A true barrier — a promise that resolves only when `fakeRedis.store.has(lockKey)` becomes true — eliminates the timing dependency. The implementation is small (~10-20 lines of test infrastructure) and the resulting test is deterministic.

## Acceptance

1. Replace the `setTimeout(r, 5)` + `setTimeout(r, 20)` fence in the two concurrency specs (`/register` and historical `/update` — note: `/update` spec may already be dropped per `backend-bridge-write-haf-lag-and-retry-amplification` round-2 hold item 9 architect-preferred path; if so, only `/register` remains) with an explicit barrier:

   ```ts
   // Wait for A's SETNX to populate fakeRedis.store before issuing B.
   async function waitForLockAcquired(lockKey: string, timeoutMs = 200): Promise<void> {
     const start = Date.now();
     while (!fakeRedis.store.has(lockKey)) {
       if (Date.now() - start > timeoutMs) throw new Error(`lock ${lockKey} not acquired within ${timeoutMs}ms`);
       await new Promise(r => setImmediate(r));
     }
   }
   ```

   The barrier is polling-based (zero-delay yield via `setImmediate`) because `FakeRedis.store` doesn't expose a change-notification primitive. The polling overhead is negligible — typical wait is sub-millisecond.

2. Update the concurrency specs to use the barrier:

   ```ts
   const reqA = signedPost(/* A's request */);
   await waitForLockAcquired(lockKey);
   const reqB = signedPost(/* B's request */);
   broadcastGate.resolve();
   const [resA, resB] = await Promise.all([reqA, reqB]);
   ```

   Drop the defensive winner-pattern (`winner = resA.status === 200 ? resA : resB`) — A is now the deterministic winner because the barrier guarantees its lock acquisition completes before B even starts.

3. Verify the test still passes under `vitest run tests/routes/bridge-haf-lag-locks.test.ts`. The `expect(sendOperations).toHaveBeenCalledTimes(1)` and 409/200 status assertions become deterministic.

## Tests

The test file IS the deliverable; no additional tests needed. Verify in CI that the test passes consistently across at least 5 runs (or however the project verifies flake removal).

## Coordination

- Cross-references `backend-bridge-write-haf-lag-and-retry-amplification` round-2 hold items 8+9 (which add the `/check` fail-open spec AND assert lock-key absence after request completes — both items consume the same test file, so coordinate landing order).
- The barrier pattern, if it works cleanly, may be worth extracting to `backend/tests/support/` for reuse by other concurrency tests (orcid binding lock, future custody locks). Out of scope for this task; suggest noting in commit message as a future `/ce-compound` candidate.

## Out of scope

- Migrating the test to real Redis. The mocked concurrency test serves a different purpose (deterministic SETNX-contention shape verification); real Redis coverage is filed separately as `backend-bridge-lock-real-redis-companion.md`.
- Adding the barrier to non-concurrency specs in the same file. The fence issue only affects the two-request-race specs.

## Priority rationale

P3 because the test passes reliably today. Filed because the timing-based fence is a known fragility class — future test-infra changes (vitest config, parallel worker count, GC tuning) can expose it. The fix is small enough that fixing now is cheaper than diagnosing a future flake.

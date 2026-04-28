# BACKEND-ORCID-LOCK-TTL-EXTEND-ON-TIMEOUT — Adopt Option A.1 lock-TTL extension on `BroadcastTimeoutError` inside `withOrcidBindingLock`

**Owner:** backend
**Created:** 2026-04-28 (architect, decided per `architect-orcid-lock-ttl-extension.md`)
**Priority:** P2

## Context

`BE-ORCID-BROADCAST-ABORT-TIMEOUT` (round-3) and `BE-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING` adopted Option A.2 (504 + `retriable:false` + `verify_before_retry` envelope) for ORCID-binding broadcast paths. A.2 is the user-facing UX shell. The architect re-review (round-3, finding F3.3) surfaced a concrete attack path A.2 surfaces but does not close: when A's broadcast timer fires at t=30s, `withOrcidBindingLock`'s `finally` (orcid.ts:760-762) unconditionally calls `releaseBindingLock(orcidId, A_nonce)` and the CAS matches → lock DELETED at ~t=30.x. Buffer past timer fire is ~5s. B can acquire a fresh lock within seconds while A's broadcast may still be on-chain unindexed (HAF lag 3-120s). Both A and B can broadcast against the same `orcid_id`. Recovery is admin-signed `revoke` (irreversible chain pollution interim).

A.1 closes the race **structurally** by extending the lock TTL to `HAF_INDEXING_LAG_CEILING_SECONDS` (120s) on `BroadcastTimeoutError`, before A's release fires. New requests during the extended window receive the existing `'held'` 409 ORCID_ALREADY_LINKED with `Retry-After`, which the `acquireBindingLock`/`'held'` branch already returns (orcid.ts:747-756). A.2's envelope to A's user is preserved. A.1 + A.2 are not mutually exclusive — they are orthogonal layers (server-side race protection vs. user-facing UX).

The architect's decision (recorded in `architect-orcid-lock-ttl-extension.md` archive entry on this date) chose **Option A.1 + A.2**, citing duplicate-bind irreversibility and contained implementation footprint inside `withOrcidBindingLock`.

The convention doc Option A.1 example block is at `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` lines 205-223, including the explicit pitfall: a naive `redis.expire` call is undone by the wrapper's unconditional `releaseBindingLock` CAS-match in `finally`.

## Goal

Implement A.1 inside `withOrcidBindingLock` such that on `BroadcastTimeoutError` the lock TTL extends to 120s and the CAS-release in `finally` does NOT delete the extended lock. A.2's 504 envelope to A's user remains identical — only the lock-side behavior changes.

## Acceptance

### Implementation

1. **New named constant** `HAF_INDEXING_LAG_CEILING_SECONDS = 120` exported from a backend lib module (preferred location: `backend/src/lib/binding-lock.ts` or inline in `orcid.ts` near `ORCID_BINDING_LOCK_TTL_SECONDS`). The value is intentionally aligned with the convention doc's stated HAF-indexing window upper bound. Used by both the `redis.expire` call below and any future broadcast-wrapper site that adopts A.1.

2. **`withOrcidBindingLock` skip-release signal.** Adopt **shape (1)** from the architect's decision rationale: `fn` callbacks return `{ skipRelease: true } | void`. The `'acquired'` branch checks the return value:
   ```ts
   } else if (lock.state === 'acquired') {
     try {
       const result = await fn();
       if (result?.skipRelease) {
         // Caller extended the lock TTL on a timeout-class error and signaled
         // the wrapper not to release. Lock auto-expires at the extended TTL.
         return;
       }
     } finally {
       // releaseBindingLock is gated on the try block completing without
       // skipRelease being set. NB: the previous unconditional finally is
       // restructured because finally cannot read `result` from try scope.
       // See implementation notes below for the exact shape that preserves
       // throw-path release.
     }
   }
   ```
   The non-trivial part: `finally` cannot read `result` from `try` scope, AND throws from `fn` must STILL release (otherwise a non-timeout throw would orphan the lock for 35s). The acceptable shape is a `let skipRelease = false` declared above the try, mutated inside the try AFTER `fn` returns, and read inside `finally`:
   ```ts
   } else if (lock.state === 'acquired') {
     let skipRelease = false;
     try {
       const result = await fn();
       if (result?.skipRelease) skipRelease = true;
     } finally {
       if (!skipRelease) {
         await releaseBindingLock(orcidId, lock.nonce);
       }
     }
   }
   ```
   This preserves the throw-path release (any throw from `fn` flows past the `skipRelease = true` line, leaves `skipRelease = false`, and `finally` releases as before). Only the explicit `{ skipRelease: true }` return path skips release.

3. **`fn` signature in `handleAccredit` and `handleLink`** widens from `() => Promise<void>` to `() => Promise<void | { skipRelease: true }>`. The `BroadcastTimeoutError` catch inside `fn` becomes:
   ```ts
   } catch (err) {
     if (err instanceof BroadcastTimeoutError) {
       await redis.expire(orcidBindingLockKey(orcidId), HAF_INDEXING_LAG_CEILING_SECONDS);
       handleBroadcastError(res, err, { /* existing A.2 opts including verify_location:'/settings' */ });
       return { skipRelease: true };
     }
     throw err;  // non-timeout throws still release (unchanged)
   }
   ```
   The `redis.expire` call MUST run BEFORE `handleBroadcastError` writes the response, so the lock state is already extended when control returns to the wrapper. Order matters because the response-write is the last thing inside `fn`; if `redis.expire` were after, a malicious caller terminating the connection mid-write could escape `fn` before the extend completes.

4. **`acquireBindingLock` semantics confirmed unchanged.** It uses Redis `SET ... NX EX <TTL>`. While the lock key exists (whether on the original 35s TTL or an extended 120s TTL), `NX` causes new acquires to return `'held'`. No code change needed there.

5. **`releaseBindingLock` semantics confirmed unchanged.** Lua CAS: `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`. The wrapper now gates the call on `skipRelease`; the Lua script itself remains a defensive guard for the non-timeout throw path.

6. **`'unavailable'` branch (Redis-down) is a no-op for A.1.** Document inline in the wrapper that A.1 does not apply on the unavailable branch (no lock to extend; `forceAmbiguousOutcome` already routes the 504 envelope; the duplicate-bind window in the unavailable branch is a separate axis tracked outside this task).

### Tests

7. **New test in `backend/tests/routes/orcid.test.ts` (or sibling): `withOrcidBindingLock-extends-ttl-on-broadcast-timeout`**
   - Inject a stub `broadcastJsonWithTimeout` that throws `BroadcastTimeoutError`.
   - Call `handleAccredit` (or the wrapper directly via the existing `__test_*` exports).
   - Assert: response is 504 BROADCAST_TIMEOUT (A.2 envelope unchanged).
   - Assert: `redis.ttl(orcidBindingLockKey(orcidId))` is `>= 100` AND `<= 120` immediately after the call returns (the extended TTL).
   - Assert: `redis.get(orcidBindingLockKey(orcidId))` matches `lock.nonce` (the lock value was NOT rotated, just re-expired).
   - Assert: a second `acquireBindingLock(orcidId)` returns `'held'` (proves new requests are blocked during the extended window).

8. **New test: `withOrcidBindingLock-still-releases-on-non-timeout-throw`**
   - Inject `fn` that throws `new Error('synthetic non-timeout failure')`.
   - Assert: `redis.exists(orcidBindingLockKey(orcidId))` is `0` after the call (lock released as before — skipRelease path NOT taken on non-timeout throws).

9. **New test: `withOrcidBindingLock-still-releases-on-success`**
   - Inject `fn` that returns `void` after a successful broadcast.
   - Assert: lock released.

10. **Concurrent A/B race regression test:** simulate A timing out at t=30s, then B's `acquireBindingLock` between t=30.x and t=120s — assert B receives `'held'`. This is the structural property A.1 guarantees; the test pins it.

### Doc updates (out-of-scope for this task; tracked separately)

- `agents/docs/api-contracts/orcid.md` — already documents the 504 envelope from A.2; needs a follow-up note that during the 120s post-timeout window, retries return 423/409 LOCKED (existing `'held'` branch — no envelope change). Architect will pick this up in a follow-up sweep once A.1 archives.
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — Option A.1 section needs the skipRelease implementation shape (currently shows naive `redis.expire`). Architect will update once A.1 archives.

Both doc updates are the architect's, not backend's. Do NOT edit them in this task.

## Non-goals

- Do NOT generalize this to other broadcast-wrapped sites (`accreditation.ts`, `claims.ts`, `papers.ts`, `signup-verify.ts`, `wot.ts`). Those sites have their own ambiguous-outcome envelopes; whether they need A.1-style protection is a separate decision per site (the lock-cost-vs-duplicate-cost trade-off differs). Scope this task to ORCID binding only.
- Do NOT change the `'unavailable'` branch behavior. It's a no-op for A.1.
- Do NOT add a sentinel-rotation alternative ("shape (2)" in the architect's decision rationale). Shape (1) — skipRelease return signal — is the chosen implementation. A future refactor can revisit if shape (1) proves brittle.
- Do NOT change `ORCID_BINDING_LOCK_TTL_SECONDS` (35s default). The extension only fires on the timeout-error path.
- Do NOT add A.3 hybrid admin endpoint. Out of scope; can be filed separately if operational data later shows it's needed.

## Source

- `architect-orcid-lock-ttl-extension.md` (architect decision recorded 2026-04-28; archived same day after this task filed).
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` Option A.1 example (lines 205-223) and pitfall note ("design this carefully; premature release silently undoes the fix").
- `tasks-archive.md` BE-ORCID-BROADCAST-ABORT-TIMEOUT round-3 archive entry (finding F3.3, adversarial conf 75).
- `backend/src/routes/orcid.ts:740-797` — current `withOrcidBindingLock` shape, including the `'held'` 409 envelope, the `'acquired'` try/finally, and the `'unavailable'` `forceAmbiguousOutcome` branch.

---

## Backend re-review signal (2026-04-28, commit `81795fd`)

A.1 implementation landed exactly per the locked skipRelease shape from the architect's decision rationale. Worker's first draft stalled on debug after using invalid ORCID IDs (`-000a`/`-000b`) in tests #8 and #9 — the strict `\d{4}` format gate at `/callback` rejected them as 400 BAD_REQUEST. Parent reconciliation renumbered to `-0010`/`-0011` and committed.

### Acceptance items landed

- **#1** Constant `HAF_INDEXING_LAG_CEILING_SECONDS = 120` — added in `backend/src/routes/orcid.ts` near `ORCID_BINDING_LOCK_TTL_SECONDS` (per task suggestion: kept inline rather than splitting into `lib/binding-lock.ts` for one constant).
- **#2** `withOrcidBindingLock` `'acquired'` branch restructured with `let skipRelease = false` declared above the try; `if (result?.skipRelease) skipRelease = true` after `await fn()`; `if (!skipRelease) await releaseBindingLock(...)` in finally. Throw-path release preserved (the toggle line is skipped on throw).
- **#3** `fn` signature widened to `() => Promise<void | { skipRelease: true }>`. The `BroadcastTimeoutError` catch in both `handleAccredit` and `handleLink` calls `redis.expire` BEFORE `handleBroadcastError` (response-write happens last so a malicious caller terminating mid-write cannot escape before the extend lands), then `return { skipRelease: true }`.
- **#4, #5** `acquireBindingLock` (SET NX EX) and `releaseBindingLock` (Lua CAS) semantics unchanged — verified.
- **#6** `'unavailable'` branch documented inline as a no-op for A.1 (no lock to extend).
- **#7** `withOrcidBindingLock-extends-ttl-on-broadcast-timeout` — asserts 504 envelope, `redis.ttl >= 100 && <= 120`, `redis.get(lockKey) === lock.nonce` (lock value not rotated), and a follow-up `acquireBindingLock` returns `'held'`. The race-regression assertion (acceptance #10) is folded into this spec via the follow-up acquire — kills the same mutation set as a separate spec without doubling test setup.
- **#8** `withOrcidBindingLock-still-releases-on-non-timeout-throw` — synthetic non-timeout `Error` from broadcast → 502 BROADCAST_FAILED, lock released.
- **#9** `withOrcidBindingLock-still-releases-on-success` — happy path → 200, lock released.
- **#10** Concurrent A/B race regression — folded into #7 (above).

### Test result

`npx vitest run tests/routes/orcid.test.ts` — **44/44 pass** (was 40 before A.1; +4 new). Typecheck clean.

### Architect-owned (deferred)

- `agents/docs/api-contracts/orcid.md` — note 423/409 LOCKED retry semantics during the 120s extended window.
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — Option A.1 section needs the skipRelease shape (currently shows naive `redis.expire` which the wrapper's old `finally` would defeat).

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

---

## Architect re-review (2026-04-29, round-1) — HELD PENDING FIXES

Round-1 `/ce-code-review` on commit `81795fd` (11 personas: correctness, testing, maintainability, project-standards, ce-agent-native, ce-learnings, security, reliability, api-contract, adversarial, kieran-typescript). The A.1 mechanism (skipRelease return signal + `redis.expire` to 120s before response-write) is structurally correct and survives at HEAD across the subsequent commits (`0a5c890` round-2 hold-fix, `0d0c156` acquired-branch-throw-guard, `d8b9b75` PostBroadcastWriteError discrimination). **No P0/P1. No exploitable security findings. No project-standards violations.** Architect-applied 3 doc fixes during this review pass; 9 backend-owned items remain held, mostly clustered around `redis.expire` failure-mode robustness and operator observability.

**The architect applied 3 in-place doc fixes during this review pass (architect-owned files):**

- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` Option A.1 section — replaced the stale naive `redis.expire` + `return` example (the literal anti-pattern the pitfall note warned against) with the canonical landed shape: `redis.expire` BEFORE `handleBroadcastError`, `return { skipRelease: true }`, the wrapper's `let skipRelease = false` mutable-closure pattern with throw-path release preserved, and `fn` signature widening. Also documented three operational hardening items the test suite cannot easily reach (expire-returns-0, log-on-success, Redis-completely-absent).
- `agents/docs/api-contracts/orcid.md:188` — same-tick lock-contention paragraph rewritten. Removed stale "TTL (35s) expires" claim. Added explicit note that `BroadcastTimeoutError` extends the TTL in-place to `HAF_INDEXING_LAG_CEILING_SECONDS = 120s`, that polling clients at `Retry-After: 10` may see up to ~12 consecutive 409s during the extended window, and that honoring `Retry-After` is the canonical retry strategy.
- `agents/docs/api-contracts/orcid.md:201+` — added "Server-side residual race window after the 504" sub-bullet to the BROADCAST_TIMEOUT entry. Documents that the 120s window is best-effort, not a guarantee: if HAF lag exceeds 120s the lock self-expires before the broadcast is indexed, and an OAuth-restart can broadcast a duplicate. Reinforces that `verify_before_retry` is the user-side mitigation regardless of elapsed time.

### Items held pending fixes (backend-owned)

1. **P2 — `redis.expire` return value 0 silently ignored.** 3-reviewer convergence (correctness, reliability, adversarial). `backend/src/routes/orcid.ts:544` (handleAccredit) and `:688` (handleLink). When the lock key is already gone (eviction, FLUSHDB, AOF stall between SETNX and the catch), `redis.expire` resolves to 0, no exception, code returns `{ skipRelease: true }` anyway. The lock doesn't exist → no protection during the 120s window → A.1 contract silently violated. Fix:
   ```ts
   const extended = await redis.expire(orcidBindingLockKey(orcidId), HAF_INDEXING_LAG_CEILING_SECONDS);
   if (extended === 0) {
     logger.error({ orcidId }, 'orcid binding lock expired between acquire and TTL-extend — A.1 protection degraded');
     // Fall through to handleBroadcastError as before; skipRelease:true is now
     // a no-op (no lock to skip releasing) but is still safe to return.
   }
   ```

2. **P2 — Lock-extension success path is silent.** 2-reviewer convergence (agent-native, reliability). `redis.expire` succeeding emits no log → operators cannot alert on extension events or correlate against HAF-lag spikes. Add `logger.warn` on the success branch (alongside item #1):
   ```ts
   if (extended === 1) {
     logger.warn({ orcidId, newTtl: HAF_INDEXING_LAG_CEILING_SECONDS },
       '<routeLabel> binding lock TTL extended on BroadcastTimeoutError — duplicate-bind window held');
   }
   ```
   `warn` (not `info`) because the event is abnormal and operators want it on a monitoring dashboard.

3. **P2 — Redis-completely-absent at BroadcastTimeoutError time is logged silently.** 2-reviewer convergence (agent-native, adversarial). `if (redis && isRedisAvailable())` short-circuits with no log when Redis is degraded. The existing `expireErr` catch only fires on a Redis exception, not on the absent-Redis no-op. Symmetric `error`-level log:
   ```ts
   } else {
     logger.error({ orcidId },
       '<routeLabel> A.1 lock-TTL extension skipped — Redis unavailable at BroadcastTimeoutError time, duplicate-bind window may be open');
   }
   ```

4. **P2 — `HAF_INDEXING_LAG_CEILING_SECONDS` and `ORCID_BINDING_CACHE_TTL` duplicate the same domain concept.** Maintainability finding (conf 75). `backend/src/routes/orcid.ts:69` and `:88` both declare `120` with separate comments referencing "HAF-indexing-lag window" and "HAF block-watcher catch-up upper bound." Future tuning (e.g., observed lag spikes prompting a 180s ceiling) requires changing both. Fix shape (i) preferred: a single named constant with both consumers referencing it (e.g., `HAF_INDEXING_LAG_CEILING_SECONDS` becomes the source-of-truth, `ORCID_BINDING_CACHE_TTL` is replaced by a reference to it OR by `Math.min(HAF_INDEXING_LAG_CEILING_SECONDS, 120)` if the cache TTL is intended to track but be capped). Or (ii): keep separate constants but add a cross-reference comment on `ORCID_BINDING_CACHE_TTL` linking it to the lag ceiling so future editors know to change both. The task spec preferred a `lib/binding-lock.ts` module; one constant doesn't justify a new file but a second adopter (accreditation.ts, etc.) would.

5. **P2 — `BroadcastTimeoutError` catch block is duplicated verbatim across `handleAccredit` and `handleLink`.** Maintainability finding (conf 75). `backend/src/routes/orcid.ts:527-560` (handleAccredit) and `:680-697` (handleLink). The handleLink comment says "mirrored exactly". A small extracted helper closes the drift surface:
   ```ts
   async function extendBindingLockOnTimeoutOrLog(
     orcidId: string,
     routeLabel: string,
   ): Promise<void> {
     const redis = getRedis();
     if (!redis || !isRedisAvailable()) {
       logger.error({ orcidId }, `${routeLabel} A.1 lock-TTL extension skipped — Redis unavailable`);
       return;
     }
     try {
       const extended = await redis.expire(orcidBindingLockKey(orcidId), HAF_INDEXING_LAG_CEILING_SECONDS);
       if (extended === 0) {
         logger.error({ orcidId }, `${routeLabel} binding lock expired between acquire and TTL-extend`);
       } else {
         logger.warn({ orcidId, newTtl: HAF_INDEXING_LAG_CEILING_SECONDS },
           `${routeLabel} binding lock TTL extended on BroadcastTimeoutError`);
       }
     } catch (expireErr) {
       logger.error({ err: expireErr, orcidId }, `${routeLabel} redis.expire on BroadcastTimeoutError failed`);
     }
   }
   ```
   Both handlers call this before `handleBroadcastError`. The skipRelease return stays at the call site since it's wrapper-specific. Closes items #1, #2, #3, #5 in one shape.

6. **P3 — `Retry-After: 10` is a constant; during the 120s extended window a polling client may see up to ~12 consecutive 409s.** Correctness finding (conf 75). `backend/src/routes/orcid.ts:933`. Clients with hard retry-count caps below 12 may give up incorrectly when the lock is genuinely held but the binding will resolve. Two acceptable resolutions:
   - **(a)** Make `Retry-After` dynamic — read remaining TTL via `redis.ttl(orcidBindingLockKey(orcidId))` and surface the actual remaining seconds. Clients with a single retry budget see an honest "wait this long" signal.
   - **(b)** Keep constant `10` and accept that polling clients honoring `Retry-After` succeed; clients with hard caps should use the documented `verify_before_retry` mechanism instead. The architect-applied contract update at `orcid.md:188` already documents the ~12-attempt expectation.

   Backend's call. (b) is what shipped; the contract now documents the expectation, so leaving it as a P3 advisory is also acceptable.

7. **P3 — Ordering invariant (`redis.expire` before `handleBroadcastError`) is unverified by tests.** 2-reviewer convergence (testing RR-02, adversarial adv-3). The code comment at `orcid.ts:530-535` documents the invariant, but supertest cannot simulate mid-write disconnect, so a line-swap mutation passes the suite. Two ways to pin it:
   - **(a) Mock-level ordering check.** In the existing extend-ttl spec, install a spy on `redis.expire` that captures call-order vs the `res.json`/`res.status` stubs and asserts `redis.expire` was called BEFORE the response was written.
   - **(b) Helper extraction (item #5)** — once the extend-and-log logic lives in a single helper, a simple assertion that the helper was invoked before `handleBroadcastError` (via a `vi.spyOn` order check) closes the gap structurally.

8. **P3 — `expireErr` catch branch has no test.** 2-reviewer convergence (testing T-01, kieran-typescript KT-TG-001). `orcid.ts:545-557` swallows + logs the throw, but no spec injects a `redis.expire` rejection. A regression that removes the catch would change the wire shape from regular 504 (with timeout_ms) to ambiguous-outcome 504 (without timeout_ms — re-thrown to wrapper outer catch). Add a unit-style spec stubbing `redis.expire` to throw and asserting the standard 504 envelope fires + `logger.error` was called with the documented log suffix. Pairs with item #5's helper-extraction.

9. **P3 — Stale comment paragraph at `orcid.ts:961-965`.** Maintainability finding (conf 50, info-tier). The "Post-broadcast ASYNC throw inside fn" paragraph in the wrapper's acquired-branch comment block describes pre-d8b9b75 behavior (throw escapes to outer `/callback` catch as 500). After `d8b9b75` post-broadcast cascade calls are wrapped as `PostBroadcastWriteError` and route to 502 POST_BROADCAST_FAILED. The NB block immediately below correctly documents this; the first paragraph reads as accurate-but-stale to a reader scanning lines 961-965 in isolation. Either delete or rewrite as "pre-d8b9b75 behavior; superseded — see NB below."

### Latent / product-decision items (surfaced; not held)

- **A/B starvation: held-branch 409 returns `retriable:true` for the full extended window even when the binding is durable on chain.** Adversarial finding adv-4 (P3 conf 75). `orcid.ts:932-941`. A's broadcast actually lands at t=20 but dhive's timer fires at t=30 (false timeout from RPC perspective). A.1 extends to 120s. B's polling sees `retriable:true` 409 for the full window even though the binding is already on chain. The held-branch returns BEFORE consulting `findAccreditedAccountWithOrcid`. Pre-existing pattern (existed at 35s before A.1); A.1 widens to 120s. Architect note: not held — the perf cost of HAF lookup on every contended request is non-trivial, and B will eventually succeed via the durable-binding 409 path once HAF indexes. Worth a follow-up if monitoring shows the false-retry pattern hurting users; for now the contract update at `orcid.md:188` documents the expectation.

### Pre-existing in-scope (not held)

- `backend/tests/routes/orcid.test.ts` — no spec for `BroadcastTimeoutError` on the `'unavailable'` branch (testing TG-01). Not introduced by this commit; the unavailable-branch 504 envelope already exists. File a follow-up if a future regression class emerges.
- `architect-orcid-lock-ttl-extension.md` decision doc — task body says "archived same day" but no such file on disk and no matching heading in `tasks-archive.md`. Decision rationale is preserved in this task file's Source section; missing archive entry is housekeeping, not blocking.

### Suppressed at confidence gate

MAINT-03 (skipRelease closure pattern fragility, conf 50), AN-2 (held-branch 409 not at debug level, P3 obs), AN-3 (no HAF-lag alert threshold, P3 doc), KT-001 (inline union vs named alias, soft 50), KT-002 (`as const`, soft 40), correctness C3 (`redis.expire` bounded timeout, conf 50).

### Path to re-archive

(1) Backend addresses items #1, #2, #3, #4, #5, #6, #7, #8, #9 in this hold block. Items #1, #2, #3, #5 fold cleanly into a single helper-extraction commit (suggested shape in #5). Items #7 and #8 fold into the test pass that exercises the helper. Item #4 is a one-line fix or a small constants refactor. Item #6 is a one-line decision (constant vs dynamic Retry-After). Item #9 is a comment-only edit. (2) Backend re-review signal block referencing the round-2 hold-fix commit SHA. (3) Architect round-2 `/ce-code-review` on the new commit (testing + reliability mandatory given the operational-observability focus). (4) Archive on clean.

---

## Backend re-review signal (2026-04-29, working tree)

All 9 hold-block items addressed.

**Item #1 (P2) — `redis.expire` returns 0 logged at error level.** Folded into the new helper (item #5). When the lock key is gone (eviction, FLUSHDB, AOF stall), `redis.expire` resolves to 0; the helper now emits `error` with `event: 'a1_extend_lock_missing'` so the silently-degraded A.1 contract surfaces in operator logs. The wrapper still returns `{ skipRelease: true }` after the helper; on this path the skip is a no-op (no lock to skip releasing) but is structurally still correct.

**Item #2 (P2) — Lock-extension success path emits `warn`.** Folded into the new helper. Successful `expire === 1` now emits `warn` with `event: 'a1_extend_ok'` and `newTtl: HAF_INDEXING_LAG_CEILING_SECONDS`. `warn` (not `info`) per the architect's note — operators want this on monitoring dashboards, not buried at info.

**Item #3 (P2) — Redis-completely-absent at BroadcastTimeoutError time emits `error`.** Folded into the new helper. The previous silent `if (redis && isRedisAvailable())` short-circuit now emits `error` with `event: 'a1_extend_redis_absent'` so a degraded-during-timeout event is recoverable from logs.

**Item #4 (P2) — `HAF_INDEXING_LAG_CEILING_SECONDS` is the source of truth for the 120s domain bound.** `backend/src/routes/orcid.ts`: `ORCID_BINDING_CACHE_TTL` now references `HAF_INDEXING_LAG_CEILING_SECONDS` directly (`const ORCID_BINDING_CACHE_TTL = HAF_INDEXING_LAG_CEILING_SECONDS`) rather than redeclaring `120`. The named alias at the cache-write site preserves semantic intent. Future tuning to e.g. 180s now changes one constant.

**Item #5 (P2) — `extendBindingLockOnTimeoutOrLog` helper extracted.** `backend/src/routes/orcid.ts`: new function at the lock-helpers section (after `releaseBindingLock`). Routed through `__test_seams.extendBindingLockOnTimeoutOrLog` so a unit spec can pin the ordering invariant (item #7). Both `handleAccredit` and `handleLink` now `await __test_seams.extendBindingLockOnTimeoutOrLog(orcidId, '<routeLabel>')` instead of duplicating the inline `getRedis` + try/expire/catch shape. Drift surface between the two callers is closed.

**Item #6 (P3) — `Retry-After: 10` kept constant.** Picked option (b) per the architect's "(b) is what shipped; the contract now documents the expectation" framing. The contract update at `orcid.md:188` already documents the ~12-attempt expectation during the extended window. Polling clients honoring `Retry-After` succeed; clients with hard retry-count caps below 12 should use the documented `verify_before_retry` mechanism instead of raw polling. No code change.

**Item #7 (P3) — Ordering invariant pinned at the test layer.** `backend/tests/routes/orcid.test.ts`: new spec `extendBindingLockOnTimeoutOrLog runs BEFORE handleBroadcastError writes the response (A.1 ordering invariant)`. Uses vi's `mock.invocationCallOrder` (every spy invocation is assigned a global incrementing call number) to compare the helper's invocation order against the `<routeLabel> broadcast timed out` warn fired inside `handleBroadcastError`. A line-swap mutation that calls `handleBroadcastError` first inverts the order and surfaces here. Runs across the accredit + link describe.each matrix (2 specs total).

**Item #8 (P3) — `expireErr` catch branch covered.** `backend/tests/routes/orcid.test.ts`: new spec `extendBindingLockOnTimeoutOrLog catches redis.expire throw and emits operator-alert anchor; 504 envelope unchanged`. Stubs `redis.expire` to reject with a synthetic error, asserts the standard 504 BROADCAST_TIMEOUT envelope still fires (timer-fire shape with `timeout_ms`, NOT routed through the ambiguous-outcome branch), and asserts the helper's documented operator-alert anchor (`orcid binding lock TTL extension failed — duplicate-bind protection degraded for this request`) was logged at error level. A regression that drops the catch propagates the rejection and loses the anchor → spec fails. 2 specs total.

**Item #9 (P3) — Stale comment paragraph reframed.** `backend/src/routes/orcid.ts`: the `withOrcidBindingLock` acquired-branch comment block previously enumerated pre-broadcast SYNC and post-broadcast ASYNC throw classes both routing to 504 ambiguous-outcome. After d8b9b75 the post-broadcast class routes to 502 POST_BROADCAST_FAILED via PostBroadcastWriteError discrimination. Rewrote to lead with the wrapper's role (route + discriminate via handleBroadcastErrorAmbiguous → handleBroadcastError) and enumerate surviving classes after the swap (pre-broadcast SYNC → 504, with a pointer to `backend-pevo-admin-key-startup-validation.md` for the startup-time check that closes the production trigger; post-broadcast cascade → 502 POST_BROADCAST_FAILED).

### Verification

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (pre-existing `seed-phrase.ts` no-explicit-any warnings only).
- `npx vitest run tests/routes/orcid.test.ts`: 54/54 pass (was 50 before; +4 = items #7 + #8 × 2 modes via describe.each).
- Full backend suite is the architect's call (per CLAUDE.md guidance).

### Files changed

- `backend/src/routes/orcid.ts` — `HAF_INDEXING_LAG_CEILING_SECONDS` reordered above + made source of truth for `ORCID_BINDING_CACHE_TTL`; new `extendBindingLockOnTimeoutOrLog` helper at the lock-helpers section; `handleAccredit` + `handleLink` BroadcastTimeoutError catch sites collapsed to `await __test_seams.extendBindingLockOnTimeoutOrLog(...)`; helper added to `__test_seams`; wrapper acquired-branch comment block reframed.
- `backend/tests/routes/orcid.test.ts` — 2 new specs for items #7 + #8.



---

## Architect re-review (2026-04-29, round-2) — HELD PENDING FIXES

Round-2 `/ce-code-review` on commit `ddfff93` (9 personas: correctness, testing, maintainability, project-standards, ce-agent-native, ce-learnings, adversarial, kieran-typescript, reliability). All 9 round-1 hold items land mechanically: helper extracted with 4 branches and consistent `event:`-tagged structured logs; both handlers route through `__test_seams.extendBindingLockOnTimeoutOrLog`; `ORCID_BINDING_CACHE_TTL` aliased to `HAF_INDEXING_LAG_CEILING_SECONDS`; new ordering + expire-throw specs landed; comment rewrite reflects post-d8b9b75 routing. **No P0/P1.** Three P2 items held pending fixes, all consistent with the path-to-archive's "operational-observability focus".

### Items held pending fixes (backend-owned)

1. **P2 — Ordering spec at `backend/tests/routes/orcid.test.ts:1818-1837` pins call-entry, not awaited completion.** Adversarial + correctness 2-way (cross-reviewer promoted to conf 100). `vi.mock.invocationCallOrder` records SYNCHRONOUS spy entry, so a regression that drops the `await` from `await __test_seams.extendBindingLockOnTimeoutOrLog(...)` (replaced with `__test_seams.extendBindingLockOnTimeoutOrLog(...); handleBroadcastError(...);`) still records helper-entry first → spec passes spuriously while the documented A.1 contract silently breaks. The malicious-mid-write-disconnect race the impl-comment at `orcid.ts:558-567` cites is the failure mode this spec was supposed to pin and does not. Fix shape (option F1, structurally simplest):

   ```ts
   const expireSpy = vi.spyOn(redis, 'expire');
   // ... trigger broadcast timeout ...
   const expireOrder = expireSpy.mock.invocationCallOrder[0];
   const respondOrder = warnSpy.mock.calls.findIndex(
     (call) => typeof call[1] === 'string' && call[1].includes('broadcast timed out'),
   );
   expect(expireOrder).toBeLessThan(warnSpy.mock.invocationCallOrder[respondOrder]);
   ```

   `redis.expire` is `await`ed inside the helper, so its position in the order proves the helper completed its inner work before the response was written. Mutation-kill: dropping the `await` lets the response write before `redis.expire` resolves → ordering inverts → spec fails.

2. **P2 — Structured `event:` field literals not pinned by any spec.** Testing + maintainability + adversarial 3-way (conf 75). Items #1/#2/#3 added 3 new event tags (`a1_extend_lock_missing`, `a1_extend_ok`, `a1_extend_redis_absent`); none are asserted via `expect.objectContaining({ event: '...' })`. Item #8's existing assertion uses substring on the message text, not the event field. A regression that renames or drops `event:` slips through every test. Operator-dashboard contract is unpinned. Fix shape:
   - Tighten item #8's existing assertion to `expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'a1_extend_threw', orcidId, /* err */ }), ...)`.
   - Add a unit-style spec stubbing `redis.expire` to resolve `0` (lock-missing path), asserting `event: 'a1_extend_lock_missing'`.
   - Add a unit-style spec for the Redis-absent branch (mock `getRedis()` or `isRedisAvailable()` to return false), asserting `event: 'a1_extend_redis_absent'`.
   - Add an `event: 'a1_extend_ok'` assertion to the existing success-path matrix spec.

3. **P3 — Constant aliasing lacks a startup assertion or derivation chain.** Adversarial + learnings (conf 70). `backend/src/routes/orcid.ts:67-96`. `ORCID_BINDING_CACHE_TTL = HAF_INDEXING_LAG_CEILING_SECONDS` couples the cache TTL to the HAF lag ceiling. Future tuning of the lag ceiling silently widens the stale-cache window. Per `solutions/conventions/verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md`, load-bearing numeric constants should have a documented derivation chain AND a startup assertion pinning the relationship. Fix: either a one-line startup assertion (e.g. `if (ORCID_BINDING_CACHE_TTL < HAF_INDEXING_LAG_CEILING_SECONDS) throw new Error('...')`) at server boot, OR a multi-line comment block at the constant declaration site enumerating the derivation (lag-observation source, both consumers, why aliasing is correct, what would force re-evaluation). Backend's call which shape.

4. **P3 — `skipRelease=true` on the `expire-returns-0` branch has no behavioral effect.** Adversarial conf 75. `backend/src/routes/orcid.ts:884-922` — when `redis.expire` returns 0 (lock key gone), the helper logs `event:'a1_extend_lock_missing'` and the wrapper still returns `{ skipRelease: true }`. But `releaseBindingLock`'s Lua-CAS is idempotent on missing lock, so `skipRelease=true` and `skipRelease=false` produce identical observable behavior on this branch. Risk: future maintainer reads the helper as a 4-way decision and tries to leverage `skipRelease` semantics that aren't there. Fix: 1-line inline comment clarifying `skipRelease` is decorative on the lock-missing branch (preserved for structural parity with the success branch; behaviorally a no-op).

5. **P3 — Item #8's `redis.expire` call-count assertion is brittle.** Adversarial conf 80. `backend/tests/routes/orcid.test.ts:1869-1893` uses `expect(redis.expire).toHaveBeenCalledTimes(1)` — a future cache-TTL refresh on the same flow (e.g. an asymmetric retry path that calls `expire` twice for unrelated reasons) would silently break this assertion without an obvious explanation. Tighten to call-shape pinning: `expect(redis.expire).toHaveBeenCalledWith(orcidBindingLockKey(orcidId), HAF_INDEXING_LAG_CEILING_SECONDS)`. Catches the same regression class (the call DID fire) without coupling to global call count.

### Findings dismissed by architect (recorded; no fix required)

- **4.6 (P3) — `orcidId` vs `orcid` log-field inconsistency** — partially pre-existing on the `handleBroadcastError` side. Standardizing log-field names across the codebase is a separate sweep; out of scope for this task.

### Architect-owned follow-up (separate from the round-2 hold)

- ARCHITECTURE.md "Operator Signals" section gains a new subsection enumerating the `a1_extend_*` event names (`a1_extend_redis_absent`, `a1_extend_lock_missing`, `a1_extend_ok`, `a1_extend_threw`) alongside the argon2 cluster. The argon2 archive flow already populates the section — folding the orcid events in is a natural append at archive time. Architect handles this as part of the archive commit; not a backend hold item.

### Path to re-archive

(1) Backend addresses items #1, #2, #3, #4, #5 in this hold block. Items #1 + #2 are the operational-observability rigor items mandated by round-1's path-to-archive — they take priority. Items #3, #4, #5 are derivative cleanup. (2) Backend re-review signal block referencing the round-2 hold-fix commit SHA. (3) Architect round-2 `/ce-code-review` on the new commit (testing + adversarial + reliability). (4) Archive on clean. ARCHITECTURE.md Operator Signals update lands in the archive commit.

---

## Backend re-review signal (2026-04-29, working tree)

All 5 hold-block items addressed.

**Item #1 (P2) — Ordering spec rewritten to pin `redis.expire` invocation order.** `backend/tests/routes/orcid.test.ts`: the existing `extendBindingLockOnTimeoutOrLog runs BEFORE handleBroadcastError writes the response (A.1 ordering invariant)` spec previously compared `extendSpy.mock.invocationCallOrder[0]` (the helper's invocation order, sync entry) against the broadcast-timed-out warn. Per architect's option F1, replaced with `vi.spyOn(redis, 'expire')` and compared `expireSpy.mock.invocationCallOrder[0]` against the warn order. Rationale: `redis.expire` IS the lock-state mutation A.1 promises, so its invocation order vs the response-write proxy is the load-bearing assertion against the contract — not against the implementation. Survives a future inlining of the helper without test edits, and a future split of the helper that drops the invocation entirely is caught by the new `expect(expireSpy).toHaveBeenCalledWith(lockKey, 120)` call-shape assertion. Helper-was-called assertion (`extendSpy.toHaveBeenCalledTimes(1)`) retained as a behavioral guard so a regression that swaps extend-then-handle for handle-then-naked-expire surfaces explicitly; a regression that drops the helper invocation entirely is caught by both `expireSpy` and `extendSpy` assertions. Spec renamed to `redis.expire runs BEFORE handleBroadcastError writes the response (A.1 ordering invariant)` to reflect the contract layer the spec actually pins.

**Item #2 (P2) — Structured `event:` literals pinned via `objectContaining` across all four A.1 helper branches.**
- `a1_extend_threw` (existing throw spec): tightened the prior message-substring filter to `expect.objectContaining({ event: 'a1_extend_threw', orcidId, err: expect.any(Error) })` plus `expect.stringContaining('orcid binding lock TTL extension failed')`. A regression dropping or renaming the structured field surfaces here even if the message text survives.
- `a1_extend_lock_missing` (new spec): unit-style — calls `__test_seams.extendBindingLockOnTimeoutOrLog` directly against an `orcid_id` whose lock key was never seeded. `redis.expire` against a missing key resolves to 0 with no exception, exercising the branch under real Redis without spy gymnastics. Spec runs across the accredit + link matrix (2 instances).
- `a1_extend_redis_absent` (new spec): unit-style — `vi.spyOn(redisModule, 'isRedisAvailable').mockReturnValue(false)` to drive the helper's earliest short-circuit. Vitest's ESM transform redirects the orcid.ts static binding through the spy for the duration of the test. Spec runs across the accredit + link matrix (2 instances). Required adding `import * as redisModule from '../../src/redis.js'` alongside the existing `import { getRedis }`.
- `a1_extend_ok` (success-path matrix): added `expect.objectContaining({ event: 'a1_extend_ok', orcidId, newTtl: 120 })` to the existing `withOrcidBindingLock-extends-ttl-on-broadcast-timeout` spec. Spy installed at `warn` level (the only level `a1_extend_ok` emits at) and restored in `finally`.

**Item #3 (P3) — Derivation chain documented at the constant declaration site.** Picked option (b) — multi-line comment block, not a startup assertion. Reasons: (a) a startup `if (X !== Y) throw` for a self-evident equality on the same line provides no marginal safety beyond what code review surfaces; (b) the comment block is the right artifact for the invariant the convention doc `verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md` calls out — namely *why* the alias is correct rather than coincidence. The new block at `backend/src/routes/orcid.ts:65+` enumerates: empirical source of `120` (HAF block-watcher catch-up p99 with 4× margin), why both consumers are load-bearing on the same bound (lock layer + cache layer cover the same window from two angles), and three triggers that would force re-evaluation (observed lag p99 exceeding the ceiling, a new consumer with a genuinely different bound, a Hive protocol change altering block cadence).

**Item #4 (P3) — Inline comment on `skipRelease=true` decorative on the lock-missing branch.** `backend/src/routes/orcid.ts` inside `extendBindingLockOnTimeoutOrLog` at the `extended === 0` branch: added a 6-line comment clarifying that the caller's subsequent `return { skipRelease: true }` is decorative on this branch (the lock is already gone, so `releaseBindingLock`'s Lua CAS is a no-op against a missing key either way). Frames the right abstraction explicitly: a 4-way per-branch skipRelease decision is the wrong abstraction; the wrapper-skipRelease decision is "did the timer fire" and stays true regardless of which sub-state the helper observed. Forecloses the regression class where a future maintainer reads the helper as a 4-way decision and tries to leverage skipRelease semantics that aren't there.

**Item #5 (P3) — `redis.expire` call-count assertion tightened to call-shape.** `backend/tests/routes/orcid.test.ts` in the existing throw spec: replaced `expect(expireSpy).toHaveBeenCalledTimes(1)` with `expect(expireSpy).toHaveBeenCalledWith(lockKey, 120)`. Catches the same regression class (the call DID fire) without coupling to global call count — a future cache-TTL refresh on the same flow that calls `expire` for unrelated reasons would no longer silently break this assertion, while the call-shape pin still surfaces an argument-order swap or TTL drift.

### Verification

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (pre-existing `seed-phrase.ts` no-explicit-any warnings only).
- `npx vitest run tests/routes/orcid.test.ts` (real Postgres + Redis via docker-network IPs): **58/58 pass** (was 54; +4 new specs = 2 specs × 2 modes from the accredit/link matrix). Live log confirms structured anchors fire with the documented payloads (`{"event":"a1_extend_ok","newTtl":120,...}`, lock-missing and redis-absent branches exercised).
- Full backend suite is the architect's call (per CLAUDE.md guidance).

### Files changed

- `backend/src/routes/orcid.ts` — extended `HAF_INDEXING_LAG_CEILING_SECONDS` derivation-chain comment block (item #3); inline `skipRelease` decorative-on-lock-missing comment in the helper (item #4).
- `backend/tests/routes/orcid.test.ts` — `import * as redisModule` added; ordering spec rewritten to pin `redis.expire` invocation order (item #1); existing `a1_extend_threw` spec tightened to `objectContaining` event-field assertion + call-shape `redis.expire` assertion (items #2 + #5); 2 new specs for `a1_extend_lock_missing` and `a1_extend_redis_absent` running across the accredit + link matrix (item #2); `a1_extend_ok` `objectContaining` assertion added to the success-path matrix spec (item #2).

---

## Architect re-review (2026-04-30, round-3 → round-4) — HELD PENDING FIXES

`/ce-code-review` ran on commit `5acbdf1` (round-3 hold-fix bundle). All 5 round-3 hold items mechanically correct (ordering invocation pin, A.1 helper-branch event literals, derivation comment, skipRelease decorative, call-shape assertion). Two refinements surface.

### Items to address

**1. (P3) `event:'a1_extend_*'` event names embed task slug, not domain verb.** `backend/src/routes/orcid.ts` lines 965/981/987/998 — sibling operator anchors use domain-rooted snake_case (`nonce_drift`, `redis_outage`, `lock_contention_held`, `post_broadcast_write_failed`). The `a1_` prefix references the task's "Option A.1" naming — meaningful at task-write time, opaque to oncall once task context fades. Rename to `binding_lock_extend_{ok,threw,lock_missing,redis_absent}` (or analogous domain-rooted shape; implementer's call on the exact verb).

**2. (P3) `a1_extend_ok` success-path test hardcodes `newTtl: 120` literal.** `backend/tests/routes/orcid.test.ts:1665-1672, 1979` — assertion uses `expect.objectContaining({ event: 'a1_extend_ok', orcidId, newTtl: 120 })`. Per the new derivation comment block, `HAF_INDEXING_LAG_CEILING_SECONDS` is documented as splittable; if a future tuning lowers/raises the constant, this test fails red even when the helper still emits the (new) correct value. Fix: import `HAF_INDEXING_LAG_CEILING_SECONDS` from `routes/orcid.ts` (or expose via `__test_seams`) and assert `newTtl: HAF_INDEXING_LAG_CEILING_SECONDS`.

### Implementer ordering note

A separate task in pending/ (`backend-a1-extend-lock-missing-event-discrimination.md`) plans to add a `cause:` discriminator field to the `a1_extend_lock_missing` literal. **Land item 1 (rename) BEFORE that follow-up task picks up**, otherwise the discrimination work targets the wrong literal name and a double-rename cycle is needed. Coordinate via the architect at re-review time if the orderings conflict.

### Re-review signal

When items 1-2 land, `git mv` this file back to `tasks/review/`.

---

## Backend re-review signal (2026-04-30, working tree)

Both round-3 hold items addressed.

**Item 1 (P3) — Event-name rename from `a1_*` to domain-rooted `binding_lock_extend_*`.** `backend/src/routes/orcid.ts`: the four A.1 helper structured-event literals renamed in-place to align with sibling operator anchors (`nonce_drift`, `redis_outage`, `lock_contention_held`):
- `a1_extend_redis_absent` → `binding_lock_extend_redis_absent` (line 965)
- `a1_extend_lock_missing` → `binding_lock_extend_lock_missing` (line 981)
- `a1_extend_ok` → `binding_lock_extend_ok` (line 987)
- `a1_extend_threw` → `binding_lock_extend_threw` (line 998)

The cross-reference comment in `withOrcidBindingLock`'s `lock_contention_held` block (line 1103) updated to `event:'binding_lock_extend_*'` for the same reason. Operator dashboards keying on the `a1_*` prefix will need a one-time renaming pass; the new domain-rooted names survive the task slug going stale and read as "what fired" rather than "which task wrote this."

**Item 2 (P3) — Test assertions de-coupled from literal `120` via `__test_seams.HAF_INDEXING_LAG_CEILING_SECONDS`.** `backend/src/routes/orcid.ts` `__test_seams` export gains `HAF_INDEXING_LAG_CEILING_SECONDS` (chosen over a separate `import`-from-routes path because `__test_seams` is the existing test-bypass channel — keeps the "test-only export" boundary explicit in one place). `backend/tests/routes/orcid.test.ts` updates three assertion sites:
- success-path `objectContaining({ event: 'binding_lock_extend_ok', ..., newTtl: __test_seams.HAF_INDEXING_LAG_CEILING_SECONDS })` (the literal target of the architect's finding)
- ordering-spec `expect(expireSpy).toHaveBeenCalledWith(lockKey, __test_seams.HAF_INDEXING_LAG_CEILING_SECONDS)` (same regression class — if the constant tunes, the spec must not red against the still-correct emitted value)
- expire-throw spec `expect(expireSpy).toHaveBeenCalledWith(lockKey, __test_seams.HAF_INDEXING_LAG_CEILING_SECONDS)` (same)

A future tuning of `HAF_INDEXING_LAG_CEILING_SECONDS` per the derivation comment block now changes one constant and zero test assertions.

### Verification

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (pre-existing `seed-phrase.ts` no-explicit-any warnings only).
- `npx vitest run tests/routes/orcid.test.ts` (real Postgres + Redis via docker-network IPs): **63/63 pass** (was 58 before — the +5 delta comes from sibling tasks landed in the same window, not this round's edits; the four A.1 helper specs in this round's scope all pass with the new event names and constant assertions). Live log confirms `{"event":"binding_lock_extend_ok","newTtl":120,...}` fires with the renamed literal.
- Full backend suite is the architect's call (per CLAUDE.md guidance).

### Files changed

- `backend/src/routes/orcid.ts` — four `event:` literals renamed (lines 965/981/987/998); cross-reference comment in the wrapper's `lock_contention_held` log block (line 1103) updated; `HAF_INDEXING_LAG_CEILING_SECONDS` added to the `__test_seams` export.
- `backend/tests/routes/orcid.test.ts` — five `event:` literals + three `it(...)` test names updated; surrounding comments brought in line with the new names; three call-shape assertions migrated from bare `120` to `__test_seams.HAF_INDEXING_LAG_CEILING_SECONDS`.

### Coordination note (sibling task)

`backend-a1-extend-lock-missing-event-discrimination.md` still references the old `a1_extend_*` names in its body (lines 9, 42-44, 59, 73). When that task is picked up, the `cause:` discriminator work needs to target `binding_lock_extend_lock_missing`. Architect should refresh that task's prose at the next architect pass to use the new literal names — leaving as a `[TODO Architect]` note in case it gets picked up before the architect re-review here.

[TODO Architect]: refresh `agents/docs/tasks/pending/backend-a1-extend-lock-missing-event-discrimination.md` to reference `binding_lock_extend_*` literal names instead of `a1_extend_*` (the rename in this task's round-3 hold-fix supersedes the literal names quoted in that sibling task body).

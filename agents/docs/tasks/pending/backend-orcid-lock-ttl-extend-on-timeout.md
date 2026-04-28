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



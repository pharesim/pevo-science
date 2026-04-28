# BACKEND-ORCID-ACQUIRED-BRANCH-THROW-GUARD — Wrap `withOrcidBindingLock`'s 'acquired' branch in try/catch to close the symmetric hard-block class

**Owner:** backend
**Created:** 2026-04-28 (architect, surfaced by round-2 review of `BACKEND-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING`)
**Priority:** P1

## Context

Round-1 of `BACKEND-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING` (item #3) closed a silent-regression class on `withOrcidBindingLock`'s `'unavailable'` branch: a throw inside `fn` while Redis was down combined with the OAuth state token already being consumed → 500 INTERNAL_ERROR + user hard-blocked, must restart OAuth. Round-2 fix: wrapper now ALWAYS wraps `await fn()` in try/catch on the `'unavailable'` branch and emits the 504 ambiguous-outcome envelope.

Round-2 architect re-review surfaced that the **`'acquired'` branch (Redis healthy)** has the symmetric gap. The current shape is:

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

`try { ... } finally { release }` — **no catch**. Two distinct throw classes escape this branch and hit the outer `/callback` catch as 500 INTERNAL_ERROR with the state token already consumed:

1. **Pre-broadcast sync throw inside fn.** E.g., `PrivateKey.fromString(config.pevoAdminPostingKey)` at `backend/src/routes/orcid.ts:495` and `:577` with a malformed admin key, the `crypto.createHash` call building `evidence_hash`, or any sync code in fn before the inner `try { broadcastJsonWithTimeout }`. Adversarial reviewer flagged this with confidence 90 during round-2.

2. **Post-broadcast async throw inside fn.** Broadcast SUCCEEDS, then `cacheOrcidBinding`/`updateAccountOrcid`/`seedAccreditationBonus` throws. Most concretely: `getAppPool()` is called inside `updateAccountOrcid` at line 983 OUTSIDE that function's own try/catch (which only wraps `pool.query()`). A pool-exhaustion throw escapes `updateAccountOrcid` → escapes fn (broadcast already returned) → wrapper's `'acquired'`-branch try/finally has no catch → 500 INTERNAL_ERROR. User gets a hard 500 even though the chain write succeeded; no recovery breadcrumb. Reliability reviewer flagged this with confidence 90 during round-2.

Both classes reproduce the same user-visible failure mode round-1 #3 was meant to close: consumed-state-token + 500 + no recovery. Just on the symmetric (Redis-healthy) branch.

## Why this wasn't covered by round-2

Round-1 hold's stated scope was the `'unavailable'` branch — round-2 correctly closed that. The `'acquired'`-branch gap is structurally adjacent but was not in the round-1 hold's scope, so adding it would have expanded the hold cycle. Filed as a follow-up task.

## Goal

Add a try/catch on the `'acquired'`-branch's `await fn()` so any throw escaping fn produces an ambiguous-outcome envelope (504 BROADCAST_TIMEOUT) rather than a 500 INTERNAL_ERROR with consumed state token.

## Coordination

This task layers on top of `BACKEND-ORCID-LOCK-TTL-EXTEND-ON-TIMEOUT` (`81795fd`, `tasks/review/backend-orcid-lock-ttl-extend-on-timeout.md` — currently in this same architect review batch). That task introduced the `skipRelease` return-value contract on fn's `'acquired'` branch. The new try/catch must:

- Preserve the `skipRelease` semantics for successful timeout-handling paths.
- NOT skip release on caught throws (the fn body's BroadcastTimeoutError catch already handles its own skipRelease via the redis.expire + `return { skipRelease: true }` shape; the new wrapper-level catch is ONLY for throws that escape fn's inner catches).

## Acceptance

### Implementation

1. Restructure the `'acquired'` branch in `withOrcidBindingLock` (around `backend/src/routes/orcid.ts:780`):
   ```ts
   } else if (lock.state === 'acquired') {
     let skipRelease = false;
     try {
       const result = await fn();
       if (result?.skipRelease) skipRelease = true;
     } catch (err) {
       handleBroadcastError(res, err, { ...ambiguousOutcomeOpts, forceAmbiguousOutcome: true });
       // Do NOT set skipRelease — release the lock so a subsequent retry
       // (after the user verifies state at /settings) can acquire it.
     } finally {
       if (!skipRelease) {
         await releaseBindingLock(orcidId, lock.nonce);
       }
     }
   }
   ```
   The catch uses the SAME envelope shape as the `'unavailable'` branch: `forceAmbiguousOutcome:true` → 504 BROADCAST_TIMEOUT with `outcome:'uncertain'`, `verify_before_retry:true`, `verify_location:'/settings'`. (NB: if the parent task `BACKEND-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING` round-2 hold-fix lands the discriminated-union refactor of `HandleBroadcastErrorOpts` first, this catch should call the new `handleBroadcastErrorAmbiguous(...)` entry point instead of building the spread inline — coordinate via task ordering or a follow-up no-op refactor here.)

2. Lock release semantics: throws release the lock (skipRelease stays false). Successful skipRelease (the BroadcastTimeoutError + redis.expire path inside fn) still skips. The test for `81795fd`'s skipRelease semantics must still pass.

3. **Decision needed during implementation:** for post-broadcast throws (where the chain write actually landed), the 504 `outcome:'uncertain'` envelope is technically over-cautious — the outcome is confirmed success + a downstream write failure, not "uncertain". Per the parent task's architect note (Finding #4 from round-2 review), this is filed as a separate task `backend-orcid-broadcast-outcome-discrimination.md` — discriminating broadcast-succeeded vs broadcast-threw is out of scope here. This task ships the over-cautious envelope; the discrimination task can later swap the post-broadcast throw to a 502 POST_BROADCAST_FAILED envelope without re-touching the wrapper.

### Tests

4. **New test:** `withOrcidBindingLock-acquired-branch-pre-broadcast-sync-throw`. Inject an `fn` whose first synchronous statement throws (synthetic `Error('synthetic pre-broadcast sync throw')`). Acquired-branch lock is held (Redis healthy). Assert:
   - `res.status === 504`, `res.body.error.code === 'BROADCAST_TIMEOUT'`
   - `res.body.error.details.outcome === 'uncertain'`, `verify_before_retry: true`, `verify_location: '/settings'`
   - `res.body.error.details.timeout_ms` is OMITTED (the throw is not a BroadcastTimeoutError)
   - `redis.exists(orcidBindingLockKey(orcidId)) === 0` (lock released; user can retry after verification)

5. **New test:** `withOrcidBindingLock-acquired-branch-post-broadcast-async-throw`. Broadcast resolves successfully; `getAppPoolMock.mockImplementationOnce` (or the named seam if `BACKEND-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING` round-2 #2 hold-fix landed (i)/(ii)) throws on the post-broadcast call inside `updateAccountOrcid`. Acquired-branch lock is held. Assert:
   - Same 504 envelope shape as test #4 above (no `timeout_ms`).
   - `broadcastJsonMock.mock.calls.length === 1` (broadcast did fire and succeed).
   - Lock released (`redis.exists(...) === 0`).
   - **Mutation kill:** removing the new wrapper try/catch routes the throw to outer `/callback` catch as 500 INTERNAL_ERROR; assertion `res.status === 504` fails.

6. **Regression:** existing `withOrcidBindingLock-extends-ttl-on-broadcast-timeout` test (from `81795fd`) still passes — the BroadcastTimeoutError path inside fn still returns `{ skipRelease: true }`, the new wrapper catch does NOT fire (the throw was caught by fn's inner catch), and the lock TTL extension behavior is preserved.

### Doc updates (architect-owned, deferred)

- `agents/docs/api-contracts/orcid.md` — extend the 504 entry's already-updated unavailable-branch call-out to also cover the `'acquired'`-branch pre-broadcast and post-broadcast throw cases. Architect lands this on next review pass.
- Convention doc `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — add a paragraph that the wrapper's symmetric pattern (catch on BOTH branches) is the convention; one branch with catch and one without is an anti-pattern.

## Non-goals

- Discriminating broadcast-succeeded from broadcast-threw on the post-broadcast path — that's `backend-orcid-broadcast-outcome-discrimination.md`.
- Generalizing this pattern to other broadcast wrappers — separate sweep tracked at `backend-sendoperations-outcome-handling-sweep.md`.
- Refactoring the wrapper to options-object — round-2 dismissed (two callers, no third yet).

## Source

- `agents/docs/tasks/pending/backend-orcid-broadcast-timeout-outcome-handling.md` round-2 architect re-review (2026-04-28) — Finding #2 (P1 conf 90) and pre-existing #P2 (P2 conf 90).
- `backend/src/routes/orcid.ts:780-797` — current `withOrcidBindingLock` 'acquired' branch shape.
- `backend/src/routes/orcid.ts:982-984` — `getAppPool()` call outside `updateAccountOrcid`'s try.

---

## Implementation landed (2026-04-28, commit `0d0c156`)

Round-1 implementation. Wrapper restructure + 4 new specs landed in a single commit. Layered on top of the parent task's round-2 hold-fix (commit `0a5c890`), which ships the discriminated-union opts and `handleBroadcastErrorAmbiguous` entry point this task consumes.

### Wrapper change — symmetric try/catch on `'acquired'` branch

`backend/src/routes/orcid.ts` `withOrcidBindingLock`:

```ts
} else if (lock.state === 'acquired') {
  let skipRelease = false;
  try {
    const result = await fn('acquired');
    if (result?.skipRelease) skipRelease = true;
  } catch (err) {
    handleBroadcastErrorAmbiguous(res, err, ambiguousOutcomeOpts);
    // Do NOT set skipRelease — release the lock so a subsequent retry
    // (after the user verifies state at /settings) can acquire it.
  } finally {
    if (!skipRelease) {
      await releaseBindingLock(orcidId, lock.nonce);
    }
  }
}
```

Closes both throw classes the round-2 review identified:
- **Pre-broadcast SYNC throws inside fn** — `PrivateKey.fromString` on malformed admin key, `crypto.createHash` building `evidence_hash`, or any other sync code in fn before the inner `try { broadcastJsonWithTimeout }`.
- **Post-broadcast ASYNC throws inside fn** — broadcast SUCCEEDS, then `cacheOrcidBinding` / `__test_seams.updateAccountOrcid` / `seedAccreditationBonus` throws.

Both classes previously consumed the OAuth state token at dispatch and produced 500 INTERNAL_ERROR + user hard-blocked. Now they route through the SAME 504 ambiguous-outcome envelope as the `'unavailable'` branch.

Lock release semantics: caught throws don't set `skipRelease`, so the `finally` releases under the nonce CAS — a subsequent retry can acquire cleanly. Successful `skipRelease` (the `BroadcastTimeoutError` + `redis.expire` path inside fn) still skips. Tests pin both contracts.

### Tests — 4 new specs in `tests/routes/orcid.test.ts`

In the existing `describe.each(['accredit', 'link'])` SEC-002-TOCTOU-LOCK block:

- **Pre-broadcast SYNC throw on acquired branch** — `PrivateKey.fromString` stub throws synthetically before broadcast. Asserts 504 BROADCAST_TIMEOUT + `outcome:'uncertain'` + `verify_before_retry:true` + `verify_location:'/settings'`; `timeout_ms` ABSENT (the throw isn't a `BroadcastTimeoutError`); message uses `ambiguousMsg` (regression guard for round-2 #1's discriminated union); broadcast NEVER fired; lock RELEASED for retry; cache absent; operator-alert anchor log fired at error level.

- **Post-broadcast ASYNC throw on acquired branch** — `vi.spyOn(__test_seams, 'updateAccountOrcid').mockRejectedValueOnce(...)` (round-2 #2's seam) injects the throw deterministically. Asserts 504 envelope (initially); `broadcastJsonMock` called EXACTLY ONCE (mutation-kill anchor — proves the throw came from a post-broadcast cascade, not a re-entered fn or double-broadcast); lock RELEASED.

  **Note**: this spec was rewritten to assert 502 POST_BROADCAST_FAILED in the immediately-following commit `d8b9b75` (BACKEND-ORCID-BROADCAST-OUTCOME-DISCRIMINATION) — discrimination took the round-1 over-cautious envelope and replaced it with `outcome:'confirmed'` + `tx_id` + `failed_step`. Don't re-review this spec's 504 history; the tests as of `d8b9b75` are the contract.

Each new spec in the matrix runs across both `accredit` and `link` modes (`describe.each`) so 4 assertion-pairs total.

### Mutation kills

- Removing the wrapper's new acquired-branch `try/catch` propagates either throw class to the outer `/callback` catch as 500 INTERNAL_ERROR; `expect(res.status).toBe(504)` (or `502` post-discrimination) fails.
- Removing `forceAmbiguousOutcome:true` from `accreditAmbiguousOpts` / `linkAmbiguousOpts` is a TypeScript-level error after round-2 #1's discriminated union; a bypass would re-route the throw to a 502 BROADCAST_FAILED envelope and fail the BROADCAST_TIMEOUT (or POST_BROADCAST_FAILED) assertion.
- Removing the `instanceof PostBroadcastWriteError` discrimination check in `handleBroadcastError` would fall through to the `BroadcastTimeoutError` or `forceAmbiguousOutcome` branch → 504 envelope; `outcome === 'confirmed'` assertion fails.

### Verification

- `npx vitest run tests/routes/orcid.test.ts`: 48 passed (was 44 pre-acquired-branch; +4 = 2 new specs × 2 modes).
- `npx vitest run` (full backend suite, real Postgres + Redis): 593 passed, 4 pre-existing skipped — clean.
- `npm run lint`: clean.
- `npx tsc --noEmit`: clean.

### Files changed (commit `0d0c156`)

- `backend/src/routes/orcid.ts` — wrapper acquired-branch `try/catch` + ambiguous-outcome routing.
- `backend/tests/routes/orcid.test.ts` — 2 new specs in the `describe.each` block (×2 modes).

### Architect-owned (deferred per backend CLAUDE.md "architect owns contract edits")

- `agents/docs/api-contracts/orcid.md` — extend the 504 entry's already-updated `'unavailable'`-branch call-out to also cover the `'acquired'`-branch pre-broadcast and post-broadcast throw cases. (Note: the post-broadcast case at `'acquired'` now emits 502 POST_BROADCAST_FAILED per the immediately-following discrimination commit; the contract update should reflect both envelopes.)
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — add a paragraph that the wrapper's symmetric pattern (catch on BOTH branches) is the convention; one branch with catch and one without is an anti-pattern.

---

## Architect re-review (2026-04-28, round-1) — HELD PENDING FIXES

Round-1 `/ce-code-review` on commit `0d0c156` (11 personas: correctness, testing, maintainability, project-standards, ce-agent-native, ce-learnings, security, reliability, api-contract, adversarial, kieran-typescript). Wrapper restructure is structurally correct; lock release semantics, BroadcastTimeoutError + skipRelease invariant, and state-token replay all clean. **No P0/P1 in code.** Architect-applied in-place fixes during this review pass cleared four findings (JSDoc 'acquired' bullet stale, NB comment about discrimination already-landed, convention-doc symmetric-branch paragraph added, contract docs updated for both 504 trigger paths and `POST_BROADCAST_FAILED`). One backend test-tightening item remains held.

**The architect applied 5 in-place fixes during this review pass (override-the-rule for backend, user-authorized; architect-owned doc fixes need no override):**

- `backend/src/routes/orcid.ts:856-867` — JSDoc summary's `'acquired'` bullet rewritten. Previously said "Throws from fn propagate to the outer /callback catch (mapped to 500 INTERNAL_ERROR)"; after `0d0c156` the wrapper catch intercepts. Now describes the symmetric catch + handleBroadcastErrorAmbiguous routing and notes the inner-catch envelope discrimination (BroadcastTimeoutError → 504 + lock-TTL extend, non-timeout broadcast errors on 'acquired' → 502 BROADCAST_FAILED, PostBroadcastWriteError → 502 POST_BROADCAST_FAILED, anything else lands on the outer catch).
- `backend/src/routes/orcid.ts:969-980` — NB comment updated. Round-1 said discrimination was "filed separately" as a future task; commit `d8b9b75` (immediately following) shipped it. Now describes the post-broadcast 502 POST_BROADCAST_FAILED path as live, and points at the new `backend-pevo-admin-key-startup-validation.md` follow-up for the remaining pre-broadcast SYNC class.
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — added the architect-deferred "Symmetric-branch convention" section. States the wrapper MUST carry an outer try/catch on every execution branch (`acquired` AND `unavailable`); one branch with catch and one without is an anti-pattern. Includes the canonical `'acquired'`-branch shape (try/catch/finally with skipRelease handling) for new implementers to copy.
- `agents/docs/api-contracts/orcid.md:197+` — 504 BROADCAST_TIMEOUT entry rewritten to enumerate three trigger paths: timer-fire on lock-acquired, non-timer throw on lock-unavailable, pre-broadcast SYNC throw on lock-acquired. `details.timeout_ms` presence rule documented per path. New `POST_BROADCAST_FAILED` (502) entry added documenting `details.outcome:'confirmed'`, `tx_id`, `failed_step`, and the "treat as success in UI; surface to operators" guidance.
- `agents/docs/api-contracts/common.md:72-74` — added new `POST_BROADCAST_FAILED` row to the standard error table; updated `BROADCAST_TIMEOUT` parenthetical to include the lock-wrapper acquired-branch pre-broadcast SYNC throw case.

### Items held pending fixes (backend-owned)

1. **P3 — Operator-alert log assertions use `toBeGreaterThanOrEqual(1)` instead of `toBe(1)`** at `backend/tests/routes/orcid.test.ts:1340` (pre-broadcast SYNC spec) and `:1441` (post-broadcast ASYNC spec). The same spec comment blocks state the assertion is mutation-kill rigor; a stricter `toBe(1)` matches the stated intent and catches double-emit regressions. Two-line change. Suggested fix:
   ```ts
   // line 1340
   expect(ambiguousCalls.length).toBe(1);
   // line 1441
   expect(postBroadcastCalls.length).toBe(1);
   ```

### Findings routed elsewhere

- **F1 (P2, 3-reviewer convergence agent-native + reliability + adversarial, conf 100)** — Pre-broadcast SYNC throws on `'acquired'` branch (`PrivateKey.fromString` on malformed admin key) route through the 504 ambiguous-outcome envelope. No broadcast fired; the user has nothing to verify; the operator alert label routes to broadcast-on-call when the actual root cause is admin-key configuration. Filed as new task `agents/docs/tasks/pending/backend-pevo-admin-key-startup-validation.md` — validate the admin key at server boot so a malformed key fails the boot path rather than reaching this catch in production.

### Pre-existing in-scope (not held; surfaced for visibility)

- **CI-without-Redis silently skips lock-release assertions.** `backend/tests/routes/orcid.test.ts:1284` and `:1387` early-return on `if (!redis) return`. The `redis.exists(orcidBindingLockKey)` assertion is the primary mutation-kill anchor for the new catch's release semantics. In CI environments without Redis, these specs pass silently with the assertion never firing. Pre-existing pattern across multiple specs in this file; not introduced by this commit. Worth filing as a generic test-hardening follow-up.

### Suppressed at confidence gate

AN-002 lockState absent from logContext (P3 obs, conf <75 — cosmetic), adv-002 skipRelease mutation kill implicit only (P3 info, conf 75), adv-003 PrivateKey spy leak risk (P3 info, conf 50), KTS-001 handleBroadcastErrorAmbiguous return value discarded (info, conf 90 but non-actionable), KTS-002 lockState named-type extraction (info, conf 75 nice-to-have), testing TG `cache_write` integration coverage (pre-existing architectural gap).

### Path to re-archive

(1) Backend addresses item #1 in this hold block (2-line `toBe(1)` tightening). (2) Backend re-review signal block referencing the round-2 hold-fix commit SHA. (3) Architect round-2 `/ce-code-review` on the new commit (testing-focused). (4) Archive on clean. The `backend-pevo-admin-key-startup-validation.md` follow-up task is independent and does not block this task's re-archive.


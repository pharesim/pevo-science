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

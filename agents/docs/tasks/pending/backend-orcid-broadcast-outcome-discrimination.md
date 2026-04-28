# BACKEND-ORCID-BROADCAST-OUTCOME-DISCRIMINATION — Discriminate "broadcast succeeded, post-broadcast threw" from "broadcast threw" in the ambiguous-outcome envelope

**Owner:** backend
**Created:** 2026-04-28 (architect, surfaced by round-2 review of `BACKEND-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING`)
**Priority:** P2

## Context

`BACKEND-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING` round-2 (commits `df264d7..27befcf`) shipped the `forceAmbiguousOutcome:true` envelope on `withOrcidBindingLock`'s `'unavailable'`-branch try/catch. When fn throws inside that branch, the wrapper emits 504 BROADCAST_TIMEOUT with `details.outcome:'uncertain'`, `verify_before_retry:true`. The wrapper has no signal to discriminate WHICH throw class fired:

- **Broadcast threw before completing:** `broadcastJsonWithTimeout` fired the timer (BroadcastTimeoutError) or threw a non-timer error (RPC reject, network error). Outcome IS uncertain.
- **Broadcast SUCCEEDED, post-broadcast call threw:** e.g., `getAppPool()` inside `updateAccountOrcid` at `backend/src/routes/orcid.ts:983` (called OUTSIDE that function's own try) throws on DB pool exhaustion. The chain write IS confirmed; the throw is a DB-cascade failure. Outcome is NOT uncertain — it's confirmed success + a downstream write failure.

Today both classes get the same envelope. UX recovers: the user is told to "verify your ORCID linkage at /settings" and `/settings` will show success for the post-broadcast-throw class (cache-write may have skipped, but `findAccreditedAccountWithOrcid` will still see the chain op once HAF indexes). But operator alert quality is degraded:

- Alerts keyed on 504 BROADCAST_TIMEOUT will fire on confirmed-write + DB-cascade failures.
- Operator pages mention "broadcast outcome uncertain" → wakes the wrong on-call (broadcast-side) when the actual root cause is DB-side.
- Postmortem timelines mis-attribute incidents.

Reliability reviewer flagged this with confidence 80 during round-2. The framing is: the over-cautious envelope is *safe* (no user data loss, no chain corruption) — just *noisy* on the operator surface.

## Why this wasn't covered by round-2

Round-2 scope was specifically closing the consumed-state-token hard-block class (round-1 #3). Discriminating envelopes on the operator side is a different axis (alert quality, not user UX). Filed as a follow-up task.

This class is also NOT unique to ORCID — any post-broadcast write failure under `withOrcidBindingLock` falls into it. A broader sweep is tracked at `backend-sendoperations-outcome-handling-sweep.md` for non-ORCID broadcast callers; this task scopes ONLY to the ORCID binding path because (a) it's the canonical site, (b) the discrimination shape established here can be reused by the sweep.

## Goal

Discriminate broadcast-succeeded vs broadcast-threw at the `withOrcidBindingLock` catch sites, and emit a different envelope for each:

- **Broadcast-threw class (today's behavior):** 504 BROADCAST_TIMEOUT + `outcome:'uncertain'` + `verify_before_retry:true`. Unchanged.
- **Broadcast-succeeded + post-broadcast threw class (new):** 502 POST_BROADCAST_FAILED + `outcome:'confirmed'` + `details.tx_id: '<broadcast-result-id>'` + `details.failed_step: 'cache_write' | 'account_update' | 'reputation_seed'`. Operator alert pipeline can route this to the DB on-call instead of the broadcast on-call. User-facing message: "Your ORCID is verified on Hive. A backend write to <step> failed; this will reconcile automatically once HAF indexes the op." (No retry needed; the chain op IS the source of truth.)

## Coordination

- Pairs with `backend-orcid-acquired-branch-throw-guard.md` (filed alongside this task) — that task adds the symmetric try/catch on the `'acquired'` branch. Both branches need the same discrimination logic; the discrimination shape lands here, the wrapper-shape lands there. Implement order: acquired-branch-throw-guard first (or in parallel) so this task can apply discrimination to BOTH branches in a single pass.
- Pairs with parent task's hold item #4 (the `handleBroadcastErrorAmbiguous` dedicated entry point on `broadcast-error.ts`). Once that lands, the discriminator can be a second entry point: `handleBroadcastErrorPostBroadcastFailure(res, err, { ...opts, txId, failedStep })`.
- May fold into `backend-sendoperations-outcome-handling-sweep.md` if the discrimination shape is clean enough — implementer's call during scope-up.

## Acceptance

### Implementation

1. **Track `broadcastSucceeded` flag in fn body** for both `handleAccredit` and `handleLink`. Set after `broadcastJsonWithTimeout` returns successfully:
   ```ts
   let broadcastResult: { id: string } | null = null;
   try {
     broadcastResult = await broadcastJsonWithTimeout(...);
   } catch (err) {
     // existing BroadcastTimeoutError + non-timeout handling
     return;  // or skipRelease
   }
   // Post-broadcast cleanup section:
   try {
     await cacheOrcidBinding(orcidId, username);
     await updateAccountOrcid(username, orcidId);
     await seedAccreditationBonus(username);
     sendOk(res, { ..., tx_id: broadcastResult.id });
   } catch (postErr) {
     // Re-throw as a tagged error so wrapper can discriminate.
     throw new PostBroadcastWriteError(broadcastResult.id, postErr, identifyFailedStep(postErr));
   }
   ```

2. **New error class `PostBroadcastWriteError`** in `backend/src/lib/broadcast-error.ts`:
   ```ts
   export class PostBroadcastWriteError extends Error {
     constructor(
       public readonly txId: string,
       public readonly cause: unknown,
       public readonly failedStep: 'cache_write' | 'account_update' | 'reputation_seed' | 'unknown',
     ) {
       super(`Post-broadcast write failed at step '${failedStep}' (tx ${txId})`);
       this.name = 'PostBroadcastWriteError';
     }
   }
   ```

3. **Wrapper catches discriminate by error type:**
   - `err instanceof PostBroadcastWriteError` → emit 502 POST_BROADCAST_FAILED envelope with `tx_id`, `failed_step`, `outcome:'confirmed'`. Lock release happens normally (this is not an uncertainty case; nothing to wait for).
   - Any other throw → emit 504 BROADCAST_TIMEOUT envelope as today (`forceAmbiguousOutcome:true`).

4. **`identifyFailedStep` helper** maps the post-broadcast `try` block's progress to a step label. Cleanest implementation: instrument each post-broadcast call with a step label updated before each await:
   ```ts
   let currentStep: 'cache_write' | 'account_update' | 'reputation_seed' = 'cache_write';
   try {
     await cacheOrcidBinding(orcidId, username);
     currentStep = 'account_update';
     await updateAccountOrcid(username, orcidId);
     currentStep = 'reputation_seed';
     await seedAccreditationBonus(username);
     ...
   } catch (postErr) {
     throw new PostBroadcastWriteError(broadcastResult.id, postErr, currentStep);
   }
   ```

### Tests

5. **New test:** `withOrcidBindingLock-discriminates-post-broadcast-throw-from-broadcast-throw`. Three cases:
   - **Case A — broadcast threw:** `broadcastJsonMock.mockRejectedValueOnce(new Error('rpc reject'))` on `'unavailable'` branch. Assert 504 BROADCAST_TIMEOUT, `outcome:'uncertain'`, NO `tx_id`.
   - **Case B — broadcast succeeded, cache_write threw:** broadcast resolves; `cacheOrcidBindingMock.mockRejectedValueOnce(new Error('redis flap'))`. Assert 502 POST_BROADCAST_FAILED, `outcome:'confirmed'`, `tx_id` matches the mocked broadcast result, `failed_step:'cache_write'`.
   - **Case C — broadcast succeeded, account_update threw:** cache_write resolves; `updateAccountOrcid` throws. Assert 502 POST_BROADCAST_FAILED, `failed_step:'account_update'`.

6. **Regression test:** existing 504 BROADCAST_TIMEOUT specs (from round-1 + round-2 of parent task) still pass with their assertions unchanged. The new envelope ONLY fires when broadcast IS confirmed.

### Doc updates (architect-owned, deferred)

- `agents/docs/api-contracts/common.md` — add 502 POST_BROADCAST_FAILED row distinct from BROADCAST_FAILED (the existing 502 is for chain-side rejection; this new code is for post-broadcast write cascade failures with confirmed chain op). Discriminator: `details.outcome` = `'confirmed'` (POST_BROADCAST_FAILED) vs no `outcome` field (BROADCAST_FAILED).
- `agents/docs/api-contracts/orcid.md` — add 502 POST_BROADCAST_FAILED to `/callback` errors list with the discriminator + frontend-handling guidance.
- Convention doc `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — add a section: "ambiguous outcome ≠ post-broadcast write failure". Subsection on the discrimination pattern.

## Non-goals

- Generalizing to non-ORCID broadcast callers — separate sweep at `backend-sendoperations-outcome-handling-sweep.md`.
- Auto-reconciliation of failed post-broadcast writes (e.g., a background job that retries `cacheOrcidBinding` after a 502 POST_BROADCAST_FAILED) — out of scope; HAF will reconcile via natural indexing within 120s.
- Changing the user-facing message language — the new envelope's message is informational ("ORCID verified on Hive; backend write failed; will reconcile"); no UX redesign needed.

## Source

- `agents/docs/tasks/pending/backend-orcid-broadcast-timeout-outcome-handling.md` round-2 architect re-review (2026-04-28) — Finding #4 (P2 conf 80).
- `backend/src/routes/orcid.ts:983` — concrete trigger site (`getAppPool()` outside `updateAccountOrcid`'s try).
- `backend/src/lib/broadcast-error.ts` — current envelope shapes; new error class lands here.

---

## Implementation landed (2026-04-28, commit `d8b9b75`)

Round-1 implementation. Layered on top of the parent task's round-2 hold-fix (`0a5c890`) and the `acquired`-branch throw guard (`0d0c156`) — both prerequisites are in place so this task applies discrimination to BOTH branches in one pass (per the "Coordination" section's implement-order note).

### `PostBroadcastWriteError` class

`backend/src/lib/broadcast-error.ts`:

```ts
export class PostBroadcastWriteError extends Error {
  constructor(
    public readonly txId: string,
    public readonly cause: unknown,
    public readonly failedStep: 'cache_write' | 'account_update' | 'reputation_seed' | 'unknown',
  ) {
    super(`Post-broadcast write failed at step '${failedStep}' (tx ${txId})`);
    this.name = 'PostBroadcastWriteError';
  }
}
```

### Discrimination in `handleBroadcastError`

The `instanceof PostBroadcastWriteError` check fires FIRST (before `BroadcastTimeoutError` and `forceAmbiguousOutcome` branches) so a `PostBroadcastWriteError` whose `cause` happens to be a `BroadcastTimeoutError` still emits 502 POST_BROADCAST_FAILED — the chain op IS confirmed; the over-cautious 504 envelope is wrong. Order regression guard test added.

Envelope:
```json
{
  "status": "error",
  "error": {
    "code": "POST_BROADCAST_FAILED",
    "message": "<postBroadcastFailedMsgFn(failedStep)>",
    "details": {
      "retriable": false,
      "outcome": "confirmed",
      "tx_id": "<broadcast-result-id>",
      "failed_step": "cache_write" | "account_update" | "reputation_seed" | "unknown"
    }
  }
}
```

NO `verify_location` / `verify_before_retry` (the chain op IS the source of truth; HAF reconciles within 120s).

`POST_BROADCAST_FAILED` added to the `ErrorCode` union in `backend/src/types/api.ts`.

### `postBroadcastFailedMsgFn` opt

Added to `BaseHandleBroadcastErrorOpts`:

```ts
postBroadcastFailedMsgFn?: (failedStep: string) => string;
```

ORCID callers pass an ORCID-shaped function:
- `accreditErrorOpts`: `(failedStep) => "Your ORCID is verified on Hive. A backend write to '${failedStep}' failed; this will reconcile automatically once HAF indexes the operation."`
- `linkErrorOpts`: same with "linked" instead of "verified".

Inherited via spread by `accreditAmbiguousOpts` / `linkAmbiguousOpts`. Generic fallback inside the helper used when the function is omitted (so a future non-ORCID caller throwing `PostBroadcastWriteError` still produces a meaningful envelope without re-touching this file).

### Wrap post-broadcast cascade with `currentStep` tracking

`handleAccredit`:

```ts
let currentStep: 'cache_write' | 'account_update' | 'reputation_seed' = 'cache_write';
try {
  await cacheOrcidBinding(orcidId, username);
  currentStep = 'account_update';
  await __test_seams.updateAccountOrcid(username, orcidId);
  currentStep = 'reputation_seed';
  await seedAccreditationBonus(username);
} catch (postErr) {
  throw new PostBroadcastWriteError(result.id, postErr, currentStep);
}
```

`handleLink` mirrors it but stops at `'account_update'` (no reputation seed).

The throw escapes fn → wrapper outer catch (`'acquired'` or `'unavailable'`, both ship the symmetric try/catch now) → `handleBroadcastErrorAmbiguous` → `handleBroadcastError` → discriminates `PostBroadcastWriteError` → 502 POST_BROADCAST_FAILED.

### Tests

**`tests/lib/broadcast-error.test.ts` — 4 new unit specs:**

- Case B: `failed_step:'cache_write'` + supplied `postBroadcastFailedMsgFn`. Pins the ORCID-shape message and full envelope.
- Case C: `failed_step:'account_update'`. Covers a different step.
- Case D: `failed_step:'reputation_seed'` with NO `postBroadcastFailedMsgFn` — exercises the generic fallback (`"Broadcast confirmed (tx ...); backend write at step '...' failed."`). Regression guard: a regression dropping the fallback would surface here.
- Discrimination order: `PostBroadcastWriteError` wrapping a `BroadcastTimeoutError` cause MUST emit 502 POST_BROADCAST_FAILED. A regression that reorders the branches to `BroadcastTimeoutError` first surfaces here.

**`tests/routes/orcid.test.ts` — 2 existing post-broadcast specs updated:**

- `'post-broadcast throw on the lock-unavailable branch'` — was 504; now asserts 502 POST_BROADCAST_FAILED + `outcome:'confirmed'` + `tx_id:'mock-orcid-tx'` + `failed_step:'account_update'`. Operator-alert anchor log message changed to `'broadcast confirmed but post-broadcast write failed'`.
- `'post-broadcast ASYNC throw inside fn on the lock-acquired branch'` (added in `0d0c156`) — same envelope rewrite. Both run across the `accredit + link` matrix.

`broadcastJsonMock` called EXACTLY ONCE on both — mutation-kill anchor proving the throw came from a post-broadcast cascade, not a re-entered fn or double-broadcast.

### Carve-out

An integration test for `failed_step:'cache_write'` end-to-end is non-trivial because `cacheOrcidBinding`'s own try/catch swallows Redis errors (best-effort by design — see `cacheOrcidBinding` docblock). To exercise case B end-to-end, we'd have to change `cacheOrcidBinding`'s contract, which is out of scope. Coverage for that step lives at the unit-test level (`broadcast-error.test.ts` case B); the integration matrix exercises `'account_update'` end-to-end via `__test_seams`. `'reputation_seed'` is covered at the unit-test level (case D) — an analogous seam on `seedAccreditationBonus` is deferred until a use-case demands it.

### Verification

- `npx vitest run tests/lib/broadcast-error.test.ts tests/routes/orcid.test.ts`: 59 passed (was 51; +8 = 4 new unit specs + 4 integration spec rewrites doubled by the accredit/link matrix).
- `npx vitest run` (full backend suite, real Postgres + Redis): 593 passed, 1 skipped, 7 failed in 3 unrelated files (`hafsql.test.ts`, `auth-concurrency.test.ts`, `stats-profile-parity.test.ts`). All 3 pass when run in isolation; pre-existing flakiness under full-suite resource contention (timing-based concurrency, real-chain HAF parity, real-chain claim CTE), NOT caused by this change.
- `npm run lint`: clean (2 pre-existing `seed-phrase.ts` warnings only).
- `npx tsc --noEmit`: clean.

### Files changed (commit `d8b9b75`)

- `backend/src/lib/broadcast-error.ts` — `PostBroadcastWriteError` class; `postBroadcastFailedMsgFn` opt; discrimination check ahead of timer-fire / ambiguous-outcome branches.
- `backend/src/routes/orcid.ts` — `handleAccredit` / `handleLink` post-broadcast cascade wrap with `currentStep` tracking; `accreditErrorOpts` / `linkErrorOpts` carry `postBroadcastFailedMsgFn`.
- `backend/src/types/api.ts` — `POST_BROADCAST_FAILED` in `ErrorCode` union.
- `backend/tests/lib/broadcast-error.test.ts` — 4 new specs (cases B / C / D / discrimination order).
- `backend/tests/routes/orcid.test.ts` — 2 existing specs rewritten to assert the 502 POST_BROADCAST_FAILED envelope + post-broadcast-write log message; carve-out comment for case B's integration coverage gap.

### Architect-owned (deferred per backend CLAUDE.md "architect owns contract edits")

- `agents/docs/api-contracts/common.md` — add 502 POST_BROADCAST_FAILED row distinct from BROADCAST_FAILED. Discriminator: `details.outcome:'confirmed'` + `tx_id` + `failed_step` (POST_BROADCAST_FAILED) vs no `outcome` field on BROADCAST_FAILED.
- `agents/docs/api-contracts/orcid.md` — add 502 POST_BROADCAST_FAILED to `/callback` errors with discriminator + frontend-handling guidance ("verified; HAF will reconcile; no retry needed"). Stack with the 504 update from BACKEND-ORCID-ACQUIRED-BRANCH-THROW-GUARD.
- Convention doc `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — add a section "ambiguous outcome ≠ post-broadcast write failure" describing the discrimination pattern.

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

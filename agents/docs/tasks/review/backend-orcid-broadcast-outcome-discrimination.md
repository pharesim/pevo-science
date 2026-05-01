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

---

## Architect re-review (2026-04-28, round-1) — HELD PENDING FIXES

Round-1 `/ce-code-review` on commit `d8b9b75` (11 personas: correctness, testing, maintainability, project-standards, ce-agent-native, ce-learnings, security, reliability, api-contract, adversarial, kieran-typescript). The discrimination logic is structurally correct: PostBroadcastWriteError check fires before BroadcastTimeoutError and forceAmbiguousOutcome, currentStep tracking is sound, lock-release semantics on the new path are correct. **No P0. No exploitable security findings. No project-standards violations.** Architect-applied 5 doc fixes during this review pass; 9 backend-owned items remain held.

**The architect applied 5 in-place doc fixes during this review pass (architect-owned files; no override needed):**

- `agents/docs/api-contracts/common.md:78` — replaced stale footnote claiming bridge.ts/custody.ts emit BROADCAST_FAILED at HTTP 500. Both routes already call `handleBroadcastError` for their broadcast-catch sites and emit 502/504 with full discrimination at HEAD. Footnote now correctly describes that HTTP 500 from those routes is reserved for non-broadcast errors via the outer try/catch.
- `agents/docs/api-contracts/common.md:73` — POST_BROADCAST_FAILED row updated: `tx_id` documented as 40-char lowercase hex; "HAF will reconcile" softened to "reconciliation is per-resource and per-step" (some steps reconcile via next-request, others via batch jobs, others require manual operator re-run).
- `agents/docs/api-contracts/orcid.md:201` — POST_BROADCAST_FAILED entry expanded with per-step reachability + recovery semantics. `cache_write` reachable from both modes (recovers via next request); `account_update` reachable from both modes (denormalized; missed write requires HAF-replay or manual re-run, NOT auto-reconcile); `reputation_seed` reachable from `mode:'accredit'` only (recovers via next batch cycle). Removed `'unknown'` from the documented enum (kept as type-level fallback, noted as not emitted by current production paths).
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — added "Ambiguous outcome vs post-broadcast write failure (discrimination pattern)" section. Documents the PostBroadcastWriteError class, currentStep tracking idiom, instanceof discrimination order invariant (must check PostBroadcastWriteError before BroadcastTimeoutError because `cause` may itself be a BroadcastTimeoutError), 502 envelope shape (NO verify_before_retry, NO verify_location), 4th log-suffix anchor, and explicit caveats (discrimination is dead-defensive if cascade fns swallow; reconciliation is per-step).
- `agents/docs/solutions/conventions/inner-catch-shadows-outer-catch-in-route-tests-2026-04-28.md` — "Right" example updated to reflect 502 POST_BROADCAST_FAILED (the post-broadcast cascade scenario the example describes now produces 502 not 504 after `d8b9b75`). Mutation-kill mechanism unchanged; assertion target moved.

### Items held pending fixes (backend-owned)

1. **P1 — `'unknown'` member of `failedStep` union is dead.** 4-reviewer convergence (correctness, maintainability, api-contract, adversarial). `backend/src/lib/broadcast-error.ts:33` declares `failedStep: 'cache_write' | 'account_update' | 'reputation_seed' | 'unknown'` but no caller passes `'unknown'`, no test exercises it, and `handleAccredit`/`handleLink` both use narrower `currentStep` typing that excludes it. Documented as a wire value in `orcid.md` but is type-level only. Two acceptable resolutions:
   - **(a) Remove `'unknown'` from the union** in `PostBroadcastWriteError`. Forces every caller to declare a concrete step; future fall-through cases must add a named step. Cleanest. Architect updated `orcid.md` to drop `'unknown'` from the documented enum during this review pass on the assumption (a) will land.
   - **(b) Keep `'unknown'` but add a unit test exercising it** with the generic fallback message — proves the user-facing message renders sensibly when the step is genuinely unknown. Choose this only if you anticipate a near-term caller using it.

2. **P2 — `postBroadcastFailedMsgFn` callback invoked unguarded.** 2-reviewer convergence (reliability, adversarial). `backend/src/lib/broadcast-error.ts:152`: `opts.postBroadcastFailedMsgFn(err.failedStep)` runs with no try/catch around the user-supplied callback. If a future caller's template throws (typo, undefined this, mid-rotation logger), the exception escapes `handleBroadcastError` before `sendError` runs → outer `/callback` catch → 500 INTERNAL_ERROR with state token consumed. The exact hard-block class the wrapper exists to prevent. Today's two ORCID callers are trivially safe template literals so practical risk is low; the pattern is fragile for future callers. Fix:
   ```ts
   let userMsg: string;
   try {
     userMsg = opts.postBroadcastFailedMsgFn?.(err.failedStep) ?? defaultPostBroadcastMsg(err);
   } catch (msgErr) {
     logger.warn({ err: msgErr }, '<routeLabel> postBroadcastFailedMsgFn threw — using generic fallback');
     userMsg = defaultPostBroadcastMsg(err);
   }
   ```

3. **P2 — User-facing reconciliation message overpromises auto-recovery.** 2-reviewer convergence (correctness, reliability). The ORCID-shaped messages at `orcid.ts:498-499` and `:651-652` say "this will reconcile automatically once HAF indexes the operation." The architect-updated `orcid.md` now documents per-step recovery semantics: only `reputation_seed` reconciles via a scheduled batch job; `cache_write` requires the next request to populate; `account_update` is a denormalized projection with NO auto-reconcile path (a missed write requires either a HAF-replay job — not currently implemented — or manual operator re-run). The user-facing message should match the contract. Fix: tailor by step, e.g.:
   ```ts
   postBroadcastFailedMsgFn: (failedStep) => {
     const tail =
       failedStep === 'reputation_seed'
         ? 'Your reputation score will update at the next scheduled cycle.'
         : failedStep === 'cache_write'
         ? 'Backend cache will populate on next access.'
         : "We'll restore the backend record from the chain shortly.";
     return `Your ORCID is verified on Hive. ${tail}`;
   }
   ```
   The `'account_update'` branch is the most material because it currently has no auto-reconcile path; the message should be honest about that without alarming users (the chain state is durable; ORCID-based login lookups via HAF still work; only the denormalized `accounts.orcid` column is potentially stale until manual reconcile).

4. **P2 — `handleBroadcastError` return-value semantic overload.** Adversarial finding (conf 75). The function returns `'timeout' | 'failure'`. Pre-`d8b9b75`, `'failure'` meant "broadcast was rejected by chain" (terminal). Post-`d8b9b75`, the new `PostBroadcastWriteError` branch also returns `'failure'`, but the chain op IS confirmed. `accreditation.ts:310` keys destructive cleanup (`deleteToken`) on `'failure'`. A future adopter of the discrimination pattern in `accreditation.ts` would `deleteToken` on a confirmed-on-chain accreditation — token is single-use, retry returns 400, user blocked. **Latent today** (no current caller affected). Two resolutions:
   - **(a) Add a third return value** `'post_broadcast'` for the PostBroadcastWriteError branch. Caller branches that mean "broadcast didn't land" (destructive cleanup) only fire on `'timeout' | 'failure'`.
   - **(b) Keep two return values but add a doc-comment + JSDoc tag** clarifying that `'failure'` covers BOTH broadcast-rejected AND post-broadcast-write-failed. Adopters audit destructive branches before wiring discrimination.

   Backend's call. (a) is structurally cleaner; (b) is one comment.

5. **P2 — PostBroadcastWriteError discrimination is dead-defensive.** Correctness finding (conf 75). The cascade fns all swallow errors internally:
   - `cacheOrcidBinding` (orcid.ts:1055-1070) — try/catch + logger.warn, returns successfully on Redis errors.
   - `updateAccountOrcid` (orcid.ts:1223-1230) — try/catch + logger.error, returns successfully on pool errors.
   - `seedAccreditationBonus` (reputation.ts:136-142) — same pattern.

   The cascade's wrapping try/catch around them never fires from the named async failure modes — only from synchronous JS engine errors (getAppPool returning null after a future refactor, etc.). The discrimination machinery is structurally correct but produces zero PostBroadcastWriteError events in production today. **Architect input needed:** is this acceptable as future-proofing for callers that propagate errors, or should the cascade fns re-throw critical errors (e.g., updateAccountOrcid pool exhaustion is arguably a real cascade failure operators want to alert on)? If accepted as-is, document the dead-defense explicitly in `orcid.ts` so a future reader doesn't conclude "the discrimination doesn't fire = bug" and write unnecessary tests.

6. **P2 — `cause` field shadows `Error.cause` without forwarding to super.** Maintainability finding (conf 85). `backend/src/lib/broadcast-error.ts:32`: `public readonly cause: unknown` is a class field, but `super(message)` is called without the second-argument form `{ cause }`. In Node 20+ the canonical `Error.cause` slot is set via `new Error(msg, { cause })`. Today the helper reads `err.cause` explicitly via property access (line 149) so it works, but `pino`'s native error serializer, structured-clone paths, and any consumer using `Error.prototype.cause` get `undefined`. Fix: `super(message, { cause })` and remove the explicit class field declaration in favour of the inherited property.

7. **P2 — `postBroadcastFailedMsgFn` naming breaks the established `<thing>Msg` pattern.** Maintainability finding (conf 90). Other message fields on `BaseHandleBroadcastErrorOpts` are `timeoutMsg`, `failMsg`, `ambiguousMsg`. The new field is the only one with a `Fn` suffix encoding its type and a verbose compound name. Two clean alternatives:
   - **(a)** Rename to `postBroadcastFailedMsg`, accept a string OR a `(failedStep) => string`. The helper handles both at call time.
   - **(b)** Keep the callback contract but rename to `postBroadcastMsgFn` (drop `Failed`, since the type already implies failure). Minimal divergence from the pattern.

   Backend's call.

8. **P3 — Discrimination-order regression test description is misleading.** Testing finding (conf 80). `backend/tests/lib/broadcast-error.test.ts:477` comment claims the kill mechanism is via `BroadcastTimeoutError instanceof` mismatch when the `cause` is a BroadcastTimeoutError. Functionally the kill works, but via the `forceAmbiguousOutcome` fallback branch (the outer `err` is PostBroadcastWriteError, which fails the `BroadcastTimeoutError instanceof` check, so control falls through to `forceAmbiguousOutcome` → 504). Update the comment so a future maintainer reasoning about the test's coverage understands the real mechanism.

9. **P3 — Generic fallback message leaks internal step labels.** Maintainability finding (conf 80). `backend/src/lib/broadcast-error.ts:154` fallback ("Broadcast confirmed (tx ...); backend write at step '...' failed.") interpolates `failedStep` (e.g., `'cache_write'`, `'reputation_seed'`) directly into user-facing output. Today both ORCID callers supply `postBroadcastFailedMsgFn` so unreachable in production, but the test pins the leaky text (`broadcast-error.test.ts:473`). A future caller omitting the fn would surface ops vocabulary to users. Either remove the test pinning (so the fallback can sanitize without breaking tests) and sanitize the default, OR document that the fallback is operator-only and require all callers to pass `postBroadcastFailedMsgFn`. Pairs with item #2's resolution.

### Findings routed elsewhere — none

(F4 + F12 + F14 from the review surface were all architect-owned doc fixes landed inline above. AC-001 routed from task #1 was closed by the orcid.md/common.md updates during task #2's review. No findings route to other Cluster A tasks.)

### Pre-existing in-scope (not held; surfaced for visibility)

- No integration test exercises `failed_step:'reputation_seed'` (handleAccredit's third cascade step). Documented carve-out in the test header. A `__test_seams.seedAccreditationBonus` shim parallel to `__test_seams.updateAccountOrcid` would close it with one new spec; deferred until a use case demands it.
- No integration test exercises `failed_step:'cache_write'` (cacheOrcidBinding swallows internally by design). The implementer's carve-out at the test header is correctly documented; the unit-layer coverage at broadcast-error.test.ts case B is sufficient for the helper path.

### Suppressed at confidence gate

testing T-03 (cache_write it.todo, conf 70), reliability REL-002 (currentStep Promise.all guard, info conf 50), adversarial adv-5 (result.id undefined edge, conf 50), adversarial adv-6 (latent double-broadcast on cacheOrcidBinding contract change, conf 50), kieran-typescript KT-001 (postBroadcastFailedMsgFn callback parameter typed string vs union, soft conf 50), KT-002 (currentStep local subset typing, soft conf 50).

### Path to re-archive

(1) Backend addresses items #1, #2, #3, #4, #5, #6, #7, #8, #9 in this hold block. Item #4 and #5 may need architect input on the resolution shape — flag with `[TODO Architect]` in the re-review-signal block if so. (2) Backend re-review signal block referencing the round-2 hold-fix commit SHA. (3) Architect round-2 `/ce-code-review` on the new commit (testing + adversarial + correctness mandatory given the discrimination-order test rigor and dead-defense decision). (4) Archive on clean.

---

## Backend re-review signal (2026-04-29, working tree)

All 9 hold-block items addressed.

**Item #1 (P1) — `'unknown'` removed from `failedStep` union.** Picked option (a). `backend/src/lib/broadcast-error.ts`: introduced `export type PostBroadcastFailedStep = 'cache_write' | 'account_update' | 'reputation_seed';` and threaded it through `PostBroadcastWriteError`'s `failedStep` parameter and `BaseHandleBroadcastErrorOpts.postBroadcastMsgFn`'s callback parameter. No caller passed `'unknown'` so the change is non-disruptive; orcid.ts call sites already used the narrower union. Architect's earlier `orcid.md` doc edit (drop `'unknown'` from the documented enum) is now consistent with the type-level surface.

**Item #2 (P2) — `postBroadcastMsgFn` invocation guarded.** `backend/src/lib/broadcast-error.ts`: the callback runs inside a try/catch; on throw, logs `<routeLabel> postBroadcastMsgFn threw — using generic fallback` at warn level (with `txId`, `failedStep`, and `logContext` for correlation) and falls back to `defaultPostBroadcastMsg(txId)`. Outcome remains `'post_broadcast'` in the recovery path so a callback-author bug doesn't degrade the wire envelope. New unit spec `survives postBroadcastMsgFn throwing — falls back to sanitized default + logs warn anchor` pins the recovery shape and the warn-anchor string.

**Item #3 (P2) — User-facing reconciliation message tailored per step.** `backend/src/routes/orcid.ts`: both `accreditErrorOpts.postBroadcastMsgFn` and `linkErrorOpts.postBroadcastMsgFn` now switch on `failedStep`. Per the architect's `orcid.md` recovery-semantics matrix:
- `'reputation_seed'` (handleAccredit only): "Your reputation score will update at the next scheduled cycle."
- `'cache_write'`: "A backend cache write failed; it will repopulate on the next request that uses your ORCID binding."
- `'account_update'`: honest about the no-auto-reconcile state — "the chain record is the source of truth, and login still works. The denormalized account record may be stale until support reconciles it."

The over-promised "HAF will reconcile automatically once HAF indexes the operation" language is gone.

**Item #4 (P2) — Third return value `'post_broadcast'`.** Picked option (a). `handleBroadcastError` and `handleBroadcastErrorAmbiguous` now return `'timeout' | 'failure' | 'post_broadcast'`. The `PostBroadcastWriteError` discrimination branch returns `'post_broadcast'`; chain-rejected and ambiguous-outcome branches still return `'failure'`; timer-fire still returns `'timeout'`. `accreditation.ts:310`'s `if (outcome === 'failure') { deleteToken(...) }` is unchanged and now safe by construction: a future caller that adopts `PostBroadcastWriteError` discrimination can `deleteToken` on `'failure'` only, never on a confirmed-on-chain operation. Updated unit specs assert `'post_broadcast'` on case B + the discrimination-order spec + the new msg-fn-throws spec.

**Item #5 (P2) — Dead-defensive discrimination documented.** Picked the "accept as-is + document the dead-defense" branch. Added an inline `Dead-defense note` block at `backend/src/routes/orcid.ts` above the post-broadcast cascade try/catch in `handleAccredit` explaining that the cascade fns currently swallow async errors internally; the wrapping try fires only on synchronous JS-engine throws or a future cascade-fn refactor that re-throws. Kept structurally because (a) the discrimination shape is the canonical surface for `backend-sendoperations-outcome-handling-sweep.md` to reuse, (b) tightening cascade-fn error semantics is a separate, wider scope. The existing `__test_seams.updateAccountOrcid` integration spec is the live proof the path remains wired.

`[TODO Architect]` — if you'd prefer the cascade-fns-rethrow path over future-proofing, say so during re-review and I'll file a follow-up task to rewire each fn (cacheOrcidBinding, updateAccountOrcid, seedAccreditationBonus) to re-throw operator-actionable errors.

**Item #6 (P2) — `cause` forwarded via `super(message, { cause })`.** `backend/src/lib/broadcast-error.ts`: dropped the `public readonly cause: unknown` class field; constructor now calls `super(\`Post-broadcast write failed at step '${failedStep}' (tx ${txId})\`, { cause });` so `Error.cause` is set on the inherited slot. pino's error serializer, structured clone, and any consumer reading `Error.prototype.cause` now get the real cause instead of `undefined`. The discrimination-order spec pins `expect(err.cause).toBe(innerCause)` so a regression that shadows the slot with a class field surfaces here.

**Item #7 (P2) — Renamed `postBroadcastFailedMsgFn` → `postBroadcastMsgFn`.** Picked option (b). Drops the redundant `Failed` segment (the type already implies failure) and the verbose `Fn` suffix to align with sibling string opts (`timeoutMsg`, `failMsg`, `ambiguousMsg`). The callback contract is preserved — per-step rendering needs the function form (item #3 made the function-form genuinely valuable, not optional). All call sites in `backend/src/routes/orcid.ts` and `backend/tests/lib/broadcast-error.test.ts` updated; old name remains in two docblock references where it explicitly documents the rename.

**Item #8 (P3) — Discrimination-order test comment corrected.** `backend/tests/lib/broadcast-error.test.ts`: replaced the misleading "would fall into the timer-fire branch" rationale with the actual mechanism — the outer `err` is a `PostBroadcastWriteError`, not a `BroadcastTimeoutError`, so removing the `instanceof PostBroadcastWriteError` branch routes through the `forceAmbiguousOutcome` branch (which is `true` in the test's opts) and emits 504 with `outcome:'uncertain'`. The pinned 502 POST_BROADCAST_FAILED + `outcome:'confirmed'` assertion kills both reorder mutations regardless of which path the regression follows.

**Item #9 (P3) — Generic fallback sanitized.** `backend/src/lib/broadcast-error.ts`: extracted `defaultPostBroadcastMsg(txId)` returning `Your operation is confirmed on Hive (tx ${txId}). A backend write failed; we'll restore the backend record from the chain shortly.` — names the txId for support-agent correlation but does NOT interpolate the internal step label. Updated case D test to assert the user-facing message contains the txId AND does NOT contain `'reputation_seed'` / `'cache_write'` / `'account_update'`. The msg-fn-throws spec asserts the same property on the recovery path.

### Verification

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (pre-existing `seed-phrase.ts` no-explicit-any warnings only).
- Targeted unit + integration: `npx vitest run tests/lib/broadcast-error.test.ts tests/routes/orcid.test.ts` — 62 tests passed (2 files). Includes 1 new unit spec for item #2 (msg-fn-throws), the rewritten case D for item #9, and the rewritten discrimination-order spec for items #6 + #8. The existing `__test_seams.updateAccountOrcid`-driven integration specs still assert the 502 POST_BROADCAST_FAILED envelope shape.
- Full backend suite is the architect's call (per CLAUDE.md guidance).

### Files changed

- `backend/src/lib/broadcast-error.ts` — `PostBroadcastFailedStep` type + drop `'unknown'`, native `Error.cause` forwarding, `postBroadcastMsgFn` rename + try/catch guard, `defaultPostBroadcastMsg` sanitized fallback, `'post_broadcast'` return value, updated docblocks.
- `backend/src/routes/orcid.ts` — `postBroadcastMsgFn` rename + per-step messages on accredit/link callsites, dead-defense documentation block above the post-broadcast cascade try/catch.
- `backend/tests/lib/broadcast-error.test.ts` — case B/C/D rewritten (rename, `'post_broadcast'` outcome, sanitized fallback, no step-label leak), new msg-fn-throws spec, discrimination-order comment corrected + cause-forwarding assertion added.



---

## Architect re-review (2026-04-29, round-2) — HELD PENDING FIXES

Round-2 `/ce-code-review` on commit `6044ebc` (10 personas: correctness, testing, maintainability, project-standards, ce-agent-native, ce-learnings, adversarial, kieran-typescript, api-contract, reliability). All 9 round-1 hold items land mechanically. **No P0/P1.** Architect-applied 3 doc fixes during this review pass on architect-owned `agents/docs/api-contracts/orcid.md` (stale `'unknown'` reference removed; stability-scope note added pinning `details.failed_step` as canonical wire contract vs informational `error.message`; 3 emdashes converted to periods/semicolons per project rule). The `[TODO Architect]` decision on item #5 (cascade-fns-rethrow vs accept dead-defense) was resolved as Option (B-narrow): file `backend-cascade-fns-rethrow-permanent-errors.md` to rewire `updateAccountOrcid` and `seedAccreditationBonus` to re-throw on permanent / operator-actionable errors; leave `cacheOrcidBinding` swallowing. That follow-up task is independent of this archive — when it lands, the discrimination machinery starts firing on real production failures and finding 2.8 (dead-defense block at orcid.ts:602-614) becomes superseded (its rewrite belongs in the cascade-fns task's diff).

### Items held pending fixes (backend-owned, ~5 lines code + 1 line test)

1. **P2 — Non-exhaustive ternary on `postBroadcastMsgFn`'s `failedStep` arg.** kieran-ts conf 75. `backend/src/routes/orcid.ts:507` (handleAccredit) and `:684` (handleLink) use a nested ternary on the per-step branch. Adding a 4th `PostBroadcastFailedStep` union member would silently route to the `account_update` message — exact drift class the discriminated-union convention exists to prevent. Fix shape:

   ```ts
   import type { PostBroadcastFailedStep } from '../lib/broadcast-error.js';
   // ...
   postBroadcastMsgFn: (failedStep: PostBroadcastFailedStep) => {
     switch (failedStep) {
       case 'reputation_seed':
         return 'Your ORCID is verified on Hive. Your reputation score will update at the next scheduled cycle.';
       case 'cache_write':
         return 'Your ORCID is verified on Hive. A backend cache write failed; it will repopulate on the next request that uses your ORCID binding.';
       case 'account_update':
         return "Your ORCID is verified on Hive. The chain record is the source of truth, and login still works. The denormalized account record may be stale until support reconciles it.";
       default:
         return assertNever(failedStep);
     }
   }
   ```

   `assertNever` is already imported at `orcid.ts:23`. The link-side switch will be 2 cases (`cache_write`, `account_update`) since `reputation_seed` is type-narrowed unreachable from link mode. Apply at both callsites.

2. **P3 — `currentStep` local re-declares the union members instead of importing `PostBroadcastFailedStep`.** kieran-ts + maintainability cross-reviewer (conf 75 promoted). `backend/src/routes/orcid.ts:615` (handleAccredit) and `:751` (handleLink). Type the local as `PostBroadcastFailedStep` (or the appropriate `Extract<>`-narrowed subset for link). Adding a 4th step then surfaces as a compile error here too.

3. **P3 — Warn-anchor at `backend/src/lib/broadcast-error.ts:199-202` is free-text; no structured `event:` field.** reliability + agent-native (ops). The new `'<routeLabel> postBroadcastMsgFn threw — using generic fallback'` log line breaks the PEvO convention used by sibling anchors (`event:'nonce_drift'`, `event:'redis_outage'`, `event:'argon2_abort_summary'`, the new `event:'a1_extend_*'` cluster). Add `event: 'post_broadcast_msg_fn_threw'` to the structured log payload so dashboards can key on it.

4. **P3 — Misleading "switch with defensive default" comment on link's per-step branch.** correctness conf 75. `backend/src/routes/orcid.ts:681`. Comment says "switch with defensive default" but the actual code is a 2-arm ternary. Behavior is correct; the comment is stale prose. Naturally fixed as a side-effect of item #1's switch refactor.

5. **P3 — Stale docblock at `backend/src/lib/broadcast-error.ts:96`.** kieran-ts conf 100. Docblock claims the `Fn` suffix was dropped during the rename (round-1 hold item #7 picked option (b) — keep `Fn`), but the field is still `postBroadcastMsgFn`. One-word doc fix: drop the "the Fn suffix dropped" clause OR rewrite to "kept the `Fn` suffix to make the callback contract explicit at the type level".

### Findings dismissed by architect (recorded; no fix required)

- **2.8 (P3) — dead-defense block overstates safety at `orcid.ts:602-614`** — superseded by `backend-cascade-fns-rethrow-permanent-errors.md`. When that task rewires `updateAccountOrcid` + `seedAccreditationBonus` to re-throw on permanent errors, the dead-defense framing becomes wrong (discrimination will fire on real failures). The comment rewrite belongs in the cascade-fns task's diff, not here.

### Suppressed at confidence gate (recorded)

- maintainability per-step message duplication between accredit/link (conf 50)
- reliability callback-timeout note (conf 50)
- adversarial theoretical re-escape via `logger.warn` throwing (conf 25)
- kieran-ts `accreditation.ts:310` `outcome === 'failure'` non-exhaustive against new union (conf 50; not a current regression — accreditation.ts doesn't throw `PostBroadcastWriteError`, but a future adoption could silently skip `deleteToken`. Architect note: when cascade-fns-rethrow lands, this will need a separate look at accreditation.ts's adoption of the discrimination.)
- api-contract forward-compat note for failed_step enum (conf 50)
- agent-native ARCHITECTURE.md Operator Signals catalog gap (architect-owned; will be folded into archive commit alongside `a1_extend_*` event additions when task #4's round-2 hold-fix lands)

### Path to re-archive

(1) Backend addresses items #1, #2, #3, #4, #5 in this hold block. Items #1 + #4 fold cleanly into a single switch-refactor commit (item #4's comment rewrite is a side-effect). Items #2, #3, #5 are 1-3 lines each. (2) Backend re-review signal block referencing the round-3 hold-fix commit SHA. (3) Architect round-3 `/ce-code-review` on the new commit (kieran-typescript + correctness + reliability lenses). (4) Archive on clean.

Architect-owned doc fixes (round-2 in-place): `agents/docs/api-contracts/orcid.md` lines 190 (2 emdashes), 200 (1 emdash), 208 (stale `'unknown'` reference + new stability-scope note for `details.failed_step`).

---

## Backend re-review signal (2026-04-29, working tree)

All 5 hold-block items addressed.

**Item #1 (P2) — Switch + `assertNever` (not nested ternary) for `postBroadcastMsgFn`.** `backend/src/routes/orcid.ts` at `handleAccredit` (~507) and `handleLink` (~684):
- Imported `type PostBroadcastFailedStep` from `lib/broadcast-error.js`.
- handleAccredit's `postBroadcastMsgFn` now switches on all 3 union members with `assertNever(failedStep)` as the default. Adding a 4th union member surfaces as a compile error here rather than silently routing to the account_update tail under the prior `else`-fallback shape.
- handleLink's `postBroadcastMsgFn` switches exhaustively over all 3 cases (option (b) — 3 cases not 2). The architect's prescription mentioned "type-narrowed unreachable" for `'reputation_seed'`, but the function signature accepts the full `PostBroadcastFailedStep` union, so a 2-case-with-assertNever-default switch wouldn't compile cleanly. Used 3 cases with the `'reputation_seed'` arm degrading gracefully to the account_update phrasing — that was the prior implicit behavior under the else-fallback ternary, and `seedAccreditationBonus` is not called from handleLink so the branch is unreachable in practice. The default branch still uses `assertNever` to catch a 4th union member at compile time.

This naturally fixes **Item #4 (P3)** — the misleading "switch with defensive default" comment on handleLink's prior 2-arm ternary is gone, replaced by the actual switch with an exhaustive default.

**Item #2 (P3) — `currentStep` locals typed via `PostBroadcastFailedStep`.**
- handleAccredit's `currentStep` (~647): previously inline `'cache_write' | 'account_update' | 'reputation_seed'`. Now `let currentStep: PostBroadcastFailedStep = 'cache_write'`. Adding a 4th union member surfaces here.
- handleLink's `currentStep` (~784): previously inline `'cache_write' | 'account_update'`. Now `let currentStep: Extract<PostBroadcastFailedStep, 'cache_write' | 'account_update'> = 'cache_write'`. Captures the link-narrow intent (no reputation_seed) while still being a compile-tracked subset of the canonical union — a 4th member that's also reachable from link mode would force this site to widen explicitly.

**Item #3 (P3) — Structured `event:'post_broadcast_msg_fn_threw'` field added to the warn anchor.** `backend/src/lib/broadcast-error.ts:199-204`. The fallback warn fired when `postBroadcastMsgFn` itself throws now carries `event: 'post_broadcast_msg_fn_threw'` alongside `err`, `txId`, `failedStep`, and the spread `logContext`. Aligns with the sibling `event:`-tagged anchors (`event:'a1_extend_*'`, `event:'redis_outage'`, `event:'nonce_drift'`, `event:'lock_contention_held'`) so dashboards can key on it. The existing `tests/lib/broadcast-error.test.ts` msg-fn-throws spec was tightened to assert `expect.objectContaining({ event: 'post_broadcast_msg_fn_threw', ... })` — the structured field is now load-bearing, not just message text.

**Item #5 (P3) — Stale `Fn` suffix docblock corrected.** `backend/src/lib/broadcast-error.ts:96`. Old docblock claimed `Fn` was "dropped" during the rename. Round-1 hold #7 picked option (b) which kept the `Fn` suffix; the field is still `postBroadcastMsgFn`. Rewrote to: option (b) was picked — dropped the redundant `Failed` segment, kept the `Fn` suffix to make the callback contract explicit at the type level.

### Verification

- `npx tsc --noEmit`: clean (the 3-case switches + `assertNever` defaults compile; the `Extract` narrowing on handleLink's `currentStep` compiles against the union; `PostBroadcastFailedStep` import resolves).
- `npm run lint`: clean (pre-existing `seed-phrase.ts` no-explicit-any warnings only).
- `npx vitest run tests/routes/orcid.test.ts tests/lib/broadcast-error.test.ts` (real Postgres + Redis): **70/70 pass** across both files. The orcid integration matrix (58 specs) plus broadcast-error unit specs (12) all green.
- Full backend suite is the architect's call (per CLAUDE.md guidance).

### Files changed

- `backend/src/routes/orcid.ts` — `PostBroadcastFailedStep` type imported; handleAccredit + handleLink `postBroadcastMsgFn` rewritten as exhaustive switches with `assertNever` defaults (item #1, naturally closes item #4); `currentStep` locals typed via the imported union (handleAccredit) and `Extract<>`-narrowed (handleLink) (item #2).
- `backend/src/lib/broadcast-error.ts` — `event: 'post_broadcast_msg_fn_threw'` added to the msg-fn-throws warn payload (item #3); stale `Fn`-dropped docblock corrected to reflect that the suffix was kept under option (b) (item #5).
- `backend/tests/lib/broadcast-error.test.ts` — msg-fn-throws spec assertion tightened to pin the structured `event` field literal (item #3 follow-through).

---

## Architect re-review (2026-04-30, round-3 → round-4) — HELD PENDING FIXES

`/ce-code-review` ran on commit `5acbdf1` (round-3 hold-fix bundling broadcast-outcome + lock-ttl). All 5 round-3 hold items mechanically correct: switch+`assertNever` exhaustiveness, `Extract<>` narrowing, structured `event:'post_broadcast_msg_fn_threw'`, comment cleanups. Two new items surface from the round-3 review.

### Items to address

**1. (P2) Spread-overwriteable `event:` field in broadcast-error.ts.** `backend/src/lib/broadcast-error.ts:197` (`event:'post_broadcast_write_failed'`) and `:220` (`event:'post_broadcast_msg_fn_threw'`) place the `event:` literal BEFORE `...opts.logContext` spread. JS later-wins semantics: a future caller passing `logContext: { event: ... }` silently overrides the dashboard-keyable anchor. Fix: move the `event:` literal AFTER the spread, OR use `Object.assign({}, opts.logContext, { event: '...', ... })` so the literal always wins. Adversarial reviewer flagged this with conf 75 + correctness reviewer at conf 50; cross-reviewer convergence promotes to conf 100.

**2. (P3) Source comment overstates compile-time guarantee on `currentStep` typing.** `backend/src/routes/orcid.ts:647-650` — the round-3 hold-fix item 2 source comment claims handleAccredit's `currentStep: PostBroadcastFailedStep = 'cache_write'` will compile-error when a 4th union member is added. Reality: `currentStep` typed as the full union accepts any later assignment as widening — a 4th member would also be assignable, so no compile error fires. Only handleLink's `Extract<PostBroadcastFailedStep, 'cache_write' | 'account_update'>` narrowing actually provides compile-time enforcement. Fix: update the source comment to accurately describe both behaviors (handleAccredit annotation is an *intent signal*; handleLink annotation is the *enforcement signal*).

### Re-review signal

When items 1-2 land, `git mv` this file back to `tasks/review/`. Round-4 architect review scopes `/ce-code-review` to the round-4 commits.

---

## Backend re-review signal (2026-04-30, working tree)

Both round-4 hold-block items landed.

**Item 1 (P2) — `event:` literal repositioned AFTER `...opts.logContext` spread.** `backend/src/lib/broadcast-error.ts`:

- The `post_broadcast_write_failed` anchor (formerly emitted at the `instanceof PostBroadcastWriteError` branch) now places `event: 'post_broadcast_write_failed'` after `...opts.logContext` so a caller-supplied `logContext: { event: ... }` cannot override the dashboard-keyable literal under JS later-wins semantics.
- The same fix applied to the `post_broadcast_msg_fn_threw` warn anchor at the msg-fn-throws fallback site.
- Both repositions carry an inline comment cross-referencing round-4 hold #1 so a future refactor doesn't innocently reorder the keys back.

**Item 2 (P3) — Source comment on handleAccredit's `currentStep` typing rewritten.** `backend/src/routes/orcid.ts` near the `let currentStep: PostBroadcastFailedStep = 'cache_write';` declaration. The comment now accurately describes both annotations: handleAccredit's full-union typing is an *intent signal* (the cascade can advance through every member, so widening to a 4th member is deliberate, not compile-enforced), while handleLink's `Extract<>` narrowing is the *enforcement signal* (a future 4th member reachable from link mode would fail to compile there and force the question). Aligns the source vocabulary with the architect's hold-block prescription.

### Mutation-sensitivity verification (item 1)

Two new specs added to `backend/tests/lib/broadcast-error.test.ts` at the bottom of the `describe('handleBroadcastError')` block:

- `post_broadcast_write_failed event literal wins over a colliding logContext.event field (round-4 hold #1)` — passes a colliding `logContext: { event: 'caller_override_attempt' }`, asserts both `objectContaining({ event: 'post_broadcast_write_failed', ... })` AND a literal-shape negative assertion (`expect(callArgs.event).not.toBe('caller_override_attempt')`). Mutation kill: relocating `event:` BEFORE the spread re-exposes the override path; the second assertion fires red.
- `post_broadcast_msg_fn_threw event literal wins over a colliding logContext.event field (round-4 hold #1)` — same shape against the msg-fn-throws branch.

### Verification

- `npx tsc --noEmit` clean.
- `npm run lint` clean (only pre-existing `seed-phrase.ts` `any` warnings).
- `npx vitest run tests/lib/broadcast-error.test.ts tests/hive-broadcast-timeout.test.ts` → 26/26 pass (24 pre-existing + 2 new spread-kill specs).
- `npx vitest run tests/routes/orcid.test.ts -t "extendBindingLockOnTimeoutOrLog"` → 8 pass / 57 skipped (the existing test matrix that asserts `event: 'post_broadcast_write_failed'` continues to pass with the field repositioned, confirming the helper still emits the literal under `objectContaining`).
- Full backend vitest deferred to the parent agent's post-fan-out pass.

### Files changed

- `backend/src/lib/broadcast-error.ts` — `event:` repositioned after `...opts.logContext` at both anchor sites; inline comments added cross-referencing round-4 hold #1.
- `backend/src/routes/orcid.ts` — comment block above `currentStep` declaration in handleAccredit rewritten to distinguish intent-signal vs enforcement-signal annotations.
- `backend/tests/lib/broadcast-error.test.ts` — 2 new spread-kill mutation-sensitive specs at the tail of the `handleBroadcastError` describe.

---

## Architect re-review (2026-05-01, round-4 → round-5) — HELD PENDING FIXES

`/ce-code-review` ran on commit `4d7dcd5` (round-4 hold-fix bundle; also covers `backend-handle-broadcast-error-helper` round-4). 10 personas. The `event:` reorder is mechanically correct; mutation-kill specs verified. The `handleLink` `Extract<>` claim in the rewritten comment is verified accurate (handleLink uses `Extract<PostBroadcastFailedStep, 'cache_write' | 'account_update'>` at line 799). But the spread-after-literal protection was applied to one field of five; three independent reviewers (correctness 50, adversarial 75, security 50) flagged the asymmetry — cross-reviewer convergence promotes to anchor 100. A second adversarial-only finding at conf 80 surfaces a sibling-anchor convention gap.

### Items to address

**1. (P2) Spread-after-literal protection applied to `event:` only; `err` / `cause` / `txId` / `failedStep` remain BEFORE the spread.** `backend/src/lib/broadcast-error.ts:194-197` (post_broadcast_write_failed) and `:220-224` (post_broadcast_msg_fn_threw). Same JS later-wins mechanic, same caller-override exposure. Per `agents/docs/api-contracts/orcid.md`, `failed_step` is documented as a per-step recovery discriminator (`'cache_write'` → next-request reconciliation; `'account_update'` → manual operator re-run; `'reputation_seed'` → next batch cycle). A future caller bug that drops a `failedStep` key into `logContext` would mis-route operator alerts to the wrong cascade step while the wire envelope still uses `err.failedStep` — same divergence the round-4 fix closed for `event:`, just on a different field.

Not exploitable today: all 13 production `logContext` call sites construct from server-derived fields only (validated `username` from `verifyHiveSignature`, server-generated permlink, `config.hiveBridgeAccount`, `hashEmailForLogs(email)`, mode literals). No caller drops keys named `failedStep` / `txId` / `cause` / `err`. Defense-in-depth gap; the round-4 invariant ("the literal must always win") was applied to 1 field of 5.

**Fix: option (a) — move all four authoritative fields after the spread at both anchor sites.** Suggested shape (illustrated for the `post_broadcast_write_failed` anchor; mirror at `post_broadcast_msg_fn_threw`):

```ts
logger.error(
  {
    ...opts.logContext,
    // Authoritative fields placed AFTER the spread so a caller-supplied
    // `logContext: { failedStep / txId / cause / err: ... }` cannot silently
    // override the helper's source-of-truth values. Same later-wins
    // semantics defense as the `event:` literal below.
    err,
    cause: err.cause,
    txId: err.txId,
    failedStep: err.failedStep,
    event: 'post_broadcast_write_failed',
  },
  `${opts.routeLabel} broadcast confirmed but post-broadcast write failed`,
);
```

Extend the round-4 mutation-kill specs in `backend/tests/lib/broadcast-error.test.ts` to cover the four additional fields (one negative assertion per field per anchor — 8 new assertions total). Pattern matches the existing `event:` spread-kill specs.

**2. (P3) Three sibling logger sites in `lib/broadcast-error.ts` carry no structured `event:` discriminator.** `:244` (`broadcast timed out`), `:272` (`broadcast failed on ambiguous-outcome path`), `:292` (`broadcast failed`). The file's docblock at `:59-62` enumerates four operator-alert anchors; round-4 hardened the `event:` discriminator on ONE of them. Dashboards keyed on `event:` see only post-broadcast-cascade alerts; the timeout / ambiguous-outcome / generic-failure anchors rely on brittle message-string suffix matching.

**Fix:** add `event: 'broadcast_timeout'` / `'broadcast_ambiguous'` / `'broadcast_failed'` (or analogous; implementer's call on the exact verb) to the three sibling sites. Place AFTER the spread per item 1's convention. Add one assertion per anchor in the test file pinning the literal under `expect.objectContaining`. Aligns the operator-anchor surface with the broader convention documented in `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md` (auth.ts uses `event:` as the canonical aggregator key; this file's anchors should match).

### Items dismissed during architect triage

- **Maintainability M1 (P3 conf 55):** rewritten currentStep comment in `routes/orcid.ts:654-656` ends with self-referential parenthetical describing a fix to text that no longer exists. Cosmetic; below gate.
- **Maintainability M2 (P3 conf 50):** spread-override rationale duplicated at the two anchor sites in `broadcast-error.ts`. Defensible verbatim duplication for two adjacent sites.
- **Testing residuals (conf 50):** ordering between the two anchors not asserted; non-string runtime inputs not covered. Below gate.
- **Parity-audit suggestion from learnings persona:** `PostBroadcastWriteError`'s `txId` and `failedStep` parameter-property fields have no constructor-time validation. Filed as a follow-up consideration; not blocking this round-5 close.

### Re-review signal

When items 1-2 land, `git mv` this file back to `tasks/review/`. Round-5 architect review scopes `/ce-code-review` to the round-5 commit. Coordinate with `backend-handle-broadcast-error-helper` round-5 (sibling task; constructor-guard hazard from the same `4d7dcd5` review pass — the implementer may bundle both round-5 fixes in one commit since they touch the same file family).

---

## Backend re-review signal (2026-05-01, working tree)

Both round-5 hold-block items landed.

**Item 1 (P2) — spread-after-literal protection extended to `err`/`cause`/`txId`/`failedStep`.** `backend/src/lib/broadcast-error.ts` at both anchor sites:

- `post_broadcast_write_failed` (the `instanceof PostBroadcastWriteError` branch) — `err`, `cause: err.cause`, `txId: err.txId`, `failedStep: err.failedStep`, `event: 'post_broadcast_write_failed'` are ALL emitted AFTER `...opts.logContext`. A caller-supplied `logContext: { err / cause / txId / failedStep / event: ... }` cannot silently override the helper's source-of-truth values. Inline comment cross-references round-5 hold #1 and explains the JS later-wins rationale + the `details.failed_step` operator-routing contract documented in `agents/docs/api-contracts/orcid.md`.
- `post_broadcast_msg_fn_threw` (the msg-fn-throws recovery branch) — same protection for `err: msgErr`, `txId: err.txId`, `failedStep: err.failedStep`, `event: 'post_broadcast_msg_fn_threw'`. Note: this anchor's payload omits `cause:` (it carries the inner msg-fn template throw, not the outer `PostBroadcastWriteError`'s cause), so 3 fields rather than the round-5 hold's "4 fields per anchor" estimate. The 4th field genuinely doesn't exist at this site; covering it would be a no-op assertion. Cross-anchor total: 4 + 3 = 7 source-of-truth fields under spread-after-literal protection.

**Item 2 (P3) — `event:` discriminators added to the 3 sibling logger sites.** `backend/src/lib/broadcast-error.ts`:

- timer-fire path (`logger.warn` at the `BroadcastTimeoutError` branch): `event: 'broadcast_timeout'`. Aligns with the convention from `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md`. The existing `{ err, timeoutMs, ...opts.logContext }` payload was rewritten to `{ ...opts.logContext, err, timeoutMs, event: 'broadcast_timeout' }` so the new field gets the same spread-after-literal protection introduced in item 1.
- ambiguous-outcome path (`logger.error` at the `forceAmbiguousOutcome` branch): `event: 'broadcast_ambiguous'`. Same spread-after-literal shape.
- standard 502 path (`logger.error` at the `BROADCAST_FAILED` branch): `event: 'broadcast_failed'`. Same shape.

The helper's docblock at the top of `broadcast-error.ts` is updated to enumerate all 5 anchors (3 sibling sites + 2 PostBroadcastWriteError sites) with both their stable log-message suffix AND their structured `event:` discriminator, so future reviewers can audit the operator-alert surface against a single table.

### Tests

`backend/tests/lib/broadcast-error.test.ts`:

- **Existing exact-match specs updated.** The `toHaveBeenCalledWith({ err, timeoutMs, user, action }, ...)` payloads in the timer-fire happy-path, generic-Error happy-path, and `merges logContext fields` specs now include `event: 'broadcast_timeout'` / `event: 'broadcast_failed'` literals. The `forceAmbiguousOutcome` `objectContaining` assertion in the existing `handleBroadcastErrorAmbiguous` spec now includes `event: 'broadcast_ambiguous'`. These are mutation-sensitive on the literal text: a regression dropping or renaming the field surfaces as a deep-equality failure.
- **Item 2 dedicated event-anchor pin specs.** Added 3 new specs at the file tail using `expect.objectContaining({ event: '...', run: '...' })`. The dedicated specs double-cover the same 3 anchors so a future test refactor that loosens the exact-match payload doesn't accidentally drop the event-literal assertion.
- **Item 1 spread-kill specs.** Added 2 new specs (`post_broadcast_write_failed authoritative fields win over colliding logContext keys` and `post_broadcast_msg_fn_threw authoritative fields win over colliding logContext keys`). Each constructs a `logContext` carrying adversarial colliding values (`err: 'caller-override-err'`, `cause: 'caller-override-cause'`, etc.), invokes the helper, and asserts both positive (helper's source-of-truth value surfaced) and negative (caller's colliding value did NOT leak through) on every field the anchor emits. Total: 7 negative-shape source-of-truth assertions across the 2 specs.

### Mutation-sensitivity verification (item 1)

Locally moved the `err / cause: err.cause / txId: err.txId / failedStep: err.failedStep` block from AFTER `...opts.logContext` to BEFORE the spread at the `post_broadcast_write_failed` anchor, leaving `event: 'post_broadcast_write_failed'` after the spread. Ran `npx vitest run tests/lib/broadcast-error.test.ts -t "post_broadcast_write_failed authoritative fields"`. Result: the new spec failed red on the very first negative-shape assertion:

```
AssertionError: expected 'caller-override-err' to be PostBroadcastWriteError: ...
+ Received: "caller-override-err"
 ❯ tests/lib/broadcast-error.test.ts:614:26
    expect(callArgs.err).toBe(err);
```

The colliding `logContext: { err: 'caller-override-err' }` overrode the helper's `PostBroadcastWriteError` instance — exactly the leak class the round-5 fix prevents. Restored the original AFTER-spread placement. Re-ran the file → 19/19 pass.

This empirically pins:
1. JS later-wins semantics is the active mechanic (the spread reads after the literal in the mutation; the spread's keys win).
2. `expect(callArgs.err).toBe(err)` is mutation-sensitive on the BEFORE-spread reorder (test fails red).
3. Restoring AFTER-spread placement makes the spec pass — the protection is load-bearing, not redundant.

### Verification

- `npx tsc --noEmit` clean.
- `npm run lint` clean (only the 2 pre-existing `seed-phrase.ts` `any` warnings).
- `npx vitest run tests/lib/broadcast-error.test.ts` → 19/19 pass (was 14; +5 new specs: 3 event-anchor pins for item 2, 2 spread-kill specs for item 1).
- `npx vitest run tests/hive-broadcast-timeout.test.ts` → 24/24 pass (sibling task; included for cross-coverage).
- `npx vitest run tests/routes/orcid.test.ts` → 65/65 pass. Operator-log lines visibly carry the new `"event":"broadcast_timeout"` field on the `BroadcastTimeoutError` path:
  ```
  {"level":40,"username":"alice","orcid":"0000-0001-2222-0013","mode":"link",
   "err":{"type":"BroadcastTimeoutError",...},"timeoutMs":30000,
   "event":"broadcast_timeout","msg":"orcid.handleLink broadcast timed out"}
  ```
- `npx vitest run tests/routes/accreditation.test.ts tests/routes/papers.test.ts tests/routes/claims.test.ts tests/routes/custody.test.ts tests/routes/bridge.test.ts` → 65/66 pass (1 pre-existing skip; no failures introduced by the round-5 changes; sibling routes that emit the new `event:` literals through their own `handleBroadcastError` callers).
- Full backend vitest deferred to the architect's pass.

### Files changed

- `backend/src/lib/broadcast-error.ts` — both PostBroadcastWriteError anchor sites: `err / cause / txId / failedStep` repositioned AFTER `...opts.logContext` (item 1, with inline cross-reference to round-5 hold #1). Three sibling logger sites: `event: 'broadcast_timeout' | 'broadcast_ambiguous' | 'broadcast_failed'` added AFTER the spread (item 2). Helper docblock updated to enumerate all 5 anchors with their structured-event discriminators.
- `backend/tests/lib/broadcast-error.test.ts` — existing exact-match expectations updated to include the new `event:` literals (forces regression detection on a missing literal even before the dedicated specs run); 3 new dedicated event-anchor pin specs (item 2); 2 new spread-kill specs covering 7 source-of-truth fields under negative-shape assertions (item 1).

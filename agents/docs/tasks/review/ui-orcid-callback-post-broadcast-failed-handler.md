# UI-ORCID-CALLBACK-POST-BROADCAST-FAILED-HANDLER — render confirmed-but-cascade-failed accreditation as successful

**Owner:** UI Agent
**Created:** 2026-04-29 (architect, surfaced by cluster 2 task 4 + task 6 cross-cluster `/ce-code-review` convergence at conf 100)
**Priority:** P2

## Problem

`backend/src/routes/orcid.ts` round-1 of `BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS` (commit `09e01e3`) activated a previously-dead `POST_BROADCAST_FAILED` 502 path: when the Hive broadcast confirms (the `accreditation_attestation` `custom_json` lands on chain) but a post-broadcast app-side write fails permanently (SQLSTATE class `23*` or `42*` on `accounts.orcid` UPDATE, or `TypeError`/`SyntaxError`/`RangeError` on the reputation seed), the route now emits `502 POST_BROADCAST_FAILED` with `details: { retriable:false, outcome:"confirmed", tx_id, failed_step }`.

Per `agents/docs/api-contracts/orcid.md:203-208`, this code means **the linkage is durably bound on chain** — chain state is correct; only the app-side denormalization or reputation seed needs reconciliation. The contract guidance for clients is to display the linkage as successful and direct the user to verify at `/settings`.

`frontend/src/pages/orcid-callback.js` `_verify()` catch block has branches for:
- `ORCID_ALREADY_LINKED` (409, all causes — durable)
- `BROADCAST_TIMEOUT` (504 — verify-before-retry)
- Generic API errors (renders `orcid.verificationFailed`)

It has **no** branch for `POST_BROADCAST_FAILED`. The 502 falls through to the generic catch, renders "verification failed" + a `/recover` affordance — but the user's ORCID is in fact bound correctly, so `/recover` is wrong UX (it would attempt a fresh OAuth flow against an already-bound ORCID and surface a 409 `ORCID_ALREADY_LINKED`).

Pre-fix this path was structurally dead (cascade fns swallowed all errors). Post-`09e01e3` the path fires on real production failure modes — primarily app-DB schema drift after a deploy that ships a migration plus dependent code, or reputation-weights config regression.

## Threat model / UX

- **Trigger:** post-deploy window where `accounts.orcid` UPDATE hits a `42*` SQLSTATE because the migration didn't run, OR reputation-weights config regression after a runtime override.
- **Pre-fix UX:** none of these errors surfaced to the user; cache miss self-healed on the next read.
- **Post-fix UX (today):** user sees "verification failed", may click `/recover` (forbidden because their ORCID is already bound), gets stuck.
- **Target UX:** user sees "ORCID linked successfully — your account-level data may take a moment to sync; verify at /settings before retrying" with a `/settings` CTA, no `/recover` button.

## Acceptance

### 1. Add `POST_BROADCAST_FAILED` branch to `_verify` catch

`frontend/src/pages/orcid-callback.js`. After the `ORCID_ALREADY_LINKED` branch and before the generic fallback, add:

```js
if (err?.code === 'POST_BROADCAST_FAILED' && err?.details?.outcome === 'confirmed') {
  this.errorMessage = $t('orcid.postBroadcastFailedConfirmed');
  this.errorAction = 'settings'; // CTA navigates to /settings
  this._verifyPhase = 'failed';
  return;
}
```

The exact local state shape and the action discriminator should follow the patterns already used by the durable 409 / timeout branches (`errorAction = 'recover' | 'signup' | 'settings' | ''`). Add a `'settings'` action only if it doesn't already exist; otherwise reuse.

### 2. Locale string

Add `orcid.postBroadcastFailedConfirmed` to `frontend/public/messages/en.json` with text along the lines of:

> "ORCID linkage was confirmed on chain, but a follow-up account-level write failed. Verify your ORCID linkage at /settings before retrying. The linkage will succeed; only the account-level fields need a moment to sync."

(UI agent owns the exact wording. No emdashes per project convention.)

Stub the key in the other 15 locale files (`ar`, `cs`, `da`, `de`, `es`, `fa`, `fr`, `he`, `it`, `nl`, `pl`, `pt`, `sv`, `tr`, `zh`) with the English text and append a row to `frontend/public/messages/STUBS.md` so future translation passes catch them.

### 3. Template

Update the template at `frontend/src/pages/orcid-callback.js` (Alpine `<template>` block) so the new branch renders correctly. The `errorAction === 'settings'` case should render a CTA pointing at `/settings` (the existing settings route).

### 4. Tests

`frontend/tests/unit/pages-orcid-callback.test.js`:

- Add a unit spec asserting that a 502 response with `error.code === 'POST_BROADCAST_FAILED'` and `details.outcome === 'confirmed'` renders the success-with-warning message and the `/settings` CTA, and does NOT render the `/recover` button.
- Mutation guard: assert that a 502 with `details.outcome` set to anything else (or absent) does NOT match this branch — the `outcome === 'confirmed'` discriminator is load-bearing per the contract.

### 5. No backend change required

The backend already emits the correct envelope (`code: POST_BROADCAST_FAILED`, `details: { outcome: "confirmed", tx_id, failed_step }`). This task is frontend-only.

## Out of scope

- **Auto-reconciling the app-side state.** The cascade re-throw + 502 IS the reconciliation signal — operators see `event:'post_broadcast_write_failed'` in logs and fix the underlying schema/config drift. Adding client-side reconciliation logic (e.g., polling /settings until `linked === true`) would mask the operator alert.
- **Changing the contract.** `agents/docs/api-contracts/orcid.md:203-208` is canonical; the implementer reads from there.
- **Other 502/504 surfaces.** This task is scoped to the ORCID callback path. If/when other endpoints adopt the cascade-rethrow pattern (per `backend-cascade-fns-rethrow-permanent-errors.md` non-goals), file separate UI tasks.

## Source

- `/ce-code-review` of cluster 2 task 4 (`backend-cascade-fns-rethrow-permanent-errors.md`) — api-contract finding conf 75 (frontend gap surfaced when reviewing the backend re-throw activation).
- `/ce-code-review` of cluster 2 task 6 (`ui-orcid-callback-retriable-machinery-remove.md`) — api-contract finding conf 85 (frontend gap re-confirmed during the machinery-removal review).
- Cross-cluster cross-reviewer convergence at conf 100 during architect aggregation.

## Coordination

- Backend companion task already shipped (`09e01e3`). Backend is NOT blocked on this UI task — the 502 path is correct on the wire; only the SPA UX is wrong.
- Cluster 2 task 6 (`ui-orcid-callback-retriable-machinery-remove.md`) can archive independently; the machinery-removal cleanup is correct and orthogonal to this new branch.

## Architect re-review (2026-05-15) — HELD PENDING FIXES:

Round-1 implementation at commit `9fe875d` lands the `POST_BROADCAST_FAILED` + `details.outcome === 'confirmed'` branch correctly. `/ce-code-review` was clean on correctness, security, reliability, project-standards, testing, maintainability, and learnings. **One item from the api-contract reviewer (conf 95) blocks archive:** the new branch needs to also match the sibling code `POST_BROADCAST_OPERATOR_REQUIRED`, otherwise the permanent-severity half of the cascade-failure space falls through to the generic verification-failed + `/recover` path — recreating the exact UX bug this task was filed to fix.

This is a scope gap in my original task spec, not an implementer miss. The spec referenced `agents/docs/api-contracts/orcid.md:203-208` only, and orcid.md itself did not document `POST_BROADCAST_OPERATOR_REQUIRED` (it does now — I edited orcid.md in the same review session to add the sibling-code bullet; see the section on `POST_BROADCAST_OPERATOR_REQUIRED` under the accredit/link errors). The cross-resource MUST in `agents/docs/api-contracts/common.md:74` says clients keying on `POST_BROADCAST_FAILED` for cascade failures MUST also include `POST_BROADCAST_OPERATOR_REQUIRED`. Backend emits it from the same ORCID route (orcid.ts:871-886 for accredit, orcid.ts:1035-1039 for link) when `PostBroadcastWriteError.severity === 'permanent'` — TypeError/SyntaxError/RangeError or SQLSTATE class `23*`/`42*`.

### What needs to land

1. **Second branch** in `frontend/src/pages/orcid-callback.js` `_verify()` catch — match `err.code === 'POST_BROADCAST_OPERATOR_REQUIRED' && err?.details?.outcome === 'confirmed'`. Same discriminator load-bearing rule (any other outcome / absent details falls through to the generic path). The two branches MUST NOT share copy — per `common.md:74` and the new orcid.md OPERATOR_REQUIRED bullet, `POST_BROADCAST_FAILED` should indicate automatic reconciliation, while `POST_BROADCAST_OPERATOR_REQUIRED` should indicate operator/support contact (the "give it a moment to sync" framing is misleading for the permanent class).

2. **Second i18n key** `orcid.postBroadcastOperatorRequired` in `frontend/public/messages/en.json` with copy along the lines of: "Your ORCID is linked. A follow-up step needs manual attention; please contact support if your linkage does not appear in Settings shortly." (UI agent owns exact wording. No emdashes.) Stub in the 15 other locale files and append a row to `frontend/public/messages/STUBS.md` under a fresh sweep heading. The `errorAction` for this branch should also be `'settings'` (the CTA path is correct — verify in Settings) so no template change is needed; the message itself carries the operator-contact framing.

3. **Mirror unit tests** in `frontend/tests/unit/pages-orcid-callback.test.js`:
   - happy path: 502 with `code === 'POST_BROADCAST_OPERATOR_REQUIRED'` and `details.outcome === 'confirmed'` renders the operator-required message and `errorAction === 'settings'`, NOT `'recover'`.
   - mutation guards: same three fallthrough cases (missing outcome, wrong outcome, no details) for the OPERATOR_REQUIRED code, mirroring the existing POST_BROADCAST_FAILED tests.

4. **errorAction comment** on line ~69 of `orcid-callback.js` — extend the inline enumeration to mention both POST_BROADCAST_FAILED and POST_BROADCAST_OPERATOR_REQUIRED.

### Out of scope for this hold round

- The CTA-label issue (`common.tryAgain` is the wrong verb on the `errorAction === 'settings'` template path — "Try Again" after "Your ORCID is linked"). I filed this as a separate UI task at `tasks/pending/ui-orcid-callback-settings-cta-label.md` because it also affects the BROADCAST_TIMEOUT branch and is orthogonal to the POST_BROADCAST_OPERATOR_REQUIRED contract gap.
- Changing the wording of the existing `orcid.postBroadcastFailedConfirmed` string — it is correct for the transient (auto-reconciling) class.

### Architect signal

After landing the four items above, `git mv` this file back to `tasks/review/`. I'll re-review the new diff scoped to commits since this hold block was written.

## UI re-review signal (2026-05-15, working tree pending commit)

Round-2 fixes landed against the four hold items:

1. **Second branch in `_verify` catch** — `frontend/src/pages/orcid-callback.js`. Added `if (err.code === 'POST_BROADCAST_OPERATOR_REQUIRED' && err?.details?.outcome === 'confirmed')` immediately after the existing `POST_BROADCAST_FAILED` branch. Same `errorAction = 'settings'`, distinct copy via the new `orcid.postBroadcastOperatorRequired` key (operator-contact framing, not the "give it a moment to sync" framing). Inline comment documents the contract rationale and the sibling-code relationship per `common.md:74`.
2. **Second i18n key** — `frontend/public/messages/en.json` adds `orcid.postBroadcastOperatorRequired`: "Your ORCID is linked. A follow-up step needs manual attention. Please contact support if your linkage does not appear in Settings shortly." Stubbed identically in the 15 non-English locale files. New sweep heading appended to `frontend/public/messages/STUBS.md`: `### Added 2026-05-15 (UI-ORCID-CALLBACK-POST-BROADCAST-FAILED-HANDLER)` with all 15 locale-key lines. No template change (the existing `errorAction === 'settings'` block already wires `/settings`; only the message differs).
3. **Mirror unit tests** — `frontend/tests/unit/pages-orcid-callback.test.js`. Added 4 tests mirroring the existing POST_BROADCAST_FAILED suite: happy path (renders operator-required message + `errorAction === 'settings'`, NOT `'recover'`); three mutation guards (missing outcome / wrong outcome value / no details object — all fall through to the generic warn+`verificationFailed` path). Full unit file now 46 tests, all green.
4. **errorAction comment** — line 69 of `orcid-callback.js` enumeration now reads: `'settings' for BROADCAST_TIMEOUT, POST_BROADCAST_FAILED (outcome:'confirmed'), and POST_BROADCAST_OPERATOR_REQUIRED (outcome:'confirmed')`.

CTA-label hold-out (`common.tryAgain` vs. a settings-specific label) is being handled in the separate orthogonal task at `tasks/pending/ui-orcid-callback-settings-cta-label.md` per the architect's "out of scope for this hold round" note.

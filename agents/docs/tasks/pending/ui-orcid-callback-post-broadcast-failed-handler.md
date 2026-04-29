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

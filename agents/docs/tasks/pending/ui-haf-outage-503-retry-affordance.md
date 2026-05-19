# UI-HAF-OUTAGE-503-RETRY-AFFORDANCE — wire SPA to surface retry on the four backend-translated HAF outage routes

**Owner:** UI Agent
**Created:** 2026-05-20 (architect, surfaced by cluster review of backend-haf-outage-translation-audit-across-routes)
**Priority:** P2

## Problem

`backend-haf-outage-translation-audit-across-routes` translates raw pg failures to `HafQueryError` → 503 retriable at four single-resource routes. The backend wire envelope is `{status:'error', error:{code:'SERVICE_UNAVAILABLE', message:'X temporarily unavailable. Please retry shortly.', details:{retriable:true}}}`.

The SPA does not consume the new signal on three of four routes; the fourth route has zero SPA call sites yet. The `details.retriable` flag the audit was designed to drive is discarded.

## Affected sites

| Route | SPA call site | Current behavior |
|---|---|---|
| `GET /api/profile/:username/papers` | `frontend/src/pages/profile.js:371` | `fetchProfilePapers(...).catch(() => ({ data: [] }))` — blanket swallow. A 503 is rendered as "no papers"; user sees empty list with no retry affordance. |
| `GET /api/profile/:username/reviews` | `frontend/src/pages/profile.js:422-428` | Catches all errors by setting `userReviews=[]`. Same swallow shape. |
| `GET /api/papers/:author/:permlink/comments` | `frontend/src/components/threaded-comments.js:127` | Catches all errors to a generic error string. `details.retriable` never read; no retry button. |
| `GET /api/reviews/:author/:permlink` | `fetchReview` exported from `frontend/src/api.js` | Zero SPA call sites. Wire when the review-detail page lands; verify retry handling at that point. |

The retry pattern is already established at `frontend/src/components/accreditation-verify.js:159` (reads `err?.details?.retriable`) for a different flow — this task wires the same pattern at the four sites above.

## Goal

For each of the three routes with existing callers, replace the blanket `.catch` with a discriminating catch that:

- Reads `err.code === 'SERVICE_UNAVAILABLE'` and `err.details?.retriable === true`.
- Surfaces a retry affordance (button, banner, or automatic backoff — choose per site's UX context) instead of silently rendering empty state.
- Preserves the existing empty-state render for legitimate "no data" responses (200 [] / 404).

For `fetchReview`, ensure the future review-detail page consumer handles 503 retriable from the outset; until that consumer lands, document the contract in the API helper.

## Acceptance

1. Each of the three with-callers sites distinguishes 503 retriable from 200 [] / 404 and renders a different UI state for the transient-failure case.
2. Behavioral test (E2E or component) per touched site asserting the retry affordance renders on 503 retriable. Use the established `verifyHiveSignature` test patterns where applicable; if route-layer is impractical to spin up in unit tests, an E2E in the existing playwright suite is acceptable.
3. `fetchReview` carries an inline JSDoc note (or comment in `api.js`) flagging that consumers must handle 503 retriable.

## Out of scope

- Backend changes. The 503 emission is correct per `backend-haf-outage-translation-audit-across-routes`. This task is SPA-side wiring only.
- Auto-retry-with-backoff infrastructure beyond surfacing the affordance. A P3 enhancement; the current task is "stop discarding the signal."
- `retract` / `anonymousReview` / other routes not on the haf-outage list — separate concern.

## Cross-references

- `agents/docs/tasks/pending/backend-haf-outage-translation-audit-across-routes.md` (currently held; the backend contract this task consumes). On archive, the reference shifts to `tasks-archive.md`.
- `frontend/src/components/accreditation-verify.js` — the established `err?.details?.retriable` pattern.
- `agents/docs/api-contracts/profiles.md`, `reviews.md`, `papers.md` — architect-updated in the same review pass to enumerate 503 SERVICE_UNAVAILABLE for these routes.

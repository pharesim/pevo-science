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

## UI completion signal (2026-05-20)

### Wiring summary

| Route | SPA call site | Wiring landed |
|---|---|---|
| `GET /api/profile/:username/papers` | `frontend/src/pages/profile.js` `loadProfile` | Discriminating catch on the `fetchProfilePapers` sub-fetch sets `papersRetriable` when `err.code === 'SERVICE_UNAVAILABLE' && err.details?.retriable === true`. Template adds a retry card (`data-testid="profile-papers-retry"`) gated on `papersRetriable`, distinct from the existing `noPapers` empty state. |
| `GET /api/profile/:username/reviews` | `frontend/src/pages/profile.js` `loadReviews` | Same shape: `reviewsRetriable` flag + retry card (`data-testid="profile-reviews-retry"`), kept separate from the legitimate `noReviews` empty state. |
| `GET /api/papers/:author/:permlink/comments` | `frontend/src/components/threaded-comments.js` `loadComments` | `errorRetriable` flag set on the same discriminator; consumers (`frontend/src/pages/paper-detail.js` review-thread mount + top-level discussion mount) now render a `common.retry` button via `x-show="errorRetriable"`. `comments.serviceUnavailable` copy distinguishes the transient case from the generic `comments.error`. |
| `GET /api/reviews/:author/:permlink` | `fetchReview` in `frontend/src/api.js` | Zero call sites today; inline JSDoc-style note on the helper points future consumers at the established pattern + the threaded-comments wiring. |

### Tests

Component-tier (vitest) per the "E2E or component" acceptance:

- `frontend/tests/unit/components-threaded-comments.test.js` — 4 new tests covering the discriminator (retriable flag, fallback to generic on non-retriable, no-flag on missing `details.retriable`, clear-on-retry).
- `frontend/tests/unit/pages-profile.test.js` — 6 new tests across `loadProfile`/`loadReviews` covering the same shape (flag on 503 retriable, no-flag on plain failure, clear-on-retry).

Full unit suite: 1221 tests passing (62 files).

### i18n

- New keys in `frontend/public/messages/en.json`: `profile.papersUnavailable`, `profile.reviewsUnavailable`, `comments.serviceUnavailable`.
- Stubbed in all 15 non-English locale files (English text inline per the stub convention).
- `frontend/public/messages/STUBS.md` carries a fresh `### Added 2026-05-20 (UI-HAF-OUTAGE-503-RETRY-AFFORDANCE)` sweep header.

Retry buttons reuse the existing `common.retry` key (no new copy needed).

## Architect re-review (2026-05-20) — HELD PENDING FIXES:

The wiring shape is right and the test coverage is appropriate for the discriminator. Three flag-lifecycle issues need to land before archive. Surfaced by `/ce-code-review` (correctness, julik-frontend-races, and maintainability concurred on item 1; correctness flagged item 2; correctness and julik concurred on item 3).

1. **Move the `papersRetriable` mutation behind the stale-call guard in `loadProfile`.** The current shape sets `this.papersRetriable = true` from inside the `fetchProfilePapers().catch()` lambda, which executes synchronously as part of the rejection chain — before the post-`Promise.all` `if (this.username !== username) return` guard runs. A stale 503 from an in-flight fetch on the prior profile lands the flag on the new profile's component (the page-mount reuses the same Alpine `x-data` instance across param changes). The result is a briefly-visible retry card belonging to the previous username. The fix is to either capture a local boolean inside the catch lambda and assign `this.papersRetriable = local` after the existing username guard, OR re-check `this.username !== username` inside the lambda before mutating. Either shape matches `loadReviews`'s guard-then-mutate order, which is correct as-is.

2. **Tighten the retry-card template guards so retry-card and populated-list cannot co-render.** The retry-card templates use `x-if="papersRetriable"` / `x-if="reviewsRetriable"` with no list-length disjunction; the list templates have no `!retriable` disjunction; and `papersRetriable`/`reviewsRetriable` are only cleared at the top of each (re)load, never on the success path. Tighten the retry-card `x-if` to `papersRetriable && userPapers.length === 0` (and the reviews equivalent), AND clear the flag on the success path of each loader, so a successful retry returns the user to a clean populated/empty state without depending on the next call's top-of-function reset.

3. **Add a synchronous in-flight guard at the top of `loadComments`, and prevent stale-catch data clobber in `loadReviews`.** The retry `@click` handlers added in this commit make concurrent `loadComments()` invocations newly reachable (two retry buttons + the existing `comment-posted` window listener can trigger overlapping fetches). A tight double-click can also let a stale 503-rejecting fetch's catch clobber a successful retry's data — fetch B resolves, populates state, then fetch A rejects and the catch sets `userReviews = []` + `reviewsRetriable = true`, defeating the retry. Add `if (this.loading) return;` (or `if (this.reviewsLoading) return;`) as the first statement before any `await` in both `loadComments` and `loadReviews`, per `agents/docs/solutions/conventions/synchronous-flag-before-await-idempotency-guard-2026-05-16.md`. If you prefer a per-call ticket counter over the in-flight guard, that's also acceptable — the invariant is "only the most recent call's catch may mutate state."

Out of scope for this hold cycle:
- STUBS.md sweep-header format (precedent across 25 prior entries; convention-conformant as written).
- `fetchReview` JSDoc cross-file reference shape (file-path-with-symbol-fragment is acceptable for a cross-file JSDoc).
- Negative-case tests for the strict `=== true` discriminator (backend contract is fixed; theoretical hardening).
- `loadProfile` retry re-fetching `fetchProfile` when only papers failed (residual risk noted; same-HAF-backend means partial failure is rare).
- `comment-posted` window-listener permlink filter at `paper-detail.js` outer mounts (pre-existing; out of this task's scope).

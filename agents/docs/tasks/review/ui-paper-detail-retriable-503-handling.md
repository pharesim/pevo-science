# UI-PAPER-DETAIL-RETRIABLE-503-HANDLING — Surface 503 retry affordance on paper-detail surfaces

**Owner:** UI Agent
**Created:** 2026-05-20 (architect, surfaced by `/ce-code-review` of `backend-fetch-paper-detail-haf-error-vs-not-found` round-1 commit `b427a70` during the 2026-05-20 HAF-cluster review)
**Priority:** P2 (UX regression)

## Problem

The recent backend HAF-error-translation work (commit `b427a70`) and the walker wall-clock-budget work (commit `94bf294`) added `503 SERVICE_UNAVAILABLE` with `details.retriable: true` responses to all four paper-detail-class routes:

- `GET /api/papers/:author/:permlink` — HafQueryError-translation 503 + walker-budget 503
- `GET /api/papers/:author/:permlink/enrichment` — same two triggers
- `POST /api/papers/:author/:permlink/retract` — same two triggers
- `GET /api/papers/:author/:permlink/cite` — same two triggers

The SPA does NOT branch on `err.code === 'SERVICE_UNAVAILABLE'` or `err.details?.retriable === true` at any of the paper-detail call sites.

**Concrete UX regression at `frontend/src/pages/paper-detail.js:803-820`:** `loadPaper()` has a NOT_FOUND retry loop (3 attempts via `notFoundRetryDelaysMs`) AND a NOT_FOUND-specific localized error title. All other errors — including the new SERVICE_UNAVAILABLE — fall through to a generic error message with no retry. Pre-fix, a HAF transient outage returned 404 → entered the retry loop → often succeeded on retry. Post-fix, the same outage returns 503 → bypasses the loop entirely → user sees the generic error immediately with no retry CTA.

**`loadEnrichment()`** silently swallows the 503 with `console.warn` only — degraded behavior acceptable (the page renders without enrichment), but no user feedback that the metadata pane is empty due to transient failure.

**`handleRetract()`** and **`handleCitationExport()`** swallow the 503 to a generic toast. The user sees "Retract failed" or "Citation export failed" with no transient-vs-permanent discrimination.

**Wiring exists in `ApiError`:** `frontend/src/lib/api.js:15-20` already populates `ApiError.code` and `ApiError.details` from the response envelope; `loadProfile()` (per the in-flight `ui-haf-outage-503-retry-affordance` task) demonstrates the discrimination pattern. The paper-detail page just doesn't use it.

## Scope distinction

This task is **sibling, not subset, of `ui-haf-outage-503-retry-affordance`**. That task covers `frontend/src/pages/profile.js` (`loadProfile`) and `frontend/src/components/threaded-comments.js` (`loadComments`). It does NOT touch `paper-detail.js`. The implementer should treat the two tasks as independent; they can land in either order.

## Goal

Add `SERVICE_UNAVAILABLE` + `details.retriable: true` branching to all four paper-detail SPA call sites. Surface a retry affordance (button + localized message) for the user-initiated triggers; surface a degraded-mode hint for the automatic ones.

## Acceptance

### 1. `loadPaper()` 503 handling

`frontend/src/pages/paper-detail.js:803-820` `loadPaper()`:

- Add a `SERVICE_UNAVAILABLE` branch ahead of the generic error fall-through.
- When `err.code === 'SERVICE_UNAVAILABLE' && err.details?.retriable === true`: render a localized "HAF temporarily unavailable" title + a `common.retry` button. The retry button re-invokes `loadPaper()`.
- Consider auto-retry: the NOT_FOUND branch retries 3 times automatically. Decide whether `SERVICE_UNAVAILABLE` should auto-retry the same way (likely YES, since the retriable signal is the backend explicitly inviting retry); use the same `notFoundRetryDelaysMs` pattern or a new `serviceUnavailableRetryDelaysMs` constant.
- Localized strings: `paperDetail.serviceUnavailableTitle` + `paperDetail.serviceUnavailableMessage` + `common.retry`. Add to all locale files.

### 2. `loadEnrichment()` 503 handling

`paper-detail.js` `loadEnrichment()`:

- The current `console.warn`-only behavior is acceptable for the auto-load path (page renders without enrichment metadata).
- Surface a small "Enrichment temporarily unavailable. [Retry]" hint in the enrichment panel area, gated on `enrichmentRetriable: true` set when `err.code === 'SERVICE_UNAVAILABLE' && err.details?.retriable === true`. Distinct from the panel being legitimately empty (no enrichment data exists).
- Test affordance: `data-testid="enrichment-retry"` to enable E2E coverage.

### 3. `handleRetract()` 503 handling

`paper-detail.js` `handleRetract()`:

- 503 SERVICE_UNAVAILABLE: surface a localized toast "Retraction temporarily unavailable. Please retry shortly." (matching the backend's per-route message string post-`backend-fetch-paper-detail-haf-error-vs-not-found` round-2 hold item 6).
- Bound the user's manual retry rate. Per the sibling `backend-retract-rate-limit-haf-503-burn` task, the backend's `retractLimiter` may consume slots per attempt — the SPA should NOT auto-retry on `details.retriable` for `/retract` to avoid burning the user's daily retract slot budget. Surface the retry affordance as a manual button, not an auto-loop. Once `backend-retract-rate-limit-haf-503-burn` lands and the backend exempts retriable-503 from slot consumption, the SPA can optionally auto-retry; until then, manual-only.

### 4. `handleCitationExport()` 503 handling

`paper-detail.js` `handleCitationExport()`:

- 503 SERVICE_UNAVAILABLE: surface a localized toast "Citation export temporarily unavailable. Please retry shortly." Auto-retry up to 2 times with backoff (citations are read-only; no rate-limiter slot concern).
- Distinguish from 404 (paper not found, citation generator dispatch failed) and 400 (bad format).

### 5. Localization

Add the new strings to all locale files under `frontend/src/locales/`. Match the structure used by the in-flight `ui-haf-outage-503-retry-affordance` task (likely `paperDetail.serviceUnavailableTitle`, etc.).

### 6. Tests

Add E2E or component-test coverage per existing patterns in the UI codebase. At minimum:

- `loadPaper()` 503 → retry button visible + auto-retry attempted.
- `loadPaper()` 404 → existing NOT_FOUND retry behavior unchanged (regression coverage).
- `loadEnrichment()` 503 → hint visible.
- `handleRetract()` 503 → manual retry button only (no auto-loop).

If E2E coverage is impractical, vitest unit tests against the `loadPaper()` / `loadEnrichment()` / `handleRetract()` / `handleCitationExport()` error-branch logic with a mocked `ApiError`.

## Out of scope

- Backend-side changes. All backend work for the 4 routes' 503 envelopes is complete (b427a70 + 94bf294 + ongoing round-2/round-3 holds for cause-discrimination); this task is SPA-side only.
- `loadComments()` / `loadProfile()` 503 handling — covered by the sibling `ui-haf-outage-503-retry-affordance` task in `tasks/pending/`.
- General-purpose error-handling refactor across paper-detail.js. Scope is limited to the 4 affected route call sites.
- Generic SPA-level 503 interceptor (e.g., at the api.js layer). Per-call-site handling lets each consumer choose the appropriate affordance (auto-retry vs manual button vs degraded-mode hint); a global interceptor would force a single shape across all 503s.

## Cross-references

- `backend/src/routes/papers.ts` — backend emit sites for the 4 routes' 503s.
- `agents/docs/api-contracts/papers.md` — contract docs enumerating the 503 SERVICE_UNAVAILABLE envelope on all 4 routes (landed 2026-05-20 in commit `66b213ac`).
- `agents/docs/api-contracts/common.md` § 503 SERVICE_UNAVAILABLE and details.retriable — the cross-cutting note enumerating the emitter classes.
- `agents/docs/tasks/pending/ui-haf-outage-503-retry-affordance.md` — sibling task covering profile + threaded-comments. Borrow the retry-button + localization pattern from there.
- `agents/docs/tasks/pending/backend-retract-rate-limit-haf-503-burn.md` — backend task that gates whether `/retract` 503 retries can be auto-loop or must stay manual-only (currently the latter until that task lands).
- `frontend/src/lib/api.js:15-20` — `ApiError` already exposes `code` and `details` from response envelopes.
- `frontend/src/pages/paper-detail.js:803-820` — `loadPaper()` retry-loop pattern to extend.

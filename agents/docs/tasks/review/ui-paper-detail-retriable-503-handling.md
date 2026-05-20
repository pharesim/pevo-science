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

---

## Architect re-review (2026-05-20) — HELD PENDING FIXES

`/ce-code-review` fan-out (8 reviewers, full persona set minus `ce-agent-native-reviewer` per PEvO policy) on the round-1 implementation surfaced 6 items that block archive. The four-site coverage, the per-site policy divergence (auto-retry for reads, manual-only for retract), and the unit-test scaffolding are sound. Items below are correctness, hygiene, and one user-visible race.

A separate sweep task (`ui-frontend-retry-timer-guard-sweep`) is being filed to handle the timer-guard adoption gap that surfaced across this commit and the bridge.js commit — that's not held here because it crosses two implementer commits.

### Item 1 — Citation dropdown + format buttons missing `:disabled` during 4s 503-retry window

`handleCitationExport` now has bounded auto-retry (up to 2× with backoff = ~4s wall-time window). During that window, `citeOpen` stays `true` (only closes via `finally` at loop exit) and the three format buttons (APA / BibTeX / RIS) have no `:disabled` binding tied to in-flight state. Concrete scenario: user clicks APA → 503 retriable → 1500ms backoff starts; user clicks BibTeX during the backoff → second `handleCitationExport` flow fires concurrently; both flows complete; both write to clipboard (last-write-wins) and trigger downloads. Pre-diff race window was ~200ms (invisible); post-diff is ~4000ms (hittable).

Fix: add `:disabled="citeLoading"` (or a sibling in-flight flag) to the three format buttons, set the flag synchronously at handler entry (before the first `await`), clear it in `finally`. Optionally close the dropdown synchronously at handler entry too.

### Item 2 — handleRetract comment cites stale slot-burn rationale

The `handleRetract` 503 catch comment says the backend retract limiter "currently consumes a slot per attempt" and justifies the manual-only retry policy on that basis. Sibling commit `a5589588` (which landed `backend-retract-rate-limit-haf-503-burn` shortly after this commit) added `skipFailedRequests:true` to `retractLimiter` — slots are now refunded on `>=400`. The cited rationale is no longer accurate.

The manual-only choice is still correct (retract is a destructive write op; positive-confirmation UX is appropriate regardless of limiter behavior), so the policy stays. Reword the comment to anchor on the stable invariant (write-op user-confirmation, broadcast idempotency concerns) and drop the slot-burn citation. Per the root CLAUDE.md "Comment anchors" rule, comments should not cite sibling-module behavior that can change without notice.

### Item 3 — `handleCitationExport` retry leaks paper identity on tab-switch

`handleCitationExport`'s retry loop has no `this.author !== author || this.permlink !== permlink` paper-identity guard (unlike `loadPaper`, which carries this guard from the pre-existing NOT_FOUND retry pattern). Concrete scenario: user on paper A clicks APA → 503 retriable → backoff starts; user navigates to paper B mid-backoff; retry attempt fires against paper A's captured `author`/`permlink` closure values; download filename reads from `this.permlink` (now paper B) while content carries paper A's citation. User gets a download named for the current paper containing data for the prior paper.

Fix: add the paper-identity guard inside `handleCitationExport`'s retry loop, matching the existing guard in `loadPaper`. Place it post-await on both the backoff sleep and the fetch promise.

### Item 4 — `enrichmentRetriable` hint renders alongside stale-but-valid reviews data

`loadEnrichment` is called from `handleClaimSlot` / `handleApproveClaim` / `handleRejectClaim` after the initial paper-detail load has already succeeded. If a re-fetch fails with 503 retriable, `enrichmentRetriable` is set true and the template renders "Reviews and votes are temporarily unavailable. [Retry]" above the reviews section while the prior reviews data from the initial load is still visible below. Copy says "unavailable"; visible state contradicts the copy.

Fix: either (a) gate the hint on `!enrichmentLoaded` so it only shows on first-load failures, or (b) reword the hint to "Could not refresh reviews and votes. [Retry]" so it makes sense in both first-load-failed and refresh-failed cases. Implementer discretion.

### Item 5 — `loadEnrichment` console.warn unconditional on recognized retriable-503

`loadPaper`'s catch carries a semantic-code carve-out: recognized `NOT_FOUND` and recognized retriable-503 do NOT trigger `console.warn`; only unrecognized errors do. The carve-out exists to prune log noise during HAF outages. `loadEnrichment`'s catch fires `console.warn` on every error including the recognized retriable-503. During a HAF outage, every paper-detail page that triggers a claim mutation would emit a `loadEnrichment` warning per attempt per user.

Fix: align `loadEnrichment`'s error handling with `loadPaper`'s carve-out — move the `console.warn` into an `else` branch so it fires only on unrecognized errors. This is not a request to add logs; it's a structural shift that prunes existing log emission on a known-and-handled condition, consistent with PEvO's logging-minimal policy.

### Item 6 — Enrichment retry banner button missing `:disabled` guard

The "Reviews and votes are temporarily unavailable. [Retry]" hint button has no `:disabled` binding tied to in-flight state. Rapid double-click produces concurrent `fetchPaperEnrichment` calls with last-write-wins on `paper.reviews`. Same shape as Item 1 (citation dropdown) but for the enrichment retry surface. Failure mode is milder than Item 1 (no duplicate side effects — both attempts hit a read endpoint), but still wasteful and produces brief UI flicker.

Fix: add `:disabled` binding to the retry button tied to an `enrichmentRetrying` flag set synchronously at click-handler entry, cleared in `finally`. Mirror Item 1's fix shape.

---

## UI re-review signal (2026-05-20, commit 6b05c157)

Round-2 fixes landed in commit `6b05c157`. All six architect hold items addressed:

- **Item 1 (citation dropdown :disabled).** The three format buttons (APA / BibTeX / RIS) inside the citation dropdown now carry `:disabled="citeLoading"` with `disabled:opacity-50 disabled:cursor-not-allowed` styling. The dropdown also closes synchronously at `handleCitationExport` entry (`citeOpen = false`) so the visible UI matches the in-flight gate during the retry window.
- **Item 2 (handleRetract comment).** The prior slot-burn citation removed; the rewritten comment anchors on the stable invariant — retract is a destructive, chain-visible write op so positive user confirmation per attempt is the correct posture regardless of how the backend limiter handles failures.
- **Item 3 (paper-identity guard).** `handleCitationExport` now captures `author`/`permlink` at handler entry and uses the captured closures for both the `fetchCitationExport` call and the download filename. Post-await identity guards fire after each loop arm (post-fetch success, post-backoff sleep, post-fetch error). The `finally` block also guards the `citeLoading` reset so a stale completion does not flip the new paper's flag.
- **Item 4 (enrichmentRetriable gating).** Chose option (a): template gates on `enrichmentRetriable && !enrichmentLoaded`. Refresh failures from claim-mutation flows are now silent (the still-visible reviews data isn't contradicted by the banner); first-load failures still surface the retry affordance.
- **Item 5 (loadEnrichment console.warn carve-out).** `console.warn` moved into an `else` branch that fires only for unrecognized errors. Recognized retriable-503 surfaces via `enrichmentRetriable = true` without a log emission, aligning with `loadPaper`'s carve-out.
- **Item 6 (enrichment retry :disabled).** New `enrichmentRetrying` state + `retryEnrichment()` wrapper around `loadEnrichment`. The retry button binds `:disabled="enrichmentRetrying"` and `@click="retryEnrichment()"`. The wrapper sets the flag synchronously at entry, clears it in `finally`; a re-entrant call sees the flag and bails (`if (this.enrichmentRetrying) return;`).

Test result: 77/77 pass in `pages-paper-detail.test.js` (was 73/73 before). Four new vitest cases: recognized 503 carve-out, unrecognized-error warn fallback, `retryEnrichment` in-flight guard, citation tab-switch identity guard. Full E2E run deferred per the docker-stack test-up/test-down requirement.

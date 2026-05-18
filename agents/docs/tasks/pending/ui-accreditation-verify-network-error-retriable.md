# UI-ACCREDITATION-VERIFY-NETWORK-ERROR-RETRIABLE — Route network-layer fetch errors (TypeError / AbortError) to the retriable Retry CTA

**Owner:** UI
**Created:** 2026-05-17 (architect, from `/ce-code-review` finding #5 on `ui-accreditation-verify-retriable-handling` round-1 commit `b66a370`)
**Priority:** P3 (UX cascade during network blip; sibling concern to the just-landed backend-emitted retriable handling)

## Problem

`ui-accreditation-verify-retriable-handling` (commit `b66a370`) made the SPA branch retriable verify errors on `err.code === 'ACCREDITATION_GATE_UNAVAILABLE'` or `err.details?.retriable === true`. Both signals live on `ApiRequestError` — the structured envelope `frontend/src/api.js` produces when the backend responds with a 4xx/5xx.

Network-layer errors never reach `ApiRequestError`:

- `TypeError` from `fetch()` — DNS failure, connection refused, browser offline, mid-flight network drop, CORS rejection.
- `AbortError` from the fetch timeout (default 30s in `api.js`).

These errors carry no `.code` or `.details`, so `_isRetriable` returns false and they fall through to the generic `'error'` state with the "Request New" CTA. The user clicks "Request New", burns one of their 3/24h `/api/accreditation/request` slots, and re-enters the email flow. This is exactly the cascade `ui-accreditation-verify-retriable-handling` was filed to prevent, just one error class up.

The verification token is preserved on the server in all these cases (the backend was never reached, so `deleteTokenBestEffort` was never called), so a retry would succeed as soon as the network recovers.

## Goal

Extend the SPA's verify-page error classification so that network-layer errors route to a Retry CTA (re-using the existing `retriable_error` state machinery, or a new peer state — see open questions). The Retry button must re-invoke `verifyAccreditation(this._token)` against the same token.

## Open design questions

1. **Distinct copy?** Should the network-error branch render the same `verify.serviceTemporarilyUnavailable` copy as the HAF-outage branch, or a more specific message like "Network connection lost. Please check your connection and try again."? Suggestion: distinct copy key (e.g., `verify.networkUnavailable`) so the user sees actionable diagnosis. New key fans out to all 16 locales via the standard stub-then-translate flow.

2. **Backoff for AbortError?** A 30s fetch timeout suggests the backend is slow but reachable. Immediate retry may just trigger another 30s timeout. Suggestion: fixed 5s cooldown for AbortError; immediate retry for TypeError (offline → retry as soon as the user is back online, no point waiting).

3. **Discriminator shape.** Two options:
   - Extend `_isRetriable` to also return true for `err?.name === 'TypeError' || err?.name === 'AbortError'`.
   - Add a separate `_isNetworkError(err)` predicate and a third state `network_error` with its own template branch.

   Suggestion: extend `_isRetriable` and reuse the existing `retriable_error` template branch — keeps the state machine to four states. Differentiate copy + backoff inside `_verify`'s catch arm (look up `err.name` to pick the right `errorMessage` and pass the right initial cooldown to `_startCooldown`).

4. **Does `frontend/src/api.js` already wrap `TypeError` / `AbortError` into `ApiRequestError`?** Verify before implementing — if so, the discriminator can stay on `err.code`. If not (likely the case, since `ApiRequestError` is constructed from the response body), the discriminator must inspect `err.name` or `err.constructor`.

## Acceptance

The implementer should propose acceptance shape in round-1 based on the design-question resolutions above. At minimum:

### 1. Network-layer errors route to a Retry CTA

`TypeError` and `AbortError` instances caught in `_verify` route to a Retry UI state (existing `retriable_error` or a new peer — design call). The UI MUST surface a Retry button and MUST NOT route to the "Request New" CTA that burns a `/accreditation/request` slot.

### 2. Token preserved across the retry

Retry re-invokes `verifyAccreditation(this._token)` against the same token. Same invariant as `ui-accreditation-verify-retriable-handling` acceptance #2.

### 3. Cooldown uses existing machinery

Implementation reuses `_startCooldown` / `_cooldownId` / `_tickCooldown` — no new timer scaffolding. If the design picks a fixed backoff for AbortError, pass the seconds directly to `_startCooldown(5)`.

### 4. Distinct copy + i18n stubs if a new key is added

If the design picks a new translation key, add it to `frontend/public/messages/en.json` + 15 stub locale files + STUBS.md sweep entry following the standard convention (see `agents/ui/CLAUDE.md` § Internationalization).

### 5. Test coverage

Add specs:

- `TypeError` thrown from `verifyAccreditation` routes to the Retry CTA (not Request New).
- `AbortError` thrown from `verifyAccreditation` routes to the Retry CTA.
- Retry click after a network error re-invokes `verifyAccreditation(token)` against the same token (mirrors AC #6 of the sibling task).
- If a fixed cooldown is picked for AbortError, assert `retryCooldownRemaining` initializes to that value.

### 6. Hold-block round 1 of sibling task is landed first

This task should NOT start until `ui-accreditation-verify-retriable-handling` round-1 holds (2 items) are addressed and that task is archived — otherwise both rounds will conflict on the same file.

## Out of scope

- Backend changes — none needed. The token is already preserved on network-error paths because the request never reached the backend.
- Generalizing network-error retriable handling to other SPA pages — this task scopes to the verify endpoint only. Sibling pages (publish, review, settings) can adopt the same shape later.

## Source

- `/ce-code-review` finding #5 on commit `b66a370` (`ui(accreditation-verify): retriable-error branch + Retry CTA`), 2026-05-17.

## Cross-references

- `frontend/src/pages/accreditation-verify.js` — verify page (already has `_isRetriable` and the cooldown machinery).
- `frontend/src/api.js` — `ApiRequestError` shape; verify whether `TypeError` and `AbortError` propagate raw or wrapped.
- Sibling: `ui-accreditation-verify-retriable-handling` (just landed; covers backend-emitted retriable envelopes).

---

## Implementer signal (UI, 2026-05-17, commit `a6fc5d4`)

Round-1 implementation landed at commit `a6fc5d4` (`ui(accreditation-verify): route network-layer errors to Retry CTA`). The mv-to-review commit (`480909d`) was a pure rename with no content; the implementation is the prior commit. Design decisions made:
- **Discriminator shape:** `_isNetworkError(err)` predicate on `err?.name === 'TypeError' || err?.name === 'AbortError'`, separate from `_isRetriable` (which keys on `err?.code` / `err?.details?.retriable` for backend-emitted retriable envelopes).
- **Cooldown:** AbortError → 5s (backend slow but reachable; give it time before re-arming the 30s fetch timeout). TypeError → 0s (offline / DNS / CORS — user is the trigger, immediate retry once connectivity restored).
- **Copy key:** new `verify.networkUnavailable` in `en.json` + 15 locale stubs + STUBS.md sweep entry.
- **State machine:** reuses existing `retriable_error` state; `_isNetworkError` runs before `_isRetriable` in the catch arm (no collision since `ApiRequestError.name === 'ApiRequestError'`).
- **Tests:** 3 specs in `pages-accreditation-verify.test.js` — TypeError → 0s; AbortError → 5s + tick; Retry click re-invokes against the same token.

---

## Architect round-1 re-review (2026-05-18) — HELD PENDING FIXES

`/ce-code-review` cluster-pass on commit `a6fc5d4` dispatched 8 reviewers: correctness, testing, maintainability, project-standards, julik-frontend-races, reliability, adversarial, ce-learnings-researcher (skipping `ce-agent-native-reviewer` per root CLAUDE.md). Cross-reviewer corroboration on the slug-citation finding (maintainability × project-standards, anchor 100). The round-1 implementation is functionally well-defended: four guard layers (`_mounted` check, `_verifyGeneration` capture-and-compare, `_cooldownId` capture-and-compare, `state === 'loading'` early-return) correctly bound concurrent retry / unmount-during-cooldown / late-resolver scenarios. Type-safety clean. One item held; one-line edit.

### Item 1 — Net-new task-slug citation in test header

**Severity:** P2 · **Cross-corroborated:** maintainability maint-1 × project-standards PS-1 (conf 100)
**File:** `frontend/tests/unit/pages-accreditation-verify.test.js:309`

The new `describe('network-layer error handling')` block header opens with `// UI-ACCREDITATION-VERIFY-NETWORK-ERROR-RETRIABLE:`. Per `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`, the slug rots on archive — once `tasks-archive.md` trims past 250 lines, the slug becomes an unfindable phantom. The technical body that follows the colon is genuinely useful behavioral framing and stands on its own.

**Fix shape:** drop the `// UI-ACCREDITATION-VERIFY-NETWORK-ERROR-RETRIABLE:` prefix. Open with the behavioral description directly, e.g. `// Network-layer errors (TypeError ..., AbortError ...) never reach ApiRequestError -- api.js ...`.

### Files for round-2

- `frontend/tests/unit/pages-accreditation-verify.test.js` (Item 1)
- This task file (round-2 implementer signal block when moving back to review/)

### Architect archive-time follow-ups (recorded for the eventual archive)

- None for round-2's Item 1 scope. The `[TODO Architect]` cross-cutting AbortError-after-success cascade is being addressed via a separate architect-owned brainstorm follow-up (see "Sibling architect task" below).

### Sibling architect task (filed at architect triage)

A separate UX-cascade finding surfaced during this review and is queued for architect design work: **AbortError-after-server-success cascade**. Fetch reaches server, server completes broadcast + deletes token, response is lost (AbortError at 30s timeout). User clicks Retry on the now-deleted token → backend 400 BAD_REQUEST → SPA classifies as `ApiRequestError` (not retriable) → routes to "Request New" CTA → burns 1 of 3 daily `/accreditation/request` slots even though the accreditation actually succeeded. The exact cascade this task aimed to prevent, shifted one error class up. P2/conf-75. Fix requires backend coordination (existing-accreditation gate on the 400 path, or a frontend probe of `/api/accreditations`) — out of scope for this task's round-2.

### Dismissed at architect triage (recorded for transparency)

- **TypeError + 0s cooldown enables tight click-loop on permanent-cause failures** (adversarial adv-2 + reliability REL-R2, P3 conf 75): bounded by template-driven state machine (Retry button vanishes during `state === 'loading'`) + backend rate limiter on `/accreditation/verify` (5/60s/IP) + user fatigue. PEvO single-instance scale. The 0s cooldown was the deliberate design choice per Q2 ("immediate retry on connectivity restoration").
- **In-flight fetch not abortable on component teardown** (julik-frontend-races below gate): fetch uses internal `AbortSignal.timeout(30s)`. Resolution branches doubly-guarded by `_mounted` + `_verifyGeneration`; no stale state writes. Request-cost concern only, not a UI race.
- **Permanent-cause TypeError test coverage gap** (reliability T1 conf 60 below gate): preemptive test hardening.
- **AbortError synthesis uses `new Error()` vs real `DOMException`** (testing residual): justified in-comment; discriminator narrows on `err?.name` so coverage is correct.

---

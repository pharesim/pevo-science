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

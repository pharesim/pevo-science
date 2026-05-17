# UI-ACCREDITATION-VERIFY-RETRIABLE-HANDLING — SPA branches on `retriable: true` / `ACCREDITATION_GATE_UNAVAILABLE`

**Owner:** UI
**Created:** 2026-05-17 (architect, surfaced by `/ce-code-review` cluster pass on `backend-accreditation-existing-accreditation-gate` round-3)
**Priority:** P2 (UX cascade during HAF outage; not deploy-blocking but user-visible)

## Problem

`backend-accreditation-existing-accreditation-gate` round-3 (commit `9b4417a`) introduced a 503 `ACCREDITATION_GATE_UNAVAILABLE` response with `details.retriable: true` on `POST /api/accreditation/verify` when the HAF gate query throws. The backend explicitly preserves the verification token (no `deleteTokenBestEffort`) so the user can retry once HAF recovers.

The SPA's `frontend/src/pages/accreditation-verify.js:73-79` catches every error path identically: it sets `errorMessage = $t('verify.verificationFailed')` and renders the error template at `accreditation-verify.js:26-35` with a single "Request New" CTA linking to `/accreditation`. The new `err.code === 'ACCREDITATION_GATE_UNAVAILABLE'` and `err.details?.retriable === true` discriminators are dropped — the catch block does not inspect them.

**Cascade observed:** under HAF outage, a user clicking the email link sees the generic "Failed" UI, clicks "Request New" (the only forward affordance), burns one of their 3/24h `/api/accreditation/request` slots by issuing a fresh token T2. Three cycles in a 24h window → 24h email-path lockout for a legitimate user during HAF outage. The architect's intent — "token preserved so user can retry once HAF recovers" — is met server-side but invisible to the user through current UI.

## Goal

Branch on `err.code === 'ACCREDITATION_GATE_UNAVAILABLE'` (or generically on `err.details?.retriable === true` for any 5xx) and render a distinct "service temporarily unavailable, your verification link is still valid — try again in a moment" state with a "Retry" button that re-invokes `verifyAccreditation(token)` against the same token. Backoff timing should respect any `Retry-After` header the backend emits (today: not emitted; sibling task `backend-accreditation-verify-limiter-skip-failed` is adding `Retry-After: 30`).

## Acceptance

### 1. Distinct retriable error state in the verify page

`frontend/src/pages/accreditation-verify.js` adds a state branch for retriable errors. Catch block at lines 73-79 inspects `err.code` and `err.details?.retriable`. When the error is retriable:

- `state = 'retriable_error'` (or similar discriminator distinct from the existing `'error'` state).
- `errorMessage` uses a new translation key (e.g., `verify.serviceTemporarilyUnavailable`) with copy that acknowledges the token is still valid and the user should try again.
- Render template at lines 26-35 grows a third branch (`x-show="state === 'retriable_error'"`) with a "Retry" button distinct from "Request New".

### 2. Retry button re-invokes `verifyAccreditation(token)` against the same token

The "Retry" button MUST NOT clear or rotate the token. It re-invokes the same `verifyAccreditation(token)` against the same token. After click, return state to a loading branch (`state = 'pending'`) briefly so the user sees the retry attempt.

### 3. Backoff respects `Retry-After` header

If `err.retryAfterSeconds` is non-null (parsed by `frontend/src/api.js:28-33,63-71` from a `Retry-After` header), disable the "Retry" button for that many seconds and surface the countdown in the UI (e.g., "Retry available in 28s"). If `err.retryAfterSeconds` is null, allow immediate retry. (Today the backend doesn't emit `Retry-After`; sibling task `backend-accreditation-verify-limiter-skip-failed` is adding it. This task should ship the SPA-side discriminator regardless — when the header arrives the countdown lights up automatically.)

### 4. Non-retriable errors continue to surface the "Request New" CTA

Existing 4xx errors (invalid token, expired token, already verified) continue to route to the existing `'error'` state with the "Request New" CTA. Only `err.details?.retriable === true` 5xx errors take the new branch.

### 5. Translation entries

Add the new translation keys to `frontend/src/locales/en.json` (and any other locale files maintained alongside). Suggested keys:

- `verify.serviceTemporarilyUnavailable` — main error message.
- `verify.retry` — button label.
- `verify.retryAvailableIn` — countdown label, with a `{seconds}` placeholder.

### 6. Test: retriable error renders retry UI

Add a unit test in `frontend/tests/unit/pages-accreditation-verify.test.js` (or the file housing the existing verify page tests):

- Mock `verifyAccreditation(token)` to throw an `ApiRequestError` with `code === 'ACCREDITATION_GATE_UNAVAILABLE'` and `details.retriable === true`.
- Assert the rendered HTML contains the "Retry" button (not "Request New").
- Assert that clicking "Retry" re-invokes `verifyAccreditation(token)` with the same token argument.
- Sibling spec: non-retriable error (`code === 'BAD_REQUEST'`) renders "Request New" instead of "Retry".

### 7. No contract change needed at implementer time

The backend already emits the discriminator. SPA-side change is consumer-only. No `api-contracts/` edit; the architect updates `accreditation.md` for the backend side during the matching backend task archive.

## Out of scope

- Backend changes (separate task: `backend-accreditation-verify-limiter-skip-failed` for limiter + `Retry-After`).
- Generic 5xx retriable handling across other SPA pages (this task scopes to `/api/accreditation/verify` only; sibling pages can adopt the same shape later).
- Translation of locale files beyond English (English copy is canonical; other locales follow via the normal translation pipeline).

## Source

- `/ce-code-review` cluster pass on Accreditation/ORCID review, 2026-05-17.
- Cross-corroborated by reliability + adversarial reviewers on `backend-accreditation-existing-accreditation-gate` round-3.

## Cross-references

- `frontend/src/pages/accreditation-verify.js` — verify page (state machine + template + catch block).
- `frontend/src/api.js:28-33,63-71` — `ApiRequestError.retryAfterSeconds` parser.
- `backend/src/routes/accreditation.ts:530-558` — backend emit site (gate catch branch).
- Sibling backend task: `backend-accreditation-verify-limiter-skip-failed` (limiter `skipFailedRequests` + `Retry-After: 30` emission).

---

Architect re-review (2026-05-17) — HELD PENDING FIXES:

Round-1 implementation at commit `b66a370` meets all seven acceptance criteria (state branch, same-token retry, Retry-After honoring, non-retriable Request New, en.json + 15 stubs, six required specs, no api-contract edit). Token-preservation invariant holds (`_token` captured once in `init()`, never mutated). `_cooldownId` supersession is sound. Two race-related fixes are required before archive; three findings were triaged dismissed or filed as separate tasks.

1. **Concurrent `_verify()` calls share state; last-write-wins race** (P2 — julik-frontend-races).
   The current implementation has no guard against a second `_verify()` flight starting while the first is still in-flight. Both promises write to the same `state` / `errorMessage` / `resultUsername` fields when they settle. `_mounted` protects against teardown only, not against two concurrent in-flight verifications racing each other.

   **Failure shape:** user clicks Retry on slow network → first verify in-flight → user double-taps (see item 2 for the entry-point window) → second verify fires → first verify resolves with `state = 'success'` → second verify resolves with `state = 'retriable_error'` and overwrites the successful verification. The token is now gone server-side (first attempt consumed it) AND the user sees "service unavailable". This is exactly the regression the task was filed to prevent, one error class up.

   **Fix shape:** add a `_verifyGeneration` counter mirroring the existing `_cooldownId` supersession pattern already in the same file. Bump it at the top of `_verify()`, capture into the `.then` / `.catch` closure, bail before writing state if the captured generation no longer matches `this._verifyGeneration`. ~5 lines, single file, no new dependency. This is the canonical PEvO shape — see `agents/docs/solutions/conventions/synchronous-flag-before-await-idempotency-guard-2026-05-16.md`.

2. **`retryVerification` double-submit window: no `state === 'loading'` guard** (P3 — julik-frontend-races).
   The current guard checks `retryCooldownRemaining > 0` only. Between `state = 'loading'` and Alpine's x-if teardown of the Retry button, a second click can pass the cooldown guard and fire a second `_verify()`. This is the user-driven entry point to item 1's race.

   **Fix shape:** add `if (this.state === 'loading') return;` as the first line of `retryVerification()`. Fold into item 1's round — same file, one line.

   Belt + suspenders with item 1's generation counter: the loading-guard prevents the concurrent flight entirely; the generation counter is a defensive backstop if a future caller bypasses `retryVerification`.

3. **Test coverage for the new guards.**
   Add specs:
   - Two concurrent `_verify()` flights where the first resolves with success **after** the second has overwritten state with retriable_error — assert the final state is the success state (the loser's `.then`/`.catch` bails on generation mismatch).
   - Rapid synthetic double-tap on Retry while `state === 'loading'` — assert `mockVerifyAccreditation` is called exactly once.

   Existing seven specs continue to pass unchanged.

Findings triaged dismissed or filed elsewhere this pass:
- `_isRetriable` discriminator scope (reliability R1 + maintainability M1, cross-corroborated anchor 100): **dismissed** — the task explicitly authored the `code || details.retriable` disjunct as the SPA-side contract for any 5xx retriable; implementation matches spec.
- `retriable_error` state name reads as sub-type but is a peer (maintainability M2): **dismissed** — preemptive rename for hypothetical future variants; normalize if/when a third variant lands.
- `TypeError` / `AbortError` not classified retriable (reliability R5): **filed as new task** `ui-accreditation-verify-network-error-retriable.md` in `pending/`.

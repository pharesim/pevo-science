# UI-ORCID-CALLBACK-RETRIABLE-BRANCH — Consume `err.details.retriable` + `err.retryAfterSeconds` in the orcid-callback error path

**Owner:** ui
**Created:** 2026-04-22 (surfaced by UI-ORCID-RETRIABLE-DISCRIMINATOR-PLUMBING first-review)
**Priority:** P2

## Context

`UI-ORCID-RETRIABLE-DISCRIMINATOR-PLUMBING` (commit `dfb224b`) plumbed `err.details` (from `errorBody.error.details`) and `err.retryAfterSeconds` (from `Retry-After` header) through `ApiRequestError` in `frontend/src/api.js`. The infrastructure is in place; no consumer currently uses it.

`frontend/src/pages/orcid-callback.js` `_verify` catch block (lines ~106-127) branches on `err.code === 'NO_ACCOUNT'` and `err.code === 'VALIDATION_ERROR'`, then falls through to a generic "verification failed" for everything else — including `ORCID_ALREADY_LINKED` 409, which is the primary case the retriable discriminator was designed for.

A lock-contention 409 (`retriable: true`, `Retry-After: 10`) currently reaches the generic branch and displays `orcid.verificationFailed` with a "try again" link. A durable-binding 409 reaches the same branch with the same message. User cannot distinguish "wait 10s and retry" from "this ORCID is permanently bound to another account".

Agent-native Finding 1 (0.95); api-contract AC-5 (0.85). See `.context/compound-engineering/ce-code-review/aggregated/15-ui-orcid-retriable-discriminator-plumbing.md` § F15.3.

## Coordination

- Pairs with `backend-orcid-broadcast-timeout-outcome-handling.md`. Once that task lands an Option A.2 `BROADCAST_TIMEOUT` 504 envelope with `retriable: false + outcome: 'uncertain'`, this task's retriable branch also needs to surface that case.
- Also pairs with `BE-ORCID-BROADCAST-ABORT-TIMEOUT` hold block item F4.3 (BroadcastTimeoutError discrimination at call sites) — once backend emits 504 BROADCAST_TIMEOUT with `retriable`, frontend consumes it here.

## Goal

Extend `_verify`'s catch block to branch on the retriable discriminator:

1. **`err.code === 'ORCID_ALREADY_LINKED' && err.details?.retriable === true`** → show "another request is in progress, please wait {retryAfterSeconds}s and try again". If `retryAfterSeconds` is set, auto-retry after that delay (with a user-visible countdown) OR show a "retry" button that reuses the state token if it hasn't been consumed.

2. **`err.code === 'ORCID_ALREADY_LINKED'` (no retriable flag)** → show "this ORCID is linked to another account" with a path to `/recover` or contact support.

3. **`err.code === 'BROADCAST_TIMEOUT'` (once backend emits it)** → show "broadcast is pending; verify your ORCID linkage at /settings before retrying".

## Non-goals

- Adding actual auto-retry with backoff. Scope is rendering + user-initiated retry.
- Generalizing the discriminator across other pages. Other handlers (`_handleAccredit`, `_handleLink`) may warrant similar treatment; file as follow-up.

## Acceptance

- `_verify` catch block branches on `err.details?.retriable` as described.
- i18n keys added for each new message state (`orcid.alreadyLinkedRetriable`, `orcid.alreadyLinkedDurable`, `orcid.broadcastPending`); 14-locale stubs + STUBS.md entries under a fresh sweep header.
- Unit tests in `frontend/tests/unit/pages-orcid-callback.test.js` covering each branch: retriable 409 with Retry-After → retriable message + countdown; durable 409 → durable message; BROADCAST_TIMEOUT → pending message.
- No regression on NO_ACCOUNT / VALIDATION_ERROR branches.

## [TODO Architect]

None — consumes existing backend contract.

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES:**

First-pass `/ce-code-review` on commit `cbf53f1` (merge d184eca) (correctness persona). Retriable-branch consumption + countdown + retry scaffolding all correctly shaped; i18n keys present; durable vs retriable 409 correctly distinguished. Four hold items on retry-loop boundaries + semantics.

1. **P2 — `err.retryAfterSeconds !== null` discriminator misclassifies `undefined` as retriable** (correctness F14.1 0.82). `frontend/src/pages/orcid-callback.js:~139`. Today `completeOrcid` only throws `ApiRequestError`, which normalizes absent values to `null` via api.js — so the misclassification is theoretical. Diverges from stated semantics (retriable iff backend explicitly signals retriability). Fix: `err.retryAfterSeconds != null` (loose equality) or explicit `typeof err.retryAfterSeconds === 'number'`.

2. **P2 — `Retry-After: 0` collapses UX: `retryCountdown = 0` → synchronous immediate retry** (correctness F14.2 0.88). `parseRetryAfterSeconds(0) === 0` is valid (non-null). `const seconds = err.retryAfterSeconds ?? 10` evaluates to `0` (nullish coalesce doesn't fire on `0`). `_tickRetryCountdown()` finds `retryCountdown <= 0`, calls `_retryVerify()` synchronously. User sees no countdown, no error flash, immediate retry. If retry also returns 0, infinite synchronous loop risk. Fix: `const seconds = Math.max(1, err.retryAfterSeconds ?? 10)` or explicit `> 0` clamp.

3. **P2 — No retry counter enforcement; comment claims "single self-triggered retry" but code allows unbounded** (correctness F14.3 0.90). `frontend/src/pages/orcid-callback.js:~221-244`. Persistent retriable 409 (attacker holds lock / cache-HAF lag exceeds 10s / repeated backend contention) arms a new countdown on every retry-fail. Stuck-on-page user creates unbounded retry loop burning backend state tokens. Safe across navigation (destroy cancels timer) but poor UX + backend resource burn. Fix: add `_retryCount` field; `MAX_RETRIES = 1` to match the comment; on `_retryCount >= MAX_RETRIES` show the durable-binding message instead of arming a new countdown. Reset on successful verify or navigation.

4. **P3 — No test for countdown-reaches-zero → `_retryVerify` path** (correctness F14.5 info-tier 0.95). Existing teardown test advances timers to `countdown=7` then destroys. Retry-firing path is the main value-add of the branch; no test asserts `completeOrcid` gets called twice, `status` flips through `'verifying'` during retry. Fix: add a test that advances past `retryAfterSeconds=10`, asserts `completeOrcid` mock was called twice AND `status` cycled through `'verifying'`. Couples naturally with the retry-counter cap from #3 (single test can assert cap behavior + countdown firing).

**Dismissed from round-1 findings (architect triage):**
- **P3 F14.4** `errorAction` whitelist drops unknown future values (0.85): intentional default-deny shape. Future branch additions caught in code review + visible (no button rendered). Dismissed.

**Path to re-archive:** (1) UI applies items #1-4 on this task. (2) UI re-review signal block below the hold. (3) Architect re-reviews round-2; archives on clean.

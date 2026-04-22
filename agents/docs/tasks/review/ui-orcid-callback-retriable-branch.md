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

# UI-ORCID-RETRIABLE-DISCRIMINATOR-PLUMBING — Expose error.details and Retry-After through ApiRequestError so clients can act on the ORCID 409 retriable discriminator

**Owner:** ui
**Created:** 2026-04-22 (surfaced by BE-ORCID-TOCTOU-LOCK round-2 review 2026-04-22)
**Priority:** P2

## Context

`BE-ORCID-TOCTOU-LOCK` round-2 introduced a retriable-vs-durable discriminator on the `ORCID_ALREADY_LINKED` 409 response: lock-contention 409s set `Retry-After: 10` header and `error.details: { retriable: true, retry_after_seconds: 10 }`, while durable-binding 409s (on-chain binding or cache-lag) omit both. Contract documented at `agents/docs/api-contracts/orcid.md`.

Re-review flagged that the frontend layer throws the discriminator away. `frontend/src/api.js:36` constructs `ApiRequestError` as:

```js
throw new ApiRequestError(errorBody.error.code, errorBody.error.message, errorBody.data);
```

But `sendError` puts the discriminator in `errorBody.error.details`, not `errorBody.data` (which is always `null` on error responses). The `Retry-After` response header is also never read by the `request()` helper. Net effect: `err.data` is always `null` in every frontend catch block, and neither `error.details` nor `Retry-After` is reachable through documented consumption paths.

## Why this matters

The contract explicitly instructs clients to distinguish the three 409 causes via `error.details.retriable` and `Retry-After`. Today no frontend consumer can do that — lock-contention 409 and durable-binding 409 look identical inside catch blocks. A retry affordance added to the UI without fixing this silently treats transient contention as permanent failure and never retries. Agents that consume PEvO via the API get the discriminator natively via HTTP parsing; the frontend is the laggard.

## Goal

Extend `ApiRequestError` (and the `request()` error path in `frontend/src/api.js`) so that catch blocks can read:

1. `err.details` — the parsed `error.details` object from the response body (mirrors `err.code`, `err.message`).
2. `err.retryAfterSeconds` — parsed from the `Retry-After` response header when present, otherwise `null`.

Semantics:

- `err.details?.retriable === true` OR `err.retryAfterSeconds !== null` means retriable.
- Absence of both means non-retriable (per the "absent means false" convention in `api-contracts/orcid.md`).
- Keep `err.data` as the third constructor arg for backward compat (currently always `null` on errors; not changing semantics).

## Non-goals

- Adding actual retry logic to any handler. This task only plumbs the fields through so consumers CAN retry; whether/when/how a retry happens is per-handler.
- Reshaping the existing `sendError` / `sendOk` envelope on the backend.
- Migrating existing `err.data`-reading consumers (there are none, per grep).

## Acceptance

- `frontend/src/api.js` `ApiRequestError` class exposes `details` and `retryAfterSeconds` as read-only properties populated from the error response body and headers.
- One unit test under `frontend/tests/unit/api-error.test.js` (create if missing) that:
  - Stubs a 409 response with `Retry-After: 10` + body `{status:"error",error:{code:"ORCID_ALREADY_LINKED",message:"...",details:{retriable:true,retry_after_seconds:10}}}`, catches the thrown `ApiRequestError`, asserts `err.details.retriable === true` and `err.retryAfterSeconds === 10`.
  - Stubs a 409 without the header + without `details`, asserts `err.details` is `undefined` (or `null`) and `err.retryAfterSeconds` is `null`.
- `grep -rn 'err\.data' frontend/src/` — existing call sites still compile (property is preserved).
- Full frontend unit suite passes; `npm run build` clean.

## [TODO Architect]

None — self-contained frontend plumbing task. The backend and contract are already correct.

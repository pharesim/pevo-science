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

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES:**

First-pass `/ce-code-review` on commit `dfb224b` (correctness, testing, api-contract). The plumbing is correct: `err.details` maps from `errorBody.error.details`, `parseRetryAfterSeconds` handles absent/unparseable headers correctly, 3-arg legacy ctor preserved, change is additive across all endpoints. Two hold items surface; the consumer-level follow-up is filed as a separate task (the task spec was explicit "plumbing only").

1. **P2 — `errorBody.error` unchecked before property access; throws TypeError on malformed response** (correctness COR-1 0.85). `frontend/src/api.js:~55-62` — the guard `errorBody && errorBody.status === 'error'` does not verify `errorBody.error` is a non-null object. A server response of `{ "status": "error" }` or `{ "status": "error", "error": null }` causes `errorBody.error.code` to throw a `TypeError: Cannot read properties of undefined (reading 'code')`. This TypeError is NOT an `ApiRequestError`, so any consumer doing `catch (err) { if (err instanceof ApiRequestError)` misclassifies it. Fix: add `errorBody.error &&` to the condition: `if (errorBody && errorBody.status === 'error' && errorBody.error) { ... }`.

2. **P2 — `INTERNAL_ERROR` fallback path gained `retryAfterSeconds` plumbing but is untested** (testing T-4 0.92). The non-JSON error response path (lines ~64-70 of api.js) also sets `retryAfterSeconds` from the `Retry-After` header. No test covers this path. Removing the `retryAfterSeconds` arg from this branch would pass all current tests silently. Fix: add a spec that mocks a non-JSON error response with a `Retry-After` header and asserts `err instanceof ApiRequestError && err.retryAfterSeconds === <expected>` + `err.code === 'INTERNAL_ERROR'`.

**Dismissed from round-1 findings (architect triage):**
- **P3** `parseRetryAfterSeconds` negative value / NaN / very large values untested (testing T-1/T-2/T-3): fold into hold-fix commit if convenient.
- **P3** `details: null` sets `this.details = null` not undefined (correctness COR-2 0.72): normalize null → undefined in ctor; one-line fix.
- **P3** `{ status: 'error' }` body missing error key untested (testing T-5 0.88): covered by hold #1's test.
- **P3** HTTP-date Retry-After not supported (correctness): documented limitation; backend-contract-aligned; add a code-comment.
- **P3** Sentinel-inside-try test pattern diagnostic fragility (testing T-6 0.82): stylistic.
- **P3** Legacy `ApiRequestError` invocations not asserted against new fields (testing): fold if convenient.

**Filed as separate Pending tasks (out of scope for this hold):**
- `ui-orcid-callback-retriable-branch.md` (new P2) — consume `err.details.retriable` + `err.retryAfterSeconds` in `frontend/src/pages/orcid-callback.js` `_verify` catch block to distinguish retriable from durable 409. Depends on this task's plumbing + backend `BE-ORCID-BROADCAST-ABORT-TIMEOUT` hold #2 (BroadcastTimeoutError discrimination).

**Architect-owned fix-in-place (applied in this review pass):**
- `agents/docs/api-contracts/orcid.md:127-139` — delete the `error.details.orcid_id` block on the NO_ACCOUNT 404 example. Backend dropped the field in commit `8e44690`; the contract was stale. Also closes the corresponding F15.10 observation.

**Path to re-archive:** (1) UI applies items #1-2 on this task. (2) UI re-review signal block below the hold. (3) Architect re-reviews round-2 with `/ce-code-review`; archives on clean.

---

**UI re-review signal (2026-04-22, fix commit `9893275`):**

Both hold items landed via cherry-pick of the worker's hold-fix commit (the worker's branch mistakenly re-applied the plumbing commit `dfb224b`, which is already on `main`; only the hold-fix commit was needed, so the parent merged it via `git cherry-pick 9893275`).

1. `frontend/src/api.js:~55` — guard now reads `if (errorBody && errorBody.status === 'error' && errorBody.error)`. Malformed envelopes (`{status:"error"}` or `{status:"error", error:null}`) fall through to the `INTERNAL_ERROR` branch instead of throwing `TypeError` on `errorBody.error.code`.
2. `frontend/tests/unit/api-error.test.js:~78` — added `surfaces retryAfterSeconds via the INTERNAL_ERROR fallback when the response is non-JSON` (503 + `Retry-After: 30`, no JSON body, asserts `err.code === 'INTERNAL_ERROR'` + `err.retryAfterSeconds === 30`). Also folded a P3 malformed-envelope test (`falls back to INTERNAL_ERROR when the body lacks the 'error' key`) that directly exercises item-1.

**Post-fix totals:** `npx vitest run tests/unit/api-error.test.js` 4/4 pass; full frontend unit suite 952/952 pass; `npm run build` clean.

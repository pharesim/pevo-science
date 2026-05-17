# BACKEND-ACCREDITATION-VERIFY-LIMITER-SKIP-FAILED — accred-verify limiter + 503 Retry-After

**Owner:** Backend
**Created:** 2026-05-17 (architect, surfaced by `/ce-code-review` cluster pass on `backend-accreditation-existing-accreditation-gate` round-3)
**Priority:** P2 (UX cascade during HAF outage; not deploy-blocking but user-visible)

## Problem

Two related gaps on `POST /api/accreditation/verify` make round-3's 503 `ACCREDITATION_GATE_UNAVAILABLE` design intent ("token preserved so the user can retry once HAF recovers") fail in practice during a HAF outage.

### Gap 1: `accreditationVerifyLimiter` lacks `skipFailedRequests`

`backend/src/routes/accreditation.ts:36` declares `accreditationVerifyLimiter = rateLimit({ name: 'accred-verify', windowMs: 60_000, max: 5, keyFn: byIp })`. No `skipFailedRequests`. Every 503 (HAF outage, gate-throw path) consumes one of the IP's 5 slots per 60s. The legitimate user refreshing the verify-page during HAF outage burns 5 slots → 429 RATE_LIMITED for the next ~60s — blocked from reaching the route handler at all even after HAF recovers.

### Gap 2: 503 omits `Retry-After` header

`backend/src/routes/accreditation.ts:552-558` returns 503 with `details.retriable: true` but no `Retry-After` header. The SPA's `ApiRequestError` infrastructure (`frontend/src/api.js:28-33,63-71`) already parses `Retry-After` into `err.retryAfterSeconds`; the backend just doesn't emit one. Without server-driven cadence, any retry timing is whatever the SPA decides (or user-driven, which compounds Gap 1).

## Goal

(1) Add `skipFailedRequests: true` to `accreditationVerifyLimiter` so 503 responses refund the IP slot. (2) Emit a `Retry-After: 30` header on the 503 `ACCREDITATION_GATE_UNAVAILABLE` path so layered consumers (SPA + nginx + any future auto-retry middleware) share a coherent backoff floor.

## Acceptance

### 1. Limiter config change

`backend/src/routes/accreditation.ts:36` opts in to `skipFailedRequests: true`. Mirrors `upgradeLimiter` and `accreditationRequestLimiter` shapes:

```ts
const accreditationVerifyLimiter = rateLimit({
  name: 'accred-verify',
  windowMs: 60_000,
  max: 5,
  keyFn: byIp,
  skipFailedRequests: true,
});
```

### 2. `Retry-After` header on the 503 gate-unavailable path

Set `res.set('Retry-After', '30')` immediately before the existing `sendError(res, 503, 'ACCREDITATION_GATE_UNAVAILABLE', ...)` at `accreditation.ts:552-558`. Header value is operator-tunable but 30s is a reasonable default for HAF-outage recovery cadence.

### 3. Verify 4xx-vs-5xx semantics on /verify

Audit the route's full error surface (4xx validation, 422 already-verified, 5xx HAF-unavailable, 5xx broadcast-failed). Confirm which paths emit which status. Document in the implementer signal block. `skipFailedRequests: true` refunds on ANY `statusCode >= 400` per `rateLimit.ts:100-101` — that's intentional (sibling pattern in `accred-req`). 4xx paths short-circuit before expensive work so the refund-on-4xx is acceptable.

### 4. Test: 503 refunds the IP slot

Add a backend integration test mirroring `backend/tests/routes/custody-upgrade.test.ts:518` shape: drive a 503 ACCREDITATION_GATE_UNAVAILABLE response (mock the gate-query to throw via `hafQueryMock.mockRejectedValueOnce`), assert the response status is 503, then assert the next request from the same IP does NOT 429.

### 5. Test: 503 emits `Retry-After: 30`

Extend the round-3 503 spec in `backend/tests/routes/accreditation-idempotency.test.ts` (the spec asserting `gate HAF throw returns 503 ACCREDITATION_GATE_UNAVAILABLE — token preserved, no broadcast, no cap INCR`) to also assert `res.headers['retry-after'] === '30'`.

### 6. No contract change needed at implementer time

`agents/docs/api-contracts/accreditation.md` will be updated by the architect at archive time for this task; flag via `[TODO Architect]` in the implementer signal block. The contract addition is small: note the `Retry-After: 30` emission on the gate-unavailable 503 path.

## Out of scope

- `accreditationRequestLimiter` already has `skipFailedRequests: true` (landed in `backend-accreditation-limiter-skip-failed`, currently in pending/ with hold-block round-2). No change there.
- Splitting `skipFailedRequests` into `skipServerErrors` vs `skipClientErrors` discriminators (architect explicitly declined in `backend-accreditation-limiter-skip-failed` review).
- SPA-side retriable-aware UI (separate task: `ui-accreditation-verify-retriable-handling`).
- The cached idempotency-hit availability regression during HAF outage (gate runs first and 503s; cache unreachable). Architect chose "document and accept" — handled at archive time for `backend-accreditation-existing-accreditation-gate`.

## Source

- `/ce-code-review` cluster pass on Accreditation/ORCID review, 2026-05-17.
- Triage decision: file as separate backend task (rather than fold into the closing `backend-accreditation-existing-accreditation-gate` archive) so the change ships with its own test verification and operator dashboard impact (the `Retry-After` header is observable on the wire).

## Cross-references

- `backend/src/routes/accreditation.ts:36` — limiter declaration.
- `backend/src/routes/accreditation.ts:552-558` — 503 emit site.
- `backend/src/middleware/rateLimit.ts:100-109` — `skipFailedRequests` semantics.
- `backend/src/routes/custody.ts:52` — sibling `upgradeLimiter` shape.
- `backend/tests/routes/custody-upgrade.test.ts:518` — sibling slot-refund canary.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — audit-by-grep convention.

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

## Implementer signal (Backend, 2026-05-17)

Round 1 landed at commit `dcf400c`. All 6 acceptance items addressed in a single commit.

**Files touched:**
- `backend/src/routes/accreditation.ts` — added `skipFailedRequests: true` to `accreditationVerifyLimiter` (now at line 55 after the preamble comment, was at line 36); added `res.set('Retry-After', '30')` at line 578, immediately before the 503 `ACCREDITATION_GATE_UNAVAILABLE` `sendError`. Preamble comment on the limiter explicitly enumerates the route's full 4xx-vs-5xx surface (acceptance #3 below) and the rationale for the symmetric refund.
- `backend/tests/routes/accreditation-idempotency.test.ts` — (a) extended the existing round-3 503 spec (`gate HAF throw returns 503 ACCREDITATION_GATE_UNAVAILABLE — token preserved, no broadcast, no cap INCR (round-3 α)`) with a `expect(res.headers['retry-after']).toBe('30')` assertion (acceptance #5); (b) added new spec `503 ACCREDITATION_GATE_UNAVAILABLE refunds the per-IP limiter slot (skipFailedRequests canary)` inside the `existing-accreditation gate (user-level)` describe block, mirroring `backend/tests/routes/custody-upgrade.test.ts:518` shape — drives 5 consecutive 503s (filling the 5/60s bucket), then issues a 6th `/verify` from the same IP and asserts `not.toBe(429)` plus `toBe(503)` (acceptance #4). Each iteration uses a unique seeded token (`accred-idem-refund-N-*`) so the `afterEach` `pending_accred:accred-idem-*` cleanup catches them.

**Acceptance #3 — 4xx-vs-5xx audit on `POST /api/accreditation/verify`:**

The route currently emits the following statuses, all of which trigger the slot refund under `skipFailedRequests: true` (`rateLimit.ts:100-101` refund branch keys on ANY `res.statusCode >= 400`):

| Status | Code | Site | Class | Comment |
|--------|------|------|-------|---------|
| 400 | `BAD_REQUEST` | line 431 — `Invalid or expired token` | 4xx | Short-circuits BEFORE HAF probes / broadcast / Redis-write side effects. Symmetric refund is acceptable: probing only costs Redis-rate-limit ops. |
| 500 | `INTERNAL_ERROR` | line 437 — `Admin posting key not configured` | 5xx | Operator-misconfiguration; not user-triggered. Refund is irrelevant in practice (would only fire on deployment misconfig). |
| 502 | `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` | line 775 — cap-exceeded soft-block | 5xx | Token-scoped cap (separate counter from the IP limiter). Refund of the IP slot is acceptable because the cap counter is independent. |
| 502 | `POST_BROADCAST_OPERATOR_REQUIRED` | via `handleBroadcastError` → permanent severity | 5xx | Post-broadcast cascade failure. IP-slot refund is harmless: the chain op already landed; the user reaching the route again does not double-broadcast (idempotency gate + HAF check catch it). |
| 502 | `POST_BROADCAST_FAILED` | via `handleBroadcastError` → transient severity | 5xx | Same reasoning as `POST_BROADCAST_OPERATOR_REQUIRED`. |
| 503 | `ACCREDITATION_GATE_UNAVAILABLE` | line 579 — gate HAF query throw | 5xx | **This task's target.** HAF outage; user expected to retry once HAF recovers. Refund is load-bearing — without it the user trips 429 mid-outage. |
| 503 | `SERVICE_UNAVAILABLE` | line 738 — pre-INCR counter failure | 5xx | Redis flap at the cap counter. Same refund rationale as 503 gate-unavailable. |
| 504 | `BROADCAST_TIMEOUT` | via `handleBroadcastError` | 5xx | Hive RPC timeout. Refund acceptable (transient blip; user retry is the intended flow). |

The audit confirms no 4xx path on `/verify` has an expensive precondition (HAF query, broadcast, Redis write) that the symmetric refund would let an attacker exploit. The 400 `BAD_REQUEST` path returns BEFORE the admin-key check, the HAF probes, and the broadcast cap counter. A future change inserting an expensive operation BEFORE the `getToken` lookup would need to add its own throttle (the limiter's symmetric refund will not rate-limit pre-handler probes). This matches the `accreditationRequestLimiter` rationale already inlined as a preamble comment above the limiter (`accreditation.ts:25-38`).

**Acceptance #6 — `[TODO Architect]` contract update note:**

`agents/docs/api-contracts/accreditation.md` does not currently document the `Retry-After` header emission on the 503 `ACCREDITATION_GATE_UNAVAILABLE` path. Architect: please add at archive time. Suggested text under the existing 503 row: `Emits Retry-After: 30 (server-driven backoff floor). SPA parses it into err.retryAfterSeconds via frontend/src/api.js:28-33,63-71.`

**Verification:**
- `npm run typecheck` (backend) — clean.
- `npm run lint` (backend) — clean.
- Targeted vitest: `tests/routes/accreditation-idempotency.test.ts` — all 13 specs pass (12 prior + 1 new slot-refund canary). New spec runtime: ~25ms.

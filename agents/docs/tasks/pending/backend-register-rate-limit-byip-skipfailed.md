# BACKEND-REGISTER-RATE-LIMIT-BYIP-SKIPFAILED — Close byIp rate-limit slot-burn cascade on `/api/bridge/register`

**Owner:** Backend Agent
**Created:** 2026-05-20 (architect, surfaced by `/ce-code-review` of `backend-retract-rate-limit-haf-503-burn` round-1 commit `a5589588` during the 2026-05-20 bridge/broadcast-resilience cluster review)
**Priority:** P2 (reliability — NAT-shared user lockout on retriable cascade)

## Problem

`registerLimiter` at `backend/src/routes/bridge.ts:149` is `windowMs: 3_600_000, max: 10, keyFn: byIp` with NO `skipFailedRequests`. The `POST /api/bridge/register` route emits two `retriable: true` paths:

- 409 `LOCK_HELD` with `{retriable: true}` (the per-permlink SETNX-lock collision; SPA auto-retries up to 3 times per the recently-shipped `ui-bridge-register-lock-held-ux` SPA work)
- 503 `SERVICE_UNAVAILABLE` with `{retriable: true}` on HAF outage during the duplicate-check preflight (`fetchExistingBridge` fail-closed)

**The cascade:**

1. Two users behind the same corporate NAT click "Register" within the lock TTL window. First request acquires the per-permlink SETNX; second sees `LOCK_HELD` → 409 retriable.
2. SPA on the second user retries up to 3 times on `details.retriable: true`. Each retry consumes one `registerLimiter` slot.
3. With 3 users contending: 3 × 4 calls = 12 > 10 cap. Entire NAT locked out for 1hr on `/register`.
4. HAF blip during the same window amplifies further: each /register request that hits the HAF-fail-closed preflight returns 503 retriable; SPA retries; more slots burned.

**Pre-skipFailedRequests behavior:** every retriable response (the cascade's amplifier) consumes a slot. Legitimate users hit 429 RATE_LIMITED before the cascade resolves. Even after HAF recovers and locks release, the rolling 1hr window keeps the NAT locked out.

**Why filed now:** `backend-retract-rate-limit-haf-503-burn` (archived if/when round-2 clean) closed the same cascade shape on `/api/papers/:author/:permlink/retract` (byAccount/5/1hr) by adding `skipFailedRequests: true`. The audit table in that task explicitly noted `registerLimiter` as a candidate "quasi-followup if architect wants it widened" — implementer deferred on the rationale that byIp NAT-shared lockout is a different threat model from byAccount user lockout. Architect's call after review: the cascade shape (byIp + long window + retriable emit + SPA auto-retry on retriable) is the same as /retract's, and PEvO has precedent for `byIp + skipFailedRequests` already (`accreditationVerifyLimiter` at `windowMs: 60_000, max: 5, keyFn: byIp, skipFailedRequests: true` since the 2026-05-18 `backend-accreditation-verify-limiter-skip-failed` archive). The asymmetry isn't a threat-model wall, it's an unwidened sweep.

## Goal

Add `skipFailedRequests: true` to `registerLimiter` so retriable failure responses (LOCK_HELD 409, HAF-503) don't burn the NAT's slots during a cascade. Successful registrations continue to consume slots (abuse rate stays bounded).

## Acceptance

### 1. `registerLimiter` declaration updated

`backend/src/routes/bridge.ts:149` — extend the limiter config with `skipFailedRequests: true`. Multi-line struct form matching the `retractLimiter` / `accreditationVerifyLimiter` pattern. Include a stable-symbol-anchored WHY comment (1-2 sentences) explaining the cascade-close rationale: SPA auto-retries LOCK_HELD + HAF-503; without skipFailedRequests, corporate-NAT contention burns the budget within the 3-user × 4-call shape.

### 2. Threat-model documentation in the WHY comment

The comment block must cover:
- Why per-request 4xx/5xx refund is safe on this route: the 409 LOCK_HELD path is rate-limit-amplifier-shaped (retriable cascade); the 503 SERVICE_UNAVAILABLE on HAF outage is also retriable-cascade-shaped; the 400 DUPLICATE / 422 validation paths fire on user error AND DO refund under skipFailedRequests but are bounded by the user's own paper-identifier set (no unbounded probe surface).
- Why byIp vs byAccount doesn't affect the analysis: the limiter's purpose on bridge/register is to bound IP-rotation abuse (preventing one party from claiming many papers under different identifiers from the same IP). Successful 200/201 still consumes a slot under skipFailedRequests, so the per-IP abuse cap is preserved.

### 3. Canary tests

Add canaries to a sibling test file (or extend existing `bridge.test.ts` / `bridge-haf-lag-locks.test.ts` if shape fits):

- **Slot-burn = 1 per LOCK_HELD cascade event.** N sequential POST /register requests from the same IP, all returning 409 LOCK_HELD. Then 1 successful POST /register (different paper). Assert the successful request returns 201, NOT 429. Pre-fix: N+1 requests would consume N+1 slots; once the cap is hit, the legitimate registration 429s.
- **Slot-burn = 1 per HAF-503 cascade event.** Same shape with `fetchExistingBridge` (or whatever preflight throws HafQueryError) mocked to throw; assert N retriable 503s + 1 successful request still succeeds.
- **Abuse rate still bounded.** 11 successful POST /register requests from the same IP; assert 11th request returns 429 RATE_LIMITED. Pins that 2xx responses still consume slots.

Mutation-kill: remove `skipFailedRequests: true` → first canary's successful-after-N-503s assertion fails RED (the legitimate request 429s).

### 4. Verification

`npm run typecheck` clean. `npm run lint` clean for this change. Scoped vitest on the touched test files passes.

### 5. [TODO Architect] documentation update

After landing, architect updates `agents/docs/api-contracts/bridge.md` § POST /api/bridge/register Errors — `LOCK_HELD` and `SERVICE_UNAVAILABLE` entries gain a note that retriable failures no longer consume rate-limit slots, per the 503-retriable rate-limit interaction guidance already in `accreditation.md` (the precedent for byIp + skipFailedRequests).

## Out of scope

- Cross-route extension to other byIp limiters (auth.ts signup/login/reset, signup-verify.ts verify/resume/confirm/link, orcid.ts start/callback, ipfs.ts download, settings.ts read/write). Those are credential-probing or admin-scoped routes where `skipFailedRequests` MUST NOT be added (per `RateLimitConfig.skipFailedRequests` JSDoc). Survey deferred.
- `lookupLimiter` on `/api/bridge/lookup` (byIp/20/60s). Short window, fast recovery; no retriable emit on the route. Out of scope unless audit surfaces a retriable path.
- Restructuring `registerLimiter` to byAccount or composite key. The byIp threat model (raising the bar for IP-rotation abuse) is intentional; this task narrows the slot-burn cascade without changing the keying.

## Cross-references

- `backend/src/routes/bridge.ts:149` — `registerLimiter` declaration.
- `backend/src/routes/bridge.ts:425-431, 443` — the retriable 409 LOCK_HELD + 503 SERVICE_UNAVAILABLE emit sites.
- `backend/src/middleware/rateLimit.ts` — `RateLimitConfig.skipFailedRequests` JSDoc + middleware semantics (4xx/5xx refund via `res.on('finish') + res.on('close')` once-guard).
- `backend/src/routes/accreditation.ts:58` — `accreditationVerifyLimiter` (byIp + skipFailedRequests precedent).
- `backend/src/routes/papers.ts:732-737` — `retractLimiter` (byAccount + skipFailedRequests precedent and the threat-model comment template).
- `frontend/src/pages/bridge.js` — SPA auto-retry logic on `LOCK_HELD` 409 (per `ui-bridge-register-lock-held-ux` archive).
- `agents/docs/api-contracts/bridge.md` — contract doc to update at archive time.
- Originating audit table: `backend-retract-rate-limit-haf-503-burn` task signal block (Cross-route audit and bundled remediation section).

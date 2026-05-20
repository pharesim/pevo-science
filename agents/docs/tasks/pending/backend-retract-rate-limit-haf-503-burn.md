# BACKEND-RETRACT-RATE-LIMIT-HAF-503-BURN — Rate-limiter slot burn cascade on retriable 503 paths

**Owner:** Backend Agent
**Created:** 2026-05-20 (architect, surfaced by `/ce-code-review` of `backend-fetch-paper-detail-haf-error-vs-not-found` round-1 commit `b427a70` during the 2026-05-20 HAF-cluster review)
**Priority:** P2 (reliability)

## Problem

When a HAF transient outage triggers the new retriable-503 envelope on a rate-limited write path, the SPA retries on `details.retriable: true`. Each retry consumes another rate-limiter slot. The cascade burns the full per-window slot budget during a single outage event — and when HAF recovers, the legitimate user is locked out for the remainder of the rolling window.

**Canonical exemplar — `/api/papers/:author/:permlink/retract`:** `retractLimiter` is `max: 5/hour/account` (`papers.ts:720`, `keyFn: byAccount`) with NO `skipFailed: true`. Step-by-step:

1. User clicks Retract. `verifyHiveSignature` passes. `retractLimiter` consumes slot 1.
2. `fetchPaperDetailFromHaf` throws `HafQueryError` under HAF transient outage. New round-2 (per `backend-fetch-paper-detail-haf-error-vs-not-found` hold) emits `503 + details.retriable: true`.
3. SPA reads `details.retriable: true` and retries. Slot 2 consumed.
4. Outage persists 30+ seconds. SPA retries 3 more times. Slots 3-5 consumed.
5. 6th attempt: `retractLimiter` returns 429.
6. HAF recovers minutes later. User clicks Retract. `retractLimiter` sees 5/5. Returns 429. User locked out until oldest slot ages out (up to 1 hour).

**Pre-b427a70 behavior:** HAF outage returned `200 with cached null → 404`. SPA showed "Paper not found" → user stopped. Zero retries. Slot burn = 1.

**Post-b427a70 behavior:** Slot burn = 5 per outage event, on a 5/hour limiter. Legitimate users hit a self-inflicted 1-hour cooldown.

## Goal

Close the slot-burn cascade on `/retract` and audit other rate-limited write paths for the same shape. The rate limiter exists to bound abuse rate, not to penalize legitimate users for backend-side outages.

## Suggested approach (implementer to confirm during design pass)

Three fix shapes are defensible; the threat-model implications differ.

### Option A: `skipFailed: true` on `retractLimiter`

Only count successful requests against the limit. A `retractLimiter` 5xx response doesn't consume a slot.

- **Pro:** clean one-line fix at `papers.ts:720`. The middleware (`backend/src/middleware/rateLimit.ts`) likely already supports `skipFailed` (or `skipFailedRequests`) via express-rate-limit; verify.
- **Threat-model implication:** the limiter no longer bounds attempted-write rate, only completed-write rate. An attacker who can force the route to 5xx (e.g., by crafting requests that trip a 422 VALIDATION_ERROR or a 504 BROADCAST_TIMEOUT) can issue unlimited attempts. Today's `papers.ts:retract` 5xx surface includes: 404 (paper not found), 422 (already retracted), 502 (BROADCAST_FAILED), 504 (BROADCAST_TIMEOUT), 503 (new HafQueryError), 500 (unhandled). Most are deterministic-from-state, not abuse-driveable. **Question:** does `skipFailed` also skip 4xx, or only 5xx? If both, the 422-already-retracted path becomes an unbounded retry surface. Verify the middleware semantics.

### Option B: Explicit slot refund in the 503 catch arm

In the new `HafQueryError` catch, call into the rate-limiter middleware to refund the slot consumed earlier in the same request.

- **Pro:** surgical; only the retriable-503 path is exempted from slot consumption. 422 / 502 / 504 / 500 still consume slots.
- **Con:** PEvO's rate-limit middleware probably does NOT expose a refund API today. Verify; if not, this would require middleware surgery to expose `req.rateLimit.refund()` or similar.

### Option C: Per-route `Retry-After` header on the new 503

Add `Retry-After: <seconds>` to the new 503 response, tuned so SPA backoff doesn't chain-burn within the hour. Common convention is 30s (matches the argon2 / accreditation 503 paths).

- **Pro:** doesn't touch the limiter; honors `common.md`'s existing convention for retriable 503s with `Retry-After`.
- **Con:** the SPA respects `Retry-After`, but the user can still click Retract manually 5 times within the hour and burn the slots. Doesn't solve user-driven amplification — only client-loop amplification.

**Likely best path:** Option A IF the middleware's `skipFailed` semantics correctly distinguish 5xx-server-error from 4xx-client-error. Backed up by Option C for SPA self-rate-limiting on the retry loop.

## Acceptance

### 1. `/retract` slot burn under HAF transient outage = 1 per outage event

Mocked canary: install a HAF responder that throws `HafQueryError`. Issue 6 sequential POST `/retract` requests from the same account. Assert exactly 1 slot consumed (not 5 or 6). After the canary, issue a successful POST `/retract` (mocked HAF responder returns the paper); assert slot 2 consumed and 200 OK returned. Mutation-kill: remove the slot-refund / skipFailed mechanism → canary fails red (6th request returns 429 or similar).

### 2. `/retract` retains rate-limit guarantee against actual abuse

Issue 6 sequential POST `/retract` requests under healthy HAF (mocked successful broadcast). Assert 6th request returns 429 with `RATE_LIMITED` envelope. Pins that the slot accounting is preserved on the success path.

### 3. Cross-route audit and bundled remediation

Enumerate all PEvO HTTP routes with both (a) a rate limiter that consumes slots synchronously, AND (b) a code path that emits `details.retriable: true` on transient backend failure. Likely candidates to inspect:

- `POST /api/papers` (publish) — has `publishLimiter`? If yes, does it emit retriable-503 under HAF outage during pre-broadcast validation?
- `POST /api/reviews` (post review) — similar.
- `POST /api/papers/:a/:p/comments` (post comment) — `commentLimiter`?
- `POST /api/papers/:a/:p/edit` (edit paper) — limiter?
- `POST /api/bridge/register` — has the lock + `LOCK_HELD` 409 retriable path; verify the lock interaction with the limiter doesn't double-burn.
- `POST /api/papers/:a/:p/claims/.../approve` and `/revoke` — admin paths; lower priority.

For each affected route, apply the same fix as `/retract` OR document explicitly why the route is exempt (e.g., the limiter is per-IP not per-account, so cooldown isn't user-locking).

### 4. Documentation

`agents/docs/api-contracts/papers.md` (or wherever the rate-limited routes' Errors sections live) gains an explicit note on the 503-retriable behavior under rate limiting: "Clients that retry on `details.retriable` should respect `Retry-After` (if present) and bound their own retry attempts; the rate limiter exempts retriable 5xx but the SPA should still self-bound to avoid pathological loops." Architect handles the doc edit at archive; flag via `[TODO Architect]` in the signal block.

## Out of scope

- Rebuilding the rate-limit middleware from scratch. The fix should reuse existing middleware semantics where possible.
- Sliding-window vs fixed-window limiter semantics. PEvO uses what it uses; not in scope.
- Per-IP vs per-account limiter discrimination changes. Not in scope.
- BROADCAST_FAILED / BROADCAST_TIMEOUT slot-burn behavior. Those are chain-side errors with explicit `verify_before_retry` guidance; the SPA doesn't auto-retry on them. Separate concern.

## Cross-references

- `backend/src/routes/papers.ts:720` — `retractLimiter` declaration.
- `backend/src/routes/papers.ts:3095` (post round-2 hold) — `/retract` HafQueryError catch arm emitting the new retriable 503.
- `backend/src/middleware/rateLimit.ts` — limiter middleware (verify `skipFailed` support).
- `agents/docs/api-contracts/common.md` § 503 SERVICE_UNAVAILABLE and details.retriable — the cross-cutting note on retriable 503 emitters (updated 2026-05-20 in commit `66b213ac` to enumerate the new emitter classes).
- `agents/docs/api-contracts/papers.md` § POST /api/papers/:author/:permlink/retract Errors — `SERVICE_UNAVAILABLE` entry already notes the rate-limit interaction guidance pending this task's resolution.

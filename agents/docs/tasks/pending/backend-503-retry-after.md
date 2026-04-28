# BE-503-RETRY-AFTER — Set Retry-After header on 503 SERVICE_UNAVAILABLE responses

**Owner:** backend
**Created:** 2026-04-28 (surfaced by argon2 cluster re-review)
**Priority:** P3
**Blocked by:** `backend-argon2-error-handler-extract.md` (Retry-After is most cleanly added to the centralized handler — avoids per-route updates).

## Context

The argon2 cluster introduced 503 SERVICE_UNAVAILABLE responses across auth, settings, custody, signup-verify routes for two distinct conditions:
- ArgonQueueFullError (transient, retry in seconds)
- ShuttingDownError (deployment, retry in 30s+)

None of the 503 responses currently set a `Retry-After` header. RFC 7231 SHOULD-level recommendation. Without it, clients applying exponential backoff make arbitrary retry-window decisions; some retry too fast (worsening queue pressure on the new instance during rolling deploys) and some treat 503 as a non-retryable error.

The 429 RATE_LIMITED responses from the rateLimit middleware DO set Retry-After correctly (precedent and pattern available).

## Goal

Add Retry-After to the 503 responses with cause-appropriate values.

## Acceptance

- ArgonQueueFullError → `Retry-After: 5` (seconds; queue typically drains in ~625ms at full depth × 4 cap, but 5s gives a safe window).
- ShuttingDownError → `Retry-After: 30` (matching the server.close() force-timeout).
- ArgonAbortError → no header (response is silent — client is already disconnected).
- Implemented in the centralized handler (post-`backend-argon2-error-handler-extract.md`), so all 4 routes get the header consistently.
- Tests updated to assert the header presence and value (the 503 route-level tests in `backend-argon2-error-routes-test-coverage.md`).

## Non-goals

- Sub-coding the SERVICE_UNAVAILABLE error code into separate codes (deliberate decision: clients use Retry-After + body message; no second discriminator needed).
- Dynamic Retry-After computation based on actual queue depth (over-engineering — 5s flat is good enough).

## Implementation note (chosen shape)

Per-branch defaults live on the helper (`QUEUE_FULL_RETRY_AFTER_SEC = 5`, `SHUTDOWN_RETRY_AFTER_SEC = 30`), exported alongside `SERVICE_UNAVAILABLE_MESSAGE` and applied by `handleArgonError` itself via `res.set('Retry-After', ...)` before `sendError`. `HandleArgonErrorOpts.retryAfterSec` was already declared as a reserved hook by `backend-argon2-error-handler-extract.md`; it is now wired as an optional per-call override that wins over the per-branch default for whichever branch fires. No call-site change is required (every existing route gets the header for free); a route can override by passing `{ retryAfterSec }` if a future condition warrants it. `ArgonAbortError` does NOT set the header (socket is gone).

[TODO Architect] Document the `Retry-After` header on 503 SERVICE_UNAVAILABLE responses in `agents/docs/api-contracts/auth.md` (and any other contract files that reference the 503 from the argon2 surface — custody, settings, signup-verify). Suggested wording: "503 SERVICE_UNAVAILABLE responses set `Retry-After` (seconds): 5 for transient queue saturation, 30 during a SIGTERM drain. Clients SHOULD honor it instead of using exponential backoff." Helper-level constants are exported (`QUEUE_FULL_RETRY_AFTER_SEC`, `SHUTDOWN_RETRY_AFTER_SEC`) for cross-reference if the contract wants exact numbers.

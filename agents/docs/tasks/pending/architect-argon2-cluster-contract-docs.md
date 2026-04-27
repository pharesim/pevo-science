# ARCHITECT-ARGON2-CLUSTER-CONTRACT-DOCS — Document 503 SERVICE_UNAVAILABLE responses across auth/settings/custody contracts

**Owner:** architect
**Created:** 2026-04-28 (surfaced by argon2 cluster re-review)
**Priority:** P2
**Blocked by:** `backend-argon2-jslevel-concurrency-cap.md` round-3 hold landing AND `backend-argon2-semaphore-shutdown-drain.md` archiving AND `backend-argon2-semaphore-abort-signal.md` archiving (architect-owned contract sweep should reflect the final settled behavior, not intermediate states).

## Context

The argon2 cluster (jslevel-concurrency-cap, shutdown-drain, abort-signal) introduced new 503 SERVICE_UNAVAILABLE responses on auth, settings, custody, and signup-verify routes. The current API contract files do not document this status code or its semantics. `common.md` Standard Error Codes table has no 503 row.

Affected routes that can now return 503 SERVICE_UNAVAILABLE:
- POST /api/auth/signup
- POST /api/auth/login
- POST /api/auth/resend-verification
- POST /api/auth/reset-request
- POST /api/auth/reset
- POST /api/auth/recover
- POST /api/auth/resume-signup (signup-verify.ts)
- POST /api/custody/upgrade
- POST /api/settings/set-password

Two distinct trigger conditions both surface as `{ status: 'error', error: { code: 'SERVICE_UNAVAILABLE', message: '...' } }`:
- **ArgonQueueFullError** — argon2 semaphore queue saturated (transient, retry in seconds)
- **ShuttingDownError** — backend received SIGTERM and is draining (deployment in progress, retry in 30s+)

The body message string is being genericized in a separate task (`backend-503-message-genericize.md`) so this contract update should describe the response shape after that lands.

`/api/health` shape returns to its pre-cluster state in round-3 of jslevel-concurrency-cap (no contract update needed for misc.md).

## Goal

Update the architect-owned contract files to document the new 503 surface accurately.

## Acceptance

- `agents/docs/api-contracts/auth.md` — Errors section for each affected route includes a 503 SERVICE_UNAVAILABLE entry. Cross-reference common.md for the shared semantics rather than duplicating the message description per route.
- `agents/docs/api-contracts/settings.md` — Errors section for /set-password includes 503 SERVICE_UNAVAILABLE.
- `agents/docs/api-contracts/custody.md` — Errors section for /upgrade includes 503 SERVICE_UNAVAILABLE.
- `agents/docs/api-contracts/common.md` — Standard Error Codes table gains a 503 SERVICE_UNAVAILABLE row noting the dual trigger (queue saturation OR graceful shutdown), the response body shape, and that clients should retry with backoff.
- If `backend-503-retry-after.md` lands before this task: document the Retry-After header semantics (5s for queue-full, 30s for shutdown) in common.md.

## Non-goals

- Do NOT add a sub-code field that distinguishes queue-full from shutdown. The decision is to keep the existing single SERVICE_UNAVAILABLE code; clients treat both with backoff retry.
- Do NOT update misc.md /api/health entry. The cluster's round-3 strip returns the public response to its pre-cluster shape.

# BE-503-REASON-DISCRIMINATION — Add `details.reason` to argon2-503 envelopes so canary monitors can branch on shutdown vs queue-saturation

**Owner:** backend
**Created:** 2026-04-28 (surfaced by cluster A `/ce-code-review` of `backend-argon2-semaphore-shutdown-drain.md`, agent-native persona reframed as ops observability per root `CLAUDE.md` "API Consumer Surface")
**Priority:** P2

## Problem

`runWithArgon2Slot` throws three error classes that all map to 503 in route catch handlers:

- `ArgonQueueFullError` — transient capacity event. Operator action: investigate, scale up if sustained, page if rate spikes.
- `ShuttingDownError` — expected during rolling restart. Operator action: suppress alert; the next instance handles new requests.
- (`ArgonAbortError` — silent return, not 503; out of scope here.)

Both `ArgonQueueFullError` and `ShuttingDownError` map to:

```json
{
  "status": "error",
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "Authentication service temporarily overloaded. Please retry."
  }
}
```

(or "Service shutting down. Please retry." — but the message field is human-readable, not machine-parsed.)

Same status, same `error.code`. The two cases are **operationally very different** but indistinguishable to an HTTP-only consumer (canary monitors, status-page probes, browser-side error tracking, mobile SDK telemetry).

The log-tier distinction (`warn` for queue-full, `info` for shutdown) requires log-stream correlation. Many monitoring setups have HTTP-only access (synthetic canaries running externally; status-page services). They can't branch on log tier.

Sibling tasks in the same area: `backend-503-message-genericize.md` (in `pending/`) and `backend-503-retry-after.md` (in `pending/`). All three are 503-envelope refinements; this is the third sibling.

## Goal

Extend the 503 envelope's `details` field (already supported by `sendError`) to carry a machine-readable `reason` discriminator:

```json
{
  "status": "error",
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "Service shutting down. Please retry.",
    "details": {
      "reason": "shutdown_drain"
    }
  }
}
```

Values:
- `"queue_full"` — for `ArgonQueueFullError` mapping.
- `"shutdown_drain"` — for `ShuttingDownError` mapping.

A canary monitor reading the response can branch on `error.details.reason === 'shutdown_drain'` to suppress alerts during deploy windows, vs. `error.details.reason === 'queue_full'` to investigate as a real saturation event.

## Acceptance

- `handleArgonError` in `backend/src/lib/argon-error-handler.ts` sets `details.reason: 'queue_full' | 'shutdown_drain'` on the appropriate branches when emitting `sendError(res, 503, 'SERVICE_UNAVAILABLE', ..., { reason: '...' })`.
- All four route catch sites (auth, custody, settings, signup-verify) emit the field via the helper (no per-route duplication needed since they go through the helper).
- `agents/docs/api-contracts/common.md`'s SERVICE_UNAVAILABLE error code documentation is updated to include `details.reason: 'queue_full' | 'shutdown_drain'`.
- Existing tests in `backend/tests/routes/auth-signup-dup-saturated.test.ts` are extended (or new tests added to `backend/tests/lib/argon-error-handler.test.ts` if it exists) to assert `body.error.details.reason` value per error class.
- Existing route-level tests for the 503 path continue to pass with the new field present (additive change).

## Non-goals

- Coordinating with `backend-503-message-genericize.md` (different change to message field).
- Coordinating with `backend-503-retry-after.md` (different change adding Retry-After header).
- Adding new HTTP status codes (still 503 in both cases; the discrimination is in `details.reason`).
- Adding `reason` for non-argon2 503 paths (the pool-unavailable 503 in `getAppPool() === null` cases) unless the helper naturally extends. Out of scope for this task; track as follow-up if desirable.

## Related

- `backend-503-message-genericize.md`, `backend-503-retry-after.md` — sibling 503-shape refinement tasks already in `pending/`.
- `agents/docs/solutions/conventions/agent-native-persona-calibration-for-pevo-2026-04-28.md` — explains why the cluster A finding that surfaced this was reframed from agent-native to ops observability.

## [TODO Architect]

None — extends an existing helper with a clearly-bounded new field.

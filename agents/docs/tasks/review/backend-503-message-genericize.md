# BE-503-MESSAGE-GENERICIZE — Generic 503 message string to reduce information disclosure about argon2

**Owner:** backend
**Created:** 2026-04-28 (surfaced by argon2 cluster re-review)
**Priority:** P3
**Blocked by:** `backend-argon2-error-handler-extract.md` (single point of change once the handler is centralized).

## Context

The 503 SERVICE_UNAVAILABLE responses currently use the message string:
- `"Authentication service temporarily overloaded. Please retry."` (ArgonQueueFullError)
- `"Service shutting down. Please retry."` (ShuttingDownError) — exact wording varies; check before edit

The "authentication service temporarily overloaded" string tells an attacker:
1. The 503 is queue-saturation related (not a misconfiguration or backend-down).
2. Authentication is the bottleneck worth saturating (i.e., argon2 cap is the chokepoint).

Combined with the 503 status code alone, this is minor reconnaissance. The error-code field already conveys SERVICE_UNAVAILABLE; the human-readable message can be more generic without losing any client-side actionability.

## Goal

Reduce information disclosure in the 503 body message.

## Acceptance

- Replace the message strings with: `"Service temporarily unavailable. Please retry."` (or similar generic phrasing) for both ArgonQueueFullError and ShuttingDownError.
- ArgonAbortError remains silent (no body written; not in scope).
- Operator-facing log messages (`logger.warn` for queue-full, `logger.info` for shutdown) MUST retain their distinct wording — operators need to triage these differently. Only the client-facing body string is genericized.
- Tests updated to assert the new message string.

## Non-goals

- Removing the message field entirely (clients may parse it for display; keep it informative without being diagnostic).
- Localization (out of scope — the project does not yet localize backend error messages).

## Implementation note

Both 503 branches in `backend/src/lib/argon-error-handler.ts` now share `SERVICE_UNAVAILABLE_MESSAGE` (exported constant): `"Service temporarily unavailable. Please retry."`. Operator-facing log lines retain their distinct wording (`logger.warn` for queue-full, `logger.info` for shutdown). The constant is exported so downstream tests can assert against a canonical string instead of a hand-copied literal.

[TODO Architect] If `agents/docs/api-contracts/auth.md` (or related contract files) quotes the previous body strings ("Authentication service temporarily overloaded.", "Service shutting down."), update them to reference the new generic phrasing.

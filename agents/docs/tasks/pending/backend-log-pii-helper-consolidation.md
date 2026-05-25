# BACKEND-LOG-PII-HELPER-CONSOLIDATION — Move forensicDigest / hashUserAgentForAudit into lib/log-pii.ts

**Owner:** backend
**Created:** 2026-05-25 (architect, surfaced by /ce-code-review on backend-recover-email-verification-and-notify; maintainability + kieran-typescript persona)
**Priority:** P3 (cleanup; deferred from recover-email closure)

## Problem

`backend/src/routes/auth.ts` defines `forensicDigest(value: string)` returning `crypto.createHash('sha256').update(value).digest('hex')`.

`backend/src/routes/custody.ts` defines `hashUserAgentForAudit(value: string)` with a byte-for-byte identical body. The docblock above `forensicDigest` in `auth.ts` explicitly cites `custody.ts` as the rationale source.

`backend/src/lib/log-pii.ts` already houses related PII-digest helpers: `hashEmailForLogs`, `safeHashEmailForLogs`, `hashTokenForLogs`, `maskEmail`. The forensic-digest helper is generic over `value: string` (not auth-specific or custody-specific) and belongs in the same module.

Two duplicate copies will become three the next time a route needs a full SHA-256 hex digest for audit purposes.

## Goal

Consolidate the duplicate body into a single helper in `lib/log-pii.ts`. Both routes import from there.

## Acceptance

- Add a helper to `backend/src/lib/log-pii.ts` returning `crypto.createHash('sha256').update(value).digest('hex')`. Name it for the data it produces (e.g., `sha256HexDigest` or `forensicDigest` — implementer's call, consistent with the existing naming style in that file).
- `backend/src/routes/auth.ts` imports the helper and removes the local `forensicDigest` definition + docblock.
- `backend/src/routes/custody.ts` imports the helper and removes `hashUserAgentForAudit` (or has it delegate one-line to the new helper if call sites benefit from the domain-specific name).
- Existing tests for both routes still pass — the helper is pure, so call-site equivalence is the regression guard.
- No new behavior introduced.

## Non-goals

- Rename the field at consumption sites (e.g., `request_ip_hash`, `user_agent_hash`). Data-model stable.
- Add new digest variants (HMAC-keyed, scoped, etc.). Pure refactor.

## References

- `backend/src/routes/auth.ts` — `forensicDigest` definition (search by name)
- `backend/src/routes/custody.ts` — `hashUserAgentForAudit` definition (search by name; the docblock cites the duplication explicitly)
- `backend/src/lib/log-pii.ts` — existing PII-hash helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

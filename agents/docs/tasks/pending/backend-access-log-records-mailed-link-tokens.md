# The access log records the single-use tokens that mailed links carry

**Owner:** backend
**Created:** 2026-10-06
**Priority:** normal

## Why

`httpLogger` (`backend/src/logger.ts`) serializes every request as
`{ method, url: req.url, remoteAddress }`, and `app.ts` mounts it ahead of
the static files, the API routers and the SPA fallback. Several mailed links
carry a single-use token in the URL, so opening one writes the raw token to
the access log:

- `/signup/verify?token=` (`routes/auth.ts`)
- `/accreditation/verify?token=` (`routes/accreditation.ts`)
- `/auth/reset?token=` (`routes/auth.ts`; the path moves to
  `/reset-password` under `backend-password-reset-link-has-no-page`)
- `/recover/verify?token=` and `/recover/dispute?token=` (`routes/recover.ts`)
- `/settings/verify-email/<token>` (`routes/settings.ts`), a path segment
- the digest unsubscribe link `/api/profile/<user>/notification-preferences/unsubscribe?token=` (`digest.ts`)

Whoever reads the log can redeem a token that has not been spent yet; the
recovery confirm token, for one, yields a session on the account. The
codebase already keeps raw tokens out of its logs elsewhere
(`hashTokenForLogs` in `backend/src/lib/log-pii.ts`).

Surfaced in the review of `ui-seed-recovery-confirm-and-dispute-pages`
(pre-existing, unchanged by that work).

## Scope

1. Redact tokens from the URL the access log records: `token` query
   parameters on any path, and the `/settings/verify-email/<token>` path
   segment.
2. Tests that pin the serializer's output for each shape, and that a URL
   without a token is logged unchanged.

## Acceptance criteria

1. Opening any link listed above writes no raw token to the access log.
2. Method, path and the other query parameters stay in the log line.

## Architect note (2026-10-08)

`backend-password-proven-orcid-link-completes-from-current-mailbox` adds one more mailed
query-string token, the ORCID confirm link `/settings/orcid-link?token=`; it falls under this
task's query-parameter scope.

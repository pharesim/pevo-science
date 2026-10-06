# The email-change confirmation page spends its token on open

**Owner:** ui
**Created:** 2026-10-06
**Priority:** low

## Why

The email-change confirmation link `/settings/verify-email/<token>` (mailed
by `backend/src/routes/settings.ts`) opens `settingsVerifyEmailPage`
(`frontend/src/pages/settings-verify-email.js`), whose `init()` calls
`verify(token)` at once. That request, `GET /api/settings/email/verify/:token`,
needs no session and applies the email change. A mail scanner that opens
the link and runs the page spends the single-use token: the change applies,
and the owner's own click then shows the error state. The seed-recovery
confirm and stop pages (`recover-verify.js`, `recover-dispute.js`) send their
token only from a button for this reason.

Surfaced in the review of `ui-seed-recovery-confirm-and-dispute-pages`.

## Scope

1. Opening the page sends nothing; a confirm button sends the token.
2. Copy for the confirm step in all sixteen locales per the `STUBS.md`
   convention.
3. Unit tests pin that nothing is sent on open and that the button sends
   the token once.

## Acceptance criteria

1. Rendering `/settings/verify-email/<token>` without a click leaves the
   token unspent.
2. The click applies the change as today.

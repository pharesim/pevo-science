# The reset-request confirmation promises a link a passwordless account never gets

**Owner:** ui
**Created:** 2026-10-05
**Priority:** low

Filed at the architect archive of the password-reset account-state gate (archived 2026-10-05),
from its signal block's out-of-scope findings. User triage: "as recommended".

## Why

`resetPassword.checkEmailDescription` ("If an account exists with that email, you’ll receive a
password reset link shortly.") shows after every reset request on `pages/reset-password.js`.
`POST /api/auth/reset-request` now sends no link to an account without a password, and
`backend-reset-tokens-outlive-email-changes-and-recovery` adds the unverified state G row. Such
an account exists, so the copy tells its owner a link is coming when none is.

## Scope

1. Change the `en` string so it is true for every account that gets no link and identical for
   every request: the page must not show whether an account exists or has a password.
   Suggested: "If an account with a password exists for that email, you’ll receive a password
   reset link shortly." (intent only: match the backend's final `RESET_REQUEST_OK_MESSAGE`
   wording, set by the backend task above).
2. Apply the rule for an updated `en` string to the other fifteen locales
   (`frontend/public/messages/STUBS.md`).
3. No emdashes in the copy.

## Acceptance criteria

1. The confirmation copy is true for a passwordless account and the same for every request.
2. Every locale follows the updated-string rule.

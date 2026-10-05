# The signup verify page asks for the signup password

**Owner:** ui
**Created:** 2026-10-05
**Priority:** high

The UI half of `backend-signup-verify-requires-the-signup-password`, filed at the user's request
on 2026-10-05. Read that task's Why first: it explains the account takeover this closes.

## Why

`POST /api/auth/verify` will require the password chosen at signup beside the mailed token, and
will answer 400 `VALIDATION_ERROR` without it. Today `pages/signup-verify.js` calls
`verifyToken(emailToken)` from `init()` as soon as the page loads with `?token=`, and
`verifyEmail(token)` in `api.js` sends `{ token }` only. Once the backend change lands, that call
fails and the email signup flow stops at the verify page.

## Scope

1. **`api.js`:** `verifyEmail(token, password)` sends `{ token, password }`.
2. **`pages/signup-verify.js`:** landing with `?token=` shows a password field. It does not verify
   on load. Submitting sends the token and the password.
   - 401 `UNAUTHORIZED` means a wrong password. Show that, keep the form, and keep the token: the
     link stays usable.
   - The 400 `BAD_REQUEST` answers (an unknown, already used or expired token) keep today's
     handling.
   - A 503 from argon saturation shows a retry message.
   - The resume path (`query.resume === RESUME_MARKER`) is unchanged.
3. **Copy:** the prompt says this is the password chosen when signing up for PEvO, and that someone
   who did not sign up should close the page. New strings go through the project's i18n flow.
4. **Specs:** `tests/unit/pages-signup-verify.test.js`, plus whichever of
   `tests/e2e/email-signup.spec.js` and `tests/e2e/seed-phrase.spec.js` drive the verify link,
   enter the signup password. Add a unit spec: a 401 keeps the form and the token, and a retry
   with the right password reaches the `choose` phase.

## Notes

- This can ship before the backend task or with it, never after. The current `/verify` ignores
  the extra `password` field, but the backend change alone breaks the flow.
- The E2E specs need the backend change on the test stack.

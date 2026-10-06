# The mailed password-reset link opens the home page, so a reset by email cannot be completed

**Owner:** backend
**Created:** 2026-10-06
**Priority:** high

## Why

`POST /api/auth/reset-request` mails `${config.appUrl}/auth/reset?token=...`
(`backend/src/routes/auth.ts`, the reset-request handler). The backend
answers that path only with the SPA shell, and the SPA router
(`frontend/src/router.js`, `ROUTES`) knows `/reset-password` only, so the
link falls through `parsePath`'s unmatched-path fallback to the home page.
The SPA's reset page, `resetPasswordPage` in
`frontend/src/pages/reset-password.js`, reads `token` from the query string
in `init()` and shows the new-password form. `password-recovery.spec.js`
drives `/reset-password?token=` directly, so no test meets the mailed path.

Surfaced in the review of `ui-seed-recovery-confirm-and-dispute-pages`; the
user chose the backend fix on 2026-10-06.

## Scope

1. Build the reset link as `${config.appUrl}/reset-password?token=...`.
2. A test that pins the mailed link's path, following how the existing
   reset-request tests read the sent mail.

## Acceptance criteria

1. The link in the reset mail opens `/reset-password` with the token in the
   query, and the page shows the new-password form.
2. A test fails if the mailed path stops matching the SPA's reset route.

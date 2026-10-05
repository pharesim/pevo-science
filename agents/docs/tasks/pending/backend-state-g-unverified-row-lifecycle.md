# State G rows: unverified-email lifecycle and token scoping

**Owner:** backend
**Created:** 2026-10-05

Surfaced by the state-G sweep on the account-state comments task (its signal block,
"Needs triage", items 1-11). The user triaged every item to "fix" on 2026-10-05 and
made two decisions:

- **Unverified G rows: verify the email first.** A state G row (ARCHITECTURE.md § 6.1)
  whose settings-registered email is still unverified may not acquire auth factors:
  setting a password and linking an ORCID are refused until the email is verified. An
  expired unverified G row then carries nothing but the email claim, so the hourly
  cleanup may keep deleting it (back to the no-row case, email released). Login never
  deletes a G row. Re-adding an email on an unverified G row re-sends its verification
  link instead of going through the change flow.
- **Include the two pending sibling tasks** in the same pass:
  `backend-signup-upsert-overwrites-finalized-row` and
  `backend-settings-verify-clears-any-row-token`. Each keeps its own task file, signal
  block and move to review.

The signup flow itself is unchanged: signup rows (E/F) have `username` NULL and never
reach the G-only branches. The one signup-visible change comes from the upsert task: a
signup for an email an unverified G row holds answers 409 until that claim expires and
is reaped (at most the 24h link expiry plus the hourly cleanup).

## Scope

1. **Login (`POST /api/auth/login`).** The pending-signup branch (PENDING_SIGNUP,
   PENDING_UNVERIFIED, the expiry DELETE and SIGNUP_EXPIRED) applies only to signup rows
   (`username` NULL). A G row with a password and an unverified email logs in normally
   and is never deleted here.
2. **Signup cleanup (`signup-cleanup.ts`).** Signup rows keep today's two expiry arms. A G
   row is deleted only when its email is unverified (hex `verify_token`), its link has
   expired, and it carries no password and no ORCID. A G row carrying a factor (a legacy
   row from before the gates in items 6-7) is never deleted by the job.
3. **Signup verify link (`POST /api/auth/verify`).** The token lookup is scoped to signup
   rows (`username` NULL). A G row's settings token answers exactly what an unknown token
   answers, and the row is untouched.
4. **Resend verification (`POST /api/auth/resend-verification`).** A row with `username`
   set (any finalized row, G included) is treated as not pending: uniform message, no
   token rewrite, no mail. Timing equalisation is preserved.
5. **ORCID recovery (`POST /api/auth/recover`, ORCID method).** Refused for any row whose
   custody claim is not light (`custodyClaimFor`), which excludes G as well as D, with the
   same 401 and generic message the upgraded and no-ORCID branches already return. This
   matches § 6.4 (ORCID recovery: B and C). The seed-phrase method already excludes G and
   D (no `memo_key_enc`).
6. **Set password (`POST /api/settings/set-password`).** Refuses a G row whose email is
   unverified (409 `PENDING_UNVERIFIED`, an existing error code).
7. **ORCID link and accredit (`/api/orcid` callback, `mode='link'` and `mode='accredit'`).**
   Refuse, before any broadcast, a caller whose row is a G row with an unverified email
   (409 `PENDING_UNVERIFIED`). A caller with no row is unaffected. Accredit is included
   because it writes the same `accounts.orcid` factor onto the row.
8. **Settings email.** (a) `POST /api/settings/email` on an existing unverified G row
   re-issues the add-flow verification (new `email`, `verify_token`, `expires_at`)
   instead of writing the pending-change fields; the JWT-path fresh-auth gate and the
   duplicate checks are unchanged. (b) The verify handler's change branch also clears a
   hex `verify_token`, since proving control of the new address verifies the row's email
   (legacy rows that used the change flow while unverified). (c) The add-flow lookup in
   the verify handler is scoped per `backend-settings-verify-clears-any-row-token`.
9. **Signup upsert** per `backend-signup-upsert-overwrites-finalized-row`.
10. **Login `NO_PASSWORD_SET` message.** One uniform message that is true for every
    passwordless row and leaks nothing per row (the branch is unauthenticated).
11. **Comments.** The JWT-path-equals-light-account comments (`admin-roster.ts`,
    `validation.ts`, `accreditation-metadata.ts`) and the "no-row-before-JWT invariant"
    comments (`settings.ts`, `settings-email-fresh-auth.test.ts`), plus every comment the
    code changes above make stale.
12. **Test data.** `settings-email-delete-fresh-auth` seeds a real § 6.1 shape; the
    migration 017 test title names G's NULL column.

## Acceptance criteria

1. Each behaviour in items 1-10 is pinned by a route or job test that fails against the
   pre-change code and passes after it.
2. No new error code: refusals reuse `PENDING_UNVERIFIED`; the recovery refusal reuses the
   existing 401 envelope.
3. Timing equalisation and uniform messages are preserved on every unauthenticated branch
   touched (login, resend, signup, recover).
4. No new writer of `accounts.updated_at`.
5. Comment-anchor conventions hold in everything written.

# Reset tokens outlive email changes and recovery, and unverified G rows still get reset links

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Filed at the architect archive of the password-reset account-state gate (archived 2026-10-05),
from its signal block's out-of-scope findings and two residual risks from the review. User
triage: "as recommended".

## Why

1. **A reset token outlives the email it was mailed to.** Only `routes/auth.ts` writes
   `reset_token`: `POST /reset-request` sets it, and `POST /reset` clears it on use or expiry.
   No UPDATE that moves the row's `email` touches it. A grep at filing found four:
   `routes/recover.ts` `POST /recover` and `POST /recover/verify`, and in `routes/settings.ts`
   the change-flow confirm in `GET /email/verify/:token` (`SET email = pending_email`) and the
   re-issue branch of `POST /email` for an unverified state G row. `POST /reset` selects by
   token alone, so the token keeps working for the rest of its hour.

   Example: someone controls a user's mailbox and requests a reset. The user recovers through
   ORCID with a new email and a new password. The outstanding token still rotates the password,
   and the reset stamps `sessions_invalidated_at`, which revokes the user's sessions.

   A narrower case: ORCID recovery without a new password sets `password_hash` to NULL and
   leaves the token. The reset gate refuses that token while the row has no password. If the
   owner sets a password through `POST /api/settings/set-password` within the token's hour,
   the token rotates it.

2. **An unverified state G row with a password still gets a reset link.** A state G row
   (ARCHITECTURE.md § 6.1) whose settings-registered email is unverified has `username` set
   and a hex `verify_token`. `POST /api/settings/set-password` refuses such a row, so one with
   a password is a legacy row. Reset mails the link to an address the row never proved, so
   whoever holds that address sets the password, and `POST /api/auth/login` logs in a G row
   with a password whatever its email state. The user's state G decision is that an unverified
   G row may not acquire auth factors. A G account signs in with Keychain, so refusing it a
   reset leaves its owner a way in. `tests/routes/auth-reset-account-state.test.ts` pins this
   row as rotating ("G, email unverified, with a password (legacy shape)"); that spec flips.

3. **The reset-request answer promises a link that does not come.** `RESET_REQUEST_OK_MESSAGE`
   ("If an account exists with that email, a reset link has been sent.") is false for a
   passwordless account, and after item 2 for an unverified G row: the account exists and no
   link is sent. The answer must stay identical for every caller.

## Scope

1. Measure first: list every statement in `backend/src` that writes `accounts.email` or sets
   `accounts.password_hash` to NULL. The list under Why is from a grep at filing; go by your
   measurement.
2. Every UPDATE that changes `email` or sets `password_hash` to NULL also sets
   `reset_token = NULL, reset_token_expires_at = NULL`.
3. `POST /reset-request` and `POST /reset` refuse an unverified state G row the way they refuse
   a passwordless row, at both ends: the unknown-email answer and no token at `/reset-request`,
   the unknown-token `INVALID_TOKEN` answer and an unchanged row at `/reset`. Put the new term
   where the password gate sits (the lookup predicate and the UPDATE predicate), so a refusal
   stays the unknown-email and unknown-token code path.
4. Narrow `RESET_REQUEST_OK_MESSAGE` so it is true for every row reset-request refuses and
   identical for every caller. Suggested: "If an account with a password exists for that email,
   a reset link has been sent." (intent only: after Scope item 3 an unverified G row with a
   password gets no link either; write the sentence against the code). No emdashes. The UI
   shows its own copy, changed by `ui-reset-request-copy-promises-a-link`. Leave a TODO for the
   architect: `api-contracts/auth.md` quotes the message.
5. Comments these changes make false: fix each by deleting the claim or cutting it to what the
   code does, not by listing the new exceptions.
   - `routes/auth.ts`, the `/reset` UPDATE comment: "It also refuses a token that outlived its
     row's password: ORCID recovery without a new password drops the hash and leaves the token
     in place." After Scope item 2 the recovery clears the token.
   - "gates on no account state but the password", in `routes/signup-verify.ts` (the `/link`
     stuck-recovery rationale) and `tests/routes/signup-verify-stuck-recovery.test.ts`. Scope
     item 3 adds an account-state term. The lookup SQL in `signup-verify.ts` stays
     byte-identical.
   - The header of `tests/routes/auth-reset-account-state.test.ts`: "standing in for one issued
     before the gate existed or for a password dropped while the token was outstanding." After
     Scope item 2 a dropped password clears the token.
6. Route tests against real Postgres: for each writer from Scope item 1, a token issued before
   the write is refused after it and the password is unchanged. The unverified G row with a
   password is refused at both ends, with the answers deep-equal to the unknown-email and
   unknown-token answers and the timing floor the existing suite asserts.

## Acceptance criteria

1. No UPDATE in `backend/src` changes `email` or sets `password_hash` to NULL without clearing
   both reset-token columns.
2. `reset-request` and `reset` refuse an unverified state G row exactly as they refuse a
   passwordless row.
3. The reset-request answer is true for every refused row and identical for every caller.
4. The completion signal lists the writers Scope item 1 found and the per-state outcome changes,
   so the architect can update ARCHITECTURE.md § 6.3/6.4 and `api-contracts/auth.md`. Do not
   edit those yourself.

## Note (2026-10-06, backend): land with the pending-email-change sibling

`backend-recovery-and-reset-keep-a-queued-email-change` edits the same three statements: the two
recovery UPDATEs in `routes/recover.ts` and the `POST /reset` UPDATE in `routes/auth.ts`. It adds
`pending_email = NULL, pending_email_token = NULL, pending_email_expires_at = NULL` to their SET
lists. Land both in one pass so each statement is edited once. Neither task closes the other's
path.

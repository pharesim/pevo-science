# Recovery and password reset leave a queued email change alive, so the evicted attacker takes the account back

**Owner:** backend
**Created:** 2026-10-06
**Priority:** high

Filed at the user's request from the pre-existing findings in the signal block of
`backend-settings-verify-clears-any-row-token` (its item 2), after a scoping pass that measured
the takeover end to end on 02c66d99. The scoping found that password reset has the same hole as
the two recovery routes.

## Why

The change flow of `POST /api/settings/email` writes `pending_email`, `pending_email_token` and
`pending_email_expires_at`, and mails the link only to the new address. Clicked within
`EMAIL_TOKEN_EXPIRY_MS` (24h, restarted by each re-queue), the link swaps the account email.

Three statements evict a password holder by replacing the password (and, for recovery, the
email) and stamping `sessions_invalidated_at`. None of them clears that triple:

- `routes/recover.ts`, `POST /recover`, ORCID method:
  `UPDATE accounts SET password_hash = $1, email = $2, sessions_invalidated_at = $3 WHERE id = $4`
- `routes/recover.ts`, `POST /recover/verify`, the apply transaction:
  `UPDATE accounts SET password_hash = COALESCE($1, password_hash), email = $2, sessions_invalidated_at = $3 WHERE id = $4`
- `routes/auth.ts`, `POST /reset`:
  `UPDATE accounts SET password_hash = $1, reset_token = NULL, reset_token_expires_at = NULL, sessions_invalidated_at = NOW() WHERE id = $2 AND password_hash IS NOT NULL`

Measured through the real routes: the real `verifyHiveSignature` JWT path, real login, real
fresh-auth. Only the SMTP transporter was mocked and the ORCID nonce seeded. The sequence:

1. An attacker who has only the password logs in, gets a `change_email` fresh-auth proof with
   that password, and queues a change to their own address.
2. The owner evicts them by ORCID recovery, seed-phrase recovery or password reset. The eviction
   works: the old JWT gets 401 SESSION_INVALIDATED and the old password is refused.
3. The queued link still answers 200 and sets `accounts.email` to the attacker's address.
4. `POST /api/auth/reset-request` mails the attacker a reset link. Reset and login then hand them
   the account.

After an ORCID recovery without a new password, the link still takes the email. The reset chain
completes once the owner sets a password through `POST /api/settings/set-password`.

The owner gets no warning. The change mail goes only to the new address, and nothing in
`frontend/src` reads the `pendingChange` field of `GET /api/settings/email`.

A planted fix that clears the triple in all three statements makes the stale link answer the
not-found 400, deep-equal to an unknown token's answer, and keeps the post-eviction email.

## Scope

1. Add `pending_email = NULL, pending_email_token = NULL, pending_email_expires_at = NULL` to the
   SET list of the three statements above. Write all three columns in the one statement, so that
   every write of `pending_email` or `pending_email_token` still writes both. The change-branch
   swap in `GET /api/settings/email/verify/:token` relies on that pairing.
2. Leave `POST /api/custody/upgrade`, the fourth writer of `sessions_invalidated_at`, unchanged.
   It replaces neither the password nor the email (ARCHITECTURE.md § 6.2: D keeps
   `password_hash`), so clearing the triple there evicts no one. A D owner evicts a password
   holder through `POST /api/auth/reset`, which this task covers. The upgrade docblock's sentence
   about "the same posture the password-reset and recovery writers take" concerns bearer JWTs and
   session-proof windows. It is not a contradiction for this task to fix.
3. Add no new response string, status or error code. A cleared link gets the existing not-found
   400.
4. Fix any comment the change makes false by deleting or narrowing it. At filing, the change made
   none false: the change-branch comments in `routes/settings.ts` and the docblock of
   `tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts` both stay true
   under NULL-only writes. List the three changed writers in the signal block, so the architect
   can record in ARCHITECTURE.md § 6.3 that recovery and reset drop a pending email change.
5. Tests: one new real-path route spec file. The attacker queues the change through the real
   `POST /api/auth/login`, `POST /api/custody/fresh-auth` (action `change_email`) and
   `POST /api/settings/email`. Mock only the SMTP transporter and `config.smtpHost`, and seed the
   ORCID nonce. Use carve-out header items (a) and (c) as in `tests/routes/recover-two-phase.test.ts`
   and `tests/routes/recover-orcid-state-g.test.ts`. `verifyHiveSignature` runs real, so (b) does
   not apply.

## Acceptance criteria

1. The three named statements clear the triple. The custody upgrade is unchanged.
2. ORCID recovery spec: a state B row with a change queued through the real fresh-auth gate, then
   a 200 `POST /api/auth/recover` with `orcid_token`. The queued link answers a 400 deep-equal to
   an unknown token's answer, `accounts.email` equals the recovery's `new_email`, and the triple
   is NULL. The spec asserts the triple was non-NULL just before the recovery, and it fails
   against the pre-change code.
3. Seed-phrase recovery spec: the same, with `POST /api/auth/recover` (memo key) plus
   `POST /api/auth/recover/verify` as the eviction. It fails against the pre-change code.
4. Password reset spec: the same, with the owner's `POST /api/auth/reset-request` plus
   `POST /api/auth/reset` as the eviction. `accounts.email` stays the owner's address, and the
   spec fails against the pre-change code.
5. These stay green, judged by exit code and the Errors line: `tests/routes/recover.test.ts`,
   `recover-two-phase.test.ts`, `recover-orcid-state-g.test.ts`,
   `auth-reset-account-state.test.ts`, `session-proof-invalidation.test.ts`,
   `settings-state-g-unverified-email.test.ts`, `settings.test.ts`, and
   `tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`.
6. No new error code, response string or status. No emdash. No new writer of
   `accounts.updated_at`.

## Notes

- Land in one pass with `backend-reset-tokens-outlive-email-changes-and-recovery`. It edits the
  same two `recover.ts` UPDATEs (the `reset_token` clear) and the `POST /reset` UPDATE's predicate
  (its Scope item 3). `backend-reset-response-names-the-account` edits the same `POST /reset`
  handler's success data. Neither task closes this path: the reset-token one needs mailbox control
  or a pre-issued reset token, while this one needs only the password.
- Account-state check: `pending_email_*` is an overlay in ARCHITECTURE.md § 6.1, and clearing it
  changes no state dimension. Reset reaches A, B, D and G rows with a password, plus E rows and
  email-path F rows. E and F rows never carry a triple (`POST /api/settings/email` finds rows by
  username), so the clear is a no-op there.
- Accepted cost: a change the owner queued before their own recovery or reset is dropped. The
  owner re-requests it.
- Residuals, not proposed:
  - The owner is not told when a change is queued.
  - A change request already in flight can race the eviction. The window is server-side only and
    the attacker cannot stretch it.
- The custody upgrade path was not measured, because it needs on-chain keys. Its description
  above comes from code reading.
- Same statement family, different defect: both recovery paths check the new address against
  `accounts.email` only, not against other rows' `pending_email`. Filed in
  `backend-email-change-swap-500s-on-a-taken-address`.

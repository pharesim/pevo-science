# Stamp when an address was installed, and tell the displaced address when a settings change applies

**Owner:** backend
**Created:** 2026-10-08
**Priority:** high

Filed from `architect-email-change-owner-notice-and-dispute-race` (decided with the user
2026-10-08, "as recommended"). Design: ARCHITECTURE.md § 6.3, the paragraphs decided 2026-10-08.
This task is the first slice; the hold task (`backend-email-change-hold-and-owner-notice`) and
the settled-address task (`backend-recovery-dispute-only-for-a-settled-address`) build on its
column.

## Why

The change-flow swap in `GET /api/settings/email/verify/:token` overwrites `accounts.email` in
place and tells the previous address nothing, and nothing records when an address was installed,
so no later rule can tell a fresh address from a settled one. A party holding only the password
can therefore move the mailbox that reset mail goes to without the owner learning of it. This
task adds the recency column, stamps it in the three statements that install an address on a
finalized row, and mails the displaced address once when the settings swap applies.

## Scope

1. A migration adds `accounts.email_changed_at TIMESTAMPTZ` (nullable, no default, no backfill)
   with a column comment saying NULL means no settings change apply, seed-phrase recovery apply
   or ORCID recovery has installed an address on the row since it was finalized. Record it in
   `schema_migrations` as the existing migrations do; take the next free number (another
   pending task, `backend-reset-token-lookup-has-no-index`, also adds a migration; whichever lands
   second renumbers).
2. Three statements set `email_changed_at = NOW()` in the UPDATE that writes `email`: the
   change-flow swap in `GET /api/settings/email/verify/:token`, the ORCID-recovery UPDATE in
   `POST /api/auth/recover`, and the apply UPDATE in `POST /api/auth/recover/verify`. No other
   statement writes the column. `updated_at` is not written.
3. `emailDomain` is exported from `backend/src/lib/log-pii.ts` beside `maskEmail`, keeping its
   placeholder for malformed input, and `recover.ts` imports it from there.
4. After the change-flow swap has written the row and after the `notification_preferences`
   move, as the last step of the handler before its response, the handler mails the address the
   row held before the swap when that address is non-null. Subject
   `PEvO - Your email address was changed`. The body names the new address by its domain only,
   says no action is needed if the account holder made the change, and otherwise says someone
   else can act on the account, that password reset mail now goes to the new address, that the
   owner should open PEvO and use the account recovery page with their recovery phrase, and that
   a self-custody account signs in with Hive Keychain and sets the address back under Settings.
   The body carries no link, no token and no username, contains no emdash, and ends with the
   footer the other mails use.
5. The send runs only when `config.smtpHost` is set, inside its own try/catch. A failed send is
   logged once as a warn, with the previous address only through `hashEmailForLogs`. In every
   case the row and the response are unchanged. The send does not reuse the verification mail's
   throw-on-unconfigured helper: the verify route's outer catch answers 500 and several suites
   run with SMTP unconfigured.
6. Tests under the mocked-transporter carve-out, with the header justification: the change-flow
   verify sends exactly one mail, to the previous address, whose text contains the new address's
   domain and not its local part, and stamps `email_changed_at`; no mail when the row had no
   email; a throwing `sendMail` still answers 200 with the row swapped; the two recovery UPDATEs
   stamp the column (in the two-phase recovery suite and the recovery suite). Specs that count
   `sendMail` calls across a change swap gain one call.

## Acceptance criteria

1. After `GET /api/settings/email/verify/:token` applies a change on real Postgres,
   `accounts.email_changed_at` is not NULL and the previous address has received one mail that
   names only the domain of the new address.
2. After `POST /api/auth/recover` on the ORCID path and after `POST /api/auth/recover/verify`,
   `email_changed_at` is not NULL.
3. A row whose address was never installed by those three writers has `email_changed_at` NULL
   after signup finalize, the settings add flow, the re-issue branch, a password reset and the
   custody upgrade.
4. The verify route's response is byte-identical with SMTP configured, unconfigured and failing.
5. `backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts` stays
   green; the backend suite is green apart from the standing pre-existing failures.

## Notes

- The swap UPDATE is co-edited by `backend-email-change-moves-other-users-digest-address` (high)
  and `backend-email-change-swap-500s-on-a-taken-address` (normal); the apply transaction by
  `backend-recovery-verify-consume-is-not-atomic` (low). Whichever lands second merges one
  SET-list line.
- Leave a `[TODO Architect]` in the signal block for `api-contracts/settings.md` if the mail's
  wording differs from the contract's description.
- Account-state check: the three writers reach finalized rows only (A, B, C, D and G per § 6.1);
  the column is an overlay, so no state dimension changes.

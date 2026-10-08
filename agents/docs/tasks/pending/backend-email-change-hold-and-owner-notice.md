# Hold a password-proven email change 72 hours and tell the current address

**Owner:** backend
**Created:** 2026-10-08
**Priority:** high

Filed from `architect-email-change-owner-notice-and-dispute-race` (decided with the user
2026-10-08, "as recommended"). Design: ARCHITECTURE.md § 6.3 (the paragraphs decided
2026-10-08) and § 6.4 "Change email" and "Cancel a queued email change"; contract:
`api-contracts/settings.md`. Picked after `backend-email-changed-at-stamp-and-displaced-address-notice`
(its column and its apply-time mail) and after `backend-password-reset-link-has-no-page` is
archived (the notice sends the owner to Forgot password, whose mailed link opens the home page
until that task lands). Not sequenced behind the mailbox-confirmed ORCID link task: see Notes.

## Why

On the JWT path a password proof queues an email change and the mailed link applies it in the
same request, with nothing sent to the current address; the password reset that follows evicts
the owner. The password is both the login factor and the re-auth factor on states A and B, so
the fresh-auth gate adds no second factor against a party who knows it. Holding a password-proven
change for 72 hours and telling the current address keeps `accounts.email` the owner's while the
owner's own password reset, which already drops the queued change and revokes every session,
still reaches them. There is no mailed cancel link: a link that applies on open is read after a
script has used it, and the reset does strictly more than a cancel.

## Scope

1. A migration adds `accounts.pending_email_hold_until TIMESTAMPTZ` and
   `accounts.pending_email_confirmed_at TIMESTAMPTZ`, both nullable, no backfill.
   `PASSWORD_ACTION_HOLD_MS` (72 hours) is exported from `backend/src/lib/account-holds.ts`.
2. In the change branch of `POST /api/settings/email`, after the fresh-auth gate and the
   duplicate checks: a new address equal to the row's current email is refused with 400
   `VALIDATION_ERROR` `This is already the email address on this account.`; a request whose proof
   would be held (JWT path, mechanism `password`, row email non-null) while a change with no hold
   is queued (`pending_email` set and `pending_email_hold_until` NULL) is refused with 409 and a
   new `ErrorCode` `PENDING_CHANGE`, message
   `Another email change is already queued and cannot be replaced with this proof.`
3. The change is held when the request is on the JWT path, the consumed proof's mechanism is
   `password`, and the row's email is non-null. The change UPDATE writes
   `pending_email_hold_until` as the request time plus the hold when held and NULL otherwise, and
   `pending_email_confirmed_at = NULL`, with the triple it writes today. The verify token and the
   confirmation mail to the new address are unchanged and are sent first; their failure keeps
   today's restore and uniform 200, with the restore's snapshot extended to the two new columns.
4. When held, after the verification mail was handed over, a notice goes to the row's current
   address in its own try/catch. Subject `PEvO - Email change requested`. It names the new
   address in masked form (`maskEmail`) and by domain (`emailDomain`), carries no link, and says:
   the request was made from a signed-in session using the account password; no action is needed
   if the account holder made it; the change takes effect no earlier than 72 hours after the
   request and only once the new address has confirmed; until then password reset mail still
   goes to this address; if it was not them, someone knows their password, they should reset it
   now from the sign-in page's Forgot password option choosing a password that differs from the
   current one, and resetting it stops the change and signs the account out everywhere; and that
   someone sharing the mailbox should check with the account holder before resetting. A failed
   notice send is logged once as a warn with the current address through `hashEmailForLogs`; the
   change stays queued and held and the response is unchanged.
5. A second limiter named `settings-email-action`, keyed by account, 5 per hour, with failed
   requests refunded, runs on `POST /email` and on `DELETE /email` after `verifyHiveSignature` and
   after a body-shape check that does not rewrite `req.body` (the signature path hashes the body);
   the existing IP limiter stays first. See
   `agents/docs/solutions/conventions/account-keyed-limiter-after-auth-validator-before-limiter.md`.
6. The change branch of `GET /api/settings/email/verify/:token` is split into an exported apply
   function and a confirm branch. A row whose `pending_email_confirmed_at` is set answers
   `{ verified: true, applied: false }` while the hold runs and applies once it has ended, without
   consulting the token's expiry. Otherwise, after the existing expiry check: when
   `pending_email_hold_until` is NULL or has passed, the apply function runs and the route answers
   `{ verified: true, applied: true }`; else the route records `pending_email_confirmed_at` with
   an UPDATE keyed on id and token (rowCount 0 answers the unknown-token 400) and answers
   `{ verified: true, applied: false }`. The add flow answers `{ verified: true, applied: true }`.
   The apply function keys on id and `pending_email_token`, stamps `email_changed_at`, clears the
   five pending-email columns, `verify_token`, `expires_at` and the reset token pair, handles a
   23505 on `accounts_email_key` by clearing the five columns with the same key and returning a
   collided outcome (which the verify route maps to the 409 the swap-500 task prescribes and the
   sweep treats as done), then runs the `notification_preferences` move and, last, the
   displaced-address mail. It is the one site that swaps the address.
7. A sweep in `backend/src/jobs/account-holds-sweep.ts` with a first pass at boot and a 5-minute
   tick, timer unref'd, in the shape of the `pending_recovery` purge: it applies every row whose
   `pending_email_confirmed_at` is set and whose hold has ended, one row at a time, one row's
   failure not stopping the next; and clears the five pending-email columns on every row whose
   `pending_email_confirmed_at` is NULL and whose `pending_email_expires_at` has passed. Single
   instance, no lock.
8. `POST /api/auth/reset`, the ORCID-recovery UPDATE and the seed-phrase apply UPDATE set the two
   new columns to NULL where they set the triple to NULL; the unverified-G re-issue branch and
   the SMTP-fail restore write them too. The custody upgrade clears the five pending-email
   columns in its UPDATE (user decision 2026-10-08; ARCHITECTURE.md § 6.3 "Evictions").
9. `GET /api/settings/email` reports `pendingChange` true only while `pending_email` is set and
   either the change is confirmed or its verify token is unexpired, and adds `pendingEmailChange`:
   null, or `{ email, confirmed, effectiveAt }` with the pending address masked and `effectiveAt`
   null on a change with no hold.
10. New `POST /api/settings/email/cancel-change` behind the write limiter and
    `verifyHiveSignature`: the JWT path consumes a proof bound to the change-email target with the
    same mechanism check `POST /email` applies; the Hive-signature path needs no body proof. A
    proof that would be held clears the five columns only where `pending_email_hold_until` is set
    and answers 409 `PENDING_CHANGE`
    `This email change was queued with a stronger proof and cannot be cancelled with this one.`
    when the queued change carries no hold; any other accepted proof or the signature path clears
    whatever is queued. Answers 200 `{ cancelled: true }` whether or not a change was queued;
    sends no mail and writes no audit row.
11. The sentence in the `changeEmailFreshAuthTarget` docblock in `backend/src/lib/fresh-auth.ts`
    that says the issuance side is tracked separately as a follow-up is deleted; both issuers are
    live.
12. Tests on real routes with the transporter mocked under the carve-out, naming the recovery
    suite as the real-SMTP companion: a password-proven change on a state A and a state B row
    writes the hold, sends two mails (the second to the current address, naming the masked new
    address and its domain, with no link), and its verify link answers `applied: false` and leaves
    `accounts.email` unchanged; re-opening that link after the token's expiry but inside the hold
    answers `applied: false` again; a change on a real Hive-signature-path request on a
    self-custody row (D or G; a light row's signature will be refused as its re-auth proof by
    `backend-light-row-keychain-session-and-signature-proof`) and a change on a row with a NULL
    email send one mail and apply on the first open; a change proven by an ORCID proof on a B row
    applies on the first open; a request naming the row's own address answers 400 after a valid
    proof; a password-proven request against a queued ORCID-proven change answers the 409 and
    leaves the queued change; with the notice send throwing, the row keeps the held change and
    the response is byte-identical to success; with the verification send throwing, the overlay
    equals its prior values; the sweep applies a confirmed row whose hold ended (seeded by direct
    UPDATE), leaves the five columns NULL afterwards, clears an expired unconfirmed row, and
    clears a confirmed row whose address another row took (the apply's collided outcome); a
    re-queue never yields a hold earlier than the previous one and a confirmed-then-cancelled
    change is not applied by the sweep; each of the three evictions and the custody upgrade
    leave the two new columns NULL (extend the eviction suite); a session alone cannot cancel, a
    password proof cancels a held change and answers 409 against an ORCID-proven one, a
    Keychain-signed request on a self-custody row cancels either, and the cancel response is
    byte-identical with and without a queued change; the sixth successful `POST /api/settings/email`
    or `DELETE /api/settings/email` by one account within an hour answers 429 while failed
    requests do not count.

## Acceptance criteria

1. On a state A or B row with an email, a change requested with a password-mechanism proof is not
   applied by its verify link before 72 hours have passed since the request, and is applied by
   the sweep once they have.
2. A change requested with an ORCID proof, on the Hive-signature path, or on a row whose email is
   NULL applies on the click as before; a triple queued before the deploy (NULL hold) applies on
   the click; a password-proven request can neither replace nor cancel a queued change that
   carries no hold.
3. The current address receives one notice per held request, naming the masked new address and
   its domain and carrying no link; a failed notice send leaves the change queued; a failed
   verification send leaves no change queued; the route answers 200 in every case.
4. `POST /api/auth/reset` on the held row drops the change; `GET /api/settings/email` then
   reports no pending change and the old link answers as an unknown token.
5. After the sweep's apply, `email_changed_at` is set and the displaced address received the
   apply-time mail.
6. No `accounts.updated_at` write; no new log line on the success path; no emdash in any new
   string.

## Notes

- Landing order (user decision 2026-10-08): this task is not sequenced behind
  `backend-password-proven-orcid-link-completes-from-current-mailbox`. Until that task and
  `backend-orcid-link-and-accredit-require-fresh-auth` land, a password holder on an accredited
  state A row can still link an ORCID of their own and change the email with an ORCID proof,
  which carries no hold. Say so in the signal block; the architect records it as an interim
  residual in ARCHITECTURE.md § 6.3.
- `backend-email-change-moves-other-users-digest-address` (high) lands before this task or is
  merged into the apply function. Co-editors: `backend-reset-refuses-orcid-path-and-unverified-signup-rows`
  (the `/reset` UPDATE this task extends; whichever lands second merges one SET-list line),
  `backend-custody-row-gate-overclaim-and-upgrade-write-predicate` (the `/upgrade` UPDATE),
  `backend-email-change-swap-500s-on-a-taken-address` (its clear moves into the apply function;
  its acceptance 1 holds for changes with no hold and a sweep spec covers the held case),
  `backend-settings-email-status-reports-orcid` (adds `hasOrcid` to the same status response;
  whichever lands second merges).
- The e2e settings spec's password-path change must assert the held outcome; the ui task
  `ui-settings-shows-held-email-change-with-cancel` owns that edit and the SPA surfaces.
- Pre-deploy triples carry NULL in both new columns and apply on the click for up to 24 hours
  after the deploy, with no notice and no hold; a password-proven request answers the
  `PENDING_CHANGE` 409 against one until it expires. This is accepted.
- Account-state check: the hold branch reaches rows found by username with a password-mechanism
  proof, which the password issuer mints only for light rows (A and B per § 6.4); the new columns
  are overlays and change no state dimension.
- Leave a `[TODO Architect]` in the signal block for `api-contracts/settings.md` if any shape
  differs from the contract's "decided 2026-10-08" sections.

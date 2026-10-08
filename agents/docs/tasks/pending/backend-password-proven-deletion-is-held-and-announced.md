# Hold a password-proven deletion 72 hours and tell the current address

**Owner:** backend
**Created:** 2026-10-08
**Priority:** normal

Filed from `architect-email-change-owner-notice-and-dispute-race` (decided with the user
2026-10-08, "as recommended"). Design: ARCHITECTURE.md § 6.3 (the deletion paragraph decided
2026-10-08) and § 6.4 "Delete account data" and "Cancel a queued deletion"; contract:
`api-contracts/settings.md`. Picked after `backend-email-change-hold-and-owner-notice` (it
reuses that task's sweep, hold constant, account limiter and notice shape).

## Why

`DELETE /api/settings/email` with a password-minted proof erases the row, the server's only copy
of the posting and memo keys, the staged recovery and the preferences row, with no notice. For
an owner without the seed phrase there is no route back. Once the email change is held, deletion
is the destructive move left to a party holding only the password. Holding a password-proven
deletion 72 hours and telling the current address gives the owner the same stop the email change
has: the password reset. The hold is fail-open because an owner who lost the old mailbox must
still be able to exercise erasure with the password.

## Scope

1. A migration adds `accounts.pending_delete_at TIMESTAMPTZ`, nullable, no backfill.
2. On the JWT path with a password-mechanism proof on a row whose email is non-null, the handler
   does not run the delete transaction: it writes `pending_delete_at` as the request time plus
   `PASSWORD_ACTION_HOLD_MS`, mails the current address a linkless notice in its own try/catch
   (subject `PEvO - Account deletion requested`; the request was made from a signed-in session
   using the account password; no action is needed if the account holder made it; the deletion
   takes effect no earlier than 72 hours after the request; otherwise someone knows their
   password and they should reset it now, choosing a password that differs from the current one,
   which stops the deletion and signs the account out everywhere; someone sharing the mailbox
   should check with the account holder first), and answers 200
   `{ deleted: false, effectiveAt }`. A failed send is logged once with the address through
   `hashEmailForLogs` and the deletion stays queued. The route runs under the
   `settings-email-action` account limiter the hold task mounts, so change and deletion requests
   together are bounded to five per account per hour.
3. ORCID-proof, Hive-signature and NULL-email deletions run the transaction at once and answer
   `{ deleted: true }` as today. The delete transaction is exported and the sweep runs it for
   every row whose `pending_delete_at` has passed, one row at a time.
4. New `POST /api/settings/email/cancel-delete` behind the write limiter and
   `verifyHiveSignature`: the JWT path consumes a proof bound to the delete-account target with
   the same mechanism check `DELETE /email` applies; the signature path needs no body proof; the
   handler sets `pending_delete_at = NULL` by username and answers 200 `{ cancelled: true }`
   whether or not a deletion was queued; no mail, no audit row.
5. `POST /api/auth/reset`, the ORCID-recovery UPDATE, the seed-phrase apply UPDATE and the
   custody upgrade set `pending_delete_at = NULL`. `GET /api/settings/email` adds
   `pendingDeletion`: null or `{ effectiveAt }`.
6. Tests on real routes under the carve-out (the fixture
   `backend/tests/routes/settings-email-delete-fresh-auth.test.ts` drives the JWT-path proof
   today): a password-proven deletion on an A and a B row leaves the row in place, writes the
   hold, sends one notice to the current address with no link, and answers `deleted: false`; the
   sweep deletes the row once the hold has passed (seeded by direct UPDATE) with the
   transaction's audit and anonymization effects; a reset drops the queued deletion; a
   Keychain-signed deletion on a self-custody row and an ORCID-proven deletion delete at once;
   cancel with a password proof and with a signature clears the hold and answers the same with
   and without one queued.

## Acceptance criteria

1. No row is deleted on a password-proven request before 72 hours have passed; the sweep deletes
   it afterwards unless the hold was cleared.
2. The current address receives one notice per held request; a failed send leaves the deletion
   queued; the response is 200 in every case.
3. Erasure by ORCID proof, by Keychain or on a NULL-email row is unchanged; no emdash.

## Notes

- The response shape change needs `ui-settings-shows-held-deletion-with-cancel` in the same
  deploy, or the SPA shows its deleted state for a queued deletion. Say in the signal block when
  the ui task can be unblocked.
- `ui-delete-account-control-for-rows-without-email` (normal) edits the same settings delete
  control; the ui task above merges with it.
- The erasure timeline lengthens by at most 72 hours plus a sweep tick for password-proven
  requests, which the obligation to act without undue delay permits; any other proof deletes at
  once.
- Leave a `[TODO Architect]` in the signal block for `api-contracts/settings.md` if any shape
  differs from the contract's "decided 2026-10-08" sections.

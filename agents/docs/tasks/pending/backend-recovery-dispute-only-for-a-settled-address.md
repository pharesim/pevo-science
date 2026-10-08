# Seed-phrase phase 1 mails the dispute link only to a settled address

**Owner:** backend
**Created:** 2026-10-08
**Priority:** high

Filed from `architect-email-change-owner-notice-and-dispute-race` (decided with the user
2026-10-08, "as recommended"). Design: ARCHITECTURE.md § 6.3 (the `email_changed_at` paragraph
decided 2026-10-08) and § 6.4 "Recover (lost email access, seed-phrase path)". Picked after
`backend-email-changed-at-stamp-and-displaced-address-notice` has landed its migration.

## Why

Seed-phrase phase 1 (`POST /api/auth/recover`, memo-key branch) mails the dispute link to
whatever `accounts.email` holds at staging time, and phase 2 refuses a disputed row. After a
password holder swaps the address, they can stop the owner's recovery as often as it is
re-staged: the owner's confirm needs a click on a page, the dispute needs one POST a script can
send when the mail arrives. With `email_changed_at` on the row, phase 1 can withhold the dispute
link from an address the row has held for less than 30 days. The seed-phrase-holder convention
(`agents/docs/solutions/conventions/recovery-defenses-vs-seed-phrase-holder-non-load-bearing-2026-05-25.md`)
treats the dispute as non-load-bearing against a seed-phrase holder; this attacker holds the
password, the case that convention names as the one where platform-side defences are the only
defences.

## Scope

1. A new module `backend/src/lib/address-settling.ts` exports `SETTLED_ADDRESS_AGE_MS` (30 days)
   and `isAddressSettled(emailChangedAt: Date | null, now: Date): boolean`, true when the stamp
   is NULL or at least that old. It is the one place the rule lives; the mailbox-confirmed ORCID
   link task reads it too.
2. `POST /api/auth/recover` (memo-key branch) reads `email_changed_at` with the account row and
   mails the dispute link only when the row's email is non-null and the address is settled. When
   it is not: no dispute mail and no log line; the staging row, its dispute token digest, the
   verify mail to the new address and the 200 body are exactly as before.
3. `POST /api/auth/recover/verify` and `POST /api/auth/recover/dispute` are not changed. A
   dispute token that was mailed still voids an unapplied staged swap.
4. Tests in the two-phase recovery suite under its existing carve-out header: a row stamped one
   day in the past gets exactly one mail, to the new address, and phase 2 applies; a row stamped
   31 days in the past gets both mails and a dispute still makes phase 2 refuse; a row with a
   NULL stamp gets both mails; the phase-1 body is identical across the three. The suite's
   per-test baseline reset sets `email_changed_at` to NULL explicitly, because an earlier spec's
   phase-2 apply stamps it. The age-gate specs seed the stamp by direct UPDATE.

## Acceptance criteria

1. Phase 1 on a finalized row whose `email_changed_at` is within the last 30 days sends one mail;
   on a row stamped earlier, or NULL, it sends two.
2. The phase-1 200 body is byte-identical in both cases.
3. A dispute token that was mailed still voids an unapplied staged swap; the existing dispute
   specs pass unchanged on rows whose stamp is NULL.
4. The backend suite is green apart from the standing pre-existing failures.

## Notes

- `backend-signup-email-address-list` (high) edits `RecoverBodySchema.new_email` in the same
  file; whichever lands second merges.
- `backend-recovery-verify-consume-is-not-atomic` and
  `backend-recovery-dispute-message-claims-no-change` are unaffected.
- `architect-orcid-path-signup-holds-an-unproven-address` may later conjoin a proof marker with
  the settled predicate; the module is the one place to do it.
- Leave a `[TODO Architect]` in the signal block for `api-contracts/auth.md` if the behaviour
  differs from what the contract's "decided 2026-10-08" sentences say.

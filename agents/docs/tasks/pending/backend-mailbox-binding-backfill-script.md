# Operator script: bind the light accounts whose mailbox is already on file

**Owner:** backend
**Created:** 2026-10-06
**Priority:** normal

Filed from `architect-accreditation-mailbox-binding-design` (decision with the user, 2026-10-06:
light accounts on file are put on the list at rollout; accounts accredited through the
accreditation page are left until their mailbox is next verified). Design: `ARCHITECTURE.md` § 2
"Credential Bindings", "Rollout".

## Why

Ten email accreditations exist on chain before the registry. The ones made through light-account
signup can be matched deterministically: that path's `evidence_hash` is
`sha256(accounts.email + ':' + username + ':' + ('signup' | 'link'))`, and an op whose `orcid`
is absent or empty came from the email path, whose address the signup link verified (the finalize
writes `orcid: ""` when there is none). The ones made
through `POST /api/accreditation/request` cannot be matched: the address was never stored.

## Scope

1. `backend/scripts/bind-existing-mailboxes.ts` (or `.sql` plus a node step), run by the operator
   once, never a migration (one-time data work is an operator script, per the locked-row repair
   precedent in `ARCHITECTURE.md`). For every finalized account row with an e-mail: find its
   earliest authority `accredit` op on HAF; if the op's `orcid` is absent or empty and its
   `evidence_hash` equals the hash of the row's current e-mail, insert a `bound` row in
   `mailbox_bindings` with the shared canonical key (`backend-mailbox-binding-registry`), skipping
   mailboxes that already have a live row. Where several matching accounts fold to one canonical
   key, bind the one with the earliest `accredit` op and list the others in the output.
2. Dry-run mode that prints, per row, the account and whether it matches, without writing; the
   write mode prints the accounts bound. The operator mails those holders a notice that states the
   purpose and the legitimate interest before running the write mode (the notice text is the
   architect's, in the privacy task).
3. The script is idempotent and refuses to run when `MAILBOX_BINDING_KEY` is unset.

## Out of scope

- Accounts whose address is not on file (left unbound by decision).
- Any re-verification mail to holders.

## Sequencing

After `backend-mailbox-binding-registry`.

## Acceptance criteria

1. On a database with one mail-proven signup account, one ORCID-path signup account and one
   page-accredited Keychain account, the dry run names exactly the first as a match and the write
   mode binds exactly it.
2. Running twice inserts nothing new.
3. Test against the real app database and real HAF.

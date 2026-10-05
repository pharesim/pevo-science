# Decide how an institutional mailbox is bound to one accredited account

**Owner:** architect
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit (finding 3). Two reviewers reported it and the
validator confirmed it from the code. The user chose a design task over accepting it for beta
(2026-10-05).

## Why

`POST /api/accreditation/request` checks an address only with `isInstitutionalEmail`, behind a
limiter keyed on the Hive account. `POST /api/accreditation/verify` never looks up earlier use of
the address: `evidence_hash` is salted with the token, so two accreditations from one mailbox
share no value on chain, and nothing in the app database records the address. A sanction is keyed
on the Hive username.

So one mailbox can accredit any number of Hive accounts, and a sanctioned researcher can accredit
a fresh account from the same mailbox. Every accredited account can vouch, and the threshold
number of vouches (3 by default) enrolls an account in the Web of Trust, so the WoT is only as
strong as this binding.

## Questions to settle

1. **The rule.** Does one verified mailbox back at most one accredited account at a time? Does a
   sanctioned account's mailbox stay bound, so that its holder cannot accredit another account?
2. **Where the binding lives.** An app-database table keyed by an HMAC of the normalised address
   needs a migration and is not reconstructible from the chain, which sits against design
   principles 2 and 6. A value on chain is public and linkable, which sits against principle 5.
   Name the trade and choose.
3. **Normalisation.** Case, plus-addressing, and subdomain variants of one institution.
4. **Rebinding.** A researcher who lost their keys, or who moves to another account.
5. **Other entry points.** Light-account signup already refuses a duplicate `accounts.email`. How
   do the signup-verify accredit path and the settings email add flow relate to the binding?
6. **Existing accreditations.** Past `evidence_hash` values cannot be compared, so the binding
   can only apply from its rollout on, apart from addresses the `accounts` table already holds.
7. **Enforcement points.** A refusal at `/request` is cheap; the check at `/verify` is the
   authoritative one and has to hold when two verifications race.

## Deliverable

Work the questions through with the user (`/ce-brainstorm`). Record the decisions in
`ARCHITECTURE.md` § 2 and file the implementation tasks with their priorities. A schema change
needs the user's explicit approval before any task is filed.

## Related

`backend-accreditation-verify-requires-the-account-session` makes a verification show control of
both mailbox and account. It does not limit how many accounts one mailbox can accredit.

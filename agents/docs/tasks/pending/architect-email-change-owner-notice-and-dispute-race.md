# Decide how an owner learns of an email change, and who wins the seed-phrase dispute race

**Owner:** architect
**Created:** 2026-10-07
**Priority:** high

Filed from the architect review of `backend-recovery-and-reset-keep-a-queued-email-change` (its
adversarial lens). That task makes the evictions drop a queued change; this one covers an attacker
who completes the change before any eviction. Design task: brainstorm with the user, then file
implementer tasks.

## Why

Someone holding only the password can log in, take a `change_email` fresh-auth proof with that
password, queue a change to their own address through `POST /api/settings/email`, and click the
link at once. The change mail goes only to the new address, so the owner is not told.
`accounts.email` is now the attacker's.

- Password reset mails the attacker.
- A B owner gets the account back through ORCID recovery, which overwrites the email
  (`backend-orcid-link-and-accredit-require-fresh-auth` stops the attacker replacing that ORCID).
- An A owner has only seed-phrase recovery. Phase 1 (`POST /api/auth/recover`) mails the dispute
  link to the row's current email, which is the attacker's. `POST /api/auth/recover/verify`
  refuses a staging row the attacker disputed. There is no waiting period, so the owner wins only
  by clicking the verify link before the attacker clicks the dispute link. A dispute after the
  apply only marks the staging row. A script that clicks the dispute link as soon as the mail
  arrives can beat the owner.

## To decide

1. Whether to mail the current address when a change is queued, with a cancel link, and whether
   the swap waits before it applies.
2. Who the dispute link goes to after a recent email change, or whether a dispute can void a
   seed-phrase recovery at all when the current address is that recent.
3. Or accept: holding the password is holding the account.

Record the decision in ARCHITECTURE.md § 6.3/§ 6.4 and file the implementer tasks.

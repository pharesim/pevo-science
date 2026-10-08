# An ORCID-path signup can hold an address its owner never gave

**Owner:** architect
**Created:** 2026-10-07
**Priority:** normal

Filed at the architect review of `backend-signup-verify-requires-the-signup-password` (archived
2026-10-07). This came from the architect's own reading of `routes/auth.ts` while checking the
security reviewer's finding; no reviewer raised it and nothing was probed. User triage: "as
recommended".

## Why

The ORCID branch of `POST /api/auth/signup` writes the submitted address to a row F without
mailing it ("ORCID signups skip email verification", `routes/auth.ts`), and `accounts.email` is
unique (the upserts' `ON CONFLICT (email)`). So anyone whose ORCID passes the works check can put
someone else's address on a pending row. The address owner's own `/signup` then answers 409
"Email already verified. Please log in to continue." while the row is pending. Signup cleanup
reaps a row F by `created_at` after 30 days (measured in `backend-orcid-path-f-resume`). Once the
holder finalizes, the owner gets "Email already registered" for good. The eviction `/signup`
performs reaches only a factor-less unverified state G row, so it never frees these rows.
ARCHITECTURE.md already says ORCID-path signups create no mailbox binding because their address
was never proven. Nothing says such an address may keep its owner out.

## Scope

1. Have the backend measure first: an ORCID-path row F holding another person's address, pending
   and then finalized. Record the owner's answers at `/signup`, `/login`, `/reset-request` (after
   `backend-reset-refuses-orcid-path-and-unverified-signup-rows` lands) and the settings email
   flows, and which mails the holder's account later sends to that address.
2. Decide with the user, for example:
   - keep the address unproven and document the block;
   - mail a verification link before an ORCID-path address is stored, or store it as unverified
     and outside the unique claim until it is proven;
   - let the owner's own signup evict an unproven ORCID-path address, as it evicts a factor-less
     state G row.
3. Update ARCHITECTURE.md § 6.1 and § 6.3 and `api-contracts/auth.md`, and file the backend and
   UI tasks.

## Notes

- `backend-reset-refuses-orcid-path-and-unverified-signup-rows` closes the takeover through
  reset. This task is about the address block and the mail that goes to an address nobody proved.

## Architect note (2026-10-08)

ARCHITECTURE.md § 6.3 (decided 2026-10-08) defines a settled address by recency alone:
`email_changed_at` NULL or at least 30 days old, so an address an ORCID-path signup installed
without mailing it is settled at finalize and receives the seed-phrase dispute link. If this task
adds a proof marker, conjoin it in `isAddressSettled` (`backend/src/lib/address-settling.ts`,
from `backend-recovery-dispute-only-for-a-settled-address`), the one place the rule lives.

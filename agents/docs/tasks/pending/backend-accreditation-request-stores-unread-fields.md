# /request accepts an ORCID and stores a created_at that nothing reads

**Owner:** backend
**Created:** 2026-10-05
**Priority:** low

Filed from the accreditation and Web of Trust audit (finding 7). The validator confirmed it.

## Why

`POST /api/accreditation/request` accepts `orcid` (`accreditationRequestSchema` in
`backend/src/validation.ts`) and stores it, with a `created_at`, on the pending record
(`PendingAccreditation` in `backend/src/routes/accreditation.ts`). Nothing reads either field: the
accredit payload `/verify` builds has no `orcid`, and `getToken` only turns `created_at` back
into a `Date`. The email form has an ORCID input and sends its value, so a user who fills it in
has it dropped without a word.

A self-typed ORCID is unverified and must not be attested on chain. The ORCID button on the same
page is the verified path. So the fix is to stop accepting the field, not to forward it.

## Scope

1. Remove `orcid` from `accreditationRequestSchema`, from `PendingAccreditation`, and from the
   `/request` handler's destructure and record literal. `validate` parses with zod's default
   object mode, which drops unknown keys, so a client that still sends `orcid` keeps working.
2. Remove `created_at` from `PendingAccreditation`, from the record literal, and from the revival
   in `getToken`.
3. Update the test fixtures that seed either field.

## Out of scope

- The form's ORCID input (`ui-accreditation-email-form-orcid-input`). The two tasks can land in
  either order.

## Acceptance criteria

1. `/request` with an `orcid` in the body still answers 200, and the stored record has no `orcid`
   and no `created_at`.
2. The existing `/request` and `/verify` specs stay green.

## [TODO Architect] at archive

- Drop `orcid` from the `/request` body example in `api-contracts/accreditation.md`.

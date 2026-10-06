# A signup e-mail string holding two addresses passes the institutional check and mails the first

**Owner:** backend
**Created:** 2026-10-06
**Priority:** high

Found while grounding `architect-accreditation-mailbox-binding-design`; verified in-process on
2026-10-06 (nodemailer's address parser and `isInstitutionalEmail` were run on the string below).
Triage: user, "as recommended".

## Why

`SignupBodySchema` in `backend/src/routes/auth.ts` declares `email: z.string().optional()` with no
format check. The handler trims and lowercases the string and passes it to `isInstitutionalEmail`
(`backend/src/email-validator.ts`), which takes the domain after the LAST `@`. The string
`attacker@gmail.com x@mit.edu` therefore passes as `mit.edu`, is stored as `accounts.email`, and is
handed to nodemailer as `to`, whose parser reads it as the address `attacker@gmail.com` with the
display name `x@mit.edu`. The verification mail reaches a non-institutional mailbox, and the signup
finalize then accredits the account with `method: "email"`. The trust layer's institutional gate is
bypassed with a space.

## Scope

1. `SignupBodySchema.email` applies the same rule as `accreditationRequestSchema` (`z.string()
   .email().max(254)`: one addr-spec, ASCII, no whitespace) before the handler runs; a failing
   body answers 400 `BAD_REQUEST` as other schema failures do. The ORCID-direct branch, where the
   e-mail is optional, keeps `optional()` but applies the same rule to a supplied value.
2. `isInstitutionalEmail` refuses a string containing whitespace or more than one `@` regardless of
   its caller, so the gate does not depend on the schema.
3. The other e-mail intakes that lack the rule (`/resend-verification`, `/reset-request`,
   `RecoverBodySchema.new_email` max length, login) get the same format rule where they store or
   mail to the value; where a value is only a lookup key, matching an existing lowercased row is
   enough and no change is needed. List each in the signal block.
4. Comments follow root `CLAUDE.md` "Comment anchors".

## Acceptance criteria

1. `POST /api/auth/signup` with `attacker@gmail.com x@mit.edu` answers 400 and sends no mail; the
   same for a value with a comma or a quoted local part.
2. A well-formed institutional address signs up as before.
3. `isInstitutionalEmail('attacker@gmail.com x@mit.edu')` is false (unit test).
4. The existing signup specs stay green; no emdash in response text.

## [TODO Architect] at archive

- `api-contracts/auth.md`: `POST /api/auth/signup` gains the 400 for a malformed e-mail, and the
  `ACCREDITATION_NOT_FOUND` entry (the handler answers 422 `VALIDATION_ERROR` for a non-institutional
  address) is corrected.

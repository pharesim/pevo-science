# The accreditation mail does not say which account the link accredits

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit (finding 4, the part that needs no other
change first). The session requirement on `/verify` is a separate, sequenced task:
`backend-accreditation-verify-requires-the-account-session`.

## Why

The verification mail sent by `POST /api/accreditation/request` (the `sendMail` call in
`backend/src/routes/accreditation.ts`) greets the reader with the requester-supplied `full_name`
and carries the link. It does not name the Hive account the link accredits, and it does not say
that opening the link accredits an account at all. `full_name` is any 1 to 200 characters
(`accreditationRequestSchema` in `backend/src/validation.ts`), line breaks included, so the
requester writes up to 200 characters of the mail's opening.

A requester can enter someone else's institutional address and name. The recipient then gets a
mail that reads as their own pending accreditation, and opening the link accredits the
requester's account under the recipient's name.

## Scope

1. The mail body states:
   - the Hive account the request came from, written `@<hive_username>`;
   - that opening the link accredits that account on PEvO under the name and institution given
     in the request, and it shows both;
   - that a recipient who did not request this should ignore the mail and not open the link.

   This is user-facing text: no emdash.
2. `full_name` and `institution` then both appear in the mail, and both are broadcast on chain.
   Reject line breaks and other control characters in them in `accreditationRequestSchema`.
   `accreditationMetadataEditSchema` picks its field bounds from the same schema, so confirm the
   metadata edit inherits the rule and still accepts ordinary values.

## Out of scope

- Requiring a session on `/verify`, and the mail sentence that tells the reader to open the link
  while signed in. Both belong to the sequenced task named above.
- The request limiter (`backend-accreditation-limiters-refund-work-already-done`).

## Acceptance criteria

1. A spec pins that the mail body carries the requesting account, the name and the institution,
   and the ignore-if-not-yours sentence.
2. `/request` with a `full_name` or an `institution` that contains a line break answers 400
   `BAD_REQUEST` and sends no mail.
3. No emdash in the mail text. Comments follow root `CLAUDE.md` "Comment anchors".

# The verify, signup and request surfaces explain a mailbox that already backs another account

**Owner:** ui
**Created:** 2026-10-06
**Priority:** high

Filed from `architect-accreditation-mailbox-binding-design` (decisions with the user, 2026-10-06).
Design: `ARCHITECTURE.md` § 2 "Credential Bindings". Backend counterpart:
`backend-mailbox-binding-registry`, `backend-signup-finalize-claims-mailbox-binding`.

## Why

`frontend/src/pages/accreditation-verify.js` renders every non-retriable error as "Verification
Failed" with a "Request New Accreditation" button, has no branch for the existing 403
`ACCREDITATION_SANCTIONED`, and reads only `res.data.username` on success. A refusal because the
mailbox backs another account would show as a generic failure that invites another attempt. The
request form says nothing about what the address is used for, and the binding's legal basis needs
the purpose stated before the address is submitted.

## Scope

1. **Verify page:** a state for 409 `MAILBOX_ALREADY_BOUND`: the mailbox already backs
   `details.bound_to`; the way through is to sign in to that account and release its
   accreditation (link to the release surface once `ui-accreditation-release-flow` lands;
   until then "or contact PEvO"). No "Request New Accreditation" button in this state. While in
   this file: a state for 403 `ACCREDITATION_SANCTIONED` without that button either, and treat
   `AbortSignal.timeout`'s `TimeoutError` as retriable like the other network errors, since the
   backend keeps the token on a timeout.
2. **Signup finalize:** when `/confirm` or `/link` answers 409 `MAILBOX_ALREADY_BOUND` (no
   session), the signup-verify page says the account was created but not accredited because the
   mailbox already backs another account, with the same way through and a sign-in link; it must
   not suggest signing up again.
3. **Request form (`frontend/src/pages/accreditation.js`) and the signup form:** one sentence under
   the e-mail field naming the legitimate interest and the right to object: the address is used to
   verify an institutional affiliation and, to prevent abuse, to keep one accredited account per
   mailbox; a keyed hash of it is stored for that purpose and the holder can object; link to the
   privacy notice route. Nothing in the UI reveals whether an address is bound: the request answer
   is uniform by design and the explanation arrives by mail.
4. New strings in `en.json`, stubbed in all 15 other locales and recorded in `STUBS.md` per the
   convention; no emdash in UI copy.

## Out of scope

- The release action itself and the admin console (`ui-accreditation-release-flow`).
- The settings e-mail flows (they never bind).

## Acceptance criteria

1. A 409 `MAILBOX_ALREADY_BOUND` on `/verify` renders the bound-account state naming
   `details.bound_to`, with no re-request button; the sanction code renders its own state.
2. A `TimeoutError` from the verify POST lands in the retry state.
3. The finalize refusal renders the created-but-unaccredited explanation.
4. The request and signup forms carry the purpose sentence and the privacy link.
5. Unit tests for the new branches; E2E for the verify state against the real backend once the
   backend task is in.

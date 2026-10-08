# A password-proven ORCID link completes only from the settled current mailbox

**Owner:** backend
**Created:** 2026-10-08
**Priority:** high

Filed from `architect-email-change-owner-notice-and-dispute-race` (decided with the user
2026-10-08, "as recommended"). Design: ARCHITECTURE.md § 6.3 (the ORCID paragraph decided
2026-10-08) and § 6.4 "Link ORCID, and ORCID accreditation"; contract: `api-contracts/orcid.md`
"Password-proven link and accredit complete from the current mailbox" and
`POST /api/orcid/link/confirm`.

## Why

On a state A row an ORCID link proven by the password writes `accounts.orcid` and broadcasts an
accredit op in the callback, and nothing ever removes that ORCID: no eviction writes the column
and no unlink route exists. The planted ORCID then mints an ORCID change-email proof, which
carries no hold, and one-step ORCID recovery, which rewrites the email and password with no mail
to anyone. So a hold on password-proven email changes protects B rows only, unless the plant is
prevented. Completing a password-proven link only from a token mailed to the current address,
and only while that address is settled, keeps the password from adding a factor while the owner
holds the mailbox and keeps a party who just moved the mailbox from adding one for 30 days. The
link fails closed, unlike the email change, because a planted ORCID would be permanent.

## Scope

1. The `/orcid/start` state entry records the consumed proof's mechanism and the request's auth
   method (`backend-orcid-link-and-accredit-require-fresh-auth` consumes the proof there). When
   mode `link` or `accredit` was authorised on the JWT path by a password-mechanism proof and the
   row's email is non-null, `/orcid/start` and the callback refuse the request while
   `isAddressSettled(email_changed_at)` (from `backend/src/lib/address-settling.ts`) is false,
   with 422 `VALIDATION_ERROR`
   `An ORCID can be linked with the account password only once the email address has been on the account for 30 days.`
2. In that case, when the address is settled, the callback verifies the ORCID and runs the
   mode's gates (verified email, accreditation state, the never-replace refusal, the binding
   refusal, and for accredit the sanction and works gates) but does not run the binding-cache
   write, the broadcast or `updateAccountOrcid`. It stores the username, the ORCID iD, the mode
   and, for accredit, the works count and name in Redis under a key derived from a 32-byte random
   token with a 24-hour TTL, in the shape of the accreditation request's pending record,
   replacing any earlier record for the username; mails the current address a confirm link
   (subject `PEvO - Confirm linking an ORCID`, naming the ORCID iD, link
   `${config.appUrl}/settings/orcid-link?token=`) saying the request was made from a signed-in
   session using the account password, that the account holder should open the link and press
   the button, and that someone who did not request it should not open the link and should reset
   their password choosing a password that differs from the current one; and answers 200
   `{ mode, pending_confirmation: true, orcid, message: 'Confirm the link from your email address.' }`.
   An account-keyed limiter on this branch allows three confirm mails per hour per account,
   failures refunded.
3. New `POST /api/orcid/link/confirm` with the token in the body, no auth, a limiter of 10 per
   hour per IP counting every request: it consumes the record atomically, re-runs the mode's
   gates and the settled-address check, and runs the binding-cache write, the broadcast and
   `updateAccountOrcid` as the callback does today for that mode, answering the callback's
   success body. An unknown, expired or spent token answers one 400 `INVALID_TOKEN`.
4. ORCID-proof links, Hive-signature links and links on a row with no email complete in the
   callback as before.
5. Tests on real routes: a password-proven link on a settled row writes no `orcid` and broadcasts
   nothing until the confirm; the confirm completes it once and a second confirm answers 400; a
   never-replace refusal at confirm leaves the row unchanged; a password-proven link on a row
   stamped 10 days ago answers the 422 at `/orcid/start`; a signature-path link on a self-custody
   row completes in the callback. Recipe: real app pool, `broadcastAdminCustomJson` mocked as
   `backend/tests/routes/orcid-state-g-unverified-email.test.ts` does, and either a fixture
   username accredited on the test HAF or `getHafPool` mocked for the accreditation read under
   the carve-out with the header justification.

## Acceptance criteria

1. No write of `accounts.orcid` and no accredit broadcast happens on a password-proven link
   before the current mailbox's token is presented, and none happens while the current address
   is unsettled.
2. The confirm route performs every check the callback performs today and answers one 400 for
   every refused token.
3. No emdash in the mail or responses.

## Notes

- The confirm link is a query-string token; `backend-access-log-records-mailed-link-tokens`
  covers it under its query-parameter scope.
- `ui-orcid-link-confirm-page` (blocked behind this task) builds the page that sends the token
  from a button and the settings pending state; `ui-orcid-link-and-accredit-acquire-fresh-auth`
  (blocked) owns the proof acquisition on the same flow.
- Leave a `[TODO Architect]` in the signal block for `api-contracts/orcid.md` if any shape
  differs from the contract's "decided 2026-10-08" sections.

## [BLOCKED by Architect] (2026-10-08): sequenced behind the proof gate and the settling module

Waits for `backend-orcid-link-and-accredit-require-fresh-auth` (the proof consumed at
`/orcid/start`, whose mechanism this task branches on) and
`backend-recovery-dispute-only-for-a-settled-address` (the settling module) to be archived. The
architect moves this file to `pending/` when both are.

# /verify accredits the requester's account for whoever opens the link

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit (finding 4). Two reviewers reported it and
the validator confirmed it from the code. Incidence was not measured.

## Why

`POST /api/accreditation/verify` has no auth middleware. The token from the mail is its only
credential, and the handler accredits `pending.hive_username`, the account that made the request.
`POST /api/accreditation/request` accepts any institutional address from any signed-in account.
So a requester can name someone else's mailbox, and the accreditation completes when anyone with
access to that mailbox opens the link: the SPA's verify page posts the token on load. The
accredit op then carries the name and institution the requester typed.

**Decision (user, 2026-10-05):** `/verify` requires the session of the account the link was
requested for. A verification then shows that one party controls both the mailbox and the account.

## Scope

1. `POST /api/accreditation/verify` runs `verifyHiveSignature` first, then
   `validate(accreditationVerifySchema)`, then the limiter: the order `/request` uses.
   `verifyHiveSignature` accepts the session JWT or a request signature and sets
   `req.hiveUsername`.
2. Once the pending row is loaded, refuse with 403 `ACCREDITATION_ACCOUNT_MISMATCH` unless
   `req.hiveUsername === pending.hive_username`. The refusal sits before the admin-key check, the
   HAF reads and the broadcast-attempt claim, and it leaves the token, the counter and any
   completion record as they were. Message (user-facing, no emdash): "This verification link
   belongs to a different account. Sign in as that account and open the link again."
3. The grace-period branch (no pending row, completion record found) answers its cached 200 only
   when the record's `username` equals `req.hiveUsername`. Otherwise it answers the same 400
   `BAD_REQUEST` it gives when there is no record.
4. The mail body gains one sentence: open the link in a browser where you are signed in to PEvO
   as the named account. (Naming the account in the mail is
   `backend-accreditation-mail-names-the-account`.)
5. This change makes some comments in the handler false. Delete or narrow them, do not rewrite
   them longer. Known ones:
   - two logging comments call the token "the SOLE credential at /api/accreditation/verify";
     keep only the part that still holds, that the token must not be logged in plaintext;
   - the soft-block comment says requiring re-auth "was considered" and rejected for the verify
     landing page.

## Out of scope

- The verify page (`ui-accreditation-verify-page-signs-in-first`, which lands first).
- The limiters' refund sets (`backend-accreditation-limiters-refund-work-already-done`). With
  that task's lists, a 403 mismatch consumes a slot.

## Acceptance criteria

1. Without a session or signature the route answers 401 and reads no token.
2. A session for another account gets 403 `ACCREDITATION_ACCOUNT_MISMATCH`; the token still
   verifies afterwards for the right account.
3. A completion-record retry answers 200 for the record's account and 400 for any other.
4. For the right account, every existing `/verify` outcome is unchanged.
5. The specs whose focus is this authentication run the real `verifyHiveSignature` (root
   `CLAUDE.md` "Running Tests", carve-out clause (b)).
6. No emdash in response or mail text. Comments follow root `CLAUDE.md` "Comment anchors".

## [TODO Architect] at archive

- `api-contracts/accreditation.md`: `/verify` gains the auth headers, 401 and
  `ACCREDITATION_ACCOUNT_MISMATCH`.

## [BLOCKED by Architect] (2026-10-05) — sequenced behind the ui task

Waits for `ui-accreditation-verify-page-signs-in-first` to be archived. If this landed first, the
SPA's unauthenticated POST would answer 401 and the verify page would show its generic failure
state with a "Request New" button. The architect moves this file to `pending/` when the ui task
is archived.

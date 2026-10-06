# /request accepts a session alone, while the fields it sets need a fresh proof elsewhere

**Owner:** backend
**Created:** 2026-10-06
**Priority:** normal

Filed from the review of `backend-accreditation-verify-requires-the-account-session` (security
reviewer). User decision 2026-10-06: require a fresh re-auth proof on `/request` (option A).

## Why

`POST /api/accreditation/request` authenticates with `verifyHiveSignature` alone, so a bearer JWT
is enough. The request sets the `full_name` and `institution` the `accredit` op carries and names
the address the verification link goes to. Someone holding a stolen session for an account that is
not accredited can request accreditation for it, give an institutional mailbox they read, and open
the link in that session, which `/verify` accepts because the session belongs to the requesting
account. `PATCH /api/accreditation/metadata` changes the same two fields and requires a fresh-auth
proof on the JWT path. ARCHITECTURE.md § 6.4 now has a "Request accreditation" row with the
intended proof.

## Scope

1. A fresh-auth proof for action `request_accreditation`, target
   `(request_accreditation, <username>, '')`, can be minted wherever `edit_accreditation_metadata`
   can be minted today: the password path (`POST /api/custody/fresh-auth`) and the ORCID path
   (`mode='fresh_auth'`). Add a target helper next to `editAccreditationMetadataFreshAuthTarget`.
2. `/request` accepts an optional `fresh_auth_proof` in its body, with the bounds
   `accreditationMetadataEditSchema` uses.
3. The handler calls `consumeFreshAuthProof(req, <the new target helper>)`. On the signature path
   it passes without a proof, as on `/metadata`. Call it after the checks that can refuse a
   request without side effects, so a refused request does not burn the proof, and before the
   pending row is written or any mail is sent. A failed consume answers what `/metadata` answers
   (`FRESH_AUTH_REQUIRED`, status from `freshAuthFailureStatus`) and writes and sends nothing.
4. Every account state keeps a way to request (the § 6.4 row): light A and B with a password or
   ORCID proof, C with an ORCID proof, D and G with an ORCID proof on the JWT path or the Keychain
   signature path, and no-row Keychain on the signature path (no proof can be minted for an
   account without a row).

## Sequencing

Land this before `ui-accreditation-request-acquires-fresh-auth`, which needs the new action to
mint. Until that ui task lands, the request page's JWT-path POST answers `FRESH_AUTH_REQUIRED`,
so the two deploy together.

## Acceptance criteria

1. A JWT-path `/request` without a proof answers `FRESH_AUTH_REQUIRED`, writes no pending row and
   sends no mail.
2. With a valid `request_accreditation` proof, every existing `/request` outcome is unchanged.
3. A proof minted for another action or another account is refused (403), as on `/metadata`.
4. A signature-path `/request` needs no proof.
5. The specs whose focus is this gate run the real `verifyHiveSignature` and the real proof
   consume (root `CLAUDE.md` "Running Tests", carve-out clause (b)).
6. No emdash in response text. Comments follow root `CLAUDE.md` "Comment anchors".

## [TODO Architect] at archive

- `api-contracts/accreditation.md` `/request`: the `fresh_auth_proof` body field and the
  `FRESH_AUTH_REQUIRED` refusal.
- `api-contracts/custody.md` (`/fresh-auth`) and `api-contracts/orcid.md` (`mode='fresh_auth'`):
  `request_accreditation` in the action lists.

# The accreditation request page sends a fresh re-auth proof

**Owner:** ui
**Created:** 2026-10-06
**Priority:** normal

Filed from the review of `backend-accreditation-verify-requires-the-account-session`. User
decision 2026-10-06: `/request` requires a fresh re-auth proof (ARCHITECTURE.md § 6.4, "Request
accreditation" row). The backend half is `backend-accreditation-request-requires-fresh-auth`.

## Why

Once the backend half lands, a JWT-path `POST /api/accreditation/request` without a
`request_accreditation` proof answers `FRESH_AUTH_REQUIRED`. The request page
(`frontend/src/pages/accreditation.js`) submits through `requestAccreditation` in `api.js`, which
uses `authenticatedRequest` (always the bearer token) and sends no proof.

## Scope

1. Light accounts: acquire the proof the way the settings page's metadata edit does
   (`withSettingsFreshAuth` with action `request_accreditation`) and send it as
   `fresh_auth_proof`.
2. Self-custody accounts: § 6.4 gives D and G an ORCID proof on the JWT path, and gives D, G and
   no-row Keychain accounts the Keychain signature path. `withSettingsFreshAuth` sends no proof for
   a non-light custody, `authenticatedRequest` always sends the bearer token, and
   `consumeFreshAuthProof` requires a proof on every bearer-token request. Before copying the
   metadata edit's pattern, check what a Keychain user's metadata edit receives from the backend.
   If it is `FRESH_AUTH_REQUIRED`, say so in the signal block, and give the request page a path
   that works for these accounts.
3. A refused proof re-prompts instead of showing the generic failure. Cancelling the prompt sends
   nothing.

## Acceptance criteria

1. Every account state in the § 6.4 "Request accreditation" row can submit a request.
2. Cancelling the re-auth prompt sends no request.
3. No emdash in new UI copy.

## [BLOCKED by Architect] (2026-10-06): sequenced behind the backend task

Waits for `backend-accreditation-request-requires-fresh-auth` to be archived: until then the
issuance routes refuse `request_accreditation`. The architect moves this file to `pending/` when
that task is archived.

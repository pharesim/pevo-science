# The ORCID link and accredit flows send a fresh re-auth proof

**Owner:** ui
**Created:** 2026-10-07
**Priority:** high

Filed from the architect review of `backend-recovery-and-reset-keep-a-queued-email-change`. User
decision 2026-10-07: `POST /api/orcid/start` with mode `link` or `accredit` requires a fresh
re-auth proof (ARCHITECTURE.md § 6.4, "Link ORCID, and ORCID accreditation" row). The backend half
is `backend-orcid-link-and-accredit-require-fresh-auth`.

## Why

Once the backend half lands, a bearer-token `/orcid/start` for `link` or `accredit` without a
proof is refused. The settings page (`frontend/src/pages/settings.js`, mode `link`) and the
accreditation page (`frontend/src/pages/accreditation.js`, mode `accredit`) start the flow through
`startOrcid` in `api.js`, which uses `authenticatedRequest` (the bearer token) and sends no proof.

## Scope

1. Light accounts: acquire a `link_orcid` or `accredit_orcid` proof before calling `startOrcid`,
   the way the settings page acquires its other username-bound proofs, and send it in the body.
2. Self-custody accounts (G, D, and no-row Keychain): send the request on the Keychain signature
   path with no body proof, as `adminMutation` in `api.js` does for a non-light custody.
3. Cancelling the re-auth prompt starts no OAuth round trip. A refused proof re-prompts instead of
   showing the generic failure.
4. The backend's new 409 `ORCID_ALREADY_SET` gets its own message on both pages.

## Acceptance criteria

1. Every account state the § 6.4 row allows can still link or accredit.
2. Cancelling the prompt sends no request.
3. No emdash in new UI copy.

## [BLOCKED by Architect] (2026-10-07): sequenced behind the backend task

Waits for `backend-orcid-link-and-accredit-require-fresh-auth` to be archived: until then the
issuers refuse the two new actions. The architect moves this file to `pending/` when that task is
archived.

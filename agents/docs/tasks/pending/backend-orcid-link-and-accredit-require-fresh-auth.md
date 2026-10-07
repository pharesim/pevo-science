# ORCID link and accredit require a fresh re-auth proof and never replace an existing ORCID

**Owner:** backend
**Created:** 2026-10-07
**Priority:** high

Filed from the architect review of `backend-recovery-and-reset-keep-a-queued-email-change` (a
pre-existing finding of its security lens). User decision 2026-10-07: both modes that write
`accounts.orcid` require a fresh re-auth proof from a factor the account already has, and a row's
ORCID is never replaced by a different one (ARCHITECTURE.md § 6.4, "Link ORCID, and ORCID
accreditation" row). The SPA half is `ui-orcid-link-and-accredit-acquire-fresh-auth`.

## Why

`POST /api/orcid/start` accepts modes `link` and `accredit` on the session alone
(`authenticateRequest`). The callback's `handleLink` and `handleAccredit` then write the returned
ORCID through `updateAccountOrcid`:
`UPDATE accounts SET orcid = $1 WHERE username = $2 AND verify_token IS NULL`. The OAuth round
trip proves control of the ORCID being added, not of the account. ORCID login (`handleLogin`)
signs a session for the row that holds the ORCID, and ORCID recovery accepts it.

So someone holding the password, or a stolen session, can add an ORCID they control to an A row,
or replace the ORCID on a B row. None of the evictions (password reset, seed-phrase recovery,
ORCID recovery) writes `orcid`. After the owner evicts them, they log in with that ORCID or run
ORCID recovery and take the account back. On a B row whose ORCID was replaced, the owner's own
ORCID recovery answers `ORCID does not match account`.

## Scope

1. JWT path: `POST /api/orcid/start` with mode `link` or `accredit` requires a fresh-auth proof in
   the body, bound to the caller's username with target `(link_orcid, <username>, '')` or
   `(accredit_orcid, <username>, '')`. Follow the `request_accreditation` gate on
   `POST /api/accreditation/request`. Consume the proof at `/orcid/start`, before the OAuth round
   trip starts. A missing or refused proof gets the answers that gate gives; add no new code for
   it. The Keychain (Hive-signature) path needs no body proof.
2. The password issuer (`POST /api/custody/fresh-auth`) and the ORCID issuer
   (`mode='fresh_auth'`) mint both new actions under their existing account-state gates.
3. A row's `orcid` is never replaced by a different ORCID. `handleLink` and `handleAccredit` read
   the row before the broadcast and refuse a row that holds a different ORCID with a 409, code
   `ORCID_ALREADY_SET`, message "This account already has an ORCID linked." `/orcid/start` makes
   the same check early, so the user is not sent through the OAuth round trip only to be refused.
   `updateAccountOrcid` adds `AND (orcid IS NULL OR orcid = $1)`.
4. Account states, per § 6.1 and the § 6.4 row: an A row links with a password proof. A G or D row
   with no ORCID has no JWT-path proof (the password issuer refuses its claim and it has no
   ORCID), so it uses the Keychain path. No-row Keychain accounts write no row. Check each
   state your change reaches against § 6.1 and list the outcomes in the signal block.
5. Tests: real-path route specs for the proof requirement on both modes (missing proof refused, a
   proof bound to another action or user refused, a valid proof accepted) and for the different-ORCID
   refusal at both checks. Each must fail against the pre-change code.

## Acceptance criteria

1. A JWT-path `/orcid/start` for `link` or `accredit` without a valid proof for its action and
   username starts no OAuth round trip.
2. No path writes a different ORCID over a row's existing one.
3. The new 409 is the only new code or response string. No emdash.
4. The signal block lists the per-state outcomes and the API shape for
   `agents/docs/api-contracts/orcid.md` and `api-contracts/custody.md` (the new fresh-auth
   actions). [TODO Architect] at archive: update both contract files.

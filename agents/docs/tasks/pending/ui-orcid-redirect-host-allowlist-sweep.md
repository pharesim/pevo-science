# UI-ORCID-REDIRECT-HOST-ALLOWLIST-SWEEP — adopt the shared ORCID_REDIRECT_HOSTS constant everywhere

**Owner:** UI Agent
**Created:** 2026-06-09 (architect follow-up from the `ui-settings-action-fresh-auth-proof-challenge` re-review)
**Priority:** P3

## Problem

`ui-settings-action-fresh-auth-proof-challenge` introduced a shared `ORCID_REDIRECT_HOSTS` constant in
`frontend/src/lib/fresh-auth.js` (`['orcid.org', 'sandbox.orcid.org']`) — the open-redirect host
allowlist checked before navigating to an ORCID URL — and adopted it in `mintNonConsentProof` and
`beginSettingsActionOrcidFreshAuth`. Two other ORCID redirect flows still inline the same two-host
literal instead of the constant:

- `frontend/src/pages/settings.js` (`handleOrcidLink`, the ORCID account-linking flow).
- `frontend/src/pages/accreditation.js` (the accreditation ORCID flow).

Both check the same two hosts today, so this is NOT an active open-redirect — but it is the
"convention sweep missed semantic siblings in a different construct" failure mode
(`convention-sweep-syntactic-form-misses-semantic-siblings`): if `ORCID_REDIRECT_HOSTS` ever changes
(e.g. a new host), these two page-level guards silently drift from the lib policy. The original dedup's
stated rationale ("cannot drift from the session-auth flow's host policy") is not actually true until
these adopt the constant too.

## Goal

Export `ORCID_REDIRECT_HOSTS` from `frontend/src/lib/fresh-auth.js` and replace the inline
`['orcid.org', 'sandbox.orcid.org']` literals in `pages/settings.js` `handleOrcidLink` and
`pages/accreditation.js` with the constant, so every ORCID redirect-host check shares one allowlist.

## Acceptance

- `pages/settings.js` `handleOrcidLink` and `pages/accreditation.js` validate the ORCID redirect host
  against the imported `ORCID_REDIRECT_HOSTS`, not an inline literal.
- A grep for the inline two-host literal across `frontend/src/` returns no production hits (only the
  constant definition remains).
- No behavior change (same two hosts); existing ORCID-link / accreditation tests still pass.

## References

- `frontend/src/lib/fresh-auth.js` — `ORCID_REDIRECT_HOSTS` definition (export it).
- `frontend/src/pages/settings.js` `handleOrcidLink`, `frontend/src/pages/accreditation.js`.
- Convention: `agents/docs/solutions/conventions/convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md`.
- Origin: `ui-settings-action-fresh-auth-proof-challenge` hold item #2 (which targeted only
  `beginSettingsActionOrcidFreshAuth`).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

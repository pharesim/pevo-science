# UI-SETTINGS-ORCID-FACTOR-E2E — E2E coverage for the ORCID-factor settings critical actions

**Owner:** UI Agent
**Created:** 2026-06-09 (architect follow-up from the `ui-settings-action-fresh-auth-proof-challenge` re-review)
**Priority:** P3

## Problem

`ui-settings-action-fresh-auth-proof-challenge` wired the fresh-auth proof-challenge for the three
JWT-path critical settings actions across two factors (PASSWORD and ORCID). The E2E spec
(`frontend/tests/e2e/settings.spec.js`) drives only the PASSWORD factor (the change-email reauth-modal
test). The ORCID-factor settings path — `set_password` (passwordless target, ORCID-only) and the
passwordless fallback for `change_email` / `delete_account` — has thorough UNIT coverage
(`lib-fresh-auth-settings-orcid.test.js`, `lib-settings-fresh-auth.test.js`) but NO end-to-end coverage.

This is the clause-(c) real-path companion gap flagged in the parent task's re-review: the ORCID-factor
round-trip (`beginSettingsActionOrcidFreshAuth` → `/orcid/start?mode=fresh_auth` → ORCID →
`/orcid/callback` `_handleFreshAuth` → consent-op cache keyed `(action, username, '')` → settings action
resumes with the cached proof) is exercised only behind unit mocks. A regression in the callback dispatch
on `pevo_orcid_mode === 'fresh_auth'`, or in the cache-key shape, would ship green.

## Goal

Add an E2E spec that drives at least one ORCID-factor settings action end-to-end against the test-mode
stack: a passwordless (State-C) account performs `set_password` (or `delete_account`) via the ORCID
round-trip, and the action succeeds. Reuse the ORCID test-mode stubbing the other ORCID E2E specs use
(`orcid-link.spec.js` / `orcid-no-password.spec.js`).

## Acceptance

- A passwordless light account completes at least one settings critical action through the ORCID factor
  end-to-end in the test-mode stack (the full `/orcid/start` → `/orcid/callback` → cached-proof resume →
  action succeeds round-trip, not behind a unit mock).
- The consent-op cache key `(action, username, '')` round-trip is exercised against the real callback
  dispatch — the seam the unit tests mock out.
- Once landed, the `lib-fresh-auth-settings-orcid.test.js` clause-(c) header can cite a true real-path
  companion (described behaviorally; no task-slug in the comment).

## References

- `frontend/src/lib/settings-fresh-auth.js`, `frontend/src/lib/fresh-auth.js`
  (`beginSettingsActionOrcidFreshAuth`).
- `frontend/src/pages/orcid-callback.js` `_handleFreshAuth` — the `pevo_orcid_mode === 'fresh_auth'`
  dispatch + consent-op cache landing.
- `frontend/tests/e2e/settings.spec.js` (password-factor only today), `orcid-link.spec.js`,
  `orcid-no-password.spec.js` (ORCID test-mode patterns to reuse).
- Origin: `ui-settings-action-fresh-auth-proof-challenge` clause-(c) gap.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

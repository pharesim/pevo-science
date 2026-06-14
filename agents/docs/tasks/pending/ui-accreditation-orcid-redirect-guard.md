# UI-ACCREDITATION-ORCID-REDIRECT-GUARD — wire the bfcache redirect guard into accreditation.js (the 5th ORCID-redirect page)

**Owner:** ui
**Created:** 2026-06-14 (architect, split from the `/ce-code-review` of `ui-orcid-redirect-stuck-button`; correctness + adversarial + julik + maintainability all flagged it, P2)
**Priority:** P2 (real user-facing stuck-button on a live route; trivial fix — the mixin already exists)

## Problem

`ui-orcid-redirect-stuck-button` fixed the bfcache "stuck on Redirecting to ORCID"
bug on the four pages its scope table enumerated (signup, recover, login, settings)
by adding the shared `createOrcidRedirectGuard()` mixin
(`frontend/src/lib/orcid-redirect-guard.js`). But the "all four redirect-initiating
pages (verified)" enumeration was incomplete: `frontend/src/pages/accreditation.js`
is a FIFTH ORCID-redirect page with the byte-for-byte identical bug and was not
wired.

`accreditation.js` `handleOrcidVerify` sets `this.orcidLoading = true`, sets the
`pevo_orcid_mode` sessionStorage marker, then `window.location.href = data.redirect_url`,
and resets `orcidLoading` only in the `catch`. The button binds `:disabled` on
`orcidLoading` and shows the `orcid.redirecting` ("Redirecting to ORCID...") label.
On browser Back from ORCID the page is bfcache-restored (`init()`/`destroy()` do not
re-run), so the button stays frozen until a hard reload — the exact incident the
parent task fixed elsewhere. It is a live route: `orcid-callback.js` has a
`backPath = '/accreditation'` case, so the round-trip is real.

The page has `destroy()` and a `createTimerGuard()` today but NO `init()`.

## Goal

Wire the existing `createOrcidRedirectGuard('orcidLoading')` mixin into
`accreditation.js`, exactly as the four sibling pages do.

## Acceptance

- Spread `...createOrcidRedirectGuard('orcidLoading')` into the page's `Alpine.data()`
  state object.
- Add an `init()` (none exists today) that calls `this._installOrcidRedirectGuard()`.
  If other first-load setup belongs there, keep it minimal and additive.
- Call `this._teardownOrcidRedirectGuard()` from the existing `destroy()`.
- A unit test mirroring the other four pages: set `orcidLoading = true`, dispatch a
  synthetic `pageshow` with `persisted: true` (define `persisted` on the event —
  jsdom may not populate it), assert `orcidLoading` resets to `false`. Give it teeth
  (it should fail if the guard install is removed).
- No other behavior change.

## Cross-references

- `frontend/src/lib/orcid-redirect-guard.js` — the mixin to reuse (do NOT re-implement).
- The four wired siblings (signup.js / recover.js / login.js / settings.js) as the pattern; login.js is the closest analog (it also gained a new `init()`).
- The archived parent `ui-orcid-redirect-stuck-button` (see `agents/docs/tasks-archive.md`) for the bfcache root-cause writeup.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

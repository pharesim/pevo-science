# ORCID redirect button stuck on "Redirecting to ORCID" after browser Back (bfcache)

**Owner:** ui
**Created:** 2026-06-14

**Confirmed reproducible.** Click an ORCID button, get redirected to ORCID, then
press browser Back (e.g. because you could not log in at ORCID): the button is
restored **disabled** and frozen on its "Redirecting to ORCID..." loading label, and
stays that way until a hard reload. This was the actual cause of a real "ORCID signup
didn't work / redirection broke down" report (the user dead-ended at ORCID's login
page and hit Back).

## Root cause

Each ORCID-redirect handler sets a reactive loading flag to `true`, then does
`window.location.href = <ORCID redirect_url>`. The flag is reset to `false` **only
inside the handler's `catch`**. On the success path the page navigates to ORCID with
the flag still `true`. When the user returns via browser Back, the page is restored
from the back/forward cache (bfcache): Alpine `init()` does NOT re-run, `destroy()`
does NOT fire, and the `_mounted` / timer-guard does nothing here (the redirect
already navigated away before any async continuation ran). So the flag stays `true`
and the button stays `:disabled` on its loading label.

The unconditional `beforeunload` listener in `auth.js` does not reliably disable
bfcache in Chrome/Firefox, so the page stays bfcache-eligible and the bug reproduces.

## Scope — all four redirect-initiating pages (verified)

| Page | Loading flag | Redirect handler(s) | Has `init()` | Has `destroy()` |
|------|--------------|---------------------|--------------|-----------------|
| `frontend/src/pages/signup.js` | `orcidLoading` | `handleOrcidVerify`, `handleOrcidSignup` | yes | yes |
| `frontend/src/pages/recover.js` | `orcidLoading` | `handleOrcidVerify` | yes | **NO** |
| `frontend/src/pages/login.js` | `orcidLoading` | `handleOrcidLogin` | **NO** | yes |
| `frontend/src/pages/settings.js` | `orcidLinking` | `handleOrcidLink` | yes | yes |

All four reset the flag only in `catch`. Note settings.js uses a differently-named
flag (`orcidLinking`, not `orcidLoading`).

## Fix

Register a `pageshow` listener that resets the page's ORCID loading flag to `false`
on bfcache restore (`event.persisted === true`), and remove it on teardown. Clearing
the `pevo_orcid_mode` sessionStorage marker on the same path is a reasonable cleanup.

```js
// init():
this._onPageShow = (e) => { if (e.persisted) this.orcidLoading = false; };
window.addEventListener('pageshow', this._onPageShow);
// destroy():
window.removeEventListener('pageshow', this._onPageShow);
```

Per-page notes:
- **signup.js / settings.js** already define both `init()` and `destroy()`
  (settings.js even installs/tears down `_beforeUnloadHandler` + `_navigationGuard`
  symmetrically) — wire the pageshow listener the same way. settings.js flag is
  `orcidLinking`.
- **login.js** has `destroy()` but NO `init()` — add an `init()` to register the listener.
- **recover.js** has `init()` but NO `destroy()` — add a `destroy()` to remove the listener.
- A small shared helper (e.g. in `lib/`) that wires the pageshow-reset for a named flag
  would DRY the four call sites; optional, the ui agent's call.

## Out of scope (verified NOT vulnerable)

These reset their loading flags in a `finally`, so they self-clear on bfcache restore
— do not touch: recover.js `isSubmitting` (final recover submit); settings.js
`emailSubmitting` / `passwordSubmitting` / `deleting` (the `withSettingsFreshAuth`
round-trips redirect via the same mechanism but reset in `finally`).

## Tests

bfcache can't be truly simulated in jsdom, but a unit test can set the loading flag
`true`, dispatch a synthetic `pageshow` event with `persisted: true` (define the
`persisted` property on the event since jsdom may not populate it), and assert the
flag resets to `false` and the button re-enables. Add one per fixed page.

## Context

This is the confirmed cause of the reported incident. The ORCID-side failure that
sent the user Back (could not log in at ORCID) is a user/ORCID-account issue, not a
PEvO bug. The insufficient-works messaging (`ui-orcid-callback-error-message-coverage`,
`backend-orcid-works-gate-error-details`) is a separate, separately-filed wall.

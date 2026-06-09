# UI-ORCID-OPEN-REDIRECT-GUARD-SWEEP — apply the ORCID_REDIRECT_HOSTS guard at the four unguarded redirect sites

**Owner:** UI Agent
**Created:** 2026-06-09 (architect follow-up from the `ui-orcid-redirect-host-allowlist-sweep` review)
**Priority:** P2

## Problem

`ui-orcid-redirect-host-allowlist-sweep` deduped the open-redirect host allowlist into the shared
`ORCID_REDIRECT_HOSTS` constant and adopted it at the two sites that already had an inline check
(`pages/settings.js` `handleOrcidLink`, `pages/accreditation.js`). The `/ce-code-review` on that sweep
found that FOUR other ORCID start flows assign `window.location.href = data.redirect_url` (the
backend-supplied ORCID authorize URL) with NO host-allowlist check at all:

- `pages/login.js` `handleOrcidLogin` (`startOrcid('login')`)
- `pages/recover.js` `handleOrcidVerify` (`startOrcid('signup')`, return-path `recover`)
- `pages/signup.js` `handleOrcidVerify` (`startOrcid('signup')`)
- `pages/signup.js` `handleOrcidSignup` (`startOrcid('signup')`)

The guarded sites (`fresh-auth.js` session_auth + fresh_auth flows, `settings.js` `handleOrcidLink`,
`accreditation.js`) parse `new URL(data.redirect_url)` and throw `'Invalid ORCID redirect URL'` unless
`ORCID_REDIRECT_HOSTS.includes(target.hostname)`; these four do not. The defense is non-uniform.

This is PRE-EXISTING (the four sites never had a check) and exposure is gated on the backend
`/api/orcid/start` never emitting an attacker-controlled `redirect_url` (it builds the ORCID authorize URL
from server config), so it is defense-in-depth rather than a known-live open redirect. But uniform
open-redirect defense is the right posture for a security-conscious platform, and the sweep commit's new
`fresh-auth.js` docblock now claims "every redirect-host check uses one allowlist", which overstates while
these four sites have no check.

## Goal

Apply the same allowlist guard the guarded sites use, before `window.location.href = data.redirect_url`,
at all four unguarded handlers, using the shared exported `ORCID_REDIRECT_HOSTS` constant. Make the
`fresh-auth.js` docblock accurate once coverage is uniform.

## Requirements

- At each of the four handlers, after `const data = await startOrcid(...)` and before navigating, validate:
  `const target = new URL(data.redirect_url); if (!ORCID_REDIRECT_HOSTS.includes(target.hostname)) throw new Error('Invalid ORCID redirect URL');`
  Match the existing `handleOrcidLink` / accreditation shape, including each handler's existing catch +
  sanitized localized error + `console.warn` pattern. Reuse each page's existing
  `*.orcidStartFailed` / `orcidVerifyFailed` i18n key — no new user-facing copy is expected.
- Preserve each handler's existing pre-navigation behavior (the `this._mounted` guards, the
  `recover.js` `_doOrcidCheck` flow, the sessionStorage `pevo_orcid_mode` / `pevo_orcid_return_to` writes,
  the `orcidLoading` reset on error). The guard slots in just before the redirect.
- `Object.freeze` the exported `ORCID_REDIRECT_HOSTS` array in `fresh-auth.js` so a consumer cannot mutate
  the shared allowlist (folded in from the sweep review; `.includes()` is unaffected by the freeze).
- Correct the `fresh-auth.js` `ORCID_REDIRECT_HOSTS` docblock so its coverage claim is accurate once all
  ORCID redirect sites share the allowlist.

## Acceptance

- Every `window.location.href = data.redirect_url` reachable from a `startOrcid(...)` flow in
  `frontend/src/` is preceded by the `ORCID_REDIRECT_HOSTS` host check (grep-verifiable).
- Each of the four handlers has a rejection-path unit test: mock `startOrcid` to return a non-allowlisted
  host, assert no navigation occurs and the handler surfaces its localized error / resets `orcidLoading`
  (mirror the `pages-settings.test.js` `handleOrcidLink` and `pages-accreditation.test.js` rejection tests).
- Behavior is otherwise unchanged on the allowlisted-host happy path; frontend build green; comment anchors
  clean (no slug / round / line-number / SHA citations).

## References

- Guarded reference pattern: `frontend/src/pages/settings.js` `handleOrcidLink`,
  `frontend/src/pages/accreditation.js`; the constant in `frontend/src/lib/fresh-auth.js`.
- Unguarded sites: `frontend/src/pages/login.js` `handleOrcidLogin`, `frontend/src/pages/recover.js`
  `handleOrcidVerify`, `frontend/src/pages/signup.js` `handleOrcidVerify` + `handleOrcidSignup`.
- Convention: `agents/docs/solutions/conventions/convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md`
  (this is the same sweep, completed by semantic pattern rather than by the syntactic form of the literal).
- Origin: `ui-orcid-redirect-host-allowlist-sweep` review (the semantic siblings the literal-scoped sweep missed).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## UI implementation note (2026-06-09, commit f669035d on main)

All four unguarded handlers now validate the redirect host against the shared
`ORCID_REDIRECT_HOSTS` constant before `window.location.href = data.redirect_url`,
matching the `settings.js` `handleOrcidLink` shape exactly (`new URL(...)` +
`throw new Error('Invalid ORCID redirect URL')` on a non-allowlisted host):
- `pages/login.js` `handleOrcidLogin`
- `pages/recover.js` `handleOrcidVerify`
- `pages/signup.js` `handleOrcidVerify` and `handleOrcidSignup`

The internal throw routes through each handler's PRE-EXISTING sanitized catch (no
new copy): generic localized error to the DOM, raw err to `console.warn`,
`orcidLoading` reset, and the existing `sessionStorage` cleanup (`pevo_orcid_mode`,
plus `pevo_orcid_return_to` for recover). Each page gained
`import { ORCID_REDIRECT_HOSTS } from '../lib/fresh-auth.js'`. The guard is inlined
at each site (NOT extracted to a helper) because the task requires matching the
five existing guarded sites' inline shape; a helper would deviate from that
established pattern and is out of scope.

`ORCID_REDIRECT_HOSTS` is now `Object.freeze`'d in `fresh-auth.js` (`.includes()`
unaffected), and its docblock is corrected to claim uniform coverage — now true.

**Acceptance met.** Grep: 8 `window.location.href = data.redirect_url` sites, 8
`ORCID_REDIRECT_HOSTS.includes` checks (every `startOrcid` redirect is guarded).
Per-handler rejection-path unit test added (mock `startOrcid` → non-allowlisted
host; assert `window.location.href` stays `''` i.e. no navigation, the localized
`*.orcidStartFailed` error, `orcidLoading` reset, and the raw
`'Invalid ORCID redirect URL'` to `console.warn`). Happy-path (allowlisted host)
behavior unchanged. Full frontend unit suite green (1440 pass, +4); build green;
comment anchors clean (no slug/round/line/SHA citations in the new code).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

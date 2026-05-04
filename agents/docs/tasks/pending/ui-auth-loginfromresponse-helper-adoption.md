# UI-AUTH-LOGINFROMRESPONSE-HELPER-ADOPTION — Adopt the existing `loginFromResponse()` helper at the 5+ call sites that reimplement its body inline

**Owner:** UI Agent
**Created:** 2026-05-04
**Priority:** P2
**Surfaced by:** Cluster E architect review (2026-05-04) — findings #6 + #9 + #10 against `ui-savesession-api-misuse-sweep.md` (commit `748e1ac`).

## Context

`auth.js:88` defines `loginFromResponse(data)` that assembles `{token, username, expiresAt, isAccredited, accreditation, custody}` onto the auth store and calls `_saveSession()`. The helper exists; the 5+ login/upgrade call sites do not call it. Each site reimplements the helper's body inline:

- `frontend/src/auth.js:65-80` — `connect()` (the helper's own enclosing object reimplements rather than calls)
- `frontend/src/pages/login.js:154-163`
- `frontend/src/pages/orcid-callback.js:226-240`
- `frontend/src/pages/signup-verify.js:425-437`
- `frontend/src/pages/signup-verify.js:477-486`
- `frontend/src/pages/settings.js:670-685`

The duplication has produced two undocumented divergences:

- **Asymmetric `expires_at` handling.** `signup-verify.js:435/484` assigns unconditionally; `settings.js:680` guards the assignment to preserve the existing store value when backend omits `expires_at`. If backend ever drops `expires_at` from `/api/auth/confirm` or `/api/auth/link`, `auth.expiresAt = undefined` → `JSON.stringify` drops it → `_restoreSession` evicts on next reload. Latent (current backend always emits) but undocumented.
- **Token/expiry decoupling at `settings.js:678-685`.** Two independent `if` guards permit `{token: undefined, expires_at: new}` or `{token: new, expires_at: undefined}` shapes. The former persists a server-invalidated old token with new expiry. UI thinks logged in; first API call returns 401.

`ui-savesession-api-misuse-sweep.md`'s non-goals explicitly excluded centralization ("fold if/when a fourth user surfaces"). With the current commit, 5+ users have surfaced. Threshold crossed.

## Goal

Adopt `loginFromResponse(data)` at all 5+ call sites listed above. Each site collapses from ~6 manual assignments + `_saveSession()` to one method call. Treat the `{token, expires_at, custody}` triple as an atomic update: either all-or-nothing — eliminating the decoupling.

The two divergent cases need handling without re-introducing duplication:

1. **`settings.js`'s "preserve `expires_at` on omit" semantics.** The custody-upgrade response can omit `expires_at` to mean "preserve existing". Solutions: (a) make the helper's `expires_at` handling always preserve-on-falsy (consistent with settings.js, defensive across all sites); or (b) add an option flag (`{ preserveExpiresAtOnOmit: true }`) — only settings.js passes it. Prefer (a): defensive-everywhere is the safer default given the latent bug at signup sites.
2. **`orcid-callback.js`'s accreditation-state reset before save.** The ORCID flow has a stale-accreditation reset step before calling `_saveSession()`. Either keep that as a separate explicit `auth.accreditation = null;` step at the call site BEFORE `loginFromResponse(data)` runs, or add an explicit `accreditation: null` override into the data payload at that one call site.

## Non-goals

- Redesigning `loginFromResponse`'s signature beyond what's needed for the two divergent cases.
- Adding a new round-trip endpoint or breaking the existing backend contract.
- Per-locale i18n changes.

## Deliverable

- All 5+ call sites call `loginFromResponse(data)` (or whatever refined signature the helper lands on).
- The helper handles `expires_at` defensively: if `data.expires_at` is falsy, preserve existing `auth.expiresAt`; if truthy, assign.
- The helper treats `{token, expires_at, custody}` as atomic: don't update one without the other.
- Regression tests verify each site's behavior is preserved (token rotation, expires_at preservation when omitted, custody flip on upgrade, etc.).
- Tests for the "preserve `expires_at` on omit" behavior at all login-style sites (not just settings.js).
- Tests for the "atomic token + expiry" invariant.

## Connection to cluster E

This task subsumes findings #6 + #9 + #10 from the 2026-05-04 cluster E review. After this lands, the asymmetric handling, the token/expiry decoupling, and the helper-adoption gap are all closed by one structural change.

# UI-LOGIN-PENDING-SIGNUP-RESUME-REBIND — Rebind the SPA's PENDING_SIGNUP recovery flow after the login 409 stopped carrying auth_token

**Owner:** ui
**Created:** 2026-05-26 (architect, surfaced by `/ce-code-review` of the BACKEND-AUTH-TOKEN-SESSION-BINDING signup-binding range — api-contract P0, architect-verified)
**Priority:** P1 (broken signup-recovery flow; gate prod deploy of the backend binding work on this)

## Context

The backend signup session-binding work (`backend-auth-token-session-binding`, currently in `tasks/pending/` round-1 hold) changed two contracts the SPA depends on:

1. **`POST /api/auth/login` PENDING_SIGNUP (409) no longer returns `auth_token`.** The body's `data` now contains only `{ email }` (`backend/src/routes/auth.ts` login handler, the `verify_token.startsWith('confirmed:')` branch). The token was removed deliberately — it is the row-lookup credential for `/confirm` and `/link`, and returning it leaked it to anyone who guessed username+password or read a referer/proxy log.

2. **`/confirm` and `/link` now require an httpOnly `pevo_signup_session` binding cookie**, minted only by `/signup` (ORCID branch), `/verify`, and `/resume-signup`. A PENDING_SIGNUP user must obtain a fresh cookie via `/resume-signup` (password re-verify) before `/confirm`/`/link` can succeed.

**The break (architect-verified against the code):** `frontend/src/pages/login.js` (PENDING_SIGNUP branch) and `frontend/src/components/sign-in-modal.js` (PENDING_SIGNUP branch) read `err.data.auth_token` and pass it into `URLSearchParams` to redirect to `/signup/verify`. `auth_token` is now `undefined` → `URLSearchParams` encodes the literal string `"undefined"`, which is truthy and activates the URL-param fast-path in `frontend/src/pages/signup-verify.js` (the `if (query.auth_token && query.email)` branch), setting `this.authToken = "undefined"`. Every subsequent `/confirm` / `/link` then 400s. PENDING_SIGNUP users cannot complete signup.

## Goal

Make the SPA's PENDING_SIGNUP recovery route the user back through `/resume-signup` (password) so a fresh binding cookie is minted, instead of reading `auth_token` from the login 409 body.

1. In `login.js` and `sign-in-modal.js` PENDING_SIGNUP handlers: stop reading `err.data.auth_token` (it no longer exists). Drive the user to a resume-signup step that prompts for the password and calls `POST /api/auth/resume-signup` (which sets the `pevo_signup_session` cookie and returns a fresh `auth_token`).
2. Rework the `/signup/verify` URL-param fast-path so it does not activate on a stale/absent `auth_token`. The legitimate post-resume path obtains `auth_token` from the `/resume-signup` response body AND carries the binding cookie via the response `Set-Cookie` header — not from a URL query param (which leaks into logs/referer).
3. Confirm same-origin XHRs send the cookie (it is `sameSite=lax`, `path=/api/auth`).

## Acceptance

- A PENDING_SIGNUP login no longer reads `auth_token` from the 409 body anywhere in the SPA; `"undefined"` never reaches `signup-verify.js`.
- A user who hits PENDING_SIGNUP at login can complete signup via password re-verify (`/resume-signup` → cookie minted → `/confirm` or `/link` succeeds).
- `auth_token` is not passed as a URL query parameter.

## Coordination

Backend gate is in `tasks/pending/backend-auth-token-session-binding.md` (round-1 hold). The contract changes (login 409 shape, cookie requirement) are already landed in backend code, so this SPA work can proceed in parallel. **Do not deploy the backend binding work to production until this UI task ships** — PENDING_SIGNUP users are broken in the interim.

## UI implementation note (2026-05-26) → review

Implemented by a UI worker subagent. Summary:

- `login.js` + `sign-in-modal.js` PENDING_SIGNUP handlers no longer read `err.data.auth_token`. They navigate to `/signup/verify?resume=1&email=<email>` (resume marker + email hint only; no `auth_token` ever in the URL). Both gracefully handle a 409 body with `{ email }` only, with no data at all, and defensively drop any stray `auth_token` if a stale backend ever sent one.
- `signup-verify.js` `init()` dropped the `if (query.auth_token && query.email)` fast-path (the source of the `"undefined"` bug). It now activates only on the literal `query.resume === '1'` marker, lands on the resume form (`error` phase) with `resumeEmail` prefilled, and never lifts an `auth_token` from the address bar. `authToken` is obtained solely from the `/resume-signup` (or `/verify`) response body via `handleResume()`/`verifyToken()`.
- `api.js`: added explicit `credentials: 'same-origin'` to `resumeSignup`, `confirmAccount`, and `linkExistingAccount` so the httpOnly `pevo_signup_session` binding cookie (`path=/api/auth`, `sameSite=lax`) is stored from the `Set-Cookie` response and re-sent on the follow-up XHR. `resumeSignup` already existed; no new client function needed.
- i18n: new key `seedPhrase.resumeFromLogin` (a one-line explanatory note shown on the resume form when arriving from a login redirect). Added to `en.json` and stubbed as raw English into all 15 non-English locales; `STUBS.md` sweep entry added under `### Added 2026-05-26 (UI-LOGIN-PENDING-SIGNUP-RESUME-REBIND)`.
- Tests: extended `pages-login`, `components-sign-in-modal`, `pages-signup-verify`, and `api` unit suites. New coverage asserts the resume-redirect path, the `"undefined"`-never-becomes-`authToken` guard, no `auth_token` in the URL, and the `credentials: 'same-origin'` shape on the cookie-bearing calls.
- Verification: affected suites 107/107 pass; full unit run 1336/1336 pass; `vite build` succeeds. (The 3 unhandled-rejection "errors" in `pages-edit.test.js` are a pre-existing teardown artifact in `edit.js`, untouched by this task; all 60 of its tests pass.)

## Architect review (2026-05-26) — HELD PENDING FIXES (round 1):

`/ce-code-review` on commit `89e99a95` (10 personas: correctness + security + adversarial on Opus; testing / maintainability / project-standards / api-contract / reliability / julik-frontend-races / learnings on Sonnet; `ce-agent-native-reviewer` skipped per PEvO). The three touched files (`login.js`, `sign-in-modal.js`, `signup-verify.js`, `api.js`) are correct: `auth_token` is gone from the URL, the bare `PENDING_SIGNUP` guard with `err.data?.email` handles every 409 body shape, the `resume === '1'` marker + `phase='error'` landing render the resume form, `credentials:'same-origin'` and the cookie attributes match the backend, and the §6.4/§6.5 account-state-defense check passes (the binding cookie is a genuine password-re-verify second factor; `auth_token` alone never reaches `/confirm` or `/link`). The fixes below block archive. Land them, then `git mv` this file back to `tasks/review/`.

1. **(P1) `signup.js` `_resolveExistingAccount()` is a THIRD PENDING_SIGNUP handler still on the dead contract.** It guards on `loginErr.code === 'PENDING_SIGNUP' && loginErr.data`, reads `loginErr.data.auth_token`, and builds `new URLSearchParams({ auth_token, email })` → `/signup/verify?auth_token=undefined&email=...`. Reachable: re-signup with an existing PENDING_SIGNUP email → `submitSignup` rejects `DUPLICATE` → `_resolveExistingAccount()` → `loginWithPassword` → `PENDING_SIGNUP` 409. Because `signup-verify.js` `init()` no longer reads `query.auth_token` and activates only on `query.resume === '1'`, this URL (no `resume=1`, no `token`) dead-ends on the `seedPhrase.invalidLink` error page — duplicate-email recovery is broken. This **violates this task's own acceptance criterion** ("A PENDING_SIGNUP login no longer reads `auth_token` from the 409 body anywhere in the SPA"). Fix: mirror `login.js` / `sign-in-modal.js` — guard on bare `loginErr.code === 'PENDING_SIGNUP'`, build `new URLSearchParams({ resume: '1' })`, conditionally `set('email', loginErr.data?.email)`, never read `auth_token`.

2. **(P1) The test for that path pins the dead contract and masked item 1.** The `pages-signup.test.js` case "routes _resolveExistingAccount PENDING_SIGNUP to /signup/verify" mocks `data: { auth_token: 'pending-token', email }` and asserts the redirect contains `auth_token=pending-token` — it stays green while production is broken. Rewrite it to the `{ email }`-only contract: assert the redirect contains `resume=1` and the `email`, and does NOT contain `auth_token`. The sibling teardown test "DUPLICATE branch _resolveExistingAccount does not navigate after destroy()" also feeds a fabricated `auth_token` in the 409 mock; its teardown assertion is fine, just drop the dead `auth_token` field so the fixture matches the live 409 shape.

3. **(P2) `linkExistingAccount`'s `credentials:'same-origin'` is untested.** All three signup-binding-triad functions got the option this commit, but `api.test.js` pins only `resumeSignup` and `confirmAccount`; `linkExistingAccount` is not even imported in the test file. A refactor dropping the option from `linkExistingAccount` (which sends the binding cookie to `/link`) would be invisible. Add a credentials assertion mirroring the existing `confirmAccount` test.

4. **(P2) `this.email` is dead state in `signup-verify.js` after the fast-path removal.** The `email: ''` field is written by `verifyToken()` and `handleResume()` but now has no reader — the deleted `init()` fast-path (which set `phase='choose'`) was its only consumer; the resume flow uses `resumeEmail` throughout. Delete the `email: ''` declaration and the two `this.email = res.data.email` assignments.

5. **(P2) The `'1'` resume marker is an unshared magic string across three files.** Two producers (`login.js`, `sign-in-modal.js`) write `{ resume: '1' }`; the consumer (`signup-verify.js` `init()`) tests `query.resume === '1'`. A typo at any site silently falls through to the invalid-link path with no signal. Promote it to a single shared constant (e.g. an exported `RESUME_MARKER` from `signup-verify.js`, imported by the two producers) so the producer/consumer coupling is explicit.

**Dismissed at triage (architect + user, 2026-05-26) — do not re-raise:** reliability's "handleResume conflates all errors into one generic message / no 429 backoff hint" (largely pre-existing `handleResume` behavior, a UX enhancement out of this task's scope); the learnings advisories (audit sibling `URLSearchParams` "undefined"-truthy reads, `sessionStorage` flow-state scope, a backend `/resume-signup` enumeration-oracle gate-ordering check — sibling/backend concerns or speculative, out of scope here); `verifyEmail` missing `credentials:'same-origin'` (same-origin fetch default covers it; `/verify` is a cookie-minter the SPA does not need to read the cookie from); and below-gate teardown/race confirmations from julik (all verified correct, no change).

Items 1–2 are the blocking regression + its masking test; 3–5 are P2 cleanups folded into the same pass. Keep the fixes minimal — do not over-harden.

## UI re-review signal (2026-05-26, working tree):

All five hold-block items landed; scoped strictly to them, no over-hardening.

1. **(P1)** `signup.js` `_resolveExistingAccount()` PENDING_SIGNUP catch now mirrors `login.js` / `sign-in-modal.js`: guards on bare `loginErr.code === 'PENDING_SIGNUP'` (no `&& loginErr.data`), builds `new URLSearchParams({ resume: RESUME_MARKER })`, conditionally `params.set('email', loginErr.data?.email)`, and never reads `auth_token`. The duplicate-email recovery path (`submitSignup` DUPLICATE → `_resolveExistingAccount` → login 409) now routes to the working resume form instead of dead-ending on `?auth_token=undefined`.

2. **(P1)** `pages-signup.test.js` "routes _resolveExistingAccount PENDING_SIGNUP …" rewritten to the `{ email }`-only 409 contract: asserts the redirect contains `resume=1` + `email=`, and `not.toContain('auth_token')`. The sibling teardown test "DUPLICATE branch … does not navigate after destroy()" had its dead `auth_token` field dropped from the 409 mock so the fixture matches the live shape.

3. **(P2)** `api.test.js` now imports `linkExistingAccount` and pins `credentials: 'same-origin'` on `/api/auth/link`, mirroring the `confirmAccount` assertion. `signRequest` is stubbed module-wide (it is the only `signRequest` consumer exercised in this file) so the fetch-shape assertion runs without a real key.

4. **(P2)** `signup-verify.js`: deleted the `email: ''` declaration and both `this.email = res.data.email` assignments (`verifyToken()` + `handleResume()`) — no reader remained after the round-1 fast-path removal. The `enterChooseState` test helper in `pages-signup-verify.test.js` was correspondingly trimmed (dead `email` param + write removed) so it stays faithful to the production seed.

5. **(P2)** Promoted the resume marker to `export const RESUME_MARKER = '1'` in `signup-verify.js`; the consumer (`init()`) and all three producers (`login.js`, `sign-in-modal.js`, `signup.js`) import and use it. The stale "literal '1' marker" comment in `init()` was updated to reference the constant.

**Verification:** the 5 affected suites (`api`, `pages-signup`, `pages-signup-verify`, `pages-login`, `components-sign-in-modal`) pass 139/139; full unit run 1343/1343 pass; `vite build` succeeds. The 3 unhandled-rejection "errors" in the full run originate in `edit.js` `_mountEditors` (pre-existing teardown artifact, untouched by this task). No i18n keys added/changed, so no `STUBS.md` entry.

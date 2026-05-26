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

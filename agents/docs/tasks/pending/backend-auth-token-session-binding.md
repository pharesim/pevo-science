# BACKEND-AUTH-TOKEN-SESSION-BINDING — Bind signup auth_token to the browser session that initiated it

**Owner:** backend
**Created:** 2026-05-21 (surfaced by full-codebase audit 2026-04-21, `.context/audit-2026-04-21/chunk-1-security-sentinel.md` + `chunk-1-adversarial-reviewer.md`)
**Priority:** P1 (security)

## Context

`backend/src/routes/signup-verify.ts` `/confirm` and `/link` handlers look up pending signups by `auth_token` alone. Possession of the token — from a mailbox, a referrer header, a login `PENDING_SIGNUP` error body, or any leakage path — lets anyone complete the signup with their own browser-controlled keys.

The auth_token is treated as a capability rather than as a session-bootstrap secret. The login error path makes this worse: `/api/auth/login` returns `auth_token` in the error body when the account is in PENDING_SIGNUP state, so a brute-forcing attacker who guesses the username gets the token for free.

This is the recurring "token as credential" pattern flagged in the audit cross-cutting themes section: `auth_token`, `orcid_token`, ORCID state, and memo-key on the recovery path all share the shape.

## Goal

Bind `auth_token` to the browser session that initiated the signup:

1. **Mint a session-bound binding** at the original `/api/auth/signup` call site. Options: a CSRF-style token in a `httpOnly` cookie, or a server-side session row keyed by a session id stored in a cookie.
2. **Verify the binding at `/confirm` and `/link`.** Require the matching session cookie. Reject when the cookie is absent or does not match the auth_token's bound session.
3. **Stop returning `auth_token` in login error bodies.** The login error response for PENDING_SIGNUP state should communicate "this email has a pending signup, check your mailbox" without leaking the token.
4. **Rate-limit `/confirm` and `/link` by `auth_token`** in addition to by IP. Brute-forcing the token space should burn rate-limit budget even when the attacker rotates IPs.
5. **Invalidate every other `verify_token` for the same account on successful confirm.** Currently a pending signup with multiple confirmation emails (resend) has multiple live tokens.

## Non-goals

- Reworking the email-token shape itself (HMAC, opaque random, etc.). Either shape works; the issue is binding, not entropy.
- Adding 2FA to the signup confirm path. Separate concern.

## Acceptance

- `/confirm` and `/link` reject requests whose session cookie does not match the auth_token's bound session, returning a clear error (404 or 410, NOT a token-exists oracle).
- Login error responses for `PENDING_SIGNUP` no longer include the auth_token.
- A test exercises the cross-session attack: session A creates a signup, session B attempts `/confirm` with session A's token, gets rejected.
- Rate-limit hits accumulate per-auth_token under brute-force attempts.

## References

- Audit chunks:
  - `.context/audit-2026-04-21/chunk-1-security-sentinel.md` (P1: auth_token is password-equivalent).
  - `.context/audit-2026-04-21/chunk-1-adversarial-reviewer.md` (P1: same).
- Related cross-cutting theme: "Token as credential" pattern in `.context/audit-2026-04-21/SUMMARY.md` § Cross-cutting themes #2.

## [TODO Architect] — auth API contract updates

The backend implementation introduces the following changes to the auth domain
that need reflecting in `agents/docs/api-contracts/auth.md`:

1. **`POST /api/auth/confirm` and `POST /api/auth/link` now require an httpOnly
   `pevo_signup_session` cookie.** The cookie is minted by `POST /api/auth/signup`
   (ORCID-direct path), `POST /api/auth/verify`, and `POST /api/auth/resume-signup`.
   When the cookie is missing or its SHA-256 does not match the row's stored
   `signup_binding_hash`, both routes return `400 BAD_REQUEST` with the SAME
   message as an invalid auth_token (`"Invalid or expired auth token"` for
   `/confirm`, `"Invalid or expired link request"` for `/link`) so no
   token-validity oracle is exposed. Cookie attributes: `httpOnly`, `sameSite=lax`,
   `secure` in production, `path=/api/auth`, 24h max-age.

2. **`POST /api/auth/login` PENDING_SIGNUP response no longer carries
   `auth_token`.** The 409 body's `data` now contains only `{ email }`. The SPA
   must direct the user back through `POST /api/auth/resume-signup` (or the
   verification email link) to obtain a fresh cookie binding before
   `/confirm`/`/link`.

3. **New rate limit on `/confirm` and `/link`: 5 requests per auth_token per
   hour** (layered on top of the existing 10/IP/hour). Brute-force attempts
   against the same token from rotated IPs share the budget.

4. **Stuck-account recovery (Option C) bypasses the binding check** on both
   routes because Hive-account ownership is already proved by `posting_private`
   (for `/confirm`) or `verifyHiveSignature` (for `/link`).

Migration `010_accounts_signup_binding_hash.sql` adds the nullable BYTEA
column. The architect should also note in `ARCHITECTURE.md` § 6.x that the
PENDING_SIGNUP → CONFIRM transition now requires the session-binding cookie
as an additional auth factor alongside the auth_token.

A frontend follow-up will also be needed (UI agent task): update
`/signup/verify` to handle the case where login PENDING_SIGNUP no longer
provides `auth_token` (force a re-resume-signup with password to re-bind).

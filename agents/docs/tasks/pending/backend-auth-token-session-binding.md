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

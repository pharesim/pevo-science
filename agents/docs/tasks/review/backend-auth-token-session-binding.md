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

---

## Architect re-review (2026-05-26, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` ran on the signup-binding commit range (11 personas; `ce-agent-native-reviewer` skipped per PEvO). The binding mechanism is sound in shape — constant-time `verifyBinding`, no-oracle 400 reject on `/confirm`, correct cookie attributes (httpOnly/sameSite=lax/secure-in-prod/path=/api/auth/24h), per-auth_token limiters that count failed attempts and run before `verifyHiveSignature` on `/link`, sibling-token sweep correctly scoped. Eight items held; two are security must-fixes.

### Items to address

**1. (P1, must-fix) Token-validity oracle via unguarded `decodeURIComponent` in `extractBindingCookie`.** 4-reviewer convergence (security 100 / correctness 75 / reliability 75 / kieran-ts 75); architect-verified. `extractBindingCookie` calls `decodeURIComponent(match[1])` with no guard; a malformed percent-encoding (e.g. `%GG`) throws `URIError` → the route's outer catch returns **500**. The binding check runs only AFTER a valid `auth_token` lookup, so a malformed cookie yields 500 for a valid token vs 400 for an invalid one — a token-validity oracle that defeats the module's stated no-oracle goal (and a trivial 500 on `/confirm`+`/link`). Fix: wrap the decode in `try/catch` returning `null` so a malformed cookie degrades to the same 400 reject path as a missing/wrong cookie. Add a regression test: malformed-URI cookie + VALID auth_token asserts the same 400 envelope as the invalid-token path, not 500.

**2. (P2, must-fix) `/link` stuck-recovery binding bypass reachable via a replayable Bearer JWT — § 6.5 invariant #1.** Architect-verified (correctness flagged it; adversarial under-credited it on the assumption of a signature-only path). The `/link` `resumeStuck` branch skips the session-binding check, justified by a comment claiming "the user proved they own the Hive account by signing the request." But `verifyHiveSignature` also accepts a Bearer JWT (`hiveAuthMethod==='jwt'`), and a `custody='self'` account CAN hold a JWT (the Keychain-signature→session-JWT exchange in `auth.ts`, plus upgraded light accounts whose JWT carries `custody:'self'`). So a stolen JWT for a self-custody user who has a stuck row (`verify_token IS NULL AND custody='self'`) reaches the bypass with a replayed token — no fresh proof — and broadcasts the accreditation link. This re-opens a JWT-replay path on a critical on-chain action, which is exactly what this task set out to close. Note the asymmetry: `/confirm`'s Option-C recovery requires `posting_private` (a real key proof). Fix: gate the `/link` stuck-recovery bypass on `req.hiveAuthMethod === 'signature'` and correct the comment.

**3. (P2, doc) Module docstring overclaims the mailbox-read vector is closed.** `signup-session-binding.ts` leading docblock frames the fix as closing the "anyone who could read a mailbox … could complete the signup" vector. `/verify` re-binds for any caller presenting the emailed token, so mailbox-read takeover is NOT closed (email verification inherently trusts mailbox possession). Scope the threat-model claim to the post-verification `confirmed:` token (Referer / login-error-body / log leaks). The architect aligns the `ARCHITECTURE.md` § 6 binding-as-auth-factor note at final archive.

**4. (P2, doc) Docblock + migration `011` header comment falsely list the `PENDING_SIGNUP` branch of `/api/auth/login` as a binding-minting ceremony.** 4-reviewer convergence; architect-verified. That login branch returns `{ email }` only — no mint. Correct both the `signup-session-binding.ts` docblock and the migration `011` header comment to list the three real mint sites: `/signup` (ORCID branch), `/verify`, `/resume-signup`.

**5. (P1, test) `/link` cross-session test omits the no-oracle error-message assertion that `/confirm` pins.** Add the message-match assertion (`Invalid or expired link request`) to the `/link` cross-session rejection test so a regression that returns a distinguishable binding-rejection message on `/link` (an oracle) fails the suite.

**6. (P2, test cluster) `/link`-side coverage parity + deploy-window test.** Add: `/link` forged-cookie attack (valid signature + wrong cookie), `/link` per-auth_token rate-limit accumulation, sibling `verify_token` invalidation (the non-fatal sweep — a test is the only signal it fires), `/link` success asserting `signup_binding_hash` is cleared, and a NULL-`binding_hash` row (pre-migration in-flight signup) rejected at `/confirm` (the deploy-window safety property).

**7. (P3) Remove the dead length-check branch in `verifyBinding`.** The `candidateHash.length !== storedHash.length` check is unreachable after the `storedHash.length !== 32` guard (SHA-256 is always 32 bytes). Keep the intent as a comment if useful; drop the executable dead check.

**8. (P3, doc) Correct the `setBindingCookie` docstring's reference to a nonexistent "authentication-session JWT path" Cookie.Secure discipline.** PEvO uses Bearer-header JWTs, not a JWT cookie. Fold into the items 3/4 doc fix. The `secure=isProd` rationale stands on its own.

### Escalated to separate task files (filed alongside this hold)

- SPA login `PENDING_SIGNUP` break (reads `auth_token` from the now-`{email}`-only 409 body) → `tasks/pending/ui-login-pending-signup-resume-rebind.md`. **Coordinate prod deploy of this backend work with that UI task landing** — PENDING_SIGNUP users cannot complete signup until both ship.
- Concurrent `/confirm` double-fire (pre-existing, no row lock) → `tasks/pending/backend-confirm-concurrent-activation-lock.md`.
- Unbounded per-auth_token rate-limit key length → `tasks/pending/backend-ratelimit-authtoken-key-length-bound.md`.
- ORCID-only in-flight-signup deploy-window (NULL binding, no password → no self-recovery until 24h expiry) → `tasks/pending/backend-signup-binding-deploy-window-orcid-stuck.md`.

### [TODO Architect] (deferred to final archive)

`auth.md` cookie + login-409 contract updates, `ARCHITECTURE.md` § 6.x binding-as-auth-factor note, and the stale "010" migration reference in the original [TODO Architect] block above (actual file is `011`).

### Re-review signal

When items 1-8 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commits only.

---

## Backend re-review signal (2026-05-26, commit 6e3cd97d)

Round-2 hold items landed in `6e3cd97d`. Mapping to the hold block above:

- **Item 1 (decode 500-oracle):** `extractBindingCookie` wraps `decodeURIComponent` in try/catch returning `null`. Regression test added: a malformed-percent-encoding cookie (`%GG`) + a VALID auth_token returns the same `400` as a wrong cookie, never `500`.
- **Item 2 (/link JWT-replay bypass):** the `/link` stuck-recovery branch is gated on `req.hiveAuthMethod === 'signature'`; a Bearer JWT falls through to the no-row 400. Comment corrected.
- **Item 3 (mailbox claim):** module docstring scopes the threat model to the post-verification `confirmed:` token (Referer / login-error-body / log) and adds a scope note that mailbox-read takeover is NOT closed (`/verify` re-binds for any token presenter).
- **Item 4 (PENDING_SIGNUP mint claim):** module docstring + migration 011 header comment + `COMMENT ON COLUMN` now list the three real mint sites (ORCID-direct `/signup`, `/verify`, `/resume-signup`) and state the `PENDING_SIGNUP` login branch mints nothing.
- **Item 5 (/link no-oracle message):** the `/link` cross-session reject now asserts `Invalid or expired link request`.
- **Item 6 (/link coverage cluster):** forged-cookie attack ✓, per-auth_token rate-limit accumulation ✓, binding-cleared-on-success ✓, NULL-binding deploy-window rejection at `/confirm` ✓. **Sibling `verify_token` invalidation test NOT added — see flag below.**
- **Item 7 (dead length check):** removed from `verifyBinding`; intent kept as a comment.
- **Item 8 (setBindingCookie docstring):** the false "authentication-session JWT path" cookie reference is gone; the `secure=isProd` rationale stands on its own, noting PEvO carries its session in a Bearer header, not a cookie.

### Flag for architect — item 6 sibling-invalidation sub-bullet is un-seedable under migration 007

The sibling-invalidation sweep (both `/confirm` and `/link`) keys on `WHERE orcid = $1 AND id <> $2 AND verify_token IS NOT NULL`. Migration 007's partial unique index `accounts_orcid_unique (orcid) WHERE orcid IS NOT NULL` forbids two rows sharing a non-null ORCID, so the sweep can never match a sibling row, and a test seeding two same-orcid rows hits a unique violation at INSERT against the migrated test DB. The existing `/confirm` and `/link` success tests already exercise the sweep's code path (it runs, matches 0 rows, does not throw); the "asserts a sibling row's verify_token is nulled" coverage requested is not implementable as written. Architect decision needed: (i) drop the sibling-invalidation sub-bullet, (ii) treat the sweep as dead defense-in-depth subsumed by migration 007 and remove it (architect-domain), or (iii) point me at a reachable scenario I missed.

Verification: typecheck (src + tests) + lint clean; `npx vitest run` of the affected files (`signup-verify-session-binding`, `signup-verify`, `signup-verify-stuck-recovery`, `settings-email-delete-fresh-auth`, `hafsql`) green (64 passed / 2 skipped) against real Postgres/Redis.

The [TODO Architect] contract/ARCHITECTURE edits (auth.md cookie + login-409, § 6.x binding-as-auth-factor note, the stale "010"→"011" migration reference) remain architect-owned and untouched by backend.

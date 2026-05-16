# BACKEND-SETTINGS-EMAIL-REAUTH-FRESH-AUTH — Require fresh-auth proof on `/api/settings/email` change-email branch

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, surfaced by account-state-machine brainstorm at `agents/docs/ARCHITECTURE.md` § 6; audited by `backend-settings-email-reauth-audit.md` 2026-05-16)
**Priority:** P1

## Problem

`POST /api/settings/email` (`backend/src/routes/settings.ts:96`) changes the email address registered on an account. Current auth: `verifyHiveSignature` middleware only (JWT or Keychain). No fresh re-auth proof required.

Email is a critical-action route per `agents/docs/ARCHITECTURE.md` § 6.5 invariant #1: changing the email controls who receives `/api/auth/reset-request` password-reset links. A stolen JWT for a state A or state B user is a one-step takeover:

1. Attacker obtains a victim's JWT (any of the usual JWT-leak vectors).
2. Attacker POSTs `/api/settings/email` with `email: 'attacker@example.com'`. Handler writes `pending_email` and emits a verify token to the attacker-controlled address.
3. Attacker clicks the verify link, `/api/settings/email/verify/:token` swaps the registered email to the attacker's address.
4. Attacker calls `/api/auth/reset-request` with their address; PEvO emails them a password-reset token.
5. Attacker calls `/api/auth/reset` with the token and a chosen password.
6. Account password is now attacker-controlled. From there: `/api/custody/fresh-auth` (mechanism `password`) → `/api/custody/broadcast` → full takeover.

State C (passwordless ORCID-only) cannot be taken over via the reset chain in isolation (state C has no password and § 6.3 forbids `/reset` from C), but the same JWT plus the set-password gap (separate task `backend-settings-set-password-fresh-auth.md`) chains into the same takeover. Closing both gaps is required; either alone leaves a one-step path open.

The `change-email` operation transitions an auth-adjacent factor (the address that receives password-reset tokens, which gates password rotation); it must require proof of identity beyond the bearer JWT, matching what the account has registered.

## Goal

Require a fresh-auth proof on `POST /api/settings/email` for the change-email path. Per § 6.4's critical-action contract, the accepted proof factor depends on what the account has registered, mirroring the existing `/api/custody/broadcast` non-consent contract:

- **State A (password registered, no ORCID):** proof of mechanism `'password'`.
- **State B (password + ORCID):** proof of mechanism `'password'` OR `'orcid'`.
- **State C (ORCID only):** proof of mechanism `'orcid'`.
- **State D (upgraded self-custody):** Keychain-signed requests are already fresh-proof-bound via `verifyHiveSignature`'s Hive-signature path and need no body proof. JWT-authenticated requests for D users must carry a body proof matching whatever factor remains registered on the row (password and/or orcid, both preserved from pre-upgrade per § 6.3).
- **No-row pure self-custody (Add flow):** request is reachable only via the Hive-signature path of `verifyHiveSignature`, which is itself fresh-proof. No body proof required on this branch.

## Approach

Reuse the existing fresh-auth primitive at `backend/src/lib/fresh-auth.ts` and the same `fresh_auth_proof` body field shape that `/api/custody/broadcast` (`backend/src/routes/custody.ts:312`) and the in-flight `backend-settings-set-password-fresh-auth.md` task use. The handler:

1. Skips the body proof requirement on the Add-flow no-row branch (line 135 in current code) when authenticated via the Hive-signature path — that path is already fresh-proof-bound.
2. Skips the body proof requirement on JWT-or-Keychain requests authenticated via the Hive-signature path for existing rows — Keychain signature is already a fresh per-request proof.
3. On the JWT-authenticated change-email path, requires `fresh_auth_proof` in the body; verifies via the shared primitive; rejects if mechanism doesn't match what the account has registered.

Distinguish JWT path from Keychain path by checking whether `req.headers['authorization']?.startsWith('Bearer ')` succeeded (already the discriminator inside `verifyHiveSignature`); a cleaner approach is to expose this via a `req.hiveAuthMethod: 'jwt' | 'signature'` field on the middleware so route handlers don't re-parse headers. If adding that field is non-trivial, use the existing `req.hiveCustody` plus header re-check as a near-term path and file a small follow-up to add the explicit discriminator.

## Acceptance

1. `POST /api/settings/email` on the change-email branch (existing row, JWT-authenticated request) returns 401 UNAUTHORIZED if `fresh_auth_proof` is missing from the request body.
2. The proof is rejected if it was not issued for the same `username` as the JWT subject (cross-user proof).
3. The proof's mechanism is checked against the account's registered factors:
   - State A: only `'password'` accepted; `'orcid'` rejected.
   - State B: `'password'` or `'orcid'` both accepted.
   - State C: only `'orcid'` accepted; `'password'` rejected (state C has no password to base a password fresh-auth on, so a password-mechanism proof on this branch is structurally invalid and indicates either misuse or a bug elsewhere).
   - State D: same as the underlying registered factors (whatever password_hash/orcid are preserved from pre-upgrade).
4. The proof's TTL is enforced (expired proofs rejected).
5. Keychain-signature-authenticated requests (no `Authorization: Bearer …` header) on this endpoint do NOT require a body proof — the Hive-signature path is already fresh.
6. The Add-flow no-row branch (`settings.ts:135-141`, INSERT new row for a Keychain user with no `accounts` row yet) is unchanged behaviorally — that branch is unreachable from the JWT path (no JWT exists before a row exists) and remains gated by the Hive-signature freshness alone.
7. Real-path integration test in `backend/tests/routes/` exercises: happy path for each of A, B, C with the matching proof mechanism; missing-proof 401 on JWT path; cross-user 401; wrong-mechanism rejection per state; expired-proof 401; Keychain-signed-no-body-proof path succeeds.

## Out of scope

- Changing re-auth model for the rest of `/settings` endpoints. Each is its own task; see `backend-settings-set-password-fresh-auth.md` for the `/settings/set-password` companion.
- Building the UI flow that prompts users to complete password or ORCID re-auth before requesting an email change. UI agent picks that up after this lands.
- Adding the `req.hiveAuthMethod` discriminator on `verifyHiveSignature` (if implementer chooses the header re-check approach, file a small follow-up; if implementer adds the field, it's in scope here).
- Auditing or changing `POST /api/settings/email/verify/:token` (the completion endpoint). Token possession is the proof on that side and that model is correct; it's audited as part of this same task and confirmed correct in `backend-settings-email-reauth-audit.md`.

## References

- `agents/docs/ARCHITECTURE.md` § 6.4 (Critical-action / re-auth contract)
- `agents/docs/ARCHITECTURE.md` § 6.5 invariant #1 (JWT-not-sufficient)
- `agents/docs/ARCHITECTURE.md` § 6.5 invariant #2 (re-auth factor must match registered)
- `backend/src/routes/settings.ts:96` (current POST /email handler)
- `backend/src/routes/settings.ts:199` (POST /email/verify/:token — completion path, unchanged)
- `backend/src/routes/custody.ts:312` (existing consent-broadcast `fresh_auth_proof` pattern to mirror)
- `backend/src/routes/orcid.ts` `handleFreshAuth` (existing ORCID fresh-auth proof issuance)
- `backend/src/lib/fresh-auth.ts` (proof-verification primitives)
- `backend/src/middleware/verifyHiveSignature.ts` (JWT vs Hive-signature discriminator)
- `backend/src/routes/auth.ts:850` (`/reset-request` — the downstream takeover vector if change-email is unguarded)
- Companion task: `backend-settings-set-password-fresh-auth.md` (mirror gap on `/settings/set-password`; both must close together).
- Originating audit: `backend-settings-email-reauth-audit.md` (2026-05-16).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

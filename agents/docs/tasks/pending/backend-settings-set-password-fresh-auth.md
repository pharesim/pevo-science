# BACKEND-SETTINGS-SET-PASSWORD-FRESH-AUTH — Require fresh ORCID re-auth on the null-hash branch

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, surfaced by Group 3 review triage + account-state-machine brainstorm at `agents/docs/ARCHITECTURE.md` § 6)
**Priority:** P1

## Problem

`POST /api/settings/set-password` (`backend/src/routes/settings.ts:366`) sets a new password on a state C account (passwordless ORCID-only — see `agents/docs/ARCHITECTURE.md` § 6.1). Current auth: `verifyHiveSignature` middleware only (JWT or Keychain). No fresh re-auth proof required.

Threat model — JWT theft is the project's accepted threat vector, and the defense is re-auth at critical actions (see § 6.5 invariant #1). This endpoint violates that invariant:

1. Attacker obtains a state C user's JWT (any of the usual JWT-leak vectors).
2. Attacker POSTs `/api/settings/set-password` with the JWT and any password value of their choice.
3. Account transitions from state C → state B (with attacker-known password).
4. Attacker now has a password they control on the victim's account. They can call `/api/custody/fresh-auth` to issue a password-based fresh-auth proof, then `/api/custody/broadcast` with that proof to broadcast as the victim.
5. Full account takeover from a JWT-only foothold.

The `set-password from null` operation transitions the account's auth-factor set; it must require proof of identity beyond the bearer JWT.

## Goal

Require a fresh ORCID OAuth re-auth proof on `/api/settings/set-password`'s null-hash branch. Per § 6.4's critical-action contract, ORCID OAuth is the only registered auth factor for state C accounts, and is therefore the only proof factor structurally available for this transition.

## Approach

Reuse the existing fresh-auth primitive at `backend/src/lib/fresh-auth.ts` and the `mode='fresh_auth'` ORCID flow at `backend/src/routes/orcid.ts handleFreshAuth`. The set-password request body adds a `fresh_auth_proof` field; the handler verifies the proof via the established proof-verification path before accepting the new password.

## Acceptance

1. `POST /api/settings/set-password` returns 401 UNAUTHORIZED if `fresh_auth_proof` is missing from the request body.
2. The proof is rejected if it was not issued for the same `username` as the JWT subject (cross-user proof).
3. The proof is rejected if its mechanism is `'password'` rather than `'orcid'` — state C has no password to base a password fresh-auth on, so a password-mechanism proof on this branch is structurally invalid and indicates either misuse or a bug elsewhere.
4. The proof's TTL is enforced (expired proofs rejected).
5. Real-path integration test in `backend/tests/routes/` exercises: happy path (state C user → valid ORCID fresh-auth proof → password set, state transitions to B); missing-proof 401; cross-user 401; password-mechanism 401; expired-proof 401.

## Out of scope

- Changing re-auth model for the rest of `/settings` endpoints. Each is its own task; see `backend-settings-email-reauth-audit.md` for the `/settings/email` companion.
- Building the UI flow that prompts state C users to complete ORCID re-auth before set-password. UI agent picks that up after this lands.
- Rotate-password flow (changing an existing password) — separate endpoint, separate task, requires `current_password` re-auth rather than ORCID fresh-auth.

## References

- `agents/docs/ARCHITECTURE.md` § 6.4 (Critical-action / re-auth contract)
- `agents/docs/ARCHITECTURE.md` § 6.5 invariant #1 (JWT-not-sufficient)
- `backend/src/routes/settings.ts:366` (current handler)
- `backend/src/routes/orcid.ts` `handleFreshAuth` (existing ORCID fresh-auth proof issuance)
- `backend/src/lib/fresh-auth.ts` (proof-verification primitives)
- Originating Group 3 review session: surfaced as F#19 during review of commit `36b3f49`, then confirmed during architect brainstorm 2026-05-16.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

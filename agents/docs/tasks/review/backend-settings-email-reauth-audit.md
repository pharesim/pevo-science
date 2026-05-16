# BACKEND-SETTINGS-EMAIL-REAUTH-AUDIT — Audit `/api/settings/email` re-auth and document or fix any gap

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, surfaced by account-state-machine brainstorm at `agents/docs/ARCHITECTURE.md` § 6 — § 6.4 row marked "TBD")
**Priority:** P2

## Problem

`agents/docs/ARCHITECTURE.md` § 6.4 (Critical-action / re-auth contract) lists `POST /api/settings/email` with re-auth "TBD — re-auth model unverified; see open audit task". This task is that audit.

Email is a critical-action route per § 6.5 invariant #1: changing the email address controls who receives `/reset-request` password-reset links, so an attacker who can change the email to one they control can reset the password and take over the account. The re-auth model must be at least as strong as `/reset`'s effective barrier — typically: a current-password proof, an ORCID fresh-auth proof, or both.

## Goal

Read the current `/api/settings/email` handler at `backend/src/routes/settings.ts` (lines 96-198 per the route table) and the `/email/verify/:token` partner at line 199. Determine:

1. What re-auth (if any) the change-email request requires today.
2. Whether the model satisfies § 6.5 invariant #1 (no JWT-only critical-action access).
3. Whether per-state availability matches § 6.4's intent — state A (password registered), state B (password + ORCID), state C (ORCID only) should each have a path.

## Acceptance

After the audit, EXACTLY ONE of the following happens:

- **(a) Gap found:** file a follow-up backend task with the same shape as `backend-settings-set-password-fresh-auth.md` documenting the required re-auth and the per-state proof factors. Architect updates `agents/docs/ARCHITECTURE.md` § 6.4 to remove the TBD and document the intended re-auth at archive time.
- **(b) No gap:** the existing model already requires a sufficient re-auth proof (current-password OR ORCID fresh-auth, properly verified). Architect updates § 6.4 to document the current correct model and removes the TBD at archive time. No code change.

## Out of scope

- Implementation of any fix discovered. If a gap exists, this audit task closes with the filing of a follow-up; the follow-up is the implementation task.
- Auditing other `/settings` endpoints. Each is its own audit; this one is scoped to `/email` only.

## References

- `agents/docs/ARCHITECTURE.md` § 6.4 (Critical-action / re-auth contract — current row marked TBD)
- `agents/docs/ARCHITECTURE.md` § 6.5 invariant #1 (no JWT-only critical actions)
- `backend/src/routes/settings.ts:96` (current POST /email handler)
- `backend/src/routes/settings.ts:199` (POST /email/verify/:token — completion path)
- `backend/src/routes/auth.ts:850` (`/reset-request` — the downstream takeover vector if change-email is unguarded)

---

## Audit Findings (2026-05-16, Backend Agent)

### What re-auth `/api/settings/email` requires today

`backend/src/routes/settings.ts:96` mounts `POST /email` behind `writeLimiter` + `verifyHiveSignature` only. No password check, no `fresh_auth_proof` field in the request body or handler, no ORCID re-auth, no Keychain-only gate.

`verifyHiveSignature` (`backend/src/middleware/verifyHiveSignature.ts`) accepts either:
- A `Bearer <jwt>` header (JWT path — issued by `/api/auth/login`, `/api/orcid/callback mode='login'`, etc.; light accounts and post-upgrade `D` accounts use this), OR
- An `X-Hive-Username` + `X-Hive-Signature` + `X-Hive-Timestamp` triple (Hive Keychain path; pure self-custody and Keychain-authenticated requests).

JWT path is a session bearer with no fresh-auth proof attached. Hive-signature path is itself a fresh per-request proof (signed request body + 60s timestamp window + replay cache), so Keychain-signed requests do meet "fresh proof".

The `/email/verify/:token` completion endpoint (line 199) takes only the emailed token — no auth on that side, by design, since the token possession is the proof that the email-change request was legitimate. That side is fine; the gap is on the request side.

### Does the current model satisfy § 6.5 invariant #1?

**No.** A stolen JWT for any state-A/B/C account is sufficient to call `POST /api/settings/email` with an attacker-controlled address. After the attacker controls the email:

1. Attacker calls `/api/auth/reset-request` with the new (attacker-controlled) email.
2. PEvO emails a reset token to that address.
3. Attacker calls `/api/auth/reset` with the token + a new password.
4. Attacker now controls the account's password. They can `/api/custody/fresh-auth` to mint a password fresh-auth proof, then `/api/custody/broadcast` to act as the victim.

This is a one-step JWT-to-takeover escalation via a critical action that takes JWT alone — the F#19-class escalation that the set-password fresh-auth task exists to close. The set-password fix without the email fix is incomplete: an attacker on a state-A or state-B JWT can route around the set-password gate by changing email → reset → known-password instead.

Note: state-C accounts (no password) cannot be taken over via the reset chain because `/api/auth/reset` requires `password_hash IS NOT NULL`-adjacent flow (and § 6.3 explicitly states "C cannot use /reset — state C may have no email, and has no password to reset"). However, an attacker can still change C's email and then exploit a *separate* foothold (e.g., the set-password JWT gap on the same JWT) to set a password and complete takeover. The two gaps reinforce each other. Both must close.

### Per-state availability under the current handler

The handler treats all states uniformly (it cares only about whether an `accounts` row exists, branching INSERT vs UPDATE — `settings.ts:135-152`). Per-state intent per § 6.4:

- **State A (password, no ORCID):** only registered factor is password. Should require `current_password` fresh-auth.
- **State B (password + ORCID):** can prove via password OR ORCID. Should accept either fresh-auth proof.
- **State C (passwordless ORCID-only):** only registered factor is ORCID. Should require ORCID fresh-auth (same primitive set-password's null-hash branch will require post-fix).
- **State D (upgraded self-custody):** `password_hash` and `orcid` preserved from pre-upgrade. The Keychain-signature path on `verifyHiveSignature` is already a fresh per-request proof, so Keychain-authenticated requests are fine. JWT-authenticated requests for D users still need an additional fresh-auth proof; D users post-upgrade typically have Keychain on the client anyway, but the JWT path remains reachable for them (login still issues a JWT) so this isn't structurally excluded.
- **No-row pure self-custody (Add flow, `settings.ts:135-141`):** branch is reachable only via the Hive-signature path of `verifyHiveSignature` (pure-self-custody has no JWT mint path), so it's already fresh-proof-bound by construction. No separate fix needed here.

Per-state availability is structurally possible because the project already has both primitives implemented:
- Password fresh-auth: `POST /api/custody/fresh-auth` (mechanism `'password'`).
- ORCID fresh-auth: `POST /api/orcid/callback mode='fresh_auth'`.
- Proof verification: `backend/src/lib/fresh-auth.ts`.

The pattern to follow is the existing `custody.ts:312` consent-broadcast branch and the set-password fix described in `backend-settings-set-password-fresh-auth.md` — accept `fresh_auth_proof` in the request body, verify via the shared primitive, accept proof of mechanism `'password'` for A/B and mechanism `'orcid'` for B/C/D.

### Audit verdict

**GAP FOUND.** `POST /api/settings/email` is a critical action under § 6.5 invariant #1, currently accepts JWT-only, and constitutes a one-step JWT-to-takeover escalation. Per-state availability is structurally achievable using primitives that already exist. Filing follow-up task per acceptance criterion (a).

### Follow-up filed

- `agents/docs/tasks/pending/backend-settings-email-reauth-fresh-auth.md`

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

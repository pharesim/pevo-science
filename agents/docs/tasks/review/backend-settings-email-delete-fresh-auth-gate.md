# BACKEND-SETTINGS-EMAIL-DELETE-FRESH-AUTH-GATE — gate `DELETE /api/settings/email` (account erasure) behind a fresh-auth proof

**Owner:** backend
**Created:** 2026-05-26 (architect, surfaced by /ce-code-review on backend-recover-email-verification-and-notify round-2, security persona — out of scope for that commit, pre-existing)
**Unblocked:** 2026-05-26 (architect + user — decision: gate it; see Architect resolution)
**Priority:** P2 (security — destructive-action re-auth)

## Context

`DELETE /api/settings/email` (`backend/src/routes/settings.ts`) is the de-facto **account-erasure / right-to-erasure** path: the handler runs `DELETE FROM accounts WHERE username = $1` plus deletes of `notification_preferences` and `pending_recovery`, and anonymizes `custody_audit_log` — it removes the entire account, not just the email column.

It is mounted with `verifyHiveSignature` only and performs **no fresh-auth proof check**. Premise verified against the code:

- `verifyHiveSignature` (`backend/src/middleware/verifyHiveSignature.ts`) accepts a Bearer JWT: a valid JWT with a string `sub` sets `req.hiveUsername` and calls `next()` (`req.hiveAuthMethod = 'jwt'`). The middleware docblock itself states that handlers needing to distinguish a replayable bearer token from a fresh signed message must require a body-level `fresh_auth_proof` on the JWT path.
- The two sibling sensitive routes do exactly that: `POST /api/settings/email` (change-email) and `POST /api/settings/set-password` both consume a fresh-auth proof (`computeFreshAuthTargetHash` / mint side) on the JWT path. `DELETE /api/settings/email` does not.

So a stolen/replayed JWT alone (within validity, not session-invalidated) reaches the handler and erases the account — and for a light account, destroys the email/password login path. This is the ARCHITECTURE.md § 6.5 invariant #1 pattern ("JWT-only access on a critical action is a defect"). Pre-existing; not introduced by the recover-email work.

## Architect resolution (2026-05-26) — GATE IT

Architect + user decided to gate it (not exempt). Account erasure mutates an auth factor and transfers/destroys control, so it is a critical action per § 6.6; leaving it JWT-only contradicts § 6.4 ("the JWT alone is never sufficient") and § 6.5 invariant #1. ARCHITECTURE.md was updated in the unblock commit:
- § 6.4 now carries a "Delete account data / right-to-erasure" row (`DELETE /api/settings/email`), same proof contract as change-email: JWT path requires a body `fresh_auth_proof`; Keychain (Hive-signature) path is fresh at the middleware and needs no body proof. Per-state: A→password, B→password-or-ORCID, C→ORCID, D→preserved factors, no-row→n/a.
- § 6.3 now documents the `A/B/C/D ──DELETE(fresh-auth proof)──> [no row]` one-way exit and the seed-phrase → Keychain continuation.

The doc rows are marked "gate not yet implemented" until this task lands; on landing, update the § 6.4 row to reference the implementing commit (replacing the "pending implementation" marker), mirroring the change-email row.

## Goal

Add the fresh-auth proof gate to `DELETE /api/settings/email`, mirroring the change-email consume side:

1. On the JWT auth path (`req.hiveAuthMethod === 'jwt'`), require a body `fresh_auth_proof` bound to a delete-account action target (a distinct `action` value from change-email/set-password so a proof minted for one action can't be replayed on another — verify target binding via `computeFreshAuthTargetHash`). Reject with `401 FRESH_AUTH_REQUIRED` when absent/invalid and `403`/target-mismatch on a cross-action proof.
2. On the Keychain (Hive-signature) path, no body proof is required (the per-request signature is itself fresh, replay-bounded at the middleware) — consistent with change-email.
3. Widen the proof-mint paths (`POST /api/custody/fresh-auth` password issuance and `POST /api/orcid/callback mode='fresh_auth'` ORCID issuance) to issue a proof for the delete-account action target, so a real user can obtain the proof their account's registered factor supports (A→password, B→either, C→ORCID, D→preserved).
4. Update the settings api-contract doc (`agents/docs/api-contracts/settings.md`) for the new `DELETE /api/settings/email` proof requirement and error shapes. (api-contract docs are integrator-facing — no emdashes.)
5. On landing, the architect updates the § 6.4 row's implementation reference (architect owns ARCHITECTURE.md; flag at review).

## Acceptance

- JWT path: `DELETE /api/settings/email` without a valid `fresh_auth_proof` → `401 FRESH_AUTH_REQUIRED`; with a valid matching proof → `200` and the account is erased; a proof minted for a different action (e.g. change-email) → rejected (target mismatch).
- Keychain (signature) path: a fresh signed request with no body proof still succeeds (no regression for self-custody / state-D Keychain users).
- The fresh-auth factor required matches the account's registered factors per the § 6.4 row (a state-C account uses ORCID proof, a state-A account uses password proof).
- Route tests cover the 401-without-proof, 200-with-proof, and cross-action-target-mismatch cases. Per the test carve-out in root `CLAUDE.md`, auth-focused tests must exercise real `verifyHiveSignature` against signed requests, not the mock fixture.
- The settings api-contract doc reflects the new requirement.

## Coordination

The user-facing deletion confirmation UX (clear "all PEvO data is erased" + "your Hive account survives; re-import your seed phrase into Keychain to continue as self-custody" copy, plus presenting the fresh-auth challenge before the DELETE call, plus logging the session out after success) is a separate UI task: `ui-account-delete-consequences-and-fresh-auth`. The UI proof-challenge wiring integrates once this backend gate lands; the warning-copy + post-delete-logout portions are independent and can proceed in parallel.

## Non-goals

- Re-auditing the other settings routes (covered by the change-email cluster, now archived).
- Renaming the endpoint. `DELETE /api/settings/email` erasing the whole account (rather than just nulling the email column) is surprising REST, but renaming is an API-shape change out of scope for this security gate; note it for a possible future task rather than bundling it here.

## Backend completion signal (2026-05-26)

Gate landed, mirroring the change-email consume side present at `POST /api/settings/email`.

- **fresh-auth.ts.** Added `delete_account` to the `FreshAuthTargetAction` union and a `deleteAccountFreshAuthTarget(username)` helper binding `(delete_account, <username>, '')`. The distinct `action` value (length-prefixed into the target hash) is what blocks a change-email / set-password proof from being replayed as an erasure.
- **settings.ts `DELETE /email`.** Reads `req.hiveAuthMethod`. On the JWT path it consumes a `fresh_auth_proof` bound to the delete-account target: missing/expired → `401 FRESH_AUTH_REQUIRED`; username/target/kind mismatch → `403` (a change-email or set-password proof rejects with `target_mismatch`); a mechanism not registered on the account → `401` with `reason: wrong_mechanism` (closed-default per § 6.4: A→password, B→either, C→ORCID, D→preserved). The gate runs after the row-existence check and before the destructive transaction. The Keychain (Hive-signature) path requires no body proof (fresh at the middleware).
- **Mint paths widened.** `POST /api/custody/fresh-auth` (password mechanism) and `POST /api/orcid/start { mode: 'fresh_auth' }` (ORCID mechanism) accept `action: 'delete_account'`.

**Test.** `tests/routes/settings-email-delete-fresh-auth.test.ts` (new, auth-focused, real `verifyHiveSignature` — no `MOCK_VERIFY_SIGNATURE`): JWT no-proof → 401 missing; valid `delete_account` proof → 200 + account erased (states A and C); cross-action `change_email`/`set_password` proofs → 403 target_mismatch (not erased); wrong-mechanism (state A + ORCID proof) → 401 (not erased); real Hive-signature Keychain request with no body proof → 200 + erased (self-custody / state-D no-regression). Only `hiveClient.database.getAccounts` is stubbed for a deterministic keypair; the signature path runs real cryptographic recovery + posting-key match.

**Verification.** `npm run typecheck` clean (src + tests); `npm run lint` clean on touched files; targeted `npx vitest run tests/routes/settings-email-delete-fresh-auth.test.ts` green against real Postgres/Redis (10 specs).

### [TODO Architect] — contract + ARCHITECTURE edits (architect-owned; backend did NOT touch them)

1. **`agents/docs/api-contracts/settings.md`** — document the new `DELETE /api/settings/email` re-auth requirement (integrator-facing, no emdashes):
   - JWT (Bearer) path requires a body `fresh_auth_proof` minted for the `delete_account` action. Obtain via `POST /api/custody/fresh-auth { action: "delete_account" }` (password mechanism, states A/B) or `POST /api/orcid/start { mode: "fresh_auth", action: "delete_account" }` then `POST /api/orcid/callback` (ORCID mechanism, states B/C/D). The proof mechanism must match a factor registered on the account (A password, B password or ORCID, C ORCID, D preserved).
   - Keychain (Hive-signature) path requires no body proof.
   - Error shapes: missing/expired proof → `401 FRESH_AUTH_REQUIRED` with `details.reason` of `missing` or `expired`; proof bound to a different user/target/kind → `403 FRESH_AUTH_REQUIRED` with `details.reason` of `username_mismatch` / `target_mismatch` / `kind_mismatch` (a change-email or set-password proof → `target_mismatch`); mechanism not registered → `401 FRESH_AUTH_REQUIRED` with `details.reason` of `wrong_mechanism`.
2. **`agents/docs/ARCHITECTURE.md` § 6.4** — the "Delete account data / right-to-erasure" row's "gate not yet implemented" marker can be updated to reference the implementing commit (task goal item 5).

Moves the task to review/.

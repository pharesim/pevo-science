# PEvO API Contract — Settings

Endpoints for account-level settings (email, password) that apply to the authenticated user.

All write endpoints are authenticated via `verifyHiveSignature` (Keychain signature or Bearer JWT from `/api/auth/session` or `/api/auth/login`).

---

### GET /api/settings/email

Read the authenticated account's email and password status. Used by the settings UI to decide which surfaces to show (add email, verify email, set password, etc.).

**Auth:** `verifyHiveSignature` (Bearer JWT or Keychain signature).

**Response `data`:**

```json
{
  "hasEmail": true,
  "email": "j***h@***.com",
  "verified": true,
  "custody": "light",
  "pendingChange": false,
  "hasPassword": false
}
```

- `hasPassword` — `true` when the account has `password_hash` set; `false` for ORCID-only signups that opted out of password, or recovered accounts that skipped password reset. The UI should show a "Set a password" surface when `hasPassword` is `false`. Renamed from snake_case `has_password` to align with the rest of the response object's camelCase casing.
- `hasEmail` / `email` / `verified` / `pendingChange` — existing email-management fields (unchanged).
- `custody` — `"self"` for upgraded/Keychain accounts, `"light"` otherwise.

When the authenticated user has no account row (Keychain user who never added an email), the response is `{ hasEmail: false, custody: 'self', hasPassword: false }`.

---

### POST /api/settings/email

Add or change the authenticated account's email. Sends a verification link to the new address; email is not switched until `GET /api/settings/email/verify/:token` is hit.

**Auth:** `verifyHiveSignature`.

**Body shape depends on the path:**

- **Change-email branch on an existing row, JWT-authenticated:** `{ "email": "new@example.com", "fresh_auth_proof": "<single-use token>" }`. A fresh-auth proof is required; the proof's `mechanism` must match a factor registered on the account (state A: `password`; state B: `password` or `orcid`; state C: `orcid`; state D: matches the preserved password/orcid columns). The proof is bound to `(change_email, <username>, '')`; mint via `POST /api/orcid/start mode='fresh_auth' action='change_email'` (ORCID factor) or `POST /api/custody/fresh-auth action='change_email'` (password factor) once those mint paths are live; until then, change-email on the JWT path is gated closed-default. See ARCHITECTURE.md § 6.4 row "Change email" for the per-state contract.
- **Keychain (Hive-signature) authenticated:** `{ "email": "new@example.com" }`. No body proof required — the signed canonical message is already fresh-proof-bound at the middleware.
- **Add-flow no-row branch (account has no `accounts` row yet):** Reachable only from the Keychain path (no JWT is minted before a row exists). Body is `{ "email": "new@example.com" }`; no body proof.

**Response `data`:** `{ "message": "Verification email sent" }`

**Errors:**
- `VALIDATION_ERROR` — invalid or missing email
- `DUPLICATE` — email is already linked to another account (including another account's `pending_email`)
- `FRESH_AUTH_REQUIRED` (401) — `details.reason ∈ {"missing", "expired", "malformed", "wrong_mechanism"}`. `missing` fires when the JWT path body has no `fresh_auth_proof`; `expired` fires when the proof has been consumed, exceeded its TTL (5 min), or is unknown; `malformed` fires on token-format failure; `wrong_mechanism` fires when the proof's mechanism does not match the per-state matrix (e.g., a `password`-mechanism proof submitted against a state-C account that has no password registered).
- `FRESH_AUTH_REQUIRED` (403) — `details.reason ∈ {"username_mismatch", "target_mismatch", "kind_mismatch"}`. `username_mismatch` fires when the proof was issued for a different user than the JWT subject; `target_mismatch` fires when the proof's target hash does not match the change-email binding (e.g., a consent-op proof replayed at this surface); `kind_mismatch` fires when a session-kind proof is submitted to this consent-op-kind consume surface.

---

### GET /api/settings/email/verify/:token

Confirm an email address via a one-time token (from the link sent by `POST /api/settings/email`).

**Auth:** none (unauthenticated — the token itself is the proof).

**Response `data`:** `{ "verified": true }`

**Errors:**
- `INVALID_TOKEN` — token not found or expired

---

### DELETE /api/settings/email

Delete the authenticated account's email and all associated data (notification preferences, pending recovery rows, and the account row itself; custody audit log rows are anonymized in place rather than deleted). This is the de-facto right-to-erasure path: it removes the entire account, not just the email column. For light accounts this removes login access; Keychain self-custody users lose only their email subscription. The on-chain Hive account is untouched, so a light user who still holds their BIP39 seed phrase can re-import it into Keychain and continue as pure self-custody.

**Auth:** `verifyHiveSignature` (Bearer JWT or Keychain signature).

**Re-auth:** account erasure is a critical action, so a fresh-auth proof is required on the JWT path. The Keychain (Hive-signature) path is fresh at the middleware and needs no body proof. On the JWT path the body must carry a `fresh_auth_proof` bound to the `delete_account` action (target `(delete_account, <username>, '')`), and the proof's `mechanism` must match a factor registered on the account (state A: `password`; state B: `password` or `orcid`; state C: `orcid`; state D: matches the preserved password/orcid columns). A proof minted for a different action (`change_email` or `set_password`) is rejected as a cross-action replay. Mint via `POST /api/custody/fresh-auth action='delete_account'` (password factor) or `POST /api/orcid/start mode='fresh_auth' action='delete_account'` then `POST /api/orcid/callback` (ORCID factor). See ARCHITECTURE.md § 6.4 row "Delete account data / right-to-erasure" for the per-state contract. Implemented at `settings.ts` DELETE /email (commit `6dd1f8b5`).

**Body:** `{ "confirm": true, "fresh_auth_proof": "<single-use token>" }`. The JWT path requires `fresh_auth_proof`; the Keychain path requires only `confirm: true`.

**Response `data`:** `{ "deleted": true }`

**Errors:**
- `VALIDATION_ERROR` (400) when `confirm: true` is not provided.
- `UNAUTHORIZED` (401) when no account row exists for the authenticated user. Returned instead of 404 for the same enumeration-oracle reason documented under POST /api/settings/set-password: a holder of a stale JWT must not be able to distinguish account-deleted from other authed-error states by status code.
- `FRESH_AUTH_REQUIRED` (401) with `details.reason ∈ {"missing", "expired", "malformed", "wrong_mechanism"}`. Same taxonomy as POST /api/settings/email above. `missing` fires when the JWT path body carries no `fresh_auth_proof`; `wrong_mechanism` fires when the proof's mechanism is not registered on the account (for example, an ORCID-mechanism proof against a state-A password-only account).
- `FRESH_AUTH_REQUIRED` (403) with `details.reason ∈ {"username_mismatch", "target_mismatch", "kind_mismatch"}`. Same taxonomy as POST /api/settings/email above; a `change_email` or `set_password` proof replayed here returns `target_mismatch`.

---

### POST /api/settings/set-password

Opt into password login for an account that currently has `password_hash IS NULL`. This is the path ORCID-only signups and null-password-recovered accounts use to enable email/username + password login without re-running the signup flow.

**Auth:** `verifyHiveSignature` (Bearer JWT or Keychain signature).

**Body:**

```json
{ "password": "NewSecurePass1", "fresh_auth_proof": "<single-use token>" }
```

`fresh_auth_proof` is REQUIRED on all paths. State C is the only state that reaches this handler (states A/B short-circuit on `PASSWORD_ALREADY_SET` 409; state D rows with `password_hash IS NOT NULL` likewise; the state-A degenerate without ORCID returns `ORCID_REQUIRED` 403). State C has no password to base a password fresh-auth on, so the proof's `mechanism` MUST be `'orcid'`; `password`-mechanism proofs are structurally invalid here and return `FRESH_AUTH_REQUIRED` 401 with `details.reason: "wrong_mechanism"`. Mint via `POST /api/orcid/start mode='fresh_auth' action='set_password'` (no `root_author`/`root_permlink` body fields needed — the backend synthesizes the target from the authenticated username). The proof binds to `(set_password, <username>, '')`. See ARCHITECTURE.md § 6.4 row "Set password from null" for the per-state contract.

Password must meet the signup policy: at least 10 characters with lowercase, uppercase, and numbers. Validated server-side via the shared `backend/src/lib/password-policy.ts` `isPasswordValid` helper, mirrored by `frontend/src/password-policy.js`.

**Response `data`:** `{ "message": "Password set. You can now log in with your email/username and this password." }`

**Rate limit:** 10 writes per IP per minute (shared with other settings writes).

**Errors:**
- `VALIDATION_ERROR` — password missing, too short, or missing required character classes
- `UNAUTHORIZED` (401) — no account row for the authenticated user (session is no longer valid). Returned instead of 404 because, for an authed endpoint, "your account no longer exists" is functionally equivalent to "your session is invalid" — flipping to 401 closes a small enumeration oracle (a holder of a stale JWT could otherwise distinguish account-deleted from other authed-error states by status code). The same 404→401 treatment applies to `DELETE /api/settings/email`, `POST /api/custody/broadcast`, and `POST /api/custody/upgrade`.
- `ORCID_REQUIRED` (403) — caller has no linked ORCID. The set-password opt-in is deliberately scoped to ORCID-verified accounts: today only ORCID-path signup/recover leaves `password_hash IS NULL`, but the runtime guard makes the invariant explicit so future flows that null the hash for other reasons cannot silently inherit set-password eligibility.
- `PASSWORD_ALREADY_SET` (409) — account already has a password. Use the (separate) change-password flow, which must require the current password to authorize the rotation. Rotating a known password via `set-password` is deliberately disallowed because `set-password` authenticates via Keychain or JWT only; allowing it to overwrite an existing hash would let any live JWT silently rotate the password without re-proving the current one.
- `SERVICE_UNAVAILABLE` (503) — argon2 capacity exhausted or backend draining. See [common.md](common.md).
- `FRESH_AUTH_REQUIRED` (401) — `details.reason ∈ {"missing", "expired", "malformed", "wrong_mechanism"}`. Same taxonomy as POST /api/settings/email above. `wrong_mechanism` on this route specifically fires when the proof's mechanism is not `'orcid'` (state C has no password, so a password-mechanism proof is invalid here).
- `FRESH_AUTH_REQUIRED` (403) — `details.reason ∈ {"username_mismatch", "target_mismatch", "kind_mismatch"}`. Same taxonomy as POST /api/settings/email above.

**Why a distinct endpoint from `/api/auth/reset`:** `/api/auth/reset` is token-gated (email reset link) and targets the "I lost my password" path. `POST /api/settings/set-password` is session-gated and targets the "I never had one" path — no email round-trip required, and the account must be in the `password_hash IS NULL` state.

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
  "email": "j***h@example.com",
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

**Body:** `{ "email": "new@example.com" }`

**Response `data`:** `{ "message": "Verification email sent" }`

**Errors:**
- `VALIDATION_ERROR` — invalid or missing email
- `DUPLICATE` — email is already linked to another account (including another account's `pending_email`)

---

### GET /api/settings/email/verify/:token

Confirm an email address via a one-time token (from the link sent by `POST /api/settings/email`).

**Auth:** none (unauthenticated — the token itself is the proof).

**Response `data`:** `{ "verified": true }`

**Errors:**
- `INVALID_TOKEN` — token not found or expired

---

### DELETE /api/settings/email

Delete the authenticated account's email and all associated data (notification preferences, custody audit log, the account row itself). For light accounts this removes login access — Keychain self-custody users lose only their email subscription.

**Auth:** `verifyHiveSignature`.

**Body:** `{ "confirm": true }` (literal)

**Response `data`:** `{ "deleted": true }`

**Errors:**
- `VALIDATION_ERROR` — `confirm: true` not provided
- `NOT_FOUND` — no account row for the authenticated user

---

### POST /api/settings/set-password

Opt into password login for an account that currently has `password_hash IS NULL`. This is the path ORCID-only signups and null-password-recovered accounts use to enable email/username + password login without re-running the signup flow.

**Auth:** `verifyHiveSignature` (Bearer JWT or Keychain signature).

**Body:**

```json
{ "password": "NewSecurePass1" }
```

Password must meet the signup policy: at least 10 characters with lowercase, uppercase, and numbers. Validated server-side via the shared `backend/src/lib/password-policy.ts` `isPasswordValid` helper, mirrored by `frontend/src/password-policy.js`.

**Response `data`:** `{ "message": "Password set. You can now log in with your email/username and this password." }`

**Rate limit:** 10 writes per IP per minute (shared with other settings writes).

**Errors:**
- `VALIDATION_ERROR` — password missing, too short, or missing required character classes
- `UNAUTHORIZED` (401) — no account row for the authenticated user (session is no longer valid). Returned instead of 404 because, for an authed endpoint, "your account no longer exists" is functionally equivalent to "your session is invalid" — flipping to 401 closes a small enumeration oracle (a holder of a stale JWT could otherwise distinguish account-deleted from other authed-error states by status code). The same 404→401 treatment applies to `DELETE /api/settings/email`, `POST /api/custody/broadcast`, and `POST /api/custody/upgrade`.
- `ORCID_REQUIRED` (403) — caller has no linked ORCID. The set-password opt-in is deliberately scoped to ORCID-verified accounts: today only ORCID-path signup/recover leaves `password_hash IS NULL`, but the runtime guard makes the invariant explicit so future flows that null the hash for other reasons cannot silently inherit set-password eligibility.
- `PASSWORD_ALREADY_SET` (409) — account already has a password. Use the (separate) change-password flow, which must require the current password to authorize the rotation. Rotating a known password via `set-password` is deliberately disallowed because `set-password` authenticates via Keychain or JWT only; allowing it to overwrite an existing hash would let any live JWT silently rotate the password without re-proving the current one.
- `SERVICE_UNAVAILABLE` (503) — argon2 capacity exhausted or backend draining. See [common.md](common.md).

**Why a distinct endpoint from `/api/auth/reset`:** `/api/auth/reset` is token-gated (email reset link) and targets the "I lost my password" path. `POST /api/settings/set-password` is session-gated and targets the "I never had one" path — no email round-trip required, and the account must be in the `password_hash IS NULL` state.

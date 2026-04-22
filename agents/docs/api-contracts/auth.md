# PEvO API Contract -- Auth

Endpoints for authentication, signup, login, password reset, and account recovery. ORCID OAuth endpoints have moved to [orcid.md](orcid.md).

---

### POST /api/auth/session

Create a session token. The client signs the request-bound message (see [common.md → Direct Hive Signature Authentication](common.md)) with Hive Keychain at login time, then exchanges it for a JWT that authenticates all subsequent API requests — no further Keychain popups needed.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`, `X-Hive-Timestamp`

**Body:** `{}` (empty JSON object; `Content-Type: application/json` required)

**Response `data`:** `SessionResponse`

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_at": "2026-03-27T14:30:00Z",
  "custody": "self"
}
```

- The JWT is valid for 24 hours. The frontend should store it in memory and include it as `Authorization: Bearer <token>` on all authenticated requests.
- `custody` is `"self"` for Keychain accounts, `"light"` for custodial accounts. The frontend uses this to route signing operations.
- When the token expires, the frontend should prompt the user to re-connect (which triggers a new Keychain sign + session creation).

**Rate limit:** 10 requests per account per hour.

**Errors:**
- `UNAUTHORIZED` — invalid or expired Hive signature

---

### POST /api/auth/signup

Register a light account. Two paths: email-based (institutional email required) or ORCID-based (verified ORCID with sufficient publications).

**Body:**

```json
{
  "email": "researcher@university.edu",
  "password": "SecurePass123",
  "full_name": "Dr. Jane Smith",
  "institution": "MIT",
  "field": "neuroscience",
  "orcid_token": "abc123..."                // optional -- nonce from /api/orcid/callback
}
```

**Without `orcid_token` (email path):**
- `email` -- required, must be from an institutional domain.
- `password` -- required, at least 10 characters with lowercase, uppercase, and numbers.
- `full_name`, `institution`, `field` -- required.

**With `orcid_token` (ORCID path):**
- `email` -- optional. Any domain accepted (no institutional requirement). When omitted, the account has no email (ORCID-only).
- `password` -- **optional** on the ORCID path, regardless of whether `email` is provided. When omitted, null, or empty, the account is stored with `password_hash = NULL`; subsequent password-login attempts return `403 NO_PASSWORD_SET` and the UI should direct the user to sign in via ORCID or recover via seed phrase. The user can opt into password login later via `POST /api/settings/set-password`. When supplied, the password must meet the signup policy (10+ chars with lowercase, uppercase, and numbers).
- `full_name` -- optional, falls back to name from ORCID profile.
- `institution`, `field` -- optional, default to empty string.
- `orcid_token` -- one-time nonce returned by `POST /api/orcid/callback` (signup mode). Backend validates against Redis and retrieves the verified ORCID iD. Consumed on use.

ORCID-path accounts skip email verification and go directly to the username/keys step (`/api/auth/confirm`).

Username selection and account creation happen later, at the `/api/auth/confirm` or `/api/auth/link` step.

**Response `data`:**

```json
{
  "message": "Verification email sent to r***r@***.edu",
  "expires_at": "2026-04-15T12:00:00Z"
}
```

**Rate limit:** 10 requests per IP per hour.

**Errors:**
- `VALIDATION_ERROR` — password too weak, or missing required fields
- `DUPLICATE` — email already registered or pending (fires BEFORE the accreditation gate; duplicate-email 409 is authoritative regardless of whether the domain is institutional)
- `ACCREDITATION_NOT_FOUND` — non-institutional email without valid `orcid_token`, on a non-duplicate email. Institution-is-accredited is public knowledge; the fast-return on this path is intentional.

---

### POST /api/auth/resend-verification

Resend the signup verification email. Requires the email and password to prevent abuse.

**Body:**

```json
{
  "email": "researcher@university.edu",
  "password": "SecurePass123"
}
```

**Response `data`:**

```json
{
  "message": "If that email has a pending signup, a new verification link has been sent."
}
```

Always returns the same generic success message regardless of account state (unknown email, already-active account, confirmed-but-pending, hex-pending). The uniform body is a privacy invariant: no observer can distinguish account states from this endpoint's 200 response.

**Rate limit:** 3 requests per IP per hour.

---

### POST /api/auth/verify

Verify the email token from a signup. Marks the account as confirmed and returns an `auth_token` for the next step (choosing between new account or linking an existing Hive account).

**Body:**

```json
{
  "token": "abc123..."
}
```

**Response `data`:**

```json
{
  "flow": "choose",
  "email": "researcher@university.edu",
  "auth_token": "confirmed:abc123..."
}
```

The `auth_token` is used in the subsequent `/api/auth/confirm` (new account) or `/api/auth/link` (existing Hive account) step.

**Errors:**
- `VALIDATION_ERROR` — missing or invalid token
- `BAD_REQUEST` — token not found or expired

---

### POST /api/auth/resume-signup

Resume an interrupted signup when the user has already verified their email but did not complete account creation. Authenticates via email and password, resets the token expiry, and returns the `auth_token` to continue.

**Body:**

```json
{
  "email": "researcher@university.edu",
  "password": "SecurePass123"
}
```

**Response `data`:**

```json
{
  "flow": "choose",
  "email": "researcher@university.edu",
  "auth_token": "confirmed:abc123..."
}
```

**Rate limit:** 5 requests per IP per hour.

**Errors:**
- `VALIDATION_ERROR` — missing email or password
- `BAD_REQUEST` — invalid credentials (returns an opaque `"Invalid email or password"` for all failure cases, including unverified email, to prevent enumeration)

---

### POST /api/auth/confirm

Create a new Hive account and complete the signup. The client generates a BIP39 mnemonic, derives all four key pairs, and sends the public keys plus the posting and memo private keys (which the backend encrypts and stores for server-side signing).

**Body:**

```json
{
  "auth_token": "confirmed:abc123...",
  "username": "researcher1",
  "keys": {
    "owner_public": "STM...",
    "active_public": "STM...",
    "posting_public": "STM...",
    "memo_public": "STM...",
    "posting_private": "5J...",
    "memo_private": "5J..."
  }
}
```

- `auth_token` — the token returned by `/api/auth/verify` or `/api/auth/resume-signup`
- `username` must be Hive-compatible (3-16 chars, lowercase a-z, 0-9, dots/hyphens)
- All six key fields are required. Public keys must be valid `STM`-prefixed keys.

**Response `data`:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_at": "2026-04-15T12:00:00Z",
  "custody": "light",
  "username": "researcher1",
  "block_num": 12345678
}
```

On success: Hive account created via `create_claimed_account`, posting and memo keys encrypted and stored, accreditation `custom_json` broadcast, JWT session issued.

**Errors:**
- `VALIDATION_ERROR` — missing fields, invalid key format, or invalid username
- `BAD_REQUEST` — invalid or expired auth token
- `DUPLICATE` — username already taken on Hive
- `INTERNAL_ERROR` — account creation failed (e.g., no available claim tokens)

---

### POST /api/auth/link

Link an existing Hive account to a verified PEvO signup. Requires Keychain signature proving ownership of the Hive account.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`, `X-Hive-Timestamp` (see [common.md → Direct Hive Signature Authentication](common.md) for the signed-message format)

**Body:**

```json
{
  "auth_token": "confirmed:abc123..."
}
```

The Hive username is extracted from the Keychain signature headers, not from the body.

**Response `data`:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_at": "2026-04-15T12:00:00Z",
  "custody": "self",
  "username": "existing-hive-user"
}
```

On success: account activated with `custody: "self"`, accreditation `custom_json` broadcast, JWT session issued.

**Errors:**
- `VALIDATION_ERROR` — missing auth token or Keychain signature
- `BAD_REQUEST` — invalid or expired auth token
- `NOT_FOUND` — Hive account does not exist
- `DUPLICATE` — Hive account already linked to another PEvO account

---

### POST /api/auth/login

Password-based login for light accounts.

**Body:**

```json
{
  "email_or_username": "researcher1",
  "password": "SecurePass123"
}
```

`email_or_username` accepts either the Hive username or email address. The legacy field name `username` is also accepted for backwards compatibility.

**Response `data`:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_at": "2026-04-15T12:00:00Z",
  "custody": "light",
  "username": "researcher1"
}
```

**Rate limit:** 10 requests per IP per hour. Account locked after 20 failed attempts (reset via password reset).

**Errors:**
- `UNAUTHORIZED` — invalid credentials
- `NO_PASSWORD_SET` (403) — account has `password_hash IS NULL` (ORCID-only signup, or ORCID recovery that skipped password). The UI should direct the user to sign in with ORCID or recover via seed phrase. Message: `"Account has no password; sign in with ORCID or recover via seed phrase"`. Distinct from 401 on purpose — collapsing this into "invalid credentials" would make password login indistinguishable from the wrong-password case and hide the correct remediation path from legitimate users. Backend implementation note (advisory, not contract): the null-hash branch burns a sentinel `argon2.verify` against a module-load-computed argon2id hash before returning the 403, so its wall-time matches the real-hash verify path. This closes the per-request timing oracle that would otherwise let an unauthenticated attacker enumerate ORCID-only accounts (~1ms vs ~100ms before the equalization). The status-code axis (403 vs 401) is an accepted tradeoff — the feature-distinct error is UX-valuable for legitimate ORCID users, and status-code oracles are weaker than the prior 100x timing gap.
- `ACCOUNT_LOCKED` (403) — too many failed attempts
- `PENDING_SIGNUP` (409) — email verified but signup not completed. Response includes `auth_token` and `email` to resume.
- `PENDING_UNVERIFIED` (409) — email not yet verified
- `SIGNUP_EXPIRED` (410) — signup expired, user must re-register

---

### POST /api/auth/reset-request

Request a password reset email.

**Body:**

```json
{
  "email": "researcher@university.edu"
}
```

**Response `data`:**

```json
{
  "message": "If an account exists with that email, a reset link has been sent."
}
```

Always returns success to prevent email enumeration.

**Rate limit:** 5 requests per IP per hour.

---

### POST /api/auth/reset

Set a new password using a reset token.

**Body:**

```json
{
  "token": "abc123...",
  "password": "NewSecurePass456"
}
```

**Response `data`:**

```json
{
  "message": "Password has been reset. Please log in with your new password."
}
```

Invalidates all existing sessions for the account.

**Rate limit:** 5 requests per IP per hour.

**Errors:**
- `INVALID_TOKEN` — token not found or expired
- `VALIDATION_ERROR` — password does not meet requirements

---

### POST /api/auth/recover

Recover a light account when the user has lost access to their email. Requires either a seed-phrase-derived memo key or a verified ORCID token as proof of identity.

**Body (seed phrase recovery):**

```json
{
  "username": "researcher1",
  "memo_key": "5J...",
  "new_email": "new@university.edu",
  "new_password": "NewSecurePass456"
}
```

- `new_password` is **required** on seed-phrase recovery. Memo-key knowledge is the only credential the user just proved; forcing a fresh password keeps the account password-loginable.

**Body (ORCID recovery):**

```json
{
  "username": "researcher1",
  "orcid_token": "abc123...",
  "new_email": "new@university.edu",
  "new_password": "NewSecurePass456"          // optional
}
```

- `new_password` is **optional** on ORCID recovery. When omitted, null, or empty, `password_hash` is set to `NULL` — password login is disabled for the account until the user opts in via `POST /api/settings/set-password`. Subsequent password-login attempts return `403 NO_PASSWORD_SET`. Seed-phrase recovery remains available on null-hash accounts.
- When supplied, the password must meet the signup policy (10+ chars with lowercase, uppercase, and numbers — same `isPasswordValid` helper used by signup).

For ORCID recovery, obtain `orcid_token` via `POST /api/orcid/start` (mode: `signup`) and `POST /api/orcid/callback` first. The backend verifies the ORCID iD from the token matches the account's stored ORCID. Note: the ORCID recovery path does not re-check `ORCID_MIN_WORKS`. It only verifies identity match, since the ORCID was already validated during signup.

**Response `data`:**

```json
{
  "token": "eyJhbG...",
  "expires_at": "2026-04-19T12:00:00.000Z",
  "custody": "light",
  "username": "researcher1"
}
```

Updates email, resets password, invalidates all existing sessions, and returns a new JWT.

**Rate limit:** 10 requests per IP per hour.

**Errors:**
- `VALIDATION_ERROR` — missing fields, weak password, no recovery method provided, OR **both `memo_key` and `orcid_token` supplied simultaneously**. Exactly one credential must be presented. Message: `"Supply exactly one of memo_key or orcid_token, not both"`.
- `NOT_FOUND` — no active account with that username
- `UNAUTHORIZED` — memo key mismatch, no ORCID on account, invalid/expired ORCID token, or ORCID mismatch
- `DUPLICATE` — new email already in use by another account

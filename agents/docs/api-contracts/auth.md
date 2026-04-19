# PEvO API Contract — Auth

Endpoints for authentication, signup, login, password reset, and account recovery.

---

### POST /api/auth/session

Create a session token. The client signs a challenge with Hive Keychain at login time, then exchanges it for a JWT that authenticates all subsequent API requests — no further Keychain popups needed.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`, `X-Hive-Message`, `X-Hive-Timestamp`

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

Register a light account. Accreditation requires **either** an institutional email address **or** a verified ORCID with sufficient publications (configured via `ORCID_MIN_WORKS`, default 3). Non-institutional emails are accepted when a valid `orcid_token` is provided.

**Body:**

```json
{
  "email": "researcher@university.edu",
  "password": "SecurePass123",
  "full_name": "Dr. Jane Smith",
  "institution": "MIT",
  "field": "neuroscience",
  "orcid_token": "abc123..."                // optional — nonce from /api/auth/orcid/callback
}
```

- `email` — any valid email. If not from an institutional domain, `orcid_token` is required.
- `password` must be at least 10 characters with lowercase, uppercase, and numbers.
- `full_name`, `institution`, `field` — required accreditation details, stored with the account.
- `orcid_token` (optional) — one-time nonce returned by `/api/auth/orcid/callback`. Backend validates against Redis and retrieves the verified ORCID iD. Consumed on use.

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
- `VALIDATION_ERROR` — non-institutional email without valid `orcid_token`, password too weak, or missing required fields
- `DUPLICATE` — email already registered or pending

---

### POST /api/auth/orcid/start

Initiate ORCID OAuth for the signup flow. No authentication required. Generates a state parameter stored in Redis and returns the ORCID authorization URL.

**Body:** _(none)_

**Response `data`:**

```json
{
  "redirect_url": "https://orcid.org/oauth/authorize?client_id=...&response_type=code&scope=/authenticate+/read-limited&redirect_uri=...&state=..."
}
```

**Rate limit:** 10 requests per IP per minute.

**Errors:**
- `INTERNAL_ERROR` — ORCID integration not configured

---

### POST /api/auth/orcid/callback

Complete the signup ORCID OAuth flow. Exchanges the authorization code for an access token, fetches the ORCID profile via the public API, and checks that the profile has at least `ORCID_MIN_WORKS` (default 3) works with an external source (Crossref, DataCite, Scopus — not self-asserted). On success, stores the verified ORCID iD in Redis keyed by a one-time nonce and returns that nonce.

**Body:**

```json
{
  "code": "<ORCID authorization code>",
  "state": "<state from OAuth redirect>"
}
```

**Response `data`:**

```json
{
  "orcid_token": "<one-time nonce>",
  "orcid_id": "0000-0001-2345-6789",
  "works_count": 5
}
```

The `orcid_token` is valid for 30 minutes and consumed when used in `/api/auth/signup`. The `orcid_id` and `works_count` are returned for display purposes only — the backend re-reads the verified ORCID iD from Redis using the nonce, never trusting the client.

**Errors:**
- `BAD_REQUEST` — invalid/expired state or authorization code
- `VALIDATION_ERROR` — ORCID profile has fewer than `ORCID_MIN_WORKS` externally-sourced works
- `INTERNAL_ERROR` — ORCID API unreachable

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

Always returns a generic success message to prevent email enumeration. If the account is already active, returns `"Your account is already active. Please log in."`.

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

**Headers:** `X-Hive-Username`, `X-Hive-Signature`, `X-Hive-Message`

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

**Body (ORCID recovery):**

```json
{
  "username": "researcher1",
  "orcid_token": "abc123...",
  "new_email": "new@university.edu",
  "new_password": "NewSecurePass456"
}
```

For ORCID recovery, obtain `orcid_token` via the existing `POST /api/auth/orcid/start` and `POST /api/auth/orcid/callback` flow first. The backend verifies the ORCID iD from the token matches the account's stored ORCID. Note: the ORCID recovery path does not re-check `ORCID_MIN_WORKS`. It only verifies identity match, since the ORCID was already validated during signup.

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
- `VALIDATION_ERROR` — missing fields, weak password, or no recovery method provided
- `NOT_FOUND` — no active account with that username
- `UNAUTHORIZED` — memo key mismatch, no ORCID on account, invalid/expired ORCID token, or ORCID mismatch
- `DUPLICATE` — new email already in use by another account

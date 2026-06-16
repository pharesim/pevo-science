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
- `ORCID_ALREADY_LINKED` (409) -- the supplied `orcid_token`'s ORCID is already bound to another account row (the `accounts_orcid_unique` partial index). Same terminal wire shape as the `/orcid/callback` durable-binding 409 (no `retriable` field, no `Retry-After` header). Previously surfaced as `INTERNAL_ERROR` (500). Recovery is terminal: the ORCID is already bound to a different account, so a resubmit cannot succeed, and the single-use verification nonce is already consumed (a same-`orcid_token` resubmit falls through to the missing/invalid-token `422`). Clients MUST NOT blindly resubmit the same `orcid_token`; route the user to log into the existing account, or restart the ORCID OAuth flow from `/api/orcid/start` for a different ORCID.
- `ACCREDITATION_NOT_FOUND` — non-institutional email without valid `orcid_token`, on a non-duplicate email. Institution-is-accredited is public knowledge; the fast-return on this path is intentional.
- `SERVICE_UNAVAILABLE` (503) — argon2 capacity exhausted or backend draining. Both the duplicate-email burn path and the new-account hash path emit 503 under saturation, so the 503 outcome does not distinguish registration status. See [common.md → Standard Error Codes](common.md) for the cross-route 503 contract and `Retry-After` semantics.

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

**Errors:**
- `SERVICE_UNAVAILABLE` (503) — argon2 capacity exhausted or backend draining. Fires uniformly regardless of email state, preserving the privacy invariant. See [common.md](common.md).

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

**Sets cookie:** `pevo_signup_session` (httpOnly, `sameSite=lax`, `secure` in production, `path=/api/auth`, max-age 24h). This binding cookie is required by the subsequent `/api/auth/confirm` and `/api/auth/link` calls. The `auth_token` alone is not sufficient. Same-origin XHRs must send credentials so the cookie is stored from `Set-Cookie` and re-sent.

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

**Sets cookie:** `pevo_signup_session` (httpOnly, `sameSite=lax`, `secure` in production, `path=/api/auth`, max-age 24h), the same binding cookie minted by `/api/auth/verify`. A `PENDING_SIGNUP` user who arrives via the login redirect re-verifies their password here to obtain a fresh cookie before `/api/auth/confirm` or `/api/auth/link` will accept the request.

**Rate limit:** 5 requests per IP per hour.

**Errors:**
- `VALIDATION_ERROR` — missing email or password
- `BAD_REQUEST` — invalid credentials (returns an opaque `"Invalid email or password"` for all failure cases, including unverified email, to prevent enumeration)
- `SERVICE_UNAVAILABLE` (503) — argon2 capacity exhausted or backend draining. The 503 path equalizes against the password-verify path so the 503 outcome does not distinguish credential-validity. See [common.md](common.md).

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

**Requires cookie:** the `pevo_signup_session` binding cookie minted by `/api/auth/verify` or `/api/auth/resume-signup`. The request is rejected without it. The `auth_token` is the row-lookup credential, not the authorization proof, so it is not sufficient on its own. The SPA sends the cookie via `credentials: 'same-origin'`.

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
- `ORCID_ALREADY_LINKED` (409) -- the finalizing account's ORCID is already accredited on-chain to a *different* account. Fires at the finalize-time accreditation broadcast guard (a chain plus binding-cache check, run under the ORCID binding lock), and is distinct from the `/api/auth/signup` `accounts_orcid_unique` cause above: this one fires *after* the account row and keys are persisted, so the account stays finalized but unaccredited and recoverable (the user can log in and is simply unaccredited until the ORCID conflict is resolved out of band). Same terminal wire shape as the `/orcid/callback` durable-binding 409 and the `/signup` DB-index 409 (no `retriable` field, no `Retry-After` header). Resubmitting the same ORCID cannot succeed; the on-chain binding is authoritative.
- `INTERNAL_ERROR` — account creation failed (e.g., no on-chain `pending_claimed_accounts` capacity on the onboarding account, transient HAF/Hive read failure, or chain-side rejection of `create_claimed_account`). The platform reads chain capacity directly via `getCachedPendingClaimedAccounts()` (10s Redis cache); there is no DB token mirror.
- `POST_BROADCAST_FAILED`: the on-chain `create_claimed_account` and accreditation broadcast both landed, but a downstream non-blocking step (reputation seed) failed transiently. The user's account is recoverable on a subsequent retry via the resume-on-/confirm flow, and that retry is idempotent (the resume branch finalizes against the already-landed broadcast, so it cannot double-bind). Because the chain op is durable, the client should treat the operation as successful from the user's perspective and not prompt a retry. See [common.md](common.md) for the no-prompt client contract, the global handler shape, and the per-attempt vs error event role split.
- `POST_BROADCAST_OPERATOR_REQUIRED`: the on-chain broadcasts landed but a downstream step failed permanently (e.g., programmer error such as a reputation seed shape regression). The user's account state is recoverable on subsequent retry. The permanent failure is recorded via a `post_broadcast_write_failed` log event (severity `permanent`) for operator follow-up; outbound alerting (PagerDuty/Slack/email) is deferred, so the interim operator signal is the log stream, not a paged alert. See [common.md](common.md).
- `BROADCAST_TIMEOUT` (504) -- the accreditation broadcast's outcome is uncertain from this request's view. `details` carries `retriable: false`, `outcome: "uncertain"`, `verify_before_retry: true`, and no `verify_location` (recovery is in-band, below). The account row is already finalized when this fires (it surfaces during the post-finalize accreditation broadcast), so the user is set up and may already be accredited if the timed-out broadcast landed. Three triggers collapse to this one shape: (1) a genuine broadcast timeout (`BroadcastTimeoutError`, which additionally carries `details.timeout_ms`); (2) a Redis-`unavailable` forced-ambiguous outcome when the ORCID binding lock cannot be taken; and (3) a self-held binding lock -- this account's OWN prior finalize attempt timed out and extended the ORCID binding lock across the ~120s HAF-indexing-lag window, and a retry within that window finds it held (this case carries no `timeout_ms`). Distinct from the terminal cross-account `409 ORCID_ALREADY_LINKED` above: the signup `auth_token` is not consumed on this path (a retry re-enters the username-keyed resume branch), so it is recoverable, not terminal. Recovery: verify accreditation, then retry `POST /api/auth/confirm` with the same `auth_token`, `username`, and `keys`; the resume branch finalizes idempotently if the broadcast already landed.

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

**Requires cookie:** the `pevo_signup_session` binding cookie minted by `/api/auth/verify` or `/api/auth/resume-signup`. The request is rejected without it. The `auth_token` is the row-lookup credential, not the authorization proof, so it is not sufficient on its own. This is in addition to the Keychain signature headers. The SPA sends the cookie via `credentials: 'same-origin'`.

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
- `ORCID_ALREADY_LINKED` (409) -- the linking account's ORCID is already accredited on-chain to a *different* account. Fires at the finalize-time accreditation broadcast guard (a chain plus binding-cache check, run under the ORCID binding lock), distinct from the `/api/auth/signup` `accounts_orcid_unique` cause: it fires *after* the account is activated (`custody: "self"`, keys in place), so the account stays finalized but unaccredited and recoverable (the user can log in, simply unaccredited until the ORCID conflict is resolved out of band). Same terminal wire shape as the `/orcid/callback` durable-binding 409 and the `/signup` DB-index 409 (no `retriable` field, no `Retry-After` header). Resubmitting the same ORCID cannot succeed; the on-chain binding is authoritative.
- `POST_BROADCAST_FAILED`: the accreditation broadcast landed but a downstream non-blocking step (reputation seed) failed transiently. The user's account is recoverable on a subsequent retry via the resume-on-/link flow, and that retry is idempotent (the resume branch finalizes against the already-landed broadcast, so it cannot double-bind). Because the chain op is durable, the client should treat the operation as successful from the user's perspective and not prompt a retry. See [common.md](common.md) for the no-prompt client contract, the global handler shape, and the per-attempt vs error event role split.
- `POST_BROADCAST_OPERATOR_REQUIRED`: the accreditation broadcast landed but a downstream step failed permanently (e.g., programmer error such as a reputation seed shape regression). The user's account state is recoverable on subsequent retry. The permanent failure is recorded via a `post_broadcast_write_failed` log event (severity `permanent`) for operator follow-up; outbound alerting (PagerDuty/Slack/email) is deferred, so the interim operator signal is the log stream, not a paged alert. See [common.md](common.md).
- `BROADCAST_TIMEOUT` (504) -- the accreditation broadcast's outcome is uncertain from this request's view. `details` carries `retriable: false`, `outcome: "uncertain"`, `verify_before_retry: true`, and no `verify_location`. The account is already activated (`custody: "self"`) when this fires, so the user is set up and may already be accredited if the timed-out broadcast landed. Same three triggers as `/confirm`: a genuine broadcast timeout (with `details.timeout_ms`), a Redis-`unavailable` forced-ambiguous outcome, or a self-held ORCID binding lock from this account's own prior timed-out attempt within the ~120s HAF-indexing-lag window (no `timeout_ms`). Distinct from the terminal cross-account `409 ORCID_ALREADY_LINKED` above: the signup `auth_token` is not consumed on this path (a retry re-enters the username-keyed resume branch), so it is recoverable, not terminal. Recovery: verify accreditation, then retry `POST /api/auth/link` with a fresh Keychain-signed request and the same `auth_token`; the resume branch finalizes idempotently if the broadcast already landed.

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
- `PENDING_SIGNUP` (409): email verified but signup not completed. Response `data` contains `{ email }` only. The `auth_token` is NOT returned here (it is the row-lookup credential for `/confirm` and `/link`, and returning it in the login response leaked it via referer/proxy logs). To resume, route the user to `/api/auth/resume-signup` (password re-verify), which mints the binding cookie and returns a fresh `auth_token` in its response body.
- `PENDING_UNVERIFIED` (409) — email not yet verified
- `SIGNUP_EXPIRED` (410) — signup expired, user must re-register
- `SERVICE_UNAVAILABLE` (503) — argon2 capacity exhausted or backend draining. See [common.md](common.md).

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

**Errors:**
- `SERVICE_UNAVAILABLE` (503) — argon2 capacity exhausted or backend draining. Fires uniformly regardless of account existence, preserving the enumeration-prevention invariant. See [common.md](common.md).

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
- `SERVICE_UNAVAILABLE` (503) — argon2 capacity exhausted or backend draining. See [common.md](common.md).

---

### POST /api/auth/recover

Recover a light account when the user has lost access to their email. Requires either a seed-phrase-derived memo key or a verified ORCID token as proof of identity. The two paths behave differently. The memo-key (seed-phrase) path is **two-phase**: it stages the requested change and does not touch the account until the new email proves control via `POST /api/auth/recover/verify`. The ORCID path applies immediately, because the fresh OAuth round-trip is itself the email-side control proof the memo-key path lacks.

**Body (seed phrase recovery):**

```json
{
  "username": "researcher1",
  "memo_key": "5J...",
  "new_email": "new@university.edu",
  "new_password": "NewSecurePass456"
}
```

- `new_password` is **required** on seed-phrase recovery. Memo-key knowledge is the only credential the user just proved, so forcing a fresh password keeps the account password-loginable.

**Body (ORCID recovery):**

```json
{
  "username": "researcher1",
  "orcid_token": "abc123...",
  "new_email": "new@university.edu",
  "new_password": "NewSecurePass456"          // optional
}
```

- `new_password` is **optional** on ORCID recovery. When omitted, null, or empty, `password_hash` is set to `NULL`, which disables password login until the user opts in via `POST /api/settings/set-password`. Subsequent password-login attempts return `403 NO_PASSWORD_SET`. Seed-phrase recovery remains available on null-hash accounts.
- When supplied, the password must meet the signup policy (10+ chars with lowercase, uppercase, and numbers, the same `isPasswordValid` helper used by signup).

For ORCID recovery, obtain `orcid_token` via `POST /api/orcid/start` (mode: `signup`) and `POST /api/orcid/callback` first. The backend verifies the ORCID iD from the token matches the account's stored ORCID. Note: the ORCID recovery path does not re-check `ORCID_MIN_WORKS`. It only verifies identity match, since the ORCID was already validated during signup. ORCID recovery is severed once the account has upgraded to self-custody (state D): a `upgraded_at IS NOT NULL` account is under on-chain (Keychain) control, and a stored ORCID link must not trigger a server-side rebind.

**Response `data` is path-dependent.**

**Seed-phrase (memo-key) path, success (200):** phase 1 only. Nothing on the account changes yet, and no token or JWT is returned.

```json
{
  "recovery": "pending_verification",
  "message": "Confirm the recovery by clicking the link sent to n***w@***.edu."
}
```

Phase 1 verifies the memo key, then stages the requested swap (new email plus the pre-hashed new password) in a server-side staging row. It mails a verification link to the **new** email (proof of control, which gates phase 2) and a dispute link to the **old** email so the prior owner can void the swap. The `message` names a masked form of the new email. The swap applies only when the new mailbox confirms via `POST /api/auth/recover/verify`. A repeated phase-1 request for the same username supersedes any earlier un-confirmed staging row.

**ORCID path, success (200):** applies immediately. Updates email, sets or drops the password per `new_password`, invalidates all existing sessions, and returns a new JWT (same envelope as `POST /api/auth/login`).

```json
{
  "token": "eyJhbG...",
  "expires_at": "2026-04-19T12:00:00.000Z",
  "custody": "light",
  "username": "researcher1"
}
```

**Rate limit:** 10 requests per IP per hour, shared across `POST /api/auth/recover`, `POST /api/auth/recover/verify`, and `POST /api/auth/recover/dispute` (one combined `auth-recover` counter keyed by IP).

**Errors:**
- `VALIDATION_ERROR` (400): missing fields, weak password, no recovery method provided, OR **both `memo_key` and `orcid_token` supplied simultaneously**. Exactly one credential must be presented. Message: `"Supply exactly one of memo_key or orcid_token, not both"`.
- `NOT_FOUND` (404): no active account with that username.
- `UNAUTHORIZED` (401): memo key mismatch, account has no stored memo key, no ORCID on account, ORCID recovery attempted on an account that has upgraded to self-custody, or invalid/expired/mismatched ORCID token. The message is generic so the route is not an upgrade-state or account-state oracle.
- `DUPLICATE` (409): new email already in use by another account.
- `SERVICE_UNAVAILABLE` (503): argon2 capacity exhausted or backend draining (the memo-key path and password-bearing ORCID path both run argon2). See [common.md](common.md).

---

### POST /api/auth/recover/verify

Phase 2 of memo-key recovery. The holder of the **new** email clicks the link mailed in phase 1, proving control of that mailbox, which applies the staged email/password swap. Not used by the ORCID path (which applies in one step).

**Body:**

```json
{
  "token": "the verify token from the recovery link"
}
```

**Response `data`, success (200):** the swap is applied (email updated, password set from the phase-1 staged hash, all existing sessions invalidated) and a new JWT is returned, identical in shape to the login envelope.

```json
{
  "token": "eyJhbG...",
  "expires_at": "2026-04-19T12:00:00.000Z",
  "custody": "light",
  "username": "researcher1"
}
```

The verify token expires 24 hours after phase 1.

**Rate limit:** shared `auth-recover` counter (see `POST /api/auth/recover`).

**Errors:**
- `VALIDATION_ERROR` (400): missing or empty `token`.
- `INVALID_TOKEN` (400): the staging row was not found, already consumed, disputed by the old email-holder, or expired. Also returned when the account was deleted or upgraded to self-custody between phase 1 and phase 2. All of these collapse to one generic message so the link is not a dispute-status or account-state oracle. There is no machine-readable `details.reason` discriminator; the SPA may string-match the message text if it needs to distinguish the expired case for copy.
- `DUPLICATE` (409): the new email was claimed by another account between phase 1 and phase 2.
- `INTERNAL_ERROR` (503): the application database is unavailable. This path runs no argon2, so it has no argon2-capacity 503.

---

### POST /api/auth/recover/dispute

Lets the holder of the **old** email void a staged memo-key recovery. The dispute link is mailed to the old address in phase 1. Clicking it within the dispute window stops a not-yet-confirmed swap from ever applying.

**Body:**

```json
{
  "token": "the dispute token from the notification email"
}
```

**Response `data`, success (200):**

```json
{
  "disputed": true,
  "message": "The recovery request has been stopped. No change has been made to your account."
}
```

Idempotent: clicking the link twice returns the same 200 (the staging row's `disputed_at` is set with `COALESCE(disputed_at, NOW())`, so only the first click records the timestamp). The dispute window is 48 hours from phase 1, intentionally longer than the 24-hour verify window so the prior owner has more time to react. If the swap already applied (the new mailbox confirmed within the first 24 hours) before the dispute is filed, the dispute is recorded for forensics in `custody_audit_log` but the applied swap is **not** rolled back; the success message is uniform either way so the link is not a swap-status oracle.

**Rate limit:** shared `auth-recover` counter (see `POST /api/auth/recover`).

**Errors:**
- `VALIDATION_ERROR` (400): missing or empty `token`.
- `INVALID_TOKEN` (400): dispute token not found, or past the 48-hour dispute window.
- `INTERNAL_ERROR` (503): the application database is unavailable.

**Dispute-mail PII convention.** The dispute notification mailed to the old address names only the **domain** of the new email (via the `emailDomain()` helper), never the full address. This is a deliberate data-minimization choice (CNPD-defensible under the Portugal jurisdiction): a passive attacker who staged a hostile rebind, or anyone who later reads the old mailbox, cannot confirm the exact target address from the notification. Preserve this domain-only framing in any future copy edit to the dispute email.

**Recovery forensic trail and erasure.** The phase-1 staging row carries forensic digests (a SHA-256 digest of the requesting IP, a digest of the old email, plus timestamps) for abuse correlation. These digests live on the `pending_recovery` row only while the account exists: the `DELETE /api/settings/email` transaction sweeps the staging row along with the account data, so the forensic digests do **not** survive a user exercising right-to-erasure. The durable post-deletion record of a recovery is the anonymized `account_recovery` row in `custody_audit_log`, which notes that a recovery occurred without retaining the erased user's contact digests. The staging row is not a durable forensic store.

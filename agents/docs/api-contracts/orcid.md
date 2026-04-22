# PEvO API Contract -- ORCID (Consolidated)

Unified ORCID OAuth endpoints replacing the separate auth and accreditation ORCID flows.

**Replaces:**
- `POST /api/auth/orcid/start` and `POST /api/auth/orcid/callback` (from auth.md)
- `GET /api/accreditation/orcid/start`, `GET /api/accreditation/orcid/link-start`, and `POST /api/accreditation/orcid/callback` (from accreditation.md)

**Route file:** `backend/src/routes/orcid.ts` (new)

---

### POST /api/orcid/start

Initiate the ORCID OAuth2 flow for any mode. Generates a state parameter stored in Redis and returns the ORCID authorization URL.

**Auth:** Required for `accredit` and `link` modes (JWT). Not required for `signup` and `login` modes.

**Body:**

```json
{
  "mode": "signup" | "login" | "accredit" | "link"
}
```

| Mode | Auth | Purpose |
|------|------|---------|
| `signup` | No | Verify ORCID for new account creation |
| `login` | No | Sign in via ORCID |
| `accredit` | Yes (JWT) | Get accredited via ORCID |
| `link` | Yes (JWT) | Link/update ORCID on existing accreditation |

**State stored in Redis:** Key `orcid_state:{state}`, TTL 600s.

```json
{
  "mode": "signup" | "login" | "accredit" | "link",
  "username": "...",
  "timestamp": 1234567890
}
```

`username` is present only for authenticated modes (`accredit`, `link`), read from the JWT.

**Response `data`:**

```json
{
  "redirect_url": "https://orcid.org/oauth/authorize?client_id=...&response_type=code&scope=/authenticate&redirect_uri=...&state=..."
}
```

**Redirect URI:** Derived at runtime as `${config.appUrl}/orcid/callback`. No env var.

**Scope:** All modes use `/authenticate` only. The ORCID Public API (free tier) does not permit additional scopes like `/read-limited` (Member API paid tier).

**Rate limit:** 10 requests per IP per minute.

**Errors:**
- `VALIDATION_ERROR` -- invalid mode
- `UNAUTHORIZED` -- missing/invalid JWT for authenticated modes
- `INTERNAL_ERROR` -- ORCID integration not configured

---

### POST /api/orcid/callback

Complete the ORCID OAuth2 flow. Exchanges the authorization code for an access token, reads the ORCID profile, and performs mode-specific logic.

**Auth:** Required for `accredit` and `link` modes (JWT or Hive-signature headers). The authenticated caller must match the `username` bound into the state by `/start`; otherwise the request is rejected with 403. Not required for `signup` and `login` modes (their state has no bound username). This closes the state-hijack path where a leaked state could be replayed by a different user.

**Body:**

```json
{
  "code": "<ORCID authorization code>",
  "state": "<state from OAuth redirect>"
}
```

**Behavior by mode:**

#### signup

1. Exchange code for token, fetch ORCID profile and works.
2. Check `ORCID_MIN_WORKS` (default 3). Only count works with an external source (Crossref, DataCite, Scopus, etc.).
3. Store verified data in Redis: key `orcid_verified:{nonce}`, TTL 1800s, value `{ orcid_id, works_count, name }`.
4. Return nonce + profile info.

**Response `data`:**

```json
{
  "mode": "signup",
  "orcid_token": "<one-time nonce>",
  "orcid_id": "0000-0001-2345-6789",
  "works_count": 5,
  "name": "Jane Doe"
}
```

The `orcid_token` is consumed by `POST /api/auth/signup`.

#### login

1. Exchange code for token, get ORCID iD.
2. Look up account in `accounts` table by `orcid` column.
3. If found: return JWT session.
4. If not found: return error `NO_ACCOUNT`.

No min works check on login.

**Response `data` (success):**

```json
{
  "mode": "login",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_at": "2026-04-20T12:00:00Z",
  "custody": "light",
  "username": "researcher1"
}
```

**Response error (no account):**

```json
{
  "status": "error",
  "error": {
    "code": "NO_ACCOUNT",
    "message": "No account linked to this ORCID. Please sign up first."
  },
  "orcid_id": "0000-0001-2345-6789"
}
```

#### accredit

1. Exchange code for token, fetch profile and works.
2. Check `ORCID_MIN_WORKS`.
3. Broadcast `accredit` custom_json with `method: "orcid"`.
4. Update `orcid` column in `accounts` table (if light account).

**Response `data`:**

```json
{
  "mode": "accredit",
  "message": "Accreditation via ORCID confirmed",
  "username": "scientist1",
  "orcid": "0000-0001-2345-6789",
  "tx_id": "<Hive custom_json transaction ID>"
}
```

#### link

1. Exchange code for token, get ORCID iD and profile.
2. Fetch existing accreditation from HAF to preserve fields (name, institution, field, method).
3. Broadcast updated `accredit` custom_json with ORCID added/updated.
4. Update `orcid` column in `accounts` table (if light account).

No min works check on link.

**Response `data`:**

```json
{
  "mode": "link",
  "message": "ORCID linked successfully",
  "username": "scientist1",
  "orcid": "0000-0001-2345-6789",
  "tx_id": "<Hive custom_json transaction ID>"
}
```

**Errors (all modes):**
- `BAD_REQUEST` -- invalid/expired state or authorization code
- `UNAUTHORIZED` -- missing/invalid auth on `accredit` or `link` callbacks
- `FORBIDDEN` -- authenticated caller does not match the `username` bound into the state by `/start` (applies to `accredit`, `link`)
- `ORCID_ALREADY_LINKED` (409) -- ORCID is bound to another account. Applies to `accredit` and `link`. Three distinct causes share this code; clients distinguish them via `error.details.retriable` and the `Retry-After` response header:
  - **Durable on-chain binding:** the ORCID is accredited to another account on Hive. `findAccreditedAccountWithOrcid` matched an authority-signed `accredit` op for a different account. Not retriable; the caller must rebind via that account's keys or wait for a revoke. `error.details` omits `retriable`; no `Retry-After` header.
  - **Cache-lag binding:** a different account successfully bound this ORCID within the last ~120s and the op has not yet been indexed by HAF. The orcid_binding Redis cache answered the 409 during the HAF-indexing-lag window. The binding is durable once indexed; not retriable. `error.details` omits `retriable`; no `Retry-After` header.
  - **Same-tick lock contention:** another request for the same ORCID currently holds the `orcid_binding_lock:${orcid_id}` SETNX lock (acquired before broadcast, released in the finally under a Lua CAS keyed on a per-acquisition nonce). Transient; resolves once that request's broadcast completes or its lock TTL (35s) expires. Retriable: `error.details.retriable` is `true`, `error.details.retry_after_seconds` is `10`, and the response carries a `Retry-After: 10` header. A well-behaved client backs off and retries; the subsequent request either succeeds or promotes to one of the two durable-binding causes above.

  Convention: absence of `error.details.retriable` means `false`. Clients MUST NOT treat a missing field as unknown; durable-binding 409s (the first two causes above) deliberately omit the field to keep the wire shape minimal. A client that needs to distinguish transient from durable MUST check either `error.details?.retriable === true` or the presence of the `Retry-After` response header; anything else is a non-retriable binding.
- `VALIDATION_ERROR` -- ORCID profile has fewer than `ORCID_MIN_WORKS` works (signup/accredit modes only)
- `VALIDATION_ERROR` -- link mode but user is not accredited
- `INTERNAL_ERROR` -- ORCID API unreachable

---

### Changes to POST /api/auth/signup

When `orcid_token` is provided:
- `email` becomes optional (NULL allowed in DB after migration)
- `password` becomes optional when no email is provided
- `institution` and `field` become optional (filled from ORCID if available, empty string otherwise)
- `full_name` falls back to ORCID profile name when not provided

The rest of the signup flow (verify, confirm/link) is unchanged. ORCID-signup accounts skip email verification and go directly to the username/keys step.

---

### Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `ORCID_CLIENT_ID` | (none) | ORCID OAuth2 client ID. Required for ORCID features. |
| `ORCID_CLIENT_SECRET` | (none) | ORCID OAuth2 client secret. Required for ORCID features. |
| `ORCID_BASE_URL` | `https://orcid.org` | Set to `https://sandbox.orcid.org` for the ORCID sandbox environment. |
| `ORCID_MIN_WORKS` | `3` | Minimum externally-sourced works required for signup/accredit modes. |

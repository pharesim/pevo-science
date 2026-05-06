# PEvO API Contract — Custody

Endpoints for light account server-side signing and custody upgrade.

---

### POST /api/custody/broadcast

Sign and broadcast Hive operations for light accounts. Only `comment`, `vote`, and `custom_json` (revote only) operations are permitted.

**Headers:** `Authorization: Bearer <jwt>` or `X-Hive-Username`, `X-Hive-Signature` (account must have `custody: "light"`)

**Body:**

```json
{
  "operations": [
    ["comment", {
      "parent_author": "",
      "parent_permlink": "pevo",
      "author": "researcher1",
      "permlink": "my-paper",
      "title": "Paper Title",
      "body": "...",
      "json_metadata": "{\"app\":\"pevo/1.0\",\"tags\":[\"pevo\",\"science\"]}"
    }]
  ],
  "fresh_auth_proof": "<token from POST /api/custody/fresh-auth or POST /api/orcid/start { mode: 'fresh_auth' }>"
}
```

`fresh_auth_proof` is REQUIRED when the bundle contains a consent op (`author_accept` or `author_resign`) and otherwise omitted. The proof is single-use and consumed atomically before the broadcast attempt.

**Response `data`:**

```json
{
  "tx_id": "abc123...",
  "block_num": 12345678
}
```

**Constraints:**
- Only `comment`, `vote`, and `custom_json` operations are allowed. All other operation types return 403.
- The `author` (for comments), `voter` (for votes), or `required_posting_auths` (for custom_json) must match the JWT subject.
- For comments, `json_metadata.app` must start with the configured app tag.
- For `custom_json`, the `id` must match the app tag. Permitted `action` values: `revote`, `claim_authorship`, `approve_authorship`, `revoke_authorship`, `author_accept`, `author_resign`. All other actions return 403.
- A bundle MAY contain at most one consent op (`author_accept` or `author_resign`). Bundles with two or more consent ops return 400 `MULTIPLE_CONSENT_OPS`. Submit each consent op in its own request with its own `fresh_auth_proof`.

**Rate limit:** 30 requests per account per minute.

**Errors:**
- `NOT_FOUND` — custodial account not found
- `FORBIDDEN` — operation not in allowlist, author/voter mismatch, or account already upgraded to self-custody
- `VALIDATION_ERROR` — malformed operations or missing app tag
- `MULTIPLE_CONSENT_OPS` (400) — bundle contains more than one consent op. Submit each consent op in its own request.
- `FRESH_AUTH_REQUIRED` (401|403) — bundle contains a consent op but the `fresh_auth_proof` is missing, expired, malformed, bound to a different user, or bound to a different consent target. Status is discriminated by `details.reason`:
  - `details.reason: "username_mismatch"` → **403 FORBIDDEN** (user-binding violation; token was issued for a different account).
  - `details.reason: "target_mismatch"` → **403 FORBIDDEN** (per-op target-binding violation; token was issued for a different `(action, root_author, root_permlink)` triple than the consent op in the bundle). The fresh-auth proof binds at issuance time to the specific consent op the user authorized; reusing it for a different action or paper is rejected.
  - `details.reason: "missing" | "expired" | "malformed"` → **401 UNAUTHORIZED** (no valid proof present).
  - `details.reason` is a closed enum: `"missing" | "expired" | "username_mismatch" | "target_mismatch" | "malformed"`. Adding a new value is a wire contract change; document here before shipping. Consumers MUST branch on `details.reason` to render distinct UX, not on the message string.
- `BROADCAST_TIMEOUT` (504) — broadcast timed out before chain confirmation. Message: `"Broadcasting signed operation timed out"`. Details: `{retriable:false, outcome:"uncertain", verify_before_retry:true, timeout_ms}`.
- `BROADCAST_FAILED` (502) — Hive node rejected the broadcast. Message: `"Failed to broadcast signed operation to Hive"`. Details: `{retriable:false}`.
- `INTERNAL_ERROR` (500) — non-broadcast errors (database, decryption, key parse) via the outer catch. Only broadcast-path errors flow through 502/504.

**Single-use proof semantics.** The `fresh_auth_proof` is consumed atomically before the broadcast call. If the broadcast subsequently fails (502, 504), the proof is gone; the caller MUST issue a new proof before retrying. This matches the `chain-write-timeout-ambiguous-outcome` convention: single-use state plus ambiguous broadcast outcome means burn-on-consume is the conservative default.

---

### POST /api/custody/fresh-auth

Mint a per-op fresh-auth proof via password re-verification. Light-account-only. The sibling ORCID issuance path lives at `POST /api/orcid/start { mode: "fresh_auth" }` (see [orcid.md](orcid.md)).

**Headers:** `Authorization: Bearer <jwt>` or `X-Hive-Username`, `X-Hive-Signature` (account must have `custody: "light"`)

**Body:**

```json
{
  "password": "SecurePass123",
  "action": "author_accept" | "author_resign",
  "root_author": "<hive-account>",
  "root_permlink": "<paper-permlink>"
}
```

All four fields are REQUIRED. The `(action, root_author, root_permlink)` triple is the per-op target the proof will bind to; the consent op submitted on a subsequent `POST /api/custody/broadcast` MUST match this triple exactly or the broadcast returns 403 `FRESH_AUTH_REQUIRED` with `details.reason: "target_mismatch"`. The triple is validated as a closed enum on `action` and as non-empty strings on `root_author` and `root_permlink`; any missing or malformed field returns 400 `VALIDATION_ERROR`.

**Response `data`:**

```json
{
  "fresh_auth_proof": "<single-use token>",
  "expires_at": "2026-05-06T12:05:00Z",
  "mechanism": "password"
}
```

`fresh_auth_proof` is a single-use bearer token bound to the JWT subject AND to the `(action, root_author, root_permlink)` target. TTL is 5 minutes. Submit it as the `fresh_auth_proof` field on a subsequent `POST /api/custody/broadcast` request that contains a consent op for the same target.

**Rate limit:** 10 requests per account per minute.

**Errors:**
- `UNAUTHORIZED` (401) — missing JWT, account not found, or password mismatch. The "no password set" case (e.g., ORCID-only account with `password_hash IS NULL`) returns the same shape to avoid becoming a password-existence oracle.
- `FORBIDDEN` (403) — account has been upgraded to self-custody. Self-custody users sign consent ops via Hive Keychain and do not use this endpoint.
- `VALIDATION_ERROR` (400) — missing `password`, missing or invalid `action` (must be `"author_accept"` or `"author_resign"`), missing or empty `root_author`, or missing or empty `root_permlink`.
- `INTERNAL_ERROR` (500) — argon2 verification failure or unexpected error.
- `SERVICE_UNAVAILABLE` (503) — argon2 capacity exhausted or backend draining. See [common.md](common.md).

---

### POST /api/custody/upgrade

Notify the backend that the user has completed a client-side key upgrade to self-custody. The backend deletes stored encrypted keys and issues a new JWT.

**Headers:** `Authorization: Bearer <jwt>` or `X-Hive-Username`, `X-Hive-Signature` (account must have `custody: "light"`)

**Body:**

```json
{
  "password": "SecurePass123"
}
```

**Response `data`:**

```json
{
  "custody": "self",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_at": "2026-04-15T12:00:00Z"
}
```

**Rate limit:** 1 request per account per hour.

**Errors:**
- `NOT_FOUND` — account not found
- `UNAUTHORIZED` — invalid password
- `VALIDATION_ERROR` — missing password
- `FORBIDDEN` — account is not a light account
- `ALREADY_UPGRADED` (409) — account already upgraded
- `SERVICE_UNAVAILABLE` (503) — argon2 capacity exhausted or backend draining. See [common.md](common.md).

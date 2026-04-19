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
  ]
}
```

**Response `data`:**

```json
{
  "tx_id": "abc123...",
  "block_num": 12345678
}
```

**Constraints:**
- Only `comment`, `vote`, and `custom_json` (revote only) operations are allowed. All other operation types return 403.
- The `author` (for comments), `voter` (for votes), or `required_posting_auths` (for custom_json) must match the JWT subject.
- For comments, `json_metadata.app` must start with the configured app tag.
- For `custom_json`, the `id` must match the app tag and the payload must have `action: "revote"`. All other custom_json actions return 403.

**Rate limit:** 30 requests per account per minute.

**Errors:**
- `NOT_FOUND` — custodial account not found
- `FORBIDDEN` — operation not in allowlist, author/voter mismatch, or account already upgraded to self-custody
- `VALIDATION_ERROR` — malformed operations or missing app tag
- `BROADCAST_FAILED` (500) — Hive broadcast failed

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

# PEvO API Contract — Common

> **Owner:** Architect Agent
> **Version:** 0.1
> **Base URL:** `/api`

All responses use JSON. All timestamps are ISO 8601 UTC. Pagination uses `page` (1-indexed) and `limit` parameters.

## Accredited-Only Data Policy

PEvO only surfaces data from accredited users by default:

- **Votes** from unaccredited accounts are excluded from all reputation computations, vote counts, and ranking. They still affect native Hive rewards but are invisible to PEvO.
- **Reviews** from unaccredited accounts are excluded from the default view and do not count toward paper ratings or reviewer reputation.
- **Citations** from papers by unaccredited authors are excluded from citation counts.
- **Papers** from unaccredited authors are excluded when `accredited_only=true` (the default).

The `net_votes` field in API responses reflects **accredited votes only**, not the raw Hive vote count. The `review_count` and `citation_count` fields similarly reflect accredited-only data.

## Common Response Envelope

Success:
```json
{
  "status": "ok",
  "data": { ... },
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 142
  }
}
```

Error:
```json
{
  "status": "error",
  "error": {
    "code": "NOT_FOUND",
    "message": "Paper not found"
  }
}
```

### Standard Error Codes

| HTTP | Code | Description |
|------|------|-------------|
| 400 | `BAD_REQUEST` | Invalid or missing parameters |
| 401 | `UNAUTHORIZED` | Authentication required |
| 403 | `FORBIDDEN` | Insufficient permissions |
| 404 | `NOT_FOUND` | Resource not found |
| 413 | `FILE_TOO_LARGE` | Upload exceeds configured size limit |
| 422 | `INVALID_FILE_TYPE` | Upload is not a PDF |
| 409 | `DUPLICATE` | Resource already exists |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `BROADCAST_FAILED` | Hive broadcast failed |
| 500 | `INTERNAL_ERROR` | Server error |

---

## Authentication Notes

PEvO uses two authentication mechanisms. All write operations to the Hive chain are signed client-side via Hive Keychain and broadcast directly to Hive nodes. For PEvO backend API calls, the user authenticates once at login (Keychain signature) and receives a session JWT that covers all subsequent requests.

### Session-Based Authentication (preferred)

On login, the frontend signs a challenge via Hive Keychain and calls `POST /api/auth/session`. The backend verifies the signature and returns a JWT (HS256, 24h expiry). All subsequent authenticated API calls include the JWT:

| Header | Description |
|--------|-------------|
| `Authorization` | `Bearer <jwt>` — the session token returned by `POST /api/auth/session` |

This avoids repeated Keychain popups for read operations (notifications, preferences, profile data).

### Direct Hive Signature Authentication (fallback)

For backwards compatibility, all authenticated endpoints also accept direct Hive Keychain signatures:

| Header | Description |
|--------|-------------|
| `X-Hive-Username` | The Hive account name |
| `X-Hive-Signature` | Hex-encoded Hive Keychain signature |
| `X-Hive-Message` | (Optional) The original message that was signed. Defaults to SHA-256 of the request body if omitted. |
| `X-Hive-Timestamp` | ISO 8601 timestamp (must be within 60 seconds) |

The backend recovers the public key from the signature and verifies it matches one of the account's posting key authorities on-chain.

### Auth Resolution Order

The `verifyHiveSignature` middleware handles **both** JWT and Hive signature auth. Despite the name, it is not Hive-signature-only. It checks in order:
1. `Authorization: Bearer <jwt>` — verify JWT, extract username and custody type
2. `X-Hive-Username` + `X-Hive-Signature` — verify Hive signature on-chain
3. Neither → 401 UNAUTHORIZED

When a contract file says `Authorization: Bearer <jwt>` or `X-Hive-Username`/`X-Hive-Signature`, both paths are supported via this single middleware. Do not flag JWT support as "unimplemented" just because the route file only references `verifyHiveSignature`.

### What Still Requires Keychain

Hive chain operations (publish, vote, review, vouch, retract) are signed and broadcast client-side via Keychain. These are NOT session-based — they require the user's posting key to sign the Hive transaction.

---

## Operational Policies

### CORS

The frontend is served from the same origin as the backend (compiled Vite output in `backend/public/`), so same-origin requests do not need CORS. For external API consumers, CORS is restricted to the configured `APP_URL` origin. If `APP_URL` is not set, cross-origin requests are denied.

- **Same-origin:** No CORS headers needed (browser does not enforce CORS for same-origin requests)
- **Cross-origin:** Allowed only from the `APP_URL` origin (e.g., `https://pevo.science`)

### Rate Limiting

Rate limits protect authenticated endpoints from abuse:

| Endpoint | Limit | Window |
|----------|-------|--------|
| `POST /api/accreditation/request` | 3 requests | per account per 24 hours |
| `POST /api/ipfs/upload` | 10 requests | per account per hour |
| `GET /api/ipfs/:cid` | 60 requests | per IP per minute |
| `POST /api/reviews/anonymous` | 5 requests | per account per hour |
| `GET /api/notifications` | 30 requests | per IP per 5 minutes |
| `GET /api/search` | 60 requests | per IP per minute |
| `GET /api/bridge/lookup` | 20 requests | per IP per minute |
| `POST /api/bridge/register` | 10 requests | per IP per hour |
| `POST /api/bridge/update` | 10 requests | per IP per hour |
| `POST /api/contact` | 5 requests | per IP per hour |
| `POST /api/auth/resend-verification` | 3 requests | per IP per hour |
| `POST /api/papers/:a/:p/invalidate` | 10 requests | per account per minute |
| `GET /api/settings/email` | 30 requests | per IP per minute |
| `POST /api/settings/email` | 10 requests | per IP per minute |
| All other GET endpoints | 120 requests | per IP per minute |

Rate limit state may be stored in-memory (development) or Redis (production). When a rate limit is exceeded, the response uses error code `RATE_LIMITED` (HTTP 429) with a `Retry-After` header in seconds.

### API Versioning

The v0.1 API uses unversioned paths (`/api/...`). When breaking changes are needed in the future, the API will adopt path-based versioning (`/api/v2/...`), with the original paths continuing to serve v1 responses for a deprecation period of at least 6 months. The `app` field in Hive post metadata already includes a version string (`pevo/0.1`) that can be used for content versioning independently of the API version.

# PEvO API Contract — Common

> **Owner:** Architect Agent
> **Version:** 0.1
> **Base URL:** `/api`

All responses use JSON. All timestamps are ISO 8601 UTC. Pagination uses `page` (1-indexed) and `limit` parameters.

## Stability

PEvO is in beta. The API surface (endpoints, query parameters, response shapes, error codes) may change without deprecation notice during beta. Forks and third-party integrators should pin to specific commit SHAs or accept that surfaces may break.

Once PEvO declares 1.0, we'll commit to:
- Semver-style versioning for breaking changes.
- A deprecation cycle for removed surfaces (minimum 1 minor release).
- Migration notes in `agents/docs/api-contracts/CHANGELOG.md`.

For now: the contract files in this directory are the canonical surface description, but they're a snapshot of intent at HEAD, not a stability commitment. See "API Versioning" below for the path-based versioning scheme that ships with 1.0.

## Accredited-Only Data Policy

PEvO only surfaces data from accredited users by default:

- **Votes** from unaccredited accounts are excluded from all reputation computations, vote counts, and ranking. They still affect native Hive rewards but are invisible to PEvO.
- **Reviews** from unaccredited accounts are excluded from every reviews surface (paper-detail `reviews: []` array, single-doc fetch which returns 404, reviews search) and do not count toward paper ratings or reviewer reputation.
- **Comments** from unaccredited accounts are excluded from comments listings and search.
- **Citations** from papers by unaccredited authors are excluded from citation counts.
- **Papers** from unaccredited authors are excluded from papers listings and search. The one exception is `bridge_paper`-typed posts (system-account cross-posts from external sources), which are admitted only when authored by `config.hiveBridgeAccount` (`HIVE_BRIDGE_ACCOUNT` env).

Accreditation is a hard gate: there is no `accredited_only=false` opt-out on any endpoint. The bridge-paper exemption is **author-and-type-gated**: only posts authored by `config.hiveBridgeAccount` with `json_metadata.type === 'bridge_paper'` are admitted. A type claim alone is not an exemption — PEvO object identity is determined by author vouching, not by self-declared metadata. See `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`.

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
| 409 | `LOCK_HELD` | A concurrent request holds an advisory lock on the same resource; retriable shortly. `details.retriable: true`. Distinct from `DUPLICATE`: `LOCK_HELD` is transient (the holder will finish and the lock will release within the broadcast wall-clock bound), `DUPLICATE` is terminal (the resource already permanently exists). Routes that adopt the per-resource advisory-lock pattern (Redis `SET NX EX` with Lua CAS release on a per-acquisition nonce) emit this code; the bridge `/register` route is the canonical exemplar. SPA and integrators MUST switch on `error.code` rather than parsing message text to discriminate the two 409 paths. |
| 429 | `RATE_LIMITED` | Too many requests |
| 502 | `BROADCAST_FAILED` | Hive chain rejected the broadcast (chain-side error, not retriable). `details.retriable: false`. |
| 502 | `POST_BROADCAST_FAILED` | Broadcast confirmed on chain, then a downstream cascade write (cache, persistent row, secondary index) failed with a **transient (auto-reconcile-eligible)** class. `details.retriable: false, details.outcome: 'confirmed', details.tx_id: <40-char lowercase hex string, the Hive transaction id>, details.failed_step: <string>`. Distinct from `BROADCAST_FAILED`: the chain op IS durable; the failed step is a server-side cascade, not a chain rejection. The user-facing message indicates automatic reconciliation. Clients should treat the operation as successful from the user's perspective (the chain state is canonical) and surface the failed step to operators rather than asking the user to retry. Reconciliation of the failed cascade step is per-resource and per-step (some steps reconcile via the next request populating the cache; others via a scheduled batch job; some require manual re-execution); see the resource contract for the canonical list of `failed_step` values and their recovery semantics. |
| 502 | `POST_BROADCAST_OPERATOR_REQUIRED` | Broadcast confirmed on chain, then a downstream cascade write failed with a **permanent (non-retriable)** class. `details.retriable: false, details.outcome: 'confirmed', details.tx_id: <40-char lowercase hex string>, details.failed_step: <string>`. Same wire shape as `POST_BROADCAST_FAILED` and same "chain op is durable" semantics, but discriminated by severity: this code signals that automatic reconciliation will NOT close the cascade gap and operator intervention is required. The user-facing message indicates support contact rather than automatic recovery. The two codes share the helper layer (`backend/src/lib/broadcast-error.ts` `handleBroadcastError`); the discriminator at throw time is the `severity: 'transient' \| 'permanent'` field on the `PostBroadcastWriteError` instance. Operators should alert on `POST_BROADCAST_OPERATOR_REQUIRED` events at a higher priority than `POST_BROADCAST_FAILED` (the former is page-worthy; the latter is dashboard-worthy). Clients that branch on `error.code` for cascade failures MUST include this code in any handler keyed on `POST_BROADCAST_FAILED` to avoid silently falling through to a generic INTERNAL_ERROR path. |
| 504 | `BROADCAST_TIMEOUT` | Backend aborted the broadcast at the wall-clock bound, OR caught a non-timer throw on a code path where outcome cannot be determined (e.g. lock-wrapper unavailable-branch with non-`BroadcastTimeoutError` throw, OR lock-wrapper acquired-branch pre-broadcast SYNC throw such as a malformed signing key). Outcome is uncertain (the op may or may not have landed on chain). `details.retriable: false, details.outcome: 'uncertain', details.verify_before_retry: true`. `details.timeout_ms` is OPTIONAL: present iff the underlying throw was a `BroadcastTimeoutError` (timer-fire path); omitted otherwise. Clients must verify chain state before retrying to avoid duplicate ops. |
| 503 | `SERVICE_UNAVAILABLE` | Backend dependency is unavailable. Two distinct sub-cases share this code: (1) **Argon2 capacity exhaustion** — emitted by argon2-bound endpoints (auth signup/login/resend-verification/reset-request/reset/recover, signup-verify resume-signup, custody upgrade, settings set-password) when the password-hash/verify queue is full or the backend is draining for shutdown. Transient. `Retry-After` header carries seconds: 5 for queue-full, 30 for shutdown drain. Body is the generic `"Service temporarily unavailable. Please retry."` — the body's `error.message` intentionally does not distinguish queue-full from shutdown to avoid leaking the chokepoint identity. The machine-readable discriminator is `details.reason: 'queue_full' \| 'shutdown_drain'` on the same envelope (see note below). Clients SHOULD honor `Retry-After` rather than tight-loop retrying. (2) **Bridge posting key not configured** — emitted by bridge-account broadcast paths (`/api/bridge/register`, `/api/bridge/update`, and the admin-on-bridge-paper branches of `/api/papers/.../claims/.../approve` and `/api/papers/.../claims/.../revoke`) when `PEVO_BRIDGE_POSTING_KEY` is unset on the deployment. Operator misconfiguration; a redeploy with the key set restores service. Body: `"Bridge posting key not configured"`. No `Retry-After` (not a transient capacity signal). No `details.reason` discriminator (the body message is the discriminator). |
| 500 | `INTERNAL_ERROR` | Server error |

**Note on `BROADCAST_*` codes.** `bridge.ts` and `custody.ts` use a different broadcast helper (`broadcastSendOperationsWithTimeout`) but route their broadcast-catch sites through `handleBroadcastError`, so they emit the same 502 `BROADCAST_FAILED` / 504 `BROADCAST_TIMEOUT` discrimination envelopes as the `broadcastJsonWithTimeout` callers. HTTP 500 from those routes is reserved for non-broadcast errors (DB, decrypt, key-parse, etc.) emitted by an outer try/catch as `INTERNAL_ERROR`.

**Note on `503 SERVICE_UNAVAILABLE` and client disconnects.** Argon2-bound endpoints may emit no response body when the client disconnects mid-request (the in-flight argon2 work is aborted via the request's `AbortSignal`). The closed socket is the client signal; no response envelope is written. Frontend code paths that observe a torn-down request (e.g. fetch `AbortError`) should treat it as a normal client cancellation, not as a server fault. Future global response middleware MUST NOT enforce "every request gets a body" or this contract will silently break.

**Note on `503 SERVICE_UNAVAILABLE` and `details.reason`.** Argon2-bound 503 envelopes carry a `details.reason: 'queue_full' \| 'shutdown_drain'` discriminator on the same response body. Status, error code, message, and `Retry-After` are deliberately identical between the two cases (HTTP body parity prevents leaking which chokepoint is active); the discriminator lets HTTP-only consumers (synthetic canaries, status-page probes, browser-side telemetry) branch on shutdown-drain vs. queue-saturation without log-stream correlation. `'queue_full'` is a transient capacity event (operator action: investigate, scale up if sustained); `'shutdown_drain'` is the expected SIGTERM rolling-restart path (operator action: suppress alert, the next instance handles new requests). Source-of-truth values are pinned in `backend/src/lib/argon2-error-handler.ts` as `ARGON_REASON_QUEUE_FULL` / `ARGON_REASON_SHUTDOWN_DRAIN`. Other 503 paths NOT yet covered (the `getAppPool() === null` pool-unavailable case in particular) intentionally do NOT emit `details.reason` today; consumers MUST treat absence of `details.reason` as a third "non-argon2" bucket rather than assuming a default.

**Note on `503 SERVICE_UNAVAILABLE` and `details.retriable`.** Some non-argon2 503 paths emit `details.retriable: true` on the same envelope to signal that the failure had no chain-side or token-side state effect and the client may safely retry. Per-route Errors sections are the authoritative enumeration; the current emitter classes are:

- **Accreditation gate / verify token broadcast** — `POST /api/accreditation/verify` on two branches: `SERVICE_UNAVAILABLE` when the per-token broadcast-attempts counter cannot be primed because Redis is unavailable, and the sibling `ACCREDITATION_GATE_UNAVAILABLE` (its own error code, also 503) when the HAF existing-accreditation gate query throws. Both branches emit `Retry-After: 30` alongside `details.retriable: true`.
- **HAF outage (HafQueryError + retriable pg cause)** — emitted by routes that translate `HafQueryError` to 503 when the wrapped pg cause code is retriable per `isRetriableHafError` (connection-class `08*`, statement_timeout `57014`, and the no-code default for generic JS errors thrown from the pool/network layer). Routes: `GET /api/papers/:author/:permlink` and its `/enrichment`, `/cite`, and `/retract` siblings; `GET /api/papers/:author/:permlink/comments` (both preflight and listing arms); `GET /api/reviews/:author/:permlink`; `GET /api/profile/:username/papers`; `GET /api/profile/:username/reviews`. Deterministic pg errors (`42601` syntax, `42501` permission, `22P02` type) fall through `isRetriableHafError` to the central 500 handler rather than emit a retriable 503; clients MUST treat absence of `details.retriable` as "no retry guidance" rather than assuming all 5xx on these routes is retriable.
- **Walker wall-clock budget exceeded** — emitted by the paper-detail routes (`GET /:author/:permlink` and `/enrichment`, `/retract`, `/cite`) when the `hafWalkerWallClockMs` AbortController fires before canonical-root walker completion. Same envelope shape as the HAF-outage class on the same routes; consumers do not need to distinguish the two triggers (both warrant the same retry).
- **Bridge `/register` lock-held** — `LOCK_HELD` (its own error code, 409 not 503, but shares the `details.retriable: true` shape) emitted when a concurrent `/register` request holds the per-permlink advisory lock. Listed here as a sibling retriable signal; the bridge route's Errors section is authoritative.

Consumers SHOULD treat `details.retriable` as an opaque retry hint independent of `details.reason`; absence of `details.retriable` means "no retry guidance" (treat as non-retriable by default). The argon2-bound 503 paths emit `Retry-After` without `details.retriable`; treat the union of either signal as a retry hint. The HAF-outage and walker-budget emitters do NOT emit `Retry-After` today (the SPA owns its own retry cadence); a future change adding it would be additive.

Example envelope:

```json
{
  "status": "error",
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "Service temporarily unavailable. Please retry.",
    "details": { "reason": "shutdown_drain" }
  }
}
```

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

All authenticated endpoints also accept direct Hive Keychain signatures. The signed payload is **always** bound to the request:

| Header | Required | Description |
|--------|----------|-------------|
| `X-Hive-Username` | yes | The Hive account name |
| `X-Hive-Signature` | yes | Hex-encoded Hive Keychain signature over the message defined below |
| `X-Hive-Timestamp` | yes | ISO 8601 timestamp. Rejected if more than 60 seconds off wall-clock. |

The client signs exactly this message (byte-for-byte):

```
{APP_TAG}-auth|v1|{METHOD}|{path}|{sha256_hex(body)}|{timestamp}
```

- `APP_TAG` — deployment tag (`pevo` in production, `pevotest` on beta, per-fork for forks). Included so signatures from one deployment cannot be replayed against another.
- `METHOD` — HTTP method, uppercase (e.g. `POST`).
- `path` — request path, no query string (e.g. `/api/auth/session`).
- `sha256_hex(body)` — lowercase hex SHA-256 of `JSON.stringify(body || {})`. For requests with no body, sign the hash of `'{}'`. Authenticated POSTs **must** send `Content-Type: application/json` and a JSON body (at minimum `{}`).
- `timestamp` — the raw value of `X-Hive-Timestamp`.

The backend recovers the public key from the signature over `sha256(message)` and verifies it matches one of the account's posting key authorities on-chain. Every accepted signature is also cached for 5 minutes to prevent in-window replay.

**Note:** `X-Hive-Message` used to be accepted as a free-form override for this payload. It has been removed (see security-audit-findings.md → FINDING-001). Any client sending `X-Hive-Message` will be ignored and the request will fail signature check.

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

#### Trusted Proxy Chain

Per-IP rate-limit keys are derived from `req.ip` with Express `trust proxy = 1`. The production topology assumes exactly one trusted proxy hop (nginx on the host, terminating TLS and forwarding to the backend on `127.0.0.1:3001`). `X-Forwarded-For` values from untrusted upstreams are not honored — only the left-most value prepended by the trusted nginx hop is used.

If a CDN (Cloudflare, Fastly) is introduced in front of nginx later, the `trust proxy` value increases to `2` or is replaced with an explicit CIDR allowlist. Do not trust arbitrary `X-Forwarded-For` chains.

**Residual:** Attackers with a legitimate IPv6 /64 block can still rotate source IPs per-request under IPv6. Closing that requires keying on a broader CIDR or on session/account — out of scope for the current rate-limit shape.

### API Versioning

The v0.1 API uses unversioned paths (`/api/...`). When breaking changes are needed in the future, the API will adopt path-based versioning (`/api/v2/...`), with the original paths continuing to serve v1 responses for a deprecation period of at least 6 months. The `app` field in Hive post metadata already includes a version string (`pevo/0.1`) that can be used for content versioning independently of the API version.

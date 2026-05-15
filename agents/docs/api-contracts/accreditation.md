# PEvO API Contract -- Accreditation

Endpoints for accreditation requests, email verification, and Web of Trust. ORCID OAuth endpoints have moved to [orcid.md](orcid.md).

---

### GET /api/accreditations

List accredited researchers.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `field` | string | — | Filter by field of research |
| `institution` | string | — | Filter by institution |
| `page` | integer | `1` | Page number |
| `limit` | integer | `50` | Results per page (max 200) |

**Response `data`:** Array of `AccreditedResearcher`

```json
{
  "username": "scientist1",
  "name": "Dr. Jane Smith",
  "institution": "MIT",
  "field": "neuroscience",
  "method": "email",
  "orcid": "0000-0001-2345-6789",
  "timestamp": "2026-01-15T10:00:00Z"
}
```

`orcid` is present when the researcher has a verified ORCID, otherwise absent/null.

**Response `meta`:** Pagination metadata: `{ "page": 1, "limit": 50, "total": 142 }`

---

### GET /api/accreditations/:username

Accreditation status for a single user.

**Response `data`:**

```json
{
  "username": "scientist1",
  "is_accredited": true,
  "accreditation": {
    "name": "Dr. Jane Smith",
    "institution": "MIT",
    "field": "neuroscience",
    "method": "email",
    "orcid": "0000-0001-2345-6789",
    "timestamp": "2026-01-15T10:00:00Z",
    "tx_id": "5123456789"
  } | null
}
```

- `accreditation.tx_id` — the HAF `customJson.id` of the latest authority-signed `accredit` custom_json for this account, as a decimal string. `null` when the account has never been accredited or when the latest authority op is a `revoke` (in which case `accreditation` itself is `null`). Shape matches `/api/profile/:username` exactly — both endpoints resolve the same authority-filtered HAF query.

The `accredit` row is filtered server-side to only include events signed by `config.accreditationAuthorities` (via `required_posting_auths ?|` on HAF). Self-broadcast fake `accredit` ops do not surface here.

---

### POST /api/accreditation/request

Submit an accreditation request. Triggers an email verification flow.

**Headers:** `X-Hive-Username`, `X-Hive-Signature` (same as other authenticated endpoints).

**Request Body:**

```json
{
  "full_name": "Dr. Jane Smith",
  "institution": "MIT",
  "field": "neuroscience",
  "email": "jsmith@mit.edu",
  "orcid": "0000-0001-2345-6789"
}
```

The `X-Hive-Signature` header proves the requester controls the Hive account. The backend verifies the signature before sending the verification email.

**Response `data`:**

```json
{
  "message": "Verification email sent to j***h@***.edu",
  "expires_at": "2026-03-26T14:30:00Z"
}
```

**Errors:**
- `UNAUTHORIZED` — invalid or missing Hive signature
- `VALIDATION_ERROR` (422) — non-institutional email domain
- `BAD_REQUEST` — missing required fields
- `RATE_LIMITED` — too many requests from this account

---

### POST /api/accreditation/verify

Confirm an email verification token to complete accreditation.

**Request Body:**

```json
{
  "token": "<verification token from email>"
}
```

**Response `data`:**

```json
{
  "message": "Accreditation confirmed",
  "username": "scientist1",
  "tx_id": "<Hive custom_json transaction ID>",
  "outcome": "already_landed"
}
```

The backend broadcasts the accreditation `custom_json` to Hive upon successful verification. The on-chain payload includes an `idempotency_key` field set to `sha256(${token}:${hive_username})` (deterministic per token; no PII since the token is high-entropy and the username is already public). Pre-broadcast the backend probes HAF for a prior `accredit` op carrying the same `idempotency_key`; on hit the response short-circuits to the existing `tx_id` without re-broadcasting.

`outcome` is OPTIONAL. The field is **omitted** on a fresh broadcast and **present with value `"already_landed"`** only on the HAF idempotency-hit path (a prior verification of the same token already landed an accredit op). On the hit path the per-token state is best-effort cleaned and the response carries the prior `tx_id`.

**Errors:**
- `BAD_REQUEST`: invalid/expired token.
- `BROADCAST_FAILED` (502): Hive chain rejected the accreditation broadcast. `details.retriable: false`. The token is consumed; request a new verification token.
- `POST_BROADCAST_FAILED` (502): Broadcast confirmed on chain, then a transient downstream cascade write failed. Today the only emitter on this route is `seedAccreditationBonus`, which writes the initial reputation-bonus row keyed by username. Wire shape per [common.md](common.md). `details.failed_step: 'reputation_seed'`, `details.outcome: 'confirmed'`, `details.tx_id` carries the confirmed accreditation tx_id. The accreditation IS durable; the bonus row is reconciled by the next reputation-batch cycle. Clients should treat this as success from the user's perspective (do NOT prompt for a new verification token; the chain op is canonical).
- `POST_BROADCAST_OPERATOR_REQUIRED` (502): Broadcast confirmed on chain, then a permanent downstream cascade write failed (e.g., a TypeError or non-retriable DB error inside `seedAccreditationBonus`). Wire shape per [common.md](common.md). Same chain-is-canonical semantics as `POST_BROADCAST_FAILED`, but operator intervention is required to reconcile the missed bonus. User-facing message indicates support contact rather than automatic reconciliation. Clients should NOT prompt for a new verification token.
- `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` (502): Per-token broadcast-attempts cap exceeded under concurrent retry burst (the broadcast was never invoked, so this is distinct from `BROADCAST_FAILED`). `details.retriable: false`. The token is **preserved** (soft-block, not consumed): the per-token broadcast-attempts counter and the pending-token entry both TTL out independently within the token's 24h life, after which the user can retry the same token. Clients should NOT call `/api/accreditation/request` for a fresh token in immediate response; that endpoint is rate-limited to 3 requests per account per 24 hours, and burning a slot here may lock the user out for the rest of the day. Surface the message to the user and let them wait or request a fresh email after the wait. Operators alerting on `BROADCAST_FAILED` rate should NOT bucket this code together with `BROADCAST_FAILED`: this signals client retry-pressure, not chain rejection. **Ordering guarantee:** if the operation is already confirmed on chain (idempotency-probe hit), this code is never returned regardless of the counter value; the response short-circuits to 200 `outcome: 'already_landed'` before the cap is consulted. A confirmed accreditation cannot mask itself as cap-exhausted.
- `BROADCAST_TIMEOUT` (504): Backend aborted the broadcast at 30s. Outcome uncertain. `details.retriable: false, details.outcome: 'uncertain', details.verify_before_retry: true, details.timeout_ms: 30000`. The on-chain `idempotency_key` field (see Response notes above) means a blind retry within the token's 24h life is now SAFE: the retry's pre-broadcast HAF lookup will find the landed op (if it did land) and short-circuit to `outcome: 'already_landed'`. The historical "blind retry produces duplicate `accredit` ops" hazard is closed by the idempotency layer for this endpoint.
- `SERVICE_UNAVAILABLE` (503): Backend Redis dependency was unavailable when the per-token broadcast-attempts counter could not be primed before reaching the broadcast site. `details.retriable: true`. No `Retry-After` header (this is the third "non-argon2" 503 sub-case per `common.md`); no `details.reason` discriminator. The broadcast was never invoked and no chain-side or token-side state changed, so clients can safely retry. See the `details.retriable` note in `common.md` for the cross-endpoint convention.

---

### GET /api/wot/:username

Vouch status for a user in the Web of Trust system. Returns the number of vouches received, the threshold required for WoT accreditation, and the list of vouchers.

**Response `data`:** `VouchStatus`

```json
{
  "username": "scientist1",
  "vouch_count": 2,
  "threshold": 3,
  "vouches": [
    { "voucher": "scientist2", "relationship": "colleague", "timestamp": "2026-03-25T10:00:00Z" },
    { "voucher": "scientist3", "relationship": "advisor", "timestamp": "2026-03-25T11:00:00Z" }
  ],
  "eligible": false
}
```

**Errors:**
- `INTERNAL_ERROR` — HAF database unavailable (required for WoT queries)

---

### POST /api/wot/vouch

Notify the backend that a vouch `custom_json` has been broadcast. The backend checks whether the vouchee has reached the WoT threshold and auto-accredits them if so. The frontend must first broadcast the `vouch` custom_json via Hive Keychain, then call this endpoint.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`

**Request Body:**

```json
{
  "vouchee": "scientist4"
}
```

**Response `data`:**

```json
{
  "message": "Vouch recorded. scientist4 has been auto-accredited via Web of Trust.",
  "accredited": true,
  "tx_id": "<Hive transaction ID or null>",
  "vouch_status": { "...VouchStatus object..." }
}
```

When the vouchee has not yet reached the threshold, the message format is `"Vouch recorded. scientist4 has N/M vouches."` and `accredited` is `false`.

**Errors:**
- `BAD_REQUEST` — missing `vouchee`
- `VALIDATION_ERROR` (422) — voucher is the same as vouchee
- `FORBIDDEN` — voucher is not accredited

---

### POST /api/wot/retract

Notify the backend that a `retract_vouch` custom_json has been broadcast. The backend checks for cascading revocations — if a WoT-accredited researcher drops below the threshold, their accreditation is revoked, and this cascades to anyone they vouched for.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`

**Request Body:**

```json
{
  "vouchee": "scientist4"
}
```

**Response `data`:**

```json
{
  "message": "Retraction processed. No cascading revocations needed.",
  "revocations": [],
  "vouch_status": { "...VouchStatus object..." }
}
```

**Errors:**
- `BAD_REQUEST` — missing `vouchee`

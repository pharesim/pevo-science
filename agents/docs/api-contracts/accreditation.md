# PEvO API Contract — Accreditation

Endpoints for accreditation requests, verification, ORCID-based accreditation, and Web of Trust.

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
  "timestamp": "2026-01-15T10:00:00Z"
}
```

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
    "timestamp": "2026-01-15T10:00:00Z"
  } | null
}
```

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
  "message": "Verification email sent to j***h@mit.edu",
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
  "tx_id": "<Hive custom_json transaction ID>"
}
```

The backend broadcasts the accreditation `custom_json` to Hive upon successful verification.

**Errors:** `BAD_REQUEST` (invalid/expired token)

---

### GET /api/accreditation/orcid/start

Initiate the ORCID OAuth2 accreditation flow. Returns the ORCID authorization URL that the frontend should redirect to.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`

**Response `data`:** `OrcidStartResponse`

```json
{
  "redirect_url": "https://orcid.org/oauth/authorize?client_id=...&response_type=code&scope=/authenticate&redirect_uri=..."
}
```

**Errors:**
- `UNAUTHORIZED` — invalid signature
- `VALIDATION_ERROR` (422) — user is already accredited

---

### POST /api/accreditation/orcid/callback

Complete the ORCID OAuth2 flow. The frontend sends the authorization code and state parameter received from ORCID's redirect. The backend verifies the state, exchanges the code for an access token, reads the ORCID profile, and broadcasts an `accredit` custom_json with `method: "orcid"`.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`

**Request Body:**

```json
{
  "code": "<ORCID authorization code>",
  "state": "<state from OAuth redirect>"
}
```

**Response `data`:** `OrcidCallbackResponse`

```json
{
  "message": "Accreditation via ORCID confirmed",
  "username": "scientist1",
  "orcid": "0000-0001-2345-6789",
  "tx_id": "<Hive custom_json transaction ID>"
}
```

**Errors:**
- `UNAUTHORIZED` — invalid Hive signature
- `BAD_REQUEST` — invalid/expired ORCID authorization code, user already accredited
- `INTERNAL_ERROR` — ORCID API unreachable

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

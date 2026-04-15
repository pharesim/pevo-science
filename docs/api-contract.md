# PEvO API Contract

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
| 413 | `FILE_TOO_LARGE` | Upload exceeds 10MB |
| 422 | `INVALID_FILE_TYPE` | Upload is not a PDF |
| 409 | `DUPLICATE` | Resource already exists |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Server error |

---

## Endpoints

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
  "username": "researcher1",
  "linked_username": "existing-hive-user",  // optional — link existing Hive account instead of creating new
  "orcid_token": "abc123..."                // optional — nonce from /api/auth/orcid/callback
}
```

- `email` — any valid email. If not from an institutional domain, `orcid_token` is required.
- `password` must be at least 10 characters with lowercase, uppercase, and numbers
- `username` must be Hive-compatible (3-16 chars, lowercase a-z, 0-9, dots/hyphens)
- `linked_username` (optional) — if set, the user links an existing Hive account instead of creating a new one; the username must already exist on Hive
- `orcid_token` (optional) — one-time nonce returned by `/api/auth/orcid/callback`. Backend validates against Redis and retrieves the verified ORCID iD. Consumed on use.

**Response `data`:**

```json
{
  "message": "Verification email sent to r***r@***.edu",
  "expires_at": "2026-04-15T12:00:00Z"
}
```

**Rate limit:** 10 requests per IP per hour.

**Errors:**
- `VALIDATION_ERROR` — non-institutional email without valid `orcid_token`, password too weak, or invalid username format
- `DUPLICATE` — email or username already registered or pending
- `NOT_FOUND` — linked Hive account does not exist

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

### POST /api/auth/verify

Verify the email token from a signup. For new accounts, returns a seed phrase. For linked accounts, returns a challenge for Keychain signature.

**Body:**

```json
{
  "token": "abc123..."
}
```

**Response `data` (new account):**

```json
{
  "flow": "new",
  "username": "researcher1",
  "seed_phrase": "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12"
}
```

**Response `data` (linked account):**

```json
{
  "flow": "link",
  "username": "researcher1",
  "linked_username": "existing-hive-user",
  "challenge": "pevo-link-..."
}
```

**Errors:**
- `INVALID_TOKEN` — token not found or expired

---

### POST /api/auth/confirm

Confirm seed phrase retention and create the Hive account. Only for new (non-linked) signups.

**Body:**

```json
{
  "username": "researcher1",
  "seed_words": "word3 word7 word11"
}
```

The user re-enters selected words from the seed phrase to prove retention.

**Response `data`:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_at": "2026-04-15T12:00:00Z",
  "custody": "light",
  "username": "researcher1",
  "is_accredited": true
}
```

On success: Hive account created, keys encrypted and stored, accreditation broadcast, JWT session issued.

**Errors:**
- `VALIDATION_ERROR` — incorrect seed words
- `INTERNAL_ERROR` — account creation failed (e.g., no available tokens)

---

### POST /api/auth/link

Complete linking an existing Hive account. Requires Keychain signature proving ownership.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`, `X-Hive-Message`

**Body:**

```json
{
  "username": "researcher1",
  "challenge": "pevo-link-..."
}
```

**Response `data`:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_at": "2026-04-15T12:00:00Z",
  "custody": "self",
  "username": "existing-hive-user",
  "is_accredited": true
}
```

**Errors:**
- `FORBIDDEN` — signature does not match linked username
- `INVALID_TOKEN` — challenge not found

---

### POST /api/auth/login

Password-based login for light accounts.

**Body:**

```json
{
  "username": "researcher1",
  "password": "SecurePass123"
}
```

`username` can be either the username or email address.

**Response `data`:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_at": "2026-04-15T12:00:00Z",
  "custody": "light"
}
```

**Rate limit:** 10 requests per IP per hour. Account locked after 20 failed attempts (reset via password reset).

**Errors:**
- `UNAUTHORIZED` — invalid credentials
- `ACCOUNT_LOCKED` — too many failed attempts

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

### POST /api/custody/broadcast

Sign and broadcast Hive operations for light accounts. Only `comment` and `vote` operations are permitted.

**Headers:** `Authorization: Bearer <jwt>` (must have `custody: "light"`)

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
- Only `comment` and `vote` operations are allowed. All other operation types return 403.
- The `author` (for comments) or `voter` (for votes) must match the JWT subject.
- For comments, `json_metadata.app` must start with the configured app tag.

**Rate limit:** 30 requests per account per minute.

**Errors:**
- `FORBIDDEN` — operation not in allowlist, or author/voter mismatch
- `VALIDATION_ERROR` — malformed operations or missing app tag

---

### POST /api/custody/upgrade

Notify the backend that the user has completed a client-side key upgrade to self-custody. The backend deletes stored encrypted keys and issues a new JWT.

**Headers:** `Authorization: Bearer <jwt>` (must have `custody: "light"`)

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
- `UNAUTHORIZED` — invalid password
- `FORBIDDEN` — account is not a light account
- `ALREADY_UPGRADED` — account already upgraded

---

### GET /api/papers

List PEvO papers with filtering and sorting.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `discipline` | string | — | Filter by discipline |
| `keyword` | string | — | Filter by keyword tag |
| `author` | string | — | Filter by Hive username |
| `language` | string | — | Filter by language code (e.g. `en`, `de`, `es`) |
| `sort` | enum | `date` | `date`, `reputation`, `votes` |
| `order` | enum | `desc` | `asc`, `desc` |
| `accredited_only` | boolean | `true` | Only show papers from accredited authors |
| `include_retracted` | boolean | `false` | Include retracted papers in results |
| `source` | enum | — | Filter by paper source: `native` (original PEvO papers), `bridge` (registered preprints), or omit for both |
| `page` | integer | `1` | Page number (1-indexed) |
| `limit` | integer | `20` | Results per page (max 100) |

**Response `data`:** Array of `PaperSummary`

```json
{
  "author": "scientist1",
  "permlink": "neural-network-plasticity-2026",
  "title": "Neural Network Plasticity in Adult Brains",
  "abstract": "First 300 chars of body...",
  "discipline": "neuroscience",
  "keywords": ["plasticity", "neural-networks"],
  "authors": [
    { "name": "Dr. Jane Smith", "hive": "scientist1", "orcid": "0000-0001-2345-6789" }
  ],
  "ipfs_cid": "QmXyz..." | null,
  "created": "2026-03-20T14:30:00Z",
  "net_votes": 42,
  "review_count": 3,
  "citation_count": 7,
  "author_reputation": 68,
  "is_accredited": true
}
```

---

### GET /api/papers/:author/:permlink

Single paper with full content and reviews.

**Response `data`:** `PaperDetail`

```json
{
  "author": "scientist1",
  "permlink": "neural-network-plasticity-2026",
  "title": "Neural Network Plasticity in Adult Brains",
  "body": "<full markdown body>",
  "json_metadata": { ... },
  "created": "2026-03-20T14:30:00Z",
  "last_update": "2026-03-20T14:30:00Z",
  "net_votes": 42,
  "pending_payout_value": "12.345 HBD",
  "discipline": "neuroscience",
  "keywords": ["plasticity", "neural-networks"],
  "authors": [
    {
      "name": "Dr. Jane Smith",
      "hive": "scientist1",
      "orcid": "0000-0001-2345-6789",
      "affiliation": "MIT"
    }
  ],
  "ipfs_cid": "QmXyz..." | null,
  "ipfs_filename": "paper.pdf" | null,
  "document_hash": "sha256..." | null,
  "abstract_hash": "sha256...",
  "language": "en",
  "citations": [
    { "author": "scientist2", "permlink": "related-work", "title": "Related Work Title" }
  ],
  "citation_count": 7,
  "author_reputation": 68,
  "is_accredited": true,
  "reviews": [
    {
      "author": "reviewer1",
      "permlink": "re-scientist1-neural-network-plasticity-review",
      "body": "<review markdown>",
      "rating": {
        "methodology": 4,
        "novelty": 5,
        "clarity": 3,
        "significance": 4
      },
      "is_anonymous": false,
      "created": "2026-03-21T09:00:00Z",
      "net_votes": 15,
      "reviewer_reputation": 45,
      "is_accredited": true,
      "reviewed_version": 1
    }
  ],
  "versions": [
    { "version_number": 1, "created": "2026-03-20T14:30:00Z", "title": "Neural Network Plasticity in Deep Learning" }
  ],
  "is_retracted": false,
  "retraction_reason": null,
  "retraction_timestamp": null
}
```

**Notes:**
- The `versions` array contains the edit history of this paper (from HAF operation history), ordered by `version_number` ascending. Papers are versioned via Hive's native edit mechanism (same author/permlink). The Hive API only returns the latest version; HAF is required to view older versions.
- Each review includes `reviewed_version` indicating which version of the paper was reviewed.
- If `is_retracted` is `true`, the paper was retracted by the author or `pevo.admin`. The `retraction_reason` and `retraction_timestamp` fields provide context.
- Retracted papers are excluded from `GET /api/papers` and `GET /api/search` by default. Pass `include_retracted=true` to include them.

**Errors:** `NOT_FOUND` if paper does not exist or is not a PEvO paper.

---

### GET /api/papers/:author/:permlink/citations

Papers that cite this paper.

**Query Parameters:** `page`, `limit`

**Response `data`:** Array of `PaperSummary` (same shape as `/api/papers` list items).

---

### GET /api/reviews/:author/:permlink

Single review with full details.

**Response `data`:** `ReviewDetail`

```json
{
  "author": "reviewer1",
  "permlink": "re-scientist1-neural-network-review",
  "body": "<full review markdown>",
  "rating": {
    "methodology": 4,
    "novelty": 5,
    "clarity": 3,
    "significance": 4
  },
  "is_anonymous": false,
  "reviewer_attestation_id": "abc123..." | null,
  "paper": {
    "author": "scientist1",
    "permlink": "neural-network-plasticity-2026",
    "title": "Neural Network Plasticity in Adult Brains"
  },
  "created": "2026-03-21T09:00:00Z",
  "net_votes": 15,
  "reviewer_reputation": 45,
  "is_accredited": true
}
```

---

### GET /api/profile/:username

Researcher profile with reputation breakdown.

**Response `data`:** `Profile`

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
  } | null,
  "reputation": {
    "score": 68,
    "breakdown": {
      "papers": 30,
      "reviews": 10,
      "paper_votes": 12,
      "review_votes": 5,
      "citations": 8,
      "accreditation": 20,
      "account_age": 3
    }
  },
  "stats": {
    "paper_count": 3,
    "review_count": 2,
    "citation_count": 1,
    "first_pevo_post": "2026-01-20T08:00:00Z"
  }
}
```

---

### GET /api/profile/:username/papers

Papers authored by a specific researcher.

**Query Parameters:** `sort` (`date`, `votes`), `order`, `page`, `limit`

**Response `data`:** Array of `PaperSummary`.

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
- `BAD_REQUEST` — missing fields, invalid email domain, invalid signature
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
  "message": "Vouch recorded. scientist4 has 3/3 vouches.",
  "accredited": true,
  "tx_id": "<Hive transaction ID or null>",
  "vouch_status": { "...VouchStatus object..." }
}
```

**Errors:**
- `BAD_REQUEST` — missing `vouchee`, or voucher is the same as vouchee
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

---

### POST /api/ipfs/upload

Upload a file and pin it to IPFS. Uses the local Kubo node by default; falls back to Pinata when configured and Kubo is unavailable.

**Request:** `multipart/form-data` with a `file` field (max 10MB).

**Accepted types:** PDF, PNG, JPEG, GIF, WebP, SVG, CSV, ZIP. Magic bytes are validated server-side.

**Headers:** `X-Hive-Username` and `X-Hive-Signature` — the user must sign the file's SHA-256 hash with Hive Keychain to prove they are an accredited user.

**Response `data`:**

```json
{
  "cid": "QmXyz...",
  "size": 2048576,
  "filename": "paper.pdf",
  "type": "application/pdf"
}
```

**Errors:**
- `UNAUTHORIZED` — invalid signature or not accredited
- `INVALID_FILE_TYPE` — unsupported type or magic bytes mismatch
- `FILE_TOO_LARGE` — exceeds 10MB

---

### GET /api/ipfs/:cid

Validated IPFS gateway proxy. Serves file content only for CIDs referenced by known PEvO papers (checked against HAF metadata and Redis pending uploads). Unknown CIDs return 404.

**Rate limit:** 60 requests per minute per IP.

**Response:** Streams the file content with appropriate `Content-Type` and `Cache-Control: public, max-age=31536000, immutable` headers.

**Errors:**
- `BAD_REQUEST` — invalid CID format
- `NOT_FOUND` — CID not referenced by any PEvO paper
- `INTERNAL_ERROR` — IPFS gateway unavailable

---

### GET /api/papers/:author/:permlink/comments

Discussion comments on a paper (threaded). Returns a flat list of all comments; the frontend builds the tree using `parent_author`/`parent_permlink` fields. Only comments from accredited authors are included by default.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `accredited_only` | boolean | `true` | Only show comments from accredited authors |
| `sort` | enum | `date` | `date`, `votes` |
| `order` | enum | `asc` | `asc`, `desc` |
| `page` | integer | `1` | Page number |
| `limit` | integer | `50` | Results per page (max 200) |

**Response `data`:** Array of `DiscussionComment`

```json
{
  "author": "scientist2",
  "permlink": "re-scientist1-neural-network-plasticity-comment-20260322",
  "body": "<comment markdown>",
  "created": "2026-03-22T11:00:00Z",
  "net_votes": 5,
  "is_accredited": true,
  "author_reputation": 42,
  "parent_author": "scientist1",
  "parent_permlink": "neural-network-plasticity-2026"
}
```

**Notes:**
- Top-level comments have `parent_author` = paper author and `parent_permlink` = paper permlink.
- Replies to comments have `parent_author` = parent commenter and `parent_permlink` = parent comment permlink.
- The `replies` field from the `DiscussionComment` contract type is populated client-side by the frontend when building the thread tree, **not** by the API. The API returns a flat list.
- `net_votes` reflects accredited votes only.

**Errors:** `NOT_FOUND` if paper does not exist.

---

### GET /api/search

Full-text search across PEvO papers and reviews.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `q` | string | **required** | Search query |
| `type` | enum | `all` | `paper`, `review`, `all` |
| `discipline` | string | — | Filter by discipline |
| `language` | string | — | Filter by language code (e.g. `en`, `de`, `es`) |
| `accredited_only` | boolean | `true` | Only accredited authors |
| `sort` | enum | `relevance` | `relevance`, `date` |
| `page` | integer | `1` | Page number |
| `limit` | integer | `20` | Results per page (max 100) |

**Response `data`:** Array of `SearchResult`

```json
{
  "type": "paper",
  "author": "scientist1",
  "permlink": "neural-network-plasticity-2026",
  "title": "Neural Network Plasticity in Adult Brains",
  "snippet": "...highlighted <mark>matching text</mark>...",
  "rank": 0.95,
  "created": "2026-03-20T14:30:00Z",
  "is_accredited": true
}
```

---

### GET /api/disciplines

List all disciplines that have at least one PEvO paper.

**Response `data`:** Array of `Discipline`

```json
{
  "name": "neuroscience",
  "paper_count": 42
}
```

---

### GET /api/stats

Platform-wide statistics.

**Response `data`:**

```json
{
  "total_papers": 256,
  "total_reviews": 812,
  "total_accredited_researchers": 89,
  "total_citations": 1043,
  "active_disciplines": 15,
  "papers_last_30_days": 23,
  "reviews_last_30_days": 67
}
```

---

### POST /api/reviews/anonymous

Submit an anonymous review. The backend posts the review from the `pevo.anon` Hive account and stores an encrypted mapping for abuse resolution.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `X-Hive-Username` | yes | Hive username of the actual reviewer |
| `X-Hive-Signature` | yes | Hive Keychain signature of the SHA-256 hash of the JSON request body |

**Request Body:**

```json
{
  "paper_author": "scientist1",
  "paper_permlink": "neural-network-plasticity-2026",
  "body": "<review markdown text>",
  "rating": {
    "methodology": 4,
    "novelty": 5,
    "clarity": 3,
    "significance": 4
  }
}
```

**Response `data`:** `AnonymousReviewResponse`

```json
{
  "author": "pevo.anon",
  "permlink": "re-scientist1-neural-network-plasticity-2026-anon-1711360000000",
  "tx_id": "<Hive transaction ID>"
}
```

**Errors:**
- `UNAUTHORIZED` -- invalid signature or account not found
- `FORBIDDEN` -- reviewer is not accredited
- `BAD_REQUEST` -- missing fields or invalid rating values

---

### GET /api/notifications

Fetch notification events for the authenticated user since a given Hive block number. The client polls this endpoint periodically (recommended: every 5 minutes). No persistent connection required.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `since_block` | integer | **required** | Return events after this Hive block number |
| `limit` | integer | `50` | Max events to return (max 100) |

**Response `data`:** `NotificationBatch`

```json
{
  "events": [
    {
      "type": "new_review",
      "block_num": 82345678,
      "timestamp": "2026-03-25T14:30:12Z",
      "actor": "reviewer1",
      "paper_author": "scientist1",
      "paper_permlink": "neural-network-plasticity-2026",
      "paper_title": "Neural Network Plasticity in Adult Brains",
      "permlink": "re-scientist1-neural-network-plasticity-review"
    },
    {
      "type": "new_citation",
      "block_num": 82345700,
      "timestamp": "2026-03-25T14:31:18Z",
      "actor": "scientist2",
      "paper_author": "scientist1",
      "paper_permlink": "neural-network-plasticity-2026",
      "paper_title": "Neural Network Plasticity in Adult Brains",
      "citing_permlink": "follow-up-study-2026"
    },
    {
      "type": "new_vote",
      "block_num": 82345720,
      "timestamp": "2026-03-25T14:32:00Z",
      "actor": "scientist3",
      "target_author": "scientist1",
      "target_permlink": "neural-network-plasticity-2026",
      "target_type": "paper",
      "weight": 10000
    },
    {
      "type": "accreditation_update",
      "block_num": 82345800,
      "timestamp": "2026-03-25T14:35:00Z",
      "action": "accredit",
      "method": "wot"
    },
    {
      "type": "new_vouch",
      "block_num": 82345810,
      "timestamp": "2026-03-25T14:35:30Z",
      "actor": "scientist4",
      "relationship": "colleague"
    },
    {
      "type": "new_reply",
      "block_num": 82345900,
      "timestamp": "2026-03-25T14:40:00Z",
      "actor": "scientist5",
      "parent_author": "scientist1",
      "parent_permlink": "re-neural-network-comment-1",
      "paper_author": "scientist1",
      "paper_permlink": "neural-network-plasticity-2026",
      "permlink": "re-neural-network-comment-2"
    }
  ],
  "latest_block": 82345900,
  "has_more": false
}
```

**Field details:**

- `events`: Array of `NotificationEvent` objects, ordered by `block_num` ascending.
- `latest_block`: The highest `block_num` included in this response. The client should pass this as `since_block` on the next poll to avoid gaps or duplicates.
- `has_more`: If `true`, there are more events beyond the `limit`. The client should immediately re-poll with `since_block` = `latest_block` to fetch the remainder.

**Event types:**

| Type | Trigger | Who receives it |
|------|---------|-----------------|
| `new_review` | New review (pevo.type=review) on your paper | Paper author |
| `new_citation` | New paper whose pevo.citations references your paper | Cited paper author |
| `new_vote` | New vote on your paper or review from an accredited voter | Content author |
| `accreditation_update` | Your accreditation is granted or revoked | Target account |
| `new_vouch` | Someone vouches for you in WoT | Vouchee |
| `new_reply` | New discussion comment (pevo.type=comment) replying to your comment | Parent comment author |

**Rate Limiting:** 30 requests per account per 5 minutes (one poll per 10 seconds burst, but expected interval is 5 minutes).

**Errors:**
- `UNAUTHORIZED` -- invalid signature
- `BAD_REQUEST` -- missing `since_block`

**Notes:**
- Only accredited-voter votes trigger `new_vote` events, consistent with the platform-wide accredited-only policy.
- The backend queries HAF for events in the block range `(since_block, latest_head_block]`.
- The first poll: if the client has no stored `since_block`, it should call `GET /api/health` to get the current timestamp, then use the corresponding block number (or simply use `0` to get the most recent events up to `limit`).
- This design is suitable for both web (localStorage cursor) and mobile (SharedPreferences cursor) clients. No persistent connections or server-side state.

---

### GET /api/papers/:author/:permlink/cite

Export a citation for this paper in a specified format.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `format` | enum | **required** | `bibtex`, `ris`, or `apa` |

**Response `data`:** `CitationExportResponse`

```json
{
  "format": "bibtex",
  "content": "@article{scientist1_neural_2026,\n  title={Neural Network Plasticity in Adult Brains},\n  author={Dr. Jane Smith},\n  year={2026},\n  publisher={PEvO},\n  url={https://pevo.science/papers/scientist1/neural-network-plasticity-2026}\n}"
}
```

For `apa` format, the `content` field contains the formatted APA string. For `bibtex` and `ris`, it contains the file content suitable for download.

**Errors:**
- `BAD_REQUEST` — missing or invalid `format`
- `NOT_FOUND` — paper does not exist

---

### POST /api/papers/:author/:permlink/retract

Retract a paper. The backend broadcasts a `retract_paper` custom_json to Hive.

**Authorization:** The paper author or `pevo.admin` may retract any paper. For bridge papers (`pevo.type = "bridge_paper"`), the Hive `author` is the bridge account, so instead the backend checks: (1) the registerer via `pevo.source.registered_by`, (2) `pevo.admin`, or (3) any user whose Hive username matches an entry in `pevo.authors[].hive` (original preprint authors with PEvO accounts).

**Headers:** `X-Hive-Username`, `X-Hive-Signature`

**Request Body:**

```json
{
  "reason": "Error discovered in methodology section 3.2"
}
```

**Response `data`:** `RetractPaperResponse`

```json
{
  "message": "Paper retracted successfully",
  "tx_id": "<Hive custom_json transaction ID>"
}
```

**Errors:**
- `UNAUTHORIZED` — invalid signature
- `FORBIDDEN` — user is neither the paper author, `pevo.admin`, nor (for bridge papers) the registerer or an original author listed in `pevo.authors[].hive`
- `NOT_FOUND` — paper does not exist
- `BAD_REQUEST` — paper is already retracted, or missing reason

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
- `BAD_REQUEST` — user is already accredited

---

### POST /api/accreditation/orcid/callback

Complete the ORCID OAuth2 flow. The frontend sends the authorization code received from ORCID's redirect. The backend exchanges it for an access token, reads the ORCID profile, and broadcasts an `accredit` custom_json with `method: "orcid"`.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`

**Request Body:**

```json
{
  "code": "<ORCID authorization code>"
}
```

**Response `data`:** `OrcidCallbackResponse`

```json
{
  "message": "ORCID accreditation confirmed",
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

### GET /api/papers/:author/:permlink/doi

Assign or retrieve a DOI for this paper via DataCite. If a DOI has already been assigned, returns it. Otherwise, registers a new DOI with DataCite and stores it in the paper's on-chain metadata (via a `custom_json` update).

**Headers:** `X-Hive-Username`, `X-Hive-Signature` (required for DOI assignment; optional for retrieval)

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `assign` | boolean | `false` | If `true`, assign a new DOI (requires auth). If `false`, just retrieve existing DOI. |

**Response `data`:** `DoiResponse`

```json
{
  "doi": "10.5281/pevo.scientist1.neural-network-plasticity-2026",
  "doi_url": "https://doi.org/10.5281/pevo.scientist1.neural-network-plasticity-2026",
  "status": "registered",
  "registered_at": "2026-03-25T14:30:00Z"
}
```

If no DOI exists and `assign=false`:

```json
{
  "doi": null,
  "doi_url": null,
  "status": "unregistered",
  "registered_at": null
}
```

**Errors:**
- `UNAUTHORIZED` — invalid signature (when `assign=true`)
- `FORBIDDEN` — user is not the paper author (when `assign=true`)
- `NOT_FOUND` — paper does not exist
- `BAD_REQUEST` — paper is retracted
- `INTERNAL_ERROR` — DataCite API unreachable

**Notes:**
- DOI prefix is configured via `DATACITE_DOI_PREFIX` env var
- The DOI suffix follows the pattern `{prefix}/pevo.{author}.{permlink}`
- After assignment, the backend broadcasts a `custom_json` to store the DOI in the paper's on-chain metadata
- DataCite credentials: `DATACITE_REPOSITORY_ID`, `DATACITE_PASSWORD`, `DATACITE_DOI_PREFIX`
- Development uses DataCite test API (`https://api.test.datacite.org`)

---

### GET /api/profile/:username/notification-preferences

Retrieve notification preferences for a user.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`

**Response `data`:** `NotificationPreferences`

```json
{
  "username": "scientist1",
  "email_digest": true,
  "digest_frequency": "weekly",
  "email": "jsmith@mit.edu",
  "updated_at": "2026-03-25T10:00:00Z"
}
```

If no preferences exist, returns defaults: `email_digest: false`, `digest_frequency: "weekly"`, `email: null`.

**Errors:**
- `UNAUTHORIZED` — invalid signature or username mismatch

---

### PUT /api/profile/:username/notification-preferences

Update notification preferences. Requires the authenticated user to match the profile username.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`

**Request Body:**

```json
{
  "email_digest": true,
  "digest_frequency": "weekly",
  "email": "jsmith@mit.edu"
}
```

All fields are optional; only provided fields are updated.

**Response `data`:** `NotificationPreferences` (full object after update)

**Errors:**
- `UNAUTHORIZED` — invalid signature or username mismatch
- `BAD_REQUEST` — invalid email format, invalid frequency (must be `daily` or `weekly`)

**Notes:**
- Preferences are stored in the application database (`notification_preferences` table), not on-chain
- Email digest is sent by a backend cron job that queries HAF for unseen events since last digest
- Users who haven't polled notifications in 7+ days AND have `email_digest: true` receive the digest

---

### GET /api/profile/:username/notification-preferences/unsubscribe

One-click email digest unsubscribe. No authentication required — uses an HMAC token generated by the digest email sender. Linked from the "Unsubscribe" footer in digest emails.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `token` | string | **required** | HMAC-SHA256 token binding the unsubscribe action to the username |

**Response `data`:**

```json
{
  "message": "Email digest unsubscribed"
}
```

**Errors:**
- `BAD_REQUEST` — missing or invalid unsubscribe token

**Notes:**
- Token is generated server-side when sending digest emails. It is not a JWT — it is a simple HMAC binding `unsubscribe:{username}` to a server-side secret.
- Sets `email_digest = false` in the `notification_preferences` table.

---

### GET /api/bridge/lookup

Preview metadata for a preprint by DOI, arXiv ID, or URL from a supported source. No authentication required. Used by the frontend to show a preview before registration.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `identifier` | string | **required** | DOI, arXiv ID, or URL from a supported source. Accepted formats: bare DOI (`10.1101/...`), `doi.org` URL, arXiv ID (`2301.12345`), `arxiv:` prefix, `arxiv.org` URL, `biorxiv.org` URL, `medrxiv.org` URL, `pubmed.ncbi.nlm.nih.gov` URL, `semanticscholar.org` URL, `researchgate.net/publication/` URL |

**Response `data`:** `BridgeLookupResult`

```json
{
  "source_type": "arxiv",
  "doi": "10.48550/arXiv.2301.12345",
  "arxiv_id": "2301.12345",
  "title": "Attention Is All You Need",
  "authors": [
    {
      "name": "Ashish Vaswani",
      "orcid": null,
      "affiliation": "Google Brain"
    }
  ],
  "abstract": "The dominant sequence transduction models are based on...",
  "published_date": "2023-01-15",
  "source_name": "arXiv",
  "source_url": "https://arxiv.org/abs/2301.12345",
  "pdf_url": "https://arxiv.org/pdf/2301.12345",
  "license": "CC-BY-4.0",
  "subjects": ["cs.CL", "cs.LG"]
}
```

**Field notes:**
- `source_type` — `"arxiv"` or `"crossref"`, indicating which API provided the metadata. Indirect sources (PubMed, Semantic Scholar, ResearchGate, bioRxiv, medRxiv URLs) are resolved to a DOI and fetched via CrossRef, so `source_type` will be `"crossref"` for all of them.
- `doi` — may be `null` for arXiv papers without a DOI.
- `arxiv_id` — may be `null` for non-arXiv sources.
- `subjects` — source-specific subject/category codes. For arXiv, these are arXiv categories (e.g., `cs.CL`). For CrossRef, these are subject areas. The frontend can suggest a PEvO discipline based on these.
- `authors[].orcid` — populated if the source metadata includes ORCID iDs.

**Errors:**
- `BAD_REQUEST` — missing `identifier`, or identifier could not be parsed
- `NOT_FOUND` — no preprint found for the given identifier
- `RATE_LIMITED` — upstream API rate limit reached (retry after backoff)
- `INTERNAL_ERROR` — upstream API unreachable

---

### GET /api/bridge/check

Check whether a preprint has already been registered on PEvO.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `identifier` | string | **required** | DOI, arXiv ID, or URL from any supported source (same formats as `/api/bridge/lookup`) |

**Response `data`:** `BridgeCheckResult`

If already registered:
```json
{
  "exists": true,
  "author": "scientist1",
  "permlink": "bridge-arxiv-2301-12345",
  "title": "Attention Is All You Need",
  "created": "2026-03-20T14:30:00Z"
}
```

If not registered:
```json
{
  "exists": false,
  "author": null,
  "permlink": null,
  "title": null,
  "created": null
}
```

**Errors:**
- `BAD_REQUEST` — missing or unparseable identifier

---

### POST /api/bridge/register

Register an existing preprint as a bridge paper on PEvO. The backend validates the request, checks for duplicates, and broadcasts the Hive post **server-side** under the bridge account (`HIVE_BRIDGE_ACCOUNT`). The requesting user only needs to authenticate via Keychain signature — no client-side Hive broadcast is required.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`, `X-Hive-Message`

**Request Body:**

```json
{
  "identifier": "2301.12345",
  "discipline": "Computer Science",
  "keywords": ["transformers", "attention", "NLP"],
  "language": "en"
}
```

The `identifier` accepts the same formats as `/api/bridge/lookup` (DOI, arXiv ID, or URL from PubMed, bioRxiv, medRxiv, Semantic Scholar, ResearchGate). The `discipline` must be a valid discipline from the taxonomy. `keywords` and `language` are optional (defaults: empty array, `"en"`).

**Response `data`:** `RegisterBridgePaperResponse`

```json
{
  "author": "pevo.admin",
  "permlink": "bridge-arxiv-2301-12345",
  "tx_id": "abc123...",
  "source": {
    "type": "arxiv",
    "doi": "10.48550/arXiv.2301.12345",
    "arxiv_id": "2301.12345",
    "url": "https://arxiv.org/abs/2301.12345"
  }
}
```

The `author` is the bridge account (not the requesting user). The requesting user is recorded in the on-chain `pevo.source.registered_by` field. The `tx_id` is the Hive transaction ID of the broadcast.

**Errors:**
- `UNAUTHORIZED` — invalid signature
- `FORBIDDEN` — user is not accredited
- `BAD_REQUEST` — missing identifier, invalid discipline, or identifier not found at source
- `DUPLICATE` (HTTP 409) — preprint already registered on PEvO. Response includes `existing_author` and `existing_permlink`.
- `INTERNAL_ERROR` — bridge posting key not configured or Hive broadcast failed
- `RATE_LIMITED` — too many registrations

---

### POST /api/bridge/update

Re-fetch metadata from the source for an existing bridge paper and broadcast the updated post **server-side** under the bridge account. Used when the source preprint has a new version.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`, `X-Hive-Message`

**Request Body:**

```json
{
  "permlink": "bridge-arxiv-2301-12345"
}
```

Only the original registerer (matched via `pevo.source.registered_by` in the existing post's metadata) can update a bridge paper.

**Response `data`:** `UpdateBridgePaperResponse`

```json
{
  "author": "pevo.admin",
  "permlink": "bridge-arxiv-2301-12345",
  "tx_id": "def456...",
  "previous_version": 1,
  "new_version": 2
}
```

**Errors:**
- `UNAUTHORIZED` — invalid signature
- `FORBIDDEN` — user is not the original registerer of this bridge paper, or not accredited
- `NOT_FOUND` — bridge paper does not exist
- `BAD_REQUEST` — source metadata could not be retrieved
- `INTERNAL_ERROR` — bridge posting key not configured or Hive broadcast failed

---

### GET /api/health

Server health check. Not paginated.

**Response:**

```json
{
  "status": "ok",
  "haf_available": true,
  "timestamp": "2026-03-25T12:00:00Z"
}
```

Note: This endpoint does not use the standard response envelope.

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

The `verifyHiveSignature` middleware checks in order:
1. `Authorization: Bearer <jwt>` — verify JWT, extract username
2. `X-Hive-Username` + `X-Hive-Signature` — verify Hive signature on-chain
3. Neither → 401 UNAUTHORIZED

### What Still Requires Keychain

Hive chain operations (publish, vote, review, vouch, retract) are signed and broadcast client-side via Keychain. These are NOT session-based — they require the user's posting key to sign the Hive transaction.

---

## Operational Policies

### CORS

The backend should configure CORS to allow requests from the frontend origin only in production:

- **Development:** Allow all origins (`*`)
- **Production:** Allow only the configured `APP_URL` origin (e.g., `https://pevo.science`)

The `APP_URL` environment variable determines the allowed origin in production.

### Rate Limiting

Rate limits protect authenticated endpoints from abuse:

| Endpoint | Limit | Window |
|----------|-------|--------|
| `POST /api/accreditation/request` | 3 requests | per account per 24 hours |
| `POST /api/ipfs/upload` | 10 requests | per account per hour |
| `GET /api/ipfs/:cid` | 60 requests | per IP per minute |
| `POST /api/reviews/anonymous` | 5 requests | per account per hour |
| `GET /api/notifications` | 30 requests | per account per 5 minutes |
| `GET /api/search` | 60 requests | per IP per minute |
| `GET /api/bridge/lookup` | 20 requests | per IP per minute |
| `POST /api/bridge/register` | 10 requests | per account per hour |
| `POST /api/bridge/update` | 10 requests | per account per hour |
| All other GET endpoints | 120 requests | per IP per minute |

Rate limit state may be stored in-memory (development) or Redis (production). When a rate limit is exceeded, the response uses error code `RATE_LIMITED` (HTTP 429) with a `Retry-After` header in seconds.

### API Versioning

The v0.1 API uses unversioned paths (`/api/...`). When breaking changes are needed in the future, the API will adopt path-based versioning (`/api/v2/...`), with the original paths continuing to serve v1 responses for a deprecation period of at least 6 months. The `app` field in Hive post metadata already includes a version string (`pevo/0.1`) that can be used for content versioning independently of the API version.

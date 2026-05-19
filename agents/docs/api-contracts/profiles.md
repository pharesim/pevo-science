# PEvO API Contract — Profiles

Endpoints for researcher profiles, notification preferences, email settings, and account search.

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
    "orcid": "0000-0001-2345-6789",
    "timestamp": "2026-01-15T10:00:00Z",
    "tx_id": "abc123..."
  } | null,
  "reputation": {
    "score": 68,
    "breakdown": {
      "papers": 30,
      "reviews": 10,
      "citations": 8,
      "accreditation": 20
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

**Field notes:**
- `discipline` — canon_name form (lowercased and trimmed), matches `/api/disciplines.canon_name` and the `?discipline=` filter contract; round-trippable through the URL filter without re-canonicalization. `PaperSummary.discipline` is typed `string` (not nullable); absent values surface as `''`. Display form via `/api/disciplines.display_name` lookup or CSS `text-transform: capitalize`.
- `authors[].orcid` / `authors[].orcid_verified` / `authors[].orcid_discrepancy` — same supersession semantics as `PaperSummary.authors[]` in [papers.md § GET /api/papers](papers.md). The projection is applied JS-side via `toPaperSummary` (not via the SQL `authorsWithSupersessionSelect` helper used on `/api/papers`), but the field semantics, suppression-to-null path, canonical display rule, and continuation-chain caveat are identical to the canonical PaperSummary description there.
- `authors[].affiliation` — NOT emitted on PaperSummary surfaces. `toPaperSummary` strips `affiliation` from every author entry unconditionally to honor the PaperSummary contract; affiliation is only carried on `PaperDetail` responses from `/api/papers/:author/:permlink`.
- `authors[]` cumulative-union — this surface returns the **head broadcaster's** `pevo.authors[]` only. Unlike `PaperDetail` from `/api/papers/:author/:permlink` (which applies cumulative-union across the continuation chain), `/api/profile/:username/papers` does not currently reconstruct continuation-chain co-authors. Cross-surface authors-set parity is tracked separately; consumers needing the cumulative-union authors set should fetch `/api/papers/:author/:permlink` per paper.
- **Cache staleness:** `orcid_verified` / `orcid_discrepancy` on this surface MAY be up to ~10 minutes stale relative to current `active_accreditations` state. The response is wrapped in a short-TTL response cache (≤30 seconds) inside the `getAccreditedOrcidsByAccount` 10-minute map cache; net worst-case revocation lag is bounded by the inner map TTL. This is the chain-is-SSoT / cache-is-perf-layer posture; tighter than the 30-minute window documented for `/api/papers` paper-detail but conceptually identical.

**Errors:**
- `SERVICE_UNAVAILABLE` (503) — transient HAF failure on the user-papers fetch or the post-fetch accreditation enrichment. `details.retriable: true`. Distinguished from a legitimate empty result (200 with empty `data[]`) so consumers can surface a retry affordance instead of rendering "no papers." Sibling route to the other 503-retriable HAF-outage emitters; see the cross-cutting note in [common.md § Error envelope](common.md).

---

### GET /api/profile/:username/reviews

Reviews authored by a specific researcher.

**Query Parameters:** `sort` (`date`, `votes`), `order`, `page`, `limit`

**Response `data`:** Array of review summaries with pagination metadata.

**Errors:**
- `SERVICE_UNAVAILABLE` (503) — transient HAF failure on the user-reviews fetch. `details.retriable: true`. Distinguished from a legitimate empty result (200 with empty `data[]`); same retry contract as `/api/profile/:username/papers` above.

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

If no preferences exist, returns defaults: `email_digest: false`, `digest_frequency: "weekly"`, `email: null`, `updated_at: null`.

**Errors:**
- `UNAUTHORIZED` — invalid signature
- `FORBIDDEN` — username mismatch (can only view your own preferences)

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

All three fields are required in the request body. Use `null` for `email` to clear it.

**Response `data`:** `NotificationPreferences` (full object after update)

**Errors:**
- `UNAUTHORIZED` — invalid signature
- `FORBIDDEN` — username mismatch (can only update your own preferences)
- `BAD_REQUEST` — invalid email format, invalid frequency (must be `daily` or `weekly`), or missing required fields

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

### GET /api/settings/email

Get the current email state for the authenticated user.

**Headers:** `Authorization: Bearer <jwt>` or `X-Hive-Username`, `X-Hive-Signature`

**Response `data`:**

```json
{
  "hasEmail": true,
  "email": "r***@university.edu",
  "verified": true,
  "custody": "light",
  "pendingChange": true | false
}
```

- `pendingChange` — `true` when the user has requested an email change that has not yet been verified.

If no account row exists: `{ "hasEmail": false, "custody": "self" }`.

**Rate limit:** 30 requests per IP per minute.

---

### POST /api/settings/email

Add or change the email address for the authenticated user. Sends a verification email to the new address.

**Headers:** `Authorization: Bearer <jwt>` or `X-Hive-Username`, `X-Hive-Signature`

**Body:**

```json
{
  "email": "new@university.edu"
}
```

**Response `data`:**

```json
{
  "message": "Verification email sent"
}
```

**Rate limit:** 10 requests per IP per minute.

**Errors:**
- `VALIDATION_ERROR` — invalid email format
- `DUPLICATE` — email already used by another account

---

### GET /api/settings/email/verify/:token

Verify an email add or change token. No authentication required (token is proof of email ownership).

**Path Parameters:** `token` — the verification token from the email link.

**Response `data`:**

```json
{
  "verified": true
}
```

**Errors:**
- `INVALID_TOKEN` — token not found or expired

---

### DELETE /api/settings/email

Delete the authenticated user's email and all associated account data (notification preferences, audit logs). For light accounts, this means losing password-based login access.

**Headers:** `Authorization: Bearer <jwt>` or `X-Hive-Username`, `X-Hive-Signature`

**Body:**

```json
{
  "confirm": true
}
```

**Response `data`:**

```json
{
  "deleted": true
}
```

**Rate limit:** 10 requests per IP per minute.

**Errors:**
- `VALIDATION_ERROR` — missing confirmation
- `NOT_FOUND` — no account data found

---

### GET /api/accounts/search

Search Hive accounts by username prefix. No authentication required. Returns whether each account is accredited on PEvO.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `q` | string | **required** | Username prefix (2-16 chars, Hive-valid characters) |
| `limit` | integer | `5` | Max results (1-10) |

**Response `data`:**

```json
{
  "accounts": [
    {
      "username": "scientist1",
      "is_accredited": true
    }
  ]
}
```

**Errors:**
- `BAD_REQUEST` — missing query, too short, or too long

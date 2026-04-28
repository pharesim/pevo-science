# PEvO API Contract — Papers

Endpoints for listing, viewing, searching, citing, retracting papers, and discussion comments.

---

### GET /api/papers

List PEvO papers with filtering and sorting.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `discipline` | string | — | Filter by discipline. Match is case-insensitive (the backend lowercases both the query param and the stored value via `LOWER()`). Case-variant values share a single Redis cache entry. Pass `canon_name` from `GET /api/disciplines` as the canonical form. Repeated params (`?discipline=a&discipline=b`) are treated as no-filter rather than coerced to a single value; clients SHOULD send exactly one value. Values must match `^[\p{L}\p{N} \-]+$` (Unicode letters/digits/space/hyphen) and be at most 100 characters; longer or other-charset values return `400 BAD_REQUEST` with `{ code: 'BAD_REQUEST', message: 'Discipline filter invalid' }`. |
| `keyword` | string | — | Filter by keyword tag |
| `author` | string | — | Filter by Hive username |
| `language` | string | — | Filter by language code (e.g. `en`, `de`, `es`) |
| `sort` | enum | `date` | `date`, `reputation`, `votes` |
| `order` | enum | `desc` | `asc`, `desc` |
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
  "vote_strength": "endorsement",
  "author_reputation": 68,
  "is_accredited": true,
  "accredited_authors": ["scientist1"],
  "source_type": "native",
  "doi": null
}
```

**Field notes:**
- `discipline` — canon_name form (lowercased), matches `/api/disciplines.canon_name` and the `?discipline=` filter contract; round-trippable through the URL filter without re-canonicalization. Display form via `/api/disciplines.display_name` lookup or CSS `text-transform: capitalize`. May be `null` (paper not tagged with a discipline).
- `vote_strength` — qualitative tier derived from average accredited vote weight, or `null` if no votes. See enrichment endpoint for possible values.
- `source_type` — `"native"` for original PEvO papers, `"arxiv"` or `"crossref"` for bridge papers.
- `doi` — DOI string for bridge papers (from source metadata), `null` for native papers.

---

### GET /api/papers/:author/:permlink

Single paper with full content and reviews.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `version` | integer | — | Retrieve a specific historical version (requires HAF). Omit for latest. |

**Response `data`:** `PaperDetail`

```json
{
  "author": "scientist1",
  "permlink": "neural-network-plasticity-2026",
  "title": "Neural Network Plasticity in Adult Brains",
  "body": "<full markdown body>",
  "abstract": "First 300 chars of body...",
  "json_metadata": { ... },
  "created": "2026-03-20T14:30:00Z",
  "last_update": "2026-03-20T14:30:00Z",
  "net_votes": 42,
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
  "language": "en",
  "citations": [
    { "author": "scientist2", "permlink": "related-work", "title": "Related Work Title" }
  ],
  "citation_count": 0,
  "author_reputation": 0,
  "is_accredited": true,
  "accredited_authors": ["scientist1"],
  "reviews": [],
  "versions": [
    {
      "version_number": 1,
      "created": "2026-03-20T14:30:00Z",
      "title": "Neural Network Plasticity in Deep Learning",
      "is_content_revision": true,
      "author": "scientist1",
      "permlink": "neural-network-plasticity-2026",
      "addresses_reviews": null
    }
  ],
  "supplementary_files": [],
  "metadata_restored": false,
  "canonical_author": "scientist1",
  "canonical_permlink": "neural-network-plasticity-2026",
  "head_author": "scientist1",
  "head_permlink": "neural-network-plasticity-2026",
  "is_retracted": false,
  "retraction_reason": null,
  "retraction_timestamp": null
}
```

**Notes:**
- `discipline` — same canon_name semantics as `PaperSummary.discipline` above (lowercased, round-trippable through `?discipline=`, may be `null`).
- Unlike `PaperSummary`, this endpoint does not return `vote_strength`, `review_count`, `source_type`, or `doi`. Those fields are on the list view only. `vote_strength` is returned by the enrichment endpoint.
- `citation_count` is computed for single-paper views: for native papers via HAF (counting accredited papers that cite this one), for bridge papers via Semantic Scholar external citation counts.
- `author_reputation` is always `0` in this endpoint (not computed for single-paper views; the list endpoint populates it via batch reputation queries).
- The `reviews` array is always empty in this endpoint. Reviews and vote details are loaded lazily via `GET /api/papers/:author/:permlink/enrichment` to speed up initial page loads.
- The `versions` array contains the edit history of this paper (from HAF operation history), ordered by `version_number` ascending. Papers are versioned via Hive's native edit mechanism (same author/permlink). The Hive API only returns the latest version; HAF is required to view older versions. Each version entry includes `is_content_revision` (true when the body or title changed), `author`/`permlink` (the post this version came from, relevant for continuation chains), and `addresses_reviews` (array of `{author, permlink}` for reviews this revision responds to, or null).
- Each review includes `reviewed_version` indicating which version of the paper was reviewed.
- If `is_retracted` is `true`, the paper was retracted by the author or `pevo.admin`. The `retraction_reason` and `retraction_timestamp` fields provide context.
- Retracted papers are excluded from `GET /api/papers` and `GET /api/search` by default. Pass `include_retracted=true` to include them.
- `supplementary_files` — array of supplementary file metadata attached to the paper.
- `metadata_restored` — `true` if metadata was reconstructed from HAF after the original was lost or corrupted.
- `canonical_author` / `canonical_permlink` — for continuation posts, points to the root paper. For non-continuation papers, equals the paper's own author/permlink.
- `head_author` / `head_permlink` — points to the latest version in a continuation chain. For non-continuation papers, equals the paper's own author/permlink.

**Errors:** `NOT_FOUND` if paper does not exist or is not a PEvO paper.

---

### GET /api/papers/:author/:permlink/enrichment

Lazy-loaded enrichment data for a paper (votes, reviews). Separated from the main paper detail endpoint to enable faster initial page loads. The frontend uses this to populate vote and review sections after the initial paper render.

**Response `data`:**

```json
{
  "net_votes": 42,
  "vote_strength": "endorsement",
  "voters": [
    {
      "voter": "scientist2",
      "weight": 8000,
      "effective_weight": 8000,
      "voted_version": 1
    }
  ],
  "reviews": [
    {
      "author": "reviewer1",
      "permlink": "re-scientist1-neural-network-review",
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
      "reviewer_reputation": 0,
      "is_accredited": true,
      "reviewed_version": 1,
      "outdated": false,
      "addressed_by_version": null
    }
  ],
  "authorship_claims": [
    {
      "claimer": "scientist3",
      "author_index": 1,
      "status": "accepted",
      "claimed_at": "2026-03-22T10:00:00Z"
    }
  ]
}
```

**Field notes:**
- `vote_strength` — qualitative tier derived from average effective vote weight: `"strong endorsement"`, `"endorsement"`, `"mild endorsement"`, `"neutral"`, `"mild concerns"`, `"reject"`, `"strong reject"`, or `null` if no effective voters.
- `voters[]` — per-voter breakdown. `effective_weight` reflects the voter's signal weight (vote strength). `voted_version` indicates which paper version the vote was cast on (inferred from block number for native votes, explicit for revotes). Votes persist across paper revisions and are never invalidated by edits.
- `reviews[].reviewer_reputation` — always `0` (not yet computed per-review; reserved for future use).
- `reviews[].outdated` — `true` if the review was written against an older version than the current paper.
- `reviews[].addressed_by_version` — version number of a paper revision that explicitly addresses this review, or `null`.
- `authorship_claims[]` — list of non-revoked authorship claims on this paper. `status` is `accepted` (auto-accepted via ORCID/hive username match, or manually approved) or `pending`. Revoked claims are excluded.

**Errors:** `NOT_FOUND` if paper does not exist.

---

### GET /api/papers/:author/:permlink/claims

List authorship claims on a paper. Cached for 2 minutes.

**Response `data`:**

```json
{
  "claims": [
    {
      "claimer": "scientist3",
      "paper_author": "scientist1",
      "paper_permlink": "neural-network-plasticity-2026",
      "author_index": 1,
      "status": "accepted",
      "claimed_at": "2026-03-22T10:00:00Z"
    }
  ]
}
```

Revoked claims are excluded from the response.

---

### POST /api/papers/:author/:permlink/claims

Claim an author slot on a paper. Requires accredited user. Returns the `custom_json` operation for the frontend to broadcast via Hive Keychain or custody endpoint.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`

**Request Body:**

```json
{
  "author_index": 1
}
```

`author_index` — zero-based index into the paper's `authors` array, or `null` for unlisted authors.

**Response `data`:**

```json
{
  "operation": ["custom_json", { "id": "pevotest", "json": "...", "required_auths": [], "required_posting_auths": ["scientist3"] }],
  "message": "Broadcast this operation to claim authorship"
}
```

**Errors:**
- `FORBIDDEN` — user is not accredited
- `BAD_REQUEST` — invalid `author_index`

**Rate limit:** 5 per minute per account.

---

### POST /api/papers/:author/:permlink/claims/:claimer/approve

Approve a pending authorship claim. For bridge papers, the server broadcasts directly with the bridge account key. For native papers, returns the operation for the post author to broadcast.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`

**Request Body:**

```json
{
  "author_index": 1
}
```

**Response `data` (bridge paper):**

```json
{
  "message": "Authorship claim approved",
  "tx_id": "<Hive transaction ID>"
}
```

**Response `data` (native paper):**

```json
{
  "operation": ["custom_json", { "..." }],
  "message": "Broadcast this operation to approve the authorship claim"
}
```

**Authorization:**
- **Native papers:** only the post author.
- **Bridge papers:** the platform admin OR an existing approved co-author (a claimer with an `accepted` authorship-claim on the same paper, AND who is currently accredited per `active_accreditations`). A claimer cannot approve their own pending claim — the approval chain must bootstrap with the admin, who seeds the first approved co-author; after that, approved co-authors can vouch for new claimants. This prevents anyone from self-approving their way to bridge-key server-side broadcast. Co-sign authority tracks accreditation live: if a previously-approved co-author is later revoked, they immediately lose the ability to co-sign new approvals (the `isApprovedCoAuthor` HAF query JOINs `active_accreditations` so a revoked account yields zero rows). Without this JOIN, the immutable accepted-claim row on HAF would grant lifelong co-sign authority regardless of trust changes.

**Errors:**
- `FORBIDDEN` — `"Only the post author can approve claims on native papers"` (native path), OR `"Only the platform admin or an approved co-author can approve claims on bridge papers"` (bridge path, caller is neither admin nor approved co-author), OR `"Claimer cannot approve their own claim"` (bridge path, caller is the claimer even if they are admin or co-author elsewhere).
- `UNAUTHORIZED` — invalid Hive signature.
- `BROADCAST_FAILED` (502) — Hive chain rejected the approve broadcast. `details.retriable: false`. Fires only on the bridge-server-side-broadcast path.
- `BROADCAST_TIMEOUT` (504) — Backend aborted the broadcast at 30s. Outcome uncertain. `details.retriable: false, details.outcome: 'uncertain', details.verify_before_retry: true, details.timeout_ms: 30000`. Verify chain state (via HAF) before retrying to avoid duplicate approve ops.

**Rate limit:** 10 per minute per account.

---

### POST /api/papers/:author/:permlink/claims/:claimer/revoke

Revoke an authorship claim.

**Authorization:** `isPostAuthor || isClaimer || isAdmin`. The bridge account is NOT implicitly authorized — on bridge papers, the post author IS the bridge account, so admin-driven revokes fall under the `isAdmin` clause. Server-side bridge-key broadcast fires only when the caller is the admin AND the paper is a bridge paper AND `PEVO_BRIDGE_POSTING_KEY` is configured; otherwise the handler returns the operation for the frontend to broadcast (admin revoking a native paper broadcasts under admin's own posting auths).

**Headers:** `X-Hive-Username`, `X-Hive-Signature`

**Request Body:**

```json
{
  "reason": "Unauthorized claim"
}
```

**Response:** Same shape as approve (either `tx_id` for server-broadcast or `operation` for frontend broadcast).

**Errors:**
- `FORBIDDEN` — `"Not authorized to revoke this claim"` (caller is none of: post author, claimer, admin).
- `UNAUTHORIZED` — invalid Hive signature.
- `BROADCAST_FAILED` (502) — Hive chain rejected the revoke broadcast. `details.retriable: false`. Fires on the bridge-admin and admin-on-native server-side-broadcast paths.
- `BROADCAST_TIMEOUT` (504) — Backend aborted the broadcast at 30s. Outcome uncertain. `details.retriable: false, details.outcome: 'uncertain', details.verify_before_retry: true, details.timeout_ms: 30000`. Verify chain state before retrying.

**Rate limit:** 10 per minute per account.

---

### GET /api/papers/:author/:permlink/comments

Discussion comments on a paper (threaded). Returns a flat list of all comments; the frontend builds the tree using `parent_author`/`parent_permlink` fields. Only comments from accredited authors are included — the gate is unconditional, no opt-out.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
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
- The API returns a **flat list**. The frontend builds the thread tree client-side using `parent_author`/`parent_permlink` fields.
- Top-level comments have `parent_author` = paper author and `parent_permlink` = paper permlink.
- Replies to comments have `parent_author` = parent commenter and `parent_permlink` = parent comment permlink.
- `net_votes` reflects accredited votes only.

**Errors:** `NOT_FOUND` if paper does not exist.

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
  "message": "Paper retracted",
  "tx_id": "<Hive custom_json transaction ID>"
}
```

**Errors:**
- `UNAUTHORIZED` — invalid signature
- `FORBIDDEN` — user is neither the paper author, `pevo.admin`, nor (for bridge papers) the registerer or an original author listed in `pevo.authors[].hive`
- `NOT_FOUND` — paper does not exist
- `VALIDATION_ERROR` (422) — paper is already retracted
- `BROADCAST_FAILED` (502) — Hive chain rejected the retract broadcast. `details.retriable: false`.
- `BROADCAST_TIMEOUT` (504) — Backend aborted the broadcast at 30s. Outcome uncertain. `details.retriable: false, details.outcome: 'uncertain', details.verify_before_retry: true, details.timeout_ms: 30000`. Retraction is idempotent at the chain layer; retry is safe after verifying the op did not land.

---

### POST /api/papers/:author/:permlink/invalidate

Invalidate the server-side cache for a paper. Useful after editing or updating a paper to force fresh data on the next request.

**Headers:** `Authorization: Bearer <jwt>` or `X-Hive-Username`, `X-Hive-Signature`

**Response `data`:**

```json
{
  "message": "Cache invalidated"
}
```

**Rate limit:** 10 requests per account per minute.

---

### GET /api/search

Full-text search across PEvO papers and reviews.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `q` | string | **required** | Search query |
| `type` | enum | `all` | `paper` or `all` (reviews are not searchable via this endpoint) |
| `discipline` | string | — | Filter by discipline. Match is case-insensitive (the backend lowercases both the query param and the stored value via `LOWER()`). Case-variant values share a single Redis cache entry. Pass `canon_name` from `GET /api/disciplines` as the canonical form. Repeated params (`?discipline=a&discipline=b`) are treated as no-filter rather than coerced to a single value; clients SHOULD send exactly one value. Values must match `^[\p{L}\p{N} \-]+$` (Unicode letters/digits/space/hyphen) and be at most 100 characters; longer or other-charset values return `400 BAD_REQUEST` with `{ code: 'BAD_REQUEST', message: 'Discipline filter invalid' }`. |
| `language` | string | — | Filter by language code (e.g. `en`, `de`, `es`) |
| `source` | enum | — | Filter by paper source: `native`, `bridge`, or omit for both |
| `include_retracted` | boolean | `false` | Include retracted papers in results |
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
  "created": "2026-03-20T14:30:00Z",
  "is_accredited": true
}
```

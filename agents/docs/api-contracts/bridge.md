# PEvO API Contract — Bridge

Endpoints for registering external preprints (arXiv, CrossRef, etc.) as bridge papers on PEvO.

---

### GET /api/bridge/lookup

Preview metadata for a preprint by DOI, arXiv ID, or URL from a supported source. No authentication required. Used by the frontend to show a preview before registration.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `identifier` | string | **required** | DOI, arXiv ID, or URL from a supported source. Accepted formats: bare DOI (`10.1101/...`), `doi.org` URL, arXiv ID (`2301.12345`), `arxiv:` prefix, `arxiv.org` URL, `biorxiv.org` URL, `medrxiv.org` URL, `pubmed.ncbi.nlm.nih.gov` URL, `semanticscholar.org` URL, `researchgate.net/publication/` URL |

**Rate limit:** 20 requests per IP per minute.

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

**Rate limit:** 20 requests per IP per minute.

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
- `INTERNAL_ERROR` — check failed (e.g. HAF query error)

---

### POST /api/bridge/register

Register an existing preprint as a bridge paper on PEvO. The backend validates the request, checks for duplicates, and broadcasts the Hive post **server-side** under the bridge account (`HIVE_BRIDGE_ACCOUNT`). The requesting user only needs to authenticate via Keychain signature — no client-side Hive broadcast is required.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`, `X-Hive-Timestamp` (see [common.md → Direct Hive Signature Authentication](common.md) for the signed-message format)

**Request Body:**

```json
{
  "identifier": "2301.12345",
  "discipline": "Computer Science",
  "keywords": ["transformers", "attention", "NLP"],
  "language": "en"
}
```

The `identifier` accepts the same formats as `/api/bridge/lookup` (DOI, arXiv ID, or URL from PubMed, bioRxiv, medRxiv, Semantic Scholar, ResearchGate). The `discipline` is required and must be a valid discipline from the taxonomy. `keywords` and `language` are optional (defaults: empty array, `"en"`).

**Rate limit:** 10 requests per IP per hour.

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
- `DUPLICATE` (HTTP 409) — preprint already registered on PEvO. `error.details` includes `existing_author` and `existing_permlink` pointing at the existing post.
- `LOCK_HELD` (HTTP 409) — a concurrent `/register` for the same preprint is in flight and holds the Redis lock. Retriable shortly. `error.details`: `{retriable: true}`. Distinct from `DUPLICATE` so SPA / integrators can switch on `err.code` without parsing the message string.
- `BROADCAST_TIMEOUT` (504) — broadcast timed out before chain confirmation. Message: `"Broadcasting bridge paper registration timed out"`. Details: `{retriable:false, outcome:"uncertain", verify_before_retry:true, timeout_ms}`. The broadcast may have landed; verify via the chain before retrying. See [common.md → Broadcast Error Envelopes](common.md).
- `BROADCAST_FAILED` (502) — Hive node rejected the broadcast. Message: `"Failed to broadcast bridge paper registration to Hive"`. Details: `{retriable:false}`.
- `SERVICE_UNAVAILABLE` (503) — bridge posting key not configured on the deployment. Operator misconfiguration; a redeploy with `PEVO_BRIDGE_POSTING_KEY` set restores service. Message: `"Bridge posting key not configured"`.
- `RATE_LIMITED` — too many registrations

---

### POST /api/bridge/update

Re-fetch metadata from the source for an existing bridge paper and broadcast the updated post **server-side** under the bridge account. Used when the source preprint has a new version.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`, `X-Hive-Timestamp` (see [common.md → Direct Hive Signature Authentication](common.md) for the signed-message format)

**Request Body:**

```json
{
  "permlink": "bridge-arxiv-2301-12345"
}
```

Only the original registerer (matched via `pevo.source.registered_by` in the existing post's metadata) can update a bridge paper.

**Rate limit:** 10 requests per IP per hour.

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
- `BROADCAST_TIMEOUT` (504) — broadcast timed out before chain confirmation. Message: `"Broadcasting bridge paper update timed out"`. Details: `{retriable:false, outcome:"uncertain", verify_before_retry:true, timeout_ms}`. The broadcast may have landed; verify via the chain before retrying.
- `BROADCAST_FAILED` (502) — Hive node rejected the broadcast. Message: `"Failed to broadcast bridge paper update to Hive"`. Details: `{retriable:false}`.
- `SERVICE_UNAVAILABLE` (503) — bridge posting key not configured on the deployment. Operator misconfiguration; a redeploy with `PEVO_BRIDGE_POSTING_KEY` set restores service. Message: `"Bridge posting key not configured"`.

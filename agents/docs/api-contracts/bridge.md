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
- `INTERNAL_ERROR` — check failed for a non-HAF reason (e.g. `resolveToCanonical` throws or another outer-catch error). HAF query failures do NOT flow through `INTERNAL_ERROR`: `/check` is fail-open on HAF outage and returns HTTP 200 with body `{exists:false, author:null, permlink:null, title:null, created:null}`, accompanied by a structured warn log keyed on `event:'bridge.check.haf_check_failed'`, `route:'bridge.check'` for operator visibility. Callers reading `/check` for client-side duplicate-prevention should treat a `{exists:false}` answer during a known HAF outage as advisory: the authoritative duplicate-check guarantee applies only when `/register` is invoked, and `/register` itself fail-closes with `503 SERVICE_UNAVAILABLE` on HAF outage (see the `/register` errors section below).

---

### POST /api/bridge/register

Register an existing preprint as a bridge paper on PEvO. The backend validates the request, deduplicates it, and **enqueues** it. The Hive post is broadcast later **server-side** under the bridge account (`HIVE_BRIDGE_ACCOUNT`) by a background worker, one broadcast per chain-cooldown window. The endpoint returns immediately with a queue entry rather than waiting for chain confirmation. The requesting user only needs to authenticate via Keychain signature; no client-side Hive broadcast is required.

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

**Rate limit:** 10 requests per IP per hour. Independently, each accredited user has a per-account cap of 5 in-flight (pending or in-progress) queued imports. Exceeding the cap returns `RATE_LIMITED` (see below); it is a distinct limit from the per-IP limiter and they share the `RATE_LIMITED` code.

**Response (HTTP 202 Accepted):** `EnqueueBridgePaperResponse`

A successful enqueue returns **HTTP 202 Accepted** (not 200). The body follows the standard `{ "status": "ok", "data": ... }` envelope but is constructed with HTTP 202 directly (the entry is accepted, not yet broadcast), so callers must treat 202 as success alongside 200.

```json
{
  "status": "ok",
  "data": {
    "entry": {
      "id": 42,
      "operation_kind": "register",
      "identifier": "2301.12345",
      "permlink": "bridge-arxiv-2301-12345",
      "discipline": "Computer Science",
      "keywords": ["transformers"],
      "language": "en",
      "state": "pending",
      "attempts": 0,
      "scheduled_at": "2026-05-26T14:00:00.000Z",
      "tx_id": null,
      "error_code": null,
      "error_message": null,
      "existing_author": null,
      "existing_permlink": null,
      "created_at": "2026-05-26T14:00:00.000Z",
      "completed_at": null
    },
    "queue_position": 1,
    "eta_seconds": 0,
    "source": {
      "type": "arxiv",
      "doi": "10.48550/arXiv.2301.12345",
      "arxiv_id": "2301.12345",
      "url": "https://arxiv.org/abs/2301.12345"
    }
  }
}
```

The `entry` object is the queue row (full field reference under `GET /api/bridge/imports` below). At enqueue time `state` is `"pending"`, `tx_id` is `null`, and `error_code`/`error_message` are `null`. The broadcast happens on a later worker tick: `tx_id` populates and `state` advances to `"completed"` (or `"failed"`) only after dispatch. The Hive post is authored by the bridge account (not the requesting user); the requesting user is recorded in the on-chain `pevo.source.registered_by` field. Poll `GET /api/bridge/imports` for the terminal outcome. `queue_position` is the entry's 1-based position in the dispatch order; `eta_seconds` is a best-effort estimate derived from the 5-minute chain cooldown (position 1 dispatches on the next tick, so its ETA is 0).

**Errors (synchronous, at enqueue time):**
- `UNAUTHORIZED`: invalid signature.
- `FORBIDDEN`: user is not accredited.
- `BAD_REQUEST`: missing identifier, invalid discipline, or identifier not found at source. Also returned with **HTTP 415** when the request `Content-Type` is not `application/json` (the body never parses under `express.json`, so the request is rejected inside `validateRegisterBody` before the rate limiter runs; no slot consumed). The error `code` stays `BAD_REQUEST` because the response envelope has no `UNSUPPORTED_MEDIA_TYPE` code; only the HTTP status is 415.
- `DUPLICATE` (HTTP 409): the preprint is already on PEvO, or already queued. The same `code` covers both; the caller distinguishes via `error.details`. Already registered on chain: `{ existing_author, existing_permlink }`, pointing at the existing post. Already queued (an active pending or in-progress entry for the same permlink): `{ existing_entry_id, existing_entry_state }`, pointing at the in-flight queue entry.
- `LOCK_HELD` (HTTP 409): a concurrent `/register` for the same preprint holds the Redis dedup lock. Retriable shortly. `error.details`: `{retriable: true}`. Distinct from `DUPLICATE` so the SPA can switch on `err.code` without parsing the message string.
- `RATE_LIMITED` (HTTP 429): two distinct sources share this code. The per-IP limiter (10/hour) rejects with the standard limiter envelope. The per-user in-flight cap rejects when the caller already holds `cap` pending or in-progress imports: `error.details` is `{ retriable: true, inflight, cap }` and the message names the in-flight count and cap. Submission resumes once one in-flight import completes.
- `SERVICE_UNAVAILABLE` (HTTP 503): either the bridge posting key is not configured on the deployment (operator misconfiguration; message `"Bridge posting key not configured"`; a redeploy with `PEVO_BRIDGE_POSTING_KEY` set restores service), or the HAF duplicate-check is temporarily unavailable (`error.details`: `{retriable: true}`). Both fail closed before any entry is enqueued.
- `INTERNAL_ERROR` (HTTP 500): identifier resolution threw, metadata fetch threw, or the enqueue write failed.

Because the broadcast is now asynchronous, the synchronous `BROADCAST_TIMEOUT` (504) and `BROADCAST_FAILED` (502) responses no longer occur on this endpoint. Broadcast outcomes surface on the queue entry's `error_code` field instead (see `GET /api/bridge/imports`).

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
- `BROADCAST_TIMEOUT` (504) — broadcast timed out before chain confirmation. Message: `"Broadcasting bridge paper update timed out"`. Details: `{retriable:false, outcome:"uncertain", verify_before_retry:true, timeout_ms}` (`timeout_ms` is present; these routes always use the timer-fire path). The broadcast may have landed; verify via the chain before retrying.
- `BROADCAST_FAILED` (502) — Hive node rejected the broadcast. Message: `"Failed to broadcast bridge paper update to Hive"`. Details: `{retriable:false}`.
- `SERVICE_UNAVAILABLE` (503) — bridge posting key not configured on the deployment. Operator misconfiguration; a redeploy with `PEVO_BRIDGE_POSTING_KEY` set restores service. Message: `"Bridge posting key not configured"`.

---

### GET /api/bridge/imports

List the caller's own bridge import queue entries. Used by the SPA's "My imports" surface to render pending, in-progress, completed, and failed entries and their terminal outcomes. Because `/api/bridge/register` is now asynchronous, this endpoint is how a caller learns the broadcast result.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`, `X-Hive-Timestamp` (see [common.md → Direct Hive Signature Authentication](common.md) for the signed-message format)

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `state` | string | (all) | Optional filter. One of `pending`, `in_progress`, `completed`, `failed`. An unrecognized value returns `BAD_REQUEST`. |
| `limit` | integer | 50 | Optional. Must be a positive integer; values over 200 are clamped down. A non-integer or non-positive value returns `BAD_REQUEST` (the guard prevents `LIMIT NaN` reaching SQL). |

Entries are scoped to the authenticated `X-Hive-Username`. There is no caller-controlled selector for another user's entries.

**Response `data`:** `BridgeImportListResult`

```json
{
  "entries": [
    {
      "id": 42,
      "operation_kind": "register",
      "identifier": "2301.12345",
      "permlink": "bridge-arxiv-2301-12345",
      "discipline": "Computer Science",
      "keywords": ["transformers"],
      "language": "en",
      "state": "completed",
      "attempts": 1,
      "scheduled_at": "2026-05-26T14:05:00.000Z",
      "tx_id": "abc123...",
      "error_code": null,
      "error_message": null,
      "existing_author": null,
      "existing_permlink": null,
      "created_at": "2026-05-26T14:00:00.000Z",
      "completed_at": "2026-05-26T14:05:01.000Z"
    }
  ],
  "cap": 5
}
```

`cap` is the per-user in-flight cap, the same limit enforced by `/register`'s `RATE_LIMITED` branch.

**Queue entry fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Queue entry id. |
| `operation_kind` | string | `"register"`. The column is general to allow future bridge operations. |
| `identifier` | string | The submitted identifier. |
| `permlink` | string | The deterministic bridge permlink. |
| `discipline`, `keywords`, `language` | | As submitted. |
| `state` | string | `pending`, `in_progress`, `completed`, or `failed`. |
| `attempts` | number | Broadcast attempts consumed. Pre-broadcast transient outages (metadata or HAF unavailable, or a post-broadcast completion-write failure) do NOT increment this. |
| `scheduled_at` | string (ISO 8601) | Next dispatch time. |
| `tx_id` | string \| null | Hive transaction id once the broadcast lands; `null` before. |
| `error_code` | string \| null | Last error classification (values below). `null` on success or while pending with no prior error. |
| `error_message` | string \| null | Human-readable last error. |
| `existing_author`, `existing_permlink` | string \| null | Set when the entry resolved to an already-on-chain post (permlink-collision short-circuit; the entry completes pointing at the existing post). |
| `created_at` | string (ISO 8601) | Enqueue time. |
| `completed_at` | string (ISO 8601) \| null | Terminal time (`completed` or `failed`); `null` while non-terminal. |

**`error_code` values** (set on the entry by the background worker; these are queue states, not HTTP codes):

- `BAD_REQUEST`: identifier no longer resolvable at dispatch or source preprint gone (terminal `failed`), or metadata source transiently unavailable (reschedules, does not consume the broadcast budget).
- `SERVICE_UNAVAILABLE`: HAF duplicate-check unavailable at dispatch (reschedules, no budget consumed), or the bridge posting key was not configured at dispatch (terminal `failed`).
- `BROADCAST_TIMEOUT`: the broadcast timed out before chain confirmation. The post may still have landed; the next tick's pre-broadcast on-chain reconciliation resolves it. Consumes the broadcast budget.
- `BROADCAST_FAILED`: the Hive node rejected the broadcast. Consumes the broadcast budget.
- `COMPLETION_WRITE_FAILED`: the broadcast landed but the completion write failed. The entry stays `pending`; the next tick's pre-broadcast on-chain reconciliation finds the post and completes the entry. Does not consume the broadcast budget and does not re-broadcast (the chain cooldown is recorded before the failed write).

An entry that consumes its broadcast budget (5 attempts) transitions to terminal `failed` with its last `error_code` retained.

**Errors:**
- `UNAUTHORIZED`: invalid signature.
- `BAD_REQUEST`: invalid `state` filter or invalid `limit`.
- `INTERNAL_ERROR`: listing failed.

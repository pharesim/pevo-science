# PEvO API Contract — Reviews

Endpoints for viewing and submitting reviews.

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

**Field notes:**
- `net_votes` — counts only votes from accredited users (net sum of +1/-1 per accredited voter), not all Hive votes.

**Errors:**
- `NOT_FOUND` — review does not exist, is not a PEvO review (fails `validReviewWhere()` in `backend/src/hafsql.ts`), or its parent post is not a valid PEvO paper (fails `validPevoPaperWhere(source:'all')` in `backend/src/hafsql.ts`; covers both native pevo paper posts and `bridge_paper` posts authored by `config.hiveBridgeAccount`)
- `SERVICE_UNAVAILABLE` (503) — transient HAF failure on the review fetch. `details.retriable: true`. Distinguished from `NOT_FOUND` so consumers can surface a retry affordance for outages instead of treating them as "review does not exist." Sibling route to the other 503-retriable HAF-outage emitters; see the cross-cutting note in [common.md § Error envelope](common.md).

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

**Rate limit:** 5 requests per account per hour.

**Errors:**
- `UNAUTHORIZED` -- invalid signature or account not found
- `FORBIDDEN` -- reviewer is not accredited, or reviewer is an author/co-author of the paper (self-review prevention)
- `BAD_REQUEST` -- missing fields or invalid rating values

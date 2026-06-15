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
- `net_votes` is the net sum of the latest accredited signal per voter (+1 or -1), counting both native Hive votes and post-payout `revote` `custom_json` operations. A voter who flipped or retracted via a revote after the 7-day Hive payout window is reflected here, at parity with the reputation cycle. Self-votes are excluded, and unaccredited signals are never counted.

**Errors:**
- `NOT_FOUND` — review does not exist, is not a PEvO review (fails `validReviewWhere()` in `backend/src/hafsql.ts`), is authored by a credited authorship-claimer holding an `accepted` claim on the reviewed paper (the display self-review exclusion drops it via `excludeClaimedSelfWhere()`, so this endpoint now returns 404 for a credited claimer's self-review where it previously returned 200), or its parent post is not a valid PEvO paper (fails `validPevoPaperWhere(source:'all')` in `backend/src/hafsql.ts`; covers both native pevo paper posts and `bridge_paper` posts authored by `config.hiveBridgeAccount`)
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

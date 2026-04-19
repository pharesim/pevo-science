# PEvO API Contract — Notifications

Endpoints for polling notification events.

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

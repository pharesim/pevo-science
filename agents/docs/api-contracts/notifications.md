# PEvO API Contract: Notifications

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
      "permlink": "re-neural-network-comment-2"
    },
    {
      "type": "claim_pending",
      "block_num": 82345950,
      "timestamp": "2026-03-25T14:42:00Z",
      "actor": "scientist6",
      "paper_author": "scientist1",
      "paper_permlink": "neural-network-plasticity-2026"
    },
    {
      "type": "claim_approved",
      "block_num": 82346000,
      "timestamp": "2026-03-25T14:45:00Z",
      "paper_author": "scientist1",
      "paper_permlink": "neural-network-plasticity-2026"
    },
    {
      "type": "claim_revoked",
      "block_num": 82346010,
      "timestamp": "2026-03-25T14:46:00Z",
      "paper_author": "scientist1",
      "paper_permlink": "neural-network-plasticity-2026"
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
| `new_review` | New review on your paper. Trigger conditions: `type='review'`, authored by an accredited reviewer or the anon proxy, with a structurally-valid 4-dim rating object (each dimension an integer in `[1,5]`), parent is a PEvO paper (native or bridge), and not authored by the paper author or a named co-author. Source of truth: `validReviewWhere()` in `backend/src/hafsql.ts`. | Paper author |
| `new_citation` | New paper whose pevo.citations references your paper | Cited paper author |
| `new_vote` | New vote on your paper or review from an accredited voter. `target_type` is `"paper"` for votes on a native or bridge paper and `"review"` for votes on a review. Self-votes do not fire. Votes on discussion comments do not fire. | Content author |
| `accreditation_update` | Your accreditation is granted or revoked | Target account |
| `new_vouch` | Someone vouches for you in WoT | Vouchee |
| `new_reply` | New discussion comment (pevo.type=comment) replying to your comment | Parent comment author |
| `claim_pending` | Someone files an authorship claim (`action='claim_authorship'`) on your paper, signed by the accredited claimer. `actor` is the claimer. | Post author (`paper_author`) |
| `claim_approved` | Your authorship claim is approved (`action='approve_authorship'`), signed by the original post author or the bridge account. No `actor`. | Claimer |
| `claim_revoked` | Your authorship claim is revoked (`action='revoke_authorship'`), signed by the original post author or the bridge account. No `actor`. | Claimer |

**Rate Limiting:** 30 requests per account per 5 minutes (one poll per 10 seconds burst, but expected interval is 5 minutes).

**Errors:**
- `UNAUTHORIZED` -- invalid signature
- `BAD_REQUEST` -- missing `since_block`

**Notes:**
- Only accredited-voter votes trigger `new_vote` events, consistent with the platform-wide accredited-only policy.
- `new_reply` carries no `paper_author` / `paper_permlink`. A reply can sit any number of levels deep in a comment chain, so the root paper coordinates are not resolvable without unbounded recursive queries. Clients that want the paper context should resolve it from the `parent_author` / `parent_permlink` chain.
- The `claim_*` events carry the paper coordinates (`paper_author`, `paper_permlink`) but no `paper_title`. `claim_pending` notifies the post author and carries `actor` (the claimer); `claim_approved` and `claim_revoked` notify the claimer and carry no `actor`. All three are signer-gated (per `hive-schemas.md` § 2.9, § 2.10, § 2.11) so a forged `claim_authorship` / `approve_authorship` / `revoke_authorship` cannot spam notifications.
- The backend queries HAF for events in the block range `(since_block, latest_head_block]`.
- The first poll: if the client has no stored `since_block`, it should call `GET /api/health` to get the current timestamp, then use the corresponding block number (or simply use `0` to get the most recent events up to `limit`).
- This design is suitable for both web (localStorage cursor) and mobile (SharedPreferences cursor) clients. No persistent connections or server-side state.

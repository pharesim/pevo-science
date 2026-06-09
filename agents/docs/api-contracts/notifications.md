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
| `limit` | integer | `50` | Target page size (max 100). A response may exceed this when one Hive block holds more events than the limit; that block is delivered atomically rather than split. See the `has_more` field. |

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
- `latest_block`: The highest `block_num` included in this response. It is always a *fully delivered* block: the server never splits a single Hive block across the response, so every event of `latest_block` that is newer than `since_block` is present in `events`. On the next poll the client advances its cursor to this value. When the response contains no events, `latest_block` echoes the caller's `since_block` so the cursor holds its position.
- `has_more`: If `true`, more undelivered events newer than the cursor remain inside the server's look-back window beyond this page. Poll again to drain them. The client advances its cursor to `latest_block` on the next poll regardless of `has_more` (there is no rewind step). Whole-block delivery is the guarantee that makes this safe: because `latest_block` is always a complete block, advancing to it can never skip intra-block events. One consequence: a response MAY contain more than `limit` events when a single Hive block holds more than `limit` events targeting the account. That block is delivered atomically (all of it in one response) rather than split, so the count for that one response can exceed `limit`; the overshoot is bounded by the internal fetch cap. Clients should still deduplicate by a per-event key (block, type, actor, target permlink) for robustness against an overlapping re-fetch.

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
| `claim_approved` | Your authorship claim is approved (`action='approve_authorship'`), signed by the original post author or the bridge account. Fires only when you have a real `claim_authorship` op on the same `(paper_author, paper_permlink)`. Repeated or edited approvals of one paper collapse to a single notification (earliest block wins). No `actor`. | Claimer |
| `claim_revoked` | Your authorship claim is revoked (`action='revoke_authorship'`), signed by the original post author, the claimer, the bridge account, or the admin account. Fires only when you have a real `claim_authorship` op on the same `(paper_author, paper_permlink)`. Repeated or edited revocations of one paper collapse to a single notification (earliest block wins). No `actor`. | Claimer |

**Rate Limiting:** 30 requests per account per 5 minutes (one poll per 10 seconds burst, but expected interval is 5 minutes).

**Errors:**
- `UNAUTHORIZED` -- invalid signature
- `BAD_REQUEST` -- missing `since_block`

**Notes:**
- Only accredited-voter votes trigger `new_vote` events, consistent with the platform-wide accredited-only policy.
- `new_reply` carries no `paper_author` / `paper_permlink`. A reply can sit any number of levels deep in a comment chain, so the root paper coordinates are not resolvable without unbounded recursive queries. Clients that want the paper context should resolve it from the `parent_author` / `parent_permlink` chain.
- The `claim_*` events carry the paper coordinates (`paper_author`, `paper_permlink`) but no `paper_title`. `claim_pending` notifies the post author and carries `actor` (the claimer); `claim_approved` and `claim_revoked` notify the claimer and carry no `actor`. All three are signer-gated (per the Claim Authorship, Approve Authorship, and Revoke Authorship schemas in `hive-schemas.md`) so a forged `claim_authorship` / `approve_authorship` / `revoke_authorship` cannot spam notifications. Beyond the signer gate, `claim_approved` and `claim_revoked` also require a real `claim_authorship` op by the recipient on the same `(paper_author, paper_permlink)`, so an approve or revoke that names a recipient who never claimed produces no notification. Repeated or edited approve/revoke broadcasts for one paper collapse to a single notification per `(paper_author, paper_permlink)`.
- The backend computes events against a fixed look-back window of approximately the last 100,000 blocks (about 3.5 days) from the current chain head, not from `since_block`. Within that window the server materializes at most the *newest* N events for the account (N is an internal fetch cap, currently 1,000, deliberately larger than any response `limit`). The window batch is cached server-side per `(account, limit)` for up to 60 seconds; the `since_block` cursor is then applied to the cached batch, so the response contains events in `(since_block, window_head]`. Consequences for clients:
  - Responses can be up to 60 seconds behind the chain head. The polling interval already exceeds this; do not treat the feed as real-time.
  - `since_block = 0` returns events from the look-back window only, not from genesis. "All history" is not a supported query shape.
  - A cursor older than the window floor (a client offline longer than the window span) skips the gap: events between the cursor and the window floor are not returned and will not be returned later. The email digest covers long offline gaps through its own cursor.
  - Because the server keeps the newest N events of the window, an account that accrued more than N events inside the window surfaces only the newest N in this feed; events older than that (but still inside the block window) are not returned to the poll feed. This bounds the bell feed to recent activity for very high-volume accounts; the email digest drains the full set through its own cursor, so nothing is lost overall.
- The first poll: if the client has no stored `since_block`, use `0` to receive the most recent window of events up to `limit`.
- This design is suitable for both web (localStorage cursor) and mobile (SharedPreferences cursor) clients. No persistent connections or server-side state.

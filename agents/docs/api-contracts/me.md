# Me (`/api/me/*`)

Account-scoped reads for the authenticated user. Mounted at `/api/me` (`backend/src/routes/me.ts`). Responses use the standard envelope and error codes from [common.md](common.md).

## GET /api/me/authorships/pending

Discovery surface for the consented-authorship model (`ARCHITECTURE.md` § 2 "Consented vs claimed authorship"): the slots awaiting the authenticated user's action across the papers that name them. Consumed by the paper-detail consent affordances and any "pending authorships" list in the SPA.

**Auth:** required. `verifyHiveSignature` (the standard Hive-signature gate; the user proves they hold the account being queried). The response is scoped to the signing account; there is no path or query parameter, so one user cannot read another user's pending set.

**Request:** no body, no parameters.

**Response (200):**

```json
{
  "pending_claims": [
    {
      "paper_author": "scientist1",
      "paper_permlink": "my-paper",
      "author_index": 1,
      "claimed_at": "2026-03-22T10:00:00Z"
    }
  ],
  "pending_consents": [
    {
      "paper_author": "scientist2",
      "paper_permlink": "another-paper"
    }
  ]
}
```

- `pending_claims[]`: Route-3 (name-only slot) claims the user has broadcast (`claim_authorship`) that are still awaiting the root author's `approve_authorship`. `author_index` is the zero-based slot the claim targets; `claimed_at` is the claim op's timestamp. Ordered newest claim first.
- `pending_consents[]`: Route-2 (anchored slot) papers whose claimed-slot set anchors the user (a `hive` slot equal to their account, or an `orcid` slot equal to their authority-attested ORCID) where the user has not yet broadcast a valid `author_accept`. Identified by `(paper_author, paper_permlink)` only; the SPA resolves the specific slot on the paper-detail page. A user's own root papers are omitted (Route-1 implicit consent), as are slots already cleared by an accept, resign, or revoke.

An empty array for either key means "nothing pending in that route", not an error.

**Freshness:** the result is volatile-cached per account with an at-most-one-block staleness target; a consent op the user broadcasts propagates on the next cache miss.

**Errors:**

- `401 UNAUTHORIZED` when the request is unsigned or the username cannot be resolved.
- `503 SERVICE_UNAVAILABLE` with `{ "retriable": true }` when the HAF read is unavailable (pool down, or a retriable query failure). This surface is fail-closed: it returns 503 rather than an empty `200`, because an empty list would be indistinguishable from "nothing pending" and would silently hide slots awaiting the user's action. Clients SHOULD surface a retry affordance and never render the empty state on a 503. Deterministic (non-retriable) query failures fall through to the central `500`.

**Cross-references:**

- `ARCHITECTURE.md` § 2 "Consented vs claimed authorship" and "Consented-set computation" (the fail-closed posture this endpoint shares with paper-detail).
- [papers.md](papers.md): the per-author `consented` flag and the `authorship_claims[]` array on the paper-detail / enrichment responses (the read side this discovery surface complements).
- `ui-multi-author-consent-affordances` (task): the SPA surface that consumes this endpoint.

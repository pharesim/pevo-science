# PEvO Hive Schemas

> **Owner:** Architect Agent
> **Version:** 0.2

This document defines all Hive post metadata structures and `custom_json` payload schemas used by PEvO. These are the canonical definitions — all agents build against these schemas.

---

## 0. APP_TAG and Metadata Key

All PEvO metadata is keyed by the configurable `APP_TAG` environment variable, **not** a hardcoded string. In production the value is `pevo`; in beta it is `pevotest`. Throughout this document, `APP_TAG` is used as a placeholder. In code:

- `app` field: `"<APP_TAG>/<APP_VERSION>"` (e.g., `"pevo/0.1"` or `"pevotest/0.1"`)
- `parent_permlink` for top-level posts: `APP_TAG`
- `tags` array: first element is `APP_TAG`
- `custom_json` id: `APP_TAG`
- PEvO-specific metadata object: keyed as `[APP_TAG]: { ... }` in `json_metadata`

The `app` field uses pattern matching (`LIKE '<APP_TAG>/%'`) in SQL queries to allow version bumps without breaking queries.

---

## 1. Post Metadata Schemas

All PEvO content is identified by `app: "<APP_TAG>/<APP_VERSION>"` in `json_metadata` and the `APP_TAG` tag.

### 1.1 Paper Post

A PEvO paper is a top-level Hive post (comment with no parent author).

**Hive Operation:** `comment`

| Field | Value |
|-------|-------|
| `parent_author` | `""` (empty — top-level post) |
| `parent_permlink` | `APP_TAG` |
| `author` | Hive username of publishing researcher |
| `permlink` | URL-safe slug (e.g., `neural-plasticity-findings-2026`) |
| `title` | Paper title |
| `body` | Abstract followed by `---` separator and full paper text in Markdown (see Body Format below) |

**`json_metadata` schema:**

```json
{
  "app": "<APP_TAG>/0.1",
  "canonical_url": "https://<domain>/paper/<author>/<permlink>",
  "tags": ["<APP_TAG>", "science", "<discipline>", ...keywords],
  "image": ["https://..."] | absent,
  "<APP_TAG>": {
    "type": "paper",
    "version": 1,
    "authors": [
      {
        "name": "Dr. Full Name",
        "hive": "hive_username",
        "orcid": "0000-0001-2345-6789",
        "affiliation": "University of X"
      }
    ],
    "discipline": "neuroscience",
    "keywords": ["keyword1", "keyword2"],
    "ipfs_cid": "Qm..." | null,
    "ipfs_filename": "paper.pdf" | null,
    "language": "en",
    "document_hash": "<sha256 hex of PDF>" | null,
    "citations": [
      {
        "author": "other_scientist",
        "permlink": "cited-paper-permlink",
        "title": "Title of Cited Paper",
        "reputation_relevant": true
      }
    ],
    "supplementary_files": [
      {
        "cid": "Qm...",
        "filename": "data.csv",
        "type": "text/csv",
        "size": 12345,
        "description": "Raw experiment data"
      }
    ],
    "addresses_reviews": [
      { "author": "reviewer1", "permlink": "re-review-permlink" }
    ] | absent,
    "continues": {
      "author": "original_author",
      "permlink": "original-paper-permlink"
    } | absent
  }
}
```

**Field Notes:**
- `authors` — array of co-authors. The first entry should match the posting `author`. Fields `hive`, `orcid`, and `affiliation` are all optional.
- `ipfs_cid` / `ipfs_filename` / `document_hash` — required together if a PDF is uploaded; all null if the paper is text-only.
- `citations` — array of references to other PEvO papers. Omitted when empty. Each citation has an optional `reputation_relevant` field (default `true`). When `false`, the citation appears in the reference list but is excluded from reputation computation — use this when citing work for context, contrast, or refutation without endorsing it.
- `supplementary_files` — array of IPFS-pinned supplementary materials (datasets, code, etc.). Omitted when empty.
- `addresses_reviews` — present on edited versions to link to the specific reviews this revision addresses. Absent on initial publication.
- `continues` — present only on continuation posts (new permlink continuing a paper when the original author differs from the editor). Points to the current chain head being continued. Absent on initial publication and same-author edits. SQL queries filter out continuation posts (`(json_metadata -> APP_TAG -> 'continues') IS NULL`) to find canonical papers.
- `canonical_url` — top-level metadata field (not inside the `APP_TAG` object). Points to the paper's URL on the PEvO frontend.
- `image` — top-level metadata field. Array of image URLs extracted from markdown image embeds in the body. Only present when the body contains images.
- `discipline` — a discipline string. The frontend offers a taxonomy dropdown, but user-provided values are accepted. The `/api/disciplines` endpoint returns the list of disciplines derived from existing papers. In tags, disciplines are lowercased with spaces replaced by hyphens (e.g., "Computer Science" becomes "computer-science").
- `version` — content version counter, starting at 1. The author increments this on each edit. Revisions use Hive's native edit mechanism (same `author/permlink`, new `comment` operation) or continuation posts (new permlink, with `continues` pointer). HAF stores the full operation history; the Hive API returns only the latest version.

**Body Format:**

The post `body` is structured as abstract + separator + full text:

```markdown
## Abstract

{abstract text, max 2000 characters}

---

{full paper text in Markdown}
```

If the paper has no full text (abstract-only, with a PDF upload), the body is just the `## Abstract` header followed by the abstract, with no separator. The abstract is limited to 2,000 characters. The entire transaction (body + json_metadata + title + overhead) must fit within the 65,536-byte Hive block size limit; the frontend warns at 55 KB and blocks submission at 60 KB.

### 1.2 Bridge Paper Post

A bridge paper represents an existing preprint (from arXiv, bioRxiv, medRxiv, etc.) registered on PEvO for evaluation. It is a real Hive post, structurally similar to a native paper but with `type = "bridge_paper"` and a `source` object describing the external origin.

**Hive Operation:** `comment`

| Field | Value |
|-------|-------|
| `parent_author` | `""` (empty — top-level post) |
| `parent_permlink` | `APP_TAG` |
| `author` | Hive username of the **bridge account** (`HIVE_BRIDGE_ACCOUNT`), not the registering researcher |
| `permlink` | Deterministic slug: `bridge-{source}-{normalized_id}` (e.g., `bridge-arxiv-2301-12345`) |
| `title` | Paper title from source metadata |
| `body` | Formatted abstract with author list, source link, and registration attribution (see below) |

**`json_metadata` schema:**

```json
{
  "app": "<APP_TAG>/0.1",
  "canonical_url": "https://<domain>/paper/<author>/<permlink>",
  "tags": ["<APP_TAG>", "science", "<discipline>"],
  "<APP_TAG>": {
    "type": "bridge_paper",
    "version": 1,
    "authors": [
      {
        "name": "Dr. Full Name",
        "hive": null,
        "orcid": "0000-0001-2345-6789"
      }
    ],
    "discipline": "neuroscience",
    "keywords": ["keyword1", "keyword2"],
    "language": "en",
    "citations": [],
    "ipfs_cid": null,
    "ipfs_filename": null,
    "document_hash": null,
    "source": {
      "type": "arxiv" | "crossref",
      "doi": "10.1234/example.2026" | null,
      "arxiv_id": "2301.12345" | null,
      "url": "https://arxiv.org/abs/2301.12345",
      "pdf_url": "https://arxiv.org/pdf/2301.12345" | null,
      "published_date": "2023-01-15",
      "source_name": "arXiv" | "bioRxiv" | "medRxiv" | "CrossRef",
      "license": "CC-BY-4.0" | null,
      "registered_by": "hive_username"
    }
  }
}
```

**Field Notes:**
- `type` — always `"bridge_paper"` to distinguish from native `"paper"` posts.
- `authors` — populated from source metadata. The `hive` field is `null` for authors without known Hive accounts. The `orcid` field is populated if available from the source. Note: `affiliation` is not typically populated for bridge papers (source APIs may not provide it).
- `tags` — does **not** include `"bridge"` as a tag (unlike the previous version of this schema). Tags are `[APP_TAG, "science", discipline]`.
- `source.type` — `"arxiv"` if fetched from arXiv API, `"crossref"` if fetched from CrossRef API. Papers imported via PubMed, Semantic Scholar, ResearchGate, or bioRxiv/medRxiv URLs are resolved to a DOI and fetched through CrossRef, so their `source.type` is `"crossref"`.
- `source.doi` — present for CrossRef sources and some arXiv papers. May be `null` for arXiv-only papers without a DOI.
- `source.arxiv_id` — present for arXiv sources. `null` for non-arXiv papers.
- `source.url` — canonical URL to the paper on the source server. Always present.
- `source.pdf_url` — direct link to PDF if available from the source. May be `null`.
- `source.published_date` — ISO 8601 date string of original publication on the preprint server.
- `source.source_name` — human-readable name of the source server.
- `source.license` — SPDX license identifier if available from the source metadata. May be `null`.
- `source.registered_by` — Hive username of the accredited researcher who registered this bridge paper. Note: the Hive `author` of a bridge post is the bridge account (`HIVE_BRIDGE_ACCOUNT`), not the registerer.
- `ipfs_cid`, `ipfs_filename`, `document_hash` — always `null` for bridge papers (PEvO does not host the PDF; it links to the source).
- `version` — starts at 1. Incremented when the bridge paper is updated with a new version from the source.
- `citations` — initially empty. Can be populated by the registering user in subsequent edits, just like native papers.

**Post Body Format:**

```markdown
# {title}

**Authors:** {author1}, {author2}, ...
**Published:** {date} on {source_name}
**DOI:** [{doi}](https://doi.org/{doi})
**License:** {license}

---

## Abstract

{abstract text from source}

---

*This paper was originally published on {source_name}. It was registered on PEvO by @{registering_user} to enable open scientific evaluation. [View original]({source_url})*
```

The DOI and License lines are only included when those fields are non-null.

### 1.3 Review Comment

A PEvO review is a Hive comment on a paper post.

**Hive Operation:** `comment`

| Field | Value |
|-------|-------|
| `parent_author` | Paper author's Hive username |
| `parent_permlink` | Paper's permlink |
| `author` | Reviewer's Hive username OR `HIVE_ANON_ACCOUNT` (default: `"pevo.anon"`) for anonymous reviews |
| `permlink` | Auto-generated slug (e.g., `re-scientist1-paper-permlink-{timestamp}`) |
| `title` | `""` (empty — Hive convention for comments) |
| `body` | Review text in Markdown |

**`json_metadata` schema:**

```json
{
  "app": "<APP_TAG>/0.1",
  "tags": ["<APP_TAG>", "review"],
  "<APP_TAG>": {
    "type": "review",
    "version": 1,
    "rating": {
      "methodology": 4,
      "novelty": 5,
      "clarity": 3,
      "significance": 4
    },
    "is_anonymous": false,
    "reviewer_attestation_id": null
  }
}
```

**Field Notes:**
- `rating` — all four dimensions are required. Values are integers 1-5.
- `is_anonymous` — `true` only when the review is posted from `HIVE_ANON_ACCOUNT`.
- `reviewer_attestation_id` — set to `null` for both anonymous and non-anonymous reviews. (The on-chain attestation for anonymous reviews is a separate `custom_json` operation; see section 2.3.)
- `reviewed_version` — not stored in metadata. The backend computes it at read time by comparing the review's `created` timestamp against the paper's version history (the latest version created before the review). This is returned in the API response as `reviewed_version` and used to determine whether a review is outdated.

### 1.4 Discussion Comment

Regular scientific discussion comments on papers (not structured reviews).

**Hive Operation:** `comment`

| Field | Value |
|-------|-------|
| `parent_author` | Paper author OR another commenter |
| `parent_permlink` | Paper permlink OR parent comment permlink |
| `author` | Commenter's Hive username |
| `permlink` | Auto-generated slug |
| `title` | `""` |
| `body` | Comment in Markdown |

**`json_metadata` schema:**

```json
{
  "app": "<APP_TAG>/0.1",
  "tags": ["<APP_TAG>"],
  "<APP_TAG>": {
    "type": "comment",
    "version": 1
  }
}
```

Discussion comments have `type = "comment"` to distinguish them from reviews (`type = "review"`). They have no structured rating.

---

## 2. Custom JSON Schemas

All PEvO `custom_json` operations use `id: APP_TAG`. The `json` field is a stringified JSON object with an `action` field that determines the operation type.

### 2.1 Accreditation

Broadcast by the admin account to attest that a Hive user is a verified scientist.

```json
{
  "action": "accredit",
  "account": "<hive_username>",
  "name": "Dr. Full Name",
  "institution": "University of X",
  "field": "neuroscience",
  "method": "email" | "wot" | "orcid" | "manual",
  "orcid": "0000-0001-2345-6789" | absent,
  "evidence_hash": "<sha256 of verification evidence>",
  "timestamp": "<ISO 8601>"
}
```

**Hive Operation:**

| Field | Value |
|-------|-------|
| `id` | `APP_TAG` |
| `required_auths` | `[]` |
| `required_posting_auths` | `["<HIVE_ADMIN_ACCOUNT>"]` |
| `json` | Stringified JSON above |

**Field Notes:**
- `method` — verification method used. `email` = university email confirmation, `wot` = web of trust, `orcid` = ORCID verification, `manual` = manual admin verification (broadcast directly, no automated route).
- `orcid` — verified ORCID iD, present when the user has completed ORCID OAuth verification (either during accreditation or later via settings). ORCID iDs are public identifiers. A new `accredit` custom_json with `orcid` overwrites the previous accreditation record (the CTE takes the most recent by `block_num`). Used for authorship claim auto-acceptance.
- `evidence_hash` — hash of the verification evidence (email confirmation, signed document, etc.). The evidence itself is NOT stored on-chain.

### 2.2 Revocation

Revokes a previously issued accreditation.

```json
{
  "action": "revoke",
  "account": "<hive_username>",
  "reason": "Institution affiliation no longer valid",
  "timestamp": "<ISO 8601>"
}
```

**Hive Operation:**

| Field | Value |
|-------|-------|
| `id` | `APP_TAG` |
| `required_auths` | `[]` |
| `required_posting_auths` | `["<HIVE_ADMIN_ACCOUNT>"]` |
| `json` | Stringified JSON above |

An account's accreditation status is determined by the most recent `accredit` or `revoke` action targeting that account.

### 2.3 Anonymous Review Attestation

Broadcast on-chain as a public attestation that an anonymous review was posted by an accredited researcher. The actual reviewer-to-review mapping is stored **off-chain** (encrypted in the backend database), not on-chain.

```json
{
  "action": "anon_review",
  "review_permlink": "<permlink of the anonymous review>",
  "paper_author": "<paper author>",
  "paper_permlink": "<paper permlink>",
  "attestation_id": "<sha256 hash of permlink + encrypted data>",
  "expires": "<ISO 8601 — 6 months from now>",
  "timestamp": "<ISO 8601>"
}
```

**Hive Operation:**

| Field | Value |
|-------|-------|
| `id` | `APP_TAG` |
| `required_auths` | `[]` |
| `required_posting_auths` | `["<HIVE_ANON_ACCOUNT>"]` |
| `json` | Stringified JSON above |

**Security Notes:**
- The `attestation_id` is a SHA-256 hash of `permlink:encrypted_ciphertext_hex`. It proves an accredited reviewer posted the review without revealing their identity on-chain.
- The encrypted reviewer mapping (AES-256-GCM) is stored in the backend database, not on-chain.
- After the `expires` date, the backend permanently deletes the decryption key for this mapping.
- Decryption before expiry requires a governance process (not yet specified).

### 2.4 Update Reputation Weights

Updates the reputation algorithm weights. Effective immediately for new computations.

```json
{
  "action": "update_weights",
  "weights": {
    "paper": 20,
    "review": 10,
    "downvote": 2,
    "citation": 3,
    "citation_max": 15,
    "accreditation_bonus": 5,
    "self_citation_discount": 0.05,
    "decay_rate": 0.02,
    "decay_floor": 0.3,
    "decay_grace_months": 6,
    "cycle_blocks": 28800
  },
  "rationale": "v0.4 — deterministic cycle-based computation",
  "timestamp": "<ISO 8601>"
}
```

**Hive Operation:**

| Field | Value |
|-------|-------|
| `id` | `APP_TAG` |
| `required_auths` | `[]` |
| `required_posting_auths` | `["<HIVE_ADMIN_ACCOUNT>"]` |
| `json` | Stringified JSON above |

The current weights are determined by the most recent `update_weights` custom_json. If none exists, defaults from the reputation algorithm spec apply. All fields are optional. Missing fields use defaults from `DEFAULT_REPUTATION_WEIGHTS` in `backend/src/types/domain.ts`. `cycle_blocks` (default 28,800 = ~1 day at 3s/block) controls the block-based reputation computation cycle length.

### 2.5 Vouch (Web of Trust)

Broadcast by an accredited researcher to vouch for another researcher's credentials.

```json
{
  "action": "vouch",
  "voucher": "<accredited_hive_username>",
  "vouchee": "<hive_username>",
  "relationship": "colleague" | "advisor" | "collaborator",
  "timestamp": "<ISO 8601>"
}
```

**Hive Operation:**

| Field | Value |
|-------|-------|
| `id` | `APP_TAG` |
| `required_auths` | `[]` |
| `required_posting_auths` | `["<voucher_username>"]` |
| `json` | Stringified JSON above |

**Field Notes:**
- `voucher` must be an accredited researcher.
- `relationship` describes the professional connection between voucher and vouchee.
- When a vouchee accumulates `min_accreditations_for_wot` (default: 3) vouches from distinct accredited researchers, the backend broadcasts an `accredit` action with `method: "wot"`.
- A researcher cannot vouch for themselves.

### 2.6 Retract Vouch

Retracts a previously issued vouch.

```json
{
  "action": "retract_vouch",
  "voucher": "<accredited_hive_username>",
  "vouchee": "<hive_username>",
  "reason": "No longer affiliated",
  "timestamp": "<ISO 8601>"
}
```

**Hive Operation:**

| Field | Value |
|-------|-------|
| `id` | `APP_TAG` |
| `required_auths` | `[]` |
| `required_posting_auths` | `["<voucher_username>"]` |
| `json` | Stringified JSON above |

**Cascading Effects:** If retracting a vouch causes a WoT-accredited researcher to drop below the `min_accreditations_for_wot` threshold, the backend suspends their accreditation by broadcasting a `revoke` action with `reason: "WoT threshold no longer met"`.

### 2.7 Retract Paper

Marks a paper as retracted. Retracted papers remain on-chain and are accessible via their direct URL (the detail endpoint returns them with `is_retracted: true`, `retraction_reason`, and `retraction_timestamp`; the frontend displays a retraction banner). They are excluded from paper listings and reputation computation by default. Listings accept an `include_retracted` query parameter to override.

```json
{
  "action": "retract_paper",
  "author": "<hive_username>",
  "permlink": "<paper_permlink>",
  "reason": "Error discovered in methodology section 3.2",
  "timestamp": "<ISO 8601>"
}
```

**Hive Operation:**

| Field | Value |
|-------|-------|
| `id` | `APP_TAG` |
| `required_auths` | `[]` |
| `required_posting_auths` | `["<paper_author>"]` or `["<HIVE_ADMIN_ACCOUNT>"]` |
| `json` | Stringified JSON above |

Either the paper author or the admin account (for misconduct cases) may retract.

### 2.8 Platform Parameter Update

Updates configurable platform parameters.

```json
{
  "action": "update_params",
  "params": {
    "max_upload_size_mb": 50,
    "anon_review_ttl_days": 180,
    "min_accreditations_for_wot": 3
  },
  "rationale": "...",
  "timestamp": "<ISO 8601>"
}
```

**Hive Operation:** Same structure as 2.4 (admin account posting auth).

### 2.9 Claim Authorship

Broadcast by an accredited user to claim an author slot on a paper. The claim is auto-accepted when: (a) the claimer's on-chain verified ORCID matches `authors[i].orcid` in the paper metadata, or (b) `authors[i].hive === claimer` for native papers. Otherwise, the claim is pending until approved by the original post author (native papers) or bridge account (bridged papers).

```json
{
  "action": "claim_authorship",
  "paper_author": "<post_author>",
  "paper_permlink": "<permlink>",
  "author_index": 2,
  "timestamp": "<ISO 8601>"
}
```

**Hive Operation:**

| Field | Value |
|-------|-------|
| `id` | `APP_TAG` |
| `required_auths` | `[]` |
| `required_posting_auths` | `["<claimer_username>"]` |
| `json` | Stringified JSON above |

**Field Notes:**
- `paper_author` / `paper_permlink` — identify the canonical (root) paper post. For bridged papers, `paper_author` is the bridge account.
- `author_index` — zero-based index into the paper's `authors` array that the claimer is claiming. For claims by users not listed in the author array, `author_index` is `null` (unlisted claim, requires approval from the original post author or bridge account).
- The claimer's identity is proven by the posting key signature (`required_posting_auths`).
- Only accredited users may claim. The backend validates this before processing.

### 2.10 Approve Authorship

Broadcast to approve a pending authorship claim. The approver depends on context: the original post author for native papers, the bridge account for bridged papers.

```json
{
  "action": "approve_authorship",
  "claimer": "<hive_username>",
  "paper_author": "<post_author>",
  "paper_permlink": "<permlink>",
  "author_index": 2,
  "timestamp": "<ISO 8601>"
}
```

**Hive Operation:**

| Field | Value |
|-------|-------|
| `id` | `APP_TAG` |
| `required_auths` | `[]` |
| `required_posting_auths` | `["<original_post_author>"]` or `["<HIVE_BRIDGE_ACCOUNT>"]` |
| `json` | Stringified JSON above |

**Field Notes:**
- `author_index` — if `null` in the original claim (unlisted author), the approver specifies the index at which the author is inserted, or `null` to append. The backend adds the author to the paper's displayed author list at read time.
- For bridged papers, the bridge account admin triggers this via a backend admin endpoint.

### 2.11 Revoke Authorship

Revokes a previously accepted authorship claim. Can revoke any claim, including ORCID auto-accepted ones (e.g., if someone gained unauthorized access to an ORCID account).

```json
{
  "action": "revoke_authorship",
  "claimer": "<hive_username>",
  "paper_author": "<post_author>",
  "paper_permlink": "<permlink>",
  "reason": "Unauthorized claim",
  "timestamp": "<ISO 8601>"
}
```

**Hive Operation:**

| Field | Value |
|-------|-------|
| `id` | `APP_TAG` |
| `required_auths` | `[]` |
| `required_posting_auths` | `["<original_post_author>"]` or `["<HIVE_BRIDGE_ACCOUNT>"]` or `["<HIVE_ADMIN_ACCOUNT>"]` |
| `json` | Stringified JSON above |

**Field Notes:**
- The original post author, bridge account, or admin account may revoke.
- The claimer themselves may also revoke their own claim (in that case, `required_posting_auths` is `["<claimer>"]`).

---

## 3. Hive Vote

PEvO uses standard Hive votes — no custom metadata is needed.

**Hive Operation:** `vote`

| Field | Value |
|-------|-------|
| `voter` | Hive username |
| `author` | Post/comment author |
| `permlink` | Post/comment permlink |
| `weight` | -10000 to 10000 (percentage * 100) |

Votes affect both Hive rewards and PEvO reputation calculations. Vote weight in reputation is proportional to the voter's Hive Power (vesting shares).

### 3.1 Re-Vote via custom_json

Any accredited account can vote or change their vote at any time using a `custom_json` operation. This is the only way to vote after the 7-day Hive payout window (when native votes are locked), but it is also valid before payout. Use `version=1` for unrevised papers.

```json
{
  "id": "<APP_TAG>",
  "required_posting_auths": ["<voter>"],
  "json": {
    "action": "revote",
    "author": "<paper_author>",
    "permlink": "<paper_permlink>",
    "weight": -10000,
    "version": 3
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `action` | `"revote"` | Fixed |
| `author` | string | Paper author |
| `permlink` | string | Paper permlink |
| `weight` | int | -10000 to 10000, same scale as Hive votes. `0` retracts the vote. |
| `version` | int | Paper version number at time of re-vote |

**Validation:** The backend must verify that `required_posting_auths[0]` is the voter and that the voter is accredited. No prior native Hive vote is required. Revotes are always valid, including after the 7-day Hive payout window when native votes are locked.

**Vote resolution:** When both native votes and revote custom_json exist for the same voter on the same paper, the signal with the highest `block_num` wins. See the implementation in `backend/src/routes/papers.ts` (resolved vote counts) and `backend/src/reputation.ts` (batch reputation).

---

## 4. Identifying PEvO Content

To query all PEvO content from HAF SQL (using parameterized `APP_TAG`):

```sql
-- All PEvO papers (native + bridge), excluding continuation posts
SELECT * FROM hafsql.comments c
WHERE c.parent_author = ''
  AND c.parent_permlink = $1                              -- APP_TAG
  AND (c.json_metadata -> $1 ->> 'type') IN ('paper', 'bridge_paper')
  AND c.json_metadata ->> 'app' LIKE $2                   -- APP_TAG/%
  AND (c.json_metadata -> $1 -> 'continues') IS NULL;     -- exclude continuations

-- Bridge papers only
SELECT * FROM hafsql.comments c
WHERE c.parent_author = ''
  AND c.parent_permlink = $1
  AND (c.json_metadata -> $1 ->> 'type') = 'bridge_paper'
  AND c.json_metadata ->> 'app' LIKE $2;

-- All PEvO reviews
SELECT * FROM hafsql.comments c
WHERE (c.json_metadata -> $1 ->> 'type') = 'review'
  AND c.json_metadata ->> 'app' LIKE $2;

-- All PEvO custom_json operations
SELECT * FROM hafsql.operation_custom_json_view cj
WHERE cj.custom_id = $1;                                  -- APP_TAG

-- Accreditation status for a user (most recent action wins)
SELECT * FROM hafsql.operation_custom_json_view cj
WHERE cj.custom_id = $1
  AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
  AND cj.json::jsonb ->> 'account' = $2
ORDER BY cj.block_num DESC
LIMIT 1;

-- Authorship claims on a paper (most recent action per claimer wins)
WITH claim_events AS (
  SELECT
    cj.json::jsonb ->> 'action' AS action,
    COALESCE(cj.json::jsonb ->> 'claimer',
             cj.required_posting_auths ->> 0) AS claimer,
    cj.json::jsonb ->> 'paper_author' AS paper_author,
    cj.json::jsonb ->> 'paper_permlink' AS paper_permlink,
    (cj.json::jsonb ->> 'author_index')::int AS author_index,
    cj.block_num,
    cj.timestamp,
    ROW_NUMBER() OVER (
      PARTITION BY
        COALESCE(cj.json::jsonb ->> 'claimer', cj.required_posting_auths ->> 0),
        cj.json::jsonb ->> 'paper_author',
        cj.json::jsonb ->> 'paper_permlink'
      ORDER BY cj.block_num DESC
    ) AS rn
  FROM hafsql.operation_custom_json_view cj
  WHERE cj.custom_id = $1
    AND cj.json::jsonb ->> 'action' IN (
      'claim_authorship', 'approve_authorship', 'revoke_authorship'
    )
    AND cj.json::jsonb ->> 'paper_author' = $2
    AND cj.json::jsonb ->> 'paper_permlink' = $3
)
SELECT claimer, paper_author, paper_permlink, author_index, action, timestamp
FROM claim_events
WHERE rn = 1 AND action != 'revoke_authorship';
```

Note: Table names use the `hafsql` schema (e.g., `hafsql.comments`, `hafsql.operation_custom_json_view`, `hafsql.operation_effective_comment_vote_view`). The custom_json table uses `custom_id` (not `id`) as the column name.

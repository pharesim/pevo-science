# PEvO System Architecture

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Browser                             │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  Next.js App  │  │  Hive Keychain   │  │  IPFS Gateway    │  │
│  │  (Frontend)   │  │  (Tx Signing)    │  │  (PDF Viewing)   │  │
│  └──────┬───────┘  └────────┬─────────┘  └──────────────────┘  │
└─────────┼──────────────────┼───────────────────────────────────┘
          │                  │
          │ REST API         │ Signed Transactions
          ▼                  ▼
┌──────────────────────────────────────┐
│         PEvO Backend API             │
│  (Node.js + Express)                 │
│                                      │
│  - Accreditation service             │
│  - IPFS pinning proxy               │
│  - HAF query layer                   │
│  - Anonymous review service          │
│  - Reputation computation            │
└──────┬──────────┬──────────┬─────────┘
       │          │          │
       ▼          ▼          ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│ HAF SQL  │ │  Hive    │ │  IPFS    │
│ (Postgre │ │  Node    │ │  (Pinata │
│  SQL)    │ │  (Write) │ │  / self) │
│ (Read)   │ │          │ │          │
└──────────┘ └──────────┘ └──────────┘
```

### Data Flow

- **Reading:** Frontend → Backend API → HAF SQL (PostgreSQL with indexed Hive chain data)
- **Writing:** Frontend → Hive Keychain (signs tx in browser) → Hive Node (broadcast)
- **Files:** Frontend → Backend proxy → IPFS pinning service → CID returned to frontend → stored in Hive post `json_metadata`
- **Accreditation:** Frontend → Backend → verifies identity → broadcasts `custom_json` to Hive via admin account

### App Identity Configuration

All on-chain identifiers are configurable via environment variables so that alpha/testing instances use a separate namespace from production:

| Env Var | Default | Used For |
|---------|---------|----------|
| `APP_TAG` | `pevo` | `parent_permlink` for papers, `custom_json` id, `json_metadata` key, primary post tag |
| `APP_VERSION` | `0.1` | Combined as `APP_TAG/APP_VERSION` in `json_metadata.app` (e.g. `pevo/0.1`) |
| `HIVE_ADMIN_ACCOUNT` | `pevo.admin` | Accreditation broadcasts, retraction broadcasts, WoT auto-accreditation |
| `HIVE_ANON_ACCOUNT` | `pevo.anon` | Anonymous review posting |
| `HIVE_BRIDGE_ACCOUNT` | (= `HIVE_ADMIN_ACCOUNT`) | Bridge paper posting. Defaults to admin account; set separately if you want a dedicated bridge identity |
| `PEVO_BRIDGE_POSTING_KEY` | (= `PEVO_ADMIN_POSTING_KEY`) | Posting key for bridge account. Only needed if `HIVE_BRIDGE_ACCOUNT` differs from `HIVE_ADMIN_ACCOUNT` |

The frontend derives `NEXT_PUBLIC_APP_TAG` and `NEXT_PUBLIC_APP_VERSION` from `APP_TAG` and `APP_VERSION` automatically via `next.config.mjs`. No separate frontend env vars are needed.

To run an alpha instance, set `APP_TAG=pevo-alpha`. This creates a completely separate on-chain data space for both backend and frontend. When transitioning from alpha to production, change back to `pevo`.

### Data Source Policy

The backend always reads from real chain data. **No mock/fake data in production or development.** The fallback chain is:

1. **HAF SQL** (primary) — fastest, supports complex queries
2. **Hive API nodes** (fallback) — if HAF is unreachable, query Hive API directly via dhive with multiple node failover

Configure multiple Hive API nodes for resilience (e.g., `api.hive.blog`, `api.deathwing.me`, `anyx.io`). The backend should cycle through nodes on failure. Mock data is not used.

### Accredited-Only Data Policy

PEvO only uses on-chain data from accredited users. This applies across the entire platform:

- **Votes:** Only votes from accredited accounts affect reputation scores. Votes from unaccredited accounts are ignored in all PEvO computations (they still affect Hive rewards natively, but PEvO does not use them).
- **Reviews:** Only reviews from accredited accounts appear in the default view and count toward paper ratings.
- **Citations:** Only citations from papers authored by accredited researchers count toward citation scores.
- **Papers:** The default listing (`accredited_only=true`) shows only papers from accredited authors.

Unaccredited users can still read all content and vote on Hive (affecting Hive reward payouts), but their activity is invisible to PEvO's reputation and ranking systems. This prevents Sybil attacks and ensures scientific quality.

## 2. Data Model

### Paper (Hive post)

A PEvO paper is a standard Hive post with structured metadata.

```
parent_author: ""
parent_permlink: "pevo"
author: <hive_username>
permlink: <slug>
title: <paper_title>
body: <abstract_or_full_text_in_markdown>
json_metadata: {
  app: "pevo/0.1",
  tags: ["pevo", "science", "<discipline>", ...],
  pevo: {
    type: "paper",
    version: 1,
    authors: [
      {
        name: "Full Name",
        hive: "username",
        orcid: "0000-...",
        affiliation: "University"
      }
    ],
    discipline: "neuroscience",
    keywords: ["keyword1", "keyword2"],
    ipfs_cid: "Qm..." | null,
    ipfs_filename: "paper.pdf" | null,
    language: "en",
    abstract_hash: "<sha256 of abstract text>",
    document_hash: "<sha256 of PDF if uploaded>" | null
  }
}
```

### Review (Hive comment on a paper)

A PEvO review is a Hive comment on a paper post with structured rating metadata.

```
parent_author: <paper_author>
parent_permlink: <paper_permlink>
author: <reviewer_hive_username> | "pevo.anon"
permlink: <slug>
title: ""
body: <review_in_markdown>
json_metadata: {
  app: "pevo/0.1",
  tags: ["pevo", "review"],
  pevo: {
    type: "review",
    version: 1,
    rating: {
      methodology: 1-5,
      novelty: 1-5,
      clarity: 1-5,
      significance: 1-5
    },
    is_anonymous: false | true,
    reviewer_attestation_id: "<custom_json tx id>" | null
  }
}
```

### Accreditation (custom_json)

Broadcast by the `pevo.admin` account to attest that a Hive user is a verified scientist.

```
id: "pevo"
required_auths: []
required_posting_auths: ["pevo.admin"]
json: {
  action: "accredit",
  account: "<hive_username>",
  name: "Dr. Full Name",
  institution: "University of X",
  field: "neuroscience",
  method: "email" | "pgp" | "personal" | "wot" | "orcid",
  evidence_hash: "<sha256 of verification evidence>",
  timestamp: "<ISO 8601>"
}
```

### Revocation (custom_json)

Revokes a previously issued accreditation.

```
id: "pevo"
required_posting_auths: ["pevo.admin"]
json: {
  action: "revoke",
  account: "<hive_username>",
  reason: "...",
  timestamp: "<ISO 8601>"
}
```

## 3. Reputation Algorithm (v1)

Reputation is computed entirely from public on-chain data via HAF SQL queries. Anyone running the same queries against the same HAF database must get identical results.

### Inputs

| Factor | Source | Weight (default) |
|--------|--------|------------------|
| Papers published (with `pevo` tag) | HAF: comments where parent_permlink='pevo' and json_metadata contains app='pevo' | 10 pts each |
| Reviews written | HAF: comments where json_metadata pevo.type='review' | 5 pts each |
| Upvotes received on papers | HAF: votes on paper posts from accredited voters only, weighted by voter HP | Scaled 0-30 |
| Upvotes received on reviews | HAF: votes on review comments from accredited voters only, weighted by voter HP | Scaled 0-15 |
| Citations received | HAF: count of other PEvO papers by accredited authors referencing this author's permlinks | 8 pts each |
| Accreditation status | custom_json with action='accredit' for this account | +20 if accredited |
| Account age on PEvO | Time since first PEvO post | 0-10 based on months |

### Output

- **Score:** Single numeric value 0-100 (clamped)
- **Breakdown:** Object with individual factor scores for transparency

### Computation

```sql
-- Pseudocode: reputation score for a given account
SELECT
  (paper_count * 10) +
  (review_count * 5) +
  (LEAST(weighted_paper_votes / max_paper_votes * 30, 30)) +
  (LEAST(weighted_review_votes / max_review_votes * 15, 15)) +
  (citation_count * 8) +
  (CASE WHEN is_accredited THEN 20 ELSE 0 END) +
  (LEAST(EXTRACT(MONTH FROM age(now(), first_pevo_post)), 10))
FROM pevo_user_stats
WHERE account = $1;
-- Final score clamped to 0-100
```

The v1 algorithm and weights are documented in `docs/reputation-algorithm.md`. The v2 algorithm (`docs/reputation-algorithm-v2.md`) adds:

- **Self-citation discounting** — configurable multiplier (0.0-1.0) for self-citations
- **Review quality weighting** — reviews earn bonus points based on peer upvotes
- **Temporal decay** — older contributions gradually contribute less, with configurable grace period and floor

v2 is backwards-compatible: default weights produce identical scores to v1. Features activate via `update_weights` custom_json with non-default values. Both algorithms can be modified by community governance.

## 4. API Contract

Full endpoint specifications are in `docs/api-contract.md`. Summary:

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/session` | Exchange Hive Keychain signature for a session JWT (24h) |
| GET | `/api/papers` | List papers. Query params: `discipline`, `keyword`, `author`, `sort` (date/reputation/votes), `page`, `limit` |
| GET | `/api/papers/:author/:permlink` | Single paper with reviews and citation data |
| GET | `/api/papers/:author/:permlink/citations` | Papers that cite this paper |
| GET | `/api/papers/:author/:permlink/comments` | Discussion comments (threaded, accredited-only default) |
| GET | `/api/reviews/:author/:permlink` | Single review |
| GET | `/api/profile/:username` | Researcher profile with reputation breakdown |
| GET | `/api/profile/:username/papers` | Papers by a specific researcher |
| GET | `/api/accreditations` | List of accredited researchers |
| GET | `/api/accreditations/:username` | Accreditation status for a single user |
| POST | `/api/accreditation/request` | Submit accreditation request (email verification flow) |
| POST | `/api/accreditation/verify` | Confirm email verification token |
| POST | `/api/ipfs/upload` | Upload PDF, pin to IPFS, return CID |
| POST | `/api/reviews/anonymous` | Submit anonymous review (backend posts from pevo.anon) |
| GET | `/api/search?q=...` | Full-text search across papers and reviews |
| GET | `/api/disciplines` | List available disciplines with paper counts |
| GET | `/api/stats` | Platform statistics |
| GET | `/api/wot/:username` | Vouch status for a user (WoT accreditation) |
| POST | `/api/wot/vouch` | Process a vouch (triggers threshold check) |
| POST | `/api/wot/retract` | Process a vouch retraction (triggers cascading revocation) |
| GET | `/api/notifications` | Poll for notification events (authenticated, block-cursor pagination) |
| GET | `/api/papers/:author/:permlink/cite` | Export citation in BibTeX, RIS, or APA format |
| POST | `/api/papers/:author/:permlink/retract` | Retract a paper (author or pevo.admin) |
| GET | `/api/accreditation/orcid/start` | Initiate ORCID OAuth2 accreditation flow |
| POST | `/api/accreditation/orcid/callback` | Complete ORCID OAuth2 accreditation flow |
| GET | `/api/papers/:author/:permlink/doi` | Assign or retrieve DOI via DataCite |
| GET | `/api/profile/:username/notification-preferences` | Retrieve email digest preferences |
| PUT | `/api/profile/:username/notification-preferences` | Update email digest preferences |
| GET | `/api/profile/:username/notification-preferences/unsubscribe` | One-click email digest unsubscribe (token auth, no Keychain) |
| GET | `/api/bridge/lookup` | Preview preprint metadata by DOI or arXiv ID (no auth) |
| GET | `/api/bridge/check` | Check if a preprint is already registered on PEvO |
| POST | `/api/bridge/register` | Register a preprint as a bridge paper (accredited) |
| POST | `/api/bridge/update` | Update a bridge paper with new version from source (accredited) |
| GET | `/api/health` | Server health check |

### Search

Search is powered by PostgreSQL full-text search over HAF-indexed PEvO content. The `GET /api/search` endpoint accepts:

- `q` (required): Search query string
- `type`: Filter by content type (`paper`, `review`, or `all`; default `all`)
- `discipline`: Filter by discipline
- `accredited_only`: Boolean, default `true` — only return content from accredited authors
- `sort`: `relevance` (default) or `date`
- `page`, `limit`: Pagination (default limit 20, max 100)

Results include highlighted snippets via `ts_headline()` and rank scores via `ts_rank_cd()`.

## 5. Citation Schema

Papers reference other PEvO papers via a `citations` array in `json_metadata`. This enables on-chain citation tracking without any off-chain index.

```
json_metadata.pevo.citations: [
  {
    author: "<hive_username>",
    permlink: "<paper_permlink>",
    title: "Cited Paper Title"
  }
]
```

Citations are resolved by querying HAF for posts matching the `(author, permlink)` pair with `pevo.type = "paper"`. Citation counts for reputation are computed by counting distinct papers whose `pevo.citations` array references a given author's permlinks.

## 6. Governance Operations (custom_json)

All governance operations use `id: "pevo"` and require `pevo.admin` posting authority.

### Update Reputation Weights

```
id: "pevo"
required_posting_auths: ["pevo.admin"]
json: {
  action: "update_weights",
  weights: {
    paper: 10,
    review: 5,
    paper_votes_max: 30,
    review_votes_max: 15,
    citation: 8,
    accreditation_bonus: 20,
    account_age_max: 10
  },
  rationale: "Community vote #12 — increase citation weight",
  timestamp: "<ISO 8601>"
}
```

### Platform Parameter Update

```
id: "pevo"
required_posting_auths: ["pevo.admin"]
json: {
  action: "update_params",
  params: {
    max_upload_size_mb: 50,
    anon_review_ttl_days: 180,
    min_accreditations_for_wot: 3
  },
  rationale: "...",
  timestamp: "<ISO 8601>"
}
```

## 7. Anonymous Reviewing Flow

1. Accredited reviewer clicks "Review anonymously" on a paper.
2. Frontend sends review content + reviewer's signed proof to the PEvO backend.
   - The signed proof is a Hive Keychain signature of the review body hash, proving the reviewer controls an accredited Hive account.
3. Backend verifies the signature and confirms the account is accredited.
4. Backend posts the review from the `pevo.anon` Hive account using its posting key.
5. Backend stores the mapping (reviewer account → anonymous review permlink) encrypted with a server-side key, with a 6-month TTL.
6. If abuse is reported, a governance process can decrypt the mapping to identify the reviewer.
7. The review's `json_metadata` includes `is_anonymous: true` and a `reviewer_attestation_id` that proves the anonymous reviewer is accredited without revealing their identity.

### On-chain attestation

The backend broadcasts a `custom_json` attestation for each anonymous review containing only the `attestation_id` (a SHA-256 hash), the review permlink, and the paper reference. The encrypted reviewer identity is **never** published on-chain -- it is stored only in the application database where it can be deleted after expiry.

### Security Properties
- The `pevo.anon` posting key is held only by the backend server.
- The encrypted mapping uses AES-256-GCM with a versioned key stored in environment variables.
- After TTL expiry, the mapping is permanently deleted from the database.
- To make identities truly unrecoverable, rotate the encryption key periodically and destroy old keys once all mappings for that key version have expired. The `key_version` column in `anon_review_mappings` tracks which key encrypted each mapping.
- The on-chain attestation contains only a hash, not the ciphertext, so destroying the key is sufficient to make decryption impossible.

## 8. Discussion Threads

Papers support threaded discussion comments in addition to structured reviews.

### On-Chain Representation

Discussion comments use `pevo.type = "comment"` in `json_metadata` (see `docs/hive-schemas.md` §1.3). They are standard Hive comments and support arbitrary nesting via `parent_author`/`parent_permlink`.

### API Design

`GET /api/papers/:author/:permlink/comments` returns a **flat list** of all discussion comments in the paper's thread. Each comment includes `parent_author`/`parent_permlink` fields. The frontend builds the nested thread tree client-side using these fields. The `replies` field on the `DiscussionComment` contract type is populated by the frontend, not the API. This keeps the backend simple and gives the frontend full control over tree rendering.

### Accredited-Only Policy

By default, only comments from accredited authors are returned (`accredited_only=true`). The `net_votes` field reflects accredited votes only, consistent with the platform-wide policy.

### Comment vs Review Distinction

| Aspect | Review (`pevo.type = "review"`) | Comment (`pevo.type = "comment"`) |
|--------|------|---------|
| Has structured rating | Yes (methodology, novelty, clarity, significance) | No |
| Affects paper scores | Yes | No |
| Can be anonymous | Yes (via `pevo.anon`) | No |
| Supports threading | No (always direct reply to paper) | Yes (nested replies) |
| Accreditation required | Yes (for default view) | Yes (for default view) |

## 9. IPFS Integration


### Upload Flow

1. **Frontend:** User selects a PDF file.
2. **Frontend:** Computes SHA-256 hash of the file client-side (for integrity verification).
3. **Frontend:** Uploads the file to the backend proxy via `POST /api/ipfs/upload` (multipart form data).
4. **Backend:** Validates the file (PDF content type + magic bytes, max 10MB).
5. **Backend:** Pins the file to IPFS via Pinata API (or equivalent provider).
6. **Backend:** Returns the IPFS CID to the frontend.
7. **Frontend:** Includes the CID (`ipfs_cid`) and the client-computed hash (`document_hash`) in the paper's `json_metadata` when posting to Hive.

### Verification

Anyone can verify paper integrity:
1. Download the PDF from IPFS using the CID from `json_metadata`.
2. Compute the SHA-256 hash of the downloaded file.
3. Compare to the `document_hash` stored on-chain in `json_metadata`.
4. If they match, the document is authentic and unmodified.

### Provider Abstraction

The IPFS pinning service is abstracted behind an interface so providers can be swapped (Pinata, web3.storage, self-hosted IPFS node) without changing application logic.

## 10. Operational Policies

### CORS

- **Development:** Allow all origins.
- **Production:** Restrict to the configured `APP_URL` origin only.

### Rate Limiting

Authenticated endpoints (accreditation, IPFS upload, anonymous reviews) are rate-limited per account. Public read endpoints are rate-limited per IP. See `docs/api-contract.md` for specific limits per endpoint.

### API Versioning

v0.1 uses unversioned paths (`/api/...`). Future breaking changes will use path-based versioning (`/api/v2/...`) with a 6-month deprecation window for the previous version.

### Shared Types Contract

The `@pevo/contracts` package in `contracts/` is the single source of truth for all TypeScript types shared between frontend and backend. Both packages import types from `@pevo/contracts` rather than defining their own copies. The `ReputationWeights` interface includes both v1 and v2 fields; `DEFAULT_REPUTATION_WEIGHTS` provides defaults that produce v1-equivalent behavior.

### Authentication

All backend-authenticated endpoints use HTTP headers for credentials:

- `X-Hive-Username` -- the Hive account name
- `X-Hive-Signature` -- hex-encoded Hive Keychain signature
- `X-Hive-Message` -- (optional) the signed message; defaults to SHA-256 of the request body

The frontend must send credentials via these headers, not in the JSON request body. See `docs/api-contract.md` for details.

## 11. Web of Trust (WoT) Accreditation

WoT is a decentralized alternative to the centralized email-based accreditation flow. Accredited researchers can vouch for other researchers they know professionally.

### Flow

1. An accredited researcher broadcasts a `vouch` custom_json (signed with their own posting key, not `pevo.admin`).
2. The backend monitors `pevo.vouch_counts` (HAF view) for vouchees reaching the `min_accreditations_for_wot` threshold (default: 3).
3. When the threshold is met, the backend broadcasts an `accredit` custom_json from `pevo.admin` with `method: "wot"`.
4. If a vouch is retracted (`retract_vouch`) and a WoT-accredited researcher drops below the threshold, the backend broadcasts a `revoke` with `reason: "WoT threshold no longer met"`.

### On-Chain Schemas

See `docs/hive-schemas.md` §2.5 (`vouch`) and §2.6 (`retract_vouch`). TypeScript types: `VouchAction`, `RetractVouchAction` in `@pevo/contracts`.

### HAF Views

- `pevo.vouch_events` — all vouch/retract_vouch events
- `pevo.active_vouches` — current vouch status per (voucher, vouchee) pair
- `pevo.vouch_counts` — active vouch count per vouchee from accredited vouchers

### Security Considerations

- A researcher cannot vouch for themselves (enforced by backend before accepting the custom_json).
- Revocation of a voucher's own accreditation cascades: the backend rechecks all their vouchees against the threshold and revokes any that no longer qualify.
- WoT-accredited researchers have the same platform privileges as email-accredited researchers — there is no tier distinction.
- The `min_accreditations_for_wot` parameter is updatable via `update_params` custom_json.

## 12. Notifications

PEvO uses a polling-based notification system. No persistent connections or server-side notification state — all events are computed on-demand from HAF chain data.

### Design

The client polls `GET /api/notifications?since_block=N&limit=50` on a regular interval (recommended: 5 minutes). The response includes events since block `N` and a `latest_block` cursor for the next poll. The client stores the cursor locally (localStorage on web, SharedPreferences on Android).

### Event Types

| Type | Trigger | Recipient |
|------|---------|-----------|
| `new_review` | Review posted on your paper | Paper author |
| `new_citation` | Paper cites your paper | Cited paper author |
| `new_vote` | Accredited vote on your paper/review | Content author |
| `accreditation_update` | Your accreditation granted/revoked | Target account |
| `new_vouch` | Someone vouches for you | Vouchee |
| `new_reply` | Reply to your discussion comment | Parent comment author |

### Implementation

The backend uses the `pevo.get_notifications()` SQL function (see `docs/haf-views.sql` section 11), which executes a UNION ALL across all event sources for a given account and block range. This is efficient because:

- The block_num filter is indexed in HAF tables.
- Each sub-query targets a specific, narrow set of rows.
- Results are limited and ordered by block number.

### Mobile Compatibility

This design supports a future Android app without changes:

- **Foreground:** Poll every 5 minutes via standard HTTP.
- **Background:** Android `WorkManager` can poll at the OS-minimum 15-minute interval.
- **Push (future):** A backend worker can poll HAF on behalf of registered devices and send Firebase Cloud Messaging pushes. The API remains the same — FCM just triggers the app to poll sooner.

### No Off-Chain Storage

Notifications are not stored in any application database. "Unread" state is determined client-side: events with `block_num` greater than the user's last-seen cursor are unread. This keeps the backend stateless and avoids a notification table that would grow unboundedly.

## 13. Internationalization (i18n)

PEvO uses `next-intl` for frontend internationalization with a cookie-based locale selection strategy.

### Locale Resolution

1. Check `NEXT_LOCALE` cookie (set by language switcher)
2. Fall back to `Accept-Language` header
3. Default to `en`

### Supported Locales

`ar` (Arabic), `cs` (Czech), `da` (Danish), `de` (German), `en` (English), `es` (Spanish), `fa` (Persian), `fr` (French), `he` (Hebrew), `it` (Italian), `pl` (Polish), `pt` (Portuguese), `sv` (Swedish), `zh` (Chinese)

### File Structure

```
frontend/
  messages/
    en.json        ← source of truth (complete)
    es.json
    de.json
    fr.json
    zh.json
    ar.json
    he.json
    fa.json
    it.json
    pl.json
    pt.json
    cs.json
    da.json
    sv.json
  src/
    i18n/
      request.ts   ← next-intl server config (locale detection)
      routing.ts   ← locale list + default locale constant
```

### Design Decisions

- **No path-based routing** (`/en/papers`, `/de/papers`). Locale is a user preference stored in a cookie, not a URL segment. This avoids breaking existing routes, simplifies link sharing, and keeps URLs clean. SEO for non-English content can be added later via `hreflang` meta tags.
- **Single JSON namespace** per locale. The message file is small enough (<15KB) that splitting into per-page namespaces adds complexity without measurable benefit.
- **RTL support** for Arabic, Hebrew, and Persian: the root `<html>` tag sets `dir="rtl"` when the locale is in `RTL_LOCALES` (`ar`, `he`, `fa`). Tailwind's `rtl:` variant handles layout mirroring.
- **Paper content is NOT translated.** i18n applies only to UI chrome (navigation, buttons, labels, status messages). Paper bodies, review text, and on-chain data remain in their original language. The `language` field in paper metadata allows filtering by language.
- **Backend is English-only.** API error messages and log output remain in English. Only the frontend is localized.

### Translation Workflow

1. Developer adds/modifies keys in `messages/en.json`
2. CI checks that all locale files have the same key set (missing keys = build warning)
3. Translations are contributed via PR (community) or machine-translated as a starting point

Full spec: `docs/i18n-architecture.md`

## 14. Frontend Response Validation

API responses are validated client-side using Zod schemas to guard against malformed data from a compromised or misconfigured backend.

### Strategy

- Define Zod schemas in `frontend/src/lib/schemas.ts` that mirror the `@pevo/contracts` response types
- The `request<T>()` function in `api.ts` accepts an optional Zod schema parameter
- When provided, `schema.parse(data)` runs after `res.json()` — a `ZodError` is caught and converted to an `ApiRequestError` with code `INVALID_RESPONSE`
- Critical endpoints (profile, accreditation status, notifications) MUST pass a schema
- Read-only listing endpoints (papers, search) MAY skip validation for performance

### Schema Ownership

Schemas live in the frontend, not in `@pevo/contracts`. The contracts package defines TypeScript interfaces (compile-time); Zod schemas provide runtime validation. Keeping them separate avoids adding Zod as a dependency of the contracts package (which is also used by the backend).

Full spec: `docs/frontend-validation.md`

## 15. IPFS CDN Strategy

### Current Flow

Frontend → Backend proxy → IPFS gateway (ipfs.io or Pinata gateway) → PDF

### Target Flow

Frontend → CDN edge (Cloudflare/Fastly) → IPFS gateway (origin) → PDF

### Implementation

- Configure a CDN with the IPFS gateway as origin
- Set `Cache-Control: public, max-age=31536000, immutable` — IPFS CIDs are content-addressed, so cached content never goes stale
- The frontend constructs PDF URLs as `{CDN_BASE_URL}/ipfs/{cid}` (configured via `NEXT_PUBLIC_IPFS_GATEWAY_URL`)
- The backend continues to handle uploads (pinning); only reads go through CDN

### Env Vars

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_IPFS_GATEWAY_URL` | `https://ipfs.io` | IPFS gateway base URL (or CDN URL) |

## 16. Runtime Requirements

### Node.js 20+

The project requires Node.js 20 or later. This is enforced by:

- `"engines": { "node": ">=20.0.0" }` in all `package.json` files (backend already set; contracts and frontend must be added)
- CI pinned to `node-version: 20` in `.github/workflows/ci.yml`
- Docker images use `node:20-alpine`

**Reason:** The test runner (Vitest via Rolldown) requires `node:util.styleText`, which was added in Node 20.0.0.

## 17. Paper Versioning

Papers can be revised after publication using Hive's native edit mechanism. The author broadcasts another `comment` operation with the same `author/permlink`, replacing the post body. The Hive API always returns the latest version, but HAF stores every operation, so the full edit history is recoverable.

### On-Chain Representation

The `pevo.version` field in `json_metadata` is an integer counter that the author increments on each edit:

```
json_metadata.pevo.version: 1   // first publication
json_metadata.pevo.version: 2   // after first revision
```

The post `author` and `permlink` remain the same across all versions. Citations always point to a single stable permlink.

### Content Hash — Revision vs Metadata-Only Edits

Every paper version includes a `pevo.content_hash` field: the SHA-256 of `title + "\n" + body`. When the backend resolves version history, it compares each version's `content_hash` against the previous one. If the hash changed, the edit is a **content revision** (the paper text was modified). If only metadata changed (e.g. author linking, keyword correction), the `content_hash` stays the same and the edit is flagged as metadata-only.

The `versions` array in the API response includes an `is_content_revision` boolean for each entry. The UI uses this to distinguish meaningful revisions from housekeeping edits.

### Version History

The backend resolves the version history by querying HAF's `hive.operations_view` for all `comment` operations on the same `(author, permlink)`. The `GET /api/papers/:author/:permlink` response includes a `versions` array:

```
versions: [
  { version_number: 1, created: "2026-01-15T...", title: "Original Title", is_content_revision: true },
  { version_number: 2, created: "2026-02-20T...", title: "Revised Title", is_content_revision: true },
  { version_number: 3, created: "2026-03-01T...", title: "Revised Title", is_content_revision: false }
]
```

Version 1 is always `is_content_revision: true` (initial publication). Subsequent versions compare their `content_hash` against the previous version.

Viewing old version content requires HAF (the Hive API only returns the latest body). This is not a new dependency — PEvO already requires HAF for reputation, accreditation, and notifications.

### Review Attribution

Reviews include a `reviewed_version` integer in their `json_metadata.pevo`:

```
json_metadata.pevo.reviewed_version: 2
```

This records which version of the paper the review was written against. The UI displays "Reviewed version 2" with a link to view that version's content. All reviews remain attached to the same permlink (one discussion thread per paper).

### HAF View

```sql
-- pevo.paper_versions: edit history from operations
CREATE OR REPLACE VIEW pevo.paper_versions AS
SELECT
  op.body::jsonb ->> 'author' AS author,
  op.body::jsonb ->> 'permlink' AS permlink,
  COALESCE(
    (op.body::jsonb -> 'json_metadata' -> 'pevo' ->> 'version')::int,
    ROW_NUMBER() OVER (
      PARTITION BY op.body::jsonb ->> 'author', op.body::jsonb ->> 'permlink'
      ORDER BY op.block_num
    )
  ) AS version_number,
  op.body::jsonb ->> 'title' AS title,
  op.body::jsonb ->> 'body' AS body,
  op.timestamp AS created,
  op.block_num
FROM hive.operations_view op
WHERE op.op_type = 1  -- comment operation
  AND (op.body::jsonb ->> 'parent_author') = ''
  AND (op.body::jsonb ->> 'parent_permlink') = 'pevo'
  AND (op.body::jsonb -> 'json_metadata' -> 'pevo' ->> 'type') = 'paper'
ORDER BY op.block_num;
```

## 18. Paper Retraction

Hive posts are immutable after the payout window. PEvO supports retraction as a metadata overlay.

### On-Chain Representation

```
id: "pevo"
required_posting_auths: ["<paper_author>"] | ["pevo.admin"]
json: {
  action: "retract_paper",
  author: "<hive_username>",
  permlink: "<paper_permlink>",
  reason: "...",
  timestamp: "<ISO 8601>"
}
```

Either the paper author or `pevo.admin` (for misconduct) can retract.

### Platform Behavior

- Retracted papers display a prominent "RETRACTED" banner with the reason
- Retracted papers are excluded from `GET /api/papers` and `GET /api/search` by default (overridable with `include_retracted=true`)
- Reviews and citations of retracted papers remain visible with a note
- Retracted papers do not count toward the author's reputation score

### HAF View

`pevo.retracted_papers` -- lists all retracted paper (author, permlink) pairs with retraction timestamp and reason.

## 19. ORCID Accreditation

ORCID OAuth2 provides an additional accreditation method alongside email verification and Web of Trust.

### Flow

1. User clicks "Verify with ORCID" on the accreditation page
2. Frontend redirects to ORCID OAuth2 authorization endpoint
3. User logs in to ORCID and grants read access to their profile
4. ORCID redirects back to `{APP_URL}/accreditation/orcid/callback` with an authorization code
5. Frontend sends the code to `POST /api/accreditation/orcid/callback`
6. Backend exchanges the code for an access token, reads the ORCID profile
7. Backend broadcasts `accredit` custom_json with `method: "orcid"` and `orcid: "0000-..."`

### Env Vars

| Variable | Description |
|----------|-------------|
| `ORCID_CLIENT_ID` | ORCID OAuth2 client ID |
| `ORCID_CLIENT_SECRET` | ORCID OAuth2 client secret |
| `ORCID_REDIRECT_URI` | Callback URL (must match ORCID app config) |

### Security

- The ORCID access token is used once (to read the profile) and then discarded
- The ORCID iD is stored on-chain in the accreditation custom_json, making it publicly verifiable
- ORCID's sandbox environment is used for development; production uses `https://orcid.org`

## 20. Rich Text Editor with LaTeX

Scientific papers require mathematical notation. PEvO provides a WYSIWYG editor for authoring and a rendering pipeline for viewing that both support LaTeX math.

### Editor (Publish Page)

**Library:** [Tiptap](https://tiptap.dev/) — a headless, ProseMirror-based rich text editor with a mature extension ecosystem.

**Key extensions:**
- `@tiptap/starter-kit` — paragraphs, headings, bold, italic, lists, blockquotes, code blocks
- `@tiptap/extension-mathematics` (or community `tiptap-math`) — inline and display math via KaTeX
- `@tiptap/extension-table` — tables for data presentation
- `@tiptap/extension-link` — hyperlinks
- `@tiptap/extension-image` — embedded images (from IPFS CIDs)
- `@tiptap/extension-placeholder` — placeholder text

**Math input UX:**
- Inline math: type `$` to open an inline math node, type LaTeX, press `$` or `Enter` to close. The equation renders inline immediately.
- Display math: type `$$` on an empty line to open a display math block. LaTeX is entered in a code-like input and renders as a centered equation below.
- Alternatively: toolbar button "Insert Equation" opens a modal with a LaTeX input field and live KaTeX preview.

**Output format:** The editor serializes to **Markdown** with LaTeX delimiters preserved (`$...$` for inline, `$$...$$` for display). This is what gets stored in the Hive post body. Tiptap's `@tiptap/pm/markdown` serializer handles this with custom rules for math nodes.

**Toolbar:**
- Text: Bold, Italic, Strikethrough
- Structure: H2, H3, Bullet List, Ordered List, Blockquote
- Science: Inline Math ($), Display Math ($$), Table
- Media: Image, Link
- Utility: Undo, Redo, Full-screen

### Viewer (Paper Detail + Review Rendering)

**Library:** [react-markdown](https://github.com/remarkjs/react-markdown) with plugins:
- `remark-math` — parses `$...$` and `$$...$$` delimiters into math AST nodes
- `rehype-katex` — renders math nodes to HTML via KaTeX
- `remark-gfm` — GitHub Flavored Markdown (tables, strikethrough, task lists)

**CSS:** Import `katex/dist/katex.min.css` globally (or lazy-load on pages that render papers).

**Security:** `react-markdown` does not use `dangerouslySetInnerHTML` for user content — it builds a React element tree from the AST. The `rehype-katex` plugin only generates KaTeX HTML for math nodes, which is safe (KaTeX's output is a known-safe subset of HTML). DOMPurify remains available as an additional layer if needed.

### Abstract Editor

The abstract field on the publish page uses the same `TiptapEditor` component as the full paper body — one component, two instances. This ensures any editor improvements (toolbar, extensions, bug fixes) apply to both fields automatically.

**Configuration via props:** `TiptapEditor` accepts an optional `variant` prop:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `variant` | `"full" \| "abstract"` | `"full"` | Controls which toolbar groups are shown and editor height |
| `placeholder` | `string` | (variant-dependent) | Placeholder text when editor is empty |
| `maxLength` | `number \| undefined` | `undefined` | Character limit (applied to serialized Markdown output). Shows counter when set. |

**Variant differences:**

| Feature | `"full"` (paper body) | `"abstract"` |
|---------|----------------------|--------------|
| Min height | 280px | 120px |
| Toolbar: Text (B, I, S) | Yes | Yes |
| Toolbar: Structure (H2, H3, Lists, Quote) | Yes | No |
| Toolbar: Science (Math inline, Math block) | Yes | Yes |
| Toolbar: Table | Yes | No |
| Toolbar: Image | Yes | No |
| Toolbar: Link | Yes | Yes |
| Toolbar: Undo/Redo | Yes | Yes |
| Placeholder | "Write your paper body here..." | "Write your abstract here..." |
| Character counter | Yes (count only) | Yes (count + 2000 char limit) |

The `"abstract"` variant hides headings, lists, blockquotes, tables, and images — an abstract is a single formatted paragraph with optional math and links, not a structured document.

**Character counter:** Always visible in both variants. When `maxLength` is set, displays as `count / limit` with red styling on overflow. When `maxLength` is not set, displays the count alone.

**Serialization:** Both variants serialize to Markdown. The abstract Markdown is composed into the final Hive post body via `composePostBody(abstract, fullText)` as before.

### Where This Applies

| Location | Current | Target |
|----------|---------|--------|
| Publish page abstract (`/publish`) | Tiptap WYSIWYG (`variant="abstract"`) | Done |
| Publish page body (`/publish`) | Tiptap WYSIWYG (`variant="full"`) | Done |
| Publish preview toggle | `react-markdown` + `remark-math` + `rehype-katex` | Done |
| Paper detail body | `react-markdown` + `remark-math` + `rehype-katex` | Done |
| Review body (ReviewCard) | `react-markdown` + `remark-math` + `rehype-katex` | Done |
| Comment body (ThreadedComments) | `react-markdown` + `remark-math` + `rehype-katex` | Done |

### Dependencies

```
# Editor (publish page only — code-split)
@tiptap/react
@tiptap/starter-kit
@tiptap/extension-mathematics (or tiptap-math-extension)
@tiptap/extension-table
@tiptap/extension-link
@tiptap/extension-image
@tiptap/extension-placeholder

# Rendering (all pages that display Markdown)
react-markdown
remark-math
remark-gfm
rehype-katex
katex  (CSS only — KaTeX rendering is done by rehype-katex)
```

### Implementation Notes

1. **Code splitting:** The Tiptap editor bundle is ~150KB gzipped. It should only load on pages that use it (currently `/publish`). Use `next/dynamic` with `ssr: false` to lazy-load via `LazyTiptapEditor`. Both abstract and body editors share the same dynamic import — a single chunk is loaded once.
2. **Markdown round-trip:** Content authored in Tiptap must survive a Markdown round-trip (serialize → store on Hive → parse back for viewing). Test that LaTeX delimiters, tables, and nested lists serialize correctly.
3. **Backwards compatibility:** Existing papers stored as plain Markdown (no LaTeX) will render correctly — `remark-math` only activates when it encounters `$` delimiters.
4. **KaTeX error handling:** Invalid LaTeX (e.g., `$\frac{$`) should render the raw source with an error indicator, not crash the page. KaTeX's `throwOnError: false` option handles this.
5. **On-chain storage:** The Hive post body remains Markdown text. No binary or HTML is stored. LaTeX is embedded as text delimiters within the Markdown, which is standard practice (used by arXiv, Jupyter, Obsidian, etc.).

## 21. Discipline Taxonomy

The `discipline` field in paper metadata currently accepts free-text. For effective filtering, PEvO adopts a controlled vocabulary based on the OECD Fields of Research and Development (Frascati Manual), adapted for common scientific usage.

### Taxonomy Structure

Two-level hierarchy: top-level fields and sub-fields. Papers store the sub-field as their `discipline` value. The top-level field is inferred from the sub-field.

```
Natural Sciences
  ├── Mathematics
  ├── Computer Science
  ├── Physics
  ├── Chemistry
  ├── Earth Sciences
  ├── Biology
  └── Astronomy

Engineering and Technology
  ├── Civil Engineering
  ├── Electrical Engineering
  ├── Mechanical Engineering
  ├── Chemical Engineering
  ├── Materials Engineering
  ├── Biomedical Engineering
  └── Environmental Engineering

Medical and Health Sciences
  ├── Basic Medicine
  ├── Clinical Medicine
  ├── Health Sciences
  ├── Neuroscience
  └── Pharmacology

Agricultural and Veterinary Sciences
  ├── Agriculture
  ├── Animal Science
  ├── Veterinary Science
  └── Forestry

Social Sciences
  ├── Psychology
  ├── Economics
  ├── Education
  ├── Sociology
  ├── Law
  ├── Political Science
  └── Geography

Humanities and Arts
  ├── History
  ├── Philosophy
  ├── Languages and Literature
  ├── Arts
  └── Theology
```

### Implementation

- **Data file:** `contracts/src/disciplines.ts` exports `DISCIPLINE_TAXONOMY` (array of `{ field: string, subfields: string[] }`) and a flat `DISCIPLINES` string array of all valid sub-field values.
- **Publish form:** Searchable dropdown (combobox) grouped by top-level field. Replaces the current free-text input.
- **`GET /api/disciplines`:** Returns only disciplines that have at least one paper, with counts. The response shape (`Discipline`) is unchanged.
- **Backwards compatibility:** Papers published before the taxonomy was enforced may have `discipline` values not in the controlled vocabulary. These are displayed as-is but excluded from grouped filter dropdowns. The backend does NOT reject unknown disciplines on read — it only validates on write.
- **Extensibility:** New disciplines can be added to `disciplines.ts` via PR. The taxonomy is not stored on-chain; it is a frontend/backend convention only.

## 22. DOI Assignment

PEvO papers can be assigned Digital Object Identifiers (DOIs) via DataCite, enabling citation in traditional academic literature.

### Integration

- **Provider:** DataCite REST API (https://api.datacite.org for production, https://api.test.datacite.org for development)
- **DOI Pattern:** `{DATACITE_DOI_PREFIX}/pevo.{author}.{permlink}`
- **DataCite Metadata:** Mapped from PEvO paper metadata (title, authors with ORCID iDs, discipline, creation date, abstract)
- **Resource Type:** `Preprint` (DataCite vocabulary)

### Flow

1. Paper author clicks "Assign DOI" on paper detail page
2. Frontend sends authenticated request to `GET /api/papers/:author/:permlink/doi?assign=true`
3. Backend registers DOI with DataCite API using paper metadata
4. Backend broadcasts `assign_doi` custom_json to store DOI on-chain
5. DOI is returned and displayed on paper detail page

### On-Chain Representation

```
id: "pevo"
required_posting_auths: ["pevo.admin"]
json: {
  action: "assign_doi",
  author: "<hive_username>",
  permlink: "<paper_permlink>",
  doi: "10.5281/pevo.scientist1.neural-network-plasticity-2026",
  doi_url: "https://doi.org/10.5281/pevo.scientist1.neural-network-plasticity-2026",
  timestamp: "<ISO 8601>"
}
```

### Env Vars

| Variable | Description |
|----------|-------------|
| `DATACITE_REPOSITORY_ID` | DataCite repository ID (authentication) |
| `DATACITE_PASSWORD` | DataCite API password |
| `DATACITE_DOI_PREFIX` | DOI prefix assigned to PEvO (e.g., `10.5281`) |
| `DATACITE_API_URL` | API base URL (defaults to production) |

### HAF View

`pevo.paper_dois` -- maps (author, permlink) to DOI string, extracted from `assign_doi` custom_json events.

### Prerequisites

DOI assignment requires a DataCite membership (~$500/year for non-profits). The feature is disabled (returns `INTERNAL_ERROR`) when DataCite credentials are not configured.

## 23. Email Notification Digest

Users who opt in receive periodic email summaries of their PEvO activity (new reviews, citations, votes, etc.).

### Design

- **Storage:** `notification_preferences` table in the application database (NOT on-chain)
- **Schema:** `(username TEXT PK, email_digest BOOLEAN DEFAULT false, digest_frequency TEXT DEFAULT 'weekly', email TEXT, updated_at TIMESTAMPTZ)`
- **Cron Job:** A backend scheduled task runs daily. For each user with `email_digest = true`:
  - Skip if `digest_frequency = 'weekly'` and it's not the configured weekly send day (default: Monday)
  - Query HAF for notification events since the user's last poll (or last 7/1 days if no cursor)
  - If no events, skip
  - Render an HTML email with event summaries and links to relevant papers/reviews
  - Send via the existing Nodemailer SMTP config

### Security

- Users can only read/update their own preferences (enforced by Hive signature verification)
- Email addresses are stored server-side only, never on-chain
- HTML email content is escaped to prevent injection
- Unsubscribe link in every email sets `email_digest = false` via a signed token

### API

- `GET /api/profile/:username/notification-preferences` — retrieve preferences
- `PUT /api/profile/:username/notification-preferences` — update preferences

See `docs/api-contract.md` for full endpoint specs.

## 24. Content Security Policy (CSP)

The frontend must serve a Content-Security-Policy header to mitigate XSS and data exfiltration.

### Policy

```
default-src 'self';
script-src 'self' 'unsafe-eval' 'unsafe-inline';
style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net;
img-src 'self' data: blob: https://ipfs.io https://*.pinata.cloud;
font-src 'self' https://cdn.jsdelivr.net;
connect-src 'self' ${API_URL} https://api.hive.blog https://api.deathwing.me https://anyx.io https://orcid.org;
frame-src 'none';
object-src 'none';
base-uri 'self';
form-action 'self';
```

### Implementation Notes

- Set via `headers()` in `next.config.js`
- `unsafe-eval` required by Hive Keychain for signature operations
- `unsafe-inline` required for KaTeX rendered styles and Next.js inline scripts
- `style-src` includes `cdn.jsdelivr.net` for KaTeX CSS
- `connect-src` includes Hive API nodes and ORCID for OAuth
- `img-src` includes IPFS gateways for paper PDFs
- CSP report-only mode (`Content-Security-Policy-Report-Only`) should be deployed first to catch violations before enforcing

## 25. API Response Compression

### Implementation

Add `compression` middleware to the Express backend to serve gzip/brotli responses.

```
npm install compression @types/compression
```

Apply as early middleware in `app.ts`:

```typescript
import compression from 'compression';
app.use(compression({ threshold: 1024 }));
```

This compresses all JSON responses larger than 1KB. No frontend changes needed — browsers handle decompression transparently via `Accept-Encoding` headers.

### Expected Impact

- Paper listings (JSON ~20-50KB) compress to ~3-8KB
- Paper detail responses (with full body) compress significantly
- Static Next.js assets are already compressed by Next.js's built-in server

## 26. Preprint Bridge

### Purpose

Scientists already publish preprints on arXiv, bioRxiv, medRxiv, and similar servers. The preprint bridge lets any accredited researcher register an existing preprint on PEvO by providing its DOI or preprint URL. PEvO pulls metadata from the source, creates a Hive post representing the preprint, and enables its full evaluation layer (reviews, ratings, citations, reputation, discussion threads) on top of the existing work. Scientists do not need to change their publishing workflow — PEvO adds open evaluation on top.

### On-Chain Representation

A bridge paper is a real Hive post, just like a native PEvO paper. It uses the same `parent_permlink`, tags, and `json_metadata.app` field. The key distinction is `pevo.type = "bridge_paper"` (instead of `"paper"`), plus a `pevo.source` object that captures the external origin.

This means:
- Reviews, votes, citations, reputation, and discussions work identically for bridge papers and native papers.
- HAF queries and API endpoints treat bridge papers alongside native papers (with an optional filter to distinguish them).
- The Hive `author` of a bridge post is the **bridge account** (`HIVE_BRIDGE_ACCOUNT`, defaults to `pevo.admin`), not the registering user. The `pevo.source.registered_by` field tracks who imported it, and `pevo.authors` reflects the real paper authors from the source metadata.

### Metadata Sources

Two primary APIs provide metadata, with additional resolvers for common academic repository URLs:

| Source | API | Coverage | Auth |
|--------|-----|----------|------|
| arXiv | `http://export.arxiv.org/api/query?id_list={arxiv_id}` | arXiv (physics, math, CS, etc.) | None (rate limit: 1 req/3s) |
| CrossRef | `https://api.crossref.org/works/{doi}` | bioRxiv, medRxiv, most journals via DOI | None (polite pool: `mailto` header) |
| PubMed | `https://api.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/` | PubMed-indexed papers (resolves PMID → DOI) | None |
| Semantic Scholar | `https://api.semanticscholar.org/graph/v1/paper/{id}` | Wide coverage (resolves S2 paper hash → DOI) | None (rate limit: 100 req/5min) |
| ResearchGate | HTML meta tag extraction from publication page | ResearchGate-listed papers (extracts DOI from `citation_doi`) | None |

PubMed, Semantic Scholar, and ResearchGate act as **resolvers** — they extract a DOI from the source, then the actual metadata is fetched from CrossRef. bioRxiv and medRxiv URLs contain a DOI directly in the URL path and are also routed to CrossRef.

The backend identifies the source type from the user's input:
- Input matches `10.xxxx/...` or `doi.org/...` → CrossRef lookup by DOI
- Input matches `arXiv:YYMM.NNNNN` or `arxiv.org/abs/...` → arXiv API lookup by ID
- Input matches `biorxiv.org/content/...` or `medrxiv.org/content/...` → DOI extracted from URL → CrossRef
- Input matches `pubmed.ncbi.nlm.nih.gov/{pmid}` → NCBI ID Converter API → DOI → CrossRef
- Input matches `semanticscholar.org/paper/.../{hash}` → S2 Graph API → DOI → CrossRef
- Input matches `researchgate.net/publication/{id}` → HTML `citation_doi` meta tag → DOI → CrossRef
- Ambiguous input → try both arXiv and CrossRef, return first match

### Data Flow

```
1. Scientist provides a DOI, arXiv ID, or URL from a supported source (PubMed, bioRxiv, medRxiv, Semantic Scholar, ResearchGate) in the PEvO UI
2. Frontend calls GET /api/bridge/lookup?identifier=... (no auth needed)
3. Backend fetches metadata from arXiv/CrossRef, returns preview
4. Scientist reviews metadata, optionally edits discipline/keywords, confirms
5. Frontend calls POST /api/bridge/register (requires accreditation + Keychain signature for auth)
6. Backend checks for duplicates (same source DOI/arXiv ID already registered)
7. Backend broadcasts the Hive post server-side under the bridge account (HIVE_BRIDGE_ACCOUNT)
8. Returns the created post's author/permlink and tx_id
```

Note: Step 7 means the **backend** posts directly using the bridge account's posting key — no Keychain broadcast is needed from the user. Keychain is only used to authenticate the requesting user (prove they are accredited). This design ensures all bridge papers are owned by a single platform account rather than appearing to be authored by the registerer.

### Permlink Convention

Bridge paper permlinks follow: `bridge-{source}-{normalized_id}`, e.g.:
- `bridge-arxiv-2301-12345` (arXiv ID 2301.12345, dots replaced with dashes)
- `bridge-doi-10-1101-2026-01-01-123456` (DOI 10.1101/2026.01.01.123456, slashes and dots replaced)

Indirect sources (PubMed, Semantic Scholar, ResearchGate, bioRxiv, medRxiv) are **resolved to a canonical DOI** before permlink generation, so the resulting permlink is always `bridge-doi-...`. This ensures that the same paper registered via different URLs (e.g., once via PubMed and once via ResearchGate) produces the same permlink and is correctly deduplicated.

### Post Body

The bridge paper's Hive post body contains:

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

### Deduplication

Before registration, the backend checks whether a bridge paper with the same source identifier already exists:

1. **Permlink check:** Query Hive for a post with the deterministic permlink under `parent_permlink = APP_TAG`. If found, return the existing post's author/permlink with a `DUPLICATE` status.
2. **Metadata check:** Query HAF for any post where `json_metadata.pevo.source.doi` or `json_metadata.pevo.source.arxiv_id` matches. This catches cases where someone used a different permlink format.

### Authorship Policy

The registering user does NOT need to be one of the paper's authors. Any accredited scientist can register any preprint. This is by design — it enables:
- Lab members registering their PI's work
- Journal clubs registering papers they want to discuss
- Conference organizers registering accepted papers for community evaluation

The `pevo.authors` array reflects the real authors from the source metadata. The Hive `author` field is the registering user. The UI clearly distinguishes "Registered by @user" from the paper's actual authors.

### Version Updates

If a preprint gets a new version (e.g., arXiv v2), PEvO handles it as a Hive edit:
- The registering user (original Hive `author`) can update the post by calling `POST /api/bridge/update`
- This re-fetches metadata from the source and creates a Hive edit (same author/permlink, incremented `pevo.version`)
- Reviews retain their `reviewed_version` field, so it is clear which version was reviewed
- Any accredited user can also register the update if the original registrar is inactive (creates a new bridge post linking to the previous version via `pevo.previous_version`)

### Licensing

PEvO does not filter by license. All preprints can be registered because:
- PEvO only stores metadata (title, authors, abstract) — not the full paper text
- The abstract is typically freely available from the preprint server
- The post body links to the original source for full-text access
- This is analogous to how Google Scholar indexes papers regardless of license

### API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/bridge/lookup` | None | Preview metadata for a DOI or arXiv ID |
| GET | `/api/bridge/check` | None | Check if a preprint is already registered |
| POST | `/api/bridge/register` | Accredited | Register a preprint (posted server-side under bridge account) |
| POST | `/api/bridge/update` | Accredited | Update a bridge paper with new version from source |

See `docs/api-contract.md` for full endpoint specifications.

### HAF Queries

Bridge papers are identified alongside native papers:

```sql
-- All PEvO papers (native + bridge)
SELECT * FROM hafsql.comments
WHERE parent_author = ''
  AND parent_permlink = 'pevo'
  AND json_metadata::jsonb->>'app' LIKE 'pevo/%'
  AND json_metadata::jsonb->'pevo'->>'type' IN ('paper', 'bridge_paper');

-- Bridge papers only
SELECT * FROM hafsql.comments
WHERE parent_author = ''
  AND parent_permlink = 'pevo'
  AND json_metadata::jsonb->'pevo'->>'type' = 'bridge_paper';

-- Find bridge paper by source DOI
SELECT * FROM hafsql.comments
WHERE parent_author = ''
  AND parent_permlink = 'pevo'
  AND json_metadata::jsonb->'pevo'->>'type' = 'bridge_paper'
  AND json_metadata::jsonb->'pevo'->'source'->>'doi' = $1;
```

### Retraction

Bridge papers use the same retraction mechanism as native papers (§18). The `retract_paper` custom_json schema and `POST /api/papers/:author/:permlink/retract` endpoint are reused without modification. The only difference is an extended authorization policy for who may retract.

**Who can retract a bridge paper:**

1. **The registerer** — the user who imported the preprint (identified by `pevo.source.registered_by` in metadata, since the Hive `author` is the bridge account).
2. **`pevo.admin`** — for misconduct, abuse, or DMCA-style takedown requests. Identical to native papers.
3. **An original author of the preprint** — if the requesting user's Hive username appears in the bridge paper's `pevo.authors[].hive` field (the author list populated from source metadata), they are authorized to retract even though they did not register the bridge post.

**Original author identity verification:**

The backend reads the bridge paper's `json_metadata.pevo.authors` array and checks whether any entry has a `hive` field matching the `X-Hive-Username` from the request. If so, the user is treated as an authorized retractor. This check only applies when `pevo.type` is `"bridge_paper"` — for native papers, only the Hive `author` and `pevo.admin` can retract.

Note: the `hive` field in `pevo.authors` is `null` by default (source metadata does not include Hive usernames). It can be populated when:
- The registerer manually maps authors to Hive accounts during registration
- An original author later claims authorship (future feature)
- The author's ORCID is linked to a PEvO account (matched during registration)

If no author in the array has a non-null `hive` field matching the requester, the standard rule applies (registerer via `pevo.source.registered_by`, or admin only).

### Impact on Existing Features

- **Paper listings:** `GET /api/papers` returns both native and bridge papers by default. A new `source` query param allows filtering: `source=native`, `source=bridge`, or omitted for both.
- **Search:** Bridge papers are indexed and searchable like native papers.
- **Reputation:** Bridge papers contribute to the registering user's reputation (as a contribution to the platform), but at a reduced weight compared to native papers (configurable via reputation weights).
- **Citation export:** Bridge papers export citations using the original DOI (not a PEvO DOI).
- **Paper detail:** The UI shows a "Bridge Paper" badge and links to the original source.
- **Statistics:** `GET /api/stats` includes a `total_bridge_papers` count.

## 27. Session-Based Authentication

### Problem

The original auth design required a fresh Hive Keychain signature for every authenticated API call. Keychain is a browser extension that pops up a confirmation dialog for each signing request. This meant every background operation (notification polling, preference loading, WoT status checks) triggered a visible popup — unusable in practice.

### Design

Login signs once, then the backend issues a session JWT that covers all subsequent API requests:

```
1. User enters username → Keychain signs a challenge
2. Frontend calls POST /api/auth/session with the signature
3. Backend verifies signature against on-chain posting key
4. Backend issues JWT (HS256, SESSION_SECRET, 24h expiry)
5. Frontend stores JWT in memory (auth context)
6. All authenticated API calls send: Authorization: Bearer <jwt>
7. On expiry or disconnect, token is discarded
```

### Backend Middleware

The `verifyHiveSignature` middleware accepts two authentication methods (checked in order):

1. **Bearer JWT** — `Authorization: Bearer <token>` header. Verify JWT signature with `SESSION_SECRET`, check expiry, extract `sub` (username). Fast (no chain lookup).
2. **Hive Signature** — `X-Hive-Username` + `X-Hive-Signature` headers. Recover public key, verify against on-chain account. Slower (requires Hive API call). Still supported for backwards compatibility and for the initial `POST /api/auth/session` call itself.

### Security

- JWT is HS256 with a server-side secret (`SESSION_SECRET` env var). Never sent to the client as a cookie — stored in JS memory only (not localStorage), so not accessible after tab close.
- 24-hour expiry. No refresh tokens — user re-authenticates via Keychain when the token expires.
- The session proves the user controlled the Hive posting key at login time. It does NOT grant the ability to sign Hive transactions — those still require Keychain.
- `SESSION_SECRET` must be set in production (backend refuses to start without it).

### What Still Requires Keychain

Operations that broadcast to the Hive chain need actual key-signed transactions. These are NOT session-based:

- Publishing a paper (`client.broadcast.comment`)
- Posting a review / comment (`client.broadcast.comment`)
- Voting (`client.broadcast.vote`)
- Vouching / retracting vouch (`client.broadcast.customJson`)
- Retracting a paper on-chain (`client.broadcast.customJson`)

### Env Vars

| Var | Required | Description |
|-----|----------|-------------|
| `SESSION_SECRET` | Yes (production) | Random string (32+ chars) for JWT HS256 signing. Must be set when `NODE_ENV=production`. |

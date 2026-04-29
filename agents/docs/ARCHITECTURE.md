# PEvO System Architecture

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Browser                             │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  Alpine.js    │  │  Hive Keychain   │  │  IPFS Gateway    │  │
│  │  SPA (Vite)   │  │  (Tx Signing)    │  │  (PDF Viewing)   │  │
│  └──────┬───────┘  └────────┬─────────┘  └──────────────────┘  │
└─────────┼──────────────────┼───────────────────────────────────┘
          │                  │
          │ REST API         │ Signed Transactions
          │ (same-origin)    │
          ▼                  ▼
┌──────────────────────────────────────┐
│         PEvO Backend API             │
│  (Node.js + Express)                 │
│                                      │
│  - Static frontend serving           │
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
│ (Postgre │ │  Node    │ │  (Kubo   │
│  SQL)    │ │  (Write) │ │  node)   │
│ (Read)   │ │          │ │          │
└──────────┘ └──────────┘ └──────────┘
```

### Data Flow

- **Reading:** Browser → Backend API (same-origin) → HAF SQL (PostgreSQL with indexed Hive chain data)
- **Writing:** Browser → Hive Keychain (signs tx in browser) → Hive Node (broadcast)
- **Files:** Browser → Backend proxy → Kubo IPFS node → CID returned → stored in Hive post `json_metadata`
- **Accreditation:** Browser → Backend → verifies identity → broadcasts `custom_json` to Hive via admin account
- **Static assets:** Backend serves compiled frontend from `backend/public/` directory via `express.static`

### App Identity Configuration

All on-chain identifiers are configurable via environment variables so that alpha/testing instances use a separate namespace from production:

| Env Var | Default | Used For |
|---------|---------|----------|
| `APP_TAG` | *(required)* | `parent_permlink` for papers, `custom_json` id, `json_metadata` key, primary post tag |
| `APP_VERSION` | *(required)* | Combined as `APP_TAG/APP_VERSION` in `json_metadata.app` (e.g. `pevo/0.1`) |
| `HIVE_ADMIN_ACCOUNT` | `pevo.admin` | Accreditation broadcasts, retraction broadcasts, WoT auto-accreditation |
| `HIVE_ANON_ACCOUNT` | `pevo.anon` | Anonymous review posting |
| `HIVE_BRIDGE_ACCOUNT` | (= `HIVE_ADMIN_ACCOUNT`) | Bridge paper posting. Defaults to admin account; set separately if you want a dedicated bridge identity |
| `PEVO_BRIDGE_POSTING_KEY` | (= `PEVO_ADMIN_POSTING_KEY`) | Posting key for bridge account. Falls back to admin key only when bridge account equals admin account; throws if bridge differs and this is unset |
| `ACCREDITATION_AUTHORITIES` | (empty) | Comma-separated list of additional accounts authorized to broadcast accreditations. `HIVE_ADMIN_ACCOUNT` is always implicitly authorized. |

The frontend reads `APP_TAG` at runtime via `window.__PEVO_CONFIG__`, which the backend injects into the served HTML. The config object includes `appTag`, `appVersion`, `maxUploadSize`, `discordUrl`, `githubUrl`, and conditionally `ipfsGateway` (only when the IPFS gateway URL is a public HTTP/S URL, not an internal Docker hostname; when absent the frontend falls back to `/api/ipfs/`). See `frontend/src/config.js` for the accessor functions (`getAppTag()`, `getAppVersion()`, `getAppId()`, `getDiscordUrl()`, `getGithubUrl()`, `getMaxUploadSize()`, `getMaxUploadSizeMB()`). `ipfsGateway` has no accessor and is read directly from `window.__PEVO_CONFIG__` where needed. No separate frontend env vars or Vite `define` blocks are needed.

To run an alpha instance, set `APP_TAG=pevo-alpha`. This creates a completely separate on-chain data space for both backend and frontend. When transitioning from alpha to production, change back to `pevo`.

### Data Source Policy

The backend always reads from real chain data. **No mock/fake data in production or development.**

1. **HAF SQL** (required) — all listing, search, and reputation queries go through HAF SQL (PostgreSQL with indexed Hive chain data). If HAF is unavailable, these endpoints return empty results or errors.
2. **Hive API nodes** (writes + targeted reads) — used for broadcasting transactions (comments, votes, custom_json) and the following read operations. These reads do not affect reputation or rankings. Configure multiple nodes for resilience (e.g., `api.hive.blog`, `api.deathwing.me`, `anyx.io`). The backend cycles through nodes on failure.

   | Method | Where | Purpose |
   |--------|-------|---------|
   | `getAccounts` | `verifyHiveSignature.ts` | Fetch public posting key for signature verification |
   | `getAccounts` | `signup-verify.ts` | Check username availability before account creation |
   | `getAccounts` | `signup-verify.ts` | Verify account exists before linking |
   | `getAccounts` | `account-creation.ts` | Read on-chain `pending_claimed_accounts` capacity (cached 10s in Redis) |
   | `getAccounts` | `profile.ts` | Fetch account data for user profiles |
   | `get_content` | `app.ts` | SEO meta injection (Open Graph tags for bots) |
   | `get_content` | `anonymousReview.ts` | Fetch paper metadata to prevent author self-review |
   | `get_content` | `bridge.ts` | Fetch bridge paper to check existing metadata |
   | `get_content` | `blog.ts` | Fetch individual blog post by permlink |
   | `getDiscussions` | `blog.ts` | List recent blog posts |
   | `lookup_accounts` | `accounts.ts` | Search Hive accounts by username prefix |
   | `getDynamicGlobalProperties` | `hive.ts` | Startup health check (verify node reachability) |

### Accredited-Only Data Policy

PEvO defines its objects (papers, reviews, comments, bridge papers) by **author vouching**, not by metadata claim. A Hive comment with object-shaped metadata authored by a non-vouched account is not a PEvO object — it's a Hive comment claiming PEvO-shape. PEvO endpoints serve PEvO objects only. This is the read-gate.

This stance is distinct from the **write-gate** (root `CLAUDE.md` "Accreditation is the trust layer"), which restricts publishing/reviewing/commenting/voting on the write path to accredited accounts:

- **Write-gate (integrity invariant):** the platform itself only helps accredited users author PEvO objects. Anyone can post `APP_TAG`-tagged content directly to Hive, but PEvO won't help them.
- **Read-gate (ontological boundary):** PEvO API endpoints filter to PEvO objects. An on-chain `APP_TAG`-tagged Hive comment authored by a non-vouched account is invisible to PEvO surfaces because it isn't a PEvO object, regardless of how its metadata is shaped.

Accreditation status is itself **public** (queryable via `GET /api/accreditations`, the `active_accreditations` table, and on-chain `custom_json` accreditation attestations). The read-gate is not hiding confidentiality; it is enforcing object identity.

Per-object vouching:
- **Papers and comments:** author-vouched by accredited Hive accounts.
- **Reviews:** author-vouched by accredited reviewers, or by `config.hiveAnonAccount` posting on behalf of an accredited reviewer (`is_accredited: false` flag distinguishes anon-proxy from direct-accredited for UI badging).
- **Bridge papers:** author-vouched by `config.hiveBridgeAccount` cross-posting from external sources. The `bridge_paper` type-claim alone does not grant object status; the bridge-account vouching does. Bridge papers carry `is_accredited: false` and record the original off-chain authors in `json_metadata`.

There is no `accredited_only=false` opt-out on any endpoint. Surfacing non-vouched content is not a designed affordance.

HTTP-shape consequences:
- **List endpoints** (`GET /api/papers`, `GET /api/papers/:author/:permlink/comments`, `GET /api/search`) filter to PEvO objects via the SQL gate. Unknown query params (including `accredited_only=false`) are silently ignored per Express convention.
- **Single-doc endpoints** (`GET /api/reviews/:author/:permlink`) return 404 when the requested PEvO object doesn't exist at that identifier. An unaccredited author's object-shaped Hive comment isn't a PEvO object; 404 is the correct shape, same as a non-existent identifier.

Per-domain rules:
- **Votes:** Only votes from accredited accounts affect reputation scores, vote counts, and ranking. Votes from unaccredited accounts are ignored in all PEvO computations (they still affect Hive rewards natively).
- **Citations:** Only citations from papers authored by accredited researchers count toward citation scores.

Unaccredited users can still read PEvO surfaces and post on Hive (affecting Hive reward payouts), but their `APP_TAG`-tagged content does not become a PEvO object and does not feed into reputation, ranking, or rating systems. This prevents Sybil attacks and ensures scientific quality.

## 2. Data Model

### Paper (Hive post)

A PEvO paper is a standard Hive post with structured metadata. In the examples below, `pevo` stands for the runtime value of `APP_TAG` (e.g. `pevotest` during beta). The metadata key, `parent_permlink`, primary tag, and `app` prefix all use this value.

```
parent_author: ""
parent_permlink: APP_TAG
author: <hive_username>
permlink: <slug>
title: <paper_title>
body: <abstract_or_full_text_in_markdown>
json_metadata: {
  app: "APP_TAG/APP_VERSION",
  tags: [APP_TAG, "science", "<discipline>", ...],
  [APP_TAG]: {
    type: "paper" | "bridge_paper",
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
    supplementary_files: [
      { cid: "Qm...", filename: "data.csv", type: "text/csv", size: 12345, description: "Raw dataset" }
    ],                          // [] on initial publish; may be absent on edits
    language: "en",
    document_hash: "<sha256 of PDF if uploaded>" | null,
    citations: [
      { author: "<hive_username>", permlink: "<paper_permlink>", title: "<cited paper title>", reputation_relevant?: true }
    ] | undefined,              // absent when empty
    continues: { author: "<hive_username>", permlink: "<paper_permlink>" } | undefined,
    addresses_reviews: [
      { author: "<reviewer>", permlink: "<review_permlink>" }
    ] | undefined,              // absent when empty
    source: {                   // bridge_paper only
      type: "arxiv" | "crossref",
      doi: "<DOI>" | null,
      arxiv_id: "<arxiv_id>" | null,
      url: "<canonical URL>",
      pdf_url: "<PDF URL>" | null,
      published_date: "<ISO 8601>",
      source_name: "<display name>",
      license: "<SPDX>" | null,
      registered_by: "<hive_username>"
    } | undefined               // absent on native papers
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
  app: "APP_TAG/APP_VERSION",
  tags: [APP_TAG, "review"],
  [APP_TAG]: {
    type: "review",
    version: 1,
    rating: {
      methodology: 1-5,
      novelty: 1-5,
      clarity: 1-5,
      significance: 1-5
    },
    is_anonymous: false | true,
    reviewer_attestation_id: null   // always null on-chain; anon mapping stored in DB
  }
}
```

The API response for reviews includes a `reviewed_version` field (integer), but this is computed from timestamps by the backend, not stored in on-chain metadata.

### Comment (Hive comment on a paper)

A PEvO discussion comment is a Hive comment with minimal structured metadata.

```
parent_author: <paper_or_comment_author>
parent_permlink: <paper_or_comment_permlink>
author: <commenter_hive_username>
permlink: <slug>
title: ""
body: <comment_in_markdown>
json_metadata: {
  app: "APP_TAG/APP_VERSION",
  tags: [APP_TAG],
  [APP_TAG]: {
    type: "comment",
    version: 1
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
  method: "email" | "wot" | "orcid" | "manual",
  evidence_hash: "<sha256 of verification evidence>",
  timestamp: "<ISO 8601>"
}
```

### Revocation (custom_json)

Revokes a previously issued accreditation.

```
id: "pevo"
required_auths: []
required_posting_auths: ["pevo.admin"]
json: {
  action: "revoke",
  account: "<hive_username>",
  reason: "...",
  timestamp: "<ISO 8601>"
}
```

### Accreditation Authority Whitelist

When reading accreditation and revocation `custom_json` ops from the chain, the backend **must filter by sender**. Only transactions where `required_posting_auths` contains a whitelisted account are accepted. This prevents anyone from broadcasting a fake accreditation under the app's `custom_id`.

The whitelist is: `[HIVE_ADMIN_ACCOUNT, ...ACCREDITATION_AUTHORITIES]`. The admin account is always implicitly included.

**HAF SQL:** The `hafsql.operation_custom_json_view` has a `required_posting_auths` column (jsonb array of account names). Filter with:
```sql
AND cj.required_posting_auths ?| $N::text[]
```
where `$N` is the whitelist array. The `?|` operator checks if the jsonb array contains any of the given text values.

**WoT vouches** are not filtered by `?|` on posting authorities. Instead, vouches are validated by joining on `active_accreditations`, so only currently accredited users' vouches count.

## 3. Reputation Algorithm (v3 — current)

Reputation is computed entirely from public on-chain data via HAF SQL queries. Anyone running the same queries against the same HAF database must get identical results. Full spec: `agents/docs/reputation-algorithm.md`.

### Signals

| Signal | Source | Max Weight |
|--------|--------|------------|
| Paper score | Accredited votes weighted by voter reputation × vote strength, multiplied by review quality | W_paper = 20 |
| Review score | Accredited votes weighted by voter reputation × vote strength | W_review = 10 |
| Citations | Quality-weighted by citing paper's score, with self-citation discount (0.05×) and temporal decay | W_citation = 3 per, cap 15 |
| Accreditation bonus | On-chain `custom_json` attestation | 5 |

### Vote-Quality Mechanism

Votes from accredited users are weighted by the voter's own reputation: `voter_weight(v) = clamp(0.4, 1.0, 0.4 + 0.6 * sqrt(reputation(v) / 100))`. This creates a feedback loop where highly-reputed scientists' evaluations carry more influence, resolved via nightly batch cycles (each cycle uses the prior cycle's scores as voter weights).

Vote strength is also factored in: `vote_influence = voter_weight × abs(hive_vote_weight) / 10000`, where `hive_vote_weight` is the raw on-chain integer (-10000 to +10000). The frontend offers 6 vote levels for accredited users. The backend does not enforce these tiers; it reads the raw Hive vote weight and computes strength as a continuous value. The tiers below are a UI convention:

| Label | Hive weight | Strength |
|-------|-------------|----------|
| Strong endorsement | +10000 | 1.0 |
| Endorsement | +6000 | 0.6 |
| Mild endorsement | +2500 | 0.25 |
| Mild concerns | -2500 | 0.25 |
| Reject | -6000 | 0.6 |
| Strong reject | -10000 | 1.0 |

### Anti-Sybil Defense

- Voters with no prior batch score (fresh system or first cycle) weight at 1.0 unconditionally
- Inactive accounts (no papers or reviews) receive reduced voter weight: `sqrt(rep/100)` with no 0.4 floor
- Downvotes penalize paper scores: `weighted_downvotes × W_downvote (2)`
- Papers can go negative (floor at -W_paper)
- Self-citations count at 5% of normal value
- Citation cap prevents gaming via mass-citation (max 15 points)

### Output

- **Score:** Numeric value (clamped 0-100)
- **Breakdown:** `{ papers, reviews, citations, accreditation }` — four factors only

### Temporal Decay

All scores decay with age: `decay(age) = max(decay_floor, 1 - decay_rate × months_past_grace)`. Grace period: 6 months. Floor: 0.3. Decay rate: 0.02/month.

### Batch Computation

Reputation is computed in batch cycles defaulting to 28,800 blocks (~1 day at 3s/block). This is the `cycle_blocks` parameter in `ReputationWeights`, configurable via on-chain `update_weights` custom_json. Each cycle is a single pass using the prior cycle's scores as voter weights (no convergence iterations). The batch job checks for new cycles hourly. Scores stored in Redis (`reputation:batch:{username}`). On-demand queries read voter weights from the latest batch; if no batch exists (fresh system), all voters weight at 1.0.

Each PEvO instance runs its own Redis. Keys are not namespaced by `APP_TAG`.

## 4. API Contract

See `agents/docs/api-contract.md` for full endpoint specifications.

## 5. Operator Signals

Backend emits structured log lines that operators (and any future ops/monitoring tooling) key on for capacity-related triage. Field names listed here are stable and dashboard-safe.

### `event: 'argon2_abort_summary'`

Periodic summary log emitted at most once per `ABORT_REPORT_INTERVAL_MS` (currently hard-coded to 60s in `backend/src/lib/argon2-semaphore.ts`). Captures the count of `ArgonAbortError` events (client-disconnect-during-argon2) since the last emission. Emitted only when the delta is non-zero, so quiet boxes produce zero log lines.

| Field | Type | Description |
|-------|------|-------------|
| `event` | string | Always `'argon2_abort_summary'`. |
| `count` | integer | Aborts since the last summary emission (delta, not cumulative). |

Operator semantics: a non-zero `count` indicates clients disconnected mid-request while their argon2 hash/verify was running. A bursty signal under a network event or attacker-driven connection-cycling scenario is the expected use case. Per-event abort lines remain at `debug` for `LOG_LEVEL=debug` deep investigation; the summary is the default-`info` operator-visible signal.

Counter-accuracy note: between commits `5d33f24` (which introduced the periodic reporter) and `aeef5f2` (which added per-request dedupe via `incrementAbortOnce`), `count` could be inflated by up to 2× under the slot-grant race window (one logical abort produced two counter increments via both the parked-waiter `onAbort` listener and the awaiter-side abort check). Post-`aeef5f2`, one logical abort produces exactly one increment. Operators who calibrated alert thresholds against the inflated values will see the reported count drop by up to 50% under disconnect storms — this is a measurement correction, not a traffic decrease.

### `argon2 queue saturated` (free-text, queue-full path)

Emitted from `backend/src/lib/argon2-error-handler.ts` when a route catches `ArgonQueueFullError`. Currently free-text rather than structured. Operationally still useful (visible at `LOG_LEVEL=warn`) but log aggregators have to match the message string rather than a stable `event` field. This asymmetry vs. `argon2_abort_summary` is tracked as a follow-up; see also the `details.reason: 'queue_full' \| 'shutdown_drain'` machine-readable discriminator on the 503 envelope itself (`agents/docs/api-contracts/common.md` SERVICE_UNAVAILABLE row), which HTTP-only consumers can branch on without log-stream correlation.

### Worker / instance scope

The argon2 abort counter is per-process. If PEvO ever runs in cluster mode (multi-worker), the counter is per-worker and the summary log fires per-worker. Aggregating across workers is the dashboard's responsibility — the log line carries no worker/PID field today (one process = one source).

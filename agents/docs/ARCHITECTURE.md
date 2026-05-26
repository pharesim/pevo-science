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

### Multi-Author Trust Model

PEvO papers can have multiple co-authors. The chain layer captures who *broadcasts* each post; the metadata layer captures who is *credited* for the paper. These two sets are not the same, and the platform enforces consent-gated authorship to prevent insider abuse where one vouched co-author edits paper metadata to claim or drop authorship without the others' consent.

This section is the canonical spec for who can mutate what on a multi-author paper. The continuation-author-consent gate in `resolveContinuationChain` and the field-mutation rules layered on top of it both derive from this model.

#### Design alternatives considered

A simpler model was considered and rejected: fix the prior subset-check inversion (replace with a no-shrink rule), keep implicit consent (listing = vouched), use accreditation revocation as the only co-author-removal path. No `author_accept` / `author_resign` ops, no vouched-vs-claimed distinction. This alternative cannot tell a legitimate "Carol joined during revision and Bob added her" from a spoofed "Bob added Mallory and is pretending she consented." Both shapes look identical without an explicit consent op from the new author. The chosen design accepts the cost of two new op types in exchange for that distinction. The simpler model also offers no path for a co-author to legitimately disassociate from a paper short of accreditation revocation, which is a platform-wide nuclear option for what should be a per-paper decision.

#### Threat model

The model defends against one explicit adversary class beyond what the continuation-author-consent gate already handles:

- **Outside attacker** posting `pevo.continues = {author, permlink}` to spoof a paper. Handled by the existing continuation-author-consent gate (admitted continuator must be a vouched author of the continued paper). Out of scope for this section.
- **Vouched co-author turned adversarial.** A legitimately-added co-author whose key is compromised, account is sold, or who is themselves malicious. This includes: silent removal of other co-authors via metadata edit, silent introduction of a third party as a co-author, redirection of canonical payload pointers (`ipfs_cid`, `document_hash`).

The model does NOT defend against arbitrary co-author edits to free-edit fields (body, title, citations, etc.). That is accepted risk; the deterrents are on-chain audit trail (every malicious edit is permanently attributed to the broadcasting author), accreditation revocation, and original-author re-edit power.

#### Vouched vs claimed authorship

For a paper rooted at `(root_author, root_permlink)`, the **claimed authors** set is the union of `pevo.authors[].hive` entries across all operations on admitted chain posts (broadcasts AND subsequent edits — historical union, not current state). The set is append-only: once a hive handle has appeared in any chain post's `pevo.authors[]`, it is permanently in the claimed set, even if a later native-edit removes it from that post's current metadata. This is the load-bearing rule that prevents a vouched co-author from unilaterally unmaking another author's claim by native-editing their own continuation. Authors who contributed to a paper cannot be erased; they can only resign (see "Authors mutation" below).

A claimed author is **vouched** iff:
1. They broadcast the root post (implicit acceptance via posting-key signature on the post itself), OR
2. They have broadcast an `author_accept` `custom_json` op for this paper, AND have NOT later broadcast an `author_resign` op (latest op wins per `block_num` ordering).

Vouched status is per-(author, paper), not per-version. Once carol broadcasts a valid `author_accept` for paper P, she is vouched for ALL versions of P (current and future) unless she later broadcasts `author_resign`. A co-author who is unable to accept (no Hive account, never engages with the platform, deceased, lost keys) remains in the claimed-pending state across the paper's lifetime; this is an accepted outcome of the consent-gated model.

`pevo.authors[]` entries with `hive: null` (bridge papers' display-only credits referencing original-preprint authors who lack Hive identity) are claimed but never vouched. They have no on-chain identity to vouch with.

The continuation-author-consent gate admits continuation posts only from vouched authors. Reputation flow, citation credit, and continuation-edit power on the paper's metadata are all gated on vouched status. A claimed-but-unvouched name shown on the paper is informational only.

#### Field mutation rules

When the chain head's metadata is overlaid on the displayed paper, fields are governed by:

| Field | Rule |
|---|---|
| `pevo.authors[]` | Consent-gated. Additions allowed (claimed-pending until accept). Removals only via the resigning author's own `author_resign` op. See "Authors mutation" below. |
| `ipfs_cid`, `document_hash`, `ipfs_filename` | Per-version. Each chain post carries its own; the head's wins for the default view, prior versions accessible via `?version=N`. All historical CIDs preserved on chain (Hive immutability) AND on community-operated pinners (see "Pinner constraint" below). |
| `title`, `body`, `abstract`, `citations`, `keywords`, `discipline`, `tags`, `language`, `supplementary_files`, `addresses_reviews` | Free-edit by any vouched author via continuation. Risk accepted. Deterrents: on-chain audit (broadcaster-attributed), accreditation revocation, original-author re-edit power. |


Fields written exclusively by an admin attestation flow (`pevo.doi`, when PEvO acquires DOIs from external registrars) or by bridge import (`source.doi` on bridge papers) are not user-editable and are outside this trust model. The DOI-assignment flow itself is filed separately (not yet scoped); from this trust model's perspective, `pevo.doi` is system-managed read-only metadata.

`citations` is in the free-edit bucket because legitimate revisions regularly update the reference graph (responding to reviewer feedback, adding follow-up work, correcting errors). Treating it as consent-gated would require co-author co-signing on every citation change, which is heavier than the typical revision flow warrants. Mitigations: every edit is broadcaster-attributed on chain (a malicious edit lands under bob's account, not alice's), the original author retains re-edit power to overwrite head metadata, accreditation revocation deters persistent abuse, and the reputation algorithm can weight citations by cross-version stability so manipulation in a single version produces less reputation flow than consistent citations across the chain. Residual risk is accepted: a brief window where a malicious vouched co-author has rewritten citations before re-edit + accreditation governance respond. The deterrent model is load-bearing here, not the gating model.

#### Authors mutation

`pevo.authors[]` is mutable but consent-gated:

- **Adding a new author.** Any vouched author writes the new author into their continuation post's `pevo.authors[]`. The new author becomes a *claimed* author immediately but is *not vouched* until they broadcast an `author_accept` op. The display layer surfaces vouched status via a PEvO user badge plus profile link on the author's name; claimed-but-not-vouched names display as plain text without the badge. There is no separate "pending" UI tier; vouched-status presence or absence is the only display distinction.
- **Removing an author.** Cannot be done by another author's continuation. The removed author must broadcast an `author_resign` op themselves (self-resign). The vouched-set computation reads the latest `author_accept` / `author_resign` op per (author, paper) pair; resign demotes them out of the vouched set going forward. Pre-resign continuations they broadcast remain in the chain history. **Native-editing a chain post to drop a name from `pevo.authors[]` is NOT a removal.** Authors who have contributed to a paper cannot be erased from the claimed set by metadata edits; the claimed set is the historical union of every operation's `pevo.authors[].hive`. The only way to demote a vouched author is the resigning author's own `author_resign` op.
- **Authorship disputes** (alice wants bob removed, bob refuses). Out of scope for the metadata layer. Disputes are handled via accreditation governance (revoke bob's accreditation, which removes vouched status across all his papers) or paper retraction (republish as a new paper without bob, citing the original).

`resolveContinuationChain` and the head-meta override path enforce the additive-with-resign rule: head's `pevo.authors[].hive` may be a superset of root's (additions allowed; new entries are claimed-pending until accept), but if any name in root's `pevo.authors[].hive` is missing from head's, the override is rejected and an audit event is logged. Removal of a vouched author from the displayed authors list happens only via that author's own `author_resign` op, computed at read time from the chain's `custom_json` history.

#### Light-account signing of consent ops

Light-account users (server-encrypted posting keys; see "Account Creation" in `CLAUDE.md`) can broadcast `author_accept` and `author_resign` via the custody endpoint. Because these ops are infrequent and reputationally weighty (the broadcast event is permanently attributed on chain, even though the functional vouched state is reversible by a later inverse op), the backend MUST require a per-op fresh authentication challenge appropriate to the user's auth mechanism: a password re-prompt for password-based accounts, a fresh ORCID OAuth round-trip for ORCID-authed accounts, or the analogous fresh-auth for any future auth mechanism. After the fresh-auth succeeds, the backend signs and broadcasts.

The fresh-auth challenge mints a single-use proof bound to the JWT subject AND to the specific `(action, root_author, root_permlink)` consent target. The two issuance endpoints are documented in `agents/docs/api-contracts/`:
- `POST /api/custody/fresh-auth` — password-path issuance (see [custody.md](api-contracts/custody.md)).
- `POST /api/orcid/start { mode: "fresh_auth" }` followed by `POST /api/orcid/callback` — ORCID-path issuance via a fresh OAuth round-trip (see [orcid.md](api-contracts/orcid.md)).

Both paths produce a proof that is consumed atomically before the broadcast attempt at `POST /api/custody/broadcast`. A proof issued for one target cannot be replayed against another (cross-paper or cross-action substitution is rejected at consume with `details.reason: "target_mismatch"` → 403 `FRESH_AUTH_REQUIRED`).

The backend MUST audit-log every consent op it signs on behalf of a user. The `custody_audit_log` table carries the standard custody columns (`username`, `op_type`, `tx_id`, `block_num`, `created_at`) plus four consent-op-specific columns populated only when fresh-auth was required: `auth_mechanism` (`'password' | 'orcid'`), `fresh_auth_outcome` (the consume result, including the closed enum of rejection reasons), `session_id`, and `user_agent`. Operators investigating consent-op activity for a user query the table by `username` and `op_type IN ('author_accept', 'author_resign')`; the four extra columns provide the auth-mechanism + session correlation needed for abuse triage. The `user_agent` column is annotated as PII per GDPR/CNPD; the user's "delete my account" path MUST `DELETE FROM custody_audit_log WHERE username = $1` inside the same transaction as the rest of the user-data deletion.

Self-custody users sign these ops with their own key via Hive Keychain and bypass the custody endpoint entirely; the fresh-auth requirement is a custody-endpoint guard, not a chain-layer rule.

#### Vouched-set computation (Phase 2 constraints)

The vouched-set is computed at read time from on-chain state. The implementation shape (CTE in chain-walk SQL, separate query, materialized view, or other) is a Phase 2 decision, but the spec commits to the following constraints:

- **At most one-block-stale state.** A consent op (`author_accept` or `author_resign`) broadcast at block N MUST be reflected in the vouched-set computation by block N+1.
- **O(1) HAF queries per paper-detail request.** The vouched-set lookup runs once per request, not per chain hop. Implementations that fire one query per continuation post are out of bounds.
- **Cache invalidation on every consent op.** Cache invalidation hooks MUST fire on every `custom_json` op with `id = APP_TAG` and `action` in `{author_accept, author_resign}` that cites a paper, in addition to the existing comment-op invalidation hooks.
- **Cache keys include the version dimension.** Cached vouched-set state MUST be invalidated for both `paper-detail:{author}:{permlink}` and `paper-detail:{author}:{permlink}:v{N}` on every consent op for that paper, since vouched-set affects both default-view and per-version-view.

The HAF read fails closed. When `getPool()` returns null or the consent-op query throws, paper-detail and `/api/me/authorships/pending` MUST return 503 INTERNAL_ERROR rather than degrade to a root-only vouched-set. Degrading would silently demote legitimate co-authors below the cumulative-union claimed-set baseline AND open an attacker-attractive bypass window during HAF flaps; "chain is SSoT" is binding here. The integration site MUST short-circuit the consent fetch when the consent flow is inert (single-author claimed-set or bridge papers per the "Bridge papers" subsection) so the fail-closed surface is bounded to genuinely multi-author papers. The `fetchConsentOpsForPaper` helper MUST distinguish "no ops" from "HAF unavailable" via its return type so the integration site applies the policy explicitly. Operators see the outage as HTTP 503s plus a per-request structured pino log marking the fail-closed event. This posture matches the existing HAF-required reads at `verifyOrcidBinding` (`backend/src/routes/orcid.ts:1502-1506`, "Fail closed when HAF is unavailable: returning null would silently bypass...") and the chain-walk SQL in `resolveContinuationChain`, which is HAF-required by construction.

#### Compromised-key recovery

Posting-key compromise (phishing, malware, sold account, light-account master-key incident) admits a finite, bounded attack window. An attacker with a vouched co-author's posting key can broadcast `author_resign` for that author plus a continuation adding a new claimed-pending author; the new author can then broadcast `author_accept` under their own key. The legitimate co-author becomes unvouched until they:

1. Rotate their posting key via Hive's native `account_update` op (Hive consensus rejects further ops signed by the old key from that block onward).
2. Broadcast a new `author_accept` for the affected paper to restore vouched status going forward.
3. File an accreditation-governance ticket against the attacker-introduced author (revocation removes the attacker's vouched status across all their papers).

Pre-rotation damage is permanent on chain (the spurious resign and the attacker's continuation cannot be unmade), but reputation flow and citation credit are restored on re-accept. This residual risk is accepted; raising the resign auth level to active-key would lock light-account users out of the custody-endpoint resign path without preventing the co-pollute arm of the attack.

#### Bridge papers

Bridge papers are immutable post-publish. The bridge writer publishes the canonical mirror of an external preprint (arxiv, crossref, etc.) once and never updates it; the upstream source does not change once cited, so there is no edit, sync, or update flow for bridge papers. The implementation cleanup of the dead update surfaces is filed as `backend-retire-bridge-update-route.md` (backend route removal) and `ui-retire-bridge-sync-affordance.md` (UI affordance removal); both can land independently.

The bridge account is the sole vouched author. `pevo.authors[]` entries with `hive: null` are display-only credits referencing original-preprint authors who lack Hive identity. The consent-gated authorship flow does not apply.

The `extractAuthorizedContinuationAuthors` helper (`backend/src/helpers.ts`) special-cases `bridge_paper` type to return `{config.hiveBridgeAccount}` as the sole authorized continuator. Under the immutability policy this carve-out is inert — bridge papers do not have continuations — and is retained only as defense-in-depth: if the policy is ever revisited and bridge updates are revived, the carve-out becomes load-bearing. Until then, the canonical rule is the immutability statement above, not the helper's continuator admission.

If/when an original-preprint author joins Hive and wants to claim authorship of an imported bridge paper, the off-chain verification flow plus on-chain attestation (likely issued by the bridge service) is filed as a separate task (`backend-bridge-paper-author-claim-flow`) for scoping when triggered. Out of scope for this section.

Until that claim flow ships, the bridge importer MUST keep `pevo.authors[].hive` as `null` for all non-bridge entries on bridge papers; populating Hive handles via fuzzy ORCID-to-Hive lookup or any other auto-mapping is forbidden, because a dormant `author_accept` op pre-broadcast under a colliding handle would otherwise activate retroactively when the importer assigned the handle to a bridge paper. Authorship binding for bridge papers happens through the explicit attestation path, not through importer-side metadata writes.

#### Migration

Hard cutover. From the flag-day deploy of these rules, vouched status requires either root-broadcast or an on-chain `author_accept` op. Existing multi-author papers' co-authors must broadcast `author_accept` to retain vouched status; until they do, they are demoted to claimed-pending and cannot broadcast continuations admitted by `resolveContinuationChain`. Single-author papers are unaffected (the broadcaster is implicitly vouched).

PEvO is in beta (`pevotest` tag). The user disruption from hard cutover is bounded by the small beta-cohort multi-author paper count and is preferred over carrying a grandfather-exception path indefinitely.

The flag-day deploy depends on two follow-up surfaces shipping concurrently: a backend `GET /api/me/authorships/pending` endpoint (`backend-notification-infra-for-consent-ops`) and a UI surface for paper-detail accept/resign affordances plus a one-time migration banner (`ui-multi-author-consent-affordances`). Without those surfaces, the cutover silently strands existing co-authors with no in-platform discovery path for their demoted status.

#### Pinner constraint

PEvO relies on community-operated IPFS pinners to retain pins for every CID that has appeared in an admitted chain post's `pevo.ipfs_cid`, `pevo.document_hash`, or `pevo.supplementary_files[].cid`, for the lifetime of the paper. Unpinning is only allowed when the paper itself is retracted (separate flow). This invariant is what makes the per-version preservation rule for `ipfs_cid`/`document_hash` operationally meaningful: prior versions remain retrievable, not just identifiable.

Pinner implementation lives in [`pharesim/pevo-pinner`](https://github.com/pharesim/pevo-pinner) (extracted from PEvO main on 2026-05-21). See that repo's `agents/docs/ARCHITECTURE.md` for the discovery pipeline (HAF SQL filtered by `APP_TAG`), autopin rule engine, embedded-IPFS-node backend, and the retention invariant's operational implementation. Community deployments discover paper CIDs entirely via HAF; there is no PEvO → pinner call path.

**Drift note.** Changes to the HAF discovery query consumed by pevo-pinner (the `hafsql.comments` filter shape, `json_metadata -> '<APP_TAG>'` field access, or `APP_TAG`-coupled assumptions) are breaking changes for community deployments. Flag pinner-impacting changes in the PR description so community operators can coordinate updates.

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

### Author Accept (custom_json)

Broadcast by an author (or claimed-pending author) to register vouched status for a specific paper. See section 2 "Multi-Author Trust Model" for the semantics; this is the wire format.

```
id: "APP_TAG"
required_auths: []
required_posting_auths: ["<accepting_author_hive>"]
json: {
  action: "author_accept",
  root_author: "<paper_root_author>",
  root_permlink: "<paper_root_permlink>"
}
```

Validity (read-time), all conjuncts required:
- The chain signer (`required_posting_auths[0]` of the `custom_json` op) is the accepting author for this op. The binding is implicit: the payload carries no subject identity field, so signer identity IS the accepter identity. An attacker cannot mint a third party's acceptance by crafting a payload under their own posting key, because the signer would then be the attacker, not the third party.
- The chain signer MUST appear in the claimed authors set for the paper (the historical union of `pevo.authors[].hive` across all operations on admitted chain posts; see "Vouched vs claimed authorship" above).
- The accept op's `block_num` MUST be strictly greater than the `block_num` of the earliest admitted chain post operation that included the chain signer in `pevo.authors[]`. This prevents name-squatting: an op pre-broadcast before the author was ever claimed cannot be retroactively activated by a later collision-listing.

Latest valid op wins per `(accepting_author, paper)` pair, ordered by `(block_num, id)` (highest wins). The HAF view `hafsql.operation_custom_json_view` exposes `id` as the canonical same-block tie-break primitive (the view does not project `trx_in_block`; `id` is a bigint encoding `block_num + trx_in_block + op_in_trx`, so ordering by `id` within a fixed `block_num` is equivalent to ordering by `trx_in_block`).

### Author Resign (custom_json)

Broadcast by a vouched author to relinquish authorship of a paper.

```
id: "APP_TAG"
required_auths: []
required_posting_auths: ["<resigning_author_hive>"]
json: {
  action: "author_resign",
  root_author: "<paper_root_author>",
  root_permlink: "<paper_root_permlink>"
}
```

Validity (read-time): the chain signer (`required_posting_auths[0]`) is the resigning author for this op. Same implicit-binding shape as `author_accept`: the payload carries no subject identity field, so signer identity IS the resigner identity. Resignation is always self-resignation; an attacker cannot resign someone else by crafting a payload under their own posting key, because the signer would then be the attacker, not the third party.

Effect: the resigning author is removed from the vouched set for this paper going forward. Pre-resign continuations they broadcast remain in the chain history; their ability to broadcast new admitted continuations is revoked. The resigning author REMAINS in the claimed authors set (resignation withdraws vouched status, not historical contribution; `pevo.authors[]` history is append-only per "Vouched vs claimed authorship"). Re-acceptance after resign is allowed: a later valid `author_accept` overrides per `(block_num, id)` ordering when querying `hafsql.operation_custom_json_view`.

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

Periodic summary log emitted at most once per `ABORT_REPORT_INTERVAL_MS` (60s by default; the actual cadence is reported on every line via the `intervalMs` field). Captures the count of `ArgonAbortError` events (client-disconnect-during-argon2) since the last emission. Emitted only when the delta is non-zero, so quiet boxes produce zero log lines.

| Field | Type | Description |
|-------|------|-------------|
| `event` | string | Always `'argon2_abort_summary'`. |
| `count` | integer | Aborts since the last summary emission (delta, not cumulative). |
| `intervalMs` | integer | Reporter cadence in ms (currently 60_000). Self-describing so dashboards can express rates as `count / intervalMs * 1000` (events/s) without hardcoding the constant from source. |

Operator semantics: a non-zero `count` indicates clients disconnected mid-request while their argon2 hash/verify was running. A bursty signal under a network event or attacker-driven connection-cycling scenario is the expected use case. Per-event abort lines remain at `debug` for `LOG_LEVEL=debug` deep investigation; the summary is the default-`info` operator-visible signal.

Operator semantics during graceful shutdown (SIGTERM / `drainArgon2Queue()` window): `argon2_abort_summary` is expected to show **no** abort traffic during the drain window, even if many clients disconnect because the server is shutting down. Disconnect events that race against drain classify as `ShuttingDownError` (HTTP 503 with `details.reason: 'shutdown_drain'`) and do not feed the abort counter; pre-aborted callers arriving after `drainArgon2Queue()` flips the shutdown flag also classify as shutdown, not abort. A dashboard that suddenly shows zero abort traffic across a deploy is the metric working correctly, not a broken pipeline. The asymmetric counter rule that produces this behavior: the abort counter is incremented only by the abort listener that actually owns propagation. Drain-race aborts (caller already received `ShuttingDownError`) and slot-release-race aborts (slot-grant race-guard already counted) do not double-count. The contract is `count == ArgonAbortError instances actually thrown to callers`.

Counter-accuracy notes (each is a measurement correction, not a traffic change — alert thresholds calibrated against the prior counter shape will see one or both step-downs):

- **Round 1 (`5d33f24` → `aeef5f2`):** introduced the periodic reporter and then closed a slot-grant-race double-increment via per-request `incrementAbortOnce`. `count` could be inflated by up to 2× before `aeef5f2`; post-`aeef5f2`, one logical abort produces exactly one increment. Step-down was distributed across all disconnect storms.
- **Round 2 (`647a115`):** gated the parked-waiter `onAbort` counter on `waiters.indexOf(w) >= 0` (drain-race + slot-release-race no-op) and swapped function-entry guards so `shuttingDown` precedes `signal?.aborted` (pre-aborted-during-drain reclassifies as shutdown, not abort). Step-down is concentrated in graceful-restart windows specifically — operators should expect a quieter `argon2_abort_summary` during rolling deploys after `647a115` than before, with steady-state values largely unchanged.

### `argon2 queue saturated` (free-text, queue-full path)

Emitted from `backend/src/lib/argon2-error-handler.ts` when a route catches `ArgonQueueFullError`. Currently free-text rather than structured. Operationally still useful (visible at `LOG_LEVEL=warn`) but log aggregators have to match the message string rather than a stable `event` field. This asymmetry vs. `argon2_abort_summary` is tracked as a follow-up; see also the `details.reason: 'queue_full' \| 'shutdown_drain'` machine-readable discriminator on the 503 envelope itself (`agents/docs/api-contracts/common.md` SERVICE_UNAVAILABLE row), which HTTP-only consumers can branch on without log-stream correlation.

### Worker / instance scope

The argon2 abort counter is per-process. If PEvO ever runs in cluster mode (multi-worker), the counter is per-worker and the summary log fires per-worker. Aggregating across workers is the dashboard's responsibility — the log line carries no worker/PID field today (one process = one source).

## 6. Account State Machine and Re-Auth Invariants

The `accounts` Postgres table tracks signup-originated users (email and ORCID signups) and post-upgrade self-custody users. Pure self-custody users who bring their own Hive account have no `accounts` row at all; they authenticate via the `verifyHiveSignature` middleware's per-request Hive-signature path. This section is the canonical reference for every reachable steady state, the routes that transition between them, and the re-auth proof each critical action requires. Code that defends, branches on, or migrates between account states must be reviewable against this section; defenses against `(field, field, field)` combinations not enumerated here are dead code and should be flagged at review.

### 6.1 Reachable Steady States

Six dimensions of the `accounts` row affect auth and state transitions: `verify_token`, `username`, `password_hash`, `orcid`, `custody`, `upgraded_at`. Orthogonal overlays (`reset_token`, `pending_email_*`, `sessions_invalidated_at`) are transient flags layered on top of these states, not states themselves.

| State | verify_token | username | password_hash | orcid | custody | upgraded_at | Reached by |
|---|---|---|---|---|---|---|---|
| A | NULL | SET | SET | NULL | `'light'` | NULL | Email signup, no ORCID linked |
| B | NULL | SET | SET | SET | `'light'` | NULL | A with ORCID linked, or combined email+ORCID signup |
| C | NULL | SET | NULL | SET | `'light'` | NULL | ORCID-only signup, or A/B after `/recover` with `orcid_token` and no `new_password` |
| D | NULL | SET | (preserved from A/B/C) | (preserved) | `'self'` | SET | A/B/C after `/api/custody/upgrade` |
| E | random hex | NULL | SET | NULL | NULL | NULL | Email signup, after `/api/auth/signup`, before email-verify-link click |
| F | `'confirmed:<hex>'` | NULL | SET (email path) or NULL (ORCID path) | NULL or SET | NULL | NULL | Email signup after verify-link click, OR ORCID signup (skips E directly per `auth.ts:460-490`) |

Plus the **no-row case**: pure self-custody. User brings their own Hive account, never goes through PEvO signup, has no `accounts` row. Authenticated via `verifyHiveSignature` middleware per request (Hive-signature path); `req.hiveCustody = 'self'`.

States E and F are transient signup-pending. States A, B, C, D are finalized. **No transition produces a row that doesn't match one of the rows above.** Any code that posits another combination is defending a fictional state.

**Field rationale:**
- `verify_token`: encodes signup progress. Random hex = email not yet confirmed (state E). `'confirmed:<hex>'` = ready to finalize via `/signup-verify` (state F). NULL = finalized.
- `username`: NULL while pending finalization; SET to Hive username once the user picks one (light path) or links to an existing one (self path).
- `password_hash`: SET if account can password-auth. NULL for ORCID-only signups (no password ever set) and after `/recover-orcid-no-password` (password dropped). Argon2id-hashed.
- `orcid`: SET if account has an ORCID linked. ORCID-only signup sets this at signup; email-signup users can link later via `/orcid/callback mode='link'`.
- `custody`: `'light'` while server holds encrypted broadcasting keys. `'self'` after upgrade. NULL only during transient pre-finalize states E and F.
- `upgraded_at`: Set by `/api/custody/upgrade` as part of the light→self transition. Once set, never unset.

### 6.2 Per-State Concept and Session Auth Factors

**State A — Light, password-set, no ORCID.** Standard light account from email + password signup. Session auth: `POST /api/auth/login` (mints JWT with `custody='light'`). Recovery factor: BIP39 seed phrase (generated client-side at signup, used via `/api/auth/recover` with `memo_key`).

**State B — Light, password-set + ORCID-linked.** Either email signup followed by `/orcid/callback mode='link'`, or combined email + ORCID signup. Session auth: `POST /api/auth/login` (password path) or `POST /api/orcid/callback mode='login'` (ORCID path). Recovery factors: seed phrase or ORCID.

**State C — Light, passwordless ORCID-only.** Either ORCID-only signup (skipped password at signup, no email required), or A/B after `/api/auth/recover` with `orcid_token` and `new_password` omitted. Session auth: `POST /api/orcid/callback mode='login'` only. Recovery factors: seed phrase (all light signups produce one) or ORCID.

**State D — Upgraded self-custody.** Originally light (any of A/B/C), then upgraded via `/api/custody/upgrade`. `custody='self'`, `upgraded_at` set. Encrypted broadcasting keys (`posting_key_enc`, `memo_key_enc`, IVs) wiped during upgrade. `password_hash` and `orcid` are **preserved** — the user can still session-auth via the same factors they had before. But server-side broadcasting via `/api/custody/broadcast` is now disabled (no encrypted keys to decrypt). Useful work post-upgrade requires Keychain on the client.

**No-row case — Pure self-custody.** User brings their own Hive account and signs every request via Hive Keychain. The `verifyHiveSignature` middleware verifies the signature against the on-chain posting key from `getAccounts` (Hive API) and sets `req.hiveCustody = 'self'`. No `accounts` row exists; no PEvO-server session is involved.

### 6.3 Transitions

All routes that mutate state. Routes that only read state (login session-mint, accreditation queries) do not appear here.

```
Initial → finalized:
  [no row] ──signup(email+password)──> E ──email-verify-link──> F ──signup-verify(light)──> A
  [no row] ──signup(orcid_token only)─────────────────────────> F ──signup-verify(light)──> C
  [no row] ──signup(email+password+orcid_token)──────────────> F ──signup-verify(light)──> B
  [no row] ──(bring own Hive account)──────> no-row case

Adding auth factors:
  A ──orcid-callback(link)──────> B          (links ORCID to existing light-with-password)
  C ──settings/set-password─────> B          (adds password to passwordless ORCID-only)
  (B does NOT transition back to A — no unlink-ORCID route exists)

Recovery (proof factor must match registered set):
  A ──recover(seed_phrase, new_password)──> A          (password rotated)
  B ──recover(seed_phrase, new_password)──> B
  B ──recover(orcid, new_password)──> B
  B ──recover(orcid, no new_password)──> C             (drops password)
  C ──recover(seed_phrase, new_password)──> B          (adds password)
  C ──recover(orcid, new_password)──> B                (adds password)
  C ──recover(orcid, no new_password)──> C             (no-op on auth factors)

Forgot password (requires email access):
  A ──reset(email-link, new_password)──> A             (password rotated)
  B ──reset(email-link, new_password)──> B
  (C cannot use /reset — state C may have no email, and has no password to reset)

Light → self upgrade:
  A ──custody/upgrade(seed-phrase-derived-key proof)──> D
  B ──custody/upgrade(seed-phrase-derived-key proof)──> D
  C ──custody/upgrade(seed-phrase-derived-key proof)──> D
  D ──custody/upgrade──> 409 ALREADY_UPGRADED
```

Pure self-custody (no-row) users never enter this state machine; their identity is on-chain only.

The `recover(seed_phrase, …)` transitions above are **two-phase**: phase 1 (`POST /api/auth/recover`) only stages the change and the account stays in its current state; the transition lands at phase 2 (`POST /api/auth/recover/verify`) once the new email proves control (or never, if the staged swap is disputed or expires). The `recover(orcid, …)` transitions apply in one step. See § 6.4 for the per-path re-auth contract.

### 6.4 Critical-Action / Re-Auth Contract

Every critical action requires a fresh re-auth proof; the JWT alone is never sufficient. The required proof factor is determined by **what kind of control the action transfers or uses**, not by what auth factors the account happens to have. Per-state availability captures intent; current code may diverge — divergences are tracked as separate tasks, not inline here.

| Action | Endpoint | Required re-auth (intended) | Per-state availability |
|---|---|---|---|
| Server-side broadcast (non-consent ops) | `POST /api/custody/broadcast` | Fresh-auth proof matching a factor registered on the account | A: password proof. B: password OR ORCID proof. C: ORCID proof. D: blocked (encrypted keys nulled at upgrade). no-row: n/a (Keychain). |
| Server-side broadcast (consent ops: `author_accept`, `author_resign`) | `POST /api/custody/broadcast` | Per-target fresh-auth proof (target binds `op_type` + `paper_author` + `paper_permlink`) | Same as non-consent. Implemented at `custody.ts:312`. |
| Issue fresh-auth proof (password) | `POST /api/custody/fresh-auth` | Current password | A or B (states with password registered) |
| Issue fresh-auth proof (ORCID) | `POST /api/orcid/callback mode='fresh_auth'` | Fresh ORCID OAuth round-trip | B or C (states with ORCID registered) |
| Light → self upgrade | `POST /api/custody/upgrade` | Seed-phrase-derived pubkey (UI derives from BIP39 client-side; backend verifies pubkey matches on-chain `getAccounts` posting/active key) | All light states (A, B, C). D: 409. Pure self-custody: n/a. |
| Set password from null | `POST /api/settings/set-password` | Fresh ORCID OAuth proof (null-hash accounts have ORCID as their only registered factor) | C only. A and B return 409 (`PASSWORD_ALREADY_SET`). |
| Recover (lost email access, seed-phrase path) | `POST /api/auth/recover` (phase 1) + `POST /api/auth/recover/verify` (phase 2) | Seed-phrase derived memo key **AND** control of the new email. Phase 1 verifies the memo key and stages the swap; phase 2 applies it only after a token mailed to the new email is presented back. The old email receives a 48h dispute link that voids the staged swap. The memo-key proof alone no longer mutates the account — the email-control sub-proof is required on top. | All light states (A, B, C). Seed phrase works from any light state (every light signup produces one). |
| Recover (lost email access, ORCID path) | `POST /api/auth/recover` | Fresh ORCID OAuth round-trip matching the account's registered ORCID. Applies immediately and in one step — the OAuth round-trip is itself the email-side control proof the memo-key path lacks. Severed once `upgraded_at` is set (state D returns 401, generic message, to avoid an upgrade-state oracle). | B and C (states with `orcid IS NOT NULL`). |
| Reset (forgot password) | `POST /api/auth/reset-request` + `POST /api/auth/reset` | Email-link token | A and B (states with email AND password). C: not applicable. |
| Change email | `POST /api/settings/email` (change-email branch on existing row) | Fresh-auth proof matching a factor registered on the account. JWT path requires the proof in the body; Keychain (Hive-signature) path is fresh-proof at the middleware and requires no body proof. Add-flow no-row branch is JWT-unreachable and remains Keychain-only. | A: password proof. B: password OR ORCID proof. C: ORCID proof. D: matches preserved factors (password and/or orcid columns). Implemented at `settings.ts` POST /email (commit `b27bcdf`, audit closed by `backend-settings-email-reauth-audit` 2026-05-16). |
| Link ORCID | `POST /api/orcid/callback mode='link'` | Fresh ORCID OAuth | A → B |

### 6.5 Security Invariants

These invariants hold across every authenticated route. Code that violates an invariant is a security defect, not a stylistic preference.

1. **Critical actions require fresh re-auth proof.** A stolen JWT must not be a one-step takeover vector. JWT-only access on a critical action is a defect.
2. **Re-auth factor must match a factor the account has registered.** ORCID OAuth proof from an unrelated ORCID iD does not authenticate; password verification against a null hash does not authenticate; seed-phrase derived key proves possession only when the derived pubkey matches the on-chain account's posting/active key.
3. **Recovery proof must match a factor the account has registered.** State A (no ORCID) cannot recover via ORCID — no registered ORCID to prove against. State C (no password) cannot use `/reset` — no password to forget.
4. **State transitions only via the documented routes in § 6.3.** No code path may produce an `accounts` row that doesn't match a state in § 6.1. If a new state is needed, this section must be updated first and the transition added before code lands.
5. **Field-state inference is grounded in this section, not in code-side assumptions.** Reviewers MUST flag code that defends, branches on, or migrates `(verify_token, username, password_hash, orcid, custody, upgraded_at)` combinations not enumerated in § 6.1. Verbose-but-correct defense against the enumerated states is fine; defense against a state that doesn't exist is dead code that misleads future maintainers and reviewers.
6. **The seed phrase is the upgrade proof, not a session-auth factor.** UI derives a key from the BIP39 mnemonic locally and sends the derived pubkey to the backend. Backend verifies it matches the on-chain account's posting/active key via `getAccounts`. The seed phrase itself never leaves the client. Critical actions other than upgrade do not accept the seed-phrase-derived key as proof.
7. **The upgrade transition is one-way.** Once `upgraded_at` is set, the account is in state D forever. No "downgrade-to-light" route exists; the encrypted keys were destroyed during upgrade and cannot be reconstructed.

### 6.6 Maintenance

When any of the following change, this section is updated in the same commit as the code change:
- New routes that write `verify_token`, `username`, `password_hash`, `orcid`, `custody`, or `upgraded_at`.
- New auth factors (a hypothetical hardware-key or WebAuthn factor would add columns and states).
- New critical actions (anything that broadcasts, mutates an auth factor, or transfers control).
- New transitions, even between existing states.

The section is referenced from root `CLAUDE.md` "Code Review Findings" guidance: reviewers must consult § 6.1 to verify any defended account state is actually reachable.

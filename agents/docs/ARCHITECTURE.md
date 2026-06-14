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

### Schema Migrations

Migrations are authoritative. Application code never issues DDL on startup. The application schema is defined solely by the numbered `backend/migrations/*.sql` files; each file self-records into the `schema_migrations` table via a trailing idempotent UPSERT, and `deploy.sh migrate` applies them with a raw `psql` loop (no migration framework).

On boot the backend runs the `verifyAppDbMigrations` probe (`backend/src/app-db.ts`): it reads `schema_migrations` and aborts with a `BootFatalError` if any `*.sql` file present on disk lacks a row there (or if the tracking table itself is absent). The backend therefore never auto-creates or alters tables to "catch up" a stale database; it fails loud instead. Operators must run `./deploy.sh migrate` (or apply the migration set manually against `APP_DATABASE_URL`) before starting the backend. `deploy.sh restart` enforces that order by ensuring Postgres is up, running migrations, then swapping the backend (see the live-migrate rule below).

#### Live-migrate during `deploy.sh restart` (near-zero-downtime swap)

`deploy.sh restart` builds the new backend image and applies migrations while the **old** backend keeps serving `127.0.0.1:3001`, then recreates only the backend container (`cmd_restart` / `swap_backend`). The prior implementation ran `$COMPOSE down` first, so the host port had no listener for the whole down → build → migrate → boot sequence and host nginx returned a 502 for minutes; the swap ordering collapses that to a few-second container handover.

Applying migrations under a still-running old backend is safe because of a deliberate asymmetry in `verifyAppDbMigrations`: it fails closed only when the DB is **behind** the code (a `*.sql` on disk lacks its `schema_migrations` row) and **tolerates the DB being ahead** (extra rows ignored). The old backend already passed its probe at its own boot and does not re-run it, so a DB that has run ahead of it trips nothing.

The only DDL shapes that would break a still-serving old backend are relation/column **removal**, **rename**, a column **type change**, or `ADD COLUMN ... NOT NULL` (a constraint the running code does not satisfy). The set is otherwise expand-only (`CREATE TABLE/INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `COMMENT`, and constraint-**relaxing** `ALTER COLUMN ... DROP NOT NULL`), all invisible or benign to the old backend. `cmd_restart` greps the **unapplied** migration set (files on disk not yet recorded in `schema_migrations` — not the whole `*.sql` set, which would always match the already-applied `004_drop_account_creation_tokens.sql` `DROP TABLE` and wrongly force the carve-out on every restart) for those destructive shapes. Each file is normalized before matching — `--` comments stripped and newlines collapsed to one line — so a commented-out destructive statement does not force a needless carve-out and a destructive statement split across lines is still caught (a line-by-line grep would let a multi-line `ADD COLUMN ... NOT NULL` evade it); an unreadable file forces the carve-out. Clean → migrate live, then swap. Match → **brief-stop carve-out**: stop the backend, migrate against the quiescent DB, start the new backend. The carve-out still pays only the migration window, because the image was already built while the old backend was serving. If the migration fails on the carve-out path, `cmd_restart` restarts the previous backend before aborting (the new image was only built, not yet swapped in), and a failed handover on the swap step exits non-zero so a wrapper sees the broken deploy.

**Adding a destructive migration:** it triggers the brief-stop carve-out automatically (correct and safe). One latent foot-gun the grep does **not** catch: a large-table non-`CONCURRENTLY` `CREATE INDEX` or `ALTER ... SET NOT NULL` takes an `ACCESS EXCLUSIVE` lock that can stall the still-serving old backend even on the otherwise-clean path. Negligible at beta row counts; at scale use `CONCURRENTLY` or force the carve-out. The residual few-second swap blip is the inherent floor for a single host port behind an unreloadable host nginx, not a bug.

#### Post-deploy cleanup: migration 011 (signup binding hash)

Migration `011_accounts_signup_binding_hash.sql` adds a nullable `signup_binding_hash` column that back-fills NULL on existing rows. `/api/auth/confirm` and `/api/auth/link` fail closed on a NULL hash (the session-binding cookie cannot match a NULL stored hash), so any signup in-flight at deploy time is stranded. Email-flow rows self-recover via `/api/auth/resume-signup` (password re-verify re-mints the cookie and sets the hash). ORCID-only rows (`orcid` set, `password_hash` NULL) have no password and cannot, so they see a generic `400 "Invalid or expired ..."` until they re-start the full ORCID signup or the row's 24h `expires_at` lapses. Immediately after running the migration, clear any stranded ORCID-only pending rows so affected users get a clean re-signup:

```sql
-- Inspect first (confirm the set is the in-flight ORCID-only strand and nothing else):
SELECT id, orcid, full_name, created_at, expires_at
  FROM accounts
 WHERE verify_token IS NOT NULL
   AND signup_binding_hash IS NULL
   AND orcid IS NOT NULL
   AND password_hash IS NULL
 ORDER BY created_at;

-- Then DELETE (not merely NULL verify_token): the ORCID-direct /signup INSERT has no
-- ON CONFLICT, and the migration-007 partial-unique index on orcid would make a re-signup
-- collide on the lingering row. These rows are never-activated pending signups (no username,
-- no custody), so deletion is non-destructive.
DELETE FROM accounts
 WHERE verify_token IS NOT NULL
   AND signup_binding_hash IS NULL
   AND orcid IS NOT NULL
   AND password_hash IS NULL;
```

The window self-resolves within 24h via `expires_at` regardless; the cleanup just turns a confusing stuck `400` into an immediate clean re-signup for users mid-flight at deploy time.

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

PEvO papers can have multiple co-authors. The chain layer captures who *broadcasts* each post; the metadata layer captures who is *credited* for the paper. These two sets are not the same, and the platform enforces consent-gated authorship to prevent insider abuse where one consented co-author edits paper metadata to claim or drop authorship without the others' consent.

This section is the canonical spec for who can mutate what on a multi-author paper. The continuation-author-consent gate in `resolveContinuationChain` and the field-mutation rules layered on top of it both derive from this model.

**Implementation status.** The full consent model documented here is **live**: the continuation-admission gate (claimed-membership), the cumulative-union display construction, the consented-set resolution (the shared `consentChainCteBody` + `consentedAuthorsCteBody` SQL stack in `backend/src/hafsql.ts`), reputation/citation credit over Routes 1/2/3 minus demotions with **no metadata auto-accept** (`computeReputationBatch` composes the same stack; the former ORCID/hive auto-accept arms are deleted from `authorshipClaimsCteBody`), the paper-detail `consented` badge, `GET /api/me/authorships/pending`, and the display self-dealing exclusion over the full credited set (the `excludeClaimedSelfWhere` + `excludeConsentedSelfWhere` helper pair). The continuation gate still admits on **claimed** membership by design (see "Display construction" and "Consented-set computation (Phase 2 constraints)"). The JS consent primitives (`computeConsentedAuthors` / `getConsentedAuthors` in `backend/src/consent-ops.ts`) remain membership-only utilities composed into no read path; the SQL stack is the production resolution on every surface.

#### Design alternatives considered

A simpler model was considered and rejected: fix the prior subset-check inversion (replace with a no-shrink rule), keep implicit consent (listing = consented), use accreditation revocation as the only co-author-removal path. No explicit consent ops, no consented-vs-claimed distinction. This alternative cannot tell a legitimate "Carol joined during revision and Bob added her" from a spoofed "Bob added Mallory and is pretending she consented." Both shapes look identical without an explicit consent op from the new author. The chosen design accepts the cost of two new op types in exchange for that distinction. The simpler model also offers no path for a co-author to legitimately disassociate from a paper short of accreditation revocation, which is a platform-wide nuclear option for what should be a per-paper decision.

#### Threat model

The model defends against one explicit adversary class beyond what the continuation-author-consent gate already handles:

- **Outside attacker** posting `pevo.continues = {author, permlink}` to spoof a paper. Handled by the existing continuation-author-consent gate (admitted continuator must be a claimed author of the continued paper: a member of the cumulative chain `pevo.authors[].hive` set, per "Display construction" below). Out of scope for this section.
- **Consented co-author turned adversarial.** A legitimately-added co-author whose key is compromised, account is sold, or who is themselves malicious. This includes: silent removal of other co-authors via metadata edit, silent introduction of a third party as a co-author, redirection of canonical payload pointers (`ipfs_cid`, `document_hash`).

The model does NOT defend against arbitrary co-author edits to free-edit fields (body, title, citations, etc.). That is accepted risk; the deterrents are on-chain audit trail (every malicious edit is permanently attributed to the broadcasting author), accreditation revocation, and original-author re-edit power.

#### Consented vs claimed authorship

For a paper rooted at `(root_author, root_permlink)`, the **claimed authors** set is the union of `pevo.authors[].hive` entries across all operations on admitted chain posts (broadcasts AND subsequent edits — historical union, not current state). The set is append-only: once a hive handle has appeared in any chain post's `pevo.authors[]`, it is permanently in the claimed set, even if a later native-edit removes it from that post's current metadata. This is the load-bearing rule that prevents a consented co-author from unilaterally unmaking another author's claim by native-editing their own continuation. Authors who contributed to a paper cannot be erased; they can only resign (see "Authors mutation" below).

A claimed author is **consented** — credited (reputation + citation) and shown with the PEvO author badge — iff one of the following holds AND they have not since been demoted (latest op wins per `(block_num, id)` ordering; demotion is the author's own `author_resign` / self-`revoke_authorship`, or an author/admin `revoke` backstop):

1. **Root broadcaster** — they broadcast the root post (implicit consent via the posting-key signature on the post itself), OR
2. **Anchored-slot accept** — their `pevo.authors[]` slot carries an identity anchor and they broadcast an `author_accept` op for this paper. The anchor is EITHER a `hive` handle equal to the signer, OR an `orcid` equal to the signer's authority-attested ORCID — so the original author need not know the co-author's Hive handle; a verified ORCID binds the identity. OR
3. **Name-only approval** — their slot carries no anchor (neither `hive` nor `orcid`) and they broadcast a `claim_authorship` op that the paper author or admin confirms with an `approve_authorship` op, binding their Hive account to the name-only slot.

Routes 2 and 3 are selected by slot shape; both require the credited person's own explicit op. **There is no auto-accept**: an identity anchor (hive or ORCID) only establishes *who may consent*, never credit on its own. Route 2's wire format is in section 2 "Author Accept (custom_json)"; route 3's `claim_authorship` / `approve_authorship` / `revoke_authorship` wire formats are in `hive-schemas.md` § 2.9–2.11.

Consented status is per-(author, paper), not per-version. Once carol's consent resolves for paper P, she is consented for ALL versions of P (current and future) unless she later resigns or is revoked. A co-author who never completes a consent route (no Hive account, never engages with the platform, deceased, lost keys) remains in the claimed-pending state across the paper's lifetime; this is an accepted outcome of the consent-gated model.

A slot with neither a `hive` handle nor an `orcid` (a pure name-only display credit) is claimed but not consented until its real owner obtains a Hive account and completes route 3. A slot with an `orcid` but no `hive` becomes consented when its owner — accredited with that ORCID — broadcasts `author_accept` (route 2). Bridge papers' `pevo.authors[]` entries with `hive: null` follow the same rule, binding a Hive identity only through the explicit bridge-author-claim attestation flow (`backend-bridge-paper-author-claim-flow`).

The continuation-author-consent gate admits continuation posts from any **claimed** author of the paper (membership in the cumulative chain `pevo.authors[].hive` set, per "Display construction" below); this is the live defense against the outside-attacker spoof. Reputation/citation **credit**, by contrast, flows only to **consented** authors via the routes above — that is the credit gate this model establishes. Its enforcement in the reputation cycle is **live**: `computeReputationBatch` credits the Routes 1 ∪ 2 ∪ 3 union by composing the same `consentedAuthorsCteBody` (Routes 1/2) and `authorshipClaimsCteBody` `accepted_claims` (Route 3) stacks the read surfaces use, minus demotions (`author_resign` / `revoke_authorship`); see `reputation-algorithm.md` "Co-author Credit". Optionally tightening continuation admission itself to consented status remains a separate Phase 2 consideration.

#### Display construction (cumulative union)

The displayed `authors[]` is the **cumulative union** of `pevo.authors[]` entries across every admitted post in the paper's continuation chain (root + continuations + native edits). The claimed-set rule above (the append-only union of `pevo.authors[].hive`) is the *invariant*; this subsection is the *construction* that realizes it for display. Entries appear in **first-occurrence order** across the walked chain. Implemented by `buildCumulativeAuthorsForChain` in `backend/src/routes/papers.ts`.

**Drops are forbidden by construction — per-request scope.** Because the displayed list is a union over the chain rather than a projection of the head post's metadata, a later native-edit that removes a name from one post's `pevo.authors[]` cannot drop that name from the display: it still appears on the earlier post the union also reads. There is no reject-the-override / cover-check step; nothing to reject, because nothing is ever subtracted. **This invariant is scoped to a single read-time computation over the currently-resolvable chain.** It is NOT a claim of across-time permanence against walker truncation or HAF unavailability: a degraded or truncated forward walk yields a partial chain whose union is missing the truncated tail. That partial union is deliberately **not cached** and the surface falls back to its head-metadata projection, recomputed on the next request. The guarantee is "within one resolvable-chain computation, no admitted author is dropped," not "the union is durable across infrastructure flaps."

**Two never-merging tracks.** The union runs on two parallel tracks that are kept strictly separate:

- **Hive-keyed track.** Entries whose `hive` normalizes to a valid Hive account (lowercase + ASCII-space trim + `[a-z0-9.-]` charset, per `normalizeHiveAccount` in `backend/src/lib/author-supersession.ts`) dedup on the normalized hive. Per-hive sub-fields (`name`, `orcid`, `affiliation`) resolve by **most-recent self-claim wins** (the latest chain post the hive authored *about itself*), else **most-recent fallback claim wins** (the latest broadcaster's claim about that hive). A self-claim, once seen, outranks any non-self claim regardless of recency.
- **Hive-less display-credit track.** Entries with no normalizable `hive` (bridge-paper original-preprint authors, and any co-author credited without a Hive account) carry on a separate track keyed by a **composite key**: normalized `orcid` when present, else normalized `name` (`hivelessCompositeKey`). Most-recent occurrence wins the entry content; these are informational credits with no self-claim authority, so over/under-merge on the composite key is an accepted cosmetic outcome. An entry that normalizes neither a hive, an orcid, nor a name names no one and is skipped.

The two tracks **never auto-merge**. A Hive-less display credit is never linked to a Hive identity by fuzzy name or ORCID matching. The only path from Hive-less credit to a consented Hive identity is the explicit bridge-author-claim attestation flow (`backend-bridge-paper-author-claim-flow`); importer-side or read-time auto-mapping is forbidden (a dormant `author_accept` pre-broadcast under a colliding handle would otherwise activate retroactively — see "Bridge papers" below).

**`accredited_authors`** is the intersection of the **Hive-keyed** union with the currently-accredited account set. Hive-less entries have no account to be accredited and never enter this set.

**ORCID server-override + `orcid_claim_mismatch` audit (Hive-keyed track only).** For an accredited hive, the on-chain accreditation attestation is the authoritative ORCID; a broadcaster's chain-claimed ORCID about an accredited account is at most a second-best signal. The override has two arms, keyed on the account's accreditation state at read time:

- **Active accreditation.** The attested ORCID supersedes the displayed `orcid`. A divergent broadcaster claim emits an `orcid_claim_mismatch` audit event AND server-overrides the displayed value. An absent broadcaster claim prefills from the attestation. A matching claim passes through. When the accredited author has *no* on-chain ORCID attestation but a co-author's chain post claims one for them, the server **suppresses** the claim (`orcid` → `null`, the accredited user's silence is the authoritative "no ORCID" claim) and audits with `accreditedOrcid: null`.
- **Revoked accreditation.** The operator has retired the account's accreditation, so the server does NOT override the broadcaster's claim, but the audit still fires when the claim disagrees with the last-attested ORCID, carrying `accreditationStatus: 'revoked'` so triage can distinguish an active spoof from post-revocation residual.

The audit payload (a `logger.warn` structured event, deduped per-`(rootAuthor, rootPermlink, hive)` per request) is:

```
{ event: 'orcid_claim_mismatch', rootAuthor, rootPermlink, hive,
  claimedOrcid: string | null,      // raw broadcaster claim, for forensics
  accreditedOrcid: string | null,   // attested value (null on the suppress arm)
  accreditationStatus: 'active' | 'revoked',
  claimSource: string }             // which chain post carried the claim
```

The equality compare normalizes the chain claim with the same ASCII-C-whitespace stripper the SQL projection (`authorsWithSupersessionSelect` BTRIM) and the JS supersession helper (`computeSupersession`) use, so override/audit, `orcid_discrepancy`, and the list-vs-detail surfaces agree on the same payload. The display-layer `orcid_verified` / `orcid_discrepancy` fields are the read-side projection of this same rule; see [hive-schemas.md § 1.1 "ORCID supersession rule"](hive-schemas.md) and `api-contracts/papers.md`.

**Name-supersession (Hive-keyed track).** An accredited author's attested `researcher_name` supersedes the broadcaster-claimed `name`, **silently** — no discrepancy field, no audit event (unlike ORCID), because name variation (Rob/Robert, maiden names, transliterations, initials) is benign and high-noise. `name` is mandatory on every displayed author entry, resolved by the read-time fallback order **attested name → broadcaster `name` → hive handle → `orcid`**; an entry that resolves none of these names no one and is dropped. The canonical rule lives in [hive-schemas.md § 1.1](hive-schemas.md); the JS implementation is `resolveAuthorName` and the SQL mirror is the `name` arm of `authorsWithSupersessionSelect`.

**Cross-surface parity.** The same cumulative union is served on the detail, listing, and profile surfaces via the shared `resolveChainCumulativeAuthors` helper + a per-root Redis cache (`${appTag}:cache:chain-authors:<root-author>:<root-permlink>`, 30-minute TTL). The detail surface passes its already-resolved chain posts (write-through, warming listing/profile for free); listing/profile pass only the root pair and the helper walks the chain on a cache miss. **Single-link papers short-circuit**: a root-only paper has no cross-link union, so each surface's own supersession projection is authoritative (SQL `authorsWithSupersessionSelect` for listing/detail, JS `applyAuthorSupersession` for profile) and the helper returns `null` to signal "use your own projection." This keeps the multi-link cumulative shape (which normalizes the displayed `hive`) from leaking into single-link responses (which pass `hive` through raw). A degraded walk returns `null` and is not cached (see the per-request-scope note above).

#### Field mutation rules

When the chain head's metadata is overlaid on the displayed paper, fields are governed by:

| Field | Rule |
|---|---|
| `pevo.authors[]` | Consent-gated. Additions allowed (claimed-pending until accept). Removals only via the resigning author's own `author_resign` op. See "Authors mutation" below. |
| `ipfs_cid`, `document_hash`, `ipfs_filename` | Per-version. Each chain post carries its own; the head's wins for the default view, prior versions accessible via `?version=N`. All historical CIDs preserved on chain (Hive immutability) AND on community-operated pinners (see "Pinner constraint" below). |
| `title`, `body`, `abstract`, `citations`, `keywords`, `discipline`, `tags`, `language`, `supplementary_files`, `addresses_reviews` | Free-edit by any admitted continuation author (claimed-membership gate today; consented-gating in Phase 2). Risk accepted. Deterrents: on-chain audit (broadcaster-attributed), accreditation revocation, original-author re-edit power. |


Fields written exclusively by an admin attestation flow (`pevo.doi`, when PEvO acquires DOIs from external registrars) or by bridge import (`source.doi` on bridge papers) are not user-editable and are outside this trust model. The DOI-assignment flow itself is filed separately (not yet scoped); from this trust model's perspective, `pevo.doi` is system-managed read-only metadata.

`citations` is in the free-edit bucket because legitimate revisions regularly update the reference graph (responding to reviewer feedback, adding follow-up work, correcting errors). Treating it as consent-gated would require co-author co-signing on every citation change, which is heavier than the typical revision flow warrants. Mitigations: every edit is broadcaster-attributed on chain (a malicious edit lands under bob's account, not alice's), the original author retains re-edit power to overwrite head metadata, accreditation revocation deters persistent abuse, and the reputation algorithm can weight citations by cross-version stability so manipulation in a single version produces less reputation flow than consistent citations across the chain. Residual risk is accepted: a brief window where a malicious consented co-author has rewritten citations before re-edit + accreditation governance respond. The deterrent model is load-bearing here, not the gating model.

#### Authors mutation

`pevo.authors[]` is mutable but consent-gated:

- **Adding a new author.** Any admitted continuation author (claimed-membership today) writes the new author into their continuation post's `pevo.authors[]`. The new author becomes a *claimed* author immediately but is *not consented* until they complete a consent route (anchored slot → `author_accept`; name-only slot → `claim_authorship` + the author/admin's `approve_authorship`). The display layer surfaces consented status via a PEvO author badge plus profile link on the name; claimed-but-not-consented names display as plain text without the badge. There is no separate "pending" UI tier; consented-status presence or absence is the only display distinction.
- **Removing an author.** No author's continuation can remove another. A consented author withdraws their own credit by broadcasting `author_resign` (anchored route) or self-`revoke_authorship` (name-only route). As a **backstop**, the paper author or admin may `revoke` a consented co-author — the remedy for a bad self-accept (a compromised or malicious co-author who injected a name via a continuation and then self-accepted); the consented-set computation reads the latest consent/demotion op per (author, paper) pair, and the revoke demotes them going forward. Revoke is a remedy, never a consent gate. Pre-demotion continuations remain in the chain history. **Native-editing a chain post to drop a name from `pevo.authors[]` is NOT a removal.** Authors who have contributed to a paper cannot be erased from the claimed set by metadata edits; the claimed set is the historical union of every operation's `pevo.authors[].hive`.
- **Authorship disputes** (alice wants bob removed, bob refuses). Out of scope for the metadata layer. Disputes are handled via the author/admin `revoke` backstop, accreditation governance (revoke bob's accreditation, which removes consented status across all his papers), or paper retraction (republish as a new paper without bob, citing the original).

The cumulative-union construction (see "Display construction" above) enforces the additive rule structurally: the displayed `authors[]` is the union of every admitted chain post's `pevo.authors[]`, so a head post that omits a name present on an earlier post does not drop it — there is no superset cover-check and no reject-the-override step, because nothing is ever subtracted. (This supersedes the earlier no-shrink / `headAuthorsCoverRoot` cover-check model, which rejected a head override when it failed to cover the root's author set.) Removal of a consented author from the *consented* set happens via that author's own `author_resign` / self-`revoke_authorship`, or the author/admin `revoke` backstop, computed at read time from the chain's `custom_json` history; the claimed-set display entry persists regardless, demoted to claimed-but-unconsented.

#### Light-account signing of consent ops

Light-account users (server-encrypted posting keys; see "Account Creation" in `CLAUDE.md`) can broadcast `author_accept` and `author_resign` via the custody endpoint. Because these ops are infrequent and reputationally weighty (the broadcast event is permanently attributed on chain, even though the functional consented state is reversible by a later inverse op), the backend MUST require a per-op fresh authentication challenge appropriate to the user's auth mechanism: a password re-prompt for password-based accounts, a fresh ORCID OAuth round-trip for ORCID-authed accounts, or the analogous fresh-auth for any future auth mechanism. After the fresh-auth succeeds, the backend signs and broadcasts. The same per-op fresh-auth requirement applies to the name-only route's equally reputation-weighty `claim_authorship` / `approve_authorship` / `revoke_authorship` ops; see § 6.4.

The fresh-auth challenge mints a single-use proof bound to the JWT subject AND to the specific `(action, root_author, root_permlink)` consent target. The two issuance endpoints are documented in `agents/docs/api-contracts/`:
- `POST /api/custody/fresh-auth` — password-path issuance (see [custody.md](api-contracts/custody.md)).
- `POST /api/orcid/start { mode: "fresh_auth" }` followed by `POST /api/orcid/callback` — ORCID-path issuance via a fresh OAuth round-trip (see [orcid.md](api-contracts/orcid.md)).

Both paths produce a proof that is consumed atomically before the broadcast attempt at `POST /api/custody/broadcast`. A proof issued for one target cannot be replayed against another (cross-paper or cross-action substitution is rejected at consume with `details.reason: "target_mismatch"` → 403 `FRESH_AUTH_REQUIRED`).

The backend MUST audit-log every consent op it signs on behalf of a user. The `custody_audit_log` table carries the standard custody columns (`username`, `op_type`, `tx_id`, `block_num`, `created_at`) plus four consent-op-specific columns populated only when fresh-auth was required: `auth_mechanism` (`'password' | 'orcid'`), `fresh_auth_outcome` (the consume result, including the closed enum of rejection reasons), `session_id`, and `user_agent`. Operators investigating consent-op activity for a user query the table by `username` and `op_type IN ('author_accept', 'author_resign')`; the four extra columns provide the auth-mechanism + session correlation needed for abuse triage. The `user_agent` column is annotated as PII per GDPR/CNPD; the user's "delete my account" path (the `DELETE /api/settings/email` handler) MUST anonymize rather than delete these rows. In the same transaction that removes the `accounts` row, it runs `UPDATE custody_audit_log SET username = NULL, user_agent = NULL, session_id = NULL WHERE username = $1`, severing the username link and erasing the PII-derived columns while preserving the forensic columns (`operation_type`, `tx_id`, `block_num`, `created_at`, `auth_mechanism`, `fresh_auth_outcome`) so an operator can still see that an event occurred for a now-anonymized user. The retained `tx_id`/`block_num` are references to public Hive transactions the user themselves signed; they are inherently public on-chain data, so erasure here covers the username link and the PII-derived columns, not the public-ledger operation. Anonymize-on-delete (rather than the prior same-transaction `DELETE`) keeps the forensic trail across the right-to-erasure path so a triggered `email_deleted` can no longer wipe a user's entire audit history in one call. This matches the anonymize behavior noted in § 6.3.

Self-custody users sign these ops with their own key via Hive Keychain and bypass the custody endpoint entirely; the fresh-auth requirement is a custody-endpoint guard, not a chain-layer rule.

#### Consented-set computation (Phase 2 constraints)

The consented-set is computed at read time from on-chain state. The implementation shape (CTE in chain-walk SQL, separate query, materialized view, or other) is a Phase 2 decision, but the spec commits to the following constraints:

- **At most one-block-stale state.** A consent op (`author_accept`, `author_resign`, `claim_authorship`, `approve_authorship`, or `revoke_authorship`) broadcast at block N MUST be reflected in the consented-set computation by block N+1.
- **O(1) HAF queries per paper-detail request.** The consented-set lookup runs once per request, not per chain hop. Implementations that fire one query per continuation post are out of bounds.
- **Cache invalidation on every consent op.** Cache invalidation hooks MUST fire on every `custom_json` op with `id = APP_TAG` and `action` in `{author_accept, author_resign, claim_authorship, approve_authorship, revoke_authorship}` that cites a paper, in addition to the existing comment-op invalidation hooks.
- **Cache keys include the version dimension.** Cached consented-set state MUST be invalidated for both `paper-detail:{author}:{permlink}` and `paper-detail:{author}:{permlink}:v{N}` on every consent op for that paper, since consented-set affects both default-view and per-version-view.

The consented layer's HAF reads fail closed (live). When `getPool()` returns null or the consent query throws, paper-detail and `/api/me/authorships/pending` MUST return a retriable 503 (`SERVICE_UNAVAILABLE`, `{retriable: true}`) rather than degrade to a root-only consented-set. Degrading would silently demote legitimate co-authors below the cumulative-union claimed-set baseline AND open an attacker-attractive bypass window during HAF flaps; "chain is SSoT" is binding here. The integration site MUST short-circuit the consent fetch when the consent flow is inert (single-author claimed-set or bridge papers per the "Bridge papers" subsection) so the fail-closed surface is bounded to genuinely multi-author papers. The `fetchConsentOpsForPaper` helper MUST distinguish "no ops" from "HAF unavailable" via its return type so the integration site applies the policy explicitly. Operators see the outage as HTTP 503s plus a per-request structured pino log marking the fail-closed event. This posture matches the existing HAF-required reads at `verifyOrcidBinding` (`backend/src/routes/orcid.ts:1502-1506`, "Fail closed when HAF is unavailable: returning null would silently bypass...") and the chain-walk SQL in `resolveContinuationChain`, which is HAF-required by construction.

#### Compromised-key recovery

Posting-key compromise (phishing, malware, sold account, light-account master-key incident) admits a finite, bounded attack window. An attacker with a consented co-author's posting key can broadcast `author_resign` for that author plus a continuation adding a new claimed-pending author; the new author can then broadcast `author_accept` under their own key. The legitimate co-author becomes unconsented until they:

1. Rotate their posting key via Hive's native `account_update` op (Hive consensus rejects further ops signed by the old key from that block onward).
2. Broadcast a new `author_accept` for the affected paper to restore consented status going forward.
3. File for the author/admin `revoke` backstop against the attacker-introduced author, and/or an accreditation-governance ticket (accreditation revocation removes the attacker's consented status across all their papers).

Pre-rotation damage is permanent on chain (the spurious resign and the attacker's continuation cannot be unmade), but reputation flow and citation credit are restored on re-accept. This residual risk is accepted; raising the resign auth level to active-key would lock light-account users out of the custody-endpoint resign path without preventing the co-pollute arm of the attack.

#### Bridge papers

Bridge papers are immutable post-publish. The bridge writer publishes the canonical mirror of an external preprint (arxiv, crossref, etc.) once and never updates it; the upstream source does not change once cited, so there is no edit, sync, or update flow for bridge papers. The implementation cleanup of the dead update surfaces is filed as `backend-retire-bridge-update-route.md` (backend route removal) and `ui-retire-bridge-sync-affordance.md` (UI affordance removal); both can land independently.

The bridge account is the sole consented author. `pevo.authors[]` entries with `hive: null` are display-only credits referencing original-preprint authors who lack Hive identity. The consent-gated authorship flow does not apply.

The `extractAuthorizedContinuationAuthors` helper (`backend/src/helpers.ts`) special-cases `bridge_paper` type to return `{config.hiveBridgeAccount}` as the sole authorized continuator. Under the immutability policy this carve-out is inert — bridge papers do not have continuations — and is retained only as defense-in-depth: if the policy is ever revisited and bridge updates are revived, the carve-out becomes load-bearing. Until then, the canonical rule is the immutability statement above, not the helper's continuator admission.

If/when an original-preprint author joins Hive and wants to claim authorship of an imported bridge paper, the off-chain verification flow plus on-chain attestation (likely issued by the bridge service) is filed as a separate task (`backend-bridge-paper-author-claim-flow`) for scoping when triggered. Out of scope for this section.

Until that claim flow ships, the bridge importer MUST keep `pevo.authors[].hive` as `null` for all non-bridge entries on bridge papers; populating Hive handles via fuzzy ORCID-to-Hive lookup or any other auto-mapping is forbidden, because a dormant `author_accept` op pre-broadcast under a colliding handle would otherwise activate retroactively when the importer assigned the handle to a bridge paper. Authorship binding for bridge papers happens through the explicit attestation path, not through importer-side metadata writes.

#### Rollout

No flag-day cutover and nothing to grandfather: no production papers use these consent ops yet, so the consented model is the go-forward definition, not a migration of existing state. The consent-gated credit computation is **live**: the reputation cycle credits the Routes 1/2/3 consented union (`computeReputationBatch`, tracked in `reputation-algorithm.md` "Co-author Credit"). Single-author papers are unaffected — the root broadcaster is implicitly consented.

Shipping the consent UX has one remaining surface: the backend `GET /api/me/authorships/pending` discovery endpoint is **live** (`backend-consented-set-read-surfaces`, archived; contract in `api-contracts/me.md`); the UI surface for paper-detail accept / claim / approve / resign affordances (`ui-multi-author-consent-affordances`) is still pending. Until that UI ships, co-authors have no in-platform discovery path for slots awaiting their consent.

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

The `accredit` op is **re-broadcastable**, and an account may accumulate several over time: the first establishes accreditation, later ones carry edited profile metadata (`name`/`institution`/`field`) or re-grant after a sanction. Two different ops are authoritative for two different purposes — **profile metadata** (`name`/`institution`/`field`/`method`) reads from the account's **latest** `accredit` op so edits take effect, while **tenure** ("accredited since") reads from the account's **earliest** `accredit` op so edits and re-grants never reset standing (see "Accreditation Lifecycle & Sanctions" below). `name`/`institution`/`field` are always user-supplied free text: the authority attests that the account is a verified researcher, not that these strings are correct, so editing them does not change what the attestation means.

### Revocation (custom_json)

A `revoke` is a **sanction** — a deliberate authority action against a bad actor. It is NOT the mechanism for ordinary loss of standing: a WoT member falling below the vouch threshold is handled by live membership evaluation, with no `revoke` op (see "Accreditation Lifecycle & Sanctions").

```
id: "pevo"
required_auths: []
required_posting_auths: ["pevo.admin"]
json: {
  action: "revoke",
  account: "<hive_username>",
  type: "sanction",
  reason: "...",
  timestamp: "<ISO 8601>"
}
```

A sanction is **sticky**: while an account has an un-lifted sanction it is not accredited regardless of vouch support, and the WoT auto-accreditation path MUST refuse it (vouches cannot re-admit a sanctioned account). Only a later authority `accredit` op lifts the sanction; on lift, the account's full pre-sanction history counts (tenure still reads from the earliest `accredit` op).

**Legacy revokes.** Every `revoke` broadcast before this model carries `reason: "WoT threshold no longer met"` and no `type` field; these are historical WoT threshold-drops, NOT sanctions. Membership evaluation MUST treat any `revoke` lacking `type: "sanction"` as a non-sanction and ignore it for stickiness — such an account's status is determined by its live WoT standing and authority `accredit` ops alone.

### Author Accept (custom_json)

Broadcast by a claimed author to register consented status for a specific paper — the anchored-slot route (route 2 in "Consented vs claimed authorship"). See section 2 "Multi-Author Trust Model" for the semantics; this is the wire format. The name-only route's `claim_authorship` / `approve_authorship` / `revoke_authorship` wire formats are in `hive-schemas.md` § 2.9–2.11.

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
- The chain signer MUST be eligible for a slot on this paper by EITHER anchor: (a) a slot's `hive` equals the signer (the signer appears in the claimed authors set — the historical union of `pevo.authors[].hive` across all operations on admitted chain posts), OR (b) a slot's `orcid` equals the signer's authority-attested ORCID (so the original author need not know the signer's Hive handle). See "Consented vs claimed authorship" above.
- The accept op's `block_num` MUST be strictly greater than the `block_num` of the earliest admitted chain post operation that named the signer's slot (by `hive` equal to the signer, or by `orcid` equal to the signer's attested ORCID). This prevents name-squatting: an op pre-broadcast before the slot existed cannot be retroactively activated by a later collision-listing.

Latest valid op wins per `(accepting_author, paper)` pair, ordered by `(block_num, id)` (highest wins). The HAF view `hafsql.operation_custom_json_view` exposes `id` as the canonical same-block tie-break primitive (the view does not project `trx_in_block`; `id` is a bigint encoding `block_num + trx_in_block + op_in_trx`, so ordering by `id` within a fixed `block_num` is equivalent to ordering by `trx_in_block`).

### Author Resign (custom_json)

Broadcast by a consented author to relinquish authorship of a paper.

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

Effect: the resigning author is removed from the consented set for this paper going forward. Pre-resign continuations they broadcast remain in the chain history; their ability to broadcast new admitted continuations is revoked. The resigning author REMAINS in the claimed authors set (resignation withdraws consented status, not historical contribution; `pevo.authors[]` history is append-only per "Consented vs claimed authorship"). Re-acceptance after resign is allowed: a later valid `author_accept` overrides per `(block_num, id)` ordering when querying `hafsql.operation_custom_json_view`.

### Accreditation Authority Whitelist

When reading accreditation and revocation `custom_json` ops from the chain, the backend **must filter by sender**. Only transactions where `required_posting_auths` contains a whitelisted account are accepted. This prevents anyone from broadcasting a fake accreditation under the app's `custom_id`.

The whitelist is: `[HIVE_ADMIN_ACCOUNT, ...ACCREDITATION_AUTHORITIES]`. The admin account is always implicitly included.

**HAF SQL:** The `hafsql.operation_custom_json_view` has a `required_posting_auths` column (jsonb array of account names). Filter with:
```sql
AND cj.required_posting_auths ?| $N::text[]
```
where `$N` is the whitelist array. The `?|` operator checks if the jsonb array contains any of the given text values.

**WoT vouches** are not filtered by `?|` on posting authorities. Instead, vouches are validated by joining on `active_accreditations`, so only currently accredited users' vouches count.

### Accreditation Lifecycle & Sanctions

Accreditation status is an on-chain dimension **orthogonal to the § 6.1 `accounts`-table state machine**: it is computed from authority-signed `accredit`/`revoke` `custom_json` ops plus the live WoT vouch graph, applies to every account (including no-row pure-self-custody users), and adds no column to the `accounts` table. Reviewers must not conflate it with the § 6.1 `(verify_token, …, upgraded_at)` dimensions.

**Accreditation sources (the `method` field).** `email`, `orcid`, `manual` are **authority-pinned** — a deliberate platform attestation. `wot` is **vouch-derived** — granted when an account crosses the vouch threshold. All four are admin-signed `accredit` ops; they differ only by `method`.

**Membership rule.** An account is **accredited** iff it is **not sanctioned** AND either:
- its latest `accredit` op is authority-pinned (`method ∈ {email, orcid, manual}`), OR
- its latest `accredit` op is `method = wot` AND it **currently** meets the vouch threshold (evaluated against the live `active_vouches` graph).

**WoT standing is live, not pinned.** A WoT member that falls below the vouch threshold loses standing immediately, with **no `revoke` op** — losing vouch support is ordinary, not a sanction. Recovering vouches restores standing automatically (self-healing). This is the chosen representation; an implementer may fall back to a neutral "demote" op if live evaluation proves too costly on HAF, but the *semantics* above (non-sanction, self-healing) are fixed. This reverses the earlier op-pinned, non-self-healing behavior in which a threshold-drop broadcast a `revoke`; see "Legacy revokes" under § 2 Revocation.

**Sanctions are sticky.** A `revoke` with `type: "sanction"` suppresses accreditation regardless of vouch support, and the WoT auto-accreditation path MUST refuse any account with an un-lifted sanction (vouches cannot re-admit a sanctioned account). Only a later authority `accredit` op lifts a sanction. Issuing a sanction is an **authorized-admin action** (the admin-set that may sign authority ops is administered separately from these semantics).

**Editable profile metadata.** `name`/`institution`/`field` are user-editable after accreditation by re-broadcasting an admin-signed `accredit` op carrying the new values (user-initiated through the edit endpoint; the broadcast is admin-signed, so neither light nor self-custody users sign the op — they only re-auth the request per § 6.4). The account's **latest** `accredit` op is authoritative for metadata, so edits take effect. ORCID-accredited accounts (whose `institution`/`field` are empty at grant) use the same path to set them for the first time. This replaces the former "metadata is one-shot" code invariant.

**Tenure anchor ("accredited since").** Tenure reads from the account's **earliest** `accredit` op — all history, across sanction gaps — so a metadata edit or a post-sanction re-grant never resets standing. The anchor is the earliest op's **chain block time**, not the payload `timestamp` (which a re-broadcast rewrites). Reputation **scoring** is present-tense membership (a flat `accreditation` bonus) plus content-age decay and does not key off accreditation date at all, so edits and re-grants do not move scores; only the displayed "accredited since" uses the anchor.

**Lifecycle states** (on-chain, per account):

| State | Condition | Accredited? |
|---|---|---|
| Unaccredited | No authority `accredit` op | No |
| Accredited (authority) | Latest accredit `method ∈ {email,orcid,manual}`, not sanctioned | Yes |
| Accredited (WoT) | Latest accredit `method = wot`, live vouch threshold met, not sanctioned | Yes (while threshold met) |
| Below-threshold (WoT) | Latest accredit `method = wot`, live vouch threshold **not** met, not sanctioned | No (self-heals if vouches return) |
| Sanctioned | Un-lifted `type: "sanction"` revoke | No (only an authority `accredit` lifts) |

Wire formats: § 2 "Accreditation" / "Revocation". Reputation interaction: § 3.

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

Reputation is computed in batch cycles defaulting to 28,800 blocks (~1 day at 3s/block). This is the `cycle_blocks` parameter in `ReputationWeights`, configurable via on-chain `update_weights` custom_json. Each cycle is a single pass using the prior cycle's scores as voter weights (no convergence iterations). The batch job checks for new cycles hourly. Scores are stored in Redis under the app-tag prefix (`${APP_TAG}:reputation:batch:{username}`, JSON-encoded `{score, breakdown}`; the last completed cycle number lives at `${APP_TAG}:reputation:cycle:last`). On-demand queries read voter weights from the latest batch; if no batch exists (fresh system), all voters weight at 1.0. Readers parse defensively and surface a zero score on parse failure; they do not recompute at head block (the batch is the single source of truth for displayed reputation).

Each PEvO instance runs its own Redis, and every key is namespaced by `APP_TAG` (`${config.appTag}:`) per the project-wide Redis-key convention. See `reputation-algorithm.md` for the canonical batch-key spec.

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

Six dimensions of the `accounts` row affect auth and state transitions: `verify_token`, `username`, `password_hash`, `orcid`, `custody`, `upgraded_at`. Orthogonal overlays (`reset_token`, `pending_email_*`, `sessions_invalidated_at`, `updated_at`) are transient flags layered on top of these states, not states themselves. `updated_at` is a recency marker (bumped at every `/confirm`+`/link` finalize UPDATE): it is the staleness signal the stuck-recovery lookups conjoin with the crypto ownership proof so the Option C resume path admits only genuinely-mid-crash rows, not every steady-state finalized row (see § 6.3's Option C note). A defense reading `updated_at` is therefore reviewable against this overlay, not an unenumerated state dimension.

| State | verify_token | username | password_hash | orcid | custody | upgraded_at | Reached by |
|---|---|---|---|---|---|---|---|
| A | NULL | SET | SET | NULL | `'light'` | NULL | Email signup, no ORCID linked |
| B | NULL | SET | SET | SET | `'light'` | NULL | A with ORCID linked, or combined email+ORCID signup |
| C | NULL | SET | NULL | SET | `'light'` | NULL | ORCID-only signup, or A/B after `/recover` with `orcid_token` and no `new_password` |
| D | NULL | SET | (preserved from A/B/C) or NULL (signup-verify(self) path) | (preserved) or NULL (signup-verify(self) path) | `'self'` | SET | A/B/C after `/api/custody/upgrade`, OR a fresh F → D via `POST /api/auth/link` (signup-verify(self), self-custody-linking finalization for a Hive account the user already controls) |
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
  [no row] ──signup(...)──> E or F ──signup-verify(self)──> D   (POST /api/auth/link, fresh self-custody finalization linking to a Hive account the user already controls; password_hash and orcid stay NULL on this path, distinguishing it from the A/B/C → D upgrade flow which preserves those fields)
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

Account deletion / right-to-erasure (requires fresh-auth proof per § 6.4):
  A/B/C/D ──settings/email DELETE(fresh-auth proof)──> [no row]
```

**Signup finalization (F → A/B/C) requires the session-binding cookie, not the `auth_token` alone.** The `signup-verify(light)` transitions via `POST /api/auth/confirm` (light path) and `POST /api/auth/link` (self-custody link path) require the httpOnly `pevo_signup_session` binding cookie in addition to the `auth_token`. The `auth_token` is the row-lookup credential — it identifies the state-F row by `verify_token` — not the authorization proof; the binding cookie (minted by `POST /api/auth/verify`, `POST /api/auth/resume-signup`, and the ORCID-direct `POST /api/auth/signup` branch, stored as `signup_binding_hash` on the row) proves the finalizing browser is the one that initiated the signup. This closes the auth_token-as-bearer-capability replay vector: a token leaked via mailbox, referer, or logs could otherwise finalize the account with attacker-controlled keys. Stuck-account recovery (Option C) bypasses the binding only on a real key/signature proof — `/confirm` requires `posting_private`, `/link` requires a fresh Hive signature (a replayable Bearer JWT does not satisfy it, per § 6.5 invariant #1). See `api-contracts/auth.md` for the cookie attributes and the login `PENDING_SIGNUP` 409 contract.

Account deletion erases the `accounts` row entirely; the user returns to the **no-row case**. It is a one-way exit, not a transition between steady states. The on-chain Hive account is untouched — a light user who still holds their BIP39 seed phrase can re-import it into Hive Keychain and continue as pure self-custody (the no-row case). The user-facing deletion flow must make both facts clear: all PEvO-server data is erased, and the Hive account survives via the seed phrase.

Pure self-custody (no-row) users never enter this state machine; their identity is on-chain only.

The `recover(seed_phrase, …)` transitions above are **two-phase**: phase 1 (`POST /api/auth/recover`) only stages the change and the account stays in its current state; the transition lands at phase 2 (`POST /api/auth/recover/verify`) once the new email proves control (or never, if the staged swap is disputed or expires). The `recover(orcid, …)` transitions apply in one step. See § 6.4 for the per-path re-auth contract.

### 6.4 Critical-Action / Re-Auth Contract

Every critical action requires a fresh re-auth proof; the JWT alone is never sufficient. The required proof factor is determined by **what kind of control the action transfers or uses**, not by what auth factors the account happens to have. Per-state availability captures intent; current code may diverge — divergences are tracked as separate tasks, not inline here.

| Action | Endpoint | Required re-auth (intended) | Per-state availability |
|---|---|---|---|
| Server-side broadcast (non-consent ops) | `POST /api/custody/broadcast` | Fresh-auth proof matching a factor registered on the account | A: password proof. B: password OR ORCID proof. C: ORCID proof. D: blocked (encrypted keys nulled at upgrade). no-row: n/a (Keychain). |
| Server-side broadcast (consent ops: `author_accept`, `author_resign`) | `POST /api/custody/broadcast` | Per-target fresh-auth proof (target binds `op_type` + `paper_author` + `paper_permlink`) | Same as non-consent. Implemented at `custody.ts` (`findGatedOpsInBundle`). |
| Server-side broadcast (name-only-route credit ops: `claim_authorship`, `approve_authorship`, `revoke_authorship`) | `POST /api/custody/broadcast` | Per-target fresh-auth proof. The target binds `op_type` + `paper_author` + `paper_permlink` plus the fields that identify the specific grant: `claim_authorship` binds `author_index` (the slot; the claimer is the signer); `approve_authorship` binds `author_index` + `claimer` (the subject bound to the slot); `revoke_authorship` binds `claimer` only (it carries no `author_index` on the wire, see `hive-schemas.md` § 2.11). Binding `claimer` is what stops a minted approve/revoke proof from being redirected to strip or credit a different co-author. | Same as non-consent. Gate live at `custody.ts` (`findGatedOpsInBundle`). |
| Issue fresh-auth proof (password) | `POST /api/custody/fresh-auth` | Current password | A or B (states with password registered) |
| Issue fresh-auth proof (ORCID) | `POST /api/orcid/callback mode='fresh_auth'` | Fresh ORCID OAuth round-trip | B or C (states with ORCID registered) |
| Issue IPFS upload token (binds a file to the auth envelope before pinning) | `POST /api/ipfs/upload-token` | Signature path: the per-request Hive signature body-hashes the declared file descriptor (`{file_sha256, mimetype, size}`) into the signed envelope. JWT path: a single-use **per-action `ipfs_upload`-targeted** fresh-auth proof (`fresh_auth_proof` in body, target bound to `(ipfs_upload, <username>, '')`), so a stolen JWT alone cannot mint a token and a target-less session proof minted for a vote or comment cannot be redirected here. The subsequent `POST /api/ipfs/upload` carries the returned token in `X-Upload-Token` and is rejected unless `sha256(file)` matches the declared hash. | All accredited accounts (light A/B/C/D and self-custody/Keychain). Implemented at `ipfs.ts` (`/upload-token`). The JWT-path proof is minted via password (`POST /api/custody/fresh-auth action='ipfs_upload'`) or ORCID (`POST /api/orcid/start mode='fresh_auth' action='ipfs_upload'`); the consume returns 403 on a binding violation (username/target/kind mismatch) and 401 on a missing/expired/malformed proof, mirroring the consent-op consume. **SPA carve-out:** the web client mints the JWT-path proof via the password endpoint only, so inline upload is offered to states with a registered password (A, B). Passwordless ORCID-only state C is blocked client-side with a "set a password" prompt rather than the ORCID round-trip, because a selected `File` cannot survive the full-page ORCID OAuth redirect. The backend still accepts an ORCID-minted `ipfs_upload` proof; the restriction is the SPA's, not the route's. |
| Light → self upgrade | `POST /api/custody/upgrade` | Seed-phrase-derived pubkey (UI derives from BIP39 client-side; backend verifies pubkey matches on-chain `getAccounts` posting/active key) | All light states (A, B, C). D: 409. Pure self-custody: n/a. |
| Set password from null | `POST /api/settings/set-password` | Fresh ORCID OAuth proof (null-hash accounts have ORCID as their only registered factor) | C only. A and B return 409 (`PASSWORD_ALREADY_SET`). |
| Recover (lost email access, seed-phrase path) | `POST /api/auth/recover` (phase 1) + `POST /api/auth/recover/verify` (phase 2) | Seed-phrase derived memo key **AND** control of the new email. Phase 1 verifies the memo key and stages the swap; phase 2 applies it only after a token mailed to the new email is presented back. The old email receives a 48h dispute link that voids the staged swap. The memo-key proof alone no longer mutates the account — the email-control sub-proof is required on top. | All light states (A, B, C). Seed phrase works from any light state (every light signup produces one). |
| Recover (lost email access, ORCID path) | `POST /api/auth/recover` | Fresh ORCID OAuth round-trip matching the account's registered ORCID. Applies immediately and in one step — the OAuth round-trip is itself the email-side control proof the memo-key path lacks. Severed once `upgraded_at` is set (state D returns 401, generic message, to avoid an upgrade-state oracle). | B and C (states with `orcid IS NOT NULL`). |
| Reset (forgot password) | `POST /api/auth/reset-request` + `POST /api/auth/reset` | Email-link token | A and B (states with email AND password). C: not applicable. |
| Change email | `POST /api/settings/email` (change-email branch on existing row) | Fresh-auth proof matching a factor registered on the account. JWT path requires the proof in the body; Keychain (Hive-signature) path is fresh-proof at the middleware and requires no body proof. Add-flow no-row branch is JWT-unreachable and remains Keychain-only. | A: password proof. B: password OR ORCID proof. C: ORCID proof. D: matches preserved factors (password and/or orcid columns). Implemented at `settings.ts` POST /email (commit `b27bcdf`, audit closed by `backend-settings-email-reauth-audit` 2026-05-16). |
| Delete account data / right-to-erasure (erases the entire `accounts` row plus `notification_preferences` + `pending_recovery`, and anonymizes `custody_audit_log` — not just the email column) | `DELETE /api/settings/email` | Fresh-auth proof matching a factor registered on the account. JWT path requires the proof in the body; Keychain (Hive-signature) path is fresh-proof at the middleware and requires no body proof. | A: password proof. B: password OR ORCID proof. C: ORCID proof. D: matches preserved factors (password and/or orcid columns). no-row: n/a (no `accounts` row to delete; handler 401s). Implemented at `settings.ts` DELETE /email (commit `6dd1f8b5`): the JWT path requires the `delete_account` fresh-auth body proof, the Keychain (Hive-signature) path is fresh at the middleware. |
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
8. **Bearer JWTs must carry a numeric `iat`.** The session-invalidation revocation check (§ 6.7) rides entirely on `iat`; a bearer token with an absent or non-numeric `iat` is rejected 401 rather than skipping the lookup, so revocation completeness does not depend on the unenforced "every server mint sets `iat`" cross-file invariant.

### 6.6 Maintenance

When any of the following change, this section is updated in the same commit as the code change:
- New routes that write `verify_token`, `username`, `password_hash`, `orcid`, `custody`, or `upgraded_at`.
- New auth factors (a hypothetical hardware-key or WebAuthn factor would add columns and states).
- New critical actions (anything that broadcasts, mutates an auth factor, or transfers control).
- New transitions, even between existing states.

The section is referenced from root `CLAUDE.md` "Code Review Findings" guidance: reviewers must consult § 6.1 to verify any defended account state is actually reachable.

### 6.7 Session-Invalidation (JWT Revocation) Overlay

`sessions_invalidated_at` is the bearer-JWT revocation mechanism for light accounts. A password reset (`POST /api/auth/reset`), seed-phrase recovery (`POST /api/auth/recover/verify`), and ORCID recovery (`POST /api/auth/recover`) all stamp it. On every authenticated route, the JWT path in `verifyHiveSignature` revokes any bearer token whose `iat` is at or before the invalidation second, EXCEPT the token reissued by that very event.

- **Survivor identity, not timestamp.** Second-granular `iat` cannot distinguish a pre-reset token from the fresh token minted in the same integer second by the reset itself. The reissue sites in `routes/recover.ts` therefore write `sessions_invalidated_at` from a Node `Date` and embed that exact epoch-ms in the reissued token's `reissuedAt` claim; the middleware spares the one token whose `reissuedAt` equals the stored epoch-ms (the revoke predicate is `iat <= invalidatedSec && reissuedAt !== invalidatedMs`). A pre-reset token sharing the same second is revoked; the legitimate reissued one survives. `reissuedAt` is an internal opaque-token claim — clients never read or set it, so it is not part of the api-contract surface.
- **Round-trip invariant (do not break).** The identity match requires `reissuedAt` (epoch-ms embedded at mint) to equal `sessions_invalidated_at.getTime()` read back from Postgres. This holds because the column is `TIMESTAMPTZ` and the value is written from a millisecond-precision Node `Date`, so the write-then-read round-trip preserves `getTime()` exactly. Switching either reissue writer back to SQL `NOW()` (microsecond precision) or rounding to seconds would silently break same-second survival and log every user out immediately after a reset. Keep the writer a Node `Date`.
- **`iat`-required** (§ 6.5 invariant #8). A bearer JWT with an absent or non-numeric `iat` is rejected 401 rather than skipping the lookup.
- **Known self-healing edge.** `POST /api/auth/reset` stamps `sessions_invalidated_at` but mints no token (the user logs in afterward via `POST /api/auth/login`, whose token carries no `reissuedAt`). A relogin completed within the same integer second as the reset is revoked on its first request (no matching `reissuedAt`) and the user logs in once more; the next login lands in a later second and survives. Accepted residual: the window is sub-second, the failure self-heals on the next login, and it affects only the email-reset path. The `reissuedAt` identity covers the recovery routes, which both stamp and reissue in one handler.

Client-visible effect: `verifyHiveSignature` emits `401 SESSION_INVALIDATED` (see `api-contracts/common.md`) on any authenticated route when the bearer token is revoked; the SPA treats it as session expiry and redirects to login.

## 7. Admin Roles & Authority Attribution

PEvO's authority operations (`accredit`, `revoke`, `retract_paper`, `approve_authorship`, `revoke_authorship`, `update_weights`) are all signed on-chain by a **single** key — the `pevo.admin` posting key via `broadcastAdminCustomJson` (`backend/src/hive.ts`). This section adds a human-authorization layer **in front of** that one key and an attribution field **inside** every op's payload. It does not widen the signer.

### The model: one signer, a roster in front of it

Two distinct concepts, often confused — keep them apart:

- **`accreditationAuthorities`** (`config.ts`) is the **on-chain signer whitelist**: `[HIVE_ADMIN_ACCOUNT, ...ACCREDITATION_AUTHORITIES]`, used at **read time** to filter which `custom_json` senders' authority ops the backend trusts (see § 2 "Accreditation Authority Whitelist"). In practice this is `pevo.admin` alone. It stays singular — the "admin is singular by design" decision refers to **this signer**, and it is PRESERVED. The backend never signs authority ops with any key other than `config.pevoAdminPostingKey`.
- **`admins`** (new, this section) is a **human-authorization roster recorded on-chain** (via `admin_grant`/`admin_revoke` ops) and enforced by the backend: the set of Hive accounts a human operator has empowered to *trigger* authority ops. A roster entry confers no signing key — the admin never signs an authority op; `pevo.admin` does, after the backend gate passes. The roster is derived **live from the chain** (see "Roster derivation" below), not stored in an app database.

So `accreditationAuthorities` answers "whose on-chain signature does a reader trust?" (still: `pevo.admin`). `admins` answers "which human may ask the backend to make `pevo.admin` sign?" These are orthogonal axes; widening the roster does not widen the signer.

### `issued_by` attribution on every authority op

Every authority-op payload gains an `issued_by: <hive_account>` field naming the human who triggered it. The op surface and its `issued_by` semantics:

| Op | Site (stable symbol) | `issued_by` |
|---|---|---|
| `accredit` | `routes/accreditation.ts`, `routes/orcid.ts` (×2), `routes/signup-verify.ts`, `wot.ts` `broadcastWotAccreditation` | acting admin; **`"wot"`** for auto-grants (see below) |
| `revoke` (sanction) | `wot.ts` `buildRevocationPayload` / `revokeVoucheeIfBelowThreshold` / `cascadeRevocation` | acting admin |
| `retract_paper` | `routes/papers.ts` | acting admin |
| `approve_authorship` / `revoke_authorship` | `routes/claims.ts` | acting admin |
| `admin_grant` / `admin_revoke` | roster-management endpoint (new) | acting super-admin or root |
| `update_weights` | `types/hive.ts` `UpdateWeightsAction` | root |

**WoT auto-grant marker.** The Web-of-Trust auto-accreditation path (`broadcastWotAccreditation`) and the live-threshold/self-healing machinery have no human trigger. Their ops carry a **system marker** `issued_by: "wot"`, not a person. A reader distinguishes operator-driven attestations from graph-derived ones by this marker.

**`issued_by` is a server-attributed claim, not a cryptographic proof.** The op is still signed by `pevo.admin`; `issued_by` is the backend's record of which roster member's authenticated request caused the broadcast. It exists for **transparency and audit** (on-chain history of *who* triggered each authority action), and its trustworthiness reduces to trusting the operator's backend — exactly as the single-signer trust model already requires. Readers MUST NOT treat `issued_by` as an independent authorization proof; the authorization happened at the backend gate (below), and the chain-level authority is and remains `pevo.admin`'s signature.

### Tier model and power matrix

Three tiers, strictly ordered: **admin < super-admin < root**.

- **root** is the `pevo.admin` key-holder (the operator). It is **bootstrap config, not a table row**, is **un-demotable**, and seeds the initial roster.
- **admin** holds **all operational moderation authority**.
- **super-admin** adds **admin-roster management** (promote/demote `admin`s).
- Only `update_weights` (reputation governance) and **super-admin management** are root-gated. Admin-level roster management is super-admin+. All operational moderation — including sanction, retract, and revoke_authorship — is available to a plain `admin`.

| Authority op / capability | admin | super-admin | root |
|---|:---:|:---:|:---:|
| `accredit` (incl. bridged-paper author approval) | ✓ | ✓ | ✓ |
| `approve_authorship` / `revoke_authorship` | ✓ | ✓ | ✓ |
| `revoke` (`type:"sanction"`) | ✓ | ✓ | ✓ |
| `retract_paper` | ✓ | ✓ | ✓ |
| promote/demote `admin` (`admin_grant`/`admin_revoke`) | | ✓ | ✓ |
| promote/demote `super_admin` | | | ✓ |
| `update_weights` (reputation governance) | | | ✓ |

**Lockout guard.** A super-admin may manage `admin`s but **MUST NOT** promote, demote, or otherwise manage another `super_admin` — only root manages the super-admin tier. Root is un-demotable and cannot be removed via `admin_revoke` (it is config, not a roster row), so the roster can never be emptied of its bootstrap authority and no roster operation can lock the operator out.

### Roster derivation

Admin status is **read live from the chain**, not stored in an app database. Promotion/demotion is broadcast as an `admin_grant` / `admin_revoke` authority `custom_json` (signed by `pevo.admin`, `issued_by` the acting super-admin/root), and the current roster is derived from those ops exactly as accreditation membership is derived from `accredit`/`revoke`:

- An `active_admins` HAF read over `admin_grant` / `admin_revoke` ops, filtered to the `pevo.admin` signer (singular `?` JSONB containment, the same gate as `activeAccreditationsCteBody`), latest-op-per-account wins. Each op carries `account` and `level` (`'admin' | 'super_admin'`); the latest non-revoked grant per account is that account's live level. This is the direct analogue of `active_accreditations`.
- A short Redis TTL cache (namespaced `${config.appTag}:`, mirroring `getAccreditedSet` / the accreditation `hafCache`) fronts the read so per-request authorization checks do not hit HAF every time. App-initiated grants/revokes **bust the cache key** on success, so a change the backend itself made is visible immediately; an out-of-band chain write converges within one TTL.

There is **no persistent Postgres roster table, by design.** A long-lived mirror can drift from the chain (two-write windows, broadcast-timeout ambiguity, out-of-band chain writes, data loss); PEvO already avoids exactly that for accreditation. With a live HAF read the only write is the on-chain broadcast, so nothing can fall out of sync; staleness is bounded to the Redis TTL and self-heals. If neither HAF nor the cache can resolve a level, the authorization check **fails closed** (deny) — the same HAF dependency accreditation already carries.

Root is **bootstrap config**, not an op and not a row (derived from `config.hiveAdminAccount` or a dedicated `PEVO_ROOT_ADMIN` env). It is resolved before the chain read, which is what makes it un-demotable and guarantees the roster can never be locked out.

### Authorization enforcement

An authority endpoint MUST check the **caller's current roster level** (resolved from the on-chain `admin_grant`/`admin_revoke` ops via the `active_admins` HAF read, Redis-cached) against the power matrix **before** the backend signs the op with `pevo.admin`. The roster check is a server-side authorization gate; it is not, and cannot be, enforced at the chain layer (the chain sees only one signer).

Every admin authority action — accredit, sanction, retract, authorship grant/revoke, roster management, `update_weights`, and the metadata-edit endpoint — is a **critical action** under § 6.4. Per § 6.5 invariant #1, **JWT-only access is a defect**: each requires a **fresh re-auth proof** matching a factor registered on the caller's account, in addition to passing the roster-level check. A stolen admin JWT must not be a one-step path to broadcasting an authority op. The roster level and the re-auth proof are independent gates — both must pass before `broadcastAdminCustomJson` runs.

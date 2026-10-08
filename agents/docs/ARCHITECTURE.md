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

1. **HAF SQL** (required) — all listing, search, and reputation queries go through HAF SQL (PostgreSQL with indexed Hive chain data). **When HAF cannot answer a read** (no pool, a query error, a timeout), the request fails with a retriable 503 (`details.retriable: true`, `api-contracts/common.md`) and the SPA shows an error with a retry. A route never substitutes an answer for a read it could not make: no empty list, no "not accredited", no "sanctioned". Without HAF data the site cannot answer, and a substitute answer reads as a real one (decided with the user, 2026-10-06). A failed read still lets nothing through: where a read gates an action, the action does not run, and the answer is the 503, not a refusal. An answer from a cache that an earlier successful read filled is a real answer. This rule covers requests from the SPA.
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

### Light-Account Resource Credits

A light account is created with no Hive Power, which gives it about 4.8 billion resource credits (RC), regenerating fully over five days. A comment transaction costs about 0.72 billion RC plus about 0.5 million per transaction byte (fitted to 45 transactions, 2026-10-01). An undelegated light account can therefore broadcast at most about an 8.3 KB transaction, which with PEvO's metadata is about a 7 KB paper body, while the composer accepts 60 KB. The anonymous-review proxy account has the same ceiling.

Decided 2026-10-01:

- **Delegation at creation.** Each light account receives an RC delegation from a configured delegator account when it is created, and existing light accounts receive it once. The delegator is a dedicated account: never the admin, onboarding, anonymous-review or bridge account, with no fallback to any of them, and only its posting key is configured on the server. When it is not configured, delegation is off and the backend says so at startup. It must hold its own Hive Power: RC that an account has received by delegation cannot be delegated on. Funding the delegator, and the platform accounts that author content, is an operator action.
- **Pre-flight check.** `POST /api/custody/broadcast` and the anonymous-review broadcast compare the signing account's available RC with the transaction's cost before signing, and refuse with a specific error when it falls short. A node's own RC refusal maps to the same error. Either way nothing was broadcast, so the client may say so plainly.

### Accredited-Only Data Policy

PEvO defines its objects (papers, reviews, comments, bridge papers) by **author vouching**, not by metadata claim. A Hive comment with object-shaped metadata authored by a non-vouched account is not a PEvO object — it's a Hive comment claiming PEvO-shape. PEvO endpoints serve PEvO objects only. This is the read-gate.

This stance is distinct from the **write-gate** (root `CLAUDE.md` "Accreditation is the trust layer"), which restricts publishing/reviewing/commenting/voting on the write path to accredited accounts:

- **Write-gate (integrity invariant):** the platform itself only helps accredited users author PEvO objects. Anyone can post `APP_TAG`-tagged content directly to Hive, but PEvO won't help them.

  Enforcement lives at signup plus the read layer, not per-broadcast. Light-account signup gates on the same criteria accreditation uses (a whitelisted institutional email or a valid ORCID iD), so every product-created light account automatically qualifies for accreditation; a light-custody accounts row that is not accreditation-qualified is reachable only by seeding the database directly, which test fixtures do. `POST /api/custody/broadcast` therefore performs no accreditation check by design: such a check would re-verify what signup already established, add a HAF read to every broadcast, and refuse legitimately qualified accounts sitting in the attestation-indexing lag window. The accreditation check on `POST /api/ipfs/upload-token` is resource gating (pinning costs the platform), not the trust layer. The read-gate and the per-domain rules below are what keep any out-of-band unaccredited write inert.

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

The only DDL shapes that would break a still-serving old backend are relation/column **removal**, **rename**, a column **type change**, `ADD COLUMN ... NOT NULL`, or `ADD CONSTRAINT` (each imposes a rule the running code does not satisfy). `ADD CONSTRAINT` belongs on that list even though it adds nothing the old code reads: a constraint is normally added precisely because it encodes an invariant some existing writer violates, so the old backend's own writes start failing the moment it lands. Migration `017_accounts_custody_upgraded_align.sql` is the worked case. Its `CHECK` refuses an upgrade epoch on a row whose `custody` is not `'self'`, which is exactly what the pre-017 `/api/custody/upgrade` UPDATE writes, so an upgrade landing in the live-migrate window fails after the client has already broadcast its on-chain key rotation. The set is otherwise expand-only (`CREATE TABLE/INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `COMMENT`, and constraint-**relaxing** `ALTER COLUMN ... DROP NOT NULL`), all invisible or benign to the old backend. `cmd_restart` greps the **unapplied** migration set (files on disk not yet recorded in `schema_migrations` — not the whole `*.sql` set, which would always match the already-applied `004_drop_account_creation_tokens.sql` `DROP TABLE` and wrongly force the carve-out on every restart) for those destructive shapes. Each file is normalized before matching — `--` comments stripped and newlines collapsed to one line — so a commented-out destructive statement does not force a needless carve-out and a destructive statement split across lines is still caught (a line-by-line grep would let a multi-line `ADD COLUMN ... NOT NULL` evade it); an unreadable file forces the carve-out. Clean → migrate live, then swap. Match → **brief-stop carve-out**: stop the backend, migrate against the quiescent DB, start the new backend. The carve-out still pays only the migration window, because the image was already built while the old backend was serving. If the migration fails on the carve-out path, `cmd_restart` restarts the previous backend before aborting (the new image was only built, not yet swapped in), and a failed handover on the swap step exits non-zero so a wrapper sees the broken deploy.

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

#### Post-deploy cleanup: rows the old settings verify handler locked

Before the settings verify add flow required `username IS NOT NULL`, `GET /api/settings/email/verify/:token` accepted a pending signup row's token (state E or F) and cleared `verify_token` and `expires_at` on it. That left rows with `verify_token` NULL and `username` NULL, a combination no state in § 6.1 has. Such a row keeps its email and ORCID iD claims: a new signup with either answers 409, no login on it yields a usable session, and the signup cleanup never reaps it, because `ABANDONED_ACCOUNT_ROWS` requires a token. Deleting it reaches the end state the cleanup would have reached.

The repair is a one-time operator step, not a migration: `deploy.sh migrate` re-applies every migration file on each deploy, so a DELETE there would become a standing sweeper. Run it on the server from the repo root, after deploying a backend whose settings verify add flow requires a username (the old handler can create new locked rows until then):

```bash
# 1. List the rows (read-only):
docker compose exec -T postgres psql -U pevo -d pevo_app -v ON_ERROR_STOP=1 \
  -f - < backend/scripts/repair-locked-signup-rows-count.sql

# 2. Back up exactly those rows, since the delete cannot be undone:
docker compose exec -T postgres psql -U pevo -d pevo_app -v ON_ERROR_STOP=1 -c \
  "COPY (SELECT * FROM accounts WHERE verify_token IS NULL AND username IS NULL ORDER BY id) TO STDOUT WITH CSV HEADER" \
  > ~/locked-signup-rows-backup.csv

# 3. Delete them in one transaction. It prints the deleted ids and DELETE <n>:
docker compose exec -T postgres psql -U pevo -d pevo_app -v ON_ERROR_STOP=1 \
  --single-transaction -f - < backend/scripts/repair-locked-signup-rows-delete.sql
```

The deleted ids should match the step 1 list. Run step 1 again afterwards: it should list no rows. No foreign key references `accounts`, so the delete cascades nowhere. It frees each deleted row's email and ORCID iD for a new signup. The backup can hold password hashes, so delete it once the result is confirmed.

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

**Body, edits and versions.** An edit is another `comment` op on the same `(author, permlink)`. Its body is either a full replacement or a `diff-match-patch` patch (a body that starts with `@@` and parses as one). A post's current body is the replay of its comment ops in block order (`reconstructVersionsFromHaf` in `backend/src/lib/chain-walkers.ts`), applied the way hivemind applies them: fuzzily, ignoring the per-hunk success flags, and treating a body that does not parse as a patch as a replacement. PEvO therefore shows the body every other Hive frontend shows; a reconstruction that refused fuzzy patches was considered and rejected for that reason (2026-10-01).

`hafsql.comments.body` is not the current body. HafSQL's sync never applies an edit to it (an upstream defect, found 2026-10-01), so it keeps the creation body while `title`, `json_metadata` and `last_edited` follow the latest op. It may stand for the current body only on a post whose `last_edited` is null. The paper detail reads the replay; the listing, profile, search, review and comment readers do not follow this rule yet.

Every comment op is a version entry. A version whose replayed body, title and `json_metadata` all equal those of the same post's previous version is a **repeat**: it stays in the history, but reviews and votes of the earlier version are not outdated by it. The comparison is on the replayed result, not the op: the same non-empty patch sent twice changes the replayed body and is not a repeat.

The paper's **head marker** is `<head author>/<head permlink>/<version count>/<block of the newest op>` over the chain as the walk resolved it. One backend function computes it for the detail payload and for the head endpoint. It is null only when the replay came back empty or failed, or the walk aborted; a walk that ends in a lasting degraded state (a cycle, the hop cap, a root without PEvO metadata) still gets a marker over what it resolved, so such a paper stays editable. Composers compare markers, never bodies (§ 8).

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

A slot with neither a `hive` handle nor an `orcid` (a pure name-only display credit) is claimed but not consented until its real owner obtains a Hive account and completes route 3. A slot with an `orcid` but no `hive` becomes consented when its owner — accredited with that ORCID — broadcasts `author_accept` (route 2). Bridge papers' `pevo.authors[]` entries with `hive: null` follow the same rule, binding a Hive identity only through the explicit bridge-author-claim attestation flow (a deferred feature; see "Bridge papers" below).

The continuation-author-consent gate admits continuation posts from any **claimed** author of the paper (membership in the cumulative chain `pevo.authors[].hive` set, per "Display construction" below); this is the live defense against the outside-attacker spoof. Reputation/citation **credit**, by contrast, flows only to **consented** authors via the routes above — that is the credit gate this model establishes. Its enforcement in the reputation cycle is **live**: `computeReputationBatch` credits the Routes 1 ∪ 2 ∪ 3 union by composing the same `consentedAuthorsCteBody` (Routes 1/2) and `authorshipClaimsCteBody` `accepted_claims` (Route 3) stacks the read surfaces use, minus demotions (`author_resign` / `revoke_authorship`); see `reputation-algorithm.md` "Co-author Credit". Optionally tightening continuation admission itself to consented status remains a separate Phase 2 consideration.

#### Display construction (cumulative union)

The displayed `authors[]` is the **cumulative union** of `pevo.authors[]` entries across every admitted post in the paper's continuation chain (root + continuations + native edits). The claimed-set rule above (the append-only union of `pevo.authors[].hive`) is the *invariant*; this subsection is the *construction* that realizes it for display. Entries appear in **first-occurrence order** across the walked chain. Implemented by `buildCumulativeAuthorsForChain` in `backend/src/routes/papers.ts`.

**Drops are forbidden by construction — per-request scope.** Because the displayed list is a union over the chain rather than a projection of the head post's metadata, a later native-edit that removes a name from one post's `pevo.authors[]` cannot drop that name from the display: it still appears on the earlier post the union also reads. There is no reject-the-override / cover-check step; nothing to reject, because nothing is ever subtracted. **This invariant is scoped to a single read-time computation over the currently-resolvable chain.** It is NOT a claim of across-time permanence against walker truncation or HAF unavailability: a degraded or truncated forward walk yields a partial chain whose union is missing the truncated tail. That partial union is deliberately **not cached** and the surface falls back to its head-metadata projection, recomputed on the next request. The guarantee is "within one resolvable-chain computation, no admitted author is dropped," not "the union is durable across infrastructure flaps."

**Two never-merging tracks.** The union runs on two parallel tracks that are kept strictly separate:

- **Hive-keyed track.** Entries whose `hive` normalizes to a valid Hive account (lowercase + ASCII-space trim + `[a-z0-9.-]` charset, per `normalizeHiveAccount` in `backend/src/lib/author-supersession.ts`) dedup on the normalized hive. Per-hive sub-fields (`name`, `orcid`, `affiliation`) resolve by **most-recent self-claim wins** (the latest chain post the hive authored *about itself*), else **most-recent fallback claim wins** (the latest broadcaster's claim about that hive). A self-claim, once seen, outranks any non-self claim regardless of recency.
- **Hive-less display-credit track.** Entries with no normalizable `hive` (bridge-paper original-preprint authors, and any co-author credited without a Hive account) carry on a separate track keyed by a **composite key**: normalized `orcid` when present, else normalized `name` (`hivelessCompositeKey`). Most-recent occurrence wins the entry content; these are informational credits with no self-claim authority, so over/under-merge on the composite key is an accepted cosmetic outcome. An entry that normalizes neither a hive, an orcid, nor a name names no one and is skipped.

The two tracks **never auto-merge**. A Hive-less display credit is never linked to a Hive identity by fuzzy name or ORCID matching. The only path from Hive-less credit to a consented Hive identity is the explicit bridge-author-claim attestation flow (a deferred feature; see "Bridge papers" below); importer-side or read-time auto-mapping is forbidden (a dormant `author_accept` pre-broadcast under a colliding handle would otherwise activate retroactively — see "Bridge papers" below).

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

If/when an original-preprint author joins Hive and wants to claim authorship of an imported bridge paper, the off-chain verification flow plus on-chain attestation (likely issued by the bridge service) is a **deferred feature**, to be scoped via `/ce-brainstorm` when a real claim request surfaces (the trigger is inbound demand — an original author asking to claim). The settled design boundary holds in the meantime: bridge `hive: null` slots bind a Hive identity ONLY through this explicit attestation flow, never via a direct Route-2 ORCID shortcut or any auto-mapping (a bridge slot's ORCID is external, self-asserted preprint metadata, not an accountable accredited-poster assertion). Out of scope for this section.

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
  orcid: "<ORCID iD>" | "" | absent,
  evidence_hash: "<path-specific, see below>",
  issued_by: "<acting admin account>" | "<signer account>" | "wot",
  idempotency_key: "<sha256>" | absent,
  timestamp: "<ISO 8601>"
}
```

`orcid` is present when the account has an attested ORCID iD (a public identifier; see "Credential Bindings"). `issued_by` is a backend-attributed audit claim, not a proof (§ 7): the acting admin for the admin grant, the signer account for the self-service paths (email `/verify`, ORCID, signup finalize), `"wot"` for the WoT auto-grant. `idempotency_key` is carried only by the email `/verify` path: sha256 of the one-time token and the account, used for per-token duplicate detection and free of the address. `evidence_hash` has no single formula: the email `/verify` path hashes the submitted address, the account and the one-time token (the token is deleted after use, so the value cannot be recomputed later); the light-account signup finalize hashes the stored address, the account and a fixed suffix (recomputable from `accounts.email`); the ORCID paths hash the ORCID iD and the account; the WoT path writes the sorted voucher names; the admin grant writes an empty string. No path stores the evidence itself on chain.

The `accredit` op is **re-broadcastable**, and an account may accumulate several over time: the first establishes accreditation, later ones carry edited profile metadata (`name`/`institution`/`field`) or re-grant after a sanction. Two different ops are authoritative for two different purposes — **profile metadata** (`name`/`institution`/`field`/`method`) reads from the account's **latest** `accredit` op so edits take effect, while **tenure** ("accredited since") reads from the account's **earliest** `accredit` op so edits and re-grants never reset standing (see "Accreditation Lifecycle & Sanctions" below). `name`/`institution`/`field` are always user-supplied free text: the authority attests that the account is a verified researcher, not that these strings are correct, so editing them does not change what the attestation means.

### Revocation (custom_json)

A `revoke` carries one of two `type` values. `type: "sanction"` is a deliberate authority action against a bad actor. `type: "release"` is the account giving up its own accreditation (see "Credential Bindings": it frees the account's mailbox bindings so the holder can accredit another account). Neither is the mechanism for ordinary loss of WoT standing: a WoT member falling below the vouch threshold is handled by live membership evaluation, with no `revoke` op (see "Accreditation Lifecycle & Sanctions").

```
id: "pevo"
required_auths: []
required_posting_auths: ["pevo.admin"]
json: {
  action: "revoke",
  account: "<hive_username>",
  type: "sanction" | "release",
  reason: "...",
  issued_by: "<account itself>" | "<acting admin account>",
  timestamp: "<ISO 8601>"
}
```

A release is **ordinary, not sticky**: an account whose latest `type: "release"` revoke is later than its latest `accredit` op is not accredited, and any accreditation path (email, ORCID, WoT, admin grant) re-admits it. The op is admin-signed like every authority op, on the holder's authenticated request (a § 6.4 critical action) or on an admin's request for a holder who lost their keys; `issued_by` is the account itself in the first case (as `retract_paper` writes for an author self-retract) and the acting admin in the second.

A sanction is **sticky**: while an account has an un-lifted sanction it is not accredited regardless of vouch support. Only a **deliberate admin** `accredit` (the admin grant endpoint) lifts it; on lift, the account's full pre-sanction history counts (tenure still reads from the earliest `accredit` op). Every other accreditation path MUST refuse a sanctioned account: the WoT auto-accreditation path (vouches cannot re-admit a sanctioned account) AND the scientist-triggered self-service accredit paths (email verification, ORCID callback, signup-verify). Those self-service broadcasts are admin-key-signed but scientist-initiated, so re-verifying an institutional email or ORCID cannot lift a moderation sanction.

**Legacy revokes.** Every `revoke` broadcast before this model carries `reason: "WoT threshold no longer met"` and no `type` field; these are historical WoT threshold-drops, NOT sanctions and NOT releases. Membership evaluation MUST ignore a `revoke` lacking a `type` — such an account's status is determined by its live WoT standing and authority `accredit` ops alone.

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

**WoT vouches** are not filtered by `?|` on posting authorities. A vouch counts toward the threshold while its voucher holds a current `accredit` op of any method that is neither sanctioned nor released (`accred_pinned` in `activeAccreditationsCteBody`), so a WoT voucher below the threshold still counts.

### Accreditation Lifecycle & Sanctions

Accreditation status is an on-chain dimension **orthogonal to the § 6.1 `accounts`-table state machine**: it is computed from authority-signed `accredit`/`revoke` `custom_json` ops plus the live WoT vouch graph, applies to every account (including no-row pure-self-custody users), and adds no column to the `accounts` table. Reviewers must not conflate it with the § 6.1 `(verify_token, …, upgraded_at)` dimensions.

**Accreditation sources (the `method` field).** `email`, `orcid`, `manual` are **authority-pinned** — a deliberate platform attestation. `wot` is **vouch-derived** — granted when an account crosses the vouch threshold. All four are admin-signed `accredit` ops; they differ only by `method`.

**Membership rule.** An account is **accredited** iff it is **not sanctioned**, **not released**, AND either:
- its latest `accredit` op is authority-pinned (`method ∈ {email, orcid, manual}`), OR
- its latest `accredit` op is `method = wot` AND it **currently** meets the vouch threshold (evaluated against the live `active_vouches` graph).

"Released" means the account's latest `type: "release"` revoke is later, by `(block_num, op id)`, than its latest `accredit` op. Every reader that answers "is this account accredited now" must follow this rule, including the self-service gates that decide whether to broadcast a new `accredit` op; a reader that takes the account's latest op over both actions and reads any `revoke` as "not accredited" is wrong for a legacy revoke (ignored by membership).

**Release is ordinary.** A `type: "release"` revoke ends the account's standing without stigma: its vouches stop counting, it can no longer publish, review, comment or vote, and every mailbox binding it holds moves to released (see "Credential Bindings"). It is not sticky: any accreditation path re-admits the account, and no admin decision is needed. It is broadcast on the holder's request (`POST /api/accreditation/release`, a § 6.4 critical action) or on an admin's request for a holder who lost their keys (`POST /api/admin/accreditation/release`).

**WoT standing is live, not pinned.** A WoT member that falls below the vouch threshold loses standing immediately, with **no `revoke` op** — losing vouch support is ordinary, not a sanction. Recovering vouches restores standing automatically (self-healing). This is the chosen representation; an implementer may fall back to a neutral "demote" op if live evaluation proves too costly on HAF, but the *semantics* above (non-sanction, self-healing) are fixed. This reverses the earlier op-pinned, non-self-healing behavior in which a threshold-drop broadcast a `revoke`; see "Legacy revokes" under § 2 Revocation.

**WoT auto-accreditation.** When a processed vouch (`POST /api/wot/vouch`) leaves the vouchee at or above the threshold, the admin key broadcasts a `method: "wot"` `accredit` op for it. It skips any vouchee that HAF shows holding a current `accredit` op of any method that is neither sanctioned nor released, and refuses a vouchee with an un-lifted sanction, so a `wot` op never replaces a current `accredit` op that HAF has indexed. The check reads HAF, so it misses an `accredit` op broadcast seconds earlier and not yet indexed.

**Sanctions are sticky.** A `revoke` with `type: "sanction"` suppresses accreditation regardless of vouch support. Only a **deliberate admin** `accredit` (the admin grant endpoint) lifts a sanction; every other accreditation path MUST refuse a sanctioned account — both the WoT auto-accreditation path (vouches cannot re-admit a sanctioned account) and the scientist-triggered self-service accredit paths (email/ORCID/signup), which are admin-key-signed but scientist-initiated and so cannot self-lift a moderation sanction. The membership SQL itself lifts on any later authority-pinned `accredit`, so this rule lives in those refusals; every other accredit-broadcasting route needs one. A sanction also keeps every credential binding of the account held (see "Credential Bindings"), so the credentials it holds cannot back another account while the sanction stands. Issuing a sanction is an **authorized-admin action** (the admin-set that may sign authority ops is administered separately from these semantics).

**Editable profile metadata.** `name`/`institution`/`field` are user-editable after accreditation by re-broadcasting an admin-signed `accredit` op carrying the new values (user-initiated through the edit endpoint; the broadcast is admin-signed, so neither light nor self-custody users sign the op — they only re-auth the request per § 6.4). The account's **latest** `accredit` op is authoritative for metadata, so edits take effect. ORCID-accredited accounts (whose `institution`/`field` are empty at grant) use the same path to set them for the first time. This replaces the former "metadata is one-shot" code invariant.

**Tenure anchor ("accredited since").** Tenure reads from the account's **earliest** `accredit` op — all history, across sanction gaps — so a metadata edit or a post-sanction re-grant never resets standing. The anchor is the earliest op's **chain block time**, not the payload `timestamp` (which a re-broadcast rewrites). Reputation **scoring** is present-tense membership (a flat `accreditation` bonus) plus content-age decay and does not key off accreditation date at all, so edits and re-grants do not move scores; only the displayed "accredited since" uses the anchor. The accreditation status, profile, and accredited-directory response envelopes expose this anchor as a dedicated field, **`accredited_since`** (the chain block time of the earliest `accredit` op), alongside — not replacing — the latest-op payload `timestamp` they already carry. Clients render `accredited_since` for tenure and never the latest-op `timestamp`; the accreditations LIST route keeps sorting by the existing latest-op `timestamp`, so the anchor is purely additive.

**Lifecycle states** (on-chain, per account):

| State | Condition | Accredited? |
|---|---|---|
| Unaccredited | No authority `accredit` op | No |
| Accredited (authority) | Latest accredit `method ∈ {email,orcid,manual}`, not sanctioned | Yes |
| Accredited (WoT) | Latest accredit `method = wot`, live vouch threshold met, not sanctioned | Yes (while threshold met) |
| Below-threshold (WoT) | Latest accredit `method = wot`, live vouch threshold **not** met, not sanctioned | No (self-heals if vouches return) |
| Released | Latest `type: "release"` revoke later than the latest `accredit`, not sanctioned | No (any accreditation path re-admits) |
| Sanctioned | Un-lifted `type: "sanction"` revoke | No (only an authority `accredit` lifts) |

Wire formats: § 2 "Accreditation" / "Revocation". Reputation interaction: § 3.

### Credential Bindings

Decided with the user on 2026-10-06, from the accreditation and Web of Trust audit (one mailbox could accredit any number of accounts, and a sanctioned researcher could accredit a fresh account from the same mailbox).

**The rule.** Each verified credential backs at most one accredited account at a time. The credentials are the institutional mailbox (`method = email`) and the ORCID iD (`method = orcid`, or the `orcid` field on any accredit op). A verification that would bind a credential already bound to another account is refused. A sanction keeps the sanctioned account's credentials bound. The principle behind the rule is **one researcher, one accredited account**; the binding enforces it per credential because a credential is what the platform can verify. A person who presents a mailbox on one account and an ORCID on another is not detected by the binding; that is a breach of the terms, sanctionable when found, not a permitted arrangement. One account may hold several mailboxes (each bound to it alone). Rationale: every accredited account can vouch, and the vouch threshold (default 3) enrols an account into the Web of Trust, so the WoT is only as strong as this rule. Chosen over a sanction-only refusal, a record-only registry and a small per-mailbox cap.

**Where the ORCID binding lives: on chain, as today.** The ORCID iD is a public identifier, so the latest authority `accredit` op carrying it is the binding (`findAccreditedAccountWithOrcid` in `backend/src/lib/orcid-binding.ts`; the `accounts_orcid_unique` index is a second layer for rows). Three changes to that read: a `type: "sanction"` revoke on the bound account keeps the ORCID bound (today any latest revoke frees it), a `type: "release"` frees it, and a revoke lacking `type` is ignored, as membership ignores it. Release does not touch `accounts.orcid`: the released row keeps the ORCID as a login factor, and `accounts_orcid_unique` keeps the ORCID from any other account that has an `accounts` row (light, D or G) until the released row is deleted (`DELETE /api/settings/email`); `POST /api/orcid/callback` must check the row before the broadcast, because today it writes the row after it and would land the `accredit` and then fail the row write. An authority op that drops the `orcid` field (the admin grant today) must carry the attested ORCID forward, or the read loses the binding.

**Where the mailbox binding lives: the app database, nothing on chain.** The address is not a public identifier, so the registry is a table (`mailbox_bindings`) keyed by a keyed hash of the canonical address: HMAC-SHA256 under a dedicated server-side secret that is kept out of the database and its backups. An unkeyed hash of an address is reversible by enumeration (about 2^32 addresses exist, and staff directories are public), and a value on the chain would be permanent, publicly link every account that ever shared a mailbox, and could never be rotated; the EDPB's blockchain guidelines (02/2025, final July 2026) call recording hashed personal data on a chain not advisable (para 104) and treat a keyed hash as personal data (para 52). The registry stores no plaintext address. One row per (mailbox, account) binding with a state (`pending`, `bound`, `released`); at most one row per mailbox in a live state (`pending` or `bound`), enforced by a partial unique index, which is what settles two racing verifications. Rows carry the canonicalisation version, so a later rule can look a mailbox up under each version still in the table. Design principles 2 and 6: the registry is part of the centralised issuance service (the signer account, SMTP, the admin key), not of the membership computation, which stays reconstructible from the chain; a fork or successor operator takes over the table and key, or starts empty and rebinds as researchers verify again.

**Canonical address.** One shared function for every flow: trim; lowercase the whole address; strip the local part from its first `+` to the end; keep dots; refuse any address that `accreditationRequestSchema`'s email rule rejects (the Zod email regex: ASCII, no quoted local part, no comment), which `/request` already enforces at its schema while `/signup` checks only the domain and must refuse before it stores the address; domain in its lowercased ASCII (punycode) form. Not folded, because no string rule can see them: department subdomains, institution alias domains, and self-service aliases. The rule therefore bounds accounts per address, not per person. Folding produces the registry key only; the recipient of the verification mail is not derived from it (`POST /api/accreditation/request` sends to the address as submitted, `POST /api/auth/signup` to the trimmed, lowercased form it already stores). Folding is then at worst a refusal of a second person at a host that distinguishes case or `+`, never a mail to the wrong recipient. This is a deliberate departure from RFC 6943, which reserves email-like identifiers for grant-on-match checks.

**Enforcement points.**
- `POST /api/accreditation/request` answers the same whether or not the mailbox is bound; a distinguishable refusal would let any Hive account test whether a researcher's address is accredited. When the canonical key is live-bound to another account, no token is issued and the mail carries that notice instead of a verification link: it names the account that holds the mailbox and the ways through (sign in to that account and release it, or ask an admin), in the same words whether or not that account is sanctioned.
- `POST /api/accreditation/verify` is the authoritative check. After the session proves the requester's account, after the existing-accreditation and sanction gates (so a refused attempt leaves no row) and before any chain write, the handler claims the binding row for (key, account): a live row for another account refuses with 409 `MAILBOX_ALREADY_BOUND`, no retry hint, and leaves the token in place so the same link works once that row is no longer live; a live row for the same account proceeds. The claim exists before the op can exist, in state `pending`, and becomes `bound` once the broadcast returns; it is dropped only on a refusal the node returned before accepting the transaction. On any other error (a timeout, a connection error after the request was sent) it stays `pending`, the next verification for the same account and mailbox resumes it, and 24 h after its latest claim a `pending` row becomes `bound` if its account is accredited then and is deleted otherwise. A mailbox is never accredited twice because a claim was dropped while its op was in flight. The check runs against the app database whether or not HAF is configured and fails closed (503) when the database is unavailable. An already-accredited account verifying a mailbox claims the row as `bound` at once, with no second `accredit` op.
- Light-account signup. `POST /api/auth/signup` for an address whose key is live-bound to another account answers as the same address would unbound: the duplicate-email check runs first and is unchanged, and a signup it lets through creates the same pending `accounts` row an unbound signup creates and sends the notice mail instead of the verification link. Only the mail differs, so a later login with the address and the chosen password (409 `PENDING_UNVERIFIED`), a resend and the row's expiry answer the same whether or not the address is bound; with no row, that login would answer 401 for a bound address and reveal the binding (decided with the user, 2026-10-06). A resend for such a row sends the notice again. At finalize (`POST /api/auth/confirm` and `POST /api/auth/link`, the email path), the mailbox proven by the signup link claims the row after the finalize UPDATE and before the `accredit` broadcast, with the same row states and the same refusal. A refused claim answers as the finalize-time `ORCID_ALREADY_LINKED` refusal does today: 409, no session, the account stays finalized and unaccredited; the holder signs in and verifies another mailbox or accredits with an ORCID. ORCID-path signups create no mailbox binding: their address was never proven. The settings email flows never bind or free a mailbox. Account deletion (`DELETE /api/settings/email`) does not free a binding; only a release does.
- `POST /api/accreditation/release` (holder) and `POST /api/admin/accreditation/release` (admin, for a holder who lost their keys) broadcast the `type: "release"` revoke and move the account's live rows to `released`. The rows move only after the broadcast returns; on a refusal or a timeout they stay `bound`, and a retry from a released account that still holds live rows completes the move without a second op. Both refuse a sanctioned account. The holder can accredit the new account with the same mailbox at once. There is no move by mailbox proof alone: a mailbox co-user or a later holder of a recycled address could take the accreditation over.

**History and retention.** A released row is kept, so an admin can see which accounts a mailbox backed before (`GET /api/admin/accreditation/bindings/:username`) and sanction a successor account when the predecessor is sanctioned. A scheduled backend job deletes released rows one year after the release. A `bound` row lasts until the account's release; a sanction does not end a live row. The legal basis is Art. 6(1)(f) GDPR (abuse prevention); the accreditation request form and the signup form name the legitimate interest (abuse prevention) and the right to object (Art. 21) before the address is submitted, and an objection or erasure request about a binding is decided case by case, not by a blanket rule.

**Rollout.** An operator script, not a migration, binds each finalized light account whose current `accounts.email` hashes to its earliest signup-path `accredit` op's `evidence_hash` and whose op's `orcid` is absent or empty (the mail-proven signups), after a notice to those holders that states the purpose and legitimate interest. Where several such accounts fold to one canonical key, the script binds the one with the earliest `accredit` op and lists the others in its output. Accounts accredited through the accreditation page stay unbound until their mailbox is next verified by anyone.

**Known limits.** Shared and role mailboxes bind to whoever verifies first. An address an institution reassigns to a new person stays bound to the old holder until released. An account left unbound at rollout holds no mailbox until it verifies again: meanwhile one other account can bind that mailbox and both stay accredited, and a sanction on it holds no mailbox. The signup finalize (`POST /api/auth/confirm` and `POST /api/auth/link`) writes `evidence_hash` as an unkeyed hash of the stored address, the account and a fixed suffix, so every mail-proven signup op on chain can be matched against a guessed address; the rollout reads this value, and this design leaves the path that writes it unchanged. A released account keeps the vouches made for it; if they still meet the threshold, the WoT path re-enrols it when the next vouch for it is processed. A person with two credentials on two accounts is not detected (see the principle above); closing that gap would need the two credentials to meet, for example an institutional mailbox verified alongside an ORCID-only accreditation, which is not part of this design.

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

Six dimensions of the `accounts` row affect auth and state transitions: `verify_token`, `username`, `password_hash`, `orcid`, `custody`, `upgraded_at`. Orthogonal overlays (`reset_token`, `pending_email_*`, `sessions_invalidated_at`, `updated_at`) are transient flags layered on top of these states, not states themselves. `updated_at` is a recency marker (bumped at every `/confirm`+`/link` finalize UPDATE, and by nothing else; the custody upgrade in particular must never bump it, see § 6.3's Option C note): it is the staleness signal the stuck-recovery lookups conjoin with the crypto ownership proof so the Option C resume path admits only genuinely-mid-crash rows, not every steady-state finalized row (see § 6.3's Option C note). A defense reading `updated_at` is therefore reviewable against this overlay, not an unenumerated state dimension.

| State | verify_token | username | password_hash | orcid | custody | upgraded_at | Reached by |
|---|---|---|---|---|---|---|---|
| A | NULL | SET | SET | NULL | `'light'` | NULL | Email signup, no ORCID linked |
| B | NULL | SET | SET | SET | `'light'` | NULL | A with ORCID linked, or combined email+ORCID signup |
| C | NULL | SET | NULL | SET | `'light'` | NULL | ORCID-only signup, or A/B after `/recover` with `orcid_token` and no `new_password` |
| D | NULL | SET | preserved from A/B/C, or carried from the E/F row on the signup-verify(self) path (SET on the email path, NULL on the ORCID path) | preserved, or carried from the E/F row (NULL or SET) | `'self'` | SET | A/B/C after `/api/custody/upgrade`, OR a fresh F → D via `POST /api/auth/link` (signup-verify(self), self-custody-linking finalization for a Hive account the user already controls) |
| E | random hex | NULL | SET | NULL | NULL | NULL | Email signup, after `/api/auth/signup`, before email-verify-link click |
| F | `'confirmed:<hex>'` | NULL | SET (email path) or NULL (ORCID path) | NULL or SET | NULL | NULL | Email signup after verify-link click, OR ORCID signup (skips E directly per `POST /api/auth/signup`'s `verifiedOrcid` branch) |
| G | random hex while the email is unverified, then NULL | SET | NULL, or SET after `POST /api/settings/email` + `/settings/set-password` | NULL or SET | NULL | NULL | Pure self-custody Keychain account that registered an email through `POST /api/settings/email`'s add flow, optionally linking an ORCID later via `/orcid/callback mode='link'` |

Plus the **no-row case**: pure self-custody. User brings their own Hive account, never goes through PEvO signup, has no `accounts` row. Authenticated via `verifyHiveSignature` middleware per request (Hive-signature path); `req.hiveCustody = 'self'`. Such a user acquires a row, and becomes state G, if they later register an email through settings. The custody posture does not change: the server still holds no keys for them.

States E and F are transient signup-pending. States A, B, C, D are finalized. State G is finalized too, but it never went through light signup at all: it is a self-custody account that acquired a row only because it registered an email (and it keeps that row for as long as the email is on file). G is the one finalized state whose `custody` is NULL, and the reason the session mints derive the claim rather than reading the column raw. **No transition produces a row that doesn't match one of the rows above.** Any code that posits another combination is defending a fictional state.

**Field rationale:**
- `verify_token`: encodes signup progress. Random hex = email not yet confirmed (state E, and state G while a settings-registered email is unverified). `'confirmed:<hex>'` = ready to finalize via `/signup-verify` (state F). NULL = finalized. The hex form is disambiguated by `username`: NULL in E, SET in G.
- `username`: NULL while pending finalization; SET to Hive username once the user picks one (light path) or links to an existing one (self path).
- `password_hash`: SET if account can password-auth. NULL for ORCID-only signups (no password ever set), after `/recover-orcid-no-password` (password dropped), on a state G row until a password is set, and on a D row that carried a NULL over from one of those. Argon2id-hashed. Row E always has one: `POST /api/auth/signup` refuses an `orcid_token` that does not resolve, so its email path runs only with a password. A hex-token row with `username` and `password_hash` both NULL is a shape written before that refusal; `POST /api/auth/verify` gives it the wrong-password 401 and leaves it unchanged.
- `orcid`: SET if account has an ORCID linked. ORCID-only signup sets this at signup; email-signup users can link later via `/orcid/callback mode='link'`.
- `custody`: `'light'` while server holds encrypted broadcasting keys. `'self'` after upgrade. NULL during the transient pre-finalize states E and F, and permanently in state G, whose row was created by the settings email add flow and never had server-held keys. Because NULL is reachable on a finalized row, no reader may treat the raw column as authoritative: `custodyClaimFor` (`backend/src/lib/custody-claim.ts`) is the single derivation, and it resolves anything that is not an explicit `'light'` with no epoch to `'self'`, the claim that grants nothing server-side.
- `upgraded_at`: Set by `/api/custody/upgrade` as part of the light→self transition, and by the signup-verify `/link` finalize when a self-custody account is linked. Once set, never unset. Both writers set `custody = 'self'` in the same UPDATE, and the `accounts_upgraded_implies_self_custody` CHECK (migration 017) enforces that pairing at the schema layer: an epoch on a row whose `custody` is not `'self'` is refused, NULL included. The epoch is therefore the authoritative "the server can no longer sign for this account" signal, and every gate that refuses server-side signing reads it. The CHECK is one-directional: it still permits `custody = 'self'` with no epoch. No writer produces that pairing and no state above enumerates it, so it is a fictional shape; the one reader that would otherwise have to decide about it, the `/link` stuck-recovery lookup, refuses it by construction (see § 6.3's Option C note). Do not add a defensive `OR upgraded_at IS NULL` anywhere to admit it.

### 6.2 Per-State Concept and Session Auth Factors

**State A — Light, password-set, no ORCID.** Standard light account from email + password signup. Session auth: `POST /api/auth/login` (mints JWT with `custody='light'`). Recovery factor: BIP39 seed phrase (generated client-side at signup, used via `/api/auth/recover` with `memo_key`).

**State B — Light, password-set + ORCID-linked.** Either email signup followed by `/orcid/callback mode='link'`, or combined email + ORCID signup. Session auth: `POST /api/auth/login` (password path) or `POST /api/orcid/callback mode='login'` (ORCID path). Recovery factors: seed phrase or ORCID.

**State C — Light, passwordless ORCID-only.** Either ORCID-only signup (skipped password at signup, no email required), or A/B after `/api/auth/recover` with `orcid_token` and `new_password` omitted. Session auth: `POST /api/orcid/callback mode='login'` only. Recovery factors: seed phrase (all light signups produce one) or ORCID.

**State D — Upgraded self-custody.** Originally light (any of A/B/C), then upgraded via `/api/custody/upgrade`. `custody='self'`, `upgraded_at` set. Encrypted broadcasting keys (`posting_key_enc`, `memo_key_enc`, IVs) wiped during upgrade. `password_hash` and `orcid` are **preserved** — the user can still session-auth via the same factors they had before. But server-side broadcasting via `/api/custody/broadcast` is now disabled (no encrypted keys to decrypt). Useful work post-upgrade requires Keychain on the client. A D row is also reached directly from E or F through `POST /api/auth/link` (signup-verify(self)); that row never held encrypted keys and carries the password and ORCID its E/F row had. Either way `POST /api/custody/fresh-auth` refuses it: the route refuses any row with `upgraded_at` set, whatever claim the presented token carries. So on the JWT path its only fresh-auth factor is ORCID, when linked.

**State G — Self-custody with a registered email.** A no-row Keychain user who added an email through `POST /api/settings/email`'s add flow. `custody` stays NULL, which `custodyClaimFor` resolves to `'self'`; the server holds no keys and there is no seed phrase on file. Session auth: the Keychain signature (and the `POST /api/auth/session` JWT it can mint), plus `POST /api/auth/login` once a password is set and `POST /api/orcid/callback mode='login'` once an ORCID is linked; every JWT minted for the row carries the `'self'` claim. Before it signs, mints a proof or opens a session window, or writes the row, each custody route that acts on a light claim (`POST /api/custody/broadcast`, `/fresh-auth`, `/session-auth`, `/upgrade`) re-reads the row and refuses it unless `custodyClaimFor` derives `'light'` from that read; a row with an epoch is answered first by the route's own `upgraded_at` branch. The re-read is needed because a `'light'` JWT can outlive an earlier light row of the same username: deleting a row deletes its revocation epoch with it, the G row's INSERT stamps none, and `POST /api/auth/session` re-mints whatever claim it is shown. So on the JWT path the only fresh-auth factor for a G row is ORCID, when linked. No server-side recovery (seed-phrase recovery needs `memo_key_enc`, and § 6.4 limits ORCID recovery to B and C); the Hive keys are the user's own. Decided 2026-10-05: while the email is unverified the row may not acquire a password or an ORCID (both refused with `PENDING_UNVERIFIED`), so an unverified row that expires carries nothing but the email claim and the signup cleanup reaps it (§ 6.3).

**No-row case — Pure self-custody.** User brings their own Hive account and signs every request via Hive Keychain. The `verifyHiveSignature` middleware verifies the signature against the on-chain posting key from `getAccounts` (Hive API) and sets `req.hiveCustody = 'self'`. No `accounts` row exists. The user may still hold a PEvO session: `POST /api/auth/session` mints a `'self'`-claim JWT for any Keychain-signed caller, row or not. No fresh-auth proof can be minted for a row-less account, so its critical actions go through the Keychain signature path.

### 6.3 Transitions

All routes that mutate state. Routes that only read state (login session-mint, accreditation queries) do not appear here.

```
Initial → finalized:
  [no row] ──signup(email+password)──> E ──email-verify-link(+password)──> F ──signup-verify(light)──> A
  [no row] ──signup(orcid_token only)────────────────────────────────────> F ──signup-verify(light)──> C
  [no row] ──signup(email+password+orcid_token)──────────────────────────> F ──signup-verify(light)──> B
  [no row] ──signup(...)──> E or F ──signup-verify(self)──> D   (POST /api/auth/link, fresh self-custody finalization linking to a Hive account the user already controls; the finalize UPDATE writes neither password_hash nor orcid, so the D row keeps whatever its E or F row carried: a password on the email path, an ORCID on the ORCID path, both on the combined path)
  [no row] ──(bring own Hive account)──────> no-row case

Self-custody email registration (never a light signup; custody stays NULL, the server holds no keys):
  no-row case ──settings/email POST(add flow, Keychain signature)──> G   (verify_token = random hex until the mailed link is clicked)
  G ──settings/email/verify(token)──> G                (verify_token cleared)
  G ──settings/email POST(add flow, email still unverified)──> G   (re-issues the verification link: new email, verify_token and expires_at; not the change flow)
  G ──signup-cleanup(hourly: email unverified, link expired, no password, no ORCID)──> [no row]   (email released; a G row carrying a factor is never reaped, and login never deletes a G row)
  G ──signup(same email, past the accreditation gate; email unverified, no password, no ORCID)──> [no row], then the signup's own E or F row   (the DELETE and the signup's write run in one transaction; a G row carrying a factor answers the signup 409 DUPLICATE and is kept)

Adding auth factors:
  A ──orcid-callback(link)──────> B          (links ORCID to existing light-with-password)
  C ──settings/set-password─────> B          (adds password to passwordless ORCID-only)
  G ──orcid-callback(link)──────> G          (orcid set; refused with PENDING_UNVERIFIED while the email is unverified, as is mode='accredit')
  G ──settings/set-password─────> G          (password set; needs an ORCID, like C, and a verified email)
  D ──orcid-callback(link) or settings/set-password──> D   (fills a factor the row lacks; the link UPDATE and set-password gate on no custody state, only on username, and for set-password on password_hash NULL with orcid SET)
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
  A/B/C/D/G ──settings/email DELETE(fresh-auth proof)──> [no row]
```

**Signup finalization (F → A/B/C) requires the session-binding cookie, not the `auth_token` alone.** The `signup-verify(light)` transitions via `POST /api/auth/confirm` (light path) and `POST /api/auth/link` (self-custody link path) require the httpOnly `pevo_signup_session` binding cookie in addition to the `auth_token`. The `auth_token` is the row-lookup credential — it identifies the state-F row by `verify_token` — not the authorization proof; the binding cookie (minted by `POST /api/auth/verify`, `POST /api/auth/resume-signup`, and the ORCID-direct `POST /api/auth/signup` branch, stored as `signup_binding_hash` on the row) proves the finalizing browser is the one that initiated the signup. This closes the auth_token-as-bearer-capability replay vector: a token leaked via mailbox, referer, or logs could otherwise finalize the account with attacker-controlled keys. Stuck-account recovery (Option C) bypasses the binding only on a real key/signature proof — `/confirm` requires `posting_private`, `/link` requires a fresh Hive signature (a replayable Bearer JWT does not satisfy it, per § 6.5 invariant #1). See `api-contracts/auth.md` for the cookie attributes and the login `PENDING_SIGNUP` 409 contract.

**Option C lookup predicates (canonical statement of the epoch-ordering invariant).** Both stuck-recovery lookups are keyed by username, not by `auth_token`, and both require `verify_token IS NULL` and `updated_at` within `STUCK_RECOVERY_WINDOW` (one hour) of now. Recency alone is not enough to identify a mid-crash row, so each side adds a shape term:

- `/confirm` requires `custody = 'light' AND posting_key_enc IS NOT NULL`. The `accounts_upgraded_implies_self_custody` CHECK makes that exclusive of an upgrade epoch, so no ordering term is needed there (one would evaluate NULL for every candidate and refuse them all).
- `/link` requires `custody = 'self' AND upgraded_at <= updated_at`. The ordering term is what keeps an upgraded (state D) row out. A state-D row matches every other term for the rest of its own `/confirm` window, because the upgrade writes `custody = 'self'` and never bumps `updated_at`. The `/link` finalize stamps `upgraded_at` and `updated_at` from `NOW()` in one statement, and `NOW()` is `transaction_timestamp()`, so a row the `/link` finalize produced carries them equal. `/api/custody/upgrade` stamps its epoch a full HTTP round trip and a fresh re-proof after the `/confirm` finalize that set `updated_at`, so an upgraded row's epoch is strictly newer and fails the comparison.

The invariant therefore rests on three facts, and changing any of them reopens the lookup to upgraded accounts. (1) The custody upgrade never writes `updated_at`. (2) The `/link` finalize writes both stamps from the same SQL `NOW()`, never one from a Node `Date`: two clocks put the pair a millisecond or two apart with either sign, which would refuse genuinely stuck rows at random. (3) The two finalizes are the only writers of `updated_at` and the table carries no trigger; the source canary `backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts` pins the writer half. A row with `custody = 'self'` and no `upgraded_at` fails the comparison (NULL is not TRUE) and is refused: § 6.1 enumerates no such state, no writer produces it, and refusing it is deliberate (see the `upgraded_at` field rationale).

The lookup deliberately reads no revocation state. `POST /api/auth/reset` gates on no account state and stamps `sessions_invalidated_at` (§ 6.7) without touching `updated_at`, so any revocation-based term would strand a genuinely stuck row whose owner reset a password while locked out, and a finalized row has no `confirmed:` verify_token for `/resume-signup` to pick up instead. The cost is accepted: such a row recovers, and the session it mints outlives the revocation the reset asked for. The branch demands live posting-key control, a strictly stronger proof than the bearer credential a reset revokes.

Account deletion erases the `accounts` row entirely; the user returns to the **no-row case**. It is a one-way exit, not a transition between steady states. The on-chain Hive account is untouched — a light user who still holds their BIP39 seed phrase can re-import it into Hive Keychain and continue as pure self-custody (the no-row case). The user-facing deletion flow must make both facts clear: the PEvO account record is erased, and the Hive account survives via the seed phrase.

Pure self-custody (no-row) users never enter this state machine; their identity is on-chain only.

The `recover(seed_phrase, …)` transitions above are **two-phase**: phase 1 (`POST /api/auth/recover`) only stages the change and the account stays in its current state; the transition lands at phase 2 (`POST /api/auth/recover/verify`) once the new email proves control (or never, if the staged swap is disputed or expires). The `recover(orcid, …)` transitions apply in one step. See § 6.4 for the per-path re-auth contract.

**Evictions drop a queued email change.** ORCID recovery (`POST /api/auth/recover`), the seed-phrase recovery apply (`POST /api/auth/recover/verify`) and `POST /api/auth/reset` set the `pending_email_*` overlay to NULL in the UPDATE that rewrites the password or email and stamps `sessions_invalidated_at`, so a change queued by a password holder dies with the eviction and its link answers as an unknown token does. The custody upgrade leaves the overlay: it rewrites neither the password nor the email.

### 6.4 Critical-Action / Re-Auth Contract

Every critical action requires a fresh re-auth proof; the JWT alone is never sufficient. The required proof factor is determined by **what kind of control the action transfers or uses**, not by what auth factors the account happens to have. Per-state availability captures intent; current code may diverge — divergences are tracked as separate tasks, not inline here.

| Action | Endpoint | Required re-auth (intended) | Per-state availability |
|---|---|---|---|
| Server-side broadcast (non-consent ops) | `POST /api/custody/broadcast` | A **session-kind** fresh-auth proof matching a factor registered on the account. Unlike the consent-op kind, the session kind is target-less and **multi-use within a bounded window** (see § 6.4.1), so one re-auth act covers a working stretch of votes, comments, reviews, posts, and Web of Trust vouches and retractions rather than one broadcast. Vouches ride this kind, not a per-target proof (decided 2026-10-01): a vouch is a posting-authority op like a vote, and signing it server-side gives the operator nothing it lacks, since it already holds the admin accreditation key. | A: password proof. B: password OR ORCID proof (the SPA prefers password: a modal beats a full-page OAuth redirect for an account that has both). C: ORCID proof. D: blocked (encrypted keys nulled at upgrade). no-row: n/a (Keychain). |
| Server-side broadcast (consent ops: `author_accept`, `author_resign`) | `POST /api/custody/broadcast` | Per-target fresh-auth proof (target binds `op_type` + `paper_author` + `paper_permlink`) | Same as non-consent. Implemented at `custody.ts` (`findGatedOpsInBundle`). |
| Server-side broadcast (name-only-route credit ops: `claim_authorship`, `approve_authorship`, `revoke_authorship`) | `POST /api/custody/broadcast` | Per-target fresh-auth proof. The target binds `op_type` + `paper_author` + `paper_permlink` plus the fields that identify the specific grant: `claim_authorship` binds `author_index` (the slot; the claimer is the signer); `approve_authorship` binds `author_index` + `claimer` (the subject bound to the slot); `revoke_authorship` binds `claimer` only (it carries no `author_index` on the wire, see `hive-schemas.md` § 2.11). Binding `claimer` is what stops a minted approve/revoke proof from being redirected to strip or credit a different co-author. | Same as non-consent. Gate live at `custody.ts` (`findGatedOpsInBundle`). |
| Issue fresh-auth proof (password) | `POST /api/custody/fresh-auth` | Current password | A or B. A D or G row's password does not mint here; those rows use an ORCID proof or the Keychain path. A D row is refused by its `upgraded_at` and a G row by the row's derived claim (`custodyClaimFor`), even under a `'light'` JWT (§ 6.2 State G). |
| Issue fresh-auth proof (ORCID) | `POST /api/orcid/callback mode='fresh_auth'` | Fresh ORCID OAuth round-trip | Any row with an ORCID linked: B, C, and a D or G row with an ORCID (the issuer reads `orcid` by username and has no custody gate). A D or G proof is useful only on the non-broadcast actions (change email, delete, upload token, metadata edit, admin actions), because server-side broadcast refuses a non-light claim. |
| Issue IPFS upload token (binds a file to the auth envelope before pinning) | `POST /api/ipfs/upload-token` | Signature path: the per-request Hive signature body-hashes the declared file descriptor (`{file_sha256, mimetype, size}`) into the signed envelope. JWT path: either a single-use **per-action `ipfs_upload`-targeted** fresh-auth proof (`fresh_auth_proof` in body, target bound to `(ipfs_upload, <username>, '')`) **or a valid session-kind proof within its window** (§ 6.4.1), so a stolen JWT alone still cannot mint a token. The session kind is accepted here because a live session proof already authorizes arbitrary broadcasts for the remainder of its window, so an upload is not a wider grant than what the holder can already do; the per-file integrity binding lives in the returned upload token, not in the fresh-auth proof. The subsequent `POST /api/ipfs/upload` carries the returned token in `X-Upload-Token` and is rejected unless `sha256(file)` matches the declared hash. | All accredited accounts (light A/B/C/D and self-custody/Keychain). Implemented at `ipfs.ts` (`/upload-token`). The JWT-path proof is minted via password (`POST /api/custody/fresh-auth action='ipfs_upload'`) or ORCID (`POST /api/orcid/start mode='fresh_auth' action='ipfs_upload'`); the consume returns 403 on a binding violation (username/target/kind mismatch) and 401 on a missing/expired/malformed proof, mirroring the consent-op consume. **SPA behavior:** the web client satisfies this gate from the session proof it already holds for the broadcast leg, so one re-auth act covers both the upload and the post. Passwordless ORCID-only state C is no longer blocked from inline upload: it acquires its session proof by an ORCID round-trip taken **before** any file is selected (the acquire-before-commit rule in § 6.4.1), which is what makes uploads reachable for a state whose only factor destroys page state. The prior carve-out that blocked state C client-side with a "set a password" prompt is retired. |
| Light → self upgrade | `POST /api/custody/upgrade` | Seed-phrase-derived pubkey (UI derives from BIP39 client-side; backend verifies pubkey matches on-chain `getAccounts` posting/active key) | All light states (A, B, C). D: 409. Pure self-custody: n/a. G: 403, a `'self'` JWT at the claim check and a `'light'` one by the row's derived claim (there is no light row to upgrade; § 6.2 State G). |
| Set password from null | `POST /api/settings/set-password` | Fresh ORCID OAuth proof (null-hash accounts have ORCID as their only registered factor) | C, plus a G row with an ORCID linked (and a verified email, § 6.3) and a null-hash D row with an ORCID (upgraded from C, or finalized through `/link` from an ORCID-path F row): the handler gates on `password_hash` NULL with `orcid` set, not on custody. A and B return 409 (`PASSWORD_ALREADY_SET`); a G row whose email is unverified returns 409 (`PENDING_UNVERIFIED`), checked before the ORCID requirement; a null-hash row with no ORCID returns 403 (`ORCID_REQUIRED`). |
| Recover (lost email access, seed-phrase path) | `POST /api/auth/recover` (phase 1) + `POST /api/auth/recover/verify` (phase 2) | Seed-phrase derived memo key **AND** control of the new email. Phase 1 verifies the memo key and stages the swap; phase 2 applies it only after a token mailed to the new email is presented back. The old email receives a 48h dispute link that voids the staged swap. The memo-key proof alone no longer mutates the account — the email-control sub-proof is required on top. | All light states (A, B, C). Seed phrase works from any light state (every light signup produces one). |
| Recover (lost email access, ORCID path) | `POST /api/auth/recover` | Fresh ORCID OAuth round-trip matching the account's registered ORCID. Applies immediately and in one step — the OAuth round-trip is itself the email-side control proof the memo-key path lacks. Refused for any row whose derived custody claim (`custodyClaimFor`) is not `'light'`: D, and a G row with an ORCID, get the 401 and message a row with no ORCID gets. | B and C (the light states with `orcid IS NOT NULL`). |
| Reset (forgot password) | `POST /api/auth/reset-request` + `POST /api/auth/reset` | Email-link token | A and B (states with email AND password). C: not applicable. |
| Change email | `POST /api/settings/email` (change-email branch on existing row) | Fresh-auth proof matching a factor registered on the account. JWT path requires the proof in the body; Keychain (Hive-signature) path is fresh-proof at the middleware and requires no body proof. The add flow (no row) is Keychain-only: a JWT does reach it (`POST /api/auth/session` mints one for a row-less caller, and deleting a row leaves earlier JWTs live) and gets 401 with no row written. On a G row whose email is unverified the same POST re-issues the verification link (§ 6.3) instead of taking the change branch, behind the same JWT-path gate. | A: password proof. B: password OR ORCID proof. C: ORCID proof. D and G: on the JWT path an ORCID proof when linked, because the password issuer refuses their `'self'` claim; otherwise the Keychain path. Implemented at `settings.ts` POST /email (commit `b27bcdf`, audit closed by `backend-settings-email-reauth-audit` 2026-05-16). |
| Delete account data / right-to-erasure (erases the entire `accounts` row plus `notification_preferences` + `pending_recovery`, anonymizes `custody_audit_log`, and leaves `mailbox_bindings` rows untouched (§ 2 "Credential Bindings") — not just the email column) | `DELETE /api/settings/email` | Fresh-auth proof matching a factor registered on the account. JWT path requires the proof in the body; Keychain (Hive-signature) path is fresh-proof at the middleware and requires no body proof. | A: password proof. B: password OR ORCID proof. C: ORCID proof. D and G: on the JWT path an ORCID proof when linked, because the password issuer refuses their `'self'` claim; otherwise the Keychain path. no-row: n/a (no `accounts` row to delete; handler 401s). Implemented at `settings.ts` DELETE /email (commit `6dd1f8b5`): the JWT path requires the `delete_account` fresh-auth body proof, the Keychain (Hive-signature) path is fresh at the middleware. |
| Link ORCID, and ORCID accreditation (`mode='accredit'` writes the same `orcid` column on an unaccredited account) | `POST /api/orcid/start` then `POST /api/orcid/callback`, `mode='link'` or `mode='accredit'` | Fresh-auth proof matching a factor registered on the account, bound to the caller's username with target `(link_orcid, <username>, '')` or `(accredit_orcid, <username>, '')`. JWT path requires the proof in the `/orcid/start` body; Keychain (Hive-signature) path is fresh at the middleware. The OAuth round-trip proves control of the ORCID being added, not of the account, so it is not the re-auth proof. Decided 2026-10-07: a row's `orcid` is never replaced by a different ORCID. | A → B with a password proof. G → G, and a D row with no ORCID stays D, through the Keychain path: the password issuer refuses their claim and the row has no ORCID to prove. A row that holds a different ORCID is refused. No-row Keychain accounts use the Keychain path, and no row is written. |
| Request accreditation (the caller's own account: `name`, `institution`, `field` and the address the verification link goes to) | `POST /api/accreditation/request` | Fresh-auth proof bound to action `request_accreditation` and the caller's username (target `(request_accreditation, <username>, '')`). JWT path requires the proof in the body; Keychain (Hive-signature) path is fresh at the middleware. Decided 2026-10-06: the request sets the same `name` and `institution` the metadata edit guards, so a session alone does not suffice. | Light A/B with a password or ORCID proof and C with an ORCID proof on the JWT path; D and G with an ORCID proof on the JWT path, or the Keychain path; no-row Keychain on the Keychain path. |
| Verify an accreditation request | `POST /api/accreditation/verify` | The account's session or a per-request Hive signature, plus the single-use token mailed to the address given at `/request`. The token is bound to the requesting account, and a different account is refused. The address is the requester's choice, not a registered factor, so the token proves control of that mailbox, not of the account. | Any account holding a pending request, row or no-row. |
| Edit accreditation metadata (self-service: account owner edits own `name`/`institution`/`field`) | `PATCH /api/accreditation/metadata` | Fresh-auth proof bound to action `edit_accreditation_metadata` and the caller's username (target `(edit_accreditation_metadata, <username>, '')`). JWT path requires the proof in the body; Keychain (Hive-signature) path is fresh at the middleware. Request body `{ full_name?, institution?, field? }` (at least one field; bounds mirror `accreditationRequestSchema` — `full_name`/`institution` ≤ 200, `field` ≤ 100; `full_name`/`institution` reject line breaks, other control characters and the bidi embedding, override and isolate characters; min 1 per supplied field, NOT trimmed before the length check, matching the reused `accreditationRequestSchema` which does not trim either). Authorization is the caller's OWN current accreditation (currently accredited AND not sanctioned), NOT an admin roster level: the op is admin-key-signed (single signer) but human-authorized by the account owner editing their own profile. | All currently-accredited, non-sanctioned accounts (light A/B/C and self-custody/Keychain). |
| Release own accreditation (§ 2 "Credential Bindings": broadcasts the `type: "release"` revoke and frees the account's mailbox bindings) | `POST /api/accreditation/release` | Fresh-auth proof bound to action `release_accreditation` and the caller's username. JWT path requires the proof in the body; Keychain (Hive-signature) path is fresh at the middleware. Authorization is the caller's own current accreditation, as for the metadata edit, or a released account that still holds live rows (a retry after an uncertain broadcast); a sanctioned account cannot release (its bindings stay held). | All currently-accredited, non-sanctioned accounts (light A/B/C, D and G with an ORCID proof on the JWT path or the Keychain path, and no-row Keychain), plus a released account that still holds live rows. |

**SPA factor resolution (every "password OR ORCID proof" cell above).** Where the required factor is "a factor registered on the account", the web client decides which one to offer through a single resolver (`resolvePasswordFactor` in `frontend/src/lib/fresh-auth.js`) that reads `hasPassword` from `GET /api/settings/email`; no page or orchestrator resolves it on its own, and the resolver's answer is `{ usesPassword, assumed }`. The rules, in order of precedence:

1. **Password over ORCID when both are registered (state B).** The password modal is inline; the ORCID factor is a full-page navigation that discards page state.
2. **Only an explicit `hasPassword: false` routes to ORCID.** An unknown, absent, or failed status (the read is rate-limited per IP, and a department behind one NAT can exhaust it) falls through to the password prompt with `assumed: true`, and the backend, not the client, rejects a genuinely passwordless account (§ 6.5 invariant #2; both mint routes 401 a null hash behind a sentinel argon2 burn, so the client's guess opens no state oracle). A transient status failure must never be the thing that fires the navigating factor at someone who could have typed a password.
3. **An assumed factor's first mint rejection hands the action to ORCID.** For a guessed factor, a 401 at the password mint is at least as likely "no password registered" as a typo, and a second prompt would dead-end an account whose only factor is ORCID. The shared mint helper returns the ORCID-fallback outcome and every consumer maps it to its own ORCID factor; under a redirect-suppressed acquisition (the caller holds a picked file or a batch of pins the navigation would discard) it surfaces as the non-navigating `FRESH_AUTH_REAUTH_REQUIRED` refusal instead. An observed factor's 401 is a typo and earns exactly one re-prompt.
4. **A successful password mint is remembered for the tab, per username.** The verifying route outranks the status endpoint, so a rate-limited status cannot turn a proven password back into a guess on the next action. Two consecutive rejections at the mint route retire that memory (they outrank it exactly as one success did), because it can outlive the password it vouches for: the B → C drop (`recover(orcid, no new_password)`) can run in another tab, and a same-subject re-login deliberately keeps this tab's state, so without retirement every action would prompt for a password that no longer exists until a page reload. The next resolution re-reads the status and regains the escape in rule 3. A subject change scrubs the memory outright.
5. **`set_password` is the deliberate exception.** It targets a null-hash account by definition, so it takes the ORCID factor without consulting the status.

Known residual, not a defect: the auth middleware's dead-JWT rejection carries the same `UNAUTHORIZED` code as a wrong password, so it satisfies rule 3 under an assumed factor and counts toward rule 4's retirement under an observed one. Both cost at most one status re-read after the re-login the user needs anyway; a distinct code for the middleware 401 would be the durable separation if it is ever wanted.

### 6.4.1 Session-Proof Window

The two fresh-auth proof kinds have deliberately different lifetimes, because they defend different things.

**Consent-op kind** (`author_accept`, `author_resign`, the credit ops, and the settings critical actions) stays exactly as it is: bound to one target, spent once, 5-minute TTL. Its job is to stop a proof minted for one paper, slot, or co-author being redirected onto another, and that binding is structurally incompatible with reuse. Minted by password (`POST /api/custody/fresh-auth`) or ORCID (`POST /api/orcid/start mode='fresh_auth'`) per the factor rules in § 6.4.

**Session kind** is target-less and **multi-use inside a bounded window**. It exists so that a light account can work — vote, comment, review, post, vouch, upload — without a re-auth ceremony per action. Its contract:

- **Opened only by an explicit re-auth act.** A password entry at `POST /api/custody/session-auth`, or an ORCID round-trip at `POST /api/orcid/callback mode='session_auth'`. **Login MUST NOT mint or extend a session proof**, and no route may seed one as a side effect of session establishment. This is the line that keeps § 6.5 invariant #1 meaningful: if holding a session were sufficient to open a broadcast window, the fresh-auth layer would have collapsed back into the session layer.
- **Sliding idle expiry, 15 minutes.** Each successful consume slides the idle deadline forward. An active working stretch is never interrupted.
- **Absolute cap, 2 hours from first mint.** The window dies at the cap regardless of activity, so a proof exfiltrated alongside a JWT is worth at most 2 hours of broadcasting rather than the full 24-hour session lifetime. Reaching the cap costs one re-auth act.
- **Useless without a live session.** The consume checks the proof's bound username against the authenticated username, so an expired or revoked JWT makes the proof inert. On the JWT auth path, the consume also checks the proof's `issued_at` against `accounts.sessions_invalidated_at` (§ 6.7): a credential rotation stamps that column, and any session-kind proof minted at or before the stamped instant is rejected as expired on its next consume, whether or not the best-effort Redis sweep has removed it yet. This authoritative check does not run on the `X-Hive-Signature` auth path, where invalidation still depends on the sweep and on the window's own deadlines.
- **Accepted on the non-consent broadcast surface and on `POST /api/ipfs/upload-token`.** Rejected on the consent-op surface with `kind_mismatch`, unchanged.

**Acquire-before-commit.** A client MUST hold a valid session proof before beginning work whose loss would cost the user — selecting a file, uploading to IPFS, or entering a submit sequence. The ORCID factor acquires by full-page navigation and therefore destroys in-progress page state, so acquiring it mid-submit discards the user's work. Acquire first, then commit. This rule is what makes inline upload reachable for passwordless state C, whose only factor is the redirect.

**Why multi-use is not a weakening.** The alternative that preserves single-use in form is to hold the user's password in client memory and mint a fresh proof per broadcast. That is the same posture — one authentication act authorizing many broadcasts over a window — with the long-lived secret moved to the worse location. A held password has no server-side expiry, cannot be revoked, and unlocks the settings critical actions as well; a windowed session proof expires on a schedule the client cannot extend past the cap, dies with the session, and grants only broadcasting and uploads. The windowed proof is the stronger of the two.

### 6.5 Security Invariants

These invariants hold across every authenticated route. Code that violates an invariant is a security defect, not a stylistic preference.

1. **Critical actions require fresh re-auth proof.** A stolen JWT must not be a one-step takeover vector. JWT-only access on a critical action is a defect. "Fresh" is per-action for the consent-op kind and per-window for the session kind (§ 6.4.1); in both cases an explicit re-auth act must have happened, and possession of a valid session is never itself that act.
2. **Re-auth factor must match a factor the account has registered.** ORCID OAuth proof from an unrelated ORCID iD does not authenticate; password verification against a null hash does not authenticate; seed-phrase derived key proves possession only when the derived pubkey matches the on-chain account's posting/active key.
3. **Recovery proof must match a factor the account has registered.** State A (no ORCID) cannot recover via ORCID — no registered ORCID to prove against. State C (no password) cannot use `/reset` — no password to forget.
4. **State transitions only via the documented routes in § 6.3.** No code path may produce an `accounts` row that doesn't match a state in § 6.1. If a new state is needed, this section must be updated first and the transition added before code lands.
5. **Field-state inference is grounded in this section, not in code-side assumptions.** Reviewers MUST flag code that defends, branches on, or migrates `(verify_token, username, password_hash, orcid, custody, upgraded_at)` combinations not enumerated in § 6.1. Verbose-but-correct defense against the enumerated states is fine; defense against a state that doesn't exist is dead code that misleads future maintainers and reviewers.
6. **The seed phrase is the upgrade proof, not a session-auth factor.** UI derives a key from the BIP39 mnemonic locally and sends the derived pubkey to the backend. Backend verifies it matches the on-chain account's posting/active key via `getAccounts`. The seed phrase itself never leaves the client. Critical actions other than upgrade do not accept the seed-phrase-derived key as proof.
7. **The upgrade transition is one-way.** Once `upgraded_at` is set, the account is in state D forever. No "downgrade-to-light" route exists; the encrypted keys were destroyed during upgrade and cannot be reconstructed.
8. **Bearer JWTs must carry a numeric `iat`.** The session-invalidation revocation check (§ 6.7) rides entirely on `iat`; a bearer token with an absent or non-numeric `iat` is rejected 401 rather than skipping the lookup, so revocation completeness does not depend on the unenforced "every server mint sets `iat`" cross-file invariant.
9. **A session-proof window is never opened by session establishment.** Only an explicit re-auth act (password entry or an ORCID round-trip) may mint or extend a session-kind proof. No login, token refresh, or signup-finalization path may issue one as a side effect, and no client may extend a window past its absolute cap. Code that seeds a broadcast window from the act of logging in collapses the fresh-auth layer into the session layer and violates invariant #1 in substance while appearing to satisfy it.

### 6.6 Maintenance

When any of the following change, this section is updated in the same commit as the code change:
- New routes that write `verify_token`, `username`, `password_hash`, `orcid`, `custody`, or `upgraded_at`.
- New auth factors (a hypothetical hardware-key or WebAuthn factor would add columns and states).
- New critical actions (anything that broadcasts, mutates an auth factor, or transfers control).
- New transitions, even between existing states.

The section is referenced from root `CLAUDE.md` "Code Review Findings" guidance: reviewers must consult § 6.1 to verify any defended account state is actually reachable.

### 6.7 Session-Invalidation (`sessions_invalidated_at`) Overlay

`sessions_invalidated_at` is the session-revocation timestamp. It revokes bearer JWTs directly (below) and, per § 6.4.1, also bounds session-kind fresh-auth proof windows on the JWT auth path. Four credential-rotating routes stamp it: a password reset (`POST /api/auth/reset`), seed-phrase recovery (`POST /api/auth/recover/verify`), ORCID recovery (`POST /api/auth/recover`), and the custody upgrade (`POST /api/custody/upgrade`). The column is not scoped to light accounts: the upgrade stamps it in the same UPDATE that flips the row to `custody = 'self'`, so a self-custody row carries a meaningful epoch. On every authenticated route, the JWT path in `verifyHiveSignature` revokes any bearer token whose `iat` is at or before the invalidation second, EXCEPT the token reissued by that very event.

- **Survivor identity, not timestamp.** Second-granular `iat` cannot distinguish a pre-rotation token from the fresh token minted in the same integer second by the rotation itself. The three revoke-and-reissue sites (the two `routes/recover.ts` handlers and the custody-upgrade handler) therefore write `sessions_invalidated_at` from a Node `Date` and embed that exact epoch-ms in the reissued token's `reissuedAt` claim; the middleware spares the one token whose `reissuedAt` equals the stored epoch-ms (the revoke predicate is `iat <= invalidatedSec && reissuedAt !== invalidatedMs`). A pre-rotation token sharing the same second is revoked; the legitimate reissued one survives. `reissuedAt` is an internal opaque-token claim — clients never read or set it, so it is not part of the api-contract surface.
- **Round-trip invariant (do not break).** The identity match requires `reissuedAt` (epoch-ms embedded at mint) to equal `sessions_invalidated_at.getTime()` read back from Postgres. This holds because the column is `TIMESTAMPTZ` and the value is written from a millisecond-precision Node `Date`, so the write-then-read round-trip preserves `getTime()` exactly. Switching any reissue writer back to SQL `NOW()` (microsecond precision) or rounding to seconds would silently break same-second survival and log every user out immediately after the rotation. Keep the writer a Node `Date`.
- **`iat`-required** (§ 6.5 invariant #8). A bearer JWT with an absent or non-numeric `iat` is rejected 401 rather than skipping the lookup.
- **Known self-healing edge.** `POST /api/auth/reset` stamps `sessions_invalidated_at` but mints no token (the user logs in afterward via `POST /api/auth/login`, whose token carries no `reissuedAt`). A relogin completed within the same integer second as the reset is revoked on its first request (no matching `reissuedAt`) and the user logs in once more; the next login lands in a later second and survives. Accepted residual: the window is sub-second, the failure self-heals on the next login, and it affects only the email-reset path. The `reissuedAt` identity covers the other three writers, which each stamp and reissue in one handler.
- **Not read by the stuck-recovery lookups.** Neither Option C lookup consults `sessions_invalidated_at`, so a revocation does not block stuck-signup recovery. The `/link` lookup discriminates on `upgraded_at <= updated_at` instead; § 6.3's Option C note states the invariant and why a revocation term was rejected.

Client-visible effect: `verifyHiveSignature` emits `401 SESSION_INVALIDATED` (see `api-contracts/common.md`) on any authenticated route when the bearer token is revoked. The SPA signs the user out on the current page, says the account's sign-in details changed, and opens the sign-in prompt in place; clearing the stored session signs the browser's other tabs out as well. A rejection of a token the SPA has already replaced is ignored, and a newer session that another tab of the same browser has already saved is taken up instead of signing out. A live session-kind fresh-auth proof minted before the same credential rotation is a separate case: the bearer token carrying it may survive, but the proof itself is rejected on its next JWT-path consume as `401 FRESH_AUTH_REQUIRED` with `details.reason: "expired"` (§ 6.4.1), not `SESSION_INVALIDATED`. The SPA should treat that as a re-auth prompt for the gated action, not a full session logout.

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
| `revoke` (`type:"sanction"`) | `routes/admin.ts` `POST /api/admin/accreditation/sanction` | acting admin |
| `revoke` (`type:"release"`) | `routes/accreditation.ts` `POST /api/accreditation/release` (holder), `routes/admin.ts` `POST /api/admin/accreditation/release` (admin) | the account itself (holder path); acting admin (admin path) |
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
| `revoke` (`type:"release"`) on another account | ✓ | ✓ | ✓ |
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

Every admin authority action — accredit, sanction, retract, authorship grant/revoke, roster management, and `update_weights` — is a **critical action** under § 6.4. Per § 6.5 invariant #1, **JWT-only access is a defect**: each requires a **fresh re-auth proof** matching a factor registered on the caller's account, in addition to passing the roster-level check. A stolen admin JWT must not be a one-step path to broadcasting an authority op. The roster level and the re-auth proof are independent gates — both must pass before `broadcastAdminCustomJson` runs. (The self-service accreditation-metadata edit, `PATCH /api/accreditation/metadata`, is also admin-key-signed and a § 6.4 critical action, but it is **not** roster-gated: it is authorized by the editing account's OWN current accreditation, since the owner is editing their own profile metadata rather than exercising authority over others. See its § 6.4 row.)

## 8. Composer Drafts

The publish and edit pages keep a local draft so typed work survives a reload and the full-page ORCID round-trip a passwordless account takes to open a session-proof window (§ 6.4.1, acquire-before-commit). A draft is a convenience copy in the browser's `localStorage`. It is never a source of truth; the chain is.

**Shape.** One entry per account and composer target: `pevo-draft-publish:<account>` on the publish page, `pevo-draft-edit:<account>:<canonical author>:<canonical permlink>` on the edit page. The account and the paper are captured when the page loads (or, on the publish page, when an account first signs in under it), never read live from the auth store or the router params, so an instance cannot write under another account's or another paper's key. An entry carries the text fields, on the edit page the addressed-review ticks and the head marker the form was loaded against (§ 2 "Body, edits and versions"), and the attempt state of a broadcast whose outcome is unknown (see "Retries"). It does not carry attached files, which is why no acquisition gate may navigate over a held file unasked. Every write goes through the page's `_writeDraft`, reached two ways: the debounced save a watched field arms, and the synchronous flush every acquisition gate performs before it can navigate.

**A draft holds user work only.** The instance takes a baseline of the form once the prefill is done and both editors have normalised their content, and writes nothing until the form differs from that baseline. Until the baseline exists the form takes no input, so nothing typed while the editors load can be taken for the loaded form or be replaced by the restore that follows. A form that returns to the baseline drops the stored text fields; an entry left holding no state is removed. An instance with no account captured writes nothing, and on the edit page neither do accounts that cannot edit the paper. A signed-in account that is not yet accredited keeps drafting on the publish page. Entries under the keys used before this binding existed carry no account and cannot be told apart from load-time copies, so they are not restored: the first signed-in composer load deletes them.

**Restore is bound to the account and, on the edit page, to the head.** A page restores only its own account's entry. The edit page restores silently only when the draft's head marker equals the marker of the paper it just loaded, and then shows the same "draft restored" card with Discard that the publish page shows. When the markers differ, it restores nothing yet and shows a card saying the paper has a newer version than the draft, with Restore and Discard; when either marker is null, the card says the page could not check whether the paper changed. Restore replaces the newer version in the form with the draft and binds the draft to the current head; the card says so. Until the user picks one, the form is read-only and `_writeDraft` refuses, so nothing typed can overwrite the stored draft unseen. Explicit sign-out keeps an account's drafts; deleting the account removes them.

**The instance is bound to the account and the paper it loaded for.** When an account signs in that differs from the one the instance captured, or the edit route starts naming another paper, the page flushes its pending draft under the key it captured and remounts, once no submit is in flight. A landed instance is never replaced: it navigates to the paper itself (see "Landing is terminal"). On the publish page, a sign-in under an instance that captured no account adopts that instance instead: the form is kept and written under the new account's key. If that key already holds a draft, it is restored silently over a form that holds nothing typed yet; otherwise a choice card offers Restore and Discard, and the form is read-only until the user picks (decided 2026-10-01). An adoption whose choice card still stands is provisional (decided 2026-10-05): the instance has written nothing under that account's key, so another account that signs in before the user picks clears the card and adopts the instance in its place, and the author fields the first account's prefill filled are emptied first, so they take the new account's prefill. A change to no account (a sign-out, a session teardown) does not remount: the instance keeps drafting under the key it captured, so work typed after a teardown survives the trip to the sign-in page.

**Kept until the broadcast lands.** A refused or cancelled gate, a failed upload, a rejected broadcast, and the `FRESH_AUTH_REDIRECT_PENDING` outcome all leave the draft in place and the instance drafting and submittable. The round-trip is what the draft exists to survive.

**Landing is terminal for the composer instance.** "Landed" means the broadcast call resolved with a result other than the `FRESH_AUTH_REDIRECT_PENDING` sentinel, or the existence check found the post an earlier attempt of this draft was sent under (see "Retries"). It is what the instance knows, not what the chain holds: a resolved call means one API node validated the transaction against its own head and pending transactions, before any block includes it, and a rejected call can still have put the transaction on chain (see Limits). From the moment of landing:

1. **The draft is removed once.** On the edit page by the key captured at load, and on both pages ahead of any mounted check, because the draft outlives the component.
2. **The instance never writes a draft again.** The refusal lives in `_writeDraft`, the one function every writer passes through, not at the exits of the submit sequence.
3. **The instance accepts no further submit.** A native edit still holds its diff base, which the landed op has already changed, and the version reconstruction applies a patch fuzzily (as hivemind does) instead of rejecting it, so a second edit could apply the same change twice. A continuation or a first publication would address its post again.
4. **Nothing after that point ends in the failure state.** Follow-up work that can fail is best effort: it is caught where it is called, and it runs whether or not the component is still mounted, because the paper's readers need it and the component does not. The instance first waits, for at most about 15 seconds, until the head endpoint shows the landed op in the index; then, on the edit page, it requests the cache invalidation; then it navigates. The paper page's first read is therefore built from an index that holds the change. The post is on chain, so the user is told it succeeded.

**Why a barrier and not a clear at each exit** (decided 2026-09-30). A clear answers for one moment, and the form stays interactive after it. Every later await and every resting state is then a place where a writer can put the spent draft back, and a resting state has no exit to hang a clear on. Clears placed after later awaits also run by key once the component is gone, where they can delete a draft a later visit to the same paper wrote. Past the landing the barrier removes both problems: one clear, at landing, and no writer after it. Scoping each clear by the stored draft's `savedAt` was considered and not adopted: a timestamp cannot tell this instance's own late writes from a later visit's, and it leaves the resting-state writers open.

**What a native edit sends.** By default a `diff-match-patch` patch computed against the served chain body, which keeps an edit's chain footprint and resource-credit cost small. The form recomposes that body losslessly, and while both editors still hold their post-mount baseline the served text is used as is, so an untouched form reproduces the served body byte for byte even where an editor re-serialised it at mount. The first rule that matches decides:

1. A resubmit inside the landing window of an earlier attempt sends the full body (see "Retries").
2. A target other than the post the latest version belongs to (the last `versions[]` entry names another post) sends the full body, changed or not. The served chain body is then that other post's, and readers apply a patch to the target's own previous body.
3. An unchanged body (a title, keyword, author, citation, file or addressed-review edit) sends the no-op patch `@@ -0,0 +0,0 @@\n`, whatever characters the body holds. The chain rejects an empty body.
4. A patch that cannot be computed, or a body on either side that contains a character outside the Basic Multilingual Plane, sends the full body. The JavaScript and Python implementations count patch offsets differently for such characters, and hivemind would place the hunk somewhere else.
5. A target that is not the chain head, and a patch that is not shorter than the body, send the full body.

**The head check.** A native edit or a continuation reads the paper's head marker from the uncached head endpoint before its first gate and again right before its broadcast. When a kept permlink exists, the existence check (see "Retries") runs first and decides. When the marker differs from the one the page loaded, the instance flushes the draft, broadcasts nothing, and tells the user the paper has a newer version, possibly from their own earlier save, with a reload as the way through; the head endpoint evicts a cached paper detail that disagrees with it, so the reload converges. When the endpoint cannot be read or the marker is null, the instance broadcasts nothing, keeps the form and its attached files, and says it could not confirm the paper's current version and the user can try again.

**Retries.** A rejected broadcast may have landed: a custody 504 or 502, a lost response, a Keychain timeout. Neither the custody route nor Keychain tells these apart from a rejection that did not land, so the composers do not classify rejections. They make the retry safe instead:

- A first publication or a continuation mints its permlink once and keeps it in the draft, recorded right before the broadcast call. Before any send under a kept permlink, the instance asks the head endpoint whether that post exists. If it does, the earlier attempt landed, and the instance treats it as a landing (above): it removes the draft, accepts no further submit, and links to the post. If it does not, it sends under the same permlink, so an earlier attempt still in flight turns the resend into, at worst, an identical edit. If the check cannot be read, it sends nothing and says so. Discard, an account change and starting a new paper drop the permlink.
- A native edit records an attempt marker in the draft right before the broadcast call. Inside the landing window of a rejected attempt (90 seconds on the custody route, 11 minutes on Keychain: the transaction expiration plus a margin, counted from the rejection, or from the restore for a call that never settled), a resubmit sends the full body, which is a no-op over an earlier attempt that landed first. Past the window the earlier attempt can no longer land, the marker is dropped, and the head check decides.
- A submit that ends before its broadcast went out (a refused or cancelled last gate, a failed upload), and a rejection known not to have landed (the resource-credit refusal of § 1), restore the attempt state that existed before that submit: they add none of their own and clear no earlier attempt's.
- Besides the window expiry (which drops the marker) and the permlink drops listed above, only landing and Discard remove attempt state. A form that returns to its baseline keeps it.
- A repeat (an op that leaves a post's replayed body, title and metadata unchanged) stays in the history but does not make reviews of the earlier version outdated (§ 2 "Body, edits and versions").

**Why the retry is made safe rather than the rejection classified** (decided 2026-10-01). Branching on `BROADCAST_TIMEOUT` covers one of four ambiguous routes and never fires on the Keychain path. An `idempotency_key` covers the custody route only and cannot see a transaction that is accepted but not yet indexed. Refusing fuzzy patches in the reconstruction would show a body no other Hive frontend shows. Sending every native edit as a full body was rejected for footprint and resource credits: about 0.5 million RC per byte, against about 4.8 billion for an undelegated light account (§ 1 "Light-Account Resource Credits").

**Limits.** These are properties of the design as decided. Open questions about them are tracked as tasks, not here.

- **Landing is known only when the broadcast call resolves.** A resolved call is acceptance by one node, not inclusion: a transaction that node later drops (it expired, another transaction of the same account drained its RC, a conflicting op landed first) changes nothing on chain, and the barrier has already removed its draft. A rejected call can still land, and the client cannot tell, so a rejection keeps the draft. Losing typed work is worse than restoring a spent draft.
- **A retry is safe against an earlier attempt that lands before it, not after it.** An earlier patch still pending in a node that lands after its full-body retry is applied to the retried body. The window is that transaction's expiration: up to about a minute after a custody 504, up to ten minutes on Keychain (longer if the user's clock runs ahead, or if a Keychain popup was left open across a reload and confirmed later).
- **The head check narrows concurrent editing; it does not close it.** No read source sees a transaction that is accepted but not yet indexed (inclusion plus HAF lag, a few seconds), or one waiting in an open Keychain popup. Two instances that check inside that window both pass, and the second patch is merged fuzzily into the first.
- **A broadcast that never settles leaves the instance broadcasting.** PEvO sets no client-side timeout on either route (the Keychain extension's own timeout rejects, but a stalled response can leave its callback unanswered). Reloading is the exit; the attempt state recorded before the call makes the reloaded instance treat the attempt as unknown.
- **The landing clear removes whatever sits under the key when the broadcast resolves.** That includes a draft another tab of the same account wrote under that key while the broadcast was in flight; on the publish page every visit of one account shares one key, and with it a kept permlink. The window is one broadcast long, and the other instance writes again on its next change.
- **Edits made outside PEvO's composers are not announced.** An edit from another Hive frontend sends no invalidation, so the cached paper detail serves the earlier version until a head check evicts it or the entry expires (30 minutes).
- **A full-body send costs resource credits in proportion to the body.** Inside a retry window, a light account with a large body can be refused for RC. The refusal is clean (nothing landed), and a resubmit after the window sends a patch.
- **Attached files are not in the draft.** After a reload (a head-check refusal, a broadcast that never settled) they are selected and uploaded again, under the upload rate limit.
- **Drafts outlive an explicit sign-out.** On a shared browser the next user cannot restore them, but they remain readable in the browser's storage until the account is deleted.
- **A composer mounted in another tab writes a deleted account's draft back.** Deleting the account removes its drafts from the browser's storage, but another tab with a composer mounted for that account sees the deletion as a change to no account, which keeps the instance drafting under the key it captured, so its next change writes the draft back. That draft then stays in the browser's storage like one kept across a sign-out.
- **The rules cover the publish and edit composers only.** The review page and the comment composer mint a fresh permlink per submit, so a retry after a rejected broadcast that landed posts a second review or comment.

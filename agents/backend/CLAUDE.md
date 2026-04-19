# Backend Agent — PEvO

You are the Backend agent for PEvO. You build the Node.js/Express backend.

**Startup:** Follow the startup protocol in root `CLAUDE.md`. Use `agents/docs/ARCHITECTURE.md` and the API contract files (`agents/docs/api-contracts/*.md`) as references when needed, not as required reading every time. Read only the specific contract file for the domain you're working on (e.g. `api-contracts/auth.md` for auth endpoints).

## Responsibilities

- Maintain and extend the REST API (routes in `src/routes/`).
- HAF SQL queries for listings, search, reputation, and aggregated views (`src/hafsql.ts`).
- IPFS upload/pinning proxy and CID validation (`src/routes/ipfs.ts`).
- Accreditation flow: email verification, `custom_json` broadcast, Web-of-Trust vouching (`src/routes/accreditation.ts`, `src/routes/wot.ts`).
- Reputation batch computation and caching (`src/reputation-batch.ts`, `src/reputation.ts`).
- Bridge paper import from arXiv/Crossref (`src/bridge.ts`, `src/routes/bridge.ts`).
- Light account creation, custody broadcast, and key management (`src/routes/custody.ts`, `src/routes/signup-verify.ts`).
- Anonymous review proxy via `pevo.anon` account (`src/routes/anonymousReview.ts`).
- Notification system (`src/notification-queries.ts`, `src/routes/notifications.ts`).
- Blog content serving (`src/routes/blog.ts`).
- Search across papers, authors, and disciplines (`src/routes/search.ts`).

## Technical Context

- **HAF SQL** gives you a PostgreSQL database with all Hive chain data indexed relationally.
- For development without HAF, fall back to Hive API node queries via dhive with multi-node failover.
- **No mock data.** The backend always reads from real chain data. Fallback order: HAF SQL -> Hive API nodes (api.hive.blog, api.deathwing.me, anyx.io). See "Data Source Policy" in `ARCHITECTURE.md`.
- The backend holds the posting key for the `pevo.anon` account (anonymous reviews) and the `pevo.admin` account (accreditation attestations).
- **IPFS:** Uploads go to the local Kubo node via its HTTP API. Pinata is supported as a fallback when Kubo is unavailable (configure `PINATA_API_KEY` and `PINATA_SECRET_KEY`). Downloads are proxied through `GET /api/ipfs/:cid` which validates CIDs against known papers before serving.
- Reputation scores should be recomputed periodically (cron job or on-demand with cache TTL).

## Security Considerations

- **Light accounts:** The backend holds encrypted posting and memo keys for light account users (AES-256-GCM, per-account HKDF-derived key, master key in env). These are decrypted only during custody broadcast requests and immediately discarded. Owner and active keys are never stored.
- **Self-custody users** sign their own transactions via Keychain. The backend never holds their keys.
- The `pevo.anon` posting key must be stored securely (env var, not in code).
- The `pevo.admin` posting key must be stored securely (env var, not in code).
- The accreditation email flow must be rate-limited and abuse-resistant.
- IPFS uploads must be size-limited (10MB max) and content-type validated (PDF, PNG, JPEG, GIF, WebP, SVG, CSV, ZIP) with magic-byte verification.
- Anonymous review mappings are encrypted with AES-256-GCM, key in env var, 6-month TTL.

## Redis Conventions

- Redis is optional. The backend falls back to in-memory caching when Redis is unavailable.
- All Redis keys are prefixed with `${APP_TAG}:cache:` (e.g. `pevotest:cache:papers`). The `QueryCache` class in `src/cache.ts` handles this automatically.
- Use `hafCache.registerPeriodicRefresh()` for expensive HAF queries rather than `getOrSet` with long TTLs. See `startRetractionCache()` in `routes/papers.ts` for the pattern.

## Light Account Ownership

The backend owns server-side light account operations:
- Account creation via `create_claimed_account` tokens
- Encrypted storage of posting and memo keys (AES-256-GCM, HKDF-derived per-account key)
- Custody broadcast: decrypting keys on demand to sign `comment` and `vote` operations, then immediately discarding
- Key deletion when a user upgrades to self-custody

The frontend owns client-side light account operations (seed phrase generation, key derivation, owner/active key management). See the UI agent CLAUDE.md.

## Boundaries

- Do NOT modify files outside `backend/`.
- Do NOT build UI components.
- If you need a schema change, add a `[BLOCKED by Architect]` entry in `agents/docs/TASKS.md` explaining what you need.

## Available Resources

- **`agents/docs/api-contracts/*.md`** — REST API spec split by domain (auth, papers, reviews, profiles, accreditation, custody, ipfs, bridge, notifications, misc). Read `api-contract.md` for the index, then only the file relevant to your task. `common.md` has the response envelope, error codes, and auth notes.
- **`agents/docs/reputation-algorithm.md`** — Current reputation algorithm spec with voter weight convergence, activity-gated floor, and anti-sybil measures.
- **`backend/src/types/`** — TypeScript types for API responses, Hive data, and error codes.
- **`src/middleware/verifyHiveSignature.ts`** — Hive Keychain signature verification middleware.

## Guidance for Future Work

- **Task completion:** When you finish a task, immediately move it from Pending to the Review section in `agents/docs/TASKS.md`. Do not leave completed work in Pending. This is the only way the Architect knows your work is ready for review.
- Types live in `backend/src/types/`.
- **No mock data, no mocked database pools in tests.** See root `CLAUDE.md` for how to run them.
- HAF queries use inline CTEs in `src/hafsql.ts` — do not create or deploy HAF views.
- The accredited-only data policy applies to all new queries (votes, reviews, citations, reputation).

# Backend Agent — PEvO

You are the Backend agent for PEvO. You build the Node.js/Express backend.

**Startup:** Follow the startup protocol in root `CLAUDE.md`. Use `agents/docs/ARCHITECTURE.md` and the API contract files (`agents/docs/api-contracts/*.md`) as references when needed, not as required reading every time. Read only the specific contract file for the domain you're working on (e.g. `api-contracts/auth.md` for auth endpoints).

## Responsibilities

- Implement all API endpoints defined in the contract.
- Connect to HAF SQL (PostgreSQL) for reading indexed Hive data.
- Implement the IPFS upload/pinning proxy.
- Implement the accreditation request flow (email verification, `custom_json` broadcast).
- Implement the anonymous review posting service.
- Compute and cache reputation scores.

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
- **`agents/docs/haf-views.sql`** — HAF SQL view definitions. Note: the backend uses **inline CTEs** in `src/hafsql.ts` against raw `hafsql.*` tables, not deployed views. This file is a design reference only.
- **`agents/docs/reputation-algorithm-v3.md`** — Current reputation algorithm spec (v3) with voter weight convergence, activity-gated floor, and anti-sybil measures.
- **`agents/docs/keychain-integration.md`** — Hive Keychain signing flows. Backend signature verification is in `src/middleware/verifyHiveSignature.ts`.
- **`backend/src/types/`** — TypeScript types for API responses, Hive data, and error codes.

## Guidance for Future Work

- Follow the task workflow in root `CLAUDE.md` (agent coordination rule 6).
- Types live in `backend/src/types/`.
- **No mock data, no mocked database pools in tests.** See root `CLAUDE.md` for how to run them.
- HAF queries use inline CTEs in `src/hafsql.ts` — do not create or deploy HAF views.
- The accredited-only data policy applies to all new queries (votes, reviews, citations, reputation).

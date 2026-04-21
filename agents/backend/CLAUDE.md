# Backend Agent — PEvO

You are the Backend agent for PEvO. You build the Node.js/Express backend.

**Startup:** Follow the startup protocol in root `CLAUDE.md`. Use `agents/docs/ARCHITECTURE.md` and the API contract files (`agents/docs/api-contracts/*.md`) as references when needed, not as required reading every time. Read only the specific contract file for the domain you're working on (e.g. `api-contracts/auth.md` for auth endpoints).

**Parallel task execution:** When `agents/docs/tasks/pending/` has multiple `backend-*.md` files, fan out rather than working sequentially:
1. Group pending task files by the code paths they touch. Tasks whose deliverables are independent files (e.g. different `src/routes/*.ts` or separate test files) can run in parallel; tasks that overlap on the same file must run sequentially in the parent.
2. Dispatch each independent task file as an `Agent` call with `isolation: "worktree"` and `subagent_type: "general-purpose"`. Brief the subagent with the task file path, point it at its task file under `tasks/pending/`, and instruct it to execute `/ce-work` scoped to that single task, stop before `git mv`ing to `tasks/review/`, and return its worktree path plus a short summary.
3. Subagents MUST NOT move task files between `tasks/` subdirectories or run the full vitest suite. The parent merges each returned worktree diff, then serializes (a) the `git mv tasks/pending/<slug>.md tasks/review/` move and (b) `npx vitest run` after all worktrees are merged. Tests hit real Postgres/Redis, so concurrent suite runs will collide on shared fixtures.
4. Fall back to single-task execution when only one task is pending or all pending tasks overlap on the same files.

Before any fan-out, the parent MUST commit in-flight work — see root `CLAUDE.md` "Commits and Pushes". Dirty-tree fan-out creates silent drift between workers.

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

## Boundaries

- Do NOT modify files outside `backend/`.
- Do NOT build UI components.
- **Do NOT edit `agents/docs/api-contracts/*.md`.** Those are architect-owned. When a route change requires a contract update, add a `[TODO Architect]` note inside the task file (before you `git mv` it to `tasks/review/`) describing the prose/example change required. The architect updates the contract during review. See `agents/docs/solutions/conventions/backend-api-contracts-are-architect-owned-2026-04-21.md` for rationale.
- If you need a schema change, `git mv` your task file to `agents/docs/tasks/blocked/` and append a `[BLOCKED by Architect]` note explaining what you need.

## Available Resources

- **`agents/docs/api-contracts/*.md`** — REST API spec split by domain (auth, papers, reviews, profiles, accreditation, custody, ipfs, bridge, notifications, misc). Read `api-contract.md` for the index, then only the file relevant to your task. `common.md` has the response envelope, error codes, and auth notes.
- **`agents/docs/reputation-algorithm.md`** — Current reputation algorithm spec with voter weight convergence, activity-gated floor, and anti-sybil measures.
- **`backend/src/types/`** — TypeScript types for API responses, Hive data, and error codes.
- **`src/middleware/verifyHiveSignature.ts`** — Hive Keychain signature verification middleware.

## Compound Engineering Skills

Use these ce skills as part of your normal workflow. They are not optional — invoke them when the trigger matches.

- **`/ce-work`** — Invoke this when you start executing a task from `agents/docs/tasks/pending/`. It structures the execution loop (plan, implement, verify).
- **`/ce-debug`** — When a test, build, or runtime fails and the cause isn't immediately obvious. Use it before trying speculative fixes.
- **`/ce-sessions`** — When `/ce-debug` stalls or the task touches an area that has failed before. Check prior-session investigations before speculating. Complements `agents/docs/solutions/` (curated) — sessions are the raw history.
- **`/ce-brainstorm`** — When the user's request is too broad for a single clarifying question (see root `CLAUDE.md` "Asking Questions"). Use before implementing.
- **`/ce-simplify`** — Final pass after implementation, before moving the task to Review, to cut any over-engineering. Do NOT invoke `/ce-code-review`; code review is the Architect's job during the Review→archive cycle.
- **`/ce-compound`** — Gated by the checkpoint in the Task completion bullet below. Do not invoke on every task.

**Commit policy:** see root `CLAUDE.md` "Commits and Pushes".

## Guidance for Future Work

- **Task completion:** `git mv agents/docs/tasks/pending/<slug>.md agents/docs/tasks/review/` per root rule #7. Before moving, check whether the task surfaced a non-obvious learning worth `/ce-compound`; err on the side of skipping.
- **Re-review signal:** after landing fixes for a held task, append a `Backend re-review signal (<date>, working tree or commit SHA):` block to the task file in `tasks/review/`, under the architect's hold block, per root rule #8.
- **No mock data, no mocked database pools in tests.** See root `CLAUDE.md` for how to run them.
- HAF queries use inline CTEs in `src/hafsql.ts` — do not create or deploy HAF views.
- The accredited-only data policy applies to all new queries (votes, reviews, citations, reputation).

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

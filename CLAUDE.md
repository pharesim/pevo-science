# PEvO — Publish and Evaluate Onchain

A decentralized platform for open scientific publication and interactive evaluation, built on the Hive network. Non-profit, AGPL-3.0-licensed, forkable.

## Core Design Principles

### 1. Hive-native, not Hive-wrapped
Posts are Hive posts. Comments are Hive comments. Votes are Hive votes. We use the chain as it was designed, not as a dumb data store. PEvO-specific content is identified by `APP_TAG` (`pevotest` in the beta phase) and structured `json_metadata`.

### 2. Reputation is computed, not tokenized
No custom token. Scientist reputation scores are derived from on-chain activity (publications, reviews, citations, community votes) via SQL queries against HAF (Hive Application Framework) / HafSQL. The algorithm is transparent, configurable, and forkable.

### 3. Accreditation is the trust layer
Anyone can post on Hive. PEvO adds a verified-scientist filter. Accreditation links a Hive account to a real researcher identity. Unaccredited users can only read. Publishing, reviewing, commenting, and voting are restricted to accredited accounts.

### 4. IPFS for large files
Papers >64KB are uploaded to IPFS. The IPFS CID is stored in post `json_metadata`. The post body contains the abstract, title, authors, and metadata. Short papers can live entirely in the post body as Markdown.

### 5. Privacy by design
Anonymous reviewing via a platform-managed proxy account that posts comments on behalf of accredited reviewers. The mapping is stored encrypted, time-limited, and only used for abuse prevention.

### 6. Progressive decentralization
The accreditation service starts centralized (simple server verifying university emails + issuing on-chain attestations via `custom_json`). Over time, accreditation can move to a DAO vote or web-of-trust model. The architecture must not hard-depend on the centralized component.

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Network | Hive (DPoS, 3s blocks, fee-less, native content operations) |
| Data layer | HAF SQL (PostgreSQL-based indexed view of all Hive chain data) |
| File storage | IPFS (self-hosted Kubo node; Pinata as optional fallback) |
| Frontend | Alpine.js + Vite + Tailwind CSS |
| Hive interaction | `@hiveio/dhive` (JS library for Hive operations) |
| Backend | Node.js + Express (accreditation service, IPFS pinning proxy, HAF query API) |
| Auth | Hive Keychain (self-custody) or email+password with JWT (light accounts) |

## Hive-Specific Conventions

### Posting
Use `client.broadcast.comment()` from dhive. Parent author = `''` and parent permlink = `APP_TAG` for top-level posts. Include `json_metadata` with `app: APP_TAG`, `tags: [APP_TAG, 'science', ...]`, and PEvO-specific fields.

### Custom JSON
Use `custom_json` with `id = APP_TAG` for operations that don't map to native Hive ops (accreditation attestations, anonymous review mappings, rating algorithm parameter updates, votes after the 7-day window).

### Reading Data
Query HAF SQL for aggregated views. Use Hive API nodes for real-time data. Cache aggressively on the frontend.

### Account Creation
Two paths: (1) **Self-custody** — user brings an existing Hive account and connects via Hive Keychain. (2) **Light accounts** — PEvO creates a real on-chain Hive account using `create_claimed_account` tokens. A 12-word BIP39 mnemonic is generated client-side (never sent to backend). All four key pairs are derived from it. Owner and active private keys never leave the browser. Only posting and memo private keys are sent to the backend, encrypted with AES-256-GCM (per-account HKDF-derived key, master key in env), and stored for server-side signing of allowed operations (comment, vote only). Light account users can upgrade to self-custody by rotating keys via their seed phrase, after which encrypted keys are deleted from the server.

## Project-Wide Conventions

- **Single `.env` file.** No `.env.production` or environment-specific env files. The `.env.example` serves as the template.
- **No Hive rewards as a value proposition.** We don't care about tokens. Focus on censorship resistance, reputation, structured review, decentralization.
- **No emdashes (—) in user-facing text.** Use periods, commas, or restructure sentences instead.

## Agent Coordination Rules

1. Agents communicate ONLY through files in the repo. No shared memory.
2. The **Architect agent** owns `agents/docs/ARCHITECTURE.md` and `agents/docs/TASKS.md`. It does NOT write standalone spec or contract files. The code is the source of truth for API shapes, data models, and schemas. If something needs documenting, put it in `ARCHITECTURE.md` or inline in the code.
3. The **UI agent** reads the code and `ARCHITECTURE.md` to understand interfaces. It does NOT define API shapes.
4. The **Backend agent** reads the code and `ARCHITECTURE.md` to understand interfaces. It does NOT change API shapes without updating `ARCHITECTURE.md` and notifying via a TODO in `agents/docs/TASKS.md`.
5. If an agent is blocked, it adds a `[BLOCKED by <agent>]` entry in `agents/docs/TASKS.md` explaining what it needs. The blocking agent resolves it there.
6. When a task is complete, the implementing agent moves it from Pending to a **Review** section in `agents/docs/TASKS.md`. The Architect reviews the implementation, then **physically moves** the task from `TASKS.md` to `agents/docs/tasks-archive.md`. Do NOT use strikethrough (`~~`) to mark tasks done in `TASKS.md`. Completed tasks must be removed entirely.
7. **No spec file sprawl.** Do not create new files in `agents/docs/` (except inside `api-contracts/`). The allowed files are: `ARCHITECTURE.md`, `TASKS.md`, `tasks-archive.md`, `api-contract.md` (index), `api-contracts/*.md` (split contract files), `hive-schemas.md`, and `reputation-algorithm.md`. Keep these up to date when making related code changes, but do not create additional spec or contract files.

## Local Dev Deployment

Local dev runs via Docker using `./deploy.sh`. Common commands: `./deploy.sh restart` (rebuild + restart + migrate), `./deploy.sh logs` (tail logs), `./deploy.sh up` / `./deploy.sh down`, `./deploy.sh migrate` (run SQL migrations).

## Running Tests

Use `source ~/.nvm/nvm.sh && nvm use 20` before running tests. Docker containers (Postgres, Redis) are only reachable via their Docker network IPs (not localhost). Find them with `docker inspect <container> --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'` and override env vars:

```bash
REDIS_URL="redis://:$(grep REDIS_PASSWORD .env | cut -d= -f2)@$(docker inspect pevo-redis-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'):6379" \
APP_DATABASE_URL="postgresql://pevo:pevo_dev@$(docker inspect pevo-postgres-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'):5432/pevo_app" \
npx vitest run
```

Tests run against real HAF + Hive API. No mock data, no mocked database pools.

## Startup Protocol (applies to ALL Claude instances)

**Do NOT explore the codebase on startup.** No recursive `ls`, no globbing `**/*`, no "let me understand the full project structure" sweeps. This wastes context and time.

Instead, follow this sequence:

1. Read the relevant `agents/<role>/CLAUDE.md` for your role (if acting as a specific agent).
2. Read `agents/docs/TASKS.md` — check for pending tasks assigned to you.
3. Read only the files needed for the current task.
4. If a task assigned to you is pending, verify the issue, double check the implementation, and if everything checks out implement it. If not prompt the user.

This applies equally to top-level Claude, subagents, and Explore agents. If you are asked to "initiate" an agent, follow that agent's startup protocol — do not delegate to a broad exploration pass.

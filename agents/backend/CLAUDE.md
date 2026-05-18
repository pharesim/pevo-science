# Backend Agent — PEvO

You are the Backend agent for PEvO. You build the Node.js/Express backend.

**Startup:** Follow the startup protocol in root `CLAUDE.md`. Use `agents/docs/ARCHITECTURE.md` and the API contract files (`agents/docs/api-contracts/*.md`) as references when needed, not as required reading every time. Read only the specific contract file for the domain you're working on (e.g. `api-contracts/auth.md` for auth endpoints).

**Parallel task execution:** When `agents/docs/tasks/pending/` has multiple `backend-*.md` files, fan out rather than working sequentially:
1. Group pending task files by the code paths they touch. Tasks whose deliverables are independent files (e.g. different `src/routes/*.ts` or separate test files) can run in parallel; tasks that overlap on the same file must run sequentially in the parent.
2. Dispatch each independent task file as an `Agent` call with `isolation: "worktree"` and `subagent_type: "general-purpose"`. Brief the subagent with the task file path, point it at its task file under `tasks/pending/`, and instruct it to execute `/ce-work` scoped to that single task, stop before `git mv`ing to `tasks/review/`, and return its worktree path plus a short summary. **Include in the brief: "Stage only the files you edited for this task, as an explicit path list (`git add backend/path/to/file1 backend/path/to/file2 …`). Never `git add -A`, `git add .`, or broad directory adds like `git add backend/`. The repo's `commit-msg` zone-audit hook rejects cross-zone commits — see root CLAUDE.md 'Commits and Pushes'."** General-purpose subagents do not auto-load `agents/backend/CLAUDE.md`, so the parent must propagate the staging directive into the worker brief.
3. Subagents MUST NOT move task files between `tasks/` subdirectories or run the full vitest suite. The parent merges each returned worktree diff, then serializes (a) the `git mv tasks/pending/<slug>.md tasks/review/` move and (b) `npx vitest run` after all worktrees are merged. Tests hit real Postgres/Redis, so concurrent suite runs will collide on shared fixtures.
4. Fall back to single-task execution when only one task is pending or all pending tasks overlap on the same files.

Before any fan-out, the parent MUST commit in-flight work — see root `CLAUDE.md` "Commits and Pushes". Dirty-tree fan-out creates silent drift between workers.

**Worker subagent staging:** Stage only the files you edited for the current commit, as an explicit path list — `git add backend/path/to/file1 backend/path/to/file2 agents/docs/tasks/<dir>/backend-<slug>.md`. Never `git add -A`, `git add .`, or broad directory adds like `git add backend/` or `git add agents/docs/`. Build the list from your own session memory of what you wrote, cross-checked against `git status`; anything you didn't edit stays unstaged for the parent or sibling agents to pick up. Backend's zone (everything under `backend/`, plus the backend task file) is the upper bound of what you're *permitted* to stage; the per-commit list is the narrower subset you *actually edited*. The repo's `commit-msg` zone-audit hook (see root `CLAUDE.md` "Commits and Pushes") is a backstop, not a substitute — leaning on it produces unstage/restage round-trips.

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
- **Do NOT edit `agents/docs/api-contracts/*.md` under any circumstances.** Those are architect-owned. When a route change requires a contract update, add a `[TODO Architect]` note inside the task file (before you `git mv` it to `tasks/review/`) describing the prose/example change required. The architect updates the contract during review.
  - This rule is **categorical**. A hold-block item that says "update `agents/docs/api-contracts/X.md`" does **not** delegate the edit back to the backend — it means the architect will make the contract edit themselves during the re-review pass. Hold-block items that need both a code change and a contract change split into two lanes: the code change lands in the backend's round-N fix commit, the contract change lands in the architect's archive-time edits. Both must be in place before archive.
  - If a hold-block item ambiguously seems to ask backend to edit a contract file, treat the ambiguity as the architect's error and resolve it as "backend lands the code; architect lands the contract." Move the task to `blocked/` with a `[BLOCKED by Architect]` note asking for disambiguation if the required code change is unclear without contract context.
  - See `agents/docs/solutions/conventions/backend-api-contracts-are-architect-owned-2026-04-21.md` for rationale.
- **Any time a task is waiting on another agent — architect, ui, pinner, anyone — you cannot proceed without** (schema changes, API contract shape changes, UI-side input on a proposed contract shape, a decision that conflicts with the task description, an ambiguous requirement, any design or coordination question), `git mv` the task file from `agents/docs/tasks/pending/` to `agents/docs/tasks/blocked/` and append a `[BLOCKED by <Agent>]` note describing exactly what you need. This is root `CLAUDE.md` rule #6 and it applies to *every* cross-agent blocker, not just architect ones. Do NOT leave the task in `pending/` with an inline TODO, question, or comment for the blocking agent. Startup protocols scan `blocked/` for `[BLOCKED by <self>]` entries; they do not grep `pending/` for inline questions. A blocker recorded anywhere other than `blocked/` is a blocker no one will see.

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
- **Re-review signal:** after landing fixes for a held task (the file lives in `tasks/pending/` after the architect's hold-block move per root rule #8), append a `Backend re-review signal (<date>, working tree or commit SHA):` block to the task file, under the architect's hold block. Either sequence is acceptable for the file's final state: (a) append-and-move in the same commit, or (b) append the signal block in commit N with the file still at `pending/`, then `git mv` the file to `review/` in commit N+1. The `git mv` is what signals the architect to re-review; the in-between dirty state is fine because a signal block in `pending/` is just a preview of the forthcoming re-review. Do NOT edit or mark items inside the hold block itself — the commit diff is the evidence, the architect updates the hold block during re-review.
- **No mock data, no mocked database pools in tests.** See root `CLAUDE.md` for how to run them.
- HAF queries use inline CTEs in `src/hafsql.ts` — do not create or deploy HAF views.
- The accredited-only data policy applies to all new queries (votes, reviews, citations, reputation).

## Redis Conventions

- Redis is optional. The backend falls back to in-memory caching when Redis is unavailable.
- **All Redis keys are prefixed with `${config.appTag}:<domain>:`** where `<domain>` is an open set naming the semantic namespace of the key. Keys are NOT all `:cache:` — the deployment runs locks, rate-limit buckets, OAuth state tokens, replay guards, and ORCID verification receipts alongside caches, and each gets its own domain segment. Domains currently in use: `cache`, `rl` (rate limits), `replay` (signature-replay guard), `orcid_state` (OAuth state), `orcid_binding` (bind cache), `orcid_binding_lock` (CAS lock), `orcid_verified` (verification receipt), `anon_mapping` (anonymous-review mapping), `ipfs:pending` (IPFS upload tracking), `pending_accred` (pending accreditation tokens), `reputation:cycle` + `reputation:batch` (reputation batch state). New domains are fine; pick a short namespace-like segment.
- The `${config.appTag}:` segment is the load-bearing part — it prevents collision between deployments (`pevo` vs `pevotest`) sharing a Redis instance. The `<domain>` segment is semantic and per-site.
- The `QueryCache` class in `src/cache.ts` handles appTag + caller-supplied prefix automatically. Direct `redis.*` calls must build the full prefixed key themselves (see `routes/orcid.ts` for examples).
- Rationale and audit recorded in `tasks-archive.md` → BE-REDIS-KEY-NAMING-CONVENTION-SWEEP.
- Use `hafCache.registerPeriodicRefresh()` for expensive HAF queries rather than `getOrSet` with long TTLs. See `startRetractionCache()` in `routes/papers.ts` for the pattern.

## Light Account Ownership

The backend owns server-side light account operations:
- Account creation via `create_claimed_account` tokens
- Encrypted storage of posting and memo keys (AES-256-GCM, HKDF-derived per-account key)
- Custody broadcast: decrypting keys on demand to sign `comment` and `vote` operations, then immediately discarding
- Key deletion when a user upgrades to self-custody

The UI agent owns client-side light account operations (seed phrase generation, key derivation, owner/active key management). See the UI agent CLAUDE.md.

## Linting

Backend has a minimal ESLint flat config at `backend/eslint.config.mjs` with `@typescript-eslint/no-floating-promises` as the load-bearing rule (catches fire-and-forget on safety primitives like `burnSentinel` and `withOrcidBindingLock`). Run `npm run lint` from `backend/` before committing changes that touch `src/`. `npm run lint:fix` applies auto-fixes for the small subset that supports it. Warnings for `@typescript-eslint/no-explicit-any` are acceptable at Express/dhive/pg boundaries.

## Typecheck

`npm run typecheck` from `backend/` runs `typecheck:src` (root `tsconfig.json` against `src/`) and then `typecheck:tests` (`tests/tsconfig.json` against `src/` + `tests/`). Both must pass before committing. The chained gate catches typos in fields of typed log payloads (`LogContext`) and other test-file drift that would otherwise only surface at runtime.

The tests-tsconfig overrides the root's Node16 module setting to `module: ESNext` + `moduleResolution: Bundler`. Top-level `await` is permitted in test files (the root's CJS-by-default classification forbade it). `vitest/globals` is in `types:[]` so `describe`/`it`/`expect`/`vi`/`beforeEach` are available without per-file imports. New test files inherit both — no per-file tsconfig fields needed. Mocked-pool tests that wire `vi.fn` around a polymorphic shape (e.g., `pool.query`) should type the factory with `vi.fn(async (..._args: any[]) => ({ rows: [] as any[] }))` so per-test `mockImplementation`s with various (sql/params) signatures and row shapes type-check cleanly. The looser typing is intentional at the boundary between vitest's call-signature inference and the actual pg/dhive surfaces; production code keeps strict types.

## Comment anchors

Write comments and docblocks against stable invariants — not against task coordination state or line numbers. Two specific failure modes recur often enough that they have their own conventions:

- **Task-slug citations rot on archive.** Per `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`, do not embed task slugs (`backend-foo-bar`), round numbers (`round-3 hold item 2`), or "see the task file" redirects in production or test code. Task files archive into `agents/docs/tasks-archive.md`, which trims from the bottom at 250 lines — older entries fall off entirely. The citation becomes a dead pointer; the round number loses meaning. Anchor on behavioral semantics ("per-attempt correlator", "see `/resume-signup` handler") instead.

- **Line-number anchors drift.** Per `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`, do not cite specific line numbers in code comments or docblocks (`hafsql.ts:371`, `accreditation.ts:919`, `now ~337`). Any edit above the referenced line silently stales the anchor; the `~N` tilde-approximation form acknowledges the rot but does not resolve it. Anchor on exported function names, CTE labels, route handler paths, or other stable symbols.

Coordination context — round numbers, hold items, task slugs — belongs in commit messages and task files, not in production or test source. The same rule applies inside `agents/docs/solutions/` entries (those persist, but slug+round qualifiers in their bodies still rot when the cited task archives). The `commit-msg` zone-audit hook is the runtime backstop for ownership; these anchoring conventions are the durability backstop for everything else.

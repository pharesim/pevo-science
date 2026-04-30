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

- **Single `.env` file for deployment.** No `.env.production` or other deployment-environment-specific env files. The `.env.example` serves as the template. **E2E-test-only exception:** `frontend/.env.test` (gitignored) is permitted to hold E2E-only secrets that MUST NOT leak from the production `.env` — e.g. a separate `SESSION_SECRET` or `E2E_SESSION_SECRET` used for minting test JWTs. The point of the split is to prevent E2E fixtures from accidentally authenticating against a live deployment via shared-secret reuse. `frontend/.env.test.example` is the template.
- **No Hive rewards as a value proposition.** We don't care about tokens. Focus on censorship resistance, reputation, structured review, decentralization.
- **No emdashes (—) in user-facing text.** Use periods, commas, or restructure sentences instead. "User-facing text" includes HTTP response strings, UI copy, and integrator-facing API contract docs (`agents/docs/api-contracts/*.md`). It does NOT include operator logs, code comments, commit messages, or task/coordination files.
- **API consumer surface is the frontend SPA.** PEvO's HTTP API has one consumer today: the Alpine+Vite frontend served by the same backend. There is no MCP server, no LLM-facing tool registry, no headless SDK, and no third-party agent integration. AGPL forks may build their own integrations later; the beta-stability stance in `agents/docs/api-contracts/common.md` covers them. When `/ce-code-review` surfaces "agent-native" findings (the always-on `ce-agent-native-reviewer` persona), reframe them as **ops/monitoring concerns** (canaries, status probes, log correlation) — those are the closest things to "agents" against PEvO's API today. Findings that assume LLM-driven agents, headless API clients, typed-SDK consumers, or MCP tools should be dismissed unless a concrete PEvO agent surface lands first. The persona's lens fits projects with agent integrations; PEvO is not one of those projects yet.

## Agent Coordination Rules

1. Agents communicate ONLY through files in the repo. No shared memory.
2. The **Architect agent** owns `agents/docs/ARCHITECTURE.md` and the `agents/docs/tasks/` tree. It does NOT write standalone spec or contract files. The code is the source of truth for API shapes, data models, and schemas. If something needs documenting, put it in `ARCHITECTURE.md` or inline in the code. **Commit-time enforcement of the agent ownership boundaries lives in `.githooks/commit-msg`'s `allowed_for_agent()` function** (the runtime-authoritative zone map); this rule's narrative and `agents/architect/CLAUDE.md` "Files You Own" are derived references — see "Commits and Pushes" below.
3. The **UI agent** reads the code and `ARCHITECTURE.md` to understand interfaces. It does NOT define API shapes.
4. The **Backend agent** reads the code and `ARCHITECTURE.md` to understand interfaces. It does NOT change API shapes without updating `ARCHITECTURE.md` and notifying via a TODO (a new pending task file or an appended note on an existing task in `agents/docs/tasks/`).
5. **Tasks are files, not sections.** Each task lives in its own file under `agents/docs/tasks/{pending,review,blocked}/<role>-<kebab-summary>.md`. State transitions are `git mv` between section directories. See `agents/docs/tasks/README.md` for slug format, file shape, and transition table. This per-task-file layout exists so agents editing different tasks never conflict on a shared bulletin-board file.
6. When a task is blocked, move its file to `agents/docs/tasks/blocked/` and append a `[BLOCKED by <agent>]` note explaining what's needed. The blocking agent moves it back to `pending/` once resolved.
7. When a task is complete, the implementing agent `git mv`s the file from `pending/` to `review/`. The architect reviews, then **archives** the task: prepend its contents to `agents/docs/tasks-archive.md` under a `## <Title> (archived <YYYY-MM-DD>)` heading, trim `tasks-archive.md` from the bottom to at most **250 lines** (older entries drop off; full history remains in git), and `git rm` the per-task file. Do NOT use strikethrough (`~~`) to mark tasks done. Completed task files are deleted entirely from `tasks/`.
8. **Review → held-pending-fixes → re-review cycle.** When the architect reviews a task in `review/` and finds issues that block archive, the architect appends an **`Architect re-review (<date>) — HELD PENDING FIXES:`** block to the task file listing the fixes, then `git mv`s the file back to `tasks/pending/`. The move puts the task back in the implementer's startup listing — held tasks that stayed in `review/` were invisible to implementers at startup, defeating the handoff. When the implementer lands the fixes, they `git mv` the file back to `tasks/review/`; the move itself is the re-review signal (the architect's next review pass picks it up). Implementers do NOT edit the hold block or mark findings as fixed inside it — the commit diff is the evidence; the architect updates the hold block during re-review. If a held task also becomes blocked on another agent's decision mid-cycle, move it to `blocked/` with a `[BLOCKED by <agent>]` note per rule #6; otherwise it lives in `pending/` until the implementer moves it back to `review/`.
9. **No spec file sprawl.** Do not create new files in `agents/docs/` (except inside `tasks/`, `api-contracts/`, and `solutions/`). The allowed files are: `ARCHITECTURE.md`, `tasks-archive.md`, `api-contract.md` (index), `api-contracts/*.md` (split contract files), `hive-schemas.md`, `reputation-algorithm.md`, `tasks/**/*.md` (per-task files + README), and `solutions/**/*.md` (see "Documented Solutions" below). Keep these up to date when making related code changes, but do not create additional spec or contract files.

## Commits and Pushes

Agents MAY `git commit` locally at natural checkpoints without asking: a task moving to Review, before a worktree fan-out, before handing off a long investigation, before switching context between unrelated tasks. Invoke `/ce-commit` for a message matching repo convention. Local commits are invisible to GitHub and fully reversible (`git reset --soft HEAD~N`, interactive rebase, drop, squash, amend).

**Every commit message MUST end with a `Co-Authored-By:` trailer identifying the authoring model**, e.g.:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

This applies to `/ce-commit`, manual `git commit`, worker subagent commits, and pre-fan-out checkpoint commits. Pass the message via HEREDOC so the blank line before the trailer survives. If running under a different Claude model (Sonnet, Haiku, a different Opus version), substitute the correct model name in the trailer, but never omit the trailer. `/ce-commit` sometimes drops it; re-check the last commit with `git log -1` after invoking the skill and amend the trailer in if missing.

Agents MUST NOT perform any remote-facing action without an explicit user ask for that specific action. This includes `git push` (any form), `gh pr create`, `gh pr edit`, `gh pr comment`, `gh issue create/comment`, `gh release`, and any `/ce-*-push*` / `/ce-*-pr*` skill that pushes or opens PRs. "Push" authorization is per-invocation: "push this" authorizes one push, not subsequent pushes.

**Before a worktree fan-out, the parent agent MUST commit in-flight work on the current branch** so worker subagents branch from a stable HEAD. Dirty-tree fan-out creates silent inconsistencies where workers operate on stale code and the parent must manually merge drifted changes later.

Commit scope rule: keep commits focused. Don't bundle unrelated task work into a single commit. A "checkpoint" commit that captures in-flight work before a fan-out is acceptable when the work is all on one task or one logical batch; if the tree has cross-task drift, prefer multiple focused commits over one mixed one.

**Subject-prefix style for agent commits.** Agent commits MUST use the bare `<role>:` or `<role>(<scope>):` form, where `<role>` is `architect`, `backend`, `ui`, or `pinner`. Examples: `backend: ...`, `backend(auth): ...`, `architect(compound): ...`. Conventional-commit wrappers like `fix(backend):`, `feat(architect):`, `chore(ui):` are NOT recognized by the zone-audit hook (they fall through to the unrecognized-prefix path and skip the audit). Use the bare form so the audit fires.

**Stage by task scope, not via `git add -A`.** When committing in any role (architect, backend, ui, pinner, or a worker subagent), stage files by your task's declared scope. Do not run `git add -A` or `git add .` — those sweep the entire working tree, including any sibling or parent agent's mid-flight edits sitting in zones outside your task. Anything outside your task's scope stays unstaged for the parent or sibling agent to pick up. Path-scoped staging is the cultural mechanism that prevents the "parent's mid-flight `git mv` gets bundled into worker's commit" failure mode.

**Commit-time zone audit (`commit-msg` hook).** A repo-local hook at `.githooks/commit-msg` is the mechanical backstop for the staging discipline above. The hook's `allowed_for_agent()` function is the runtime-authoritative zone map; rule #2 narrative and the architect's "Files You Own" list are derived references. The hook parses the agent prefix from the commit subject and rejects the commit if any staged path falls outside that agent's zone. Activate per clone via `git config core.hooksPath .githooks` (one-time, not a git-tracked setting). Unrecognized-prefix commits (`chore:`, `Merge ...`, `fix:`) skip the audit. Genuine cross-agent commits can be exempted by including `[skip-zone-audit]` in the subject. The `--no-verify` git flag bypasses ALL hooks per `githooks(5)`; agents MUST NOT use it without explicit per-invocation user authorization (see prohibition above) — prefer `[skip-zone-audit]` for legitimate cross-zone cases. After editing the hook, run `bash .githooks/tests/test-commit-msg.sh` to verify. See `agents/docs/solutions/conventions/commit-zone-audit-hook-2026-04-30.md`.

## Worktree Cleanup

After a worktree fan-out completes and its commits have been merged into the orchestrating branch, the parent agent MUST prune the worker worktrees it spawned. The harness writes a pid-based lock file on spawn but does not release it on child exit, so a plain `git worktree remove` fails against a stale `locked` file. Parents detect the stale lock and clear it themselves:

```bash
name=<agent-xxxxxxx>       # e.g. agent-a03c02c8, from `git worktree list`
lock=.git/worktrees/$name/locked
pid=$(grep -oE 'pid [0-9]+' "$lock" | awk '{print $2}')
if [ -n "$pid" ] && ! ps -p "$pid" > /dev/null 2>&1; then
  git worktree unlock .claude/worktrees/$name
  git worktree remove .claude/worktrees/$name
  git branch -D worktree-$name
fi
```

If the lock's pid is still alive, leave the worktree alone — it belongs to a running sibling agent. Never bulk-unlock blindly; always gate on the stale-pid check.

Worktree cleanup also has a separate work-loss failure mode: a worker subagent commits to its `worktree-agent-*` branch, the parent fails to merge those commits back into the orchestrating branch, and the task signal block ends up citing an orphan SHA. See `agents/docs/solutions/conventions/worktree-fanout-orphan-detection-2026-04-29.md` for the detection check (`git merge-base --is-ancestor <claimed-sha> main`) to run at re-review intake before trusting any "Item N landed at commit X" signal block.

## Code Review Findings

When running `/ce-code-review`, `/security-review`, or any review skill that produces findings, do NOT auto-create new task files under `agents/docs/tasks/`, do NOT silently apply fixes, and do NOT silently archive a `review/` task with unresolved findings. Surface findings as a single ranked list in chat (severity + file:line + one-line rationale) and wait for the user to triage which ones become tasks, which get fixed in place, and which get dismissed. This applies to every agent that invokes a review skill (architect, backend, ui, pinner), not to the individual persona subagents inside `/ce-code-review` itself. If the review comes back clean, say so explicitly in chat before proceeding.

## Asking Questions

Agents default to execution (`/ce-work`, `/ce-debug`) but that does not override the user's role as triager. Pause and ask before acting when:

- Scope is ambiguous and more than one reasonable interpretation exists.
- Two conventions or prior decisions conflict and the right one isn't obvious from the code.
- A decision is hard to reverse (schema changes, API shape changes, destructive operations, pushes, any remote-facing action).
- Review or audit findings need triage (see "Code Review Findings" above).
- A task description contradicts the code you're reading.

One short question with options beats a silent guess. Batch related questions into a single message when possible. This rule binds the architect, backend, ui, and pinner agents equally.

When scope is too ambiguous for a single clarifying question (e.g. the user brings a broad goal with multiple defensible shapes), invoke `/ce-brainstorm` instead of guessing or peppering the user with a wall of questions.

## Documented Solutions

`agents/docs/solutions/` is a shared knowledge store of past problems and conventions, organized by category (e.g. `conventions/`, `runtime-errors/`, `test-failures/`, `performance-issues/`) with YAML frontmatter (`module`, `tags`, `problem_type`, `component`). Entries are written via `/ce-compound` when solving a non-obvious problem whose rationale wouldn't be reconstructable from the code or git history alone. Relevant when implementing or debugging in a documented area — search by component, module, or keyword before investigating from scratch. The architect maintains the categories, format, and any required consolidation via `/ce-compound-refresh`.

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

**Carve-out for deterministic edge-case coverage:** when a test must exercise a rare or multi-state scenario (e.g., duplicate-bind 409 on `/api/orcid/callback`, the HAF-null throw path, or any case where seeding real HAF per-test is impractical), mocking the `getPool()` / `getAppPool()` helpers is permitted IF (a) the test file header documents the justification explicitly (which real path is impractical and why), (b) `verifyHiveSignature` and other middleware are NOT mocked, and (c) a real-HAF variant of the same assertion exists or is filed as a follow-up. Prefer real-HAF whenever feasible; the carve-out is for determinism, not convenience.

## Startup Protocol (applies to ALL Claude instances)

**Do NOT explore the codebase on startup.** No recursive `ls`, no globbing `**/*`, no "let me understand the full project structure" sweeps. This wastes context and time.

Instead, follow this sequence:

1. Read the relevant `agents/<role>/CLAUDE.md` for your role (if acting as a specific agent).
2. List `agents/docs/tasks/pending/` (implementer) or `agents/docs/tasks/review/` (architect) for task files whose slug starts with your role, plus `agents/docs/tasks/blocked/` for anything blocked on you. Legacy sections may still live in `agents/docs/TASKS.md` until that file is retired; check it too while it exists.
3. Read only the files needed for the current task.
4. For implementer agents (backend, ui, pinner): if a task assigned to you is in `tasks/pending/`, verify the issue, double check the implementation, and if everything checks out implement it (via `/ce-work`). If not, prompt the user. For the architect: the equivalent is `tasks/review/`, not `tasks/pending/` — see `agents/architect/CLAUDE.md` for the review/`[BLOCKED]`/brainstorm-mode summary protocol.

This applies equally to top-level Claude, subagents, and Explore agents. If you are asked to "initiate" an agent, follow that agent's startup protocol — do not delegate to a broad exploration pass.

If the user's request references prior work ("the thing we tried last week", "this keeps breaking", "we discussed this before") and the current session has no visible context for it, invoke `/ce-sessions` before guessing or starting from scratch.

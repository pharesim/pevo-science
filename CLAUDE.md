# PEvO — Publish and Evaluate Onchain

A decentralized platform for open scientific publication and interactive evaluation, built on the Hive network. Non-profit, AGPL-3.0-licensed, forkable.

## Core Design Principles

1. **Hive-native, not Hive-wrapped.** Posts, comments and votes are native Hive operations, used as the chain was designed, not as a dumb data store. PEvO content is identified by `APP_TAG` (`pevotest` in the beta phase) and structured `json_metadata`.
2. **Reputation is computed, not tokenized.** No custom token. Reputation derives from on-chain activity (publications, reviews, citations, community votes) via SQL against HAF (Hive Application Framework) / HafSQL. The algorithm is transparent, configurable and forkable.
3. **Accreditation is the trust layer.** Accreditation links a Hive account to a real researcher identity. Unaccredited users can only read; publishing, reviewing, commenting and voting are restricted to accredited accounts.
4. **IPFS for large files.** Papers >64KB go to IPFS with the CID in `json_metadata`; the post body holds abstract, title, authors and metadata. Short papers can live entirely in the body as Markdown.
5. **Privacy by design.** Anonymous reviews are posted by a platform-managed proxy account. The reviewer mapping is encrypted, time-limited, and used only for abuse prevention.
6. **Progressive decentralization.** Accreditation starts centralized (university-email verification plus on-chain `custom_json` attestations) and can move to a DAO vote or web of trust. The architecture must not hard-depend on the centralized component.

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

- **Posting:** `client.broadcast.comment()` from dhive. Top-level posts: parent author `''`, parent permlink `APP_TAG`, `json_metadata` with `app: APP_TAG`, `tags: [APP_TAG, 'science', ...]` and the PEvO-specific fields.
- **Custom JSON:** `custom_json` with `id = APP_TAG` for operations with no native Hive op (accreditation attestations, anonymous review mappings, rating algorithm parameter updates, votes after the 7-day window).
- **Reading data:** HAF SQL for aggregated views, Hive API nodes for real-time data. Cache aggressively on the frontend.
- **Account creation:** (1) **Self-custody**: the user connects an existing Hive account via Hive Keychain. (2) **Light accounts**: PEvO creates a real on-chain account with `create_claimed_account` tokens. A 12-word BIP39 mnemonic is generated client-side and never sent to the backend. All four key pairs derive from it via `PrivateKey.fromLogin(account, mnemonic, role)`, the algorithm Keychain's "Add Account by Master Password" uses, so the phrase imports into Keychain directly. Canonical derivation: `backend/src/seed-phrase.ts` (`deriveKeysFromMnemonic`) and `frontend/src/hive-keys.js` (`deriveHiveKeys`), identical argument order, pinned by a backend parity test. Owner and active private keys never leave the browser. Only posting and memo private keys go to the backend, encrypted with AES-256-GCM (per-account HKDF-derived key, master key in env), stored for server-side signing of allowed operations (`comment`, `comment_options`, `vote`, and app-tag `custom_json`). Upgrading to self-custody rotates keys via the seed phrase and deletes the encrypted keys from the server.

## Project-Wide Conventions

- **Single `.env` file for deployment.** No `.env.production` or other per-environment env files; `.env.example` is the template. **E2E-only exception:** the gitignored `frontend/.env.test` (template `frontend/.env.test.example`) holds E2E-only secrets that MUST NOT come from the production `.env`, e.g. a separate `SESSION_SECRET` or `E2E_SESSION_SECRET` for minting test JWTs, so E2E fixtures can never authenticate against a live deployment through a shared secret.
- **No Hive rewards as a value proposition.** Focus on censorship resistance, reputation, structured review, decentralization.
- **No emdashes (—) in user-facing text:** HTTP response strings, UI copy, and the integrator-facing `agents/docs/api-contracts/*.md`. Use periods, commas, or restructure. Operator logs, code comments, commit messages and task/coordination files are exempt.
- **The HTTP API's only consumer is the frontend SPA** (no MCP server, LLM tool registry, headless SDK or third-party agent; AGPL forks are covered by the beta-stability stance in `agents/docs/api-contracts/common.md`). **So `/ce-code-review` must NOT dispatch the `ce-agent-native-reviewer` always-on agent:** its lens does not fit, its findings get dismissed at triage, and it costs ~500k tokens per review. `reliability` and `correctness` cover ops/monitoring concerns. Re-enable it only when a concrete PEvO agent surface (MCP server, public LLM tool registry, headless SDK) lands.

## Agent Coordination Rules

**Default posture: assume another agent is active right now.** Architect, backend and ui agents, and parallel sessions of one role, edit, stage and commit in the same `.git` at any moment, unannounced. The working tree, index and HEAD are not yours alone. Re-read a task file immediately before acting on it. Git mechanics are under "Commits and Pushes".

1. Agents communicate ONLY through files in the repo. No shared memory.
2. The **Architect agent** owns `agents/docs/ARCHITECTURE.md` and the `agents/docs/tasks/` tree. It does NOT write standalone spec or contract files: the code is the source of truth for API shapes, data models and schemas; document in `ARCHITECTURE.md` or inline in the code. The runtime-authoritative zone map is `allowed_for_agent()` in `.githooks/commit-msg`; this rule and `agents/architect/CLAUDE.md` "Files You Own" derive from it.
3. The **UI agent** reads the code and `ARCHITECTURE.md` to understand interfaces. It does NOT define API shapes.
4. The **Backend agent** reads the code and `ARCHITECTURE.md`. It does NOT change API shapes without updating `ARCHITECTURE.md` and notifying via a TODO (a new pending task file or a note appended to an existing task in `agents/docs/tasks/`).
5. **Tasks are files, not sections:** `agents/docs/tasks/{pending,review,blocked}/<role>-<kebab-summary>.md`. State transitions are `git mv` between directories. Slug format, file shape and transition table: `agents/docs/tasks/README.md`.
6. A **blocked** task moves to `agents/docs/tasks/blocked/` with an appended `[BLOCKED by <agent>]` note saying what is needed. The blocking agent moves it back to `pending/` once resolved.
7. A **complete** task is `git mv`ed by the implementer from `pending/` to `review/`. The architect reviews, then **archives** it: prepend its contents to `agents/docs/tasks-archive.md` under a `## <Title> (archived <YYYY-MM-DD>)` heading, trim `tasks-archive.md` from the bottom to at most **250 lines** (full history stays in git), and `git rm` the task file. No strikethrough (`~~`); completed task files are deleted.
8. **Review → held-pending-fixes → re-review.** When review finds issues that block archive, the architect appends an **`Architect re-review (<date>) — HELD PENDING FIXES:`** block listing the fixes and `git mv`s the file back to `tasks/pending/`, so it shows in the implementer's startup listing. The implementer lands the fixes and `git mv`s it to `tasks/review/`; that move is the re-review signal. Implementers do NOT edit the hold block or mark items fixed inside it: the commit diff is the evidence and the architect updates the block at re-review. A held task that becomes blocked on another agent's decision goes to `blocked/` per rule 6.
9. **No spec file sprawl.** No new files in `agents/docs/` outside `tasks/`, `api-contracts/` and `solutions/`. Allowed: `ARCHITECTURE.md`, `tasks-archive.md`, `api-contract.md` (index), `api-contracts/*.md`, `hive-schemas.md`, `reputation-algorithm.md`, `tasks/**/*.md` (task files + README), `solutions/**/*.md`. Keep them current with related code changes.
10. **Priority.** Every task file carries a `**Priority:**` line under `**Created:**`; a file without one counts as `normal`.
    - `high`: security defects, data loss or corruption, a broken user-facing flow.
    - `normal`: product features and behavioral bugs.
    - `low`: comment and prose fixes, canary and pin upkeep, tooling and convention hygiene.
    - `deferred (<until when>)`: not picked up until the stated condition holds, e.g. `deferred (until all other open tasks are archived)`.

    The agent filing a task sets it, the architect adjusts it at review or triage, and the user can override it at any time. Don't change the priority of a task you are implementing; if it looks wrong, say so in the signal block. **Pick order:** a task the user names comes first; otherwise `high`, then `normal`, then `low`, alphabetically within one priority, skipping `deferred` tasks whose condition is unmet. This applies to implementers picking from `pending/` and to the architect picking from `review/`, and startup summaries list tasks in this order with their priority.

## Commits and Pushes

- **Local commits need no permission.** Commit at natural checkpoints: a task moving to review, before a worktree fan-out, before handing off a long investigation, before switching between unrelated tasks. Use `/ce-commit` or commit manually. **Before a worktree fan-out the parent MUST commit in-flight work** so workers branch from a stable HEAD.
- **Every commit message ends with a `Co-Authored-By:` trailer naming the authoring model**, e.g. `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Substitute the model you run as; never omit it. This covers `/ce-commit`, manual commits, worker subagent commits and checkpoint commits. Pass the message via HEREDOC so the blank line before the trailer survives. `/ce-commit` sometimes drops the trailer: re-check your commit and amend it in.
- **No remote-facing action without an explicit user ask for that specific action:** `git push` (any form), `gh pr create`, `gh pr edit`, `gh pr comment`, `gh issue create/comment`, `gh release`, and any `/ce-*-push*` / `/ce-*-pr*` skill. Authorization is per invocation: "push this" covers one push.
- **Keep commits focused.** Don't bundle unrelated task work. A checkpoint commit before a fan-out is fine when it covers one task or one logical batch; with cross-task drift in the tree, make several focused commits.
- **Subject-prefix style for agent commits:** the bare `<role>:` or `<role>(<scope>):` form, `<role>` one of `architect`, `backend`, `ui` (e.g. `backend(auth): ...`). Conventional-commit wrappers like `fix(backend):` are not recognized by the zone audit and skip it.
- **Stage only the files you edited this session,** as an explicit path list (`git add path/a path/b`) built from your own memory of what you wrote, edited or `git mv`d, cross-checked against `git status`. Your zone is the upper bound of what you may stage, not the list itself. `git add -A` and `git add .` are forbidden; broad directory adds (`git add backend/`, `git add agents/docs/`) are forbidden when narrower paths exist. Anything you didn't edit stays unstaged for whoever did.
- **Commit-time zone audit (`.githooks/commit-msg`).** It parses the role prefix and rejects the commit if a staged path falls outside that role's zone. Activate once per clone: `git config core.hooksPath .githooks`. Unrecognized prefixes (`chore:`, `Merge ...`, `fix:`) skip the audit. Genuine cross-agent commits put `[skip-zone-audit]` in the subject. `--no-verify` bypasses ALL hooks: never use it without explicit per-invocation user authorization. After editing the hook, run `bash .githooks/tests/test-commit-msg.sh`. See `agents/docs/solutions/conventions/commit-zone-audit-hook-2026-04-30.md`.

**Shared-index race discipline.** Siblings can stage paths between your `git status` and your `git commit`:

1. **Verify the staged set immediately before committing** (`git diff --cached --name-only`). For any path you did not stage, `git restore --staged <path>` (the sibling's working-tree edit stays intact), re-verify, then commit. The zone audit cannot see same-role concurrent sessions. See `agents/docs/solutions/conventions/concurrent-agent-staging-sweep-2026-05-12.md` and `parallel-agent-git-index-race-2026-05-15.md`.
2. **Never `git reset --hard HEAD~N` past commits you did not author.** "Your most recent commit" can be a sibling's by then. Clean up forward: `git revert <bad-sha>`, or `git reset --soft <your-specific-sha>` to undo your own commit.
3. **For a task-file move with a content edit: `Edit → git add <file> → git mv <src> <dst> → git commit`.** `git mv` records the file content from the index, so skipping the `git add` commits the pre-Edit content and leaves your edit as a stray unstaged change. With the `git commit -- <paths>` form, name BOTH source and destination paths, or the rename lands half-applied (the file sits in HEAD in both directories). Confirm with `git show --name-status HEAD` that the source appears as `D` or the move as a single `R`. See `agents/docs/solutions/conventions/git-commit-explicit-path-arg-defeats-shared-index-race-2026-05-21.md`.

## Comment anchors

Write comments and docblocks against stable invariants, never against coordination state, line numbers or commit SHAs. Each rule's rationale lives in the cited `agents/docs/solutions/conventions/` entry.

- **No task slugs, round numbers or task redirects** in production or test code (`ui-foo-bar`, "round-3 hold item 2", "see the task file", "see task <slug>"). Task files archive and the archive trims, so the citation dies. Anchor on behavior ("per-attempt correlator", "see `/resume-signup` handler"). (`task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`)
- **No line-number or SHA anchors** (``edit.js:183``, ``now ~337``, ``commit `abc1234` ``). Anchor on exported function names, CTE labels, route handler paths, Alpine binding names or other stable symbols. (`docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`)
- **No bare positional anchors.** An `above` / `below` citation is durable only when a stable name rides along in the same container (`the 42601 canary above`, `the SUBJECT_BOUND_STORAGE_KEYS loop below`). Purely positional forms (`the rule below`, `the helper above`, `the previous spec`) rot, and a docblock's paragraph is the container, so pointing across paragraphs rots too. Name what you point at, or restate it. Reviewers must not flag the durable form. (`positional-anchor-stable-named-container-carve-out-2026-05-20.md`)
- **A convention-enforcing fix audits its own replacement** against these rules: dropping a SHA must not add a task slug. Architect hold-block prescriptions are in scope too. (`convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, `hold-block-must-not-contradict-convention-docs-2026-04-22.md`)
- **Fix a false or overclaiming comment by deleting or narrowing the claim,** not by writing a longer or more qualified sentence. Remove the wrong part, or cut the claim down to what the code verifiably does. Do not rescue it with exception lists, mechanism explanations or new "because" clauses: every new sentence is a new claim the next review must verify, and most re-review holds are defects in the previous fix's new text. Add only text the fix strictly needs, and check that text against the code. The accuracy bar is unchanged.

Coordination context (round numbers, hold items, task slugs, SHAs) belongs in commit messages and task files, not in source, and not in the bodies of `agents/docs/solutions/` entries either.

**Mechanical gate (`.githooks/pre-commit`).** Fails a commit whose NEWLY-ADDED lines under `frontend/{src,tests}` or `backend/{src,tests}` introduce a task-slug citation, a round/hold ordinal, an `Option X.N` label, a line-number / `Lnn` cite, a `tasks-archive` / `see task` / `AC #N` redirect, or a bare positional anchor. It checks added lines only; `backend/tests/eslint/no-stale-comment-anchors.test.ts` keeps `backend/src/` clean as a whole. Exempt one legitimate fixture line with the literal `anchor-allow` marker in a comment on that line; skip a whole commit with `PEVO_ANCHOR_GATE=off git commit ...` (never `--no-verify`). Same one-time `core.hooksPath` activation as the zone audit. After editing the hook, run `bash .githooks/tests/test-pre-commit.sh`. Detection scope and deferred classes: `comment-anchor-rot-precommit-diff-gate-2026-06-14.md`.

## Worktree Cleanup

After a worktree fan-out's commits are merged into the orchestrating branch, the parent MUST prune the worker worktrees it spawned. The harness's pid lock is not released on child exit, so clear stale locks yourself:

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

A live pid means a running sibling's worktree: leave it alone. Never bulk-unlock; always gate on the stale-pid check. At re-review intake, before trusting an "Item N landed at commit X" signal block, check the SHA reached the branch (`git merge-base --is-ancestor <claimed-sha> main`); see `agents/docs/solutions/conventions/worktree-fanout-orphan-detection-2026-04-29.md`.

## Code Review Findings

An agent running `/ce-code-review`, `/security-review` or any review skill that produces findings does NOT auto-create task files under `agents/docs/tasks/`, silently apply fixes, or silently archive a `review/` task with unresolved findings. Surface one ranked list in chat (severity + file:line + one-line rationale) and wait for the user to triage which findings become tasks, which get fixed in place and which get dismissed. If the review is clean, say so explicitly before proceeding. This binds architect, backend and ui, not the persona subagents inside `/ce-code-review`.

**Account-state defense review.** For code that defends, branches on, or migrates between account states (any of `verify_token`, `username`, `password_hash`, `orcid`, `custody`, `upgraded_at`), check the defended `(field, field, field)` combination against `agents/docs/ARCHITECTURE.md` § 6.1's reachable states. An unenumerated combination is either (a) a fictional state: flag for removal or doc update, or (b) a transition the doc doesn't cover: flag for doc update first, then re-review against the updated state machine. Also verify the action's re-auth proof against § 6.4: JWT-only access on any critical action is a security defect (§ 6.5 invariant #1). Applies to architect reviews and to every `/ce-code-review` persona examining account-touching code (correctness, security, adversarial, kieran-typescript, project-standards).

## Asking Questions

Agents default to execution (`/ce-work`, `/ce-debug`), but the user is the triager. Ask before acting when scope is ambiguous, two conventions or prior decisions conflict, a decision is hard to reverse (schema or API shape changes, destructive operations, pushes, anything remote-facing), findings need triage, or a task description contradicts the code. One short question with options beats a silent guess; batch related questions. This binds architect, backend and ui equally. When scope is too ambiguous for one question, invoke `/ce-brainstorm`.

## Shared Domain Vocabulary

`CONCEPTS.md` (repo root) is the glossary of PEvO's domain terms (Paper, Review, Accreditation, Sanction, Web of Trust, Reputation, light vs self-custody accounts, the singular signer, and so on), so tasks and `agents/docs/solutions/` entries can cite them without redefining. Read it when orienting or before discussing domain concepts. The architect maintains it; `/ce-compound` and `/ce-compound-refresh` runs and direct edits also add terms.

## Documented Solutions

`agents/docs/solutions/` holds past problems and conventions by category (`conventions/`, `runtime-errors/`, `test-failures/`, `performance-issues/`, ...) with YAML frontmatter (`module`, `tags`, `problem_type`, `component`). Search it by component, module or keyword before investigating a documented area from scratch. Entries are written via `/ce-compound` for non-obvious problems whose rationale the code and git history don't carry; the architect owns categories and format and consolidates via `/ce-compound-refresh`. `agents/docs/solutions/README.md` is the catalog: the store's shape decisions (flat categories, no date suffix on new filenames, existing dated names kept) and, per heavily documented artifact, the entries about its own machinery. `/ce-compound` does not know the catalog exists, so a run that writes an entry naming a catalogued artifact appends the catalog row in the same commit, whatever role runs it; the architect reconciles the catalog at each `/ce-compound-refresh`.

## Local Dev Deployment

Local dev runs via Docker using `./deploy.sh`: `restart` (rebuild + restart + migrate), `logs`, `up` / `down`, `migrate` (run SQL migrations).

## Running Tests

Run `source ~/.nvm/nvm.sh && nvm use 20` first. Postgres and Redis containers are reachable only via their Docker network IPs, not localhost:

```bash
REDIS_URL="redis://:$(grep REDIS_PASSWORD .env | cut -d= -f2)@$(docker inspect pevo-redis-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'):6379" \
APP_DATABASE_URL="postgresql://pevo:pevo_dev@$(docker inspect pevo-postgres-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'):5432/pevo_app" \
npx vitest run
```

Tests run against real HAF + Hive API. No mock data, no mocked database pools.

**Carve-out for deterministic edge-case coverage:** when a rare or multi-state scenario is impractical to exercise for real per test (e.g. duplicate-bind 409 on `/api/orcid/callback`, the HAF-null throw path, an SMTP-transporter options-shape pin), targeted mocking is permitted IF:

- **(a)** the test file header documents the justification: which real path is impractical and why.
- **(b)** `verifyHiveSignature` and other auth/permission middleware run real in tests whose **focus IS authentication** or whose assertions depend on **cryptographic verification behavior**. Tests focused on downstream behavior (SQL shape, response envelope, route plumbing) may use the `MOCK_VERIFY_SIGNATURE` fixture (`backend/tests/fixtures/mock-auth.ts`), which keeps the 401-on-missing-header gate and username extraction and bypasses only the signature check. When it is used, the header MUST say under (a) that cryptographic verification is bypassed and why the focus permits it, and the (c) companion MUST exercise the real `verifyHiveSignature` against signed requests on the same or a sibling route.
- **(c)** the same risk class is covered by a real-path test elsewhere, OR a follow-up task is filed to add it. Risk class = the failure mode the assertion exists to catch (e.g. "options-shape mutations at the helper"); the companion need not assert the same thing, only exercise the integrated path on real infrastructure.

Mock targets under the carve-out: shared pool/cache helpers (`getPool()`, `getAppPool()`, `getRedis()`, `getHafPool()`), third-party libraries impractical to run for real per test (nodemailer transporter, hive-API client, IPFS client), observability surfaces (logger spies), and `verifyHiveSignature` via the fixture per (b). Prefer the real path whenever feasible: the carve-out is for determinism, not convenience. Rationale: `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`.

## Startup Protocol (applies to ALL Claude instances)

**Do NOT explore the codebase on startup:** no recursive `ls`, no `**/*` globs, no project-structure sweeps. Instead:

1. Read `agents/<role>/CLAUDE.md` if acting as a specific agent.
2. List `agents/docs/tasks/pending/` (implementer) or `agents/docs/tasks/review/` (architect) for your role's slugs, in pick order with their priority (rule 10), plus `agents/docs/tasks/blocked/` for anything blocked on you (and `agents/docs/TASKS.md` while it exists).
3. Read only the files the current task needs.
4. Implementers (backend, ui): for the task the user names, or else the first of yours in pick order in `tasks/pending/`, verify the issue and double-check the implementation; if it checks out, implement it via `/ce-work`, otherwise ask the user. Architect: the equivalent is `tasks/review/`; see `agents/architect/CLAUDE.md`.

This applies to top-level Claude, subagents and Explore agents. "Initiate <role> agent" means follow that role's startup protocol, not a broad exploration pass. If the user references prior work this session has no context for, invoke `/ce-sessions` before guessing.

# ARCHITECT-COMMIT-ZONE-AUDIT-HOOK — pre-commit hook that catches cross-agent commit-scope drift

**Owner:** Architect
**Created:** 2026-04-30 (architect, surfaced by cluster 1 review of `backend-bridge-paper-author-gate.md` round-2 commit `3c2a2a1` bundling 3 unrelated `tasks/review→pending` moves with bridge-paper implementation work)
**Priority:** P3

## Problem

Backend commit `3c2a2a1` (`fix(backend): finish bridge-paper author-gate round 2`) included `git mv` of three unrelated task files from `tasks/review/` to `tasks/pending/` (`backend-claims-error-polish`, `ui-keychain-api-misuse`, `ui-orcid-callback-fixes`) alongside the bridge-paper implementation work. Per root `CLAUDE.md` rule #8, review→pending moves are architect-driven and paired with `HELD PENDING FIXES` block edits — backend bundling them with implementation diffs mixes architect transitions with implementer work in a single commit, making git history harder to bisect and breaking the per-agent attribution of changes.

The proximate cause was likely `git add -A` (or `git add .`) staging by the worker subagent: the parent (architect) had uncommitted `git mv` operations sitting in the working tree, the worker forked from that state, and `git add -A` swept the architect's mid-flight moves into the worker's commit.

The root cause is the absence of a path-scoped commit-discipline guard. The "before fan-out, commit in-flight work" rule already exists in CLAUDE.md but doesn't cover the case where mid-flight architect work is in zones the worker doesn't touch — those edits should be allowed to coexist with worker fan-outs, not forcibly committed first.

## Goal

Add a pre-commit hook that compares the staged diff's paths against the commit-message-declared agent scope and refuses commits where staged paths exceed the agent's allowed zones per `CLAUDE.md` rule #2 + per-agent CLAUDE.md boundaries.

## Acceptance

### 1. Implement the hook

`backend/.husky/pre-commit` or `.git/hooks/pre-commit` (whichever the project uses; investigate during implementation). The hook reads:

- The commit message subject line (via `git diff --cached -m` or by reading the prepared `COMMIT_EDITMSG`)
- The list of staged file paths (via `git diff --cached --name-only`)

It parses the agent prefix from the subject (`architect:`, `backend:`, `ui:`, `pinner:`, plus the `backend(<scope>):` / `architect(<scope>):` parenthetical variants) and compares staged paths against an allowed-zones map:

| Agent | Allowed zones (paths must match one) |
|-------|--------------------------------------|
| `architect:` | `agents/docs/`, `docker-compose.yml`, `Dockerfile`, `README.md`, `CLAUDE.md` (root), `agents/*/CLAUDE.md` |
| `backend:` | `backend/`, `agents/docs/tasks/pending/<backend-slug>` (move-out only), `agents/docs/tasks/review/<backend-slug>` (move-in only) |
| `ui:` | `frontend/`, `agents/docs/tasks/pending/<ui-slug>` (move-out only), `agents/docs/tasks/review/<ui-slug>` (move-in only) |
| `pinner:` | `pinner/`, similar task-file move semantics |

If any staged path falls outside the matching agent's allowed zones, the hook prints the violating paths + the agent prefix it parsed, and exits non-zero.

### 2. Handle ambiguity gracefully

- Commit messages without a known agent prefix (e.g., `chore: bump deps`, `Merge pull request #123`) skip the audit and exit 0.
- Commits that touch multiple agent zones with explicit reason in the message (e.g., a one-off cross-agent refactor) can be exempted via a `[skip-zone-audit]` token in the commit message subject. Use sparingly; the audit log should record exemption usage.
- The `git mv` of task files between `tasks/{pending,review,blocked}` is a state transition, not zone violation — the file slug's prefix (`backend-`, `ui-`, etc.) determines whose zone the move belongs to, not the directory path. The audit should respect this: a `backend:` commit moving `tasks/review/backend-X.md` → `tasks/pending/backend-X.md` is allowed; a `backend:` commit moving `tasks/review/ui-Y.md` → `tasks/pending/ui-Y.md` is not.

### 3. Pair with worker-side path-scoped staging

The mechanical audit is the backstop. The cleaner-fit cultural mechanism is for worker subagents to `git add` by task scope rather than `git add -A`. Update the worker subagent prompts in `agents/<role>/CLAUDE.md` (per role) to explicitly direct path-scoped staging:

> When committing in this role, stage files by your task's declared scope, not via `git add -A` or `git add .`. Anything outside your scope stays unstaged for the parent or sibling agents to pick up. This prevents accidentally committing other agents' in-flight work that may be sitting in the working tree.

Both layers — worker discipline + commit-time backstop — should be in place. The hook fires only on rule violations; expected steady state is silent.

### 4. Test

- A `backend:` commit staging `agents/docs/ARCHITECTURE.md` is rejected.
- A `backend:` commit staging `frontend/src/...` is rejected.
- An `architect:` commit staging `backend/src/...` is rejected.
- A `backend:` commit moving its own task file between `tasks/{pending,review}` directories is accepted.
- A `chore:` or other unrecognized-prefix commit is accepted (skipped).
- A commit with `[skip-zone-audit]` in the subject is accepted regardless of paths.

### 5. Document the convention

Add a paragraph to `CLAUDE.md` "Commits and Pushes" section pointing at the hook and the worker-side path-scoped staging guidance. Cross-link in `docs/solutions/conventions/` (a new convention doc captures the pattern: "commit-time agent-zone audit prevents cross-agent commit-scope drift in fan-out workflows").

## Why now

- `3c2a2a1` is the documented case; this is not the only instance — `72978a0` also crossed a boundary by editing `agents/docs/ARCHITECTURE.md` in a backend commit (a different but related drift class). Cross-agent commit-scope drift is a recurring pattern at PEvO's current fan-out cadence.
- The hook is mechanical and small (~30-50 lines of bash). Cost is one hook entry; benefit is the entire class of "parent's mid-flight work gets bundled into worker commit" silently disappears.
- Future PEvO fan-out volume only goes up. Catching this at commit time, not at code-review time, saves architect cycles per fan-out.

## Out of scope

- Replacing the existing "before fan-out, commit in-flight work" rule. That rule still has value for the worker-branches-from-stable-HEAD invariant; the new hook complements it by handling the case where mid-flight work IS the parent's other-zone work.
- A pre-fan-out cleanliness gate (rejected as too rigid — sometimes parent work is genuinely mid-flight in non-overlapping zones).
- A worker-diff audit at commit time (more complex; relies on per-task scope declaration that doesn't currently exist in worker prompts).
- Migrating to a CI-side equivalent (preferred local-first; the hook should fire at commit, not at PR open).

## Source

- `/ce-code-review` of cluster 1 task `backend-bridge-paper-author-gate.md` round-2 commit `3c2a2a1` — project-standards finding (P3 conf 75 commit-scope rule violation).
- Cross-cluster pattern: same class of drift in `72978a0` (backend edited `agents/docs/ARCHITECTURE.md`).
- User-architect dialog 2026-04-30: the "commit before fan-out" framing is too rigid when parent work is genuinely mid-flight; the right backstop is at commit time, on path-scoped zones.

## Cross-references

- Root `CLAUDE.md` rule #2 (architect/backend/UI ownership boundaries) — the source-of-truth for the agent-zone map.
- Root `CLAUDE.md` "Commits and Pushes" section — already mentions "commit scope rule: keep commits focused. Don't bundle unrelated task work into a single commit." This task makes that rule mechanical.
- `agents/docs/solutions/conventions/worktree-fanout-orphan-detection-2026-04-29.md` — adjacent fan-out convention; both target the dirty-tree-fan-out failure family.

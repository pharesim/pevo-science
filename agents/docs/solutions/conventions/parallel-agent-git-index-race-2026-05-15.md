---
title: Parallel-agent commits race on the shared git index and silently bundle siblings' uncommitted work
date: 2026-05-15
category: conventions
module: agent-coordination
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - Multiple agents (architect sessions, fan-out workers, parallel reviewers) operate on the same git checkout concurrently
  - About to commit narrow per-task work (archive intake, hold-block append, test-only fix) while sibling agents have their own uncommitted edits staged or unstaged in the working tree
  - Composing a sequence of `git add` / `git rm` / `git mv` followed by `git commit`, especially with intervening `git status` / `git diff --cached` inspection turns
  - Investigating why a commit landed with more paths than the staging discipline intended ("3 files changed" instead of 2)
tags:
  - agent-coordination
  - git-workflow
  - commit-discipline
  - concurrency
  - staging-discipline
related_components:
  - .githooks/commit-msg
---

# Parallel-agent commits race on the shared git index and silently bundle siblings' uncommitted work

## Context

The architect, backend, ui, and pinner agents all share one git checkout. When multiple sessions run concurrently — common when one architect handles ui-* reviews while another handles backend-* reviews, or when a parent fans out worker subagents — the git index becomes a shared mutable resource. The "stage only the files you edited this session" rule in root `CLAUDE.md` "Commits and Pushes" and the `agents/architect/CLAUDE.md` "Architect staging" section assumes single-agent ownership of the index. That assumption breaks under concurrent operation.

Failure mode: between your `git add` and your `git commit`, a sibling agent's `git add` lands extra paths into the same index. Your commit sweeps them in. Symmetrically, a sibling's later commit can sweep in your still-unstaged work. The commit-msg zone-audit hook at `.githooks/commit-msg` does not catch this — the hook protects against cross-AGENT-ROLE bundling (e.g., a `backend:` commit touching `agents/docs/`), not cross-TASK bundling within the same role.

## Guidance

Chain stage + commit atomically in one shell expression so the race window between `git add` and `git commit` shrinks to sub-second. Do not interleave inspection turns between staging and commit:

```bash
git add <my-edited-files> && git rm <my-deleted-files> && git commit -m "..."
```

For an archive-and-delete operation, the canonical shape is:

```bash
git add agents/docs/tasks-archive.md && \
  git rm agents/docs/tasks/review/<slug>.md && \
  git commit -m "$(cat <<'EOF'
architect(<slug>): archive — round-N clean
...
EOF
)"
```

If you need visibility before the commit, fold `git diff --cached --stat` into the same chain just before commit; it is read-only and does not widen the race window:

```bash
git add <paths> && git diff --cached --stat && git commit -m "..."
```

Do NOT run a standalone `git status` between staging and commit — any harness tool-call gap (Bash → Bash) is large enough for a sibling agent's `git add` to land.

When the staging command returns an unexpected staged set (extra paths you did not touch), prefer `git restore --staged <path>` over `git reset HEAD <path>`. `git reset HEAD` with explicit paths can collateral-unstage adjacent index entries — verified 2026-05-15: a `git reset HEAD <sibling-rename-paths>` unstaged the orchestrator's own edits as well. `git restore --staged` is path-scoped and does not reach beyond its arguments.

If a sibling's paths are already bundled in your commit by the time you notice, do NOT `git reset --soft HEAD~1` and redo — the redo runs the same race against the same sibling agents and is likely to land in a different inconsistent state. Accept the bundled commit, flag the cross-task content in your end-of-turn summary, and let the sibling agent re-stage their own work (their `git add` against unchanged paths is a no-op).

## Why This Matters

The architect staging discipline exists to keep commits focused: one commit per task, easy to revert, easy to read in `git log`. Cross-task bundling defeats that — a single commit ends up reading as "archive ui-upgrade-closure-wipe AND move backend-bridge-write-haf-lag to pending," which neither commit message nor `git blame` can later untangle. It also defeats per-task rollback: `git revert <sha>` undoes both the archive and the unrelated rename.

The commit-msg hook is not the right enforcement layer for this. The hook checks paths against `allowed_for_agent('<role>')`, which is an upper-bound on what an agent role MAY touch. Cross-task bundling within the same role's allowed zone passes the hook cleanly. Discipline at the staging step is the only available enforcement.

The race window shrinks with shell-chained commands but does not close — a sibling agent's `git add` can still interleave during the `&&` between operations. The mitigation is "small enough that interleaves are rare," not "race-free." For perfectly-isolated commits, use git worktrees per-agent (see `agents/docs/solutions/conventions/worktree-fanout-orphan-detection-2026-04-29.md` for the established worktree-fanout pattern), but worktree overhead is high for single-task architect commits and the chained-shell mitigation handles the common case.

## When to Apply

- Every architect commit that follows a `/ce-code-review` archive intake — staging `agents/docs/tasks-archive.md` + `git rm` the reviewed task file.
- Every `[BLOCKED by Architect]` resolution that touches a sibling agent's task file (the sibling may be mid-flight on the same file).
- Every implementer agent committing a hold-block response while the architect (or another reviewer) has dirty staged content.
- Worker subagents inside a worktree fan-out are NOT subject to this race (each worktree has its own index), so the chained-shell pattern is optional there. The race specifically affects the SHARED main checkout where multiple top-level agents commit.

## Examples

Anti-pattern — interleaved inspection turn between stage and commit:

```bash
# Turn 1
git add agents/docs/tasks-archive.md
git rm agents/docs/tasks/review/<slug>.md
git status --porcelain  # sibling agent's `git add` can land here

# Turn 2
git commit -m "..."     # commit picks up sibling's path
```

Result observed 2026-05-15 archiving `FE-UPGRADE-CLOSURE-WIPE`: commit landed with `3 files changed` instead of the intended 2 — a sibling architect's `agents/docs/tasks/review/backend-bridge-write-haf-lag-and-retry-amplification.md` → `pending/` rename was bundled in. The commit-msg zone audit passed because all paths were in the architect zone (`agents/docs/tasks/**/*.md`).

Pattern — atomic stage + commit, no intervening tool calls:

```bash
# Single Bash call, single turn
git add agents/docs/tasks-archive.md && \
  git rm agents/docs/tasks/review/<slug>.md && \
  git commit -m "$(cat <<'EOF'
architect(<slug>): archive — round-N clean

<body>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Pattern — atomic with visibility check:

```bash
git add agents/docs/tasks-archive.md && \
  git rm agents/docs/tasks/review/<slug>.md && \
  git diff --cached --stat && \
  git commit -m "..."
```

Recovery anti-pattern — `git reset HEAD <paths>` unstaging others' bundled paths collateral-unstaged my own staged edits too (observed 2026-05-15). Prefer:

```bash
git restore --staged agents/docs/tasks/review/backend-bridge-write-haf-lag-and-retry-amplification.md
# my own staged paths untouched
```

## Related

- Root `CLAUDE.md` "Commits and Pushes" — staging-discipline narrative this learning extends.
- `agents/architect/CLAUDE.md` "Architect staging" — single-agent staging rule that this learning extends to concurrent agents.
- `agents/docs/solutions/conventions/commit-zone-audit-hook-2026-04-30.md` — the commit-msg hook this learning notes is structurally unable to catch cross-task bundling within a zone.
- `agents/docs/solutions/conventions/worktree-fanout-orphan-detection-2026-04-29.md` — worktree-per-agent isolates indexes for fan-out; not used for single-task architect commits but is the heavyweight alternative when the chained-shell pattern is insufficient.
- Personal memory `feedback_git_mv_after_edit_staging.md` — related single-agent staging-order issue (stage Edit BEFORE `git mv`); orthogonal to the concurrent-agent race documented here.

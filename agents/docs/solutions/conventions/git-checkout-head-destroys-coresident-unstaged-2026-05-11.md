---
title: "git checkout HEAD -- <file> destroys co-resident unstaged content from other agents' zones"
date: 2026-05-11
category: conventions
module: agent-coordination
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - "Resetting your own working-tree edits on a file that another agent has unstaged content on"
  - "Architect annotates a task file (hold-block, coordination note) while implementer's re-review signal block is still unstaged"
  - "Any role-scoped agent (architect, backend, ui, pinner) needs to discard their staged-or-unstaged edits on a multi-agent-touched path"
  - "Reflex to clean up with `git checkout HEAD -- <path>` or `git restore <path>` before re-staging in clean stages"
tags:
  - git
  - staging-discipline
  - multi-agent
  - working-tree
  - data-loss
  - architect
  - worktree
related_components:
  - documentation
  - tooling
---

# git checkout HEAD -- <file> destroys co-resident unstaged content from other agents' zones

## Context

PEvO's multi-agent coordination model has agents (architect, backend, ui, pinner) communicating exclusively through files in the repo (see root `CLAUDE.md` "Agent Coordination Rules"). Task files under `agents/docs/tasks/` are routinely touched by multiple agents within a single review/hold/resolve cycle — architect appends hold blocks, implementer appends re-review signal blocks, and `git mv` operations move them between section directories. This means an agent frequently encounters a file with **co-resident unstaged content authored by another agent**. The naive instinct, when wanting to "stage only my edit," is to reset the working tree and re-edit cleanly — but `git checkout HEAD -- <file>` permanently destroys the other agent's unstaged work, because unstaged changes never enter git's object database and `reflog` / `fsck --lost-found` cannot recover them. This is reachable from every role.

## Guidance

**Wrong (destroys co-resident unstaged content):**

```bash
# DO NOT do this when another agent has unstaged edits on the file
git checkout HEAD -- agents/docs/tasks/review/backend-p3-cleanup-sweep.md
# Re-edit, stage, commit — the other agent's unstaged block is GONE
```

Same destructive class:
- `git restore <file>` (restores from index, discards unstaged hunks)
- `git restore --source=HEAD <file>` (same, but from HEAD)
- `git checkout -- <file>` (older shorthand for the same op)

**Right (preserves co-resident unstaged content via stash):**

```bash
git stash push -m "preserve co-resident edits" -- agents/docs/tasks/review/backend-p3-cleanup-sweep.md
# File now reverts to HEAD-as-staged. Make your edit cleanly:
# (edit file via Edit tool, then)
git add agents/docs/tasks/review/backend-p3-cleanup-sweep.md
git commit -m "architect: ..."
git stash pop   # re-applies the other agent's unstaged content on top
```

**Alternatives** when stash doesn't fit:
- `git add -p <file>` — interactive hunk staging. Pick only your hunks; the rest stay unstaged. Most ergonomic, but interactive-only.
- `git diff <file> > /tmp/f.patch`, hand-edit the patch to keep only your hunks, then `git apply --cached /tmp/f.patch` — surgical, works in automation flows.

## Why This Matters

Unstaged working-tree changes are not tracked by git's object database, so `git reflog`, `git fsck --lost-found`, and `git stash list` cannot recover them once a reset overwrites them — the loss is **permanent**. In PEvO's coordination model, that loss is another agent's authored work, not just your own draft, so the blast radius extends to the other agent's task progress and the coordination signal itself (in the incident below, a backend re-review signal block was destroyed and had to be re-authored from scratch). The trap is reachable from every role and is structurally analogous to the worktree-teardown trap (auto memory [claude]: worker subagents in `isolation:"worktree"` must commit, lest uncommitted changes are reaped with the worktree) — same class of failure (uncommitted changes destroyed by routine tooling), different scenario. Because multi-agent file co-residence is routine in the review-hold-resolve workflow, this trap is not a rare edge case.

The `.githooks/commit-msg` zone-audit hook (see `commit-zone-audit-hook-2026-04-30.md`) catches the COMPLEMENTARY trap of `git add -A` absorbing other zones' staged content at commit time — but the audit hook cannot catch this trap, because the destructive reset happens BEFORE anything is staged. There is no mechanical backstop here; the only defense is procedural discipline at the working-tree manipulation layer.

## When to Apply

- About to reset working-tree state on any file under `agents/docs/tasks/` — these are the highest-risk files because architect and implementer routinely co-author them across hold/resolve cycles.
- About to reset working-tree state on `agents/docs/ARCHITECTURE.md`, `agents/docs/tasks-archive.md`, or any `agents/docs/api-contracts/*.md` file that may carry in-flight architect edits.
- `git status` shows a file as modified but you don't fully account for every hunk in the `git diff` as your own work.
- Mid-`git mv` workflows where another agent's prior unstaged edits may have survived into the current checkout (e.g., a held-task move where the previous round's signal block wasn't committed).
- Worktree fan-out scenarios where the parent checkout may contain unstaged content from a sibling agent or a pre-fan-out checkpoint.
- Any "I want to stage only my hunks" situation — reach for `git stash push <path>`, `git add -p`, or `git apply --cached` BEFORE reaching for `git checkout HEAD -- <path>` or `git restore <path>`.

## Examples

**Incident (2026-05-11, architect agent):**

```bash
# State: HEAD has architect's HELD-PENDING-FIXES block (commit 3489f43).
#        Working tree also has backend's unstaged "re-review signal" block,
#        left unstaged when ff3ed4f committed the M-01 fix + the git mv.

# Architect appends a coordination note via Edit, then realizes the stage
# would bundle BOTH the architect note AND backend's unstaged signal block.

# TRAP: architect runs reset to "re-edit cleanly":
git checkout HEAD -- agents/docs/tasks/review/backend-p3-cleanup-sweep.md
# Backend's unstaged signal block is now PERMANENTLY LOST.
# (Reflog/fsck cannot recover it — it never entered the object database.)

# Recovery: architect reconstructs only the architect note, commits 8e963e3,
# and has to ask backend to re-author a FRESH signal block from scratch.
```

**Correct flow that would have preserved the signal block:**

```bash
# Same starting state: HEAD + backend's unstaged signal block + architect's
# Edit-appended coordination note.

# Stash the unstaged delta on this one file:
git stash push -m "preserve backend signal + architect note" \
  -- agents/docs/tasks/review/backend-p3-cleanup-sweep.md

# File now matches HEAD. Re-apply ONLY the architect note via Edit, then:
git add agents/docs/tasks/review/backend-p3-cleanup-sweep.md
git commit -m "architect(p3-cleanup-sweep): coordination note re: signal block

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

# Re-apply the previously-stashed content (backend's signal block + the
# original Edit of the architect note — git resolves overlap or surfaces
# a conflict for manual resolution; nothing is silently destroyed):
git stash pop
# Backend's signal block is back in the working tree, unstaged, intact.
```

## Related

- `agents/docs/solutions/conventions/commit-zone-audit-hook-2026-04-30.md` — complementary direction in the same multi-agent-working-tree hazard family. The audit hook catches `git add -A` ABSORBING other zones' content at commit time; this convention catches destructive resets DISCARDING other zones' unstaged content before commit time. Together they fence the "your edit, only your edit" discipline at both staging boundaries.
- `agents/docs/solutions/conventions/worktree-fanout-orphan-detection-2026-04-29.md` — adjacent work-loss axis on worktree fan-out (worker commits never merged back). Different mechanism, same lesson: uncommitted-or-unmerged work is silently destroyable by routine tooling.
- Root `CLAUDE.md` "Commits and Pushes" → "Stage by task scope, not via `git add -A`" — narrative source for path-scoped staging discipline. This convention extends the same principle from the staging side to the reset/checkout/restore side.
- `agents/architect/CLAUDE.md` "Architect staging" — emphasizes path-scoped `git add agents/docs/<paths>` for the architect role specifically. This convention applies the same path-scoping principle to working-tree reset operations.
- Auto-memory note `feedback_worktree_subagent_commit.md` (auto memory [claude]) — "Worker subagents in `isolation:'worktree'` must commit; uncommitted changes are reaped with the worktree." Same class of failure in the worktree-teardown scenario.

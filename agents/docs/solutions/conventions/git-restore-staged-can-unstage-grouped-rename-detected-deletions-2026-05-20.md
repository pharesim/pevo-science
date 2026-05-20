---
title: "`git restore --staged <path>` can collateral-unstage other agents' staged changes via rename-detection grouping of structurally-similar markdown task files"
date: 2026-05-20
category: conventions
module: git-workflow
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - "Running `git restore --staged <path>` to unstage a sibling agent's index entry in a shared checkout"
  - "The staged index contains both your own deletion (`D`) or addition (`A`) of a markdown file AND a sibling's add or rename of a structurally similar markdown file (e.g., another task file under `agents/docs/tasks/`)"
  - "Multi-agent concurrent commits against one `.git`, per the shared-index race discipline"
  - "Any archive flow that `git rm`'s task files concurrently with sibling hold-block bounces moving sibling task files between `pending/` / `review/` / `blocked/`"
symptoms:
  - "`git restore --staged <one-path>` silently unstages additional unrelated `D` or `A` entries"
  - "Index goes from {N D + 1 R} to empty after restoring one side of a perceived rename"
  - "Next `git commit` lands without the deletions or additions the agent believed were staged"
  - "Task files re-appear in `review/` after a supposed archive, or new task files vanish from `pending/` after a supposed file-creation commit"
tags:
  - git
  - git-restore-staged
  - rename-detection
  - shared-index
  - multi-agent
  - task-archive
  - concurrency
  - architect
related_components:
  - tooling
  - documentation
---

## Context

PEvO runs architect, backend, ui, and pinner agents concurrently against one `.git`. The shared-index race discipline already documented in the repo (see Cross-References) handles the most common failure mode: a sibling agent stages a path between your `git status` and your `git commit`, and you must verify the staged set before committing. The prescribed fix, codified in root `CLAUDE.md` "Shared-index race discipline (multi-agent checkout)" item 1, is to run `git restore --staged <foreign-path>` to drop the sibling's index entry while leaving their working-tree edit intact for them to pick up.

This convention has a quiet failure mode that the existing docs do not cover. Git's content-based rename detection runs against the full set of pending index changes. When your staged deletion (`D`) and a sibling's staged addition (`A`) share enough textual similarity, git groups them into a single logical `R` (rename) operation in the index. `git restore --staged` on either side of that grouped rename restores the **entire** rename, silently unstaging the deletion you intentionally staged.

The grouping is invisible at the `git status --short` layer: your `D` lines and the sibling's `R` line appear as separate entries even when git is internally treating one of the `D`s as the source of the sibling's `R`. The grouping only becomes visible after the restore, by which point your staged work has already vanished from the index.

PEvO task files are the canonical trigger surface for this failure mode. They live under `agents/docs/tasks/`, share a markdown skeleton (`# TASK-SLUG — Title`, `**Owner:**`, `**Created:**`, `**Priority:**`, `## Problem`, …), and routinely move between `pending/`, `review/`, and `blocked/`. Multiple task files staged for deletion (during archive) plus a sibling task move (during a hold bounce) lands well above git's default 50% similarity threshold for rename detection.

## Guidance

After every `git restore --staged` on a shared-checkout workspace, re-verify the staged set with `git diff --cached --stat` and confirm every line you expected to remain staged is still there. If anything you intentionally staged vanished, restage it explicitly by name:

- `git add <path>` for ordinary modifications and additions.
- `git rm <path>` for deletions of files that are no longer on disk (use the working-tree state — if HEAD still tracks the file and the file is gone from disk, the deletion needs to be re-staged with `git rm`, not `git add`).

Do not treat `git restore --staged <single-path>` as path-scoped. The command operates on git's logical view of the index, and if rename detection has grouped your staged change with a sibling's, restoring one path undoes the grouped pair.

Verification snippet to run immediately after every `git restore --staged` in a shared checkout:

```bash
# After: git restore --staged <foreign-path>
git diff --cached --stat
git status --short
# Confirm: every path you intended to keep staged is in --stat output.
# Confirm: no surprise unstaged 'D' / 'M' / 'A' entries that were staged a moment ago.
```

If the post-restore set is missing entries, restage by exact path:

```bash
git rm <deleted-path-1> <deleted-path-2>   # for staged deletions that reverted
git add <modified-path>                    # for staged modifications that reverted
git diff --cached --stat                   # re-verify before committing
```

Stage by explicit path list, not by directory sweep. `git add agents/docs/tasks/` would re-stage the foreign path you just dropped (and would also violate the broader narrow-staging discipline per `concurrent-agent-staging-sweep-2026-05-12.md`).

## Why This Matters

The PEvO shared-index race discipline exists because the index is a shared mutable resource and silent contamination of a commit is hard to detect after the fact. The `git restore --staged` prescription is the documented defense against sibling staging contamination — but the prescription itself can backfire when rename detection has grouped a foreign path with one of your own staged changes. Running the defense without the verification step produces three downstream failures:

1. **Lost work.** The architect's staged deletions vanish from the index. Without the `git diff --cached --stat` re-check, the next `git commit` would ship only the unstaged edits, leaving the deleted files in their pre-archive state. The recovery in the originating incident worked because the deletion was caught at the verification step before the commit; without that step, the next architect session would see ghost task files in `review/` that no longer exist on disk and have no archive entry — a state inconsistent enough to break startup-listing assumptions.

2. **Silent inversion of the defense's intent.** The prescribed `git restore --staged` is meant to leave the sibling's working-tree edit untouched while clearing the foreign index entry. Rename-detection grouping inverts this: the sibling's working-tree state is preserved (good), but your own staged work is dropped (bad — the opposite of the defense's contract).

3. **Detection latency.** Unlike the foreign-path-appears-in-staged-set failure mode (visible at the pre-commit `git diff --cached --name-only` checkpoint), rename-detection grouping produces a clean-looking post-restore index. The deletions just stop being there. The `git diff --cached --stat` cross-check is the only reliable signal short of trying the commit and finding the diff smaller than expected.

The cost of the extra verification step is a single `git diff --cached --stat` invocation. The cost of skipping it is reconstructing which paths were supposed to be staged from a session memory of "I `git rm`'d two things a minute ago."

## When to Apply

This guidance applies whenever all of the following hold:

- Multi-agent shared-checkout workspace (the PEvO default; architect, backend, ui, pinner sessions sharing one `.git`).
- You ran `git restore --staged <path>` to drop a foreign path that appeared in your staged set.
- Your own staged set contained any deletions (`D`) or additions (`A`) of files structurally similar to files a sibling may have just added, deleted, or renamed — most commonly task files under `agents/docs/tasks/`, but also any markdown-skeleton corpus (solution docs, contract docs).

It also applies prophylactically: before running `git restore --staged` in a shared checkout, note your current staged set with `git diff --cached --stat` so the post-restore comparison is straightforward. If you have staged deletions of files that share a skeleton with anything a sibling might be adding right now, expect the grouping and re-stage by explicit path after the restore.

It does NOT apply to single-agent workspaces, to `git restore --staged` runs where nothing else of yours was staged, or to `git restore --staged` runs against paths whose content is structurally unique in the staged set (e.g., a JSON config file restored while your other staged paths are TypeScript source).

## Examples

### Incident reconstruction (2026-05-20 bridge/broadcast-resilience cluster archive)

The architect was archiving two tasks. Both task files were `git rm`'d, staging two deletions:

```
agents/docs/tasks/review/backend-broadcast-attempts-key-import-sweep-rest-of-test-suite.md
agents/docs/tasks/review/backend-verify-post-success-retry-idempotency.md
```

Concurrently, a sibling architect committed a `git mv` of a round-1 hold bounce:

```
agents/docs/tasks/review/ui-bridge-register-lock-held-ux.md
  → agents/docs/tasks/pending/ui-bridge-register-lock-held-ux.md
```

The architect's `git status --short` immediately after, before any restore:

```
 M agents/docs/tasks-archive.md
R  agents/docs/tasks/review/ui-bridge-register-lock-held-ux.md -> agents/docs/tasks/pending/ui-bridge-register-lock-held-ux.md
D  agents/docs/tasks/review/backend-broadcast-attempts-key-import-sweep-rest-of-test-suite.md
D  agents/docs/tasks/review/backend-verify-post-success-retry-idempotency.md
```

The `R` line is the sibling's just-committed rename, visible because the architect's index had not yet refreshed against HEAD. Following root `CLAUDE.md` "Shared-index race discipline (multi-agent checkout)" item 1, the architect ran:

```bash
git restore --staged agents/docs/tasks/pending/ui-bridge-register-lock-held-ux.md
```

Post-restore `git status --short`:

```
 M agents/docs/tasks-archive.md
```

Both staged deletions had vanished. Git's content-based rename detection had grouped one of the architect's staged `D` markdown task files with the sibling's added markdown task file at the `pending/` path. Both files met the default 50% similarity threshold against each other (shared task-file skeleton). The `git restore --staged` on the added side restored the grouped rename, undoing the deletion on the source side.

### Recovery commands

```bash
# Confirm the state: deletions visible as unstaged D (files gone from disk, HEAD still tracks them)
git status --short

# Re-stage the deletions explicitly by exact path
git rm agents/docs/tasks/review/backend-broadcast-attempts-key-import-sweep-rest-of-test-suite.md \
       agents/docs/tasks/review/backend-verify-post-success-retry-idempotency.md

# Verify the intended set is back, and nothing extra
git diff --cached --stat

# Stage the other intended edit and commit
git add agents/docs/tasks-archive.md
git commit -m "..."
```

### Verification pattern (prophylactic)

```bash
# Note current staged set BEFORE restoring a foreign path
git diff --cached --stat > /tmp/staged-before.txt

# Drop the foreign path
git restore --staged <foreign-path>

# Compare after
git diff --cached --stat > /tmp/staged-after.txt
diff /tmp/staged-before.txt /tmp/staged-after.txt
# Expected diff: the foreign path is gone. Nothing else.
# If anything else disappeared, re-stage by exact path with git add / git rm.
```

## Cross-References

- `agents/docs/solutions/conventions/concurrent-agent-staging-sweep-2026-05-12.md` — shared-index race discipline, the broad-staging-sweeps-foreign-paths failure mode and the `git restore --staged` defense that this entry extends.
- `agents/docs/solutions/conventions/parallel-agent-git-index-race-2026-05-15.md` — the broader concurrent-staging discipline. That doc's prescription "`git restore --staged` is path-scoped and does not reach beyond its arguments" is the claim this entry refines: the path-scoped property does not hold when rename detection has grouped paths.
- Root `CLAUDE.md` "Shared-index race discipline (multi-agent checkout)" — item 1 prescribes the `git restore --staged` workflow that this entry extends with the post-restore verification step; item 3 covers the related `Edit → git add → git mv → commit` sequencing for task-file moves with content edits.
- `agents/docs/solutions/conventions/commit-zone-audit-hook-2026-04-30.md` — the `commit-msg` zone-audit hook is a backstop for cross-zone staging contamination but cannot catch within-zone collateral-unstage via rename detection (the lost deletion stays within the architect's own zone).

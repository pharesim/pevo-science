---
title: "Bare `git commit` sweeps sibling-staged paths between verify and commit; the `-- <paths>` pathspec form is the defense"
date: 2026-05-21
last_updated: 2026-05-26
category: conventions
module: agent-coordination
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - "Multiple agent sessions (architect + architect, architect + backend, ui + pinner, etc.) running concurrently against one shared `.git` checkout"
  - "About to commit narrow per-task work after a `git diff --cached --name-only` verify showed a clean staged set"
  - "Composing a sequence of hold-block commits or archive moves in quick succession (each commit re-opens the race window)"
  - "Recovering from a contaminated commit via `git reset --soft <my-sha>` + `git restore --staged <foreign-paths>` and about to recommit"
  - "Any commit on the shared `main` checkout where the chained `git add ... && git commit` mitigation from `parallel-agent-git-index-race-2026-05-15.md` is insufficient because the contamination is occurring at commit time, not staging time"
  - "`git status` after a commit you intended as a rename shows a stray `D` on the source path — the pathspec named only the destination and split the `git mv`"
tags:
  - git
  - staging-discipline
  - multi-agent
  - concurrency
  - commit-discipline
  - architect
  - pathspec
related_components:
  - documentation
  - tooling
---

## Context

PEvO regularly runs architect, backend, ui, and pinner agent sessions concurrently against one shared `.git` checkout. The root `CLAUDE.md` "Agent Coordination Rules" preamble already pins the posture: assume another agent is active right now. The index is a shared mutable resource — sibling sessions can `git add` paths into it at any moment, including the millisecond gap between your `git diff --cached --name-only` verify and your `git commit`.

Two prior conventions cover adjacent failure modes in this hazard family:

- `concurrent-agent-staging-sweep-2026-05-12.md` — broad-add (`git add -A` / `git add .` / `git commit -a`) sweeps the entire index, foreign or otherwise. Prescribes per-path staging plus `git diff --cached --name-only` verification.
- `parallel-agent-git-index-race-2026-05-15.md` — chain stage and commit atomically in one shell expression so the race window shrinks. Acknowledges the window does not fully close.

Both treat the race window as "small enough that interleaves are rare" but neither closes it mechanically. The architect session on 2026-05-21 hit the residual window twice in a row despite holding to both prior conventions: per-path staging was correct, `git diff --cached --name-only` verified clean immediately prior, and the bare `git commit` still swept in two sibling-architect untracked task files that landed in the index between verify and commit. The third commit in the same session used `git commit -m "..." -- <explicit-paths>` and was clean even though the same untracked sibling work was still in the working tree.

## Guidance

**Default to `git commit -m "..." -- <explicit-paths>` for every agent commit on the shared checkout.** Pass every intended path after the `--` separator. Per `git commit(1)`, when paths are given as positional arguments, git commits ONLY the index entries for those paths; any other entries remain staged untouched.

For a `git mv` (task-state transition between `pending/` ↔ `review/` ↔ `blocked/`), pass BOTH sides — the add-at-destination AND the delete-from-source. `git mv` writes two index entries; `git commit -- <one-path>` only commits one of them.

```bash
git add agents/docs/tasks/review/backend-foo.md && \
  git mv agents/docs/tasks/review/backend-foo.md agents/docs/tasks/pending/backend-foo.md && \
  git commit -m "$(cat <<'EOF'
architect(backend-foo): round-N hold

<body>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)" -- agents/docs/tasks/pending/backend-foo.md agents/docs/tasks/review/backend-foo.md
```

The bare `git commit` form (no `--`) commits the entire current index and is acceptable only when you can guarantee no concurrent staging — solo-agent work, or work inside an isolated worktree (each worktree has its own index).

## Why this matters

The two prior conventions in this family address staging-side discipline (per-path adds, chained `&&`). Both leave a residual window: between any `git diff --cached --name-only` verify and the immediately-following `git commit`, a sibling session's `git add` can land in the index. Detection happens before the sibling stages; the commit happens after. The standard remediation (`git restore --staged <foreign-path>`) only works if you can SEE the foreign path before committing — and by definition you cannot when the sibling stages within the verify-to-commit window.

The explicit-path-arg defense closes the window mechanically rather than by timing. `git commit -- <paths>` commits only the named index entries by path, regardless of what else has accumulated in the index between your verify and your commit. The sibling's foreign-staged entries stay staged for the sibling's own commit. No coordination dance, no `git restore --staged` round trip, no widening race window.

The defense is also robust against the inverse case: your own forgotten staged path from an earlier session step does not get swept in unless you name it on the commit line. Forcing the explicit enumeration is itself a final sanity check on intent.

## When to apply

- **Default for every agent commit on the shared `main` checkout.** The bare `git commit` is acceptable only when you can guarantee no concurrent staging — solo-agent work, or work inside an isolated worktree.
- **Mandatory for task-state transitions** (`git mv` between `pending/` ↔ `review/` ↔ `blocked/`). These have two index entries to enumerate and are the most common shape that exhibits the race in practice.
- **Mandatory for archive commits** (`git add tasks-archive.md` + `git rm tasks/review/<slug>.md`). Also two-path, also high-frequency under parallel architect activity.
- **Mandatory for any commit where `git status` shows working-tree changes you do not recall touching**, even if your own staged set verifies clean. Visible foreign work suggests an invisible foreign stage may follow.

## Examples

Task-file move (review → pending, hold-block round):

```bash
git add agents/docs/tasks/review/backend-foo.md && \
  git mv agents/docs/tasks/review/backend-foo.md agents/docs/tasks/pending/backend-foo.md && \
  git commit -m "architect(backend-foo): round-3 hold (N items)" \
    -- agents/docs/tasks/pending/backend-foo.md agents/docs/tasks/review/backend-foo.md
```

Both the add-at-pending and the delete-from-review are named; one commit captures the rename atomically.

Archive commit (tasks-archive prepend + git rm):

```bash
git add agents/docs/tasks-archive.md && \
  git rm agents/docs/tasks/review/backend-foo.md && \
  git commit -m "architect(backend-foo): archive — round-N clean" \
    -- agents/docs/tasks-archive.md agents/docs/tasks/review/backend-foo.md
```

Mixed-zone commit (root CLAUDE.md narrative + task file):

```bash
git add CLAUDE.md agents/docs/tasks/review/backend-foo.md && \
  git commit -m "architect(<scope>): <subject> [skip-zone-audit]" \
    -- CLAUDE.md agents/docs/tasks/review/backend-foo.md
```

Cross-zone commits additionally need `[skip-zone-audit]` in the subject per `commit-zone-audit-hook-2026-04-30.md`; orthogonal concern.

Single-file edit (no mv, no rm):

```bash
git add agents/docs/ARCHITECTURE.md && \
  git commit -m "architect(arch): <subject>" -- agents/docs/ARCHITECTURE.md
```

## What didn't work

The session's first two commits used the canonical chained shape from prior conventions:

```bash
git add <task-file> && git mv <review> <pending> && \
  git diff --cached --name-only && \
  git commit -m "..."
```

The `git diff --cached --name-only` step verified clean (only my own paths). The `git commit` immediately following landed two foreign untracked task files in the index — visible only after the fact via `git show --stat <sha>`. The same untracked files were still in the working tree (sibling-architect work-in-progress, not yet committed by them), consistent with the sibling having run `git add` in the millisecond window between my verify and my commit.

The third commit in the session used the pathspec form (`git commit -- <pending-path> <review-path>`) with the same untracked sibling work still sitting in the working tree. That commit was clean — only the two named paths landed. The defense behaved as advertised.

The `git restore --staged` post-detection remediation from `concurrent-agent-staging-sweep-2026-05-12.md` is correct for the case where you detect the foreign path BEFORE committing. It cannot help with the verify-to-commit race because there is no detection turn between the race and the commit.

## Multi-path caveat

`git mv` records two index entries (add at destination, delete from source). `git commit -- <one-path>` commits only the named entry. If you pass only the destination path, the delete-from-source remains staged and lands in a follow-up commit (noisier; observed in the 2026-05-21 session as a trailing "complete the mv" commit cleaning up after the main hold-block commit).

Pass BOTH sides explicitly:

```bash
git commit -m "..." -- agents/docs/tasks/pending/backend-foo.md agents/docs/tasks/review/backend-foo.md
```

This is the cleanest shape — one commit captures the full rename, no follow-up needed. The alternative (commit destination, then commit the source-delete separately) is acceptable but produces two commits where one was intended and the second commit's subject must explain the leftover.

**Detection.** A commit that reports `create mode …` (or `N insertion(s)(+)` with no `rename … =>` line) when you intended a rename has captured only one half. Confirm immediately after any rename commit with `git show --name-status HEAD` — the source path must appear as a `D` (or the move as a single `R … => …` line); its absence means the delete-side was excluded from the commit. `git status` corroborates: a stray `D <source-path>` (or an `A`/`??` on the destination) for the move's other half means the rename is split between the index and HEAD — the destination lives in HEAD while the source-delete dangles in the index. This recurred on 2026-05-26 (architect holding a UI task back to `pending/`): the hold-block commit named only the two `pending/` paths, so HEAD carried the task in both `review/` and `pending/` until a follow-up commit recorded the `review/` delete — the same single-destination-pathspec split this section warns about, reinforcing that the post-commit `git show --name-status HEAD` check is worth running even when you believe the pathspec was complete. In PEvO's task tree this is worse than cosmetic: the same task file present in both `blocked/` and `review/` (or `pending/` and `review/`) at once corrupts the state machine the directories encode, and a sibling agent reading the tree at startup cannot tell which state is authoritative.

**Recovery.** If the half-committed move is your own most recent, not-yet-pushed HEAD commit, fold the dangling half in with `git commit --amend --no-edit` — the commit re-renders as a single `rename <src> => <dst>` line. First run `git diff --cached --name-status` and confirm the staged set is ONLY the move's leftover half and nothing foreign: `--amend` with no pathspec commits the whole index, so an unverified amend re-opens the very sweep this convention exists to prevent. Amend is safe ONLY because the commit is yours and unpushed — on the shared `main` checkout never amend or rewind past a commit a sibling may have authored; use `git revert` instead (root `CLAUDE.md` "Shared-index race discipline" item 2).

## Related Conventions

- `concurrent-agent-staging-sweep-2026-05-12.md` — sibling defense. The `git diff --cached --name-only` verify ritual catches contamination present BEFORE the commit; this convention closes the residual window between verify and commit by removing the index-wide commit shape entirely.
- `parallel-agent-git-index-race-2026-05-15.md` — complementary mitigation. That doc's chained-shell `git add ... && git commit` shrinks the verify-to-commit window; pathspec commit eliminates the index-state dependency at commit time for the named paths entirely. Chaining alone does not close the window; explicit-path commits do.
- `commit-zone-audit-hook-2026-04-30.md` — backstop that cannot catch this. The hook catches cross-role contamination via the staged path list. It cannot catch within-role (e.g., architect-on-architect) contamination because both swept-up and intended paths pass the same `allowed_for_agent()` filter. The explicit-path-arg defense is the layer that handles within-role races.
- `git-restore-staged-can-unstage-grouped-rename-detected-deletions-2026-05-20.md` — sibling refinement of root `CLAUDE.md` "Shared-index race discipline" item 1. Both extend the verify-and-restore defense from different angles (rename-detection collateral-unstage vs verify→commit race).
- Root `CLAUDE.md` "Shared-index race discipline" — narrative posture and item 1 (`git restore --staged` after `git diff --cached --name-only` verify). This convention adds the layer below: when verify-to-commit cannot be made race-free, switch the commit shape itself to `git commit -- <explicit-paths>`.

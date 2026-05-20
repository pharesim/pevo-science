---
title: "Broad `git add` on a shared checkout sweeps concurrent sessions' staged operations into the wrong commit"
date: 2026-05-12
category: conventions
module: agent-coordination
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - "Any commit on a checkout that has run more than one concurrent agent session during the current working period"
  - "Architect about to commit after any non-trivial interval where another session could have staged work (typical during parallel `/ce-compound`, `/ce-code-review`, or archive flows)"
  - "Archive commits specifically — they touch both `tasks-archive.md` and a `git rm` path, two distinct staged operations that are easy to lose track of if a sweep occurs"
  - "Any time the shell harness shows the cwd shared with another agent window (architect + architect, architect + backend, etc.)"
tags:
  - git
  - staging-discipline
  - multi-agent
  - concurrency
  - commit-discipline
  - architect
related_components:
  - documentation
  - tooling
---

## Context

PEvO regularly runs multiple agent sessions concurrently against the same dev checkout: architect, backend, ui, and pinner agents all operate in parallel windows that share one working tree and one git index. Each role owns a zone (per root `CLAUDE.md` "Commits and Pushes" and the runtime-authoritative `.githooks/commit-msg` `allowed_for_agent()` function), and the commit-msg zone-audit hook (see `commit-zone-audit-hook-2026-04-30.md`) catches commits whose staged paths fall outside the committing role's zone. The hook is the backstop for cross-role contamination.

A subtler failure mode is **within-zone concurrent-session contamination**, which the zone hook cannot detect. On 2026-05-12, two architect sessions ran simultaneously:

- **Session A** ran `/ce-code-review` on commit `8421a17`, found it clean, then staged its archive operation:

  ```bash
  git add agents/docs/tasks-archive.md
  git rm agents/docs/tasks/review/backend-broadcast-idempotency-cluster-followup.md
  ```

  Intent: commit both with subject `architect(tasks): archive backend-broadcast-idempotency-cluster-followup (round-5 re-review clean)`.

- **Session B**, running a parallel `/ce-compound` flow on the logger-wrapper task, committed first using a broad-add staging command (most likely `git add agents/docs/solutions/` or `git add -A` — the exact command is unrecoverable from the resulting commit, only its effect).

The resulting commit `1a7a264` on `main` carries subject `architect(compound): back-link 3 redact-policy entries to strict-superset-wrapper` but its diff is:

```
M agents/docs/solutions/conventions/defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11.md
M agents/docs/solutions/conventions/pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md
M agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md
D agents/docs/tasks/review/backend-broadcast-idempotency-cluster-followup.md
```

The task-file deletion has nothing to do with redact-policy back-linking. Session A's archive commit, when it landed (`ab3fa69`), now only carries the `tasks-archive.md` prepend — its corresponding `git rm` lives under a semantically unrelated subject line, permanently.

## Why This Matters

Subject-vs-diff drift corrupts the audit trail and the corruption is permanent:

- `git log --oneline --follow agents/docs/tasks/review/backend-broadcast-idempotency-cluster-followup.md` resolves the deletion to `1a7a264`, a commit whose subject describes solutions-doc edits. Future archaeology hits a dead end — the rationale for the task's archival lives in a different commit (`ab3fa69`) that has no diff for the file.
- The zone-audit hook at `.githooks/commit-msg` does not catch this. Both `agents/docs/tasks/review/` and `agents/docs/solutions/conventions/` are inside the architect zone. Zone validation is necessary but not sufficient: it cannot distinguish "I intended to stage this path" from "another session staged this path and I swept it up."
- The existing per-path staging rule in root `CLAUDE.md` "Commits and Pushes" prevents the *initiating* error (don't run broad-add yourself) but does not protect against the *receiving* error: a disciplined `git add path/to/foo.md` is safe in isolation, but if the index already holds another session's staged entries when *anyone* runs `git commit -a` or `git add -A`, those entries are swept in regardless of how disciplined the rest of the staging was.
- Amend is not a viable fix once the contaminated commit is pushed. Even before push, amending session B's commit to remove the foreign deletion requires re-staging the foreign `git rm` afterward — which is exactly the coordination dance the discipline is meant to avoid.

## Guidance

**Before every `git commit`, run:**

```bash
git diff --cached --name-only
```

Compare the output against the explicit path list you staged this session. Any extra entry means another session's staged work is present in the index.

**If the staged set is clean (matches your intent):**

```bash
# Proceed normally
git commit -m "$(cat <<'EOF'
architect(tasks): archive backend-broadcast-idempotency-cluster-followup (round-5 re-review clean)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**If extra entries appear, do not commit.** Unstage only the foreign paths and commit narrowly:

```bash
# Unstage the foreign entry (does NOT touch the file on disk and does NOT
# discard the other session's intent — the path stays modified/deleted in
# the working tree, just no longer in the index)
git restore --staged agents/docs/tasks/review/backend-broadcast-idempotency-cluster-followup.md

# Verify the staged set is now clean
git diff --cached --name-only

# Commit your intended paths only
git commit -m "$(cat <<'EOF'
architect(compound): back-link 3 redact-policy entries to strict-superset-wrapper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

The foreign session's intent survives the unstage: their `git rm` removed the file from the working tree and `git restore --staged` only resets the index entry. When the foreign session runs its own `git commit`, it will need to `git rm` the path again (or `git add -u` to pick up the disk-level deletion). That is acceptable coordination cost; preserving subject-vs-diff coherence on `main` is worth it.

**Never use broad staging commands on a shared checkout:**

```bash
# Forbidden — sweeps the entire index including other sessions' staged paths
git commit -a
git add -A
git add .
git add agents/docs/         # broad-directory adds are also forbidden
git add backend/             # even within a single role's zone
```

The forbid is already on the books in root `CLAUDE.md` "Commits and Pushes"; the rationale this convention adds is specifically that the **index is a shared mutable resource** across concurrent sessions, not just a wide-net hygiene concern. Per-path staging plus `git diff --cached --name-only` verification is the two-layer discipline.

## When to Apply

- Any commit on a checkout where another agent window is open or recently closed during the current working period.
- Mandatory before archive commits, which touch both `tasks-archive.md` and a `git rm` path. The two-path staging shape makes them especially easy to lose track of if a foreign entry sneaks in.
- Before any commit made after an `Agent`/`Task` dispatch returns: a worker subagent may have committed back to the parent's branch in the interval.
- When a `/ce-compound`, `/ce-code-review`, or `/ce-plan` flow is running in one window while an archive or task-state transition is in progress in another.
- When `git status` shows files modified that you do not recall touching — investigate before committing, even if the paths are inside your zone.

## Examples

**Contaminated staged set detected:**

```
$ git diff --cached --name-only
agents/docs/solutions/conventions/defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11.md
agents/docs/solutions/conventions/pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md
agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md
agents/docs/tasks/review/backend-broadcast-idempotency-cluster-followup.md   ← NOT mine
```

Session B's intended commit covers only the three `solutions/conventions/` edits. The `tasks/review/` deletion is Session A's staged `git rm`. Committing now (as happened in `1a7a264`) embeds the task-file deletion in a redact-policy back-link commit.

**Corrective action:**

```bash
$ git restore --staged agents/docs/tasks/review/backend-broadcast-idempotency-cluster-followup.md

$ git diff --cached --name-only
agents/docs/solutions/conventions/defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11.md
agents/docs/solutions/conventions/pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md
agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md
```

Clean. Commit proceeds with the intended scope. Session A's `git rm` remains a working-tree change (the file is gone from disk) and will be re-staged by session A's own archive commit.

## Companion hazard: destructive rewind by concurrent session

Within minutes of the canonical incident above (commit `1a7a264`), the same pair of architect sessions surfaced a second, materially worse failure mode. The full reflog sequence:

```
08972f6 HEAD@{0}: commit: architect(compound): cross-link strict-superset-wrapper escape-hatch sibling
56cd171 HEAD@{1}: commit: architect(tasks): file backend-review-validity-gate-and-display-reputation-parity, backend-self-review-exclusion-everywhere
c33f8e6 HEAD@{2}: reset: moving to HEAD~1
3c92741 HEAD@{3}: commit: architect(tasks): file backend-review-validity-gate-and-display-reputation-parity, backend-self-review-exclusion-everywhere
c33f8e6 HEAD@{4}: reset: moving to HEAD~1
1a7a264 HEAD@{5}: reset: moving to HEAD~1    ← rewinds past two commits…
ab3fa69 HEAD@{6}: commit: architect(tasks): archive backend-broadcast-idempotency-cluster-followup   ← session A's archive, dropped from main
1a7a264 HEAD@{7}: commit: architect(compound): back-link 3 redact-policy entries to strict-superset-wrapper
```

Read bottom-up: session A had landed its archive commit on top of the contaminated `1a7a264`. Session B then ran `git reset --hard HEAD~1` twice — apparently to "fix" the contamination by rewinding past `1a7a264` and rebuilding cleanly. The two resets dropped BOTH `1a7a264` AND `ab3fa69`. Session B then re-committed only its own intended work (`3c92741` → reset → `56cd171`, message-rewritten), leaving session A's archive entirely absent from `main`'s linear history. The task file resurrected in `tasks/review/`, the archive narrative reverted to unstaged in session A's working tree, and the only trace of session A's archive commit lived in the reflog.

**Why this is the same hazard family but worse:**

- The staging sweep (above) corrupts a commit message; the rewind silently *drops the commit entirely*. Audit-trail loss is replaced with code/state loss.
- `git reflog` is time-bounded: unreachable commits expire after `gc.reflogExpireUnreachable` (default 30 days for HEAD, faster for refs/stash). A force-push during the window or an aggressive `git gc` can shrink the recovery window further. The window felt comfortable in this incident; it is not always.
- The rewinder's intent (clean up contamination) is benign and disciplined-looking — `git reset --hard HEAD~N` is the textbook way to undo your own most recent local commit. The defect is that on a shared checkout, "your own most recent" can be someone else's by the time you run the command.

**Detection:**

```bash
# After any unexpected absence of your commit from the linear history:
git reflog | head -30        # search for your subject line
git log <your-commit-sha>    # confirm the commit object still exists
```

If your subject appears in the reflog but not in `git log HEAD`, a destructive rewind has dropped it.

**Recovery:**

```bash
# Cherry-pick the orphaned commit back onto current HEAD
git cherry-pick <your-orphaned-sha>

# Or if you have uncommitted working-tree changes that match the orphaned commit
# (the typical "commit got reset away but my edits are still in the tree" case):
#   1. Verify the working tree carries the same content as the orphaned commit:
git diff <your-orphaned-sha> -- <paths>
#   2. Stage explicitly and commit fresh with a redo note in the body — see "Re-establishing dropped commits" below.
```

**Re-establishing dropped commits (commit-body etiquette):** when re-doing an archive or other coordination-state commit that was dropped by a rewind, add one line to the commit body noting the original SHA from the reflog: `Re-establishes archive commit <orig-sha> dropped by destructive rewind at <date>.` This prevents future archaeology from concluding the archive was always at the redo's SHA — the reflog window is finite and the original SHA's audit value evaporates without the cross-reference.

**Prevention (rewinder side):**

Do not `git reset --hard HEAD~N` past commits you did not author on a shared branch. If you see a contaminated commit on top of your work (e.g., the canonical staging-sweep incident above), the correct fix is **forward-only**:

```bash
# Wrong on a shared branch — drops everything between current HEAD and the target,
# regardless of authorship:
git reset --hard HEAD~1   # ← FORBIDDEN if the dropped commit isn't yours

# Right — leaves the contaminated commit in history (still flawed, but auditable),
# adds a clean correcting commit on top:
git revert <contaminated-sha>     # auto-generates inverse commit
# OR coordinate with the contaminating-session author to amend before they push.
```

`git revert` produces a `Revert "..."` commit that other sessions' work above is preserved against. Yes, the contaminated commit is permanently in history. Yes, the subject-vs-diff drift it captured is permanent. That is the cost of choosing forward-only on a shared branch; the alternative is silent loss of unrelated work.

**Prevention (committer side):**

If you are committing on a shared branch and have any reason to suspect you may want to "fix" the commit later via rewind, push to a private branch first, work out the fix there, and merge or PR. Once a commit is on a shared branch with other sessions actively working from its tip, rewinds are no longer a unilateral option.

## Related Conventions

- `commit-zone-audit-hook-2026-04-30.md` — zone-audit catches cross-role broad-staging contamination at commit time. This convention catches within-role, same-zone session contamination that the hook cannot distinguish (both swept-up and intended paths are in the architect zone in the canonical incident, so the hook rubber-stamps the contaminated commit).
- `git-checkout-head-destroys-coresident-unstaged-2026-05-11.md` — sibling member of the multi-agent shared-checkout hazard family. The hazard taxonomy now has five members:
  - **(1) Cross-zone staging at commit time** — broad `git add` sweeps another *role's* in-flight edits (the April 30 zone-hook entry catches this via the commit-msg hook).
  - **(2) Working-tree destruction at reset time** — `git checkout HEAD -- <path>` or `git restore <path>` destroys another agent's unstaged content (the May 11 entry).
  - **(3) Within-zone staging at commit time** — broad `git add` or `git commit -a` sweeps another *session's* staged work in the same role (the staging-sweep section of this entry — zone hook cannot catch).
  - **(4) Destructive rewind by concurrent session** — `git reset --hard HEAD~N` on a shared branch drops commits the rewinder did not author (the rewind section of this entry — only the reflog catches it, time-bounded).
  - **(5) Collateral unstage via rename detection** — `git restore --staged <path>` silently unstages other paths git's content-based rename detection has grouped with it above the 50% similarity threshold (most often markdown task files sharing a skeleton). The defense from this entry (use `git restore --staged` to unstage foreign paths) is itself the trigger surface; only a post-restore `git diff --cached --stat` re-check catches it. See `git-restore-staged-can-unstage-grouped-rename-detected-deletions-2026-05-20.md`.
- Root `CLAUDE.md` "Commits and Pushes" — the explicit-path staging mandate. This convention enforces that mandate at the verification layer (`--cached` inspection) rather than only the staging layer (per-path `git add`), and forbids `git reset --hard HEAD~N` past commits you did not author.
- `worktree-fanout-orphan-detection-2026-04-29.md` — adjacent family member. Different mechanism (claimed-commit SHA never merged from a worker worktree back to main), same class of "routine git tooling silently corrupts shared coordination state."

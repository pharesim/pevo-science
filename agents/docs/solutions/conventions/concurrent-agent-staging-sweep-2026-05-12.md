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

## Related Conventions

- `commit-zone-audit-hook-2026-04-30.md` — zone-audit catches cross-role broad-staging contamination at commit time. This convention catches within-role, same-zone session contamination that the hook cannot distinguish (both swept-up and intended paths are in the architect zone in the canonical incident, so the hook rubber-stamps the contaminated commit).
- `git-checkout-head-destroys-coresident-unstaged-2026-05-11.md` — third member of the multi-agent shared-checkout hazard family. The hazard taxonomy:
  - **Staging contamination at commit time** — broad `git add` sweeps another session's staged work (this entry).
  - **Working-tree destruction at reset time** — `git checkout HEAD -- <path>` destroys another agent's unstaged content (the May 11 entry).
  - **Cross-zone staging at commit time** — broad `git add` sweeps another *role's* in-flight edits (the April 30 zone-hook entry).
- Root `CLAUDE.md` "Commits and Pushes" — the explicit-path staging mandate. This convention enforces that mandate at the verification layer (`--cached` inspection) rather than only the staging layer (per-path `git add`).
- `worktree-fanout-orphan-detection-2026-04-29.md` — adjacent family member. Different mechanism (claimed-commit SHA never merged from a worker worktree back to main), same class of "routine git tooling silently corrupts shared coordination state."

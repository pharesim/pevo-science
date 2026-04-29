---
title: Commit-time agent-zone audit prevents cross-agent commit-scope drift in fan-out workflows
date: 2026-04-30
category: conventions
module: agent-coordination
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - Fan-out worker subagents about to invoke `git add` and `git commit`
  - Parent agents preparing a checkpoint commit before fan-out
  - Any agent committing while another agent's mid-flight edits sit in the working tree (common during architect-orchestrated rounds)
  - Investigating a commit whose paths cross zone boundaries (e.g. `backend:` commit touching `agents/docs/` or `frontend/`)
tags:
  - agent-coordination
  - git-workflow
  - commit-discipline
  - fan-out
  - hook
related_components:
  - tooling
  - documentation
---

## Context

PEvO uses worktree fan-outs to parallelize implementation across worker subagents (per root `CLAUDE.md` "Worktree Cleanup" and the per-agent `agents/<role>/CLAUDE.md` "Parallel task execution" sections). Each agent owns a specific zone:

| Agent     | Zone (paths)                                                                                |
|-----------|---------------------------------------------------------------------------------------------|
| architect | `agents/docs/`, `agents/<role>/CLAUDE.md`, `CLAUDE.md`, `README.md`, `Dockerfile`, `docker-compose*.yml`, `.githooks/` |
| backend   | `backend/`                                                                                  |
| ui        | `frontend/`                                                                                 |
| pinner    | `pinner/`                                                                                   |

Task-file moves under `agents/docs/tasks/{pending,review,blocked}/` are zone-bound by the file's slug prefix (`backend-...`, `ui-...`, `architect-...`, `pinner-...`), not by the directory.

Cluster 1 review of `backend-bridge-paper-author-gate.md` round-2 commit `3c2a2a1` on 2026-04-30 surfaced a recurring drift pattern: a backend worker subagent's commit included three unrelated `git mv` operations of architect-driven task-file transitions (`tasks/review/` → `tasks/pending/`) bundled with the bridge-paper implementation diff. The proximate cause was `git add -A` (or `git add .`) staging — the architect's mid-flight moves were sitting in the working tree, the worker forked from that state, and the bulk-stage swept them in. A second instance (`72978a0`) crossed the boundary in the opposite direction (a backend commit edited `agents/docs/ARCHITECTURE.md`).

The pre-existing "before fan-out, commit in-flight work" rule in root `CLAUDE.md` doesn't fully cover this: it forces the parent to commit *all* in-flight work, even work in zones the worker doesn't touch. That's overly rigid when the parent's mid-flight zone is non-overlapping with the worker's task scope. The right backstop is at commit time, on path-scoped zones.

## Guidance

Two layers, both required:

### 1. Path-scoped staging (cultural primary)

When committing in any agent role, stage by your task's declared scope. **Do not use `git add -A` or `git add .`.** Concrete shapes per role:

```bash
# backend
git add backend/<paths>
git add agents/docs/tasks/<dir>/backend-<slug>.md

# ui
git add frontend/<paths>
git add agents/docs/tasks/<dir>/ui-<slug>.md

# pinner
git add pinner/<paths>
git add agents/docs/tasks/<dir>/pinner-<slug>.md

# architect
git add agents/docs/<paths>
git add CLAUDE.md   # root
git add agents/<role>/CLAUDE.md
git add agents/docs/tasks/<dir>/architect-<slug>.md
git add docker-compose.yml
git add .githooks/<paths>
```

Anything outside your task's declared scope stays unstaged for the parent or sibling agents to pick up.

### 2. Commit-time zone audit (mechanical backstop)

`.githooks/commit-msg` parses the agent prefix from the commit subject and rejects commits whose staged paths fall outside the matching zone. Activate per clone via:

```bash
git config core.hooksPath .githooks
```

Recognized subject prefixes:

```
architect:                 architect(<scope>):
backend:                   backend(<scope>):
ui:                        ui(<scope>):
pinner:                    pinner(<scope>):
```

Behavior:

- Unrecognized prefixes (`chore: ...`, `fix: ...`, `Merge ...`, `revert: ...`) skip the audit and accept the commit. The audit is opt-in by prefix.
- Add `[skip-zone-audit]` to the subject for genuine cross-agent commits (use sparingly; the rejection message itself names this escape hatch).
- Task-file moves are evaluated by SLUG prefix, not directory — `backend:` moving `tasks/review/backend-X.md` → `tasks/pending/backend-X.md` is allowed; `backend:` moving `tasks/review/ui-Y.md` is rejected.

## Why This Matters

- **Worker commits silently absorb parent's mid-flight work.** `git add -A` in a worker subagent sweeps the entire working tree, including parent agents' uncommitted edits in non-overlapping zones. The resulting commit attributes architect-driven task transitions to a backend worker, breaking per-agent git-blame attribution and making bisect harder.
- **The "commit before fan-out" rule alone is too rigid.** Forcing the parent to commit all in-flight work before every fan-out either churns the history (one tiny architect commit per fan-out) or blocks fan-outs while the parent finishes unrelated zone work. Zone-scoped staging lets parent and worker zones coexist in the working tree without interference.
- **Cost is asymmetric.** The hook is ~100 lines of bash and fires only on rule violation; expected steady state is silent. The cost of *not* having it is per-fan-out architect cycles spent untangling commit-scope drift at code-review time.
- **Fan-out volume only grows.** Each new round multiplies the surface area for `git add -A` accidents. Catching the violation at commit time, not at code-review time, is mechanically cheaper for the project.

## When to Apply

- Every commit by any agent (architect, backend, ui, pinner, worker subagents). Path-scoped `git add` is the always-on discipline; the hook is the always-on backstop.
- Initial repo setup (or a fresh clone): run `git config core.hooksPath .githooks` once. The setting is per-clone and not git-tracked, so each new clone needs the activation step (documented in `README.md`).
- When a hook rejection fires legitimately (a one-off cross-agent refactor): split the commit into per-zone commits. If the cross-agent shape is intentional and atomicity matters, append `[skip-zone-audit]` to the subject and proceed — the exemption is logged to stderr.

## Examples

### Backend worker staging by scope (correct)

```bash
# Worker just finished work on tasks/pending/backend-foo.md
git add backend/src/routes/foo.ts backend/tests/routes/foo.test.ts
git add agents/docs/tasks/pending/backend-foo.md   # scoped to own task move only
git mv agents/docs/tasks/pending/backend-foo.md agents/docs/tasks/review/backend-foo.md
git commit -m "backend: ship backend-foo task"
# Hook: prefix=backend, all paths under backend/ or backend-slug task file → ACCEPT
```

### Worker accidentally bulk-stages parent's task moves (rejected)

```bash
# Architect has mid-flight `git mv tasks/review/backend-bar.md tasks/pending/backend-bar.md`
# (HELD PENDING FIXES block append) sitting unstaged in the working tree.
# Worker runs:
git add -A
git commit -m "backend: ship backend-foo task"
# Hook: prefix=backend, staged paths include both backend-foo and backend-bar (architect-driven move)
# Reading the rule strictly, both slugs match `backend-`, so this passes by SLUG, BUT
# in practice the architect's move would be accompanied by an architect-zone hold-block
# edit that ALSO got swept up.
# The hook rejects on whatever the bulk-stage swept that the prefix doesn't allow.
```

### Backend commit accidentally edits ARCHITECTURE.md (rejected — `72978a0` shape)

```bash
git add backend/src/routes/auth.ts agents/docs/ARCHITECTURE.md
git commit -m "backend: route + arch update"
# Hook output:
#   commit-msg: zone audit FAILED
#     agent prefix parsed: backend
#     staged paths outside allowed zones (1):
#       - agents/docs/ARCHITECTURE.md
# Recovery: `git restore --staged agents/docs/ARCHITECTURE.md`, recommit, then
# the architect picks up the ARCHITECTURE.md edit in a separate commit.
```

### Intentional cross-agent commit (exemption)

```bash
git add backend/src/foo.ts frontend/src/bar.js
git commit -m "backend: shared util migration [skip-zone-audit]"
# Hook output:
#   commit-msg: zone audit SKIPPED ([skip-zone-audit] in subject)
# Use sparingly; cross-agent commits should be the exception, not the routine.
```

## Related conventions

- Root `CLAUDE.md` "Commits and Pushes" — top-level commit discipline, including the `Co-Authored-By:` trailer requirement and the "commit before fan-out" rule. The path-scoped staging guidance and hook reference live there.
- Root `CLAUDE.md` rule #2 — agent ownership boundaries; the source-of-truth for the zone map. The hook's allowlist is a derivation of this rule, not a parallel definition.
- `agents/docs/solutions/conventions/worktree-fanout-orphan-detection-2026-04-29.md` — adjacent fan-out failure mode (worker commits never merged back to the orchestrating branch). Both target dirty-tree-fan-out failure families; the orphan-detection convention catches work-loss, this one catches commit-scope drift.

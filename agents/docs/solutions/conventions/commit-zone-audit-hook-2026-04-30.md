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

PEvO uses worktree fan-outs to parallelize implementation across worker subagents (per root `CLAUDE.md` "Worktree Cleanup" and the per-agent `agents/<role>/CLAUDE.md` "Parallel task execution" sections). Four agent roles each own a distinct zone:

- **architect** — `agents/docs/`, per-agent `agents/<role>/CLAUDE.md`, root `CLAUDE.md`, `README.md`, `LICENSE`, `.gitignore`, `.dockerignore`, `.env.example`, `Dockerfile`, `docker-compose*.yml`, `deploy.sh`, `.githooks/`, plus any-slug task files under `agents/docs/tasks/` (rule #8 hold-block & review→pending moves are architect-driven for any agent's tasks).
- **backend** — `backend/`, plus `backend-<slug>` task files (own slug only, pending→review direction only).
- **ui** — `frontend/`, plus `ui-<slug>` task files (own slug only, pending→review direction only).
- **pinner** — `pinner/`, plus `pinner-<slug>` task files (own slug only, pending→review direction only).

The runtime-authoritative zone map is `.githooks/commit-msg`'s `allowed_for_agent()` function. The narrative summary above and the architect's "Files You Own" list in `agents/architect/CLAUDE.md` are derived references; when extending the zone map, update the hook first, then sync the doc summary and the architect list.

Cluster 1 review of `backend-bridge-paper-author-gate.md` round-2 commit `3c2a2a1` on 2026-04-30 surfaced the recurring drift pattern: a backend worker subagent's commit included three unrelated `git mv` operations of architect-driven task-file transitions (`tasks/review/` → `tasks/pending/`) bundled with the bridge-paper implementation diff. The proximate cause was `git add -A` (or `git add .`) staging — the architect's mid-flight moves were sitting in the working tree, the worker forked from that state, and the bulk-stage swept them in. A second instance (`72978a0`) crossed the boundary in the opposite direction (a backend commit edited `agents/docs/ARCHITECTURE.md`).

The pre-existing "before fan-out, commit in-flight work" rule in root `CLAUDE.md` doesn't fully cover this: it forces the parent to commit *all* in-flight work, even work in zones the worker doesn't touch. That's overly rigid when the parent's mid-flight zone is non-overlapping with the worker's task scope. The right backstop is at commit time, on path-scoped zones.

## Guidance

Two layers, both required:

### 1. Path-scoped staging (cultural primary)

When committing in any agent role, stage by your task's declared scope. **Do not use `git add -A` or `git add .`.** Concrete shapes per role:

```bash
# backend
git add backend/<paths>
git mv  agents/docs/tasks/pending/backend-<slug>.md agents/docs/tasks/review/backend-<slug>.md

# ui
git add frontend/<paths>
git mv  agents/docs/tasks/pending/ui-<slug>.md agents/docs/tasks/review/ui-<slug>.md

# pinner
git add pinner/<paths>
git mv  agents/docs/tasks/pending/pinner-<slug>.md agents/docs/tasks/review/pinner-<slug>.md

# architect
git add agents/docs/<paths>
git add CLAUDE.md   # root
git add agents/<role>/CLAUDE.md
git add docker-compose.yml
git add .githooks/<paths>
```

Anything outside your task's declared scope stays unstaged for the parent or sibling agents to pick up. `git mv` already stages both endpoints of a rename; no preceding `git add` of the source path is needed.

### 2. Commit-time zone audit (mechanical backstop)

`.githooks/commit-msg` parses the agent prefix from the commit subject and rejects commits whose staged paths fall outside the matching zone. The hook is the runtime-authoritative zone map; this doc and the architect's "Files You Own" list are derived. Activate per clone via:

```bash
git config core.hooksPath .githooks
```

Recognized subject prefixes (bare and parenthetical-scope variants):

```
architect:                 architect(<scope>):
backend:                   backend(<scope>):
ui:                        ui(<scope>):
pinner:                    pinner(<scope>):
```

The hook recognizes only the bare `<role>:` and `<role>(<scope>):` forms. Conventional-commit wrappers like `fix(backend):` and `feat(architect):` are NOT recognized — they fall through to the unrecognized-prefix path and skip the audit. Per root `CLAUDE.md` "Commits and Pushes", agent commits MUST use the bare form.

Behavior:

- Unrecognized prefixes (`chore: ...`, `fix: ...`, `Merge ...`, `revert: ...`) skip the audit and accept the commit. The audit is opt-in by prefix.
- Add `[skip-zone-audit]` to the subject for genuine cross-agent commits (use sparingly; the rejection message itself names this escape hatch).
- Task-file paths under `agents/docs/tasks/` are evaluated by SLUG prefix for non-architect agents (a `backend:` commit touching `tasks/review/ui-Y.md` is rejected). The architect bypasses the slug rule and may touch any-slug task files (per rule #8).
- Task-file *moves* in the `review/ → pending/` direction are architect-only. Even when the slug matches, a `backend:` commit performing this rename is rejected — that direction is the architect's HELD PENDING FIXES handoff.
- Merge-conflict (`U`) paths are included in the audit scope.

### Bypass primitives

Three documented bypasses, in increasing severity:

1. **Unrecognized prefix.** Any commit subject not starting with `architect:`/`backend:`/`ui:`/`pinner:` (with optional `(<scope>)`) skips the audit. This is by design — `chore:` and human-style commits don't carry agent attribution. A misuse pattern is an agent learning to use `chore:` to bypass the audit.
2. **`[skip-zone-audit]` in subject.** Explicit per-commit exemption. Logged to stderr. Use for one-off intentional cross-agent commits.
3. **`git commit --no-verify`.** Bypasses ALL git hooks, not just this one (per `githooks(5)`). Per root `CLAUDE.md` "Commits and Pushes", agents MUST NOT use `--no-verify` without explicit per-invocation user authorization. Prefer `[skip-zone-audit]` for legitimate cross-zone commits, since `--no-verify` also skips any future hook (e.g., a pre-push gate) the project may add.

## Why This Matters

- **Worker commits silently absorb parent's mid-flight work.** `git add -A` in a worker subagent sweeps the entire working tree, including parent agents' uncommitted edits in non-overlapping zones. The resulting commit attributes architect-driven task transitions to a backend worker, breaking per-agent git-blame attribution and making bisect harder.
- **The "commit before fan-out" rule alone is too rigid.** Forcing the parent to commit all in-flight work before every fan-out either churns the history (one tiny architect commit per fan-out) or blocks fan-outs while the parent finishes unrelated zone work. Zone-scoped staging lets parent and worker zones coexist in the working tree without interference.
- **Cost is asymmetric.** The hook is ~150 lines of bash and fires only on rule violation; expected steady state is silent. The cost of *not* having it is per-fan-out architect cycles spent untangling commit-scope drift at code-review time.
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
git mv  agents/docs/tasks/pending/backend-foo.md agents/docs/tasks/review/backend-foo.md
git commit -m "backend: ship backend-foo task"
# Hook: prefix=backend, all paths under backend/ or backend-slug pending→review move → ACCEPT
```

### Worker accidentally bulk-stages an architect-driven review→pending move (rejected)

```bash
# Architect has mid-flight `git mv tasks/review/backend-bar.md tasks/pending/backend-bar.md`
# (HELD PENDING FIXES block append) sitting unstaged in the working tree.
# Worker runs:
git add -A
git commit -m "backend: ship backend-foo task"
# Hook output:
#   commit-msg: zone audit FAILED
#     agent prefix parsed: backend
#     staged review/ → pending/ task-file rename detected.
#     Per root CLAUDE.md rule #8, that direction is architect-driven (HELD
#     PENDING FIXES). Non-architect agents may only mv pending/ → review/.
#       - R100	agents/docs/tasks/review/backend-bar.md	agents/docs/tasks/pending/backend-bar.md
# Recovery: `git restore --staged` the architect's move and recommit; the
# architect lands the move in a separate architect: commit.
```

This catches the original `3c2a2a1`-shape failure: even when the architect's move is on a same-slug task file (`backend-bar.md` for a `backend:` commit), the review→pending direction is architect-only.

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

### Architect appending a hold block to a backend task (accepted)

```bash
# Architect just reviewed tasks/review/backend-foo.md, found issues, appended
# a HELD PENDING FIXES block, and is moving it back to pending/.
git add agents/docs/tasks/review/backend-foo.md   # the hold-block append
git mv  agents/docs/tasks/review/backend-foo.md agents/docs/tasks/pending/backend-foo.md
git commit -m "architect: hold backend-foo round-2"
# Hook: prefix=architect, task-file paths under agents/docs/tasks/ → architect bypass → ACCEPT
```

### Intentional cross-agent commit (exemption)

```bash
git add backend/src/foo.ts frontend/src/bar.js
git commit -m "backend: shared util migration [skip-zone-audit]"
# Hook output:
#   commit-msg: zone audit SKIPPED ([skip-zone-audit] in subject)
# Use sparingly; cross-agent commits should be the exception, not the routine.
```

## Residual risks and known limitations

- **Self-bypass.** The architect zone owns `.githooks/`. An `architect:` commit that weakens or disables this hook passes its own audit. Once landed, the modified hook governs subsequent commits. Mitigation: architect commits touching `.githooks/` should receive `/ce-code-review` before archiving (matches the existing review protocol in root `CLAUDE.md` rule #7). For higher assurance, a future iteration could add a CI-side equivalent that runs the audit using a hook copy hosted outside the repo.
- **`git commit --amend` with no new staging.** When an amend doesn't add new files, `git diff --cached` returns empty and the audit skips. An amend that only changes the subject (e.g., renames the prefix from `backend:` to `architect:`) is not re-audited against the original tree. Documented; not enforced — re-auditing amend would conflate first-time commits with amends and add complexity for a low-frequency edge case.
- **Activation is per-clone.** `git config core.hooksPath .githooks` is not a git-tracked setting. Fresh clones (CI runners, new contributor checkouts, brand-new agent worktrees that don't share the parent's `.git/config`) get no protection until the manual setup runs. Worktrees of an existing clone *do* inherit the setting via `commondir`, so fan-out workers spawned in `.claude/worktrees/...` are covered automatically.
- **Hook is only a coordination tool, not a security boundary.** Bypass primitives (above) are documented and trivial. The threat model is "honest but careless agents/contributors", not adversarial.
- **Within-zone concurrent-session contamination.** The hook validates that staged paths fall within the committing role's zone, but cannot distinguish "I intended to stage this" from "another concurrent session in the same role staged this." Two architect sessions sharing a checkout can broadly-add each other's staged paths and the hook will rubber-stamp the contaminated commit because all paths are in-zone. See `agents/docs/solutions/conventions/concurrent-agent-staging-sweep-2026-05-12.md` for the canonical incident, the `git diff --cached --name-only` pre-commit verification ritual, and the companion destructive-rewind hazard.

## Maintenance

When extending the zone map (new path, new role):

1. Update `.githooks/commit-msg`'s `allowed_for_agent()` function — this is the runtime SSOT.
2. Update the narrative zone summary at the top of this doc (just prose, not a parallel allowlist).
3. Update `agents/architect/CLAUDE.md` "Files You Own" if the change adds an architect-zone path.
4. Run `bash .githooks/tests/test-commit-msg.sh` after editing the hook.
5. If adding a new role, also update root `CLAUDE.md` rule #2 narrative.

## Related conventions

- Root `CLAUDE.md` "Commits and Pushes" — top-level commit discipline, including the `Co-Authored-By:` trailer requirement, the "commit before fan-out" rule, and the bare-prefix style mandate. The path-scoped staging guidance and hook reference live there.
- Root `CLAUDE.md` rule #2 — agent ownership boundaries; the narrative source-of-truth for the zone map. The hook's allowlist is the runtime derivation of this rule.
- `agents/docs/solutions/conventions/worktree-fanout-orphan-detection-2026-04-29.md` — adjacent fan-out failure mode (worker commits never merged back to the orchestrating branch). Both target dirty-tree-fan-out failure families; the orphan-detection convention catches work-loss, this one catches commit-scope drift.
- `agents/docs/solutions/conventions/cross-task-hold-block-staleness-2026-04-22.md` — related: hold-block staleness across parallel rounds, an adjacent failure shape in the same fan-out workflow space.

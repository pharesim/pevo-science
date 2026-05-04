---
title: "Implementers self-verify any commit SHA they cite in a re-review signal block — orphan worktree SHAs and mis-identified prerequisite SHAs both fail the architect's intake check"
date: 2026-05-04
category: conventions
module: agent-coordination
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - About to write or update a "re-review signal" block at the bottom of a task file in `agents/docs/tasks/review/` (or any equivalent implementer attestation that names a commit)
  - The work was done in a worktree fan-out (worker subagent on a `worktree-agent-*` branch) before being merged or cherry-picked back to the orchestrating branch
  - The task involved multiple prerequisite or sibling commits (helper extraction + migration, schema change + backfill, etc.) and the implementer needs to identify which specific SHA carries the work the signal block describes
  - Submitting the task back to `tasks/review/` for the architect's next review pass
  - Before the implementer ends the work session that produced the cited SHA
tags:
  - agent-coordination
  - git-workflow
  - worktree
  - signal-block
  - commit-sha
  - implementer-discipline
  - orphan-detection
related_components:
  - tooling
  - documentation
---

## Context

The architect's intake check (per `worktree-fanout-orphan-detection-2026-04-29.md`) runs `git merge-base --is-ancestor <claimed-sha> main` against any commit SHA cited in a task signal block. The check fails in two distinct cases:

1. **Worktree-orphan case.** The implementer was a worker subagent dispatched in `isolation: "worktree"`. They committed to their `worktree-agent-<id>` branch, which produced SHA `X`. The parent agent then cherry-picked or replayed `X` onto the orchestrating branch (typically `main`), producing a NEW SHA `Y` with identical diff content. The implementer's natural reflex is to cite `X` (the SHA they last saw in their worker context) — but `git merge-base --is-ancestor X main` returns false because `X` lives only on the orphan branch. The on-main commit is `Y`.

2. **Mis-identified-prerequisite case.** A multi-commit task involves prerequisite SHAs (helper extraction, library upgrade, schema change) and a primary SHA that lands the actual feature work. The implementer cites the prerequisite SHA, intending to credit it as "where the helper landed" — but the signal block sits at the bottom of the task whose work is the FEATURE, not the prerequisite. An architect reading the signal block runs the intake check against the cited SHA and sees the helper diff, not the feature diff. The check passes (the SHA IS on main) but reviewing it produces nothing relevant.

Both failure modes are mechanically detectable by the implementer at the moment they're writing the signal block — the implementer has the command on hand and knows what work they're crediting. The architect's intake check is the EXPENSIVE-RECOVERY backstop; implementer self-verification is the CHEAP-PREVENTION layer.

## Guidance

Before pasting any commit SHA into a re-review signal block, run two checks:

```bash
# Check 1: SHA is reachable from main
git merge-base --is-ancestor <sha> main && echo "ON MAIN" || echo "ORPHANED"

# Check 2: SHA actually contains the work this signal block describes
git show --stat <sha> | head -20   # confirm the file list matches expectation
git log -1 --format='%s%n%b' <sha> # confirm the message describes THIS task's work
```

### When check 1 fails (worktree-orphan)

The cited SHA lives on a worker's `worktree-agent-*` branch and was never merged. Locate the on-main replay:

```bash
# Find what branch the orphan SHA lives on
git branch --contains <orphan-sha>
# e.g.:  worktree-agent-a06fcd6a935d47929

# Find the on-main replay by matching subject line or author + timestamp
git log --oneline --all --since="<work-date>" --until="<today>" --grep="<key phrase from commit subject>" main
# OR by exact patch-id match (more reliable for cherry-picks)
git log main --oneline | head -50    # scan for the on-main replay
git diff <orphan-sha> <candidate-on-main-sha>   # confirm zero-diff = same patch
```

Cite the on-main SHA in the signal block. Optionally include a parenthetical for traceability:

```
Round-3 hold-fix items 1-13 landed in commit `e521a96` (replay of orphan worktree SHA `bd1330b`).
```

### When check 2 fails (mis-identified prerequisite)

The cited SHA does NOT contain this task's work — it carries a prerequisite or sibling change. Find the SHA whose diff matches THIS task:

```bash
# Filter recent commits by file paths the task touched
git log main --oneline -- backend/src/routes/<this-task's-file>.ts | head -20

# Or grep commit messages for this task's slug or feature term
git log main --oneline --grep="<task-slug>" | head -10
```

Cite the actual feature commit; if the prerequisite commit is also relevant context, mention it parenthetically ("relies on helper extracted in `<prereq-sha>`").

## Why This Matters

- **The architect's intake check exists for a reason and produces noise when SHA cites are wrong.** The convention `worktree-fanout-orphan-detection-2026-04-29.md` documents the failure-recovery shape: detect orphans + replay or re-implement. Recovery costs are nontrivial — orphan-period API drift can produce type errors at the cherry-pick site, and downstream "doc-only fix" commits authored against the false-landed premise produce fresh drift. Self-verifying the cited SHA prevents the architect from running the recovery dance for SHA-citation errors that the implementer could have caught.

- **Recurring class with cross-cluster signal.** This convention is filed because the failure mode has now appeared in three places: cluster A's argon2-error-handler-extract round-3 (orphan SHAs `718b7ed`+`cfd5a73`+`002fec1`, replayed via `5cb0fbc`), cluster B's verify-broadcast-attempts-cap round-2 (orphan `bd1330b`, replayed via `3c2a2a1`), and cluster B's continuation-post-author-consent-gate round-1 (orphan `da5d371`, replayed via `063ead7`). Plus the cluster B mis-identified-prerequisite case (cited `0c95115` helper-extraction SHA when the task's actual migration was `27cc588`). Three cluster-A architect-recovery + two cluster-B architect-flag-and-correct cycles is enough evidence that prevention has positive ROI.

- **Implementer cost is trivial.** Both checks are ~5-second shell invocations. Compared to the architect's recovery cost (cherry-pick + drift-reconciliation + a follow-up commit chain), the implementer-side check is the cheaper enforcement point.

- **The signal block is implementer-attestation material.** Just as commit-message accuracy is the implementer's responsibility (`git log` is the durable record), signal-block SHA accuracy is the implementer's responsibility. Architects can detect-and-correct, but the implementer is the lower-cost enforcement layer because they have the work fresh.

## When to Apply

- Every time you write or update a re-review signal block at the bottom of a task file (the "Backend re-review signal" / "UI re-review signal" / etc. attestation block per `agents/<role>/CLAUDE.md`).
- Every time you write a `Co-Authored-By:` style attestation that includes a commit SHA in its body.
- Every time you reference a previous commit SHA in a task file's "Implementation note" or "Files changed" section.
- Especially after a worktree fan-out: if your work was done in `isolation: "worktree"` mode, the orphan-cite risk is HIGH; verify before pasting.
- Especially in multi-commit tasks: if there are prerequisite SHAs, mis-identification risk is HIGH; verify the cited SHA carries the feature-of-interest, not just an adjacent helper.

## Examples

### Worktree-orphan case (cluster B, ε `backend-continuation-post-author-consent-gate`)

```bash
# Implementer just finished round-1 work in a worker worktree.
# Worker's last commit on the worktree-agent-* branch:
git log -1 --oneline    # da5d371 backend(continuation-gate): pin paper continuation-chain admit on named-author membership

# Parent agent merged the worktree back to main; on-main replay:
git log main --oneline -5
# 063ead7 backend(continuation-gate): pin paper continuation-chain admit on named-author membership   <- on-main replay
# da5d371 backend(continuation-gate): pin paper continuation-chain admit on named-author membership   <- ORPHAN

# Naive signal-block cite (WRONG):
# "Implementation landed in `da5d371`."
git merge-base --is-ancestor da5d371 main && echo "ON MAIN" || echo "ORPHANED"
# ORPHANED

# Self-verify caught it. Look up the on-main SHA:
git diff da5d371 063ead7 | wc -l  # 0  (zero-diff = patch-id match = same logical commit)

# Corrected signal-block cite:
# "Implementation landed in `063ead7` (replay of orphan worktree SHA `da5d371`)."
git merge-base --is-ancestor 063ead7 main && echo "ON MAIN" || echo "ORPHANED"
# ON MAIN
# → Signal block verified.
```

### Mis-identified-prerequisite case (cluster B, α `backend-bridge-custody-broadcast-discrimination`)

```bash
# Task: migrate 3 broadcast-error catch sites in bridge.ts and custody.ts.
# Two commits in the chain:
git log main --oneline -2 -- backend/src/routes/bridge.ts backend/src/routes/custody.ts
# 27cc588 backend: BE-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION — migrate 3 sites to handleBroadcastError + normalize pino err-key
# 0c95115 backend: BE-HANDLE-BROADCAST-ERROR-HELPER — extract handleBroadcastError + migrate 7 sites

# Naive signal-block cite (WRONG):
# "the 3 call sites were migrated via handleBroadcastError (landed in `0c95115`)"
git show --stat 0c95115 -- backend/src/routes/bridge.ts backend/src/routes/custody.ts
# (empty — bridge.ts and custody.ts NOT in this commit's file list)
git show --name-only 0c95115 | head -10
# orcid.ts, accreditation.ts, claims.ts, papers.ts — the 7 OTHER sites; NOT bridge/custody

# Self-verify caught it. The actual feature commit:
git show --stat 27cc588 -- backend/src/routes/bridge.ts backend/src/routes/custody.ts
# bridge.ts | 33 +++++--
# custody.ts | 37 +++++--

# Corrected signal-block cite:
# "the 3 call sites were migrated via `handleBroadcastError` (landed in `27cc588`; helper extracted earlier in `0c95115`)"
```

### Combined: worktree-orphan AND multi-commit task (cluster A, argon2-error-handler-extract)

The cluster A round-3 work landed via three orphan SHAs (`718b7ed` + `cfd5a73` + `002fec1`), each on a separate worktree-agent-* branch. The parent agent's replay (`5cb0fbc`) consolidated them onto main, with API-drift reconciliation as a follow-up commit. A signal block citing any of the orphan SHAs would have failed the architect's intake check; the correct cite is `5cb0fbc` with parenthetical attribution to the underlying orphans. Self-verification at signal-block-write time would have caught this.

## Related conventions

- `agents/docs/solutions/conventions/worktree-fanout-orphan-detection-2026-04-29.md` — companion convention covering the architect's INTAKE recovery shape. The architect's check fires when the implementer's self-verify was missed; this convention is the prevention layer, that one is the recovery layer.
- Root `CLAUDE.md` "Worktree Cleanup" — covers stale-pid lock files preventing `git worktree remove` after a fan-out completes; orthogonal to the SHA-attestation axis this convention covers.
- Root `CLAUDE.md` "Commits and Pushes" — establishes that every commit message ends with a `Co-Authored-By:` trailer (which embeds attestation); this convention extends the same accuracy discipline to signal-block SHA cites.

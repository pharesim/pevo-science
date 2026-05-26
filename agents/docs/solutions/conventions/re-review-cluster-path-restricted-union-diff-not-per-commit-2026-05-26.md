---
title: Re-review a coupled task cluster with a path-restricted union diff, not per-commit, when a later commit relocated earlier code
date: 2026-05-26
category: conventions
module: agent-coordination
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - Architect re-reviewing two or more coupled tasks in `tasks/review/` that touch the same file set
  - A later commit in the cluster relocated or refactored code introduced by an earlier commit (classic case, a shared-module extraction that landed after the holds it depends on cleared)
  - The cluster's commits are non-contiguous on main, interleaved with sibling agents' commits
  - Tempted to dispatch one `/ce-code-review` per `review/` task scoped to that task's single commit SHA
---

## Context

The architect protocol says invoke `/ce-code-review` on every `tasks/review/` file before archiving, "scoped to the implementer's commit SHA(s)." For an isolated task that is exactly right: one task, one (or a few) commits, review them and archive or hold.

But coupled task clusters break the per-commit instinct. PEvO's multi-agent, multi-round held-task workflow routinely produces a cluster of two-plus tasks that all touch the same file pair, land across several commits, and explicitly order themselves — a refactor/extraction task that says "land me AFTER the holds I depend on clear" is the recurring shape. By the time the cluster reaches re-review, a LATER commit has often relocated code that an EARLIER commit introduced (e.g. helpers extracted out of a route module into a shared `lib/` module, a query fragment hoisted into a shared constant).

Dispatching one `/ce-code-review` per task, each scoped to that task's own single commit, is wrong in this situation for two compounding reasons:

1. **Working-tree-vs-diff mismatch → false "moved/missing code" findings.** Persona reviewers read the *current* files (HEAD) for context, but a single earlier commit's diff shows code in its pre-relocation location. The reviewer sees `unpinFromKubo` added to `routes/ipfs.ts` in the diff, opens the current `routes/ipfs.ts`, and finds it gone (moved to `lib/ipfs-shared.ts` by a later commit) — and flags a fictional defect. The diff and the working tree disagree, and the reviewer trusts the working tree.
2. **Scope bleed + wasted fan-outs.** The cluster's commits are usually NON-contiguous on main — interleaved with sibling agents' commits. A naive `base:<sha>` working-tree diff bleeds in all the unrelated sibling work between that SHA and HEAD. And N per-commit fan-outs re-read the same overlapping surface N times, multiplying the cost of an already-expensive multi-persona pass.

This sits one step *after* the supersession check (see [[re-review-intake-supersession-check-2026-05-05]]): the files still exist at HEAD and all SHAs are reachable on main, so supersession passes — but per-commit *granularity* is still wrong because a sibling commit in the same cluster relocated the surface.

## Guidance

Re-review a coupled cluster as a single unit: run ONE `/ce-code-review` over a **path-restricted union diff** of the not-yet-reviewed commits, scoped against the last-already-reviewed commit as the base and restricted to the cluster's file set. Then map the findings back to each task for separate archive/hold decisions.

```bash
# 1. Identify the cluster's file set and the base = the commit BEFORE the
#    earliest not-yet-reviewed commit (i.e. the tip of already-reviewed work).

# 2. Verify the scope shows EXACTLY the intended commits and nothing else:
git log --oneline <base>..HEAD -- <cluster file paths>     # must list only the cluster's new commits

# 3. Confirm previously-reviewed originals are excluded (ancestors of base):
git merge-base --is-ancestor <already-reviewed-orig-sha> <base> && echo "excluded OK"

# 4. Produce the review diff — path-restricted so interleaved sibling commits
#    (which don't touch these files) drop out, and the diff matches HEAD:
git diff -U10 <base> HEAD -- <cluster file paths>
```

Feed that union diff to the persona fleet, and tell them the working tree at HEAD MATCHES the diff so they read current files freely. Because the intervening sibling commits don't touch the cluster's files, the path restriction isolates exactly the cluster's net new work AND the reviewers never see relocated-away code.

Practical traps when computing the base:

- **HEAD is frequently NOT the cluster's tip commit** — a sibling agent's commit (or your own archive commit) sits on top. Don't assume `HEAD` is the last code change.
- **A file-filtered `git log -- <files>` hides intervening commits**, so the cluster's commits can *look* contiguous when they are not. Use the filtered log only to enumerate the cluster's commits, not to infer adjacency or pick a base.
- **The base must be the parent of the earliest not-yet-reviewed commit**, which is usually NOT a cluster commit at all — it's whatever sibling/architect commit preceded the cluster's first new commit.

## Why This Matters

A per-commit fan-out in this situation wastes a full expensive multi-persona pass AND seeds the triage list with false positives that cost human attention to dismiss. The union-diff approach reviews every new line of every task in the cluster exactly once, in a context that matches reality, and still lets you map findings to individual tasks (archive the clean ones, hold the ones with real findings). It is the correct reading of the architect workflow's "files that touch the same code path must be reviewed with care so findings from an earlier review inform the later one" — when a relocating commit is in the mix, "with care" means "as one diff," not "one diff per task."

This does NOT relax the "invoke `/ce-code-review` per Review task before archiving" rule (auto memory [claude]): every task's new lines are still reviewed; the union pass covers all of them. You map the single pass's findings back to each task and make a per-task archive/hold decision, so each `review/` task still gets its review before it archives.

## When to Apply

- Two or more `review/` tasks touch the same file set and at least one later commit relocated/refactored code an earlier commit introduced.
- You have already cleared the orphan-SHA check ([[worktree-fanout-orphan-detection-2026-04-29]]) and the supersession check ([[re-review-intake-supersession-check-2026-05-05]]) — this is the next granularity question, not a replacement for those gates.

Do NOT apply (use ordinary per-task scoping) when:

- The tasks touch disjoint code paths — review them independently in any order.
- No later commit relocated earlier code — per-commit scoping reads true against HEAD.

## Examples

Motivating case: the IPFS review cluster (pin-durability, image-SRF-guard, shared-module-extraction). Three tasks on `backend/src/routes/ipfs.ts` + `backend/src/ipfs-cleanup.ts`. The extraction commit (latest) moved `unpinFromKubo` / `unpinFromPinata` out of `routes/ipfs.ts` into a new `backend/src/lib/ipfs-shared.ts` and hoisted the image-guard fragment into an `IMAGE_SRF_GUARD_EXPR` constant — exactly the code the earlier pin-durability and srf-guard re-reviews would have examined. HEAD was an architect commit, not the extraction commit; the three IPFS commits were non-contiguous (interleaved with bridge-cluster and other architect commits); and a file-filtered `git log` made them look adjacent.

Wrong: three `/ce-code-review` passes, each scoped to one task's commit. The pin-durability pass would read the current `routes/ipfs.ts`, not find `unpinFromKubo` there, and flag false moved-code findings; three passes re-read the same ~700-line surface.

Right: one pass over `git diff -U10 <last-reviewed-base> HEAD -- <the six IPFS files>`, after confirming via `git log --oneline <base>..HEAD -- <files>` that the range held exactly the three new commits and `git merge-base --is-ancestor <already-reviewed-orig> <base>` that the previously-reviewed originals were ancestors of the base (excluded). Findings then mapped per task: one archived clean, two held for minor items, one P1 filed as a new task.

## Related

- [[re-review-intake-supersession-check-2026-05-05]] — the upstream sibling gate: what to do when a later commit *decommissioned or modified* (rather than relocated) the earlier commit's scope. This entry is the relocation variant of the same intake checkpoint.
- [[worktree-fanout-orphan-detection-2026-04-29]] — the `git merge-base --is-ancestor` reachability gate that must pass before trusting any SHA at intake; reused here to verify the base.
- [[hold-fix-two-commit-edit-mv-variant-2026-05-17]] — closest existing evidence that per-commit dispatch produces false positives in a multi-commit arc (project-standards false PS-001 when the `mv` is in a sibling commit).
- [[cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14]] — the hold-block-WRITING discipline (enumerate all sibling sites in widening rings); this entry is the review-DISPATCH complement.
- [[defer-architect-doc-rewrite-when-cluster-sibling-touches-same-doc-2026-05-19]] — the cluster as a first-class unit from the doc-authorship angle; this entry treats it as a review-scope unit.
- [[multi-round-task-at-archive-followup-blindness-2026-05-20]] — adjacent "read the full arc" discipline at archive intake.

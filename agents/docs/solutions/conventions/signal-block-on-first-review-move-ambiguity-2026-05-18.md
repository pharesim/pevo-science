---
title: "Re-review signal block on first pending→review move is ambiguously required — agents/backend/CLAUDE.md exempts it, implementer-self-verify-signal-block-sha convention requires it; reconcile or pick a default per cluster"
date: 2026-05-18
category: conventions
module: agent-coordination
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - About to move a task file from `agents/docs/tasks/pending/` to `agents/docs/tasks/review/` for the FIRST time (no prior architect hold-block exists on the task)
  - Architect re-reviewing a `review/` task and noticing the file has zero content changes (rename-only) — deciding whether to flag the missing signal block as a hold item or accept it
  - Persona reviewers under `/ce-code-review` disagreeing on whether a missing signal block is a process violation (typically `project-standards` exempts, `learnings` flags)
  - Editing either `agents/backend/CLAUDE.md` "Re-review signal" wording or `agents/docs/solutions/conventions/implementer-self-verify-signal-block-sha-2026-05-04.md` text — reconcile them in the same pass rather than touching one in isolation
tags:
  - agent-coordination
  - signal-block
  - convention-ambiguity
  - cross-reviewer-disagreement
  - task-lifecycle
  - architect-triage
related_components:
  - documentation
  - tooling
---

## Context

PEvO's task lifecycle has two distinct `pending/` → `review/` moves: (1) the FIRST submission, where the implementer has just landed all work against the original task body, and (2) subsequent moves following an architect hold-block, where the implementer has landed the held items and is submitting fixes for re-review.

Two doc surfaces describe the implementer's responsibilities at this transition, and they disagree on whether the FIRST submission also requires a signal block.

**`agents/backend/CLAUDE.md` "Re-review signal" section** (architect-owned per `.githooks/commit-msg:138`; current text, as of 2026-05-18):

> When the implementer has landed the fixes, they `git mv` the file back to `tasks/review/`. Every file in `tasks/review/` with your role prefix is therefore actionable — either a first review or a re-review after a prior hold.

This wording treats both kinds of moves as actionable for the architect's next review pass but does not require an attestation block on the first move — the move itself is the signal.

**Root CLAUDE.md rule #7:**

> When a task is complete, the implementing agent `git mv`s the file from `pending/` to `review/`.

Just the `git mv`. No signal block required.

**Backend CLAUDE.md "Re-review signal":**

> Append an implementer signal block when landing fixes for a held task.

Scoped to "landing fixes for a held task" — i.e., the second or later move, not the first.

**`agents/docs/solutions/conventions/implementer-self-verify-signal-block-sha-2026-05-04.md`:**

> Before moving to review/, the implementer should append a signal block citing the on-main SHA and run `git merge-base --is-ancestor <sha> main` to confirm it.

No first-vs-subsequent distinction. The convention text prescribes the signal block at every `pending/` → `review/` move.

Both readings are textually defensible from their respective source documents. The conflict only surfaces when a multi-persona `/ce-code-review` puts both readings side by side — `ce-project-standards-reviewer` reads `agents/backend/CLAUDE.md` and exempts first-move submissions; `ce-learnings-researcher` reads the convention and flags any signal-block omission. Concrete incident: cluster D review of `backend-tests-typecheck-residual-drift` commit `9a6edf1` on 2026-05-18. The task file in `review/` had zero content changes — rename-only mv from `pending/`. Project-standards: not a violation. Learnings: violation per convention. Architect dismissed the specific finding (the diff was self-evidencing — 249 → 0 typecheck errors), but the docs were not reconciled.

## Guidance

Until the source docs are reconciled, the architect triager has two defensible options:

1. **Default to "always required" for forward-safety.** Treat a missing signal block as a hold item on every `pending/` → `review/` move, including first submissions. Rationale: the signal block costs the implementer one short paragraph and gives the architect a SHA self-verification anchor. The cost is small; the orphan-worktree-SHA failure mode the parent convention warns about (`implementer-self-verify-signal-block-sha-2026-05-04.md`) doesn't care whether the move is first or Nth. Erring strict is forward-safe.

2. **Pick one reading per cluster and note it in the triage block.** When dismissing the omission, record the dismissal explicitly with the reading invoked — e.g., "first-review move exempt per `agents/backend/CLAUDE.md` 'Re-review signal' section; signal-block convention is read strict for re-review submissions only." This documents the architect's choice on this cluster so the next reviewer doesn't re-litigate the same question.

Do not silently accept a missing signal block without invoking one of these two paths. Silent acceptance trains future implementers (and future reviewer personas) that the convention is optional, which weakens both source docs further.

## Why This Matters

Cross-reviewer disagreement on whether a finding is a violation produces wall-time tax and triage churn — the architect has to read both source docs, decide which reading wins for this cluster, and write a dismissal that the next architect can audit. Reconciling the source docs once eliminates the churn for every subsequent cluster.

The deeper failure mode is that the signal block exists to break a specific class of bug: an implementer cites a commit SHA that turns out to be an orphan worktree SHA (worker committed but parent never merged the branch back), or a prerequisite-helper SHA rather than the feature SHA. Both failure modes are documented in `implementer-self-verify-signal-block-sha-2026-05-04.md` with concrete incident anchors. Whether or not the FIRST submission needs a signal block depends on whether the architect believes the first move is also susceptible to the orphan-SHA failure — and it is, since worktree fan-outs occur on initial implementations too, not just on hold-fixes.

## When to Apply

- Architect re-review intake: every time you `ls tasks/review/` and find a file with zero content changes (rename-only mv), check the source docs against the persona-reviewer findings before dismissing or holding.
- Reviewer disagreement: when `ce-project-standards-reviewer` and `ce-learnings-researcher` (or any equivalent cross-persona pair) split on a missing-signal-block finding, the disagreement IS the signal that the source docs need reconciliation.
- Doc editing: any time you touch the "Re-review signal" wording in `agents/backend/CLAUDE.md` (or its sibling protocol files in `agents/ui/CLAUDE.md`, `agents/pinner/CLAUDE.md`) or the parent convention, edit both surfaces in the same architect commit. Touching one in isolation perpetuates the ambiguity.

## Examples

**Cluster D, 2026-05-18, residual-drift task (`9a6edf1`):**

- Diff: 249 → 0 typecheck errors across 27 test files + tsconfig + package.json + agents/backend/CLAUDE.md
- Task file in `review/`: rename-only mv from `pending/`; no signal block
- Persona reviewers split: project-standards exempted ("first-review move per `agents/backend/CLAUDE.md`"); learnings flagged ("convention prescribes signal block at every move")
- Architect dismissed: diff was self-evidencing; SHA self-verification not load-bearing because nothing in the diff narrative could be misrepresented (the typecheck-error count is mechanical and verifiable from `npx tsc --noEmit -p backend/tests/tsconfig.json` exit code)
- Recurrence vector: documented here so the next cluster doesn't relitigate

**Hypothetical recurrence with a worktree fan-out on a first submission:**

- Diff: parent agent spawns 3 worktree workers, each implementing one segment of a multi-part task
- Workers commit to `worktree-agent-*` branches; parent merges (or cherry-picks) two segments but misses the third
- Task file moves `pending/` → `review/` with no signal block citing the THREE expected SHAs
- Architect intake: notices the missing signal block, runs `git merge-base --is-ancestor <expected-sha> main` per the parent convention, discovers one SHA is orphan
- If the architect had defaulted to "first-review move exempt" without the SHA self-check, the orphan segment would have been invisible until late re-review or a downstream cluster

The orphan failure mode applies regardless of whether the move is first or Nth. That's the core argument for defaulting strict (path 1 above) until the docs reconcile.

## Next-step action (architect backlog)

Edit one or both source docs to reconcile:

- **Option A:** Tighten the convention's wording to acknowledge the first-vs-Nth distinction and explicitly require the signal block at every move (matching the convention's intent — orphan SHAs are equally possible on first moves).
- **Option B:** Loosen the convention's wording to scope it to "moves following an architect hold-block" (matching the backend CLAUDE.md text). Add a separate note for first-move SHA verification at the architect's intake side, where it belongs in any case.

Either way, edit both surfaces (`agents/backend/CLAUDE.md` "Re-review signal" section + `implementer-self-verify-signal-block-sha-2026-05-04.md`) in the same architect commit. Touching one in isolation perpetuates the ambiguity.

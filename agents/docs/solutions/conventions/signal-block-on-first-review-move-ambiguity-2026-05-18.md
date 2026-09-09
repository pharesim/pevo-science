---
title: "Signal block at the first pending→review move is unstandardized — the role protocol files require one, agents/docs/tasks/README.md says none is required; reconcile or pick a default per cluster"
date: 2026-05-18
last_updated: 2026-09-09
category: conventions
module: agent-coordination
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - About to move a task file from `agents/docs/tasks/pending/` to `agents/docs/tasks/review/` for the FIRST time (no prior architect hold-block exists on the task)
  - Architect re-reviewing a `review/` task and noticing the file has zero content changes (rename-only) — deciding whether to flag the missing signal block as a hold item or accept it
  - Persona reviewers under `/ce-code-review` disagreeing on whether a missing signal block is a process violation (typically `project-standards` exempts, `learnings` flags)
  - Editing the "Re-review signal" wording in `agents/backend/CLAUDE.md` or `agents/ui/CLAUDE.md`, or the hold-block paragraph in `agents/docs/tasks/README.md` — reconcile them in the same pass rather than touching one in isolation
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

Nothing in the coordination docs prescribes what the implementer writes on the FIRST move, and two surfaces that speak to the transition contradict each other on whether an attestation block belongs there at all.

**The role protocol files require a block, scoped to hold-fixes.** `agents/backend/CLAUDE.md` and `agents/ui/CLAUDE.md`, "Re-review signal" bullet, both say to append a `<Role> re-review signal (<date>, working tree or commit SHA):` block "after landing fixes for a held task", under the architect's hold block. Both are silent on the first move. Their Task-completion bullets ask only for the `git mv`.

**`agents/docs/tasks/README.md` says no block is required at all.** Its hold-block paragraph, directly beneath the task-file-shape fenced block, ends:

> The commit diff and commit message are the evidence — no separate signal block is required.

**Root `CLAUDE.md` rule #8 sides with the README:** "the move itself is the re-review signal".

So the requirement the role files state for hold-fixes is denied outright by the README and by root rule #8, and neither surface says anything about the first move. Practice has settled the hold-fix half on its own and left the first half unstandardized. Re-review blocks are uniform, because the role files name the exact heading; first-move blocks are not, because nothing does.

Both readings are textually defensible from their respective source documents. The conflict surfaces when a multi-persona `/ce-code-review` puts them side by side — one persona reads a role protocol file and exempts first-move submissions, another reads the convention store and flags any signal-block omission. Concrete incident: cluster D review of `backend-tests-typecheck-residual-drift` commit `9a6edf1` on 2026-05-18. The task file in `review/` had zero content changes — rename-only mv from `pending/`. Project-standards: not a violation. Learnings: violation per convention. Architect dismissed the specific finding (the diff was self-evidencing — 249 → 0 typecheck errors), but the docs were not reconciled.

**Correction (2026-09-09).** As first written, this entry named the wrong pair. It quoted `agents/docs/solutions/conventions/implementer-self-verify-signal-block-sha-2026-05-04.md` as prescribing "Before moving to review/, the implementer should append a signal block…" and built the contradiction on it. That sentence is not in that entry and never was; the string appears nowhere in the repo but here. That entry is conditional throughout — its guidance opens "Before pasting any commit SHA into a re-review signal block" and its When-to-Apply defers to the role protocol files for when a block exists — so it regulates SHA accuracy given a block and never mandates writing one. It does not disagree with the role files. This entry also attributed to `agents/backend/CLAUDE.md` a passage ("Every file in `tasks/review/` with your role prefix is therefore actionable…") that lives in `agents/architect/CLAUDE.md`, in its re-review-cycle paragraph, and has never been in a backend file. The observation that survived the correction is the one above: the first-move shape is unstandardized, and the live contradiction is the role files against the README.

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
- Doc editing: any time you touch the "Re-review signal" wording in `agents/backend/CLAUDE.md` or `agents/ui/CLAUDE.md`, or the hold-block paragraph in `agents/docs/tasks/README.md`, edit every surface in the same architect commit. Touching one in isolation perpetuates the ambiguity.

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

**This deferral is itself the finding.** It was written on 2026-05-18 and sat unexecuted for roughly sixteen weeks: never filed as a task, never archived, never touched by a commit. The 2026-09-09 refresh that corrected this entry is what found it still open. That is the failure mode `agents/docs/solutions/conventions/startup-file-contradiction-outranks-convention-doc-pointer-2026-09-09.md` describes, taking the deferred path. A contradiction recorded in the convention store and left for a backlog is not scheduled work; the startup-read files keep saying what they said, and the implementers who read them keep acting on it. Reconcile in place, or accept that the drift continues.

**Resolved 2026-09-09 (architect and user): the first move is standardized.** The alternative considered and rejected was to loosen instead, scoping the role files' requirement explicitly to hold-fix moves and making the README's sentence authoritative. It was rejected because practice had already chosen the other way, most signal headings in the tasks tree cite SHAs, and loosening would have left the orphan-SHA check unowned on first submissions while requiring in-flight tasks to be reshaped back out.

Applied across three surfaces in one architect commit, per the edit-every-surface rule this entry has always carried:

- The Task-completion bullets in `agents/backend/CLAUDE.md` and `agents/ui/CLAUDE.md` now ask for a `<Role> implementation signal (<date>, working tree or commit SHA):` block naming the commits, with each SHA self-verified per `agents/docs/solutions/conventions/implementer-self-verify-signal-block-sha-2026-05-04.md`. A worktree fan-out orphans SHAs on a first implementation as readily as on a hold-fix, which is the substantive argument and the one this entry got right from the start.
- The hold-block paragraph in `agents/docs/tasks/README.md` no longer denies the block. It describes it as an index into the diff, naming the date and commits so the architect can run the orphan check, rather than as a substitute for reading the diff.
- `agents/ui/CLAUDE.md`'s "Re-review signal" bullet said to append the block "to the task file in `tasks/review/`". Per root rule #8 a held file lives in `tasks/pending/` at that moment, which is what its backend counterpart already said. Corrected to match.

The ambiguity this entry documents is therefore closed at the source. What remains useful here is the shape of the failure: a contradiction between coordination surfaces, recorded accurately and then deferred, survives for as long as nobody re-reads the surfaces themselves.

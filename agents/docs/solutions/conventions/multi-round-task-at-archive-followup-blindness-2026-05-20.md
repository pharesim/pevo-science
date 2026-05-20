---
title: "Multi-round task at-archive followup blindness — architect reads only the latest hold block at archive intake, missing earlier-round 'file at archive' prescriptions"
date: 2026-05-20
category: conventions
module: process/archive-intake
problem_type: convention
component: agent_coordination
severity: high
applies_when:
  - "Archiving a task with two or more Round-N hold blocks"
  - "Reading a tasks/review/ task body at archive intake after a multi-round held arc"
  - "The current hold block carries forward earlier obligations with phrases like 'Pre-existing architect-zone followups from round-N stand'"
  - "An earlier hold block prescribed new task files, follow-up tasks, or other actions to be filed 'at archive'"
  - "A hold block contains an 'Architect followups (land at archive after round-N clean)' or 'Architect-zone items' section"
related_components:
  - load-bearing-greps-at-signal-block-write-time-2026-05-06
  - architect-hold-block-risk-class-separation-2026-05-07
  - re-review-intake-supersession-check-2026-05-05
  - process/archive-protocol
tags:
  - agent-coordination
  - hold-block
  - archive-intake
  - multi-round
  - followup-tasks
  - architect-workflow
  - review-cycle
---

# Multi-round task at-archive followup blindness

## Context

PEvO's review/held-pending-fixes cycle (root `CLAUDE.md` rules 7 and 8) produces a held arc where a task can cycle through multiple rounds before it cleans. Each round's architect re-review block is appended at the bottom of the task file with an **`Architect re-review (<date>) — HELD PENDING FIXES:`** heading. Some of those blocks contain a sub-section titled "Architect followups (land at archive after round-N clean)" or "Architect-zone items" — prescriptions that require no implementer action but DO require the architect to file new follow-up tasks at archive time.

The failure mode: a multi-round task accumulates these prescriptions across rounds. The most recent hold block sits at the bottom of the file and visually dominates intake attention. Earlier hold blocks, and their accumulated "at archive" obligations, are above the fold. A 5-round arc may have round-2 prescriptions still unfiled at round-5, but the round-5 hold block only back-references them with a one-line cue like "Pre-existing architect-zone followups from round-2/3/4 stand." That single sentence is the only pointer. If the architect's intake scan starts and ends at the round-5 block, the earlier prescriptions are silently lost.

## Guidance

At archive intake of any task with two or more `Round-N` headings, apply this protocol BEFORE writing the archive entry or committing:

1. **Scan all hold blocks in the task body for "Architect followups (land at archive...)" or "Architect-zone items" sections** — not just the most recent. Each block must be read individually; back-references like "prior round followups stand" do not substitute for re-reading what those prior rounds said.

2. **Grep the task file for the literal phrase `at archive`** as a deterministic surface for all prescription blocks across rounds:

   ```bash
   grep -n "at archive" agents/docs/tasks/review/<slug>.md
   ```

   Every hit is a candidate prescription. Walk each line number in context.

3. **Triage each prescription against current task state.** Check `agents/docs/tasks/pending/`, `tasks/blocked/`, `tasks/review/`, and `tasks-archive.md` to identify which prescribed tasks were already filed during interim rounds. Some early-round prescriptions get satisfied by intervening work before the final clean — confirm before filing a duplicate. (Worked example: in the bridge HAF-lag arc, the round-2 prescription `backend-bridge-lock-real-redis-companion` was filed in interim commit `78e8578` and later archived in `9c8e44e` — at round-5 archive, it correctly stayed off the file-now list.)

4. **File still-unfiled prescriptions as task files in `tasks/pending/`** in a dedicated commit BEFORE the archive commit. Filing before archiving lets the archive entry reference the new task slugs by name, and ensures the tasks are visible to agent startup protocols immediately. Typical commit subject: `architect(tasks): file N follow-ups at archive intake — ...`.

5. **Deferred-with-trigger items** (e.g., "file this task if/when the area is next touched") may stay as residual notes in the archive entry body without filing. That's intentional architect deferral with a trigger condition — the trigger event is the filing signal, not the archive.

## Why This Matters

Agent startup protocols for architect, backend, ui, and pinner roles each direct the agent to list `tasks/pending/`, `tasks/blocked/`, and `tasks/review/`. **None** of them list `tasks-archive.md`. Prescriptions that end up only in an archive entry body are invisible to every agent startup pass. The obligation passed architect review when it was written, carried forward through multiple rounds, and then falls off the navigable surface at the moment it's most actionable.

The carry-forward back-reference pattern ("Pre-existing architect-zone followups from round-N stand") is load-bearing precisely because it's so cheap to write and so easy to miss at intake. A 5-round task file is long; the latest hold block closes it; the architect's natural attention flows bottom-up. Without a deliberate counter-protocol, earlier prescriptions disappear into the file's history.

## When to Apply

Apply this protocol at archive intake of any task with `Round-N` headings where N ≥ 2. Single-round archives don't have this failure mode. Tasks with 3+ rounds are the highest-risk surface, since they have the most accumulated back-references and the longest file bodies.

## Examples

**Failed approach (initially proposed for `backend-bridge-write-haf-lag-and-retry-amplification`, 2026-05-20):** After a 5-round arc cleaned, the round-5 hold block contained 3 "Architect followups" items (all architect-discretion `/ce-compound` candidates or already-resolved) and one back-reference line: "Pre-existing architect-zone followups from round-2/3/4 stand." The initial proposal was to note the 4 still-unfiled round-2 prescriptions as "carry-forward triage" prose in the archive entry body.

User pushback (verbatim): "Why not file them now? Noone will read the archive entry probably."

**Correct approach (what landed):** Grep + context-read identified 4 prescriptions from the round-2 hold block that were still unfiled (the fifth round-2 prescription, `backend-bridge-lock-real-redis-companion`, had been satisfied during interim rounds and was correctly excluded). All 4 were filed as task files in `tasks/pending/` in commit `2822e1f9`, alongside one new follow-up surfaced from the round-5 review. The archive commit `c6354165` followed, with its entry referencing the new task slugs by name.

Sequence:
- `2822e1f9` — `architect(tasks): file 5 follow-ups at HAF-cluster review intake — 4 bridge round-2/3 carry-forwards + 1 round-5 sibling-rot sweep`
- `9d34617c` — `architect(haf-walker-wall-clock-budget): archive — round-4 clean` (parallel walker task in same cluster)
- `c6354165` — `architect(bridge-write-haf-lag): archive — round-5 clean`

The test: if the architect's intake had stopped at the round-5 block, 4 prescriptions would have been lost — `backend-bridge-outer-catch-event-discriminators`, `backend-broadcast-attempt-helper-extraction`, `ui-bridge-register-lock-held-ux`, `backend-bridge-test-fence-replace-setTimeout`. The grep on `at archive` surfaces them deterministically regardless of file length or round count.

## Cross-references

- `agents/docs/solutions/conventions/load-bearing-greps-at-signal-block-write-time-2026-05-06.md` — sibling at-archive concern; covers a specific sub-case (greps deferred to architect-followup-at-archive instead of running at signal-block-write-time). This convention is the general form across all at-archive obligations.
- `agents/docs/solutions/conventions/architect-hold-block-risk-class-separation-2026-05-07.md` — prevention layer; filing different-class obligations as separate tasks early reduces the accumulation this convention guards against. The two compose.
- `agents/docs/solutions/conventions/re-review-intake-supersession-check-2026-05-05.md` — sibling archive-intake check (SHA supersession / orphan checks before reviewer dispatch). Both must pass at intake; this convention adds a third intake requirement.
- `agents/docs/solutions/conventions/cross-task-hold-block-staleness-2026-04-22.md` — related failure mode on the same artifact (hold-block premises going stale against parallel-task code changes). Same meta-pattern, different actor and time point.
- `agents/docs/solutions/conventions/defer-architect-doc-rewrite-when-cluster-sibling-touches-same-doc-2026-05-19.md` — adjacent; protocol for `[TODO Architect]` items prescribed in round-1 signals but executed at archive. Same prescription-deferral lifecycle, different prescription class.
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` — sibling architect-discipline convention; different failure mode (reviewer-side replacement-text audit) but same family of discipline conventions.
- Root `CLAUDE.md` Agent Coordination rule #7 (archive flow) and #8 (review → held-pending-fixes → re-review cycle).
- `agents/architect/CLAUDE.md` startup protocol and "Workflow when multiple files sit in tasks/review/" — natural home for the protocol prescribed here as durable architect discipline.

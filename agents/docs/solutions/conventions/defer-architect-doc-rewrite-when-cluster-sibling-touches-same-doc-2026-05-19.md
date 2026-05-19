---
title: Defer architect-owned doc rewrites when a sibling cluster task touches the same doc
date: 2026-05-19
category: conventions
module: agents/docs + architect coordination
problem_type: convention
component: documentation
severity: medium
applies_when:
  - Archiving a task with `[TODO Architect]` doc edits prescribed at the round-1 signal
  - The doc-edit scope is substantive (full section rewrite or large multi-section update)
  - A sibling task in the same review cluster is in active development and will require touching the same doc
tags: [architect-coordination, doc-edits, cluster-review, deferred-archive, blocked-task]
---

# Defer architect-owned doc rewrites when a sibling cluster task touches the same doc

## Context

PEvO's architect protocol has implementers append `[TODO Architect]` items to their task signal block when the implementation surfaces architect-owned doc edits (`ARCHITECTURE.md` sections, `api-contracts/*.md` updates, convention-doc paragraphs) that should land at the task's archive. The default flow is: architect re-reviews the implementation, finds it clean, lands the prescribed doc edits, then archives the task.

This works cleanly for single-task scopes. It produces wasteful churn when the task is part of a review **cluster** where multiple tasks in active development touch the same doc surface. The doc would be rewritten once for task N's archive, then re-rewritten 2-3 days later when task N+1 (sibling cluster task) ships its own changes to the same code surface.

Concrete incident — supersession cluster, 2026-05-19. `backend-multi-author-cumulative-union` (task 1) landed round-3 clean. Its round-1 signal prescribed 4 `[TODO Architect]` items, including a full rewrite of `ARCHITECTURE.md § 2 "Multi-Author Trust Model"` (117 lines, lines 172-288). At the same time, `backend-cumulative-union-listing-surfaces-parity` (sibling task 2 in the same cluster) was in active implementation in the working tree (commits `e0a82d1` + `6c05266` by a parallel backend agent), extending the cumulative-union invariant from the **detail surface** (closed by task 1) to **listing / profile** surfaces. The § 2 rewrite at task 1's archive would describe cumulative-union semantics for detail only; the listing-surfaces task's archive 2-3 days later would require rewriting the same section AGAIN to incorporate cross-surface parity. Two rewrites of the same 117-line section for one logical scope.

## Guidance

When archiving a task with `[TODO Architect]` doc edits, check whether an in-flight sibling cluster task will require touching the same doc surface. The mechanical check:

1. Inspect `tasks/pending/`, `tasks/review/`, and `tasks/blocked/` for sibling tasks in the same review cluster (tasks the cluster review covered together; tasks with cross-references to the archiving task; tasks visibly touching the same code surface).
2. For each sibling, infer whether its archive will require a similar doc edit. Signals: the sibling extends or amends the same invariant the archiving task established; the sibling's task body cross-references the same architect-owned doc; the cluster review's findings explicitly cite cross-surface parity between the archiving task and the sibling.
3. If yes, **defer the doc edits** by:
   - Creating an architect-self task `architect-<topic>-doc-edits.md` in `tasks/blocked/` capturing the full `[TODO Architect]` list verbatim (so the prescription survives the archive of its originating task).
   - Adding a `[BLOCKED by Backend]` (or appropriate role) note explaining the gate: "Waiting on `<sibling-task>` to archive so the doc rewrite covers both surfaces in one pass."
   - When the sibling task archives, the gating agent `git mv`s the architect-self task from `blocked/` to `pending/` per CLAUDE.md rule #6.
4. Archive the originating task with a brief deferral pointer in its archive entry: "[TODO Architect] doc edits deferred to `architect-<topic>-doc-edits` (blocked on sibling task archive)."

Do NOT block the originating task's archive on the doc edits when the deferral is reasonable. The implementation work is clean; the doc edits are downstream maintenance; blocking archive on a future task's completion serializes work unnecessarily.

## Why This Matters

`ARCHITECTURE.md` section rewrites are substantive documentation-design work — they're not mechanical paragraph-level edits. A 100+ line section rewrite touches:

- The mental model the doc imparts to future readers (cumulative-union vs no-shrink-rule framing)
- Cross-references to other docs and code paths
- Examples and reasoning chains
- The section's structural shape (how subsections compose, which invariants are foregrounded)

Re-rewriting the same section twice for one logical scope wastes the second pass's design work AND creates a transient inconsistency window where the doc is up-to-date for surface A but out-of-date for surface B. Worse, the first rewrite's text becomes anchor-rot in the second rewrite (the first version's symbol references and section structure may no longer match the second version's invariant).

Deferral makes the doc rewrite a single design pass against the final state. It also makes the architect-self task an explicit, named artifact rather than an implicit obligation buried in an archive entry — the next architect session can pick it up directly from `tasks/pending/` once the sibling archives.

## When to Apply

- The `[TODO Architect]` scope is substantive: full section rewrite, multi-section update, or cross-cutting doc edit across multiple files. Trivial one-line updates (e.g., adding a single sentence to an existing paragraph) don't justify deferral.
- The sibling task is in active development (already in `pending/` with claimed work, or in `review/` with backend-implementation commits visible). Not when the sibling is purely speculative or hasn't been picked up.
- The sibling's expected archive is within a reasonable window (days to ~2 weeks, not months). Long-horizon siblings risk the deferred doc-edit task becoming stale itself; in that case, land the partial doc edit at the originating task's archive and file a follow-up to extend later.
- The sibling's changes are additive or compositional, not contradictory. If the sibling is rolling back the originating task's invariant, the deferral logic flips — the originating task's archive should hold until the sibling resolves, or the originating task itself should be revisited.

Do NOT apply when:

- The doc edits are trivially small and the sibling task is genuinely independent. Just land them.
- The originating task is **not** part of a cluster review — single-task scopes don't have the sibling-doc-overlap problem.
- The architect doesn't have visibility into the sibling's actual scope (e.g., the sibling task body is vague). In that case, ask the user to confirm the sibling's doc-edit scope before deferring.

## Examples

### The supersession-cluster incident (2026-05-19)

Three tasks in `tasks/review/` covered by one architect-context cluster review:

| Task | Code surface | Doc-edit obligation |
|---|---|---|
| `backend-multi-author-cumulative-union` (task 1) | Detail-surface cumulative-union construction in `papers.ts` | 4 [TODO Architect] items including § 2 rewrite |
| `backend-cumulative-union-listing-surfaces-parity` (task 2) | Extends cumulative-union to listing + profile surfaces | Architect-owned `papers.md` + `profiles.md` updates at the task's own archive |
| `backend-papers-canonical-orcid-resolution` (task 3) | SQL/JS supersession projection on PaperDetail + PaperSummary | Contract-doc deferrals settled by backend's verbatim emit shape |

The cluster review settled task 1 + task 3 as round-N clean. Task 2 (which the cluster review surfaced as a design-ratification need) was ratified Option 4 by a parallel architect session and entered backend implementation during the cluster-review session.

At task 1's archive decision point, the architect noticed:

- § 2 rewrite would cover cumulative-union for **detail surfaces only** if landed at task 1's archive
- Task 2's eventual archive would require § 2 to be rewritten AGAIN to incorporate cross-surface parity (cumulative-union for listing + profile)
- The same paragraph would describe the same invariant — just extended

Action: deferred the 4 [TODO Architect] items via `architect-cumulative-union-doc-edits.md` filed in `tasks/blocked/` with `[BLOCKED by Backend]` note gated on `backend-cumulative-union-listing-surfaces-parity` archive. Task 1 archived clean with the deferral pointer in its archive entry. When task 2 archives, the doc-edit task unblocks and § 2 gets rewritten ONCE covering both surfaces.

### Counter-example — when NOT to defer

A single sentence addition to `api-contracts/papers.md` at task archive doesn't justify deferral, even if a sibling task will also touch papers.md. Land the sentence; the sibling adds its own sentence later. The cost of two single-sentence edits is lower than the coordination overhead of an architect-self task + blocked-state tracking.

## Related

- CLAUDE.md root § "Agent Coordination Rules" #6 — `[BLOCKED by <agent>]` flow for cross-agent gating
- CLAUDE.md root § "Code Review Findings" — cluster-review triage where this convention often surfaces
- `feedback_held_task_blocked_on_architect.md` (memory) — mirror pattern: held tasks waiting on architect input go to `blocked/`, not `pending/`
- `agents/architect/CLAUDE.md` § "Architect-self-task creation" — the `tasks/blocked/architect-*` slug convention this learning extends
- Concrete incident: `backend-multi-author-cumulative-union` archive (2026-05-19) + `architect-cumulative-union-doc-edits.md` (filed 2026-05-19, blocked on `backend-cumulative-union-listing-surfaces-parity` archive)

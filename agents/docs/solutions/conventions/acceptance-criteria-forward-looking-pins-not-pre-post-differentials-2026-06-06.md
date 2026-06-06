---
title: Write acceptance criteria as forward-looking pins, not pre/post differentials — a baseline that will not exist post-merge cannot discharge a bullet
date: 2026-06-06
category: conventions
module: agents/docs/tasks
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - Authoring acceptance bullets for a task file under `agents/docs/tasks/pending/`, especially for refactors and perf changes claimed to be semantically equivalent
  - Tempted to write "output byte-identical to pre-change" or "identical to the previous behavior" as an acceptance criterion
  - Writing an acceptance bullet that demands evidence gathering (EXPLAIN ANALYZE, benchmark numbers) without naming how or when to gather it
  - Reviewing a task in `tasks/review/` whose acceptance bullets are unmet and deciding whether to hold or dismiss
tags:
  - acceptance-criteria
  - task-authoring
  - shape-canary
  - absence-assertion
  - equivalence
  - architect-workflow
---

## Context

Three of seven reputation-cluster tasks arrived at review with acceptance bullets that could no longer be discharged. Two demanded "cycle output byte-identical to pre-change for the same input" — but the change was already merged, so no pre-change baseline existed to compare against, and run-to-run determinism tests cannot stand in (both runs agree on a mis-scored output). One demanded "EXPLAIN ANALYZE shows the scan is bounded" — evidence that is easy to gather during implementation and routinely skipped under implementation momentum, leaving the reviewer to choose between a retroactive hold and a dismissal.

Triage resolved these with a dismissal pattern applied four times across two review rounds: accept the mechanical equivalence proof (for example, the modified CTE has exactly one consumer and the filter matches that consumer's join domain), then convert the differential demand into a forward-looking pin that catches the regression class from now on. That case law lived only in architect hold blocks, which trim out of `tasks-archive.md` at its 250-line cap.

## Guidance

When authoring acceptance bullets, demand artifacts that remain checkable AFTER the change merges:

- **Shape canaries**: assert the emitted SQL (or source region) contains the required token (`c.author = ANY($2::text[])`, `ORDER BY ... DESC LIMIT 1`), captured via a capturing pool or a source-slice anchored on stable labels.
- **Absence assertions**: assert the replaced inline form is GONE (the strongest cheap pin for an extraction: a one-site revert-to-inline fails red).
- **Adoption pins**: assert the helper's emitted fragment appears exactly N times in the integrated output, tying call sites to the shared implementation.
- **Evidence-with-method bullets**: when plan or benchmark evidence is genuinely wanted, write "run X during implementation using Y, paste the result into this file" — naming the method and the destination. An evidence bullet without a method is a bullet that gets skipped.

Reserve "byte-identical to pre-change" for cases where a baseline will actually exist at verification time (for example, a snapshot committed BEFORE the change as part of the same task). Otherwise prove equivalence mechanically in the task's design notes and pin the regression class instead.

At review time, when an undischargeable differential bullet surfaces: do not hold the task hostage to it. Verify the mechanical proof, require the forward-looking pin, and record the dismissal with its reasoning.

## Why This Matters

A differential bullet that cannot be discharged forces a bad choice at review: hold the task for evidence nobody can produce, or wave the bullet through and erode the meaning of acceptance criteria. Forward-looking pins are strictly more durable — they verify the same property AND keep verifying it on every future commit, which a one-time pre/post comparison never does.

## When to Apply

Every time the architect writes acceptance bullets for equivalence-preserving changes (filter pushdowns, helper extractions, query rewrites, cache-layer swaps), and every review where such a bullet is unmet.

## Examples

Undischargeable (avoid):

```markdown
- Regression test: cycle output for the same accreditedArr is byte-identical to pre-change.
- EXPLAIN ANALYZE shows the paper arm scans bounded by the accredited set.
```

Forward-looking equivalents (prefer):

```markdown
- Shape canary: the paper arm of active_authors contains `c.author = ANY($2::text[])`
  and does NOT contain an `OR c.author =` widening term (capturing-pool or
  source-slice assertion, anchored on the CTE label).
- During implementation, run EXPLAIN (ANALYZE, BUFFERS) on the paper arm against
  the HAF replica via a /tmp Node script loading the backend's pg module, and
  paste the plan lines into this file; the plan must show an index-bounded scan.
- Absence assertion: the inline decay formula shape no longer appears in
  reputation.ts; the helper fragment appears exactly 3 times in the emitted batch SQL.
```

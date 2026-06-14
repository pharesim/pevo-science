---
title: Comment prose must not restate a count or value a nearby in-file data structure already encodes — duplicated-derivable-data is a rot class distinct from external-pointer rot
date: 2026-06-14
category: conventions
module: backend/tests + backend/src
problem_type: convention
component: documentation
severity: medium
applies_when:
  - "Writing a test-file header or docblock that narrates counts or values which a table, array, or constant list in the same file already encodes"
  - "Reviewing a comment that says 'the N call sites', 'across M files', or spells out a per-item breakdown that mirrors a data structure below it"
  - "Tempted to summarize a CALLSITES table / fixture array / enum's contents in prose for the reader's convenience"
tags:
  - comment-rot
  - documentation
  - derivable-data
  - prose-numerals
  - data-table
  - single-source-of-truth
  - comment-anchor
related_components:
  - documentation
  - testing_framework
---

# Comment prose must not restate a count or value a nearby in-file data structure already encodes

## Context

PEvO already documents that comments must not anchor on things that rot when their *target* moves: line numbers and SHAs (`docblock-anchor-stable-symbols-not-line-numbers`), task slugs that archive (`task-slug-citations-in-comments-go-stale-on-archive`). Those are all forms of **external-pointer rot** — a reference pointing out of the file at something that shifts.

A separate, equally recurrent rot class is **duplicated-derivable-data**: comment prose that restates a count or value which a data structure in the *same file* already encodes. A test-file header narrated the total SQL-site count, the callsite-file count, and a per-file `2+2+1+1+1+4 = 11` breakdown — all derivable from the `CALLSITES` data table a few screens below it, which is what the assertions actually enforce. The prose drifted from the table and cost **four consecutive review rounds** reconciling the narration against the table. Nothing pointed out of the file; the rot was purely internal duplication of data the file already held authoritatively.

## Guidance

Do not restate in comment or docblock prose any count or value that a nearby in-file data structure (a table, a fixture array, a constant list, an enum) already encodes. Reference the structure instead, and keep only the non-derivable explanation:

- Replace a derivable numeral with a pointer to the authoritative structure: "a revert at any callsite listed in `CALLSITES`" instead of "any of the 11 SQL sites"; "read each callsite file listed in `CALLSITES`" instead of "each of the 6 callsite files".
- Drop arithmetic that re-derives the structure ("that's 11 callsites", "2+2+1+1+1+4").
- **Keep** the symbol-level *why* the structure cannot express: which file contributes which entry and the reason (e.g. "the listing pins one combined `rev_agg` LATERAL site rather than one per metric"). Explanation is durable; a recount is not.

The test: if a value in the prose can be obtained by counting or summing a structure elsewhere in the same file, the prose is duplicating derivable data and will rot the next time the structure changes. Make the structure the single inventory.

## Why This Matters

Prose that duplicates a data structure has no enforcement tying it to that structure — only the assertions enforce the table, so the narration drifts freely on every edit to the data, and each drift is a review-round finding. It is the same single-source-of-truth failure as duplicating a constant across two declarations, but in comment form, so no compiler or test catches it. The four-round reconciliation history on one test header is the cost signature: a recurring, mechanical, entirely avoidable churn that ends only when the derivable numerals are removed and the structure is named as the single inventory.

This is a fourth member of the comment-anchor family alongside line/SHA rot, task-slug rot, and the "convention-enforcing fix must audit its own replacement" rule (`convention-enforcing-fix-must-audit-its-own-new-code`) — when removing a derivable numeral, confirm the replacement prose does not introduce a fresh anchor-rot of any class.

## When to Apply

When writing or reviewing any comment/docblock/test-header that mentions a count, a per-item breakdown, or a value that a structure in the same file encodes. Default to referencing the structure by name and deleting the derived value. Applies in `backend/src/**`, `frontend/src/**`, test headers, and `agents/docs/solutions/**` bodies; does not apply to commit messages or transient `agents/docs/tasks/**` coordination files.

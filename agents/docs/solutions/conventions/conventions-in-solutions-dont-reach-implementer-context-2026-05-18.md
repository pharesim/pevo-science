---
title: Conventions stored only in agents/docs/solutions/ don't reach implementer-agent context at write-time
date: 2026-05-18
category: conventions
module: agent-coordination
problem_type: convention
component: documentation
severity: medium
applies_when:
  - Landing a new convention via `/ce-compound` that implementer agents (backend, ui, pinner) must follow at write-time
  - A reviewer keeps finding the same anti-pattern across consecutive review rounds despite a documented convention existing
  - Deciding where to land a one-line rule vs a full rationale doc
  - Auditing whether `agents/docs/solutions/` entries are actually changing implementer behavior
tags: [agent-coordination, conventions, solutions-discoverability, startup-protocol, implementer-context, code-review-loop, documentation]
---

# Conventions stored only in agents/docs/solutions/ don't reach implementer-agent context at write-time

## Context

PEvO's implementer agents (backend, ui, pinner) follow a strict startup protocol from root `CLAUDE.md`:

1. Read `agents/<role>/CLAUDE.md` for role rules.
2. List `agents/docs/tasks/pending/` for assigned task files.
3. Read the assigned task file.
4. Read only the source files needed for the task.

The `agents/docs/solutions/` directory is **not** in that path. Conventions land there via `/ce-compound`, but the agents who need to apply them at write-time never load them. Implementer agents instead mirror the comment style of the file they're editing — which often still contains pre-convention citations because no sweep has retroactively cleaned them. Reviewers catch violations after the fact via `/ce-code-review`, hold the task for round N+1, and the cycle repeats one task at a time.

On 2026-05-18, a 4-task cluster review made this concrete: 9 of 15 confidence-gated findings across four sibling tasks were the same anti-pattern — slug citations (`// BACKEND-ACCREDITATION-LIMITER-SKIP-FAILED:`) and raw line-number anchors (`// accreditations.ts:41`) in code comments. Both anti-patterns had dedicated convention docs landed 2026-05-15 (three days earlier):

- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`
- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`

Implementer commits dated 2026-05-16 and 2026-05-17 — one to three days after the conventions landed — still produced fresh violations:

- `backend/src/routes/accreditation.ts` preamble comment cited 4 line-number anchors; 2 were already stale at write time (`:436` should have been `:455`, `:442` should have been `:461`).
- `backend/tests/routes/accreditation.test.ts:1663` cited `rateLimit.ts:100-101` as the refund branch — actual refund gate at line 156. Wrong-as-written.
- `backend/tests/routes/accreditations-likeguard-mocked.test.ts` (a brand-new file) cited 5 line numbers in its header, including `search-filters.ts:53` — wrong path (actual is `backend/src/types/search-filters.ts`). Broken at write time.
- `backend/tests/routes/accreditation-idempotency.test.ts:540, :580` opened two new test-block headers with `BACKEND-ACCREDITATION-VERIFY-LIMITER-SKIP-FAILED acceptance #N:` slug references.
- `frontend/tests/unit/pages-accreditation-verify.test.js:309` introduced a net-new `// UI-ACCREDITATION-VERIFY-NETWORK-ERROR-RETRIABLE:` slug citation.

The implementer agents weren't ignoring the rules. They never saw them.

## Guidance

When you write a convention into `agents/docs/solutions/` via `/ce-compound`, also surface a one-line summary in the **startup-read path** of every agent who needs to apply it at write-time. The solutions directory is a knowledge store, not a delivery mechanism. Conventions reach write-time context only when they are reachable from a file the agent loads during startup — `agents/<role>/CLAUDE.md`, root `CLAUDE.md`, or a task file the agent will read.

The minimum surface is a one-line entry in the relevant agent CLAUDE.md naming the rule and linking the canonical doc, e.g.:

> **Comment anchoring:** in code comments, anchor on stable type symbols and behavioral descriptions, NOT raw line numbers or task slugs. See `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` and `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`.

When the rule is project-wide (crosses roles), surface it in root `CLAUDE.md` instead — the comment-hygiene section there is the natural home for cross-role write-time rules. When it's role-specific (e.g., a Hive-broadcast convention only Backend writes), the per-role CLAUDE.md is the right surface.

Reviewer-time enforcement (`/ce-code-review` catches → hold for round N+1) is **not a substitute**. By the time the hold lands, the implementer's context still doesn't contain the convention. They fix the cited sites and reintroduce the class on the next new comment in the next new task. The per-task hold cycle catches recurrences one at a time, but each costs an extra round, and the class never closes.

The full rationale stays in the `agents/docs/solutions/` entry — the one-liner is a hook, not a duplicate.

## Why This Matters

The 9/15 cluster finding rate is the evidence. Two well-written conventions, archived in the canonical location, both violated three days running by the agent role they were authored to guide. Without a startup-path surface, every new convention buys exactly one task's worth of enforcement (the task that motivated it) and then decays. Each subsequent task's first new comment block is the moment the class returns.

Surfacing the rule in the startup path closes the class: the next new comment is written under the rule rather than retrofitted to it. The cost is one line per role-CLAUDE.md, or one line in root `CLAUDE.md` for cross-role rules. The avoided cost is N extra review rounds per N future tasks that touch the affected file class.

## When to Apply

Apply when a `/ce-compound` entry codifies a convention that implementer agents (not just reviewers, not just architects) need to follow at write-time. Specifically:

- Code-comment hygiene rules (anchoring, citation format, what to include/omit).
- Naming, structure, or layout conventions for new code.
- Test-file conventions (header format, mock policy, fixture choice, carve-out clauses).
- Any rule whose violation produces a hold finding at code-review rather than a runtime bug.

Skip the surface step for entries that only inform reviewer triage (e.g., dismissal-criteria conventions read by reviewers, not writers) or document a one-shot incident (e.g., a specific outage post-mortem with no reusable write-time rule). Those don't need write-time visibility.

When the architect lands a convention via `/ce-compound`, the discoverability check in the skill already asks whether the relevant root-level instruction file surfaces `agents/docs/solutions/`. This convention extends that check: also ask whether the rule needs a one-liner in `agents/<role>/CLAUDE.md` or in a more specific section of root `CLAUDE.md`.

## Examples

**Before (status quo, 2026-05-15 to 2026-05-18):**

`/ce-compound` writes `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` and `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`. Neither is referenced from any agent CLAUDE.md or root `CLAUDE.md` comment-hygiene section. Backend agent's next task (2026-05-16) lands a preamble comment citing 4 line-number anchors, 2 stale-at-write-time. Test file header cites `search-filters.ts:53` — wrong path. Three rounds of review/hold/fix per task, class not closed. Sibling agents (architect, ui) repeat the same pattern in their own zones.

**After (surfaced in startup path):**

`agents/backend/CLAUDE.md` gains a one-liner under its comment-guidance section:

> **Comment anchoring:** anchor on stable type symbols and behavioral descriptions, NOT raw line numbers or task slugs. See `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` and `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`.

`agents/ui/CLAUDE.md` and `agents/pinner/CLAUDE.md` gain the same line. (Or, if the architect judges the rule cross-cutting, root `CLAUDE.md`'s existing comment-hygiene block gains the link.)

Backend agent reads `agents/backend/CLAUDE.md` at startup per its standard protocol. Next preamble comment describes the gate behaviorally ("the refund branch in the rate-limit middleware") and references the type symbol (`RateLimitConfig.skipFailedRequests`), not the line. Review pass finds zero citation-hygiene issues. The convention now compounds: each task that touches a commented file inherits the rule by default rather than by retrofit.

## Related conventions

- `agents/docs/solutions/conventions/hold-block-must-not-contradict-convention-docs-2026-04-22.md` — the architect-side mirror of this discoverability failure: hold blocks must consult `solutions/conventions/` BEFORE authoring envelope-shape decisions. Same root cause (`solutions/` not consulted before write), different actor (architect-hold-author vs implementer-at-write-time).
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` — reviewer-side complement: a "purge X" fix must audit its own new code, not just the cited sweep sites.
- `agents/docs/solutions/conventions/symmetric-walker-convention-application-audit-prototype-holds-2026-05-05.md` — same problem family: the convention doc text alone is one round behind the strongest version of the rule; the prototype's hold history carries the rest.
- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` and `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` — the two conventions whose 9/15 violation rate during the 2026-05-18 cluster review motivated this meta-rule.

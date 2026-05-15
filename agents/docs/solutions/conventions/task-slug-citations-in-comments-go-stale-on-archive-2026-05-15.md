---
title: Task-slug citations in code comments and solution docs go stale on archive — anchor on behavioral invariants instead
date: 2026-05-15
category: conventions
module: backend/src + agents/docs/solutions
problem_type: convention
component: documentation
severity: medium
applies_when:
  - Writing a code comment that needs to point at related work (cluster-task arc, pending follow-up, future enhancement)
  - Writing the Related section of a doc under `agents/docs/solutions/`
  - Reviewing a hold-block round-N item that mentions a sibling task by slug
  - Cross-referencing between sibling tasks in the same cluster
tags: [documentation, comment-rot, task-slug, drift, archive, cluster-tasks, docblock]
---

# Task-slug citations in code comments and solution docs go stale on archive — anchor on behavioral invariants instead

## Context

PEvO's per-task-file workflow (root `CLAUDE.md` rules #5 + #7) deletes the per-task file from `agents/docs/tasks/` on archive. Any code comment or solution-doc reference that names a task-file slug becomes a dead pointer the moment that task archives. The 250-line tail of `tasks-archive.md` is bounded; older entries fall off entirely; the original task content survives in git history but is no longer reachable by slug-grep.

Cluster-task arcs (multiple tasks coordinating on the same code area) make this worse: tasks frequently cross-reference each other ("filed as `<slug>`", "see `<slug>` for the populator", "until `<slug>` lands the real X"). When the cluster archives in waves, each archive event silently breaks one or more sibling references. The references rot without any compile-time, test-time, or lint-time signal.

A sibling convention covers a related rot class — line-number references in comments (`file.ts:263`) drift on insertion above the citation, and `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` is the canonical fix. That convention explicitly **excludes** task-coordination files from its scope, leaving this related rot class undocumented until now.

## Guidance

In code comments, anchor on the **behavioral invariant** or the **shipped-feature description** — not on the task that tracked the work.

In solution-doc `Related` sections, prefer:
- The shipped solution doc path (durable once the doc is written)
- The authoritative code symbol (`handleBroadcastError`, `withOrcidBindingLock`, etc.)
- A behavioral description of the related work

Avoid:
- Bare task slugs (`backend-broadcast-idempotency-cluster-followup.md`)
- "When `<slug>` lands the real X" framing (presupposes the task hasn't archived)
- "Filed as `<slug>`" framing (will be unfindable after archive)

When a comment genuinely needs to track future work that doesn't have a behavioral name yet (e.g., a hold-block item identified during review but not yet captured in any doc or code), describe the CONDITION ("until a per-key counter mechanism is added") rather than the COORDINATION ARTIFACT ("until the idempotency cluster lands the real per-key counter"). Conditions are durable; coordination artifacts are not.

## Why This Matters

Three confirmed instances of this rot class were surfaced in a single `/ce-code-review` session (2026-05-15 architect re-review on the bridge cluster):

1. `backend/src/routes/custody.ts` (three sites in `attempt_n` rationale comments) referenced archived `backend-broadcast-idempotency-cluster-followup.md`. Cluster archived 2026-05-12 (commit `c715db1`) **without** adding a per-attempt counter — the framing "When the idempotency cluster lands the real per-key counter…" was misleading on two counts simultaneously: (a) the task slug no longer exists, (b) the closed task did not deliver what the framing implied it would.
2. `backend/src/lib/broadcast-error.ts:649-658` (the `makeLogBroadcastAttempt` factory docblock) — same archived slug, same misleading framing. Five reviewers independently flagged this during code review (correctness, adversarial, maintainability, learnings, project-standards).
3. `backend/src/routes/bridge.ts:474-478` (the `logBroadcastAttempt` closure call site in `/register`) — same archived slug, same framing. Two reviewers corroborated.

A fourth instance appeared inside a solution doc itself: `agents/docs/solutions/conventions/broadcast-per-attempt-vs-error-event-roles-2026-05-13.md`'s Related section still cites the archived task slug. The drift propagates: solution docs that cite task slugs perpetuate the same rot at the very doc layer meant to outlast tasks.

The cumulative failure mode is severe for cluster-task arcs: a future agent reading any of these comments follows the slug, finds nothing in `tasks/`, and bases planning on a wrong premise (treats closed work as pending, or pending work as closed). The compile-time/test-time/lint-time signal is zero; the only catch is a human reviewer noticing the dead pointer.

## When to Apply

- Writing any code comment that needs to point at coordination work — prefer the behavioral description over the task slug
- Writing the Related section of an `agents/docs/solutions/` doc — task slugs in Related are transient; the doc outlasts them
- Reviewing a hold-block round-N item that names a sibling task slug — surface as a rot risk, not just a coordination link
- Auditing a cluster-task arc for comment drift before archiving any task in the cluster

## Examples

**Bad — task-slug citation in a code comment** (the original drift instance fixed in round-4 of `backend-bridge-custody-broadcast-discrimination`):

```ts
// Round-3 hold #1: `attempt_n` is INTENTIONALLY OMITTED. The handler has no
// idempotency / per-key retry counter state today, so a hardcoded
// `attempt_n: 1` would silently report "no retries" to dashboards that key
// on the field for retry-amplification alerts — masking the very signal
// the alert exists to surface. Leaving the slot empty until the
// idempotency cluster (`backend-broadcast-idempotency-cluster-followup.md`)
// lands the real per-key counter is the safer default: alerts fire on
// missing-field rather than reading a constant 1 as ground truth.
```

**Good — behavioral-invariant citation** (the round-4 rewrite):

```ts
// Round-3 hold #1: `attempt_n` is INTENTIONALLY OMITTED. The idempotency
// layer landed (`embedIdempotencyKey` + `lookupCustodyBroadcastIdempotency`
// above wire the dedup gate against HAF), but that arc did NOT add a
// per-attempt counter — the gate either short-circuits with the prior
// tx_id on a hit or proceeds with no retry-history state. So a hardcoded
// `attempt_n: 1` would still silently report "no retries" to dashboards
// keyed on the field for retry-amplification alerts — masking the very
// signal the alert exists to surface. The slot stays empty until a
// per-key counter mechanism exists; alerts fire on missing-field rather
// than reading a constant 1 as ground truth.
```

Two improvements in the rewrite:
1. The task slug is replaced with a **shipped-feature description** (the `embedIdempotencyKey` + `lookupCustodyBroadcastIdempotency` helpers, which are authoritative code symbols).
2. The "until X lands" framing is replaced with **"until a per-key counter mechanism exists"** — a behavioral condition rather than a coordination artifact.

**Bad — task-slug citation in a solution doc Related section**:

```
## Related
- `backend-broadcast-idempotency-cluster-followup.md` — pending follow-up that adds the per-key counter mechanism.
```

**Good — durable cross-reference**:

```
## Related
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — sibling convention on broadcast retry behavior.
- Per-key retry counter (TODO): not yet implemented. The factory at `backend/src/lib/broadcast-error.ts:makeLogBroadcastAttempt` deliberately omits `attempt_n` until the mechanism exists.
```

The good form names a shipped doc by path (durable), and describes the missing mechanism by behavioral condition + authoritative code-symbol location (durable), rather than naming a task slug (transient).

## Related

- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` — covers the sibling rot class of **line-number** anchors in comments. That convention explicitly carves out task-coordination files from its scope; this one covers what that carve-out leaves uncovered.
- `agents/docs/solutions/conventions/broadcast-per-attempt-vs-error-event-roles-2026-05-13.md` — itself contains an instance of this drift in its Related section (cites archived `backend-broadcast-idempotency-cluster-followup.md`). A `/ce-compound-refresh` on that doc is filed as the canonical first remediation.
- Root `CLAUDE.md` rule #7 (the archive protocol that deletes per-task files and trims `tasks-archive.md` to 250 lines) — the underlying mechanism that makes this rot inevitable.

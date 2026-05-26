---
title: Verify "gated/blocked-on-X" task annotations against code at re-review intake, not against task-tree location
date: 2026-05-26
category: conventions
module: agent-coordination
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - 'Reviewing a task file in `agents/docs/tasks/review/` whose hold block defers an item as "gated on" or "blocked on" another task'
  - 'Deciding whether to route a dependent task to `agents/docs/tasks/blocked/` because of a cited dependency'
  - 'Re-reviewing a held task whose gating task is still sitting in `agents/docs/tasks/pending/` (the task-state-lag scenario)'
  - 'Filing a new hold round that repeats a prior "gated on X" deferral after calendar time has passed'
tags:
  - agent-coordination
  - git-workflow
  - task-coordination
  - re-review
  - audit
  - drift
---

## Context

PEvO task files in `agents/docs/tasks/` carry deferral annotations — "gated on `<other-task>`", "blocked on `<backend-task>`", "item N deferred pending `<slug>`" — written when the gate is real and updated by hand if and when the gate is lifted. Task-tree location is not synchronised with code: an implementer can commit the gating work to `main`, move their own task through review, and have it archive, all while the dependent task's hold block still reads "still gated on `<slug>`." The gating task may even still be sitting in `tasks/pending/` at that point — task-state lag is normal, tasks do not auto-archive on merge.

The concrete trigger was the UI task `ui-bridge-import-queue-ux`, item 10 ("View-paper link for ALL completed entries"). Across two hold rounds the item was marked "still gated on `backend-bridge-imports-entry-enrich`," and that backend task was still in `tasks/pending/`. On re-review intake, the naive path was to re-defer the item or move the task to `tasks/blocked/`. A direct grep of the cited route — `serializeQueueRow` in `backend/src/routes/bridge.ts` — showed the gate's requirements already on `main`: `author` was being emitted for completed entries (`existing_author ?? config.hiveBridgeAccount`), `title` was persisted via the enqueue path, and `queue_position` was wired through for the eta computation. The deferral annotation was stale in the unblocked direction. The `/ce-code-review` api-contract persona surfaced the symptom — the UI's `adaptEntry` was reading `existing_author` instead of the now-available `author`, suppressing the View-paper link for fresh-broadcast completions — which led to a one-line widening fix rather than another blocked round.

## Guidance

At re-review intake, verify "gated/blocked/deferred-on-X" annotations against the actual code on `main` — not against the gating task's location in the `tasks/` tree.

The cheap check: when a hold-block item says "gated on `<other-task>`" or "blocked on `<field>`/`<route>`/`<function>`", grep the cited symbol on `main` before re-deferring.

```bash
# Substitute the symbol the gate cited — a field name, route path, or function name.
grep -n "author" backend/src/routes/bridge.ts
# Present  → gate is likely stale; verify the emitted shape actually satisfies the item.
# Absent   → gate is still live; re-defer normally.
```

If the grep is positive, do a quick semantic scan: does the emitted shape actually satisfy what the dependent item needed? If yes, the gate is stale and the item is actionable now — move the task back to `tasks/pending/` for the implementer to land the dependent fix, rather than to `tasks/blocked/`. If the shape is present but incomplete (field exists, wrong value domain), the gate is partially lifted: note what remains and decide whether a narrower fix unblocks the item or whether the deferral should narrow its scope.

The deferral decision, before and after applying the discipline:

| Without verification | With verification |
|---|---|
| Hold block says "still gated on `backend-bridge-imports-entry-enrich`" → move task to `blocked/` and wait | Grep `serializeQueueRow` in `backend/src/routes/bridge.ts` → `author` present → gate stale → move task to `pending/` for the one-line fix |

## Why This Matters

**Deferral annotations are coordination state, not code state.** They are written at a point in time and updated — if at all — by another agent later. The window between "gate lifts on `main`" and "deferral annotation updated" can span multiple hold rounds and weeks of calendar time. Re-review that trusts the annotation at face value re-defers shippable work, extends hold chains, and sometimes routes tasks to `blocked/` for work that is already done.

**This is the annotation-trust analog of the SHA-trust intake checks.** The architect intake series already verifies *commit-SHA* claims against git — reachability, content-match, supersession (see Related). This convention adds a parallel axis on a different artifact: a *deferral annotation*, verified against code rather than git history. Both express one principle: task-coordination artifacts (signal-block SHAs, gating annotations) are NOT authoritative — code and git are. Verify at intake. The orphan-detection check catches "claimed landed but actually orphaned"; this check catches "claimed still-gated but actually shipped."

**The cost asymmetry favours the grep.** A single `grep` on a route file takes seconds. Re-deferring a shippable item costs another hold round, another implementer cycle, and another re-review pass — in the concrete incident, item 10 had already consumed two hold rounds before the stale gate was detected. Catching it at intake rather than after a third round saved a full cycle.

## When to Apply

- Architect intake of any `tasks/review/` file whose hold-block items are marked "gated on `<slug>`", "blocked on `<other-task>`", or "deferred pending `<description>`".
- Re-review of a held task where the gating task has not yet moved to `tasks/review/` (it is still in `tasks/pending/` or `tasks/blocked/`) — exactly the task-state-lag scenario.
- Any pass where you are about to route a task or item to `tasks/blocked/` because of a cited dependency: verify the dependency's code surface first.
- Implementer self-check before filing a new hold round: if your own previous deferral said "gated on X" and time has passed, grep X before repeating the deferral — the gate may have quietly shipped.

Do NOT skip the check because the gating task file is still in `tasks/pending/`. Task-file location lags code; presence in `pending/` does not mean the code is absent from `main`.

## Examples

### Stale gate detected at intake (the concrete incident)

```bash
# Hold block reads: "item 10 still gated on backend-bridge-imports-entry-enrich
# (author/title/eta fields not yet emitted by the route)."
# The backend task is still in tasks/pending/. Naive path: move to blocked/.

# Before re-deferring: grep the cited symbol on main.
grep -n "author" backend/src/routes/bridge.ts
# serializeQueueRow returns author for completed entries; title + queue_position present too.

# Gate is stale. Item is actionable. Move task back to tasks/pending/ for the
# one-line widening (adaptEntry: author: wire.existing_author ?? null
#   → wire.author ?? wire.existing_author ?? null). Do NOT move to tasks/blocked/.
```

### Live gate confirmed — re-defer normally

```bash
# Hold block reads: "item 5 gated on backend-orcid-profile-enrich
# (orcid field not yet returned by /api/users/:username)."
grep -rn "orcid" backend/src/routes/users.ts
# No output — field absent from the route.

# Gate is live. Move task to tasks/blocked/ with [BLOCKED by Backend].
```

### The two intake checks are mirror images

```bash
# SHA-trust (worktree-fanout-orphan-detection): signal block claims "landed at <sha>".
git merge-base --is-ancestor <sha> main && echo "ON MAIN" || echo "ORPHANED"
# Catches: claimed LANDED but actually orphaned.

# Annotation-trust (this convention): hold block claims "still gated on <symbol>".
grep -n "<symbol>" <route-file>
# Catches: claimed STILL-GATED but actually shipped.

# Both verify coordination state against code/git — never against other task files.
```

## Related

- **Mirror — same intake checkpoint, opposite failure direction:** [`worktree-fanout-orphan-detection-2026-04-29.md`](./worktree-fanout-orphan-detection-2026-04-29.md). Verifies a claimed-*landed* SHA is reachable from `main`. This convention verifies a claimed-*still-gated* annotation against code. Together: a "landed" claim can be falsely positive (orphaned), a "gated" claim can be falsely positive (already shipped) — both need a check against reality.
- **SHA-trust dimension series:** [`re-review-intake-supersession-check-2026-05-05.md`](./re-review-intake-supersession-check-2026-05-05.md) enumerates the three SHA-trust dimensions (reachability, content-match, supersession). This convention is the annotation-trust axis on a different artifact (deferral annotation, not commit SHA), at the same intake checkpoint.
- **Symmetric staleness on a different artifact:** [`cross-task-hold-block-staleness-2026-04-22.md`](./cross-task-hold-block-staleness-2026-04-22.md). Hold-block *premises* (cited call sites) go stale when parallel tasks land between rounds; here a *deferral annotation* goes stale when the gating work lands. Same meta-pattern, different artifact.
- **First-review variant of verify-against-code:** [`stale-review-intake-verify-spec-at-head-2026-05-15.md`](./stale-review-intake-verify-spec-at-head-2026-05-15.md). Verify a task's stated state against HEAD rather than trusting the task file, on first review intake.
- **Enclosing protocol:** root `CLAUDE.md` rule #8 (Review → held-pending-fixes → re-review cycle) and `agents/architect/CLAUDE.md` re-review intake.

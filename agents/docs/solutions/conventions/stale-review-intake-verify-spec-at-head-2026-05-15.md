---
title: Stale review/ intake — verify spec against HEAD when implementer's diff is heavily displaced
date: 2026-05-15
category: conventions
module: agent-coordination
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - Architect first-time review intake on a tasks/review/ task whose implementer commit is non-trivially behind HEAD (≥10 commits, definitively when ≥100)
  - Subsequent commits have substantially rewritten or redesigned files in the implementer's diff scope, especially when the redesign is deliberate (not just organic refactor)
  - The task spec's acceptance criteria include an explicit alternate-shape clause that HEAD may already satisfy via a different mechanism than the implementer's diff implemented
  - /ce-code-review's fast-path scope (base-to-working-tree) would diff hundreds of unrelated commits against the implementer's actual change
tags:
  - agent-coordination
  - review-intake
  - diff-scope
  - supersession
  - architect-protocol
  - ce-code-review
  - stale-task
related_components:
  - documentation
---

# Stale review/ intake: verify spec against HEAD when implementer's diff is heavily displaced

## Context

The architect mandate in `agents/architect/CLAUDE.md` requires `/ce-code-review` on every `tasks/review/` file's implementer diff before archiving: *"A manual read-through is not a substitute."* That mandate assumes the implementer's diff is at or near HEAD. The skill's fast-path scope (`base:$BASE` → `git diff $BASE` against the working tree) is built for "review the work just landed," not "review work that landed hundreds of commits ago."

When a task sits in `review/` long enough that hundreds of intervening commits land on main, the fast-path scope no longer expresses "just the implementer's diff" — it expresses "the implementer's diff plus everything since," which drowns the implementer's actual change in unrelated noise. Forcing the scope by checking out the implementer's commit on the main worktree is more disruptive than informative when the implementation has already been displaced by subsequent commits.

This is a first-time-review-intake variant of the supersession pattern documented in [`re-review-intake-supersession-check-2026-05-05.md`](./re-review-intake-supersession-check-2026-05-05.md). The re-review variant concerns hold-fix SHAs that pass the orphan-SHA check but have been overtaken between rounds. This variant concerns implementer SHAs that have aged past the point where `/ce-code-review`'s standard scope works at all, and adds a new decision axis: whether the spec's acceptance criteria are still met at HEAD via different means than the implementer's diff implemented.

## Guidance

At review/ intake, before invoking `/ce-code-review`:

1. **Count intervening commits.** `git rev-list --count <implementer-sha>..HEAD`. If trivial (under ~10), proceed with `/ce-code-review base:<implementer-sha>^` — fast-path scope is approximately the implementer's diff.

2. **If non-trivial (≥10, definitively ≥100), run the supersession check** from [`re-review-intake-supersession-check-2026-05-05.md`](./re-review-intake-supersession-check-2026-05-05.md):

   ```bash
   SCOPE=$(git diff --name-only <implementer-sha>~1 <implementer-sha>)
   git log --oneline <implementer-sha>..HEAD -- $SCOPE
   ```

3. **Classify by spec-fate, not just by file-fate.** The supersession doc's classification table covers file-level outcomes (Modified / Decommissioned / Mixed). For first-time review intake, layer a spec-level question on top: is the task spec still satisfied at HEAD?

   | HEAD vs task spec | Action |
   |---|---|
   | Implementer's exact implementation survives at HEAD (modified only superficially) | Standard `/ce-code-review base:<implementer-sha>^`; archive on clean. |
   | Implementer's implementation has been REDESIGNED but the spec's acceptance criteria are met at HEAD via an alternate shape the spec explicitly allowed (e.g., spec said "either X or Y," HEAD has Y) | Skip `/ce-code-review` on the original SHA — the code under review is gone. Verify acceptance criteria against HEAD directly. Archive clean with archive entry naming the displacing commit. |
   | Implementer's implementation has been REDESIGNED in a way the spec did NOT contemplate AND the spec is not satisfied at HEAD | Append a hold block describing the gap; `git mv` back to `tasks/pending/`. New work, new implementer cycle. |
   | Implementer's implementation has been DECOMMISSIONED (files deleted) AND the spec's acceptance criteria are unmet at HEAD | Either re-file the task or archive with explicit note of regression, depending on whether the decommission was deliberate. |

4. **Document the call in the archive entry.** Whichever branch fires, the archive entry must name the displacing commit (or commits) and explain why `/ce-code-review` was or was not invoked. The architect mandate is bypassable in the displaced-commit case ONLY because the displacement itself is documented evidence at HEAD (the displacing commit, the file docstring it added, the spec's alternate-shape clause). Bypass without that evidence trail is a silent skip, not a deliberate call.

## Why This Matters

The architect mandate exists to prevent silent manual-review drift. The heavily-displaced-commit case is the one edge where forcing the mandate's mechanism (running `/ce-code-review` on a synthetic scope) produces worse review than the alternative (verifying spec against HEAD). Distinguishing the two cases matters:

- **Skipping `/ce-code-review` without justification** silently breaks the mandate and lets bad implementer commits archive unreviewed.
- **Forcing `/ce-code-review` on a heavily-displaced diff** burns reviewer subagents on code that no longer exists at HEAD (same cost profile flagged in `re-review-intake-supersession-check-2026-05-05.md`).
- **Verifying spec against HEAD** is correct ONLY when there's evidence the HEAD state was reached deliberately: a downstream commit with a clear rationale, a file docstring documenting the design decision, or an explicit replacement task. Without that evidence, default back to filing a hold block.

The spec's structure determines which branch fires. Permissive language ("either X or Y", "the appropriate CTAs", "a clear panel listing the valid paths") lets HEAD satisfy the spec via an alternate shape the implementer didn't pick. Prescriptive language ("implement a red accreditation banner") makes HEAD's divergence from the implementer's approach a spec contradiction that needs explicit triage.

PEvO's "err on the side of forcing the mandate" instinct is right when implementer SHAs are recent; the cost of the mechanical review is low and catches real regressions. The instinct inverts when implementer SHAs are months old — the displaced implementation has already been replaced by reality, and reality is what the spec needs to be checked against.

## When to Apply

- Architect first-time review intake on any `tasks/review/` task whose implementer commit is non-trivially behind HEAD (≥10 commits, definitively when ≥100).
- When `git log --oneline <implementer-sha>..HEAD -- <scope-files>` shows substantial activity in the implementer's diff scope.
- When a file touched by the implementer's commit has a docstring at HEAD documenting a design decision that postdates and contradicts the implementer's approach.

Skip when:

- The implementer's commit is HEAD or near-HEAD (standard fast-path scope already works).
- Intervening commits are all in unrelated files (supersession check returns empty).
- This is a re-review intake on a hold-fix SHA — use `re-review-intake-supersession-check-2026-05-05.md` instead.

## Examples

### Canonical instance: ui-gating-coherence-publish-review-edit (archived 2026-05-15)

Task filed 2026-04-28, asking the UI agent to bring `review.js` and `edit.js` into coherence with `publish.js`'s "banner + still-render-form" pattern for connected+unaccredited users. Acceptance criterion #2 explicitly allowed two shapes for `edit.js`: either *"banner+disabled-form (matching `publish.js`)"* or *"a clear 'you need to be accredited / be a co-author / file a claim' panel with the appropriate CTAs."*

Implementer commit `de1c205` (same day) implemented the first shape across all three pages. The task moved to `tasks/review/` and sat there for 17 days.

By 2026-05-15, 587 commits had intervened. Downstream commit `5d44f23` ("ui: native-edit own post in chain instead of new continuation per edit") had rewritten `edit.js` (343-line diff), removing the accreditation banner and replacing it with a "Who can edit this paper?" panel listing original-author / co-author / claim paths. The change was deliberate: `edit.js:16-20` now carries a docstring justifying the redesign — *"Accreditation is NOT the gate on this page... getting accredited does not unblock editing."*

Intake decision trace:

- `git rev-list --count de1c205..HEAD` = 587. Definitively non-trivial.
- Supersession check: `edit.js` modified (343 lines), `publish.js` modified (65 lines), `review.js` untouched since `de1c205`, `accreditation-banner.js` untouched.
- HEAD's `edit.js` shape (panel with three valid paths and CTAs) matches acceptance criterion #2's alternate clause exactly.
- Decision: skip `/ce-code-review` on `de1c205`. Verify spec at HEAD. Archive clean (commit `bc6e359`); archive entry names `5d44f23` as the displacing commit and explains why the mandate was not mechanically applied.

### Counter-example: spec contradiction at HEAD

If the same task had had a prescriptive spec ("implement a red accreditation banner on edit.js") and `5d44f23` had removed that banner, the correct response would be a hold block on the task: *"HEAD's edit.js no longer carries the banner the spec asked for; either reopen the spec to allow the new shape or restore the banner."* The displacement is real; whether it's compatible with the spec depends on the spec's language.

### Counter-example: small intervening churn

A task in `review/` for one week with ~20 commits intervening, none touching the implementer's scope files. Supersession check returns empty. The intake counter is non-trivial but the scope check is clean. Standard `/ce-code-review base:<implementer-sha>^` proceeds; the fast-path scope still expresses the implementer's diff approximately (the extra ~20 commits diff against unrelated files and produce no reviewer noise).

## Related

- **Sibling — re-review variant of the same meta-pattern:** [`re-review-intake-supersession-check-2026-05-05.md`](./re-review-intake-supersession-check-2026-05-05.md). Hold-fix SHA is on main but main has moved past during the round. This convention is the first-time-review variant; the supersession check itself is shared.
- **Reachability and content-match dimensions of SHA trust:** [`worktree-fanout-orphan-detection-2026-04-29.md`](./worktree-fanout-orphan-detection-2026-04-29.md), [`implementer-self-verify-signal-block-sha-2026-05-04.md`](./implementer-self-verify-signal-block-sha-2026-05-04.md).
- **Cross-task hold-block staleness — adjacent meta-pattern:** [`cross-task-hold-block-staleness-2026-04-22.md`](./cross-task-hold-block-staleness-2026-04-22.md). Premises going stale because parallel tasks modified cited cross-references.
- **Enclosing protocols:** `agents/architect/CLAUDE.md` (MANDATORY `/ce-code-review` invocation rule), root `CLAUDE.md` rule #7 (review → archive) and rule #8 (review → held-pending-fixes → re-review).

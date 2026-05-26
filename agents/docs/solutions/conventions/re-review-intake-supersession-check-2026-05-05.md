---
title: Architect re-review intake checks diff-scope supersession after orphan-SHA detection
date: 2026-05-05
category: conventions
module: agent-coordination
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - Architect re-review intake on a `tasks/review/` task whose hold-fix commit SHA is more than ~1 commit old on main
  - Originating task's hold cycle filed sibling tasks (especially structural-follow-ups) during the round being reviewed
  - Sibling tasks have known-completed signal blocks that overlap the diff scope
  - Re-reviewing round-N hold fixes when round-N+1 follow-ups have already merged
  - Investigating a review pass where a majority of findings target paths that no longer exist at HEAD
symptoms:
  - Reviewer findings cite file paths that do not exist at HEAD
  - Hold-block fixes look correct against their own diff but moot when reconciled against current main
  - 6-of-7 or similar majority of dispatched-reviewer findings collapse to "file decommissioned, finding moot" at triage
  - SHA passes `git merge-base --is-ancestor <claimed-sha> main` but a subsequent commit on main has decommissioned files in the SHA's diff scope
tags:
  - agent-coordination
  - git-workflow
  - re-review
  - architect-protocol
  - signal-block
  - diff-scope
  - supersession
  - audit
related_components:
  - tooling
  - documentation
---

# Architect re-review intake checks diff-scope supersession after orphan-SHA detection

## Context

The architect's existing orphan-SHA check (`worktree-fanout-orphan-detection-2026-04-29.md`) catches one re-review intake failure mode: a signal block citing a commit that was committed only on a reaped worktree branch and never replayed onto main. `git merge-base --is-ancestor <claimed-sha> main` returns false and the architect rejects the signal before dispatching reviewers.

That check is necessary but not sufficient. A SHA can pass the ancestor check (it IS on main) yet still be an unsafe target for reviewer dispatch, because a SUBSEQUENT commit on main has modified or decommissioned files inside the SHA's diff scope. The reviewer fans out against the SHA's diff, but findings against now-deleted or now-rewritten files are moot at HEAD. This is a sibling failure mode at the diff-scope level, not the branch level, and it has its own one-line check at intake.

The PEvO architect intake series now has three SHA-trust dimensions:

1. **Reachability** — is the SHA on main? (`worktree-fanout-orphan-detection-2026-04-29.md`)
2. **Content match** — does the SHA actually carry the work the signal block describes? (`implementer-self-verify-signal-block-sha-2026-05-04.md`, implementer-side prevention)
3. **Supersession** — have subsequent commits modified or deleted the files this SHA touched? (this convention)

Reachability and content match are point-in-time properties checkable at signal-block-write time. Supersession is inherently architect-only because it concerns commits authored AFTER the signal block was written.

## Guidance

At every architect re-review intake, run BOTH ancestor and supersession checks before dispatching reviewers:

```bash
CLAIMED=<claimed-sha>

# Check 1 (existing): orphan-SHA detection
git merge-base --is-ancestor "$CLAIMED" main || { echo "ORPHAN — reject signal"; exit 1; }

# Check 2 (new): upstream supersession of diff scope
SCOPE=$(git diff --name-only "$CLAIMED~1" "$CLAIMED")
SUPERSEDED=$(git log --oneline "$CLAIMED..HEAD" -- $SCOPE)
if [ -n "$SUPERSEDED" ]; then
  echo "SUPERSEDED — main has moved past the diff scope:"
  echo "$SUPERSEDED"
  echo "Decommissioned files in scope:"
  git log --diff-filter=D --name-only --pretty=format: "$CLAIMED..HEAD" -- $SCOPE | sort -u
  echo "Modified files in scope:"
  git log --diff-filter=M --name-only --pretty=format: "$CLAIMED..HEAD" -- $SCOPE | sort -u
fi
```

If `SUPERSEDED` is non-empty, classify each superseding commit's effect on the original diff scope and pick a branch:

| Branch | Detection | Default action |
|--------|-----------|----------------|
| Clean | `SUPERSEDED` is empty | Standard re-review against `$CLAIMED~1..$CLAIMED` |
| Modified only | All superseding commits are `--diff-filter=M` | Re-review against `$CLAIMED~1..$CLAIMED`; flag in dispatch prompt that reviewers should propose fixes against HEAD, not the cited SHA |
| Decommissioned (partial) | Some `--diff-filter=D`, some files survive | Re-review scoped to surviving files only via explicit allowlist |
| Decommissioned (full structural replacement) | All scope files deleted by a single follow-up commit whose purpose replaces the SHA's mechanism | Skip re-review of `$CLAIMED`; review the replacement task's own SHA instead |
| Mixed M+D | Both kinds of supersession | Inspect each superseding commit individually before deciding scope |

Do NOT silently merge "modified" and "decommissioned" branches. They have different cost profiles: modified files still benefit from review (deduplicate findings against HEAD); decommissioned files almost never do (the code under review is gone).

## Why This Matters

The cost is real and concrete. Each reviewer subagent dispatched in a `/ce-code-review` fan-out reads the diff, reasons about it, and produces findings. Per-reviewer cost is on the order of tens of thousands to low-hundreds-of-thousands of tokens depending on diff size; a 7-reviewer fan-out against a moot diff burns ~7 reviewer-dispatches' worth of tokens, multiple minutes of orchestrator wall-clock time, and orchestrator-context-window pressure that compounds into the rest of the architect session. Then the user gets a frame-correction message ("these findings are against decommissioned files") and the architect repeats the dispatch against a corrected scope or skips it entirely.

PEvO accepts the high token cost of compound-engineering reviews as a deliberate tradeoff (memory: `feedback_compound_engineering_tokens.md`). That tolerance does NOT extend to spending tokens on review of code that no longer exists at HEAD. The carve-out is for thoroughness, not for unrecoverable misdirection.

The structural reason this hits PEvO specifically:

- Root `CLAUDE.md` rule #8 encourages multi-round hold cycles where each architect re-review can produce findings + structural follow-ups. The follow-up is filed as a NEW task, not bundled into the current task's diff.
- When an implementer fast-tracks a structural follow-up, its commit can land on main BEFORE the architect picks up the originating task's re-review.
- If the follow-up's mechanism replaces the originating task's mechanism (e.g., an AST-based ESLint rule replacing a bash META-defense script), the follow-up's commit decommissions files that are still in the originating task's diff scope.
- Without the supersession check, the architect dispatches reviewers against a diff whose files are gone at HEAD.

This pattern will recur. The bridge-paper / discipline-guard pair is one instance; any structural-follow-up cycle has the same shape.

## When to Apply

- At every architect re-review intake, after the orphan-SHA ancestor check, before reviewer dispatch.
- When the cited SHA is more than ~1 commit old on main (i.e., `git rev-list --count <claimed-sha>..HEAD` is non-trivial).
- When the originating task's hold cycle filed sibling tasks (especially structural-follow-ups) during the round being reviewed.
- When sibling tasks have known-completed signal blocks (file `git mv`'d to `tasks/review/` or already archived) and the architect has not yet processed the originating task.
- Whenever a worktree fan-out's worker subagents committed in parallel and any worker's branch may have touched files overlapping another worker's diff scope.

Skip only when the cited SHA is HEAD (`git rev-parse HEAD == <claimed-sha>`) — by definition no superseding commits exist.

## Examples

### Canonical instance: bridge-paper-author-gate / discipline-guard-pipeline-integration

Round-4 hold on `backend-bridge-paper-author-gate.md`:

- Hold-block fixes landed at `b8bcc40` (135-line diff across 4 files: `backend/scripts/check-bridge-paper-discipline.sh`, `backend/tests/scripts/check-bridge-paper-discipline.test.ts`, `backend/tests/routes/bridge-paper-author-gate.test.ts`, `backend/tests/helpers.test.ts`).
- The same round-4 hold-block also filed `backend-discipline-guard-pipeline-integration.md` as a structural follow-up to replace the bash META-defense with an AST-based ESLint rule.
- The implementer fast-tracked the follow-up. Commit `9bb8fec` landed on main, decommissioning both `backend/scripts/check-bridge-paper-discipline.sh` and `backend/tests/scripts/check-bridge-paper-discipline.test.ts`.
- The architect picked up the `b8bcc40` re-review AFTER `9bb8fec` was on main.

#### Before (orphan-only intake)

```bash
# Architect re-review intake for backend-bridge-paper-author-gate
CLAIMED=b8bcc40
git merge-base --is-ancestor "$CLAIMED" main && echo OK
# OK — proceed with reviewer dispatch
# /ce-code-review b8bcc40~1..b8bcc40
# 7 reviewers dispatched in parallel
# 6 of 7 surface findings against backend/scripts/check-bridge-paper-discipline.sh
#   and backend/tests/scripts/check-bridge-paper-discipline.test.ts
# Both files DECOMMISSIONED at HEAD by 9bb8fec
# All findings moot. ~7 reviewer-dispatches wasted.
```

#### After (orphan + supersession-check intake)

```bash
CLAIMED=b8bcc40

# Check 1: orphan
git merge-base --is-ancestor "$CLAIMED" main || { echo "ORPHAN — reject"; exit 1; }

# Check 2: supersession of diff scope
SCOPE=$(git diff --name-only "$CLAIMED~1" "$CLAIMED")
SUPERSEDED=$(git log --oneline "$CLAIMED..HEAD" -- $SCOPE)
if [ -n "$SUPERSEDED" ]; then
  echo "SUPERSEDED — main has moved past the diff scope:"
  echo "$SUPERSEDED"
  # 9bb8fec backend: BE-DISCIPLINE-GUARD-PIPELINE-INTEGRATION ESLint rule + decommission bash
  echo "Decommissioned files in scope:"
  git log --diff-filter=D --name-only --pretty=format: "$CLAIMED..HEAD" -- $SCOPE | sort -u
  # backend/scripts/check-bridge-paper-discipline.sh
  # backend/tests/scripts/check-bridge-paper-discipline.test.ts
fi
```

Architect interprets: 2 of 4 files in scope are decommissioned at HEAD; the superseding commit `9bb8fec` is the structural follow-up that replaces the mechanism end-to-end. Decision: skip the reviewer dispatch entirely. The discipline-guard ESLint rule is what's live at HEAD; review THAT mechanism via the `backend-discipline-guard-pipeline-integration` task's own re-review intake, not via the obsolete bash-script diff.

### Modified-only branch example

A SHA touches `backend/src/routes/auth.ts` lines 200-280 (a refactor of the password reset path). After landing, two subsequent commits also modify `auth.ts` for unrelated reasons (e.g., a separate logging-shape task, a typo fix). All three commits modify but none decommission. Re-review proceeds against `$CLAIMED~1..$CLAIMED`, with a flag in the dispatch prompt: "reviewers proposing concrete fixes should diff against HEAD, not the cited SHA, to avoid recommending changes that have already landed in subsequent commits."

## Related

- **Sibling — same intake checkpoint, different SHA-trust dimension:** [`worktree-fanout-orphan-detection-2026-04-29.md`](./worktree-fanout-orphan-detection-2026-04-29.md). Run that check first (cheaper, branch-level), this check second (slightly more expensive, file-level). Both must pass before fanning out reviewers.
- **Implementer-side prevention layer:** [`implementer-self-verify-signal-block-sha-2026-05-04.md`](./implementer-self-verify-signal-block-sha-2026-05-04.md). Covers SHA reachability and content match at signal-block-write time. The supersession axis is inherently architect-only because it concerns commits authored AFTER the signal block was written.
- **See also — symmetric staleness-between-rounds pattern on a different artifact:** [`cross-task-hold-block-staleness-2026-04-22.md`](./cross-task-hold-block-staleness-2026-04-22.md). Hold-block premises going stale because parallel tasks modified cited cross-file references, vs. signal-block premises going stale because parallel commits decommissioned cited diff scope. Same meta-pattern, different artifact.
- **Relocation variant (next checkpoint after this one):** [`re-review-cluster-path-restricted-union-diff-not-per-commit-2026-05-26.md`](./re-review-cluster-path-restricted-union-diff-not-per-commit-2026-05-26.md). When supersession passes (files survive at HEAD) but a later cluster commit *relocated* the earlier scope into a shared module, per-commit granularity is still wrong — review the coupled cluster as one path-restricted union diff. The decision table above has no "relocated" branch; that entry fills the gap.
- **Enclosing protocol:** root `CLAUDE.md` rule #8 (Review → held-pending-fixes → re-review cycle).

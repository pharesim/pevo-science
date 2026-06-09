---
title: "A review finding citing an untracked or uncommitted sibling file is scope noise, not ground truth"
date: 2026-06-09
category: conventions
module: agent-coordination
problem_type: convention
component: code-review
severity: medium
applies_when:
  - "Architect triaging /ce-code-review findings at tasks/review/ intake in PEvO's permanently-multi-agent checkout"
  - "A persona finding asserts a file or coverage 'already exists', or that a committed comment or claim is 'now stale'"
  - "The cited artifact does not appear in the reviewed commit's own diff"
  - "A high-confidence finding is premised on working-tree state while sibling agents hold untracked or uncommitted in-flight files"
tags:
  - code-review
  - multi-agent
  - re-review-intake
  - untracked-files
  - sibling-contamination
  - review-triage
  - working-tree-scope
---

# A review finding citing an untracked or uncommitted sibling file is scope noise, not ground truth

## Context

PEvO runs architect, backend, and ui agents (plus parallel sessions of each) concurrently against a single
`.git`. At any moment the working tree holds untracked or uncommitted in-flight files from sibling agents.
The architect reviews each `tasks/review/` item by invoking `/ce-code-review` on the implementer's commit
before archiving — and `/ce-code-review` persona reviewers read the working tree (HEAD plus uncommitted
plus untracked) for context, not just the commit's diff.

During a round-3 review of `ui-settings-action-fresh-auth-proof-challenge` (commit `27f55b26`), the diff
contained only a comment-only fix: a test-header docblock corrected to say the ORCID-factor settings path
"has NO end-to-end companion yet." The `/ce-code-review` testing persona returned a CONFIDENCE-100 finding:
"still inaccurate — `frontend/tests/e2e/settings-orcid-factor.spec.js` EXISTS and drives that path." Two
other personas (project-standards, maintainability) had independently cleared the same comment as accurate.
A `git status --short` settled it: the spec was listed `??` (untracked), created during the same session by
a sibling UI agent concurrently implementing the `ui-settings-orcid-factor-e2e` follow-up. The spec was not
in commit `27f55b26`, was not committed, and did not exist when the reviewed comment was written. The
committed comment was accurate relative to committed state. (The sibling later committed the spec as
`c5cda7d6` and moved its own task into `review/` mid-session, confirming the concurrency.)

## Guidance

Before acting on any `/ce-code-review` finding whose validity depends on a file's existence or absence — or
on a claim that "coverage already exists" or "this comment is now stale" — verify that the cited artifact is
tracked, committed, and within the reviewed commit's scope. Three commands gate the check:

**1. Is the file even tracked?**
```bash
git status --short <cited-file>
```
`??` means untracked (a sibling's in-flight work); ` M` / `M ` means modified-but-uncommitted. Either state
means the finding is anchored on out-of-scope working-tree state, not on reviewed state.

**2. Has the file ever been committed?**
```bash
git log --oneline -- <cited-file>
```
An empty result means the file has no commit history at all — it is purely a working-tree artifact and has
no standing as "existing" in any reviewed state.

**3. Is the file in this specific commit's diff?**
```bash
git show --stat <reviewed-commit>          # does the path appear?
git log <reviewed-commit> -- <cited-file>  # is it touched by this commit?
```
If the cited artifact does not appear in the reviewed commit's stat, the persona's finding is importing
sibling scope into the task under review.

An untracked or uncommitted cited artifact is sibling-contamination scope noise, not ground truth. Discount
the finding, or re-scope it as a heads-up that a sibling task will reconcile the artifact later once it
lands. Do NOT re-hold the clean task on it. Reconciling the comment once the sibling's work commits is the
sibling follow-up task's responsibility, not the reviewed task's.

**Upstream mitigation does not eliminate the risk.** Scoping each `/ce-code-review` to a single historical
commit via `git show <sha>` and telling reviewers to ignore unrelated uncommitted changes reduces
contamination, but a persona can still READ an untracked file it stumbles on while gathering context. The
intake-triage verification above is the necessary backstop regardless of how the review is invoked.

## Why This Matters

A confident persona finding trusted at face value would have caused the architect to wrongly re-hold a clean
task — sending the implementer to "fix" a comment that is correct relative to committed state, chasing a
moving target (the sibling's not-yet-committed work). In a permanently-multi-agent checkout the working tree
is never a stable snapshot; it reflects the union of every in-flight sibling session. A review finding that
treats the working tree as ground truth silently imports sibling state and produces false positives that
block accurate, committed work. The damage compounds when the sibling's work is itself later submitted for
review, because the two tasks then carry holds that reference each other's not-yet-landed scope.

This is the architect's READ-SIDE, review-intake complement to the implementer's WRITE-SIDE search
discipline in [[coverage-claim-downgrade-requires-codebase-search]]: that one says "search the codebase
before negating a coverage claim you are editing"; this one says "verify the cited artifact is in the
reviewed diff before acting on a finding that asserts it exists." It is also the working-tree analog of the
commit-time index-contamination hazards in the shared-checkout family ([[concurrent-agent-staging-sweep]]):
the same "a sibling's in-flight work contaminates my current operation" meta-pattern, applied to a review
finding rather than a commit's staged set.

## When to Apply

At every `/ce-code-review` triage step in the multi-agent checkout, whenever a finding asserts any of the
following about an artifact that does NOT appear in the reviewed commit's diff:

- "X already exists" / "the file is present"
- "this comment/claim is now stale" / "no longer accurate"
- "coverage is already there" / "this path is already tested"
- "this code has already been implemented elsewhere"

Run the three-command gate before deciding whether to hold, dismiss, or re-scope the finding. The check is
cheap; a wrongful re-hold costs an implementer round-trip plus a self-cancelling cross-task hold.

Do NOT over-apply: a finding scoped entirely within the reviewed commit's own diff (e.g., the commit adds a
second call site that makes its own docblock stale) is legitimate — hold it. The gate only fires when the
finding's evidence lives OUTSIDE the reviewed diff.

## Examples

**False-positive finding (do NOT re-hold).** Reviewed commit `27f55b26` contains only a docblock edit
stating the ORCID-factor settings path "has NO end-to-end companion yet." Testing persona, CONFIDENCE-100:
"`frontend/tests/e2e/settings-orcid-factor.spec.js` EXISTS and covers this path — the comment is inaccurate."

```bash
git status --short frontend/tests/e2e/settings-orcid-factor.spec.js
# => ?? frontend/tests/e2e/settings-orcid-factor.spec.js   (untracked)
git log --oneline -- frontend/tests/e2e/settings-orcid-factor.spec.js
# => (empty — never committed)
git show --stat 27f55b26 | grep settings-orcid-factor
# => (nothing — not in this commit's diff)
```
All three confirm a sibling's untracked in-flight file. Discount the finding, archive the clean task, and
note in chat that the sibling's `ui-settings-orcid-factor-e2e` task will reconcile the comment when it lands.

**Legitimate stale-comment finding (act on it).** Reviewed commit contains a docblock claiming a helper "is
only called from the signup route", and `git show --stat <reviewed-commit>` includes a second file in the
SAME commit that adds a second call site. The evidence is inside the reviewed diff; the comment is genuinely
stale. Hold the task and have the implementer update the docblock.

## Related

- [[re-review-intake-supersession-check]] — the nearest sibling: a reviewed SHA whose scope was modified or
  decommissioned by SUBSEQUENT commits. That is the "work landed after" axis; this is the "work has not
  landed at all (untracked sibling)" axis. Together with reachability they form the intake-trust chain.
- [[worktree-fanout-orphan-detection]] — the reachability gate (`git merge-base --is-ancestor`): is the
  cited SHA even on main? First link in the same intake-trust chain.
- [[re-review-cluster-path-restricted-union-diff-not-per-commit]] — the other working-tree-vs-diff mismatch:
  there, a later cluster commit RELOCATED code so the reviewer finds it "missing"; here, an untracked sibling
  file makes the reviewer find something "present." Same root (personas trust the working tree over the diff),
  inverted symptom.
- [[coverage-claim-downgrade-requires-codebase-search]] — the implementer write-side complement on the same
  clause-c artifact: search before negating a coverage claim you are editing.
- [[stale-review-intake-verify-spec-at-head]] — adjacent intake discipline: verify a spec against HEAD/git
  reality rather than trusting a coordination artifact at face value.
- [[concurrent-agent-staging-sweep]] — the commit-time variant of the same "sibling in-flight work
  contaminates my operation" hazard (the index instead of a review finding).

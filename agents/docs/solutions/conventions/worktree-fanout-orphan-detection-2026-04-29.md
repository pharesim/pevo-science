---
title: Verify task-signal-block commit SHAs are reachable from main before trusting "landed" claims
date: 2026-04-29
category: conventions
module: agent-coordination
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - Reviewing a task file in `agents/docs/tasks/review/` whose signal block claims a specific commit SHA landed
  - Building a doc-only fix or follow-up commit on top of work that a prior round's signal block declared merged
  - Encountering a hold-block re-review whose surfaced findings only make sense if a predicate migration is on main
  - Cleaning up `worktree-agent-*` branches after a fan-out
  - Investigating drift between a task file's stated state and what `git log main -- <file>` actually shows
tags:
  - agent-coordination
  - git-workflow
  - worktree
  - audit
  - task-coordination
related_components:
  - tooling
  - documentation
---

## Context

PEvO uses worktree fan-outs (per root `CLAUDE.md` "Worktree Cleanup") to parallelize implementation across worker subagents. Each worker commits to its own `worktree-agent-<id>` branch; the parent agent is supposed to merge those commits back into the orchestrating branch (typically `main`). Task signal blocks in `agents/docs/tasks/<dir>/<task>.md` document what landed at which SHA, with verification stamps (`tsc --noEmit`: clean / vitest: N passed / etc.).

Cluster B re-review on 2026-04-29 surfaced a workflow failure mode: **commits referenced by signal blocks lived only on the worker's `worktree-agent-*` branch and were never merged into `main`**. The worker correctly committed, the signal block correctly cited the SHA and verification, but the merge step was missed. The task file looked complete; the orphan SHA still resolves; `git log <sha>` shows the expected diff. The only durable evidence of the failure is `git merge-base --is-ancestor <sha> main` returning false.

Three commits in this cluster were affected: `ada6814` (round-3 isArgonSemaphoreError migration), `c4d988e` (test-mocks migration on 2 pre-existing files), `9a811b9` (a follow-up merge-of-orphan that itself never reached main). The architect re-review caught the divergence by chance — a downstream "doc-only fix" (commit `647a115`'s round-4 of `backend-argon2-error-handler-extract`) updated comments to reference `isArgonSemaphoreError`, but on main the code still used raw `instanceof` (because `ada6814` was orphaned). The fresh drift exposed the underlying work-loss; without that chance trigger, the next implementer to touch the surface would have shipped silently broken work.

## Guidance

When a task signal block claims a commit SHA landed, verify reachability before building on the claim:

```bash
# 5-second check — substitute the SHA from the signal block
git merge-base --is-ancestor <claimed-sha> main && echo "ON MAIN" || echo "ORPHANED"
```

If the SHA is not on main, locate the orphan branch:

```bash
git branch --contains <claimed-sha>
# Output like:  worktree-agent-a06fcd6a935d47929
```

Treat the task's "landed" claim as **unverified** and surface the divergence in the next architect re-review pass. Two recovery paths:

- **Replay (preferred):** cherry-pick the orphan SHA(s) onto main. Watch for downstream-API drift between the orphan's authoring time and the current main HEAD (in cluster B, the test-mocks migration was authored when `assertArgon2AbortIsSilent` was 1-arg; main HEAD had widened it to 2-arg, so the cherry-pick produced 3 type-error call sites that needed a follow-up fix).
- **Re-implement on main:** apply the same logical change directly without cherry-picking, abandoning the orphan SHA. Cleaner history at the cost of losing the worker's verification context.

When applying a doc-only fix that updates comments/JSDoc to reference a prior commit's claimed migration, **verify the migration is actually on main**, not the signal block's claim. Doc updates against a code state that doesn't exist produce fresh drift instead of removing it.

## Why This Matters

- **Task signal blocks actively misdirect.** The signal block is the implementer's post-fix attestation; reading it without verification creates a strong "work landed" prior. A future agent has no nudge to spot-check.
- **Build-on-top tasks ship silently broken work.** The cluster B trigger was a downstream commit (`647a115`'s round-4 doc fix) authored against a false code-state premise. The breakage was scoped to comments, but the same shape applies to any follow-up commit that depends on a predicate migration: tests assuming a refactored helper signature, route handlers calling a renamed function, type guards using a not-yet-imported symbol.
- **The audit cost is asymmetric.** A 5-second `git merge-base --is-ancestor` check at re-review intake catches the failure before any downstream commit is authored. A post-hoc catch (after drift has shipped) requires replay + downstream-API reconciliation + a recovery commit chain — in cluster B, three commits to repair (replay × 2 + post-replay fix).
- **Worktree cleanup convention covers a different failure.** Root `CLAUDE.md` "Worktree Cleanup" addresses stale-pid lock files preventing `git worktree remove`. Work-loss detection (orphan SHAs that the parent never merged) is a separate axis.

## When to Apply

- Architect intake of any `tasks/review/` file: scan signal blocks for cited commit SHAs and verify reachability before reviewing the diff.
- Backend/UI/pinner re-review after a hold block lands: the implementer's "Backend re-review signal" (or equivalent) cites the fix commit; verify it's on main before re-running `/ce-code-review`.
- Doc-only fixes that touch comments/JSDoc tied to a refactor: verify the refactor's commit is on main before authoring the doc edit.
- Cherry-pick recovery: after replaying an orphan SHA, run targeted vitest on the affected surface — orphan-period API drift may produce type errors or runtime failures the orphan's verification stamp couldn't have caught (it predated the drift).

## Examples

### Detection at re-review intake

```bash
# Reading agents/docs/tasks/review/backend-argon2-error-handler-extract.md
# Round-3 backend signal cites: "Item 1 — migrate 4 raw `instanceof` sites... commit ada6814"

git merge-base --is-ancestor ada6814 main && echo "ON MAIN" || echo "ORPHANED"
# ORPHANED

git branch --contains ada6814
# + worktree-agent-a06fcd6a935d47929

# At this point: do NOT proceed with the round-4 review against main as if the
# round-3 work landed. Either replay the orphan or treat round-3 as
# not-yet-reviewed.
```

### The downstream-drift recovery shape (cluster B replay)

```bash
# Orphan A (no API drift): clean cherry-pick.
git cherry-pick ada6814
# [main 718b7ed] ... migrate 4 raw instanceof sites to isArgonSemaphoreError
# 2 files changed

# Orphan B (with API drift on main HEAD): cherry-pick succeeds patch-wise but
# produces runtime errors because main's helper signature widened during the
# orphan's lifetime.
git cherry-pick c4d988e
# [main cfd5a73] ... test-mocks-migrate-pre-existing
# 2 files changed

npx vitest run tests/routes/auth-reset-request-shutdown.test.ts \
              tests/routes/auth-signup-dup-saturated.test.ts
# 3 tests fail: assertArgon2AbortIsSilent now requires 2 args (1-arg callers
# from the orphan break against main's 2-arg helper).

# Recovery: update the 3 call sites to the current API.
# Commit the fix as a separate "post-replay" commit so the cherry-pick
# preserves orphan provenance and the follow-up captures the API-drift
# reconciliation.
```

### Trusting the signal block, with verification

When the orphan-detection check passes, the signal block is reliable and the re-review can proceed normally:

```bash
git merge-base --is-ancestor <signal-block-sha> main && echo "ON MAIN"
# ON MAIN
# → Signal block verified. Proceed with /ce-code-review on the diff.
```

## Related conventions

- `agents/docs/solutions/conventions/implementer-self-verify-signal-block-sha-2026-05-04.md` — companion convention covering the implementer's PREVENTION layer (self-verify SHA reachability + commit-content match BEFORE submitting the signal block). This convention covers the architect's RECOVERY layer (detect + replay when the implementer-side check was missed). The two layers are complementary; the implementer-side check is the cheap-prevention point and reduces how often this convention's recovery dance fires.
- Root `CLAUDE.md` "Worktree Cleanup" — covers stale-pid lock files; this convention covers the orthogonal work-loss axis.
- Root `CLAUDE.md` "Commits and Pushes" — "Before a worktree fan-out, the parent agent MUST commit in-flight work" prevents one class of orphan (parent's drift), this convention catches the residual class (worker's commits not merged back).
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — orthogonal: that convention catches mutation-style regressions in tested code; this one catches workflow-style "claimed-but-not-landed" drift in coordination artifacts.

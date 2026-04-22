---
title: Cross-task hold-block staleness — a hold block correct at authorship can go stale before round-2 application if parallel work lands between rounds
date: 2026-04-22
category: conventions
module: agents/docs/tasks
problem_type: convention
component: agent_coordination
severity: medium
applies_when:
  - Authoring a hold block that cites cross-file call sites the implementer does not own
  - Picking up a held-pending-fixes task that cites specific consumers, call sites, or code references
  - A held task touches code that a parallel task is also actively modifying
  - Cross-domain hold blocks (backend-task citing FE consumers, or vice versa)
tags:
  - agent-coordination
  - hold-block
  - cross-task-staleness
  - frontend-backend-boundary
  - review-cycle
---

## Rule

When a hold block cites specific cross-file consumers, call sites, or code references the implementer does not own, the implementer MUST re-verify the cited sites at round-N+1 pickup. Hold-block premises are point-in-time snapshots; parallel work landing between rounds can invalidate them.

Architects: when authoring cross-file citations, date-stamp the premise (e.g., "verified 2026-04-21 at commit `abc1234`"). Makes staleness detection cheap at pickup.

## Why

`BE-DISCIPLINE-CANONICALIZE` round-1 hold item #2 was correct at authorship (2026-04-21): `paper-feed.js:17-18, 182` and `search.js:52-53, 252-257` did read `d.name`. The hold instructed backend to add a transient `name: display_name` shim.

Between rounds, a parallel task (`FE-PAPERS-BROWSE-DISCIPLINE-OPTION-HYDRATION-RACE`, commit `7961ac0` at 00:15) migrated those exact FE consumers to `canon_name`/`display_name`. The backend round-2 commit (`3d68ee6` at 00:27) applied the hold mechanically — adding a shim protecting consumers that no longer existed. The shim, its contract doc entry, and its test guard all asserted the shim was load-bearing.

Architect re-review (2026-04-22) caught it by grep: zero hits for `d.name` on discipline iterations anywhere in `frontend/src/`. Removing the shim becomes its own coordination problem — the code + contract + test all read as protective, so the future PR removing them must know the premise was already stale to proceed safely.

Not a backend implementer mistake (following a hold block is normal). Not an architect authorship mistake (premise was accurate when written). It's a **cross-task staleness** failure: two tasks touching the same surface, rounds completing out of sync, and nobody re-verifying the cross-file premise at application time.

## How to apply

**Implementer at hold-pickup:**

1. Read the hold block. Extract any cross-file / cross-domain references ("FE consumers at `X.js:17`", "contract at `orcid.md:128`", "test guard at `Y.test.ts:42`").
2. `grep` or read the cited files against current HEAD. Cheap — 30 seconds.
3. If state matches, proceed. If state has shifted: either (a) skip the hold item and flag in the re-review signal ("Hold #N premise no longer holds: consumer migrated in commit `<sha>` between rounds. Skipping; original concern addressed."), (b) reformulate if the underlying concern is still open in a new shape, or (c) `git mv` to `tasks/blocked/` with `[BLOCKED by Architect]` asking for disambiguation.
4. Record the verification outcome in the re-review signal explicitly.

**Architect when authoring cross-file citations:**

- Date-stamp the premise + include the commit hash you verified against. Format: "verified 2026-04-21T14:32 at `d6c2bb1^1`, `paper-feed.js:17-18` reads `d.name`."
- When 3+ held tasks touch overlapping file sets, maintain a short cross-task-touch matrix in your review notes so the staleness risk is visible.

## Related

- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — sibling from the same review pass. Teaches "verify your test would fail on revert." This doc teaches "verify your hold-block premise still holds on pickup." Same meta-pattern: cheap point-in-time verifications that break cascade failures.
- `agents/docs/solutions/conventions/verify-library-claims-before-load-bearing-security-margins-2026-04-22.md` — also from the same review pass. Grounds library-behavior claims; this doc grounds cross-file-state claims. Meta-pattern: any load-bearing claim needs grounding at the moment the fix ships.
- `agents/docs/solutions/conventions/hold-block-must-not-contradict-convention-docs-2026-04-22.md` — complementary failure mode: a hold block *wrong at authorship* by contradicting an existing convention doc. This doc covers hold blocks that go *stale between rounds*; the contradict-convention doc covers hold blocks that were wrong the moment they were written. Both fail the "verify load-bearing claims" meta-pattern but at different time points.
- Root `CLAUDE.md` rule #8 (Review → held-pending-fixes → re-review cycle) — the enclosing protocol. This convention names a failure mode within it.

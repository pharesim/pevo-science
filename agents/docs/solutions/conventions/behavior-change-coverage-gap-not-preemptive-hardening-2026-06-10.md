---
title: "Behavior-change coverage gaps are reportable: the preemptive-hardening dismissal default does not cover changed accept/reject arms"
date: 2026-06-10
category: conventions
module: ce-code-review triage + backend/tests
problem_type: convention
component: code-review
severity: medium
applies_when:
  - "Triaging a code-review finding that reports missing test coverage, deciding report vs dismiss-as-preemptive-hardening"
  - "The reviewed diff changes an HTTP surface's accept/reject behavior (new reject arm, widened acceptance, changed validation outcome)"
  - "A dismissal rationale cites the dismiss-test-quality-findings default for a route whose behavior the diff just changed"
  - "Deciding whether a missing test would pin behavior this diff changed or pin unchanged behavior against hypothetical future mutation"
  - "Reviewing route-level coverage of a changed arm where only unit-level or sibling-arm coverage exists"
tags: [code-review, triage, test-coverage, preemptive-hardening, dismissal, behavior-change, http-surface, review-findings]
related_components:
  - testing_framework
  - development_workflow
---

# Behavior-change coverage gaps are reportable: the preemptive-hardening dismissal default does not cover changed accept/reject arms

## Context

PEvO's standing triage stance for test-quality findings — dismiss preemptive test hardening; theoretical-only failure modes (hardcoded-safe, rare flake) do not warrant holds — has lived only in agent auto-memory (auto memory [claude]), never in the repo. Review fleets and independent validators have had to re-derive its boundary by hand in every dispatch prompt, and the boundary kept getting probed from both sides.

Two holds in the fresh-auth credit/consent-op gate work fixed the boundary (incident history): on 2026-06-09, the credit-op fresh-auth gate task was held at P1 because the newly added ORCID `/start` `mode=fresh_auth` credit-op issuance branch shipped with zero route-level coverage — new behavior, nothing pins it. On 2026-06-10, its consent-op normalization-parity sibling was held at P2 because a parity refactor changed the consent-branch validation on the same route (over-cap and whitespace-only `root_author`/`root_permlink` now 400 where the old bare typeof/length checks passed them) while the only `/start` fresh-auth validation describe block in `orcid.test.ts` covered credit ops exclusively; the consent branch's failure arm had no route-level coverage at all, its happy path exercised only as a side effect of the `startAuthed` helper. An independent validator articulated the discriminator: a behavior-change gap, not preemptive hardening of an unchanged path.

The same sessions dismissed four findings as genuine preemptive hardening: coverage of an `assertNever` throw unreachable through the typed call graph, an exactly-at-cap (64-char) inclusive acceptance pin where only the 65-rejection had behavioral history, a route-level cap-divergence test after pre-limiter and extractor were converged on one shared exported constant (the divergence made structurally impossible), and a whitespace-only consume-scan pin already covered by helper-level pins. The boundary held in both directions; this entry makes it repo-resident.

This is the general boundary statement for the dismissal default. Several sibling entries instantiate the same line for defects in *existing* tests (see Related: vacuous assertions, tautological value-pins, under-discriminating assertions); this entry covers the *absent-coverage* case — no test exists for an arm the diff itself changed or added.

## Guidance

When a review finding says "X has no test coverage," ask one question before reaching for the preemptive-hardening dismissal:

**Would the missing test pin behavior that THIS diff changed or added, or would it pin unchanged behavior against a hypothetical future mutation?**

- **Changed or added by this diff → reportable gap.** A new branch, a flipped accept/reject decision, a validation arm that now 400s where it previously passed — these are behaviors the diff introduced with nothing pinning them. Hold. The preemptive-hardening default does not apply, because the failure mode is not theoretical: the behavior just changed and nothing would catch it changing back (or changing wrong).
- **Unchanged by this diff → dismissable preemptive hardening.** The test would only fire if some future edit mutated a path this diff did not touch, or if a caller cast past the type system to reach code the typed call graph makes unreachable. Dismiss per the standing default. This entry does not weaken that default; it bounds it.

Secondary signal that strengthens a hold: a changed accept/reject decision on an HTTP surface whose changed arm has zero route-level coverage **while a sibling arm has the parallel coverage to mirror**. When the credit-ops arm of a route has a validation describe block and the consent arm — the one the diff just changed — has none, the gap is not hypothetical and the fix is cheap (mirror the sibling's structure).

Two corollaries:

- "The happy path is exercised as a side effect of a shared test helper" does not count as coverage for a changed failure arm. Side-effect exercise pins nothing about the rejection behavior the diff altered.
- Refactors claimed to be behavior-preserving are in scope. If convergence on a shared extractor tightened validation as a byproduct (bare typeof/length checks replaced by trim+cap), that tightening IS a behavior change, and its new rejections are holdable gaps even though the commit message says "parity."

## Why This Matters

Without the discriminator, triage oscillates. The preemptive-hardening default is broad enough to swallow real gaps: "no coverage of the consent-branch 400s" pattern-matches to "preemptive rejection-path hardening" unless the reviewer checks whether the 400s are new. Over-dismissing that way ships changed HTTP contract behavior with nothing pinning it. The opposite failure — over-holding genuinely theoretical hardening because "coverage gap" sounds serious — burns implementer rounds on tests for structurally impossible mutations. One question (did this diff change the behavior the test would pin?) resolves both directions, and it is cheap to answer from the diff itself.

## When to Apply

- Triaging test-coverage findings from `/ce-code-review` or an independent validator before deciding hold vs dismiss.
- Writing architect hold blocks: cite which diff hunk changed the unpinned behavior, so the implementer sees why the preemptive-hardening default was not applied.
- Drafting validator dispatch prompts: state the discriminator instead of restating the dismissal default alone.
- Reviewing "parity" or "convergence" refactors: diff the validation semantics, not just the code shape, before accepting behavior-preservation claims.

## Examples

| Finding | Did this diff change the behavior the test would pin? | Verdict |
|---|---|---|
| Consent-branch over-cap/whitespace `root_author` now 400s on `/api/orcid/start`; no route-level test of the consent failure arm; credit-ops sibling arm has a full validation describe block | Yes — the diff flipped pass to reject | **Hold** (behavior-change gap) |
| Newly added `fresh_auth` credit-op issuance branch on `/start` with zero route-level coverage | Yes — the branch is new | **Hold** (added-behavior gap) |
| No test of the `assertNever` throw in the mode switch | No — unreachable through the typed call graph; requires casting past the type system | **Dismiss** (preemptive) |
| No exactly-at-cap (64-char) acceptance pin; the 65-rejection is pinned | No — nothing changed at 64 | **Dismiss** (preemptive) |
| No route-level pre-limiter cap-divergence test | No — pre-limiter and extractor now share one exported constant; divergence is structurally impossible | **Dismiss** (preemptive) |

Hold-block phrasing that applies the discriminator (preferred):

```markdown
- P2: the consent-branch rejection behavior on `/start` changed in this diff
  (over-cap and whitespace-only `root_author`/`root_permlink` now 400; the old
  bare typeof/length checks passed them) and has zero route-level coverage.
  This is a behavior-change gap, not preemptive hardening of an unchanged
  path. Mirror the credit-ops validation describe block for the consent arm.
```

Dismissal phrasing that applies it (preferred):

```markdown
- Dismissed: `assertNever` throw coverage. The throw is unreachable through
  the typed call graph; the test would pin unchanged behavior against a
  hypothetical future cast. Preemptive hardening per the standing default.
```

## Related

- `dedup-shared-constant-defeats-test-value-pin-2026-05-26.md` — sibling reportable-exception; the clearest prior two-sided statement of the boundary (restored coverage vs redundant locator-pin).
- `vacuous-state-unchanged-assertion-sentinel-pattern-2026-05-20.md` — sibling boundary case with the parallel triage question "does this assertion actually fail if the guard breaks?"
- `route-level-error-class-coverage-after-helper-extraction-2026-04-29.md` — content precedent: route-level coverage is owed for arms a diff changed, even when lower-level tests exist.
- `assert-discriminating-error-message-when-code-shared-2026-06-09.md` — sibling not-dismissable carve-out with the matching "under current code, not future hypothetical" temporal framing.
- `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — umbrella mutation-soundness principle; this entry is its triage-time corollary.
- `normalize-before-hash-gate-admits-denormalized-payloads-2026-06-10.md` — the same fresh-auth extractor-convergence diff family; records the dismissed-finding counterpart from that area.

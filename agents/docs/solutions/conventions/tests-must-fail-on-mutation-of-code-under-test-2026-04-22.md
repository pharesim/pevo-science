---
title: Tests must fail when the code under test is mutated — revert-verify every load-bearing spec
date: 2026-04-22
last_updated: 2026-09-23
category: conventions
module: backend
problem_type: convention
component: testing
severity: high
applies_when:
  - Writing a test that claims to protect a specific code-level safety property
  - A hold block asks for "add a test for X" — the test must fail on revert of X before the re-review signal attests it
  - A test uses a filter predicate narrowed by string matching against production SQL / source
  - A test uses `toBeLessThanOrEqual(N)` where "exactly N" is the claim
  - A Playwright spec uses `.first().toHaveCount(1)` or similar self-tautologizing predicate
  - A test uses `mockImplementation(...)` (not `...Once`) where the detection target is "an extra unwanted call"
tags:
  - testing
  - mutation-soundness
  - vacuous-pass
  - regression-protection
  - ce-code-review
---

## Rule

Every test added to protect a specific code-level property MUST be verified to fail when that property is reverted. If the test passes against the broken code, the test is not covering the property.

The verification is cheap — revert the single LOC or commit the test is about, re-run the test, confirm it fails, restore, confirm it passes. The cost of skipping it: a green test suite that silently admits the regression it claims to catch.

When what the spec protects landed as a commit rather than one line, revert the whole commit. A commit can span coupled hunks, characteristically one that adds a condition and one that deletes what the addition made redundant, and reverting a hand-picked subset of them is not reverting the commit. It builds a state that never shipped, and such a state can pass for reasons the property has nothing to do with, which reads as a gap in a test that was fine. Take the prior version wholesale rather than flipping back whichever line looks like the change. See `agents/docs/solutions/conventions/mutation-probe-must-reconstruct-the-pre-fix-shape-2026-09-23.md`.

## Why

The 2026-04-22 architect review pass surfaced four tests across three tasks that pass today but would also pass on revert:

- **A discipline cache-key canonicalization spec** (the `GET /api/search — discipline-filter cache-key canonicalization` block in `disciplines-canon-mocked.test.ts`): filtered `hafQueryMock.mock.calls` on SQL containing `ts_rank | plainto_tsquery | websearch_to_tsquery`. The actual search SQL uses `ILIKE`. Filter matches zero calls; `toBeLessThanOrEqual(1)` trivially passes at 0.
- **The ORCID binding-lock specs** (`orcid.test.ts`): 8 `describe.each` specs prove self-release + TTL-expiry. None prove the Lua CAS refuses a foreign-nonce release — the primary safety property. Plain `DEL` regression passes all 8.
- **The same-tick SETNX lock race spec** (the `same-tick SETNX lock` `describe.each` block in `orcid.test.ts`): race-spec uses `mockImplementation` (every call parks on gate) instead of `mockImplementationOnce`. Lock-removal regression causes `Promise.race` to hang rather than fail loudly.
- **A papers-browse card-render assertion** (`papers-browse.spec.js`, the `article.card:has(.badge-discipline)` locator): `toHaveCount(1)` on `.first()` is tautological — `.first()` already scopes to one element. Assertion passes as soon as ≥1 element matches, regardless of count.

All four were caught by adversarial / testing reviewers asking "would a revert fail this?" — not by authors, implementers, or initial review. Writing a test without running it against the broken code is how vacuous specs ship.

## How to apply

1. **Before committing a new spec**, locally revert the LOC the spec is about and re-run the spec. Where the change the spec covers spans more than one hunk, take the prior version of the file wholesale instead, so the mutant is a revision that really existed. Confirm it fails. Restore and confirm it passes. In this shared checkout the restore step is destructive: confirm `git status` is clean for the target file immediately before every `git checkout -- <file>` / `git restore <file>`, because a sibling agent's unstaged edit on that path is unrecoverable once discarded (see `git-checkout-head-destroys-coresident-unstaged-2026-05-11.md`).
2. **When hold-block items ask for a test**, the re-review signal must explicitly state: "confirmed the spec fails on revert of `<file:line>`." The attestation names the probe so the architect can replay it cheaply; it does not discharge the architect's own check. Re-review-signal coverage prose in this repo is repeatedly wrong, so the architect re-runs or re-reads the cited revert rather than accepting the sentence.
3. **Prefer exact assertions over bounded ones** when the claim is exact. `toBe(1)` over `toBeLessThanOrEqual(1)`; `toHaveBeenCalledTimes(N)` over `toHaveBeenCalled()`.
4. **Grep-verify filter fragments** used in `mock.calls.filter(c => sql.includes('X'))` against production source — if `X` isn't actually in the code, the filter is dead.
5. **Match mock shape to detection target**. If the test needs to catch an extra unwanted call, use `mockImplementationOnce` for the first (gated) + `mockResolvedValue` for subsequent so the extra call increments the mock observably.
6. **Pick Playwright predicates that match intent**. `toBeVisible()` for "element rendered"; drop `.first()` and use `toHaveCount(N)` on the unnarrowed locator for "exactly N elements exist." `.first().toHaveCount(1)` is tautological.

## Related

- `agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md` — closest prior art. Generalizes here: mock-shape gap is one instance of "test cannot fail when property is broken."
- `agents/docs/solutions/conventions/verify-library-claims-before-load-bearing-security-margins-2026-04-22.md` — sibling from the same review pass. That doc grounds library-behavior claims; this doc grounds test-regression-protection claims. Both are cheap point-in-time verifications.
- `agents/docs/solutions/conventions/mutation-probe-must-reconstruct-the-pre-fix-shape-2026-09-23.md` — the fidelity extension: this doc's procedure assumes the change under revert is one atomically revertible unit. That doc covers the case where it is not, and where a partial revert therefore produces a green run that reads as missing coverage rather than as a malformed mutant.
- `agents/docs/solutions/conventions/control-pair-pins-only-varied-axis-enumerate-mutation-space-2026-06-12.md` — the non-revert extension: a passing revert probe covers binary removal of the property, but operator and granularity weakenings of the protecting comparison can survive every revert-verified spec. Enumerate the comparison's mutation space and place a control on each weakening boundary.
- `agents/docs/solutions/conventions/source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage-2026-09-08.md` — the coverage ceiling: revert-verify is a floor per spec, not a closure proof for a guard. A prescribed list of mutation probes confirms the items it names; establishing that a guard is closed needs an unscripted adversarial search with independent refutation.

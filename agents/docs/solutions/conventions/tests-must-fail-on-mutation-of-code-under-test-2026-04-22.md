---
title: Tests must fail when the code under test is mutated — revert-verify every load-bearing spec
date: 2026-04-22
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

## Why

The 2026-04-22 architect review pass surfaced four tests across three tasks that pass today but would also pass on revert:

- **BE-DISCIPLINE-CANONICALIZE** (`disciplines-canon-mocked.test.ts:442-446`): filtered `hafQueryMock.mock.calls` on SQL containing `ts_rank | plainto_tsquery | websearch_to_tsquery`. The actual search SQL uses `ILIKE`. Filter matches zero calls; `toBeLessThanOrEqual(1)` trivially passes at 0.
- **BE-ORCID-TOCTOU-LOCK** (`orcid.test.ts`): 8 `describe.each` specs prove self-release + TTL-expiry. None prove the Lua CAS refuses a foreign-nonce release — the primary safety property. Plain `DEL` regression passes all 8.
- **BE-ORCID-TOCTOU-LOCK** (`orcid.test.ts:784-817`): race-spec uses `mockImplementation` (every call parks on gate) instead of `mockImplementationOnce`. Lock-removal regression causes `Promise.race` to hang rather than fail loudly.
- **FE-PAPERS-BROWSE** (`papers-browse.spec.js:50`): `toHaveCount(1)` on `.first()` is tautological — `.first()` already scopes to one element. Assertion passes as soon as ≥1 element matches, regardless of count.

All four were caught by adversarial / testing reviewers asking "would a revert fail this?" — not by authors, implementers, or initial review. Writing a test without running it against the broken code is how vacuous specs ship.

## How to apply

1. **Before committing a new spec**, locally revert the LOC the spec is about and re-run the spec. Confirm it fails. Restore and confirm it passes.
2. **When hold-block items ask for a test**, the re-review signal must explicitly state: "confirmed the spec fails on revert of `<file:line>`." This saves the architect from re-verifying.
3. **Prefer exact assertions over bounded ones** when the claim is exact. `toBe(1)` over `toBeLessThanOrEqual(1)`; `toHaveBeenCalledTimes(N)` over `toHaveBeenCalled()`.
4. **Grep-verify filter fragments** used in `mock.calls.filter(c => sql.includes('X'))` against production source — if `X` isn't actually in the code, the filter is dead.
5. **Match mock shape to detection target**. If the test needs to catch an extra unwanted call, use `mockImplementationOnce` for the first (gated) + `mockResolvedValue` for subsequent so the extra call increments the mock observably.
6. **Pick Playwright predicates that match intent**. `toBeVisible()` for "element rendered"; drop `.first()` and use `toHaveCount(N)` on the unnarrowed locator for "exactly N elements exist." `.first().toHaveCount(1)` is tautological.

## Related

- `agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md` — closest prior art. Generalizes here: mock-shape gap is one instance of "test cannot fail when property is broken."
- `agents/docs/solutions/conventions/verify-library-claims-before-load-bearing-security-margins-2026-04-22.md` — sibling from the same review pass. That doc grounds library-behavior claims; this doc grounds test-regression-protection claims. Both are cheap point-in-time verifications.

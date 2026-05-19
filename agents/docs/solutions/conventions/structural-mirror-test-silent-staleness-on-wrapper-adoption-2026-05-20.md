---
title: "Adopting a wrapper at site N requires auditing pre-existing tests that mirror site N's pre-wrapper shape — structural-mirror canaries silently weaken when production diverges"
date: 2026-05-20
category: conventions
module: backend/tests
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Adopting a wrapper helper (`normalizeHiveAccount`, `trimAsciiSpace`, `validatedCid`, any canonical-form helper) at a production site that has existing tests pinning the pre-wrapper SQL shape, JS predicate shape, or string-equality form"
  - "Per `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`, completing the call-site grep and writing new per-site tests — but BEFORE declaring acceptance #4 (mutation-kill) satisfied"
  - "Modifying a SQL CTE, JSON predicate, or comparison shape that another test asserts as a 'structural mirror' constant (subqueryShape, expectedSql, expectedPredicate) for cascade-fail / defense-in-depth coverage"
  - "Cross-corroborated cluster review findings flag a site as having both 'production was widened correctly' AND 'an unrelated existing test still encodes the pre-fix shape' — the second is the structural-mirror staleness this convention codifies"
related_components:
  - database
tags:
  - testing
  - mutation-kill
  - structural-mirror
  - wrapper-adoption
  - audit
  - regression-test
---

# Adopting a wrapper at site N requires auditing pre-existing tests that mirror site N's pre-wrapper shape — structural-mirror canaries silently weaken when production diverges

## Context

The `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` convention prescribes a grep audit of every call site that uses the wrapper's underlying primitive, plus a per-site mutation-kill test for each adopted site. Acceptance criterion #4 of typical adoption tasks is "reverting any of the N sites to raw lookup fails the corresponding test red."

That convention closes one axis of mutation-kill: **new sites get new tests.** It does not close a second axis: **existing tests that mirror site N's PRE-wrapper shape silently encode the wrong shape after adoption.** These "structural-mirror" tests are usually defense-in-depth canaries written for an unrelated concern (cascade-fail defense, query-plan stability, syntactic invariant pinning) that happen to constant-encode the SQL or JS shape of a production site. When production widens to use a wrapper, the mirror constant still holds the pre-wrapper shape — and a targeted revert at that one production site (re-removing the wrapper) leaves the structural-mirror test green because it was already asserting the pre-revert shape.

This shipped in `backend-normalize-hive-account-adoption-sweep` (commit `58df5e7`, 2026-05-19) and was surfaced by `/ce-code-review` at architect intake on 2026-05-20. The `paper_resolved_votes` cascade-fail defense test at `backend/tests/hafsql.test.ts:759-768` hardcoded `subqueryShape = 'AND a ->> \'hive\' = plv.voter'` while production `backend/src/reputation.ts:651-652` was widened to `AND LOWER(TRIM(a ->> 'hive')) ~ '^[a-z0-9.-]+$' AND LOWER(TRIM(a ->> 'hive')) = plv.voter`. The cascade-fail test still passes (because the cascade-fail concern is structurally unrelated to the normalization), but a targeted revert of the normalization at that one production site leaves the test green. Cross-corroborated by four reviewers (security, testing, adversarial, maintainability) — the cross-reviewer signal IS the marker for this class of finding.

## Guidance

When adopting a wrapper at a production site, the audit obligation has two axes — not one:

1. **Forward axis (`wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`):** grep for the underlying primitive across `backend/src/`; verify every call site is wrapped or documented as intentional non-adoption; write per-site mutation-kill tests.

2. **Backward axis (this convention):** grep existing TESTS for any constant string, regex, or expected-shape pin that encodes the PRE-wrapper form of the same site. Each hit is a structural-mirror canary that now encodes the wrong shape; update it OR add a separate normalization assertion at the same site so a production revert turns at least one test red.

The grep for the backward axis is symmetric to the forward grep:

```bash
# Forward: find raw call sites in production code
grep -rnE '\.hive\b|->> *.hive.|a\.elem' backend/src/ --include='*.ts'

# Backward: find existing tests that encode pre-wrapper shapes
grep -rnE "a ->> 'hive'|\.hive ===|raw.*lookup" backend/tests/ --include='*.ts'
```

Tests in the backward grep that pre-date the wrapper adoption are candidates for one of:

- **Update the structural-mirror constant** to the post-fix shape (preserves the original test's intent — usually cascade-fail / defense-in-depth — AND now pins the normalization too).
- **Add a separate per-site behavioral assertion** at the same physical site (`describe()` block or sibling `it()`) that does not depend on the structural-mirror constant — a behavioral test that exercises the wrapper directly and would fail red on a revert.
- **Document the test as intentionally pre-fix** (rare — only when the test exists explicitly to pin a deprecated shape, e.g., a migration rollback safety check). Inline comment explaining why the constant intentionally lags the wrapper.

The check is "would a targeted revert of the wrapper at this one production site turn at least one test red?" If no, the structural-mirror staleness has silently weakened mutation-kill coverage.

This convention is a corollary of `route-level-error-class-coverage-after-helper-extraction-2026-04-29.md`, which addresses the same pattern in the error-class direction: helper extraction does not absolve route-level coverage of the same classes. Wrapper adoption does not absolve existing tests of asserting the post-wrapper shape.

## Why This Matters

Production wrapper adoption changes the shape of production code. If the only tests that exercise the changed shape are the NEW per-site mutation-kill tests, the project has shed mutation-kill coverage on every existing test that pinned the old shape:

- Before adoption: the structural-mirror canary asserts the cascade-fail defense for shape X. Shape X is also the normalization shape (no wrapper yet). Cascade-fail revert AND normalization revert both fail red.
- After adoption: production shape is now Y (wrapped). The structural-mirror canary still pins shape X for cascade-fail. Cascade-fail revert still fails red. Normalization revert PASSES — the constant no longer matches production, so the test asserts a shape production no longer uses; reverting the normalization brings production CLOSER to the test's expected shape, not further from it. The new per-site test catches it (per acceptance #4) — but only if the new test was written. Per-site tests added by the wrapper-adoption task cover the wrapper's CORE failure mode (raw lookup → wrong result). Sibling failure modes (cascade-fail, query-plan stability, syntactic invariants) lose their mutation-kill coverage silently.

The failure mode is invisible because the structural-mirror test still passes. Test reports don't surface "this test no longer asserts what it used to assert." A future maintainer reading the test name will assume the test pins what the name says — but the constant inside it pins something production stopped doing.

Cost to catch: one extra grep per adoption + 5-10 minutes per hit deciding "update the constant" vs "add a per-site assertion." Cost to miss: silent mutation-kill weakening that compounds with every subsequent wrapper adoption in the same area.

## When to Apply

- Every `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` adoption task, as a second-axis grep after the forward call-site grep.
- Every SQL CTE refactor that changes a predicate's literal shape (column reference, function wrapping, JSON-extract path) where existing tests pin the CTE's emitted text.
- Every JS predicate refactor that changes a comparison's normalization (case, trim, encoding) where existing tests pin the pre-normalization comparison form.
- Cross-corroborated cluster review findings where the cross-reviewer signal is "production correct, existing test stale" — this convention is the codification of that finding class.

## Examples

### The `paper_resolved_votes` cascade-fail test at `backend/tests/hafsql.test.ts:759-768`

Pre-adoption (test correctly mirrors production):
```ts
const subqueryShape = "AND a ->> 'hive' = plv.voter";
// ... cascade-fail defense assertion using subqueryShape ...
```

Production at this point: `reputation.ts:paper_resolved_votes` predicate has the raw `a ->> 'hive' = plv.voter` shape. Cascade-fail revert AND raw-lookup revert both fail red.

Post-adoption WITHOUT this convention applied (silent weakening):
```ts
// subqueryShape unchanged: "AND a ->> 'hive' = plv.voter"
// Production changed to: "AND LOWER(TRIM(a ->> 'hive')) ~ '^[a-z0-9.-]+$'
//                        AND LOWER(TRIM(a ->> 'hive')) = plv.voter"
```

Now a targeted revert of the normalization in `reputation.ts:paper_resolved_votes` brings production closer to `subqueryShape`'s expectation, not further. The cascade-fail concern is still pinned. The normalization concern is no longer pinned at this site.

Post-adoption WITH this convention applied (correct):
```ts
// Update the mirror constant:
const subqueryShape =
  "AND LOWER(TRIM(a ->> 'hive')) ~ '^[a-z0-9.-]+$' " +
  "AND LOWER(TRIM(a ->> 'hive')) = plv.voter";

// Cascade-fail defense assertion now pins the post-fix shape.
// Additionally add a behavioral assertion that exercises the normalization
// at this site directly, so the wrapper-adoption mutation-kill is pinned
// independently of the cascade-fail concern.
it('paper_resolved_votes excludes uppercase-hive co-author votes', async () => {
  // synthetic data: voter='bob', paper authors=[{hive:'Bob'}]
  // expect bob's vote excluded from paper_resolved_votes
});
```

A targeted revert of the normalization now fails BOTH the structural-mirror test (its constant no longer matches the post-revert production shape) AND the new behavioral test.

### Generalization to other PEvO wrappers

The same audit applies when adopting:

- `validatedCid` at a new emit path: grep `backend/tests/` for tests that assert raw `ipfs_cid` pass-through or `pevoString(meta, 'ipfs_cid')` without the validate-on-emit wrap.
- `trimAsciiSpace` at a new comparison: grep `backend/tests/` for tests that assert `hive.trim()` or `hive.toLowerCase().trim()` without the ASCII-space-only contract.
- `pevoString` / `pevoStringArray` at a new metadata read: grep for tests that assert `(pevo[key] as string) ?? null` or `(pevo[key] as string[]) || []` cast patterns.

In each case, the failure mode is identical: production widens, the existing test constants stay pre-widening, mutation-kill silently weakens at that site.

## Related

- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — the forward-axis convention this learning is the backward-axis corollary of.
- `agents/docs/solutions/conventions/route-level-error-class-coverage-after-helper-extraction-2026-04-29.md` — same pattern in the error-class direction (helper extraction does not absolve route-level coverage of the same classes).
- `agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` — adjacent concern: each defense layer needs its own canary. This convention is about preserving existing canaries when one of their pinned shapes shifts.
- `agents/docs/tasks/pending/backend-normalize-hive-account-adoption-sweep.md` — held re-review with item #1 (this case at `paper_resolved_votes`) as the immediate consequence in PEvO.

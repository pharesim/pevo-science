---
module: backend/tests
date: 2026-05-17
problem_type: test_failure
category: test-failures
component: testing_framework
severity: medium
symptoms:
  - "3 of 4 canary specs failed: positive assertion `findAuditEvent(warnSpy)` returned undefined"
  - "4th canary (negative-outcome, `expect(event).toBeUndefined()`) passed vacuously"
  - "vitest stderr emitted `event: canonical_root_walker_start_invalid, reason: cont_columns_invalid` for every spec"
  - "downstream `buildCumulativeAuthorsForChain` audit-emission code never executed"
  - "overlapping `hafQueryMock` matcher returned an upstream-stage row missing `cont_author`/`cont_permlink` for the downstream walker SELECT"
root_cause: test_isolation
resolution_type: test_fix
related_components:
  - database
  - development_workflow
tags:
  - vitest
  - haf-mock
  - mock-matcher
  - vacuous-assertion
  - multi-stage-mock
  - upstream-bail
  - test-fidelity
  - negative-outcome-assertion
  - discriminator-overlap
  - stderr-detection
---

# Assertion vacuity from upstream-bail in multi-stage mocked tests

## Problem

A multi-stage mocked HAF-pool test (`backend/tests/routes/papers-cumulative-orcid-audit.test.ts`) used an SQL-matcher discriminator (`SELECT c.author, c.json_metadata` + `parent_permlink = $3`) that overlapped two distinct queries: the canonical-root walker and the head-authors lookup. The walker matched first, hit a column-shape bail because the mock omitted `cont_author`/`cont_permlink`, and short-circuited the chain — leaving 3 canaries failing for the wrong reason and 1 negative-outcome canary passing vacuously.

## Symptoms

Parent agent ran the suite post-merge and observed:

- 3 of 4 canaries failed with `expected undefined to be defined` at `findAuditEvent(warnSpy)` — no audit event was emitted.
- 1 canary (`expect(event).toBeUndefined()` for the post-revocation-match non-firing case) passed.
- Vitest stderr contained `event: canonical_root_walker_start_invalid, reason: cont_columns_invalid` repeating for every test request.
- Production code (`backend/src/routes/papers.ts:1746-1815`) was correct; nothing in the route changed shape.

Initial read: "3 tests broken, 1 working." Actual read: all 4 canaries were broken — the passing one was a false positive.

## What Was Masked

The mock infrastructure bug masked the entire assertion surface:

- **3 canaries failed loudly**, but for the wrong reason (chain truncated to root-only by upstream bail, never reaching active/revoked-arm audit emission code). Fixing them by accommodating the bail would have left the contract unfenced.
- **1 canary passed silently.** `expect(event).toBeUndefined()` was satisfied because the walker bailed — not because the post-revocation-match predicate behaves correctly. If the production code's active vs revoked branching were inverted (fire on match, silent on mismatch), this canary would STILL pass. The negative-outcome assertion was structurally incapable of distinguishing "correct silence" from "bail-induced silence."
- **Test-count summaries lied.** "1/4 green" did not mean 25% of the contract was fenced; it meant 0% was fenced and one assertion happened to be vacuously satisfied.

## Solution

Disambiguate the mock matcher so the canonical-root walker SQL and the head-authors lookup match distinct branches. Two acceptable shapes:

**(a) Add a dedicated walker matcher returning a shape-valid start row:**

```ts
hafQueryMock.mockImplementation((sql, params) => {
  if (canonicalRootWalkerStartSql.test(sql)) {
    return {
      rows: [{
        author: 'alice',
        permlink: 'p1',
        cont_author: 'alice',      // required by walker; bail trigger if missing
        cont_permlink: 'p1',
        json_metadata: JSON.stringify({ /* parseable */ }),
      }],
    };
  }
  if (headAuthorsLookupSql.test(sql)) {
    return { rows: [/* head-authors rows */] };
  }
  // …
});
```

**(b) Fork the existing matcher on a column unique to one query.** The walker SELECT aliases `cont_author`/`cont_permlink`; the head-authors lookup does not. Discriminate on the alias:

```ts
const isWalkerSql = (sql: string) =>
  /\bcont_author\b/.test(sql) && /\bcont_permlink\b/.test(sql);
```

Either shape eliminates the overlap. Verify the fix landed by re-running the suite and confirming `canonical_root_walker_start_invalid` no longer appears in stderr.

## Why This Works

Root cause: the matcher discriminated on columns and predicates (`SELECT c.author, c.json_metadata`, `parent_permlink = $3`) present in BOTH the walker SQL and the head-authors lookup SQL. `vi.mock` matchers fire in declaration order on first match, so the walker SQL was claimed by the head-authors-shaped matcher, received a row missing walker-required columns, and the walker bailed at the `cont_author`/`cont_permlink` string check.

The fix forces the matcher to key on something the two queries do NOT share. `cont_author`/`cont_permlink` aliases appear in the walker SELECT and nowhere else in the route's HAF query set, making them a stable unique discriminator. Once disambiguated, the walker returns a shape-valid row, `buildCumulativeAuthorsForChain` traverses the full chain, and the audit emission code in the active/revoked arms is actually reached — so the canaries assert against the behavior they're supposed to fence.

## Prevention

This is not preemptive test hardening — the assertions in question are genuinely vacuous (the 4th canary would pass even if production were inverted). The mitigations below address a real assertion-strength bug, not a theoretical one.

**1. Add a positive-control canary to every multi-stage mocked test.** A canary asserting a positive outcome (e.g., "the audit-target hive name appears in the response body", "the response chain length matches the seeded link count") provides a structural check that the chain reached the assertion target. If the positive control fails alongside negative-outcome canaries, the bail is the cause and the negative-outcome assertions cannot be trusted until the positive control passes. Without a positive control, a clean bail is indistinguishable from correct behavior.

**2. Inspect stderr during test development for upstream-bail signals.** Before considering a multi-stage mocked test reliable, grep its run output for known-bail discriminators: `*_invalid`, `*_failed`, `*_columns_*`, `*_bail`, and any structured-log event with `reason: *_missing` or `reason: *_unparseable`. PEvO routes emit these as `logger.warn` events with stable `event:` keys; their presence during a test run is a red flag even when the test passes. The detection method that found this bug — reading vitest stderr — is the actionable discipline.

**3. When a mock matcher discriminates between SQL queries that share columns or predicates, use a discriminator UNIQUE to one query.** Audit the SELECT clauses and WHERE predicates of every query the route issues; pick a column, alias, or predicate that appears in exactly one. PEvO concrete example: the canonical-root walker SELECT aliases `cont_author`/`cont_permlink`; the head-authors lookup does not. Use the unique alias, not the shared `c.author, c.json_metadata` prefix.

**Negative-outcome assertions are MOST susceptible to vacuity-by-upstream-bail.** Assertions of the shape `expect(...).toBeUndefined()`, `expect(spy).not.toHaveBeenCalled()`, `expect(arr).toHaveLength(0)` are satisfied by ANY upstream short-circuit that prevents the assertion target from being produced. Positive-outcome assertions are self-protecting: a bail makes them fail loudly. When writing a negative-outcome canary, pair it with at least one positive-control canary on the same fixture so a bail cannot satisfy both simultaneously.

## Files of record

- `backend/tests/routes/papers-cumulative-orcid-audit.test.ts:164-200` — the buggy `seedTwoLinkChain` rootRow mock that omitted `cont_author`/`cont_permlink`.
- `backend/src/routes/papers.ts:1746-1815` — canonical-root walker SQL + bail at `cont_columns_invalid`.
- `agents/docs/tasks/pending/backend-orcid-claim-mismatch-post-revocation-audit.md` — task with round-2 hold item 1 calling for the mock fix; parent's diagnostic appended under "Parent re-review note (2026-05-16, post-merge vitest run)".

## Related conventions

- `agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md` — closest prior art on HAF-mock predicate guards. The multi-stage generalization: instead of one guard whose fallback hides a bypass, two guards' discriminators overlap such that the upstream guard consumes the downstream guard's response.
- `agents/docs/solutions/conventions/test-marker-stub-vacuous-or-fallback-2026-05-15.md` — closest sibling failure mode (vacuous-pass via stub design). Same family on a different surface: there the truthy marker defeats OR-fallback; here the overlapping discriminator defeats stage routing.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — umbrella principle. This doc is one specific class of how multi-stage mocks violate it.
- `agents/docs/solutions/conventions/vi-spyon-mockimplementation-bypasses-function-under-test-2026-05-12.md` — shares the "negative-outcome assertions are the easiest to break vacuously" lesson and the stderr/log-inspection detection technique.
- `agents/docs/solutions/conventions/mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` — meta-doc; when writing a mutation-kill claim for this kind of test, trace the mutation → assertion → data-the-test-sees triple.
- `agents/docs/solutions/conventions/inner-catch-shadows-outer-catch-in-route-tests-2026-04-28.md` and `agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` — broader family of "test's observable is satisfied by an unintended path."

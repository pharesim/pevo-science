---
title: A synthetic-CTE SQL-redirect test helper silently false-greens if the production alias text drifts; assert the substitution landed
date: 2026-06-15
category: conventions
module: backend
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "A test exercises a PRODUCTION SQL fragment verbatim by string-replacing its FROM-clause table refs with synthetic CTE names, e.g. `body.sql.split(`${T.customJson} cj`).join('synthetic_cj cj')` then wrapping in `WITH synthetic_cj(...) AS (VALUES ...)`"
  - "The substring being replaced is the production helper's table-alias text (`${T.voteOps} v`, `${T.customJson} cj`), which the helper owns and can rename independently of the test"
  - "Some test cases legitimately expect an empty/zero result (a retraction, a self-vote, a malformed input, an empty input set)"
related_components:
  - testing
  - hafsql
tags:
  - vitest
  - test-isolation
  - sql
  - synthetic-cte
  - false-green
  - real-postgres
  - mock-carve-out
---

# A synthetic-CTE SQL-redirect test helper silently false-greens if the production alias text drifts; assert the substitution landed

## Context

Several PEvO backend tests exercise a production SQL fragment VERBATIM against controlled rows by string-replacing the fragment's FROM-clause table references with synthetic-CTE names, then defining those CTEs as `VALUES`. This is the documented real-Postgres carve-out (see [[test-mock-carve-out-clause-c-2026-05-04]]): the production clause under test runs unchanged through a real `getPool()` connection; only the data source is swapped. The pattern:

```ts
// Take the real fragment, redirect its table refs to synthetic sets.
let countExpr = accreditedVoteCount("'paper-author'", "'paper-permlink'", '$1');
countExpr = countExpr.split(`${T.voteOps} v`).join('synthetic_v v');
countExpr = countExpr.split(`${T.customJson} cj`).join('synthetic_cj cj');
const sql = `WITH synthetic_v(...) AS (VALUES ...), synthetic_cj(...) AS (VALUES ...)
             SELECT ${countExpr} AS net`;
```

Helpers using this shape: `runAccredCte`, `runVoteCount`, and `runVoteCountWithRevotes` in `backend/tests/window-cte-deterministic-tiebreaker.test.ts`, plus a helper in `backend/tests/wot-vouch-status-select-real-postgres.test.ts`.

The trap: the `.split(targetAlias).join(syntheticAlias)` redirect depends on the production helper emitting EXACTLY `targetAlias`. If the helper (`accreditedVoteCount`, `activeVouchesCteBody`, etc.) renames its table alias, or the `T.x` table constant changes, `.split()` finds nothing, `.join()` is a SILENT no-op, and the redirected SQL still references the REAL table. The assembled query then defines the `synthetic_*` CTEs but never references them; the production clause runs against the real HAF tables, finds no rows for the synthetic test keys (`'paper-author'`/`'paper-permlink'`), and returns 0/empty. Every case that legitimately expects 0 (retraction, self-vote, malformed weight, empty set) passes GREEN against the wrong data. Only the non-zero cases fail loudly. The output-shape canary that asserts on the raw helper output does NOT reach this, because the break is in the test's redirected copy, not in the helper.

## Guidance

After the redirect, ASSERT that the synthetic aliases actually landed in the redirected SQL, and throw a clear, actionable error if they did not. One cheap line per redirected ref converts a silent false-green into a loud failure the moment an alias drifts:

```ts
// Redirect-integrity guard. If the helper's table-alias text ever changes, the
// splits above silently no-op and the synthetic VALUES never substitute, so the
// 0-expecting cases pass green against the real tables. Assert both landed.
if (!countExpr.includes('synthetic_v v') || !countExpr.includes('synthetic_cj cj')) {
  throw new Error(
    'redirect no-op (accreditedVoteCount alias text changed). Update the .split() ' +
      'targets so the synthetic sets are substituted, else cases fall through and pass as false-green.',
  );
}
```

The guard asserts on the POST-substitution string, so the synthetic token can only be present if the substitution ran. It complements but does not duplicate a helper-output shape canary: the canary pins the production helper's SQL; this guard pins the test's redirected copy.

## Why This Matters

A string-replace redirect couples the test to an internal detail the production helper is free to change (its table alias). When that coupling breaks, the failure mode is the worst kind: not a red test, but a green one asserting against empty real-table results. The cases most likely to silently pass are exactly the negative/boundary cases (retraction, exclusion, malformed input) that the test exists to protect. The guard is a one-line, zero-runtime-cost conversion of that silent false-green into an immediate, self-explaining failure.

## When to Apply

Any test helper that redirects production SQL to synthetic CTEs via `.split(productionAlias).join(syntheticAlias)`. Add the integrity assertion in the same helper, right after the last redirect and before the SQL executes. As of this writing only `runVoteCountWithRevotes` carries the guard; `runAccredCte`, `runVoteCount`, and the `wot-vouch-status-select-real-postgres.test.ts` helper use the same redirect WITHOUT it and remain exposed to a future alias rename (low probability, but the guard is cheap insurance and the convention is "every redirect helper asserts its own substitution").

## Examples

Canonical guard: `runVoteCountWithRevotes` in `backend/tests/window-cte-deterministic-tiebreaker.test.ts` (asserts `synthetic_v v` and `synthetic_cj cj` are present after the two redirects). The unguarded siblings in the same file (`runAccredCte`, `runVoteCount`) and in `backend/tests/wot-vouch-status-select-real-postgres.test.ts` are the candidates for the same one-line guard.

## Related

- [[test-mock-carve-out-clause-c-2026-05-04]] — the carve-out that licenses running a production SQL fragment against synthetic rows through a real Postgres connection; this learning is a failure mode of that technique.

---
title: Test HAF SQL selection logic against a real planner — redirect the CTE FROM to synthetic VALUES, never mock the query result
date: 2026-06-09
category: conventions
module: backend
problem_type: convention
component: testing
severity: medium
applies_when:
  - Writing a test whose focus is which rows a HAF CTE admits (JOIN type, HAVING, FILTER, ROW_NUMBER ranking)
  - Verifying a CTE still selects or excludes specific rows after a schema or JOIN change
  - The discriminating graph cannot be seeded into the live HAF corpus without broadcasting real chain ops
  - The production query is an exported builder whose FROM clause can be string-substituted
  - A real pg.Pool (Docker Postgres, APP_DATABASE_URL-gated) is reachable from the test runner
tags:
  - haf-sql
  - cte
  - synthetic-values
  - postgres-planner
  - mutation-blind
  - test-mock-carve-out
  - from-redirect
  - selection-logic
---

# Test HAF SQL selection logic against a real planner — redirect the CTE FROM to synthetic VALUES, never mock the query result

## Context

HAF is a PostgreSQL mirror of the entire Hive blockchain. PEvO reads accreditation and vouch state from it through CTE-based queries (`activeAccreditationsCteBody`, `activeVouchesCteBody`, `cascadeDiscoverySelect`, and siblings). The corpus is append-only chain data — there is no API to seed synthetic rows into the live HAF view at test time. Getting a controlled row into the mirror means broadcasting a real `vouch`/`accredit` custom_json to the chain and waiting out HAF indexing lag. For selection-logic tests that need a precise, contrived graph shape (e.g. a WoT-accredited vouchee whose only accredited voucher is the account being revoked), seeding the live corpus per test is not feasible.

The natural fallback is to mock `pool.query` and return fixture rows directly. That is fine for downstream concerns (response envelope, call counts, budget/timeout accounting), but it is structurally blind to the SQL logic itself: the mock bypasses the Postgres planner, so the JOIN type, HAVING predicate, and FILTER expression are never executed.

## Guidance

The FROM-redirect technique runs the production SQL verbatim against controlled data — no seeded corpus, no result mock.

**1. Export the SQL builder.** Extract the production query fragment into an exported function that returns a SQL string with `$N` placeholders. The test imports and calls the same builder, so it exercises production SQL, not a hand-rewritten copy that drifts.

```ts
// wot.ts — exported so the regression test runs the production SQL verbatim
export function cascadeDiscoverySelect(revokedParam: string, thresholdParam: string): string {
  return `SELECT av_target.vouchee
       FROM active_vouches av_target
       JOIN active_accreditations aa_target
         ON aa_target.account = av_target.vouchee AND aa_target.method = 'wot'
       LEFT JOIN active_vouches av_all ON av_all.vouchee = av_target.vouchee
       LEFT JOIN active_accreditations aa_voucher ON aa_voucher.account = av_all.voucher
       WHERE av_target.voucher = ${revokedParam}
       GROUP BY av_target.vouchee
       HAVING COUNT(DISTINCT av_all.voucher) FILTER (
         WHERE aa_voucher.account IS NOT NULL AND av_all.voucher != ${revokedParam}
       ) < ${thresholdParam}`;
}
```

**2. Redirect the CTE's FROM to a synthetic VALUES set.** Build the real CTE block (`buildWith(...)`), then string-replace the live HAF view reference (`hafsql.operation_custom_json_view`) with a synthetic CTE name you define via `VALUES (...)`. Prepend that synthetic CTE to the combined WITH block. Every `?` predicate, JOIN condition, ROW_NUMBER ranking, and HAVING clause compiles and runs unchanged — only the data source changes.

```ts
const cte = buildWith(1, activeAccreditationsCteBody, activeVouchesCteBody);
const cteBodies = cte.sql.replace(/^\s*WITH\s+/, '');
const redirectedCte = cteBodies.split(`${T.customJson} cj`).join('synthetic_cj cj');

const sql = `
  WITH synthetic_cj(id, custom_id, json, required_posting_auths, block_num) AS (
    VALUES ${valueLines.join(',\n')}
  ),${redirectedCte}
  ${cascadeDiscoverySelect(revokedParam, thresholdParam)}`;

const result = await discoveryPool!.query<{ vouchee: string }>(sql, params);
```

**3. Add a redirect no-op guard immediately after computing the redirect.** If the view-reference string drifts (a CTE alias change, whitespace normalization, a rename of the view), the `split(...).join(...)` becomes a no-op, the test silently runs against the LIVE corpus instead of the synthetic set, and a behavioral assertion can pass vacuously (the live corpus does not contain the contrived graph). Guard it:

```ts
expect(redirectedCte).not.toContain(T.customJson);
```

If the redirect was a no-op, the view literal still appears, the assertion fires at the guard, and the test reports the configuration failure instead of a false-positive behavioral pass.

**4. Gate on a real pool and set a generous timeout.** The connection is available only when `APP_DATABASE_URL` (or the HAF equivalent) is configured. Use `it.skipIf(!discoveryPool)` so a DB-less CI stays green, with a ~30s timeout to match the cold-connection planning cost the sibling tests already allow.

**5. Document the test-mock carve-out clauses in the file header.** Clause (a): why seeding the live corpus is impractical for this case. Clause (b): no auth middleware is involved — the CTE sits below the route layer, so cryptographic verification is not applicable (this is a SQL-shape-focused test, not an auth-focused one). Clause (c): the real-path companion — the FROM-redirect block is itself the real-path companion for the SQL-shape risk class, while the mocked-pool specs cover the call-count/budget/accounting risk classes.

## Why This Matters

Any mutation to the JOIN type (INNER vs LEFT), the HAVING predicate, or the FILTER inside COUNT is invisible to a result-mocked test — those constructs are dead code from its perspective, so the mutation ships green. The concrete cost: the WoT cascade-discovery query is meant to catch the cascade-terminal vouchee — an account WoT-accredited whose only accredited voucher is the one being revoked, so removing that voucher drops its surviving accredited-voucher count to zero. An INNER JOIN on the surviving-voucher tables silently drops that account: with no surviving voucher row, no group forms, and the vouchee falls out of the result set, left WoT-accredited with zero accredited vouchers. The mocked-pool discovery tests passed under the INNER-join form because they returned the expected to-be-revoked set directly, bypassing the broken SQL entirely. The regression was caught only by hand-tracing the SQL during architect re-review — by no test. A FROM-redirect test on a real pool catches the same mutation immediately: the cascade-terminal account is absent from the INNER-join result and the assertion fails, naming the missing account.

This is the core correctness argument for HAF queries. The chain is the system of record; a HAF query's selection logic is part of that correctness contract. Mocking the result treats the query as a trusted oracle whose output you supply, which defeats the point of having the query at all.

## When to Apply

**Use FROM-redirect with a real pool when:**

- The test's focus is which rows the SQL selects — JOIN type, HAVING, FILTER, ROW_NUMBER ranking, or any construct whose correctness depends on how the planner processes the data.
- The discriminating graph cannot be seeded into the live HAF corpus per test without broadcasting real chain ops and waiting out indexing lag.
- The production query is a CTE or composed body that can be exported and imported verbatim.

**Result-mocking (`pool.query` returns a fixture) stays correct when:**

- The test's focus is downstream of the SQL — response envelope, HTTP status, route plumbing, call counts, budget/timeout/invalidation accounting — behavior that is the same regardless of which rows the query returns.
- The discriminating scenario is in the surrounding application logic, not in what the SQL selects.

The clearest rule: **mock the result only when you are not asserting which rows the SQL selects. If the rows matter, run real SQL.** (When result-mocking IS the right call for a HAF route test, the mocked-pool route-test recipe applies: `getGenesisBlock → 0` plus a complete Redis mock, since the shared test setup otherwise pollutes the genesis cache via the real pool.)

## Examples

**The redirect no-op guard, the canonical form (from `active-vouches-signer-gate.test.ts`):**

```ts
const body = activeVouchesCteBody(1);
// Redirect the CTE's FROM at the real HAF view to the synthetic row set;
// everything else (the `?` gate, the per-pair ROW_NUMBER ranking, the
// rn=1 AND action='vouch' active filter) is the production SQL verbatim.
const redirected = body.sql.replace(T.customJson, 'synthetic_cj');
// Fail fast if the table-reference string drifts and the redirect no-ops,
// rather than letting a behavioral assertion pass against the live corpus.
expect(redirected).not.toContain(T.customJson);
```

**The full redirect + synthetic VALUES assembly (from the `runDiscovery` helper in `wot-broadcast-timeout.test.ts`):**

```ts
const cte = buildWith(1, activeAccreditationsCteBody, activeVouchesCteBody);
// buildWith() prefixes `WITH `; strip it so our own synthetic CTE can lead.
const cteBodies = cte.sql.replace(/^\s*WITH\s+/, '');
const redirectedCte = cteBodies.split(`${T.customJson} cj`).join('synthetic_cj cj');

// ... build valueLines[] and params[] from the test's accreditations + vouches ...

const sql = `
  WITH synthetic_cj(id, custom_id, json, required_posting_auths, block_num) AS (
    VALUES
      ${valueLines.join(',\n        ')}
  ),${redirectedCte}
  ${cascadeDiscoverySelect(revokedParam, thresholdParam)}`;

const result = await discoveryPool!.query<{ vouchee: string }>(sql, params);
return result.rows.map((r) => r.vouchee).sort();
```

The `synthetic_cj` VALUES set carries the same column names and types the production CTE bodies expect (`custom_id`, `json`, `required_posting_auths`, `block_num`, `id`). The appTag bind is reused as the `custom_id` value for every synthetic row so the `WHERE custom_id = $1` gate admits them; distinct `block_num` values per row keep the ROW_NUMBER ranking deterministic.

## Related

- `conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — the parent rule this satisfies: a test that cannot go RED on the mutation it claims to guard is vacuous. A result-mock is mutation-blind to JOIN/HAVING/FILTER changes; FROM-redirect makes the test fail RED on them.
- `conventions/test-mock-carve-out-clause-c-2026-05-04.md` — governs when mocking is acceptable. This technique is the affirmative alternative for the non-acceptable case (focus IS the SQL selection logic), and supplies the clause-(c) real-path companion for the SQL-shape risk class.
- `conventions/pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16.md` — the first procedural mention of "synthetic-VALUES + real Postgres" (as a crash-prevention canary for an SRF guard). This doc promotes the same machinery to a named convention for selection-logic parity.
- `test-failures/assertion-vacuity-from-upstream-bail-in-mocked-tests-2026-05-17.md` — sibling failure mode in mocked HAF-pool tests (an upstream bail vacates downstream canaries) that running real SQL structurally avoids.
- `conventions/pg-bigint-default-stringification-defeats-typeof-cast-guards-2026-05-06.md` — same family: an assertion that passes for the wrong reason because the test observes a layer the author did not intend to measure.
- `conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` — the complementary layer: a source-level SQL-shape pin alongside a synthetic-VALUES behavioral canary pins both the string and the runtime behavior.
- `conventions/pg-typed-query-generic-compile-time-only-not-sql-projection-guard-2026-06-09.md` — the consumer-side reason this technique is the required companion for a typed query: `pool.query<T>` is compile-time-only and will not catch a `SELECT`-column drop, so a real-path test (FROM-redirect or real-HAF) is the only guard against projection drift on a security/correctness-critical predicate.

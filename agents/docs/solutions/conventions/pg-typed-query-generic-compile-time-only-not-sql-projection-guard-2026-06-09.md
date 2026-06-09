---
title: A typed pool.query<T> is compile-time-only — it catches a TS-read-side field change but not a SQL-side SELECT-column drop, so it does not guard against projection drift
date: 2026-06-09
category: conventions
module: backend
problem_type: convention
component: database
severity: medium
applies_when:
  - Writing or reviewing a pool.query<RowType>() whose result feeds a security-adjacent or correctness-critical predicate
  - Drafting a hold-block, commit message, or docblock that credits a type parameter with protecting against SQL or column drift
  - Deciding whether a typed query needs a companion behavioral/real-path test
  - Reviewing a comment that asserts a typed query "cannot silently no-op" or "cannot silently drift"
tags:
  - postgres
  - typescript
  - haf-sql
  - testing
  - security-adjacent
---

# A typed `pool.query<T>` is compile-time-only, not a guard against SQL-projection drift

## Context

In node-postgres, a typed query `pool.query<RowType>(sql, params)` looks like it pins the SQL result shape to `RowType`. It does not. The generic is a **compile-time-only assertion** about how TypeScript code reads `result.rows[i].*`. pg performs **zero runtime validation** that the columns the SQL `SELECT` projects actually match `RowType` — it returns whatever the SQL string projects, and the generic only types the accessor side. The two sides of the contract can drift apart silently.

This surfaced in the paper-detail enrichment path. `fetchEnrichmentFromHaf` (`backend/src/routes/papers.ts`) runs a `pool.query<ClaimsRow>(...)` whose `SELECT` projects `claimer, ..., status, claimed_at`, then builds a security-adjacent self-vote exclusion:

```ts
const acceptedClaimers = new Set<string>();
for (const r of claimsResult.rows) {
  if (r.status === 'accepted') acceptedClaimers.add(r.claimer);
}
```

The native-vote loop and the revote loop both skip `acceptedClaimers`, so a credited authorship-claimer cannot inflate the displayed `net_votes` with a self-vote. A re-review hold prescribed the `<ClaimsRow>` type parameter specifically "so a future projection change to the claims SELECT (status renamed or dropped) would NOT silently leave `acceptedClaimers` empty and reopen the self-dealing gap," and the landing commit message asserted the type means the exclusion "cannot silently no-op." Both claims are wrong about the failure mode they name.

## Guidance

Treat `pool.query<T>(...)` as **TS-read-side typing only**. It documents the row contract and is strictly better than `any`, but it does not protect against SQL-projection drift.

The asymmetry to internalize:

- **CAUGHT (compile error):** a TS-read-side change — renaming/removing a field on `RowType`, or consuming code reading a field `RowType` does not declare. The compiler flags the use site.
- **NOT CAUGHT:** a SQL-side change — editing the `SELECT` string to drop or rename a projected column. After a SQL-only drop, `r.field` is `undefined` at runtime, `r.field` **still compiles** (because `RowType` still declares it), and any predicate over it silently misbehaves. No compile error, no runtime throw.

Two rules follow:

1. **When a typed query feeds a security-adjacent or correctness-critical predicate, the type parameter is NOT the guard.** Pair it with a behavioral test that exercises the actual SQL projection through to the JS consumer and fails red if a projected column is dropped or renamed — a real-HAF test, or the FROM-redirect synthetic-`VALUES` technique (see related convention). Only an end-to-end `SELECT -> rows -> predicate` exercise detects projection drift.
2. **Do not assert in a hold-block, commit message, or docblock that `pool.query<T>` prevents SQL-projection drift.** Scope the claim precisely: it catches TS-read-side drift, documents the row contract, and improves on `any`. It does not detect a dropped or renamed projected column.

## Why This Matters

The whole point of the prescribed type here was to make a self-dealing security gap fail loudly if the claims projection changed. The type delivers the opposite of the prescribed protection against the named threat. Drop `status` from the `SELECT` and: `r.status` is `undefined` at runtime, `r.status === 'accepted'` is never true, `acceptedClaimers` stays empty, neither vote loop skips anyone, and a credited claimer's self-vote re-inflates `net_votes` — with **no compile error and no runtime error**. Worse than a silent gap: the codebase would carry a comment and a commit message both asserting this cannot happen, so a future reader trusts the type as the guard and skips the real test.

The type was still correctly accepted as-is — it is a net improvement, and the `SELECT` currently projects every consumed column, so the drift test is deferrable as preemptive hardening (consistent with the project posture of dismissing theoretical-only test hardening). The durable lesson is narrower and must outlive that triage decision: **the type is not the guard; do not overstate it**, so the next agent does not re-prescribe `pool.query<T>` as projection-drift protection.

## When to Apply

- Writing or reviewing any `pool.query<T>(...)` (or equivalent typed driver call) whose result feeds a predicate that gates security, voting, access, or any correctness-critical branch.
- Drafting an architect hold-block, commit message, or docblock that credits a type parameter with protecting against SQL or column drift — scope the claim to TS-read-side typing instead.
- Deciding whether a typed query needs a companion behavioral test: it does when a SQL/JS column drift would silently break the consumer, even if the current `SELECT` projects every consumed column (the test is then deferrable-but-documented, not unnecessary).
- Reviewing a comment asserting a typed query "cannot silently no-op" or "cannot silently drift" — verify the assertion is scoped to the TS-read side, not the SQL-projection side.

## Examples

The silent SQL-drop no-op — a one-line `SELECT` edit reopens the self-dealing gap with no compiler or runtime complaint:

```ts
type ClaimsRow = { claimer: string; /* ... */ status: string; claimed_at: string };

// BEFORE — status projected; r.status is 'accepted' | 'pending' | ...
//   SELECT claimer, paper_author, paper_permlink, author_index, status, claimed_at
//   -> acceptedClaimers populated -> both vote loops skip credited claimers

// AFTER — a refactor drops `status` from the projection:
//   SELECT claimer, paper_author, paper_permlink, author_index, claimed_at
//   pg does NOT error: it returns rows without a `status` column
//   r.status STILL COMPILES: ClaimsRow still declares status: string
//   r.status is `undefined` at runtime
//   r.status === 'accepted' is never true
//   -> acceptedClaimers stays EMPTY -> neither loop skips anyone
//   -> a credited claimer's self-vote re-inflates net_votes
//   No compile error. No runtime throw. Silent self-dealing regression.
```

What the type *does* catch (the TS-read side), for contrast — removing `status` from the **type** is a compile error at the use site:

```ts
type ClaimsRow = { claimer: string; /* status removed */ claimed_at: string };
// if (r.status === 'accepted') ...  -> TS2339: Property 'status' does not exist
```

The behavioral guard the type cannot replace — exercise the real projection through to the consumer so a dropped column fails red:

```
Real-HAF or FROM-redirect synthetic-VALUES test:
  seed an 'accepted' claim for claimer X, inject X's self-vote (native AND revote),
  call the enrichment path, assert net_votes EXCLUDES X.
If a future SELECT edit drops `status`, acceptedClaimers empties, X's vote is
counted, net_votes is wrong -> the test fails. The type never would.
```

## Related

- `pg-bigint-default-stringification-defeats-typeof-cast-guards-2026-05-06.md` — the closest sibling and the same meta-pattern (a pg/TS surface relied on as a runtime guard that is not one). That doc covers VALUE coercion (a `bigint` column arrives as a JS string regardless of a `::text` cast, so `typeof === 'string'` is a placebo); this doc covers COLUMN PRESENCE (a field dropped from the `SELECT` is not caught by the TS generic). Distinct failure axes, shared root: pg/TS typing is not a runtime SQL contract.
- `test-haf-sql-selection-redirect-cte-from-synthetic-values-2026-06-09.md` — the prescribed companion test pattern: run real SQL against a real planner via a FROM-redirect to synthetic `VALUES`, rather than trusting the generic. Its "mock the result only when you are not asserting which rows the SQL selects" rule generalizes to "...which columns the SQL projects."
- `defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` — the typed query is not a defense layer and cannot canary one; each runtime layer needs its own behavioral pin.
- `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — parent rule: a guard that does not fail on the mutation it claims to prevent is a vacuous spec.
- `test-mock-carve-out-clause-c-2026-05-04.md` — mocking `pool.query` is specifically insufficient for the SQL-projection-drift risk class (the mock supplies the columns the real `SELECT` might have dropped).
- `vote-resolution-native-revote-2x2-gate-2026-06-09.md` — the incident-site context: what the accepted-claimer self-vote exclusion does across the native/revote x listing/detail cross-product.
- `discipline-interface-tsc-perimeter-omission-2026-05-11.md` — sibling in the "a TypeScript guarantee silently does not apply" family (there, the consumer is outside the `tsc` perimeter; here, the construct never reaches runtime).

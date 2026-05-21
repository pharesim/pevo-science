---
module: backend
date: 2026-05-16
problem_type: convention
component: database
severity: high
tags:
  - postgres
  - jsonb
  - jsonb_array_elements
  - cross-join-lateral
  - evaluation-order
  - cascade-fail
  - defensive-sql
applies_when:
  - "Calling CROSS JOIN LATERAL jsonb_array_elements(...) (or any set-returning function) on JSONB whose array-ness cannot be guaranteed upstream"
  - "Auditing whether a sibling site's `WHERE jsonb_typeof(...) = 'array'` guard actually protects a LATERAL SRF"
  - "Reviewing a hold-block fix that closes a cascade-fail at one CTE — every sibling LATERAL SRF on the same field family needs the same shape audit"
related_components:
  - reputation_cycle
  - haf_query_layer
---

# CROSS JOIN LATERAL `jsonb_array_elements` — the type-guard MUST be in the SRF argument, not in a WHERE clause

## Context

Postgres evaluates `CROSS JOIN LATERAL <set-returning function>` BEFORE applying the WHERE clause. A guard of the form

```sql
SELECT ...
FROM rows
CROSS JOIN LATERAL jsonb_array_elements(rows.json_metadata -> 'authors') AS a
WHERE jsonb_typeof(rows.json_metadata -> 'authors') = 'array'   -- TOO LATE
```

is INEFFECTIVE. The lateral SRF expands first; if any input row has a non-array `authors` value (JSONB null literal, string, integer, object), `jsonb_array_elements` raises `cannot extract elements from a scalar` before the WHERE filter has a chance to reject the row. The query crashes for the whole batch.

The WHERE-clause guard has the APPEARANCE of protection (it reads like a type check) but not the reality. A code reviewer skimming the query sees "we guard with `jsonb_typeof`" and moves on; a chain post broadcasting `pevo.authors: null` crashes the consumer.

## Guidance

**The `jsonb_typeof = 'array'` check MUST sit inside the SRF argument via CASE-WHEN, not in a downstream WHERE clause.** Use this shape:

```sql
SELECT ...
FROM rows
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(rows.json_metadata -> 'authors') = 'array'
       THEN rows.json_metadata -> 'authors'
       ELSE '[]'::jsonb
  END
) AS a
-- No WHERE-clause jsonb_typeof guard needed; the CASE-WHEN absorbs the non-array case.
```

For the equivalent NOT EXISTS subquery shape (when LATERAL is not the join form), the same CASE-WHEN goes around the SRF argument:

```sql
NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(rows.json_metadata -> 'authors') = 'array'
         THEN rows.json_metadata -> 'authors'
         ELSE '[]'::jsonb
    END
  ) a
  WHERE a ->> 'hive' = some_voter
)
```

The CASE-WHEN evaluates at the SRF call site, so a non-array input substitutes the empty-array literal before `jsonb_array_elements` runs. No throw, no cascade.

If the JSONB elements themselves can be non-objects (the `authors` array contains bare strings or other JSONB scalars), add an inner element-type guard so `->>'hive'` on a scalar element doesn't return NULL silently:

```sql
... WHERE jsonb_typeof(a) = 'object' AND a ->> 'hive' = some_voter
```

This is a SEPARATE concern from the outer array-guard — see `pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12.md` for the per-element shape-check rationale.

## Why This Matters

The Postgres documentation describes LATERAL evaluation order plainly, but the WHERE-clause-after-LATERAL anti-pattern reads as protective and passes code review repeatedly. In PEvO this trap defeated multiple rounds of review on the reputation-cycle CTEs (`paper_resolved_votes`, `citing_papers`) and on listing-path helpers (`authorsWithSupersessionSelect`, `profile`/`stats` per-user CTEs) before independent reviewers converged on the actual evaluation order. A WHERE-clause `jsonb_typeof(...) = 'array'` guard on a `CROSS JOIN LATERAL jsonb_array_elements(...)` reads exactly like the safe shape but provides zero protection.

The cycle-cascade blast radius matters: a SINGLE chain post with malformed `pevo.authors` or `pevo.citations` crashes `computeReputationBatch` for EVERY user until the malformed post is edited or removed. The architect cannot patch the data (chain is the source of truth); the only mitigation is upgrading every PEvO instance to a defended build. The listing-path sites (`authorsWithSupersessionSelect` consumed by `/api/papers`, the profile/stats per-user CTEs) have narrower per-request blast radius but the same shape.

## When to Apply

- **Always** when introducing a new `CROSS JOIN LATERAL jsonb_array_elements(...)` (or any LATERAL SRF) on a JSONB field whose shape is not guaranteed by upstream validation.
- **At review time** when a hold-block fixes a cascade-fail at one CTE — audit every sibling LATERAL SRF on the same JSONB field family before declaring the fix complete.
- **At code-review time** when the diff includes the phrase `WHERE jsonb_typeof(...)` near a `CROSS JOIN LATERAL` — confirm the guard is in the SRF argument, not the WHERE clause, regardless of how protective the WHERE phrasing looks.

## Examples

### Correct (CASE-WHEN at SRF argument position)

The reference implementation is `excludeSelfReviewWhere` in `backend/src/hafsql.ts` — the NOT EXISTS subquery guards `p.json_metadata -> $tag -> 'authors'` with a CASE-WHEN at SRF argument position, then layers an inner `jsonb_typeof(auth) = 'object'` element-shape guard inside the subquery's WHERE clause:

```sql
NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(p.json_metadata -> $tag -> 'authors') = 'array'
         THEN p.json_metadata -> $tag -> 'authors'
         ELSE '[]'::jsonb
    END
  ) auth
  WHERE jsonb_typeof(auth) = 'object'
    AND auth ->> 'hive' = c.author
)
```

Sibling sites in the cycle-cascade class — the `paper_resolved_votes` CTE and the `citing_papers` CTE in `computeReputationBatch` — use the same CASE-WHEN-at-SRF-arg shape. The listing-path helper `authorsWithSupersessionSelect` in `backend/src/hafsql.ts` and the per-user CTEs in `backend/src/routes/profile.ts` + `backend/src/routes/stats.ts` use the same shape with narrower (per-request) blast radius.

### Anti-pattern (WHERE-clause guard after LATERAL — fires too late)

```sql
CROSS JOIN LATERAL jsonb_array_elements(citing.json_metadata -> $tag -> 'citations') AS cit
...
WHERE jsonb_typeof(citing.json_metadata -> $tag -> 'citations') = 'array'   -- ❌ TOO LATE
```

Postgres expands the LATERAL SRF on every input row before applying the WHERE filter. A non-array `citations` value crashes `jsonb_array_elements` before the WHERE clause has a chance to reject the row. Same trap on `pevo.authors` (`authorsWithSupersessionSelect`'s ancestor shape) and `image` array fields in IPFS-pin checks.

Worse anti-pattern: no guard at all. The unguarded form has the same failure mode but reads as "we didn't think about it" rather than "we thought about it and got the placement wrong"; both crash identically.

### Migration pattern

To migrate an anti-pattern site:

1. Move the `jsonb_typeof = 'array'` check from the WHERE clause INTO the SRF argument via CASE-WHEN with `ELSE '[]'::jsonb` fallback.
2. Remove the now-redundant WHERE-clause guard (it does no work pre-fix and continues to do no work post-fix; deleting it tightens the SQL).
3. Add a behavioral canary per the `defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` convention: synthetic-VALUES + real Postgres feeding non-array shapes (null literal, string, integer, object) and asserting the query does NOT raise.

## Related

- `agents/docs/solutions/conventions/pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12.md` — sibling: the WHERE-predicate form of "the JSONB type guard looks correct but isn't" (covers `IS NOT NULL` placebo on JSONB paths).
- `agents/docs/solutions/conventions/pg-bigint-default-stringification-defeats-typeof-cast-guards-2026-05-06.md` — third family member: JS-driver layer where a naive `typeof === 'number'` guard fails on Postgres bigint stringification.
- `agents/docs/solutions/conventions/sql-semantic-shift-cross-surface-audit-2026-05-12.md` — protocol for auditing sibling sites when a SQL gate semantics changes. Run this when migrating an anti-pattern site so every consumer of the same JSONB field is audited.
- `agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` — per-layer canary discipline; each migrated SRF site needs its own behavioral canary that feeds a non-array shape and asserts no crash.
- `agents/docs/solutions/conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md` — when a hold-block fixes one site, enumerate every sibling site in widening rings before declaring the fix complete. The LATERAL trap is the canonical motivating example.

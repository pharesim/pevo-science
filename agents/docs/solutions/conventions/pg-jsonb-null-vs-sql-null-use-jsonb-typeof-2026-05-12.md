---
title: "Postgres JSONB null is distinct from SQL NULL: use jsonb_typeof() for shape validation, not IS NOT NULL"
date: 2026-05-12
category: conventions
module: backend/src/hafsql.ts
problem_type: convention
component: database
severity: medium
applies_when:
  - "Writing a SQL WHERE clause that must reject a JSONB sub-key whose value is JSON null, a non-object, or absent"
  - "Shape-validating a JSONB path that must contain a specific type (object, number, string, array, boolean)"
  - "Reviewing a SQL guard that uses `IS NOT NULL` on a JSONB expression and assuming it catches `{key: null}`"
  - "Writing a JS/TS guard on a JSONB-derived value and using `typeof x === 'object'` to reject non-objects"
  - "Adding a canary or regression test for a JSONB validation helper"
root_cause: wrong_api
resolution_type: code_fix
tags:
  - postgres
  - jsonb
  - sql-null
  - jsonb-typeof
  - type-validation
  - hafsql
  - shape-guard
  - javascript-typeof
---

# Postgres JSONB null is distinct from SQL NULL — use `jsonb_typeof()` for shape validation, not `IS NOT NULL`

> **Companion to** [`pg-bigint-default-stringification-defeats-typeof-cast-guards-2026-05-06.md`](pg-bigint-default-stringification-defeats-typeof-cast-guards-2026-05-06.md) (sibling Postgres-type-system trap, JS-layer instance). That doc covers how the driver's bigint-to-string default mapping defeats `typeof === 'number'` assertions; this doc covers how Postgres's JSONB-null vs SQL-NULL distinction defeats `IS NOT NULL` shape assertions. Together they form a small family: "Postgres type-system counter-intuition makes a naive guard a placebo."

## Context

PEvO's `backend/src/hafsql.ts` centralizes valid-review filtering in a single `validReviewWhere` helper applied at ten review-aggregating query sites (commit `8be9206`, `backend(reviews): canonical validReviewWhere helper + display↔reputation parity`). The first clause of that helper reads:

```sql
AND c.json_metadata -> $appTag -> 'rating' IS NOT NULL
```

The intent is plain: "rating must be present and non-null." The clause is, however, a placebo for JSONB paths. Postgres maintains two distinct null concepts inside JSONB. SQL NULL means the column value or path itself is absent — `IS NOT NULL` excludes that. JSONB null is an explicit JSON literal stored inside the document: `'{"rating": null}'`. When Postgres evaluates `IS NOT NULL` on a JSONB expression that resolves to the JSONB null literal, it returns `TRUE`, because from SQL's perspective the path is present — it has a value, and that value is the JSON null token. Confirm with `SELECT 'null'::jsonb IS NOT NULL;` — result: `t`. A review row whose `json_metadata` contains `{"pevotest": {"type": "review", "rating": null}}` passes the `IS NOT NULL` gate without a correctly shaped rating object.

This surfaced during `/ce-code-review` of commit `8be9206` (adversarial reviewer, P3, anchor 75). The gate is currently rescued by four downstream regex clauses that test individual sub-keys of the rating object. When the `rating` JSONB path is the null literal, `->> 'methodology'` on a JSONB-null parent returns SQL NULL; `NULL ~ '^[1-5]$'` evaluates to NULL, which Postgres treats as false in a WHERE clause. The row is correctly excluded — but by the regex chain, not by the `IS NOT NULL` clause.

## Guidance

When shape-validating a JSONB sub-key, never use `IS NOT NULL`. Use `jsonb_typeof(<path>) = '<expected-type>'` instead.

`jsonb_typeof` returns a text string describing the JSON type of the value at the path, with a special case for SQL NULL (absent path):

| Input at path | `jsonb_typeof` returns |
|---|---|
| `{...}` (JSON object) | `'object'` |
| `[...]` (JSON array) | `'array'` |
| `"foo"` (JSON string) | `'string'` |
| `42` or `4.2` (JSON number) | `'number'` |
| `true` / `false` (JSON boolean) | `'boolean'` |
| `null` (JSONB null literal) | `'null'` (the string) |
| Path absent / column is SQL NULL | `NULL` (SQL NULL) |

Comparing to `'object'` admits exactly one case — a JSON object — and excludes JSONB null, arrays, scalars, and absent paths in a single self-documenting clause. The comparison returns false (or NULL) for every non-object shape, so no additional `IS NOT NULL` guard is required alongside it.

**SQL↔JS parity note.** `jsonb_typeof(...) = 'object'` rejects arrays as well as JSONB null. The JS-side validator in `backend/src/helpers.ts` uses `typeof rating !== 'object'` to guard the same field. `typeof []` is `'object'` in JS, so that check admits arrays, breaking parity with the SQL layer. Mirror the SQL fix by adding `|| Array.isArray(rating)`:

```ts
// Before (admits arrays)
if (typeof rating !== 'object' || rating === null) { ... }

// After (matches jsonb_typeof = 'object' semantics)
if (typeof rating !== 'object' || rating === null || Array.isArray(rating)) { ... }
```

Maintain this parity whenever a shape check appears at both the SQL and JS layers for the same field.

## Why This Matters

The `IS NOT NULL` clause reads as though it is load-bearing: a shape check that, if removed, would let malformed rows through. It is not. A future maintainer auditing the helper might reason: "the IS NOT NULL clause prevents rating-less rows from affecting aggregates; the regex lines below are a value-range check on top of that." On that reading, the regex chain looks like a bonus constraint rather than the actual gate. Deleting the four regex lines would not produce an error — it would silently break review validation.

The failure chain if the regex lines were dropped: rows with `rating: null` survive the `IS NOT NULL` clause. Each sub-key access (`->> 'methodology'`, etc.) on a JSONB-null parent returns SQL NULL. `NULL::numeric` is valid in Postgres and produces NULL. `AVG(NULL, NULL, NULL, NULL)` returns NULL. The reputation computation hits `COALESCE(pr.quality, 1.0)`, inflating every paper's reputation score that has even one such malformed review row to the floor quality value of 1.0 — silently, with no error, no log line, and no failing assertion. **This is strictly worse than a crash.** A `::numeric` cast on a string rating would raise a runtime error and halt the cycle; the JSONB-null path produces an answer that looks correct.

## When to Apply

- Any SQL clause whose purpose is to verify that a JSONB path contains a value of a specific shape (object, array, string, number, boolean) — replace `IS NOT NULL` with `jsonb_typeof(<path>) = '<expected-type>'`.
- Any JS validator for a field that will be shape-checked in SQL via `jsonb_typeof = 'object'` — add `|| Array.isArray(value)` to the `typeof !== 'object'` guard to maintain parity.
- Any code review or audit where `IS NOT NULL` appears on a JSONB path expression — treat it as a potential placebo until the downstream clauses are confirmed to cover the JSONB-null case.

Do NOT apply this rule where `IS NOT NULL` is genuinely checking SQL NULL on a non-JSONB expression. For example, asserting the entire `json_metadata` column is non-NULL (`WHERE json_metadata IS NOT NULL`) is a correct SQL-NULL check — the column itself either has a value or it does not; no JSONB-null ambiguity applies at that level. The trap arises only when the expression is a JSONB path operator result (`->`, `->>`, `#>`, `#>>`).

## Examples

**SQL shape-check, before and after:**

```sql
-- Before: IS NOT NULL admits JSONB null, making the clause a placebo
AND c.json_metadata -> $appTag -> 'rating' IS NOT NULL

-- After: jsonb_typeof rejects JSONB null, arrays, scalars, and absent paths
AND jsonb_typeof(c.json_metadata -> $appTag -> 'rating') = 'object'
```

**Postgres semantics reference (verify in psql):**

```sql
SELECT jsonb_typeof('{"a":1}'::jsonb);    -- object
SELECT jsonb_typeof('[1,2]'::jsonb);      -- array
SELECT jsonb_typeof('"foo"'::jsonb);      -- string
SELECT jsonb_typeof('42'::jsonb);         -- number
SELECT jsonb_typeof('true'::jsonb);       -- boolean
SELECT jsonb_typeof('null'::jsonb);       -- null  (the string, not SQL NULL)
SELECT jsonb_typeof(NULL::jsonb);         -- NULL  (SQL NULL)

-- The IS NOT NULL trap:
SELECT 'null'::jsonb IS NOT NULL;                 -- t  (TRUE — JSONB null passes IS NOT NULL)
SELECT jsonb_typeof('null'::jsonb) = 'object';    -- f  (FALSE — correctly excluded)
```

**JS-side parity fix:**

```ts
// SQL: jsonb_typeof(rating) = 'object'   -- rejects array, scalar, JSONB null
// JS before — typeof admits arrays:
if (typeof rating !== 'object' || rating === null) {
  throw new Error('rating must be an object');
}

// JS after — matches SQL semantics exactly:
if (typeof rating !== 'object' || rating === null || Array.isArray(rating)) {
  throw new Error('rating must be an object');
}
```

**Dangerous deletion pattern this prevents:**

A well-intentioned simplification that looks safe but isn't — removing the four regex lines on the assumption that `IS NOT NULL` already enforced "rating object present." Result: rows with `rating: null` survive, `AVG` returns NULL, `COALESCE(pr.quality, 1.0)` silently inflates reputation scores. The `jsonb_typeof = 'object'` rewrite makes the simplification safe by itself; the regex lines still belong (they enforce value-range, which `jsonb_typeof` does not), but they are no longer the sole gate against malformed shapes.

## Related

- [`pg-bigint-default-stringification-defeats-typeof-cast-guards-2026-05-06.md`](pg-bigint-default-stringification-defeats-typeof-cast-guards-2026-05-06.md) — same family (Postgres type-system counter-intuition defeats a naive guard). That doc is the JS-layer instance (driver maps INT8 to JS string by default, defeating `typeof === 'number'`); this doc is the SQL-predicate-layer instance (JSONB null passes `IS NOT NULL`, defeating shape assertions).
- [`sql-semantic-shift-cross-surface-audit-2026-05-12.md`](sql-semantic-shift-cross-surface-audit-2026-05-12.md) — companion learning from the same review (commit `8be9206`). That doc covers what to audit when a gate's admit/exclude semantics shift; this doc covers why the gate's `IS NOT NULL` clause was a placebo.
- [`pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`](pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md) — establishes `validReviewWhere` / `validPevoPaperWhere` as the canonical SQL helpers where the JSONB-null trap lives. The convention's centralized-helper design is what makes the trap fixable at one site instead of ten.
- [`defense-in-depth-canary-must-pin-each-layer-2026-05-07.md`](defense-in-depth-canary-must-pin-each-layer-2026-05-07.md) — adjacent test discipline. A canary that pins `IS NOT NULL` shape assertions must be migrated alongside the predicate to pin the corrected `jsonb_typeof` form, otherwise the canary itself enforces the wrong contract.
- [`js-coercion-mutation-kill-vector-2026-05-04.md`](js-coercion-mutation-kill-vector-2026-05-04.md) — broader family (an operator that looks like a type/null check passes for structural/semantic reasons unrelated to what you're guarding).
- [`pg-jsonb-containment-vs-extract-type-coercion-2026-06-06.md`](pg-jsonb-containment-vs-extract-type-coercion-2026-06-06.md) — sibling axis: `@>` containment is type-sensitive while `->>` extraction text-coerces, so rewriting one into the other silently widens match semantics; the fix is `jsonb_typeof = 'string'` guards on every extracted key.

---
title: pg's default `bigint` to JS string mapping makes `typeof === 'string'` a placebo for `::text` cast guards in real-HAF tests
date: 2026-05-06
category: conventions
module: backend/tests
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - Writing a real-HAF or real-Postgres integration test that projects a `bigint` (or other pg-default-stringified) column through node-postgres
  - Adding a regression guard intended to detect removal of a `::text` cast on a numeric column
  - Reviewing an assertion that claims `typeof x === 'string'` proves a SQL-level `::text` cast is in place
tags:
  - testing
  - postgres
  - pg-types
  - bigint
  - sql-cast
  - real-haf
  - type-safety
related_components:
  - database
---

# pg's default `bigint` to JS string mapping makes `typeof === 'string'` a placebo for `::text` cast guards in real-HAF tests

## Context

PEvO's `backend/tests/` integration tests run against real HAF (Hive Application Framework) PostgreSQL views. Several queries cast bigint columns to text — for example `SELECT cj.id::text AS op_id` against `hafsql.operation_custom_json_view` — to preserve full numeric precision when the value crosses the JS boundary. JavaScript's `Number` only safely represents integers up to 2^53 - 1; PostgreSQL `bigint` is 64-bit. Hive op ids routinely exceed `Number.MAX_SAFE_INTEGER`.

A natural impulse when writing a regression guard for that cast is:

```ts
expect(typeof row.op_id).toBe('string'); // intended: "fail if someone drops ::text"
```

This assertion is a **placebo**. It passes identically whether the SQL projects `cj.id::text AS op_id` or `cj.id AS op_id`. A regression that silently drops the cast does not trip this test. The pattern surfaced in `backend/tests/consent-ops-real-haf.test.ts` at commit `5788519` during `/ce-code-review` (correctness + testing reviewers, anchor 100), and the same antipattern will recur anywhere a test author reasons "bigint must become string for JS, so `typeof === 'string'` proves it."

## Guidance

When a test exists to guard a `::text` cast (or any other column-type projection decision) on a numeric column read through node-postgres, **assert on column metadata via the `QueryResult.fields` array, not on the JavaScript runtime type of the row value**.

Preferred form — assert on `dataTypeID`:

```ts
const result = await pool.query(`
  SELECT cj.id::text AS op_id
  FROM hafsql.operation_custom_json_view cj
  WHERE cj.id = $1
  LIMIT 1
`, [opId]);
const opIdField = result.fields.find(f => f.name === 'op_id');
expect(opIdField?.dataTypeID).toBe(25); // 25 = text OID; 20 = int8/bigint OID
```

Alternative form — project `pg_typeof()` and assert on the runtime PostgreSQL type name:

```sql
SELECT cj.id::text AS op_id, pg_typeof(cj.id::text) AS op_id_pg_type
FROM hafsql.operation_custom_json_view cj
WHERE cj.id = $1
LIMIT 1
```

```ts
expect(row.op_id_pg_type).toBe('text');
```

Both forms actually distinguish the cast from its absence. The `dataTypeID` form is preferable when the test already has the `QueryResult` in hand. The `pg_typeof` form is preferable when the assertion lives downstream of a helper that only returns rows.

Antipattern to avoid:

```ts
// PLACEBO — passes identically with or without ::text
expect(typeof row.op_id).toBe('string');
expect(row.op_id).toMatch(/^\d+$/);
expect(() => BigInt(row.op_id)).not.toThrow();
```

All three assertions above are satisfied by pg's default INT8 stringification. They guard nothing about the cast.

## Why This Matters

The mental model "JavaScript has no native bigint, so PostgreSQL bigints must be cast to text to survive the JS boundary" is a half-truth that bridges from a real concern (precision preservation) to a false test-design claim (`typeof === 'string'` proves the cast).

The truth: **node-postgres maps PostgreSQL `bigint` (OID 20) to a JavaScript string by default.** The driver does this because JS `Number` cannot safely hold values above 2^53 - 1, so pg returns INT8 columns as decimal strings out of the box. No type-parser override is required. Confirm absence of any project-level override with:

```bash
grep -rn "setTypeParser" .  # returns nothing in PEvO at the time of this writing
```

Consequence: a `cj.id` column read through pg arrives in JS as a string regardless of whether the SQL casts it. The `::text` cast changes the projected column's PostgreSQL type (OID 20 to OID 25) but does not change the JS-side runtime type of the value, because both forms already arrive as strings. A `typeof === 'string'` assertion therefore cannot detect the cast being dropped, and a regression that removes `::text` will land green.

What `dataTypeID === 25` (or `pg_typeof = 'text'`) actually catches:

- Direct removal of `::text` on the column (`cj.id::text` becomes `cj.id`, flipping `dataTypeID` from 25 to 20).
- Refactors that replace the cast with a function returning a different type.
- Schema migrations that change the underlying column's type without updating the cast layer.

These are real regression classes the placebo test is silent on.

## When to Apply

- Any test under `backend/tests/` (or any node-postgres test) where the SQL query under test casts a numeric column to text (`::text`, `::varchar`, similar) for precision-preservation reasons, the test's stated intent is to guard against the cast being dropped, AND the current assertion is `typeof row.<col> === 'string'`, `expect(row.<col>).toMatch(/^\d+$/)`, or `BigInt(row.<col>)` parsability.
- The rule generalizes beyond bigint: any time the assertion's purpose is to pin the **projected PostgreSQL column type**, assert on `dataTypeID` or `pg_typeof()` rather than on the JS-side value's runtime type. The JS-side type is a downstream effect of the driver's parser config, not of the SQL projection.
- Do **not** apply this pattern when the assertion's purpose is to verify the JS-side value shape consumed by application code (for example, "the API contract returns a stringified id" against a route response). That is a legitimate `typeof === 'string'` check on a different load-bearing claim. The rule is: match the assertion to what is being guarded.

## Examples

Before — placebo assertion that passes with or without the cast (the actual bug pattern from `backend/tests/consent-ops-real-haf.test.ts`, commit `5788519`):

```ts
const result = await pool.query(`
  SELECT cj.id::text AS op_id, cj.json
  FROM hafsql.operation_custom_json_view cj
  WHERE cj.id = $1
  LIMIT 1
`, [opId]);
const row = result.rows[0];

// Intended as a guard against someone dropping ::text. It is not.
expect(typeof row.op_id).toBe('string');
expect(row.op_id).toMatch(/^\d+$/);
```

If a future change drops `cj.id::text` to plain `cj.id`, pg still returns the value as a string (default INT8 parser), and the test passes. The regression ships.

After — assert on the projected column's PostgreSQL type via `dataTypeID`:

```ts
const result = await pool.query(`
  SELECT cj.id::text AS op_id, cj.json
  FROM hafsql.operation_custom_json_view cj
  WHERE cj.id = $1
  LIMIT 1
`, [opId]);
const row = result.rows[0];

// Guard the cast, not the JS-side type.
const opIdField = result.fields.find(f => f.name === 'op_id');
expect(opIdField?.dataTypeID).toBe(25); // 25 = text; 20 = int8/bigint
expect(row.op_id).toBe(String(opId));   // separate assertion: value correctness
```

After (alternative) — `pg_typeof()` projection when the test only has rows in scope:

```sql
SELECT cj.id::text AS op_id,
       pg_typeof(cj.id::text) AS op_id_pg_type,
       cj.json
FROM hafsql.operation_custom_json_view cj
WHERE cj.id = $1
LIMIT 1
```

```ts
expect(row.op_id_pg_type).toBe('text');
expect(row.op_id).toBe(String(opId));
```

Reference OIDs for the common pg-default mappings that surface in PEvO queries:

| PostgreSQL type | OID  | pg default JS type                                     |
|-----------------|------|--------------------------------------------------------|
| `text`          | 25   | string                                                 |
| `varchar`       | 1043 | string                                                 |
| `int8` / bigint | 20   | string (driver default; no override needed)            |
| `int4`          | 23   | number                                                 |
| `numeric`       | 1700 | string                                                 |
| `timestamptz`   | 1184 | Date                                                   |

The bigint to string default is the specific trap; the broader rule (assert on what you mean to guard) covers the rest.

## Related

- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — parent rule. This convention is the general principle (every assertion must fail on a mutation of the code it claims to guard); the present doc is a pg-driver-specific instance where the placebo is invisible without driver-internal knowledge. That doc's `applies_when` list is a candidate for a refresh entry covering the type-assertion-on-driver-coerced-column pattern.
- `agents/docs/solutions/conventions/js-coercion-mutation-kill-vector-2026-05-04.md` — sibling. Same family ("typeof check passes for the wrong reason") at a different layer. There, JS-side `String()` wrapping flattens null to the literal string `"null"`; here, driver-side INT8 to string flattens int8 to the same JS type as text. Both render `typeof` checks structurally placebo.
- `agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md` — sibling abstraction (assertion passes whether or not the property holds). Same pattern in a mock-shape context.
- `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md` — situational. The rule above lives **outside** the carve-out scope; it applies to real-HAF tests where the assertion's failure mode is that the real-path test silently misses a SQL-shape mutation.
- `agents/docs/solutions/conventions/verify-library-claims-before-load-bearing-security-margins-2026-04-22.md` — sibling spirit. Verify driver/library default behavior empirically before depending on it. The `grep -rn setTypeParser` step in this doc is the verification primitive that establishes the pg-default claim for a given codebase.

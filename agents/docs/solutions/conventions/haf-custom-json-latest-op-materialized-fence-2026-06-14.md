---
title: "Sparse-match ORDER BY block_num DESC LIMIT over a HAF custom_json view needs an AS MATERIALIZED fence (block_num is a function, not a stored column)"
date: 2026-06-14
category: conventions
module: backend/src/wot.ts
problem_type: convention
component: database
severity: medium
applies_when:
  - "Reading the latest matching row from operation_custom_json_view with ORDER BY block_num DESC LIMIT n"
  - "The WHERE predicates can select a sparse or empty match set (e.g. a custom_id whose op may not exist on chain yet)"
  - "Any HAF view where block_num is a function over the operation id (hafd.operation_id_to_block_num) rather than a stored column"
  - "A short statement_timeout silently degrades the result to a hardcoded default when the query is slow"
root_cause: missing_index
resolution_type: code_fix
tags:
  - haf
  - custom-json
  - sql
  - cte-materialized
  - query-planner
  - statement-timeout
  - block-num-function
  - explain-analyze
---

# Sparse-match ORDER BY block_num DESC LIMIT over a HAF custom_json view needs an AS MATERIALIZED fence

## Context

`loadWotThreshold` in `backend/src/wot.ts` fetches the latest on-chain
`update_params` operation from HAF's `operation_custom_json_view` to derive
`min_accreditations_for_wot` (the Web-of-Trust auto-accreditation threshold). The
query ran under a `SET LOCAL statement_timeout = 5000` guard:

```sql
SELECT json
FROM operation_custom_json_view
WHERE custom_id = $1
  AND json::jsonb ->> 'action' = 'update_params'
  AND required_posting_auths ?| $2::text[]
ORDER BY block_num DESC
LIMIT 1
```

In production this query took ~18s on every 30-minute cache refresh, consistently
tripping the 5s timeout. On timeout the handler fell back silently to
`DEFAULT_WOT_THRESHOLD` (3). Because no on-chain `update_params` override had been
broadcast yet, the fallback happened to coincide with the correct threshold: a
**latent** correctness bug (it would serve the wrong threshold the instant any
operator broadcast an override, because the query times out before finding it)
plus a **present** recurring ~18s query and warn-log noise with no user-visible
symptom, making it easy to ignore.

## Guidance

Wrap the row match in a `WITH candidates AS MATERIALIZED (...)` optimization fence
so the planner resolves the small `custom_id`-indexed candidate set first, then
sorts and limits the already-tiny materialized result:

```sql
WITH candidates AS MATERIALIZED (
  SELECT json, block_num
  FROM operation_custom_json_view
  WHERE custom_id = $1
    AND json::jsonb ->> 'action' = 'update_params'
    AND required_posting_auths ?| $2::text[]
)
SELECT json
FROM candidates
ORDER BY block_num DESC
LIMIT 1
```

The `AS MATERIALIZED` keyword is load-bearing: it forces the planner to fully
evaluate the CTE before applying the outer `ORDER BY ... LIMIT`, so the sort/limit
runs over the small filtered set instead of driving the plan from a backward walk
of the blocks index. Verified against live HAF: ~15ms vs ~18s, and the blocks
index scan reports `(never executed)` in `EXPLAIN`. The fix is match-independent,
so it stays fast even once a real override exists and the candidate set is
non-empty.

**Anti-pattern — do NOT add a `block_num >= $floor` predicate** to narrow the scan
instead. On this view a floor flips the planner to a `BitmapAnd` against the full
view. That shape is prohibited by the `pevo/no-custom-id-block-num-floor` ESLint
rule; the `AS MATERIALIZED` fence is the correct alternative for the sparse-match
`DESC + LIMIT` case.

**Regression guard.** Real HAF cannot deterministically reproduce the ~18s vs
~15ms gap in CI, so the guard is a SQL-shape canary that asserts the resolved
query string carries `AS MATERIALIZED`, matching the file's existing signer-gate
canary pattern. Keep the `WITH candidates AS MATERIALIZED (...)` clause inline in
the query literal, not extracted into an interpolated `${...}` constant, or a
static-SQL canary/lint scanning the literal goes silently green (see Related).

## Why This Matters

The root cause is that `block_num` in `operation_custom_json_view` is computed by a
**function** at query time, `hafd.operation_id_to_block_num(o.id)`, not stored as
a column. The planner therefore cannot use any index to satisfy
`ORDER BY block_num DESC LIMIT 1` directly.

With a sparse or empty match set (e.g. when no `update_params` op has ever been
broadcast for the app tag), the planner satisfies the `DESC + LIMIT` by walking
the ~107M-row `blocks` index **backward** in a nested loop, probing each block
against the tiny `custom_id`-filtered candidate set. With zero matches it scans
nearly all 107M blocks to confirm none exist. `EXPLAIN (ANALYZE, BUFFERS)` showed
this as an ~8.6s index-only scan inside the ~18s query. The `custom_id = $1`
predicate **alone** already hits a good HAF index (`hafsql_id_opid_idx`, ~15 rows,
~12ms) — so the sole source of the blowup is the ORDER-BY-on-a-function-column
`DESC + LIMIT` over a sparse match.

HAF indexes are fixed external infrastructure: the operator manages them and PEvO
cannot add or modify one, so the remedy must be a PEvO-side query rewrite rather
than a new index. That is why an `AS MATERIALIZED` fence is the right path. (auto
memory [claude])

## When to Apply

Apply when **all** of these hold:

- The query reads from `operation_custom_json_view` (or any view that computes
  `block_num` via a function rather than storing it).
- The query uses `ORDER BY block_num DESC LIMIT n`.
- The match set can be **sparse or empty** — the `WHERE` predicates select rows
  that may not exist yet or exist only rarely.

Do **not** reach for the fence when:

- The query is also filtered on a Hive **account** column *and that account
  reliably has matching ops*. The real safety criterion is a **non-empty** match
  set, not the account filter itself: a selective filter that usually returns rows
  lets the backward scan find its row and stop early. A filter over an account
  with zero or near-zero matching ops is just as sparse as the `update_params`
  case and can hit the same pathology — prefer the fence there too.
- The ordering is a window function, `ROW_NUMBER() OVER (... ORDER BY block_num
  DESC)`. The set is gathered first and ordered within it, so the pathological
  backward scan does not arise the same way.
- The match set is reliably non-empty (a well-established `custom_id` with many
  ops). The nested-loop probe terminates early and the fence only adds overhead.

Only the `loadWotThreshold` case was verified empirically against live HAF. Treat
the guidance as confirmed for the sparse/empty `DESC + LIMIT` pattern; use judgment
for other shapes and EXPLAIN before generalizing.

**Verification methodology** (for anyone re-confirming): the HAF node has no `psql`
binary available, and pgbouncer rejects a `statement_timeout` startup parameter.
The approach that worked was loading the `pg` module via `createRequire` from
`/tmp` and issuing `EXPLAIN (ANALYZE, BUFFERS)` through the application pool. (auto
memory [claude])

## Examples

`backend/src/wot.ts` — `loadWotThreshold`, before and after:

```sql
-- Before: trips the 5s statement_timeout on a sparse match (~18s).
SELECT json FROM operation_custom_json_view
WHERE custom_id = $1
  AND json::jsonb ->> 'action' = 'update_params'
  AND required_posting_auths ?| $2::text[]
ORDER BY block_num DESC LIMIT 1

-- After: materialization fence (~15ms; blocks index scan never executed).
WITH candidates AS MATERIALIZED (
  SELECT json, block_num FROM operation_custom_json_view
  WHERE custom_id = $1
    AND json::jsonb ->> 'action' = 'update_params'
    AND required_posting_auths ?| $2::text[]
)
SELECT json FROM candidates
ORDER BY block_num DESC LIMIT 1
```

`backend/tests/wot-threshold-signer-gate.test.ts` — the SQL-shape canary that pins
the fence (captures the SQL the query issues through a stubbed pool and asserts the
keyword is present):

```ts
it('wraps the row match in an AS MATERIALIZED CTE', async () => {
  stubSelect([{ json: JSON.stringify({ action: 'update_params', params: { min_accreditations_for_wot: 5 } }) }]);
  await getWotThreshold();
  expect(capturedSql).toMatch(/\bAS\s+MATERIALIZED\b/i);
});
```

The canary does not measure HAF performance; it pins the query shape so a future
refactor that drops the fence fails red in CI before the regression reaches
production.

## Related

- `convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md` — to
  find other sparse-match `DESC + LIMIT` sites, sweep by the dangerous SQL pattern
  semantically, not by the function/file that happens to house it.
- `perf-floor-drop-removes-incidental-security-predicate-2026-05-25.md` — why the
  naive "just add a `block_num` floor" fix is banned (and, on `custom_json` reads,
  can also strip an authorship gate). The `AS MATERIALIZED` fence is the correct
  alternative.
- `correlated-subquery-to-cte-collapse-is-index-dependent-2026-06-14.md` — sibling
  planner-surprise on the same HAF view family; always EXPLAIN a shape change
  against live data rather than reasoning from the query text.
- `static-sql-lint-rule-blind-to-extracted-fragments-2026-06-14.md` — a static-SQL
  canary/lint that scans a query literal goes silently green if the guarded clause
  is extracted into an interpolated constant; keep the fence inline.
- `pevo/no-custom-id-block-num-floor` ESLint rule
  (`backend/tests/eslint/no-custom-id-block-num-floor.test.ts`) — enforces the
  anti-pattern ban above; names the `loadWotThreshold` custom_id-only shape as the
  allowed one.

Provenance: backend `loadWotThreshold` rewrite, commit `ca18ee81` on `main`.

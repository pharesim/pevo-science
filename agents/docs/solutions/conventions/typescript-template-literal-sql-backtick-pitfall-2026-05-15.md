---
title: "TypeScript template literals reject backtick-quoted identifiers in SQL comments — use bare names"
date: 2026-05-15
category: conventions
module: backend
problem_type: convention
component: tooling
severity: low
applies_when:
  - Authoring SQL inside a TypeScript template literal passed to pool.query() or a sibling DB helper
  - Writing SQL block comments inside that template literal that reference column or table names
  - Mirroring Postgres-style identifier quoting conventions in those comments
  - Editing comment clusters in backend files where SQL is built via template literal
  - Reviewing a backend PR where SQL comments include identifier names
related_components:
  - documentation
  - development_workflow
tags:
  - typescript
  - template-literal
  - sql
  - pool-query
  - backtick
  - tsc-parse-error
  - sql-comment
---

# TypeScript template literals reject backtick-quoted identifiers in SQL comments — use bare names

## Context

PEvO's backend composes SQL via TypeScript template literals — `pool.query(\`SELECT ... FROM hafsql.comments c WHERE ${someParam} ...\`)`. SQL block comments inside those template literals reference column and table names. The instinct is to use Postgres-style backtick-quoted identifiers in those comments (`-- this column maps to \`user_papers\``) for readability or because Postgres documentation often renders identifiers that way.

TypeScript parses the backtick first. A backtick inside a template literal terminates the outer template at the parser level — before SQL parsing is even relevant. The result is ~10 tsc parse errors clustered around the affected lines: mismatched template-literal close, expression-position confusion, type errors on the resulting partial expression, parser-recovery cascading into surrounding code.

The pattern has been hit twice in PEvO's backend, both during architect-hold-block fix commits where the implementer was writing rationale comments inside multi-line SQL strings:

- `backend(self-review-exclusion-everywhere): round-1 hold-fixes` (commit `39966f5`) — implementer hit the parse error during the first edit attempt; recovery dropped the backticks.
- `backend(review-validity-gate-and-display-reputation-parity): round-3 hold fixes` (commit `f77ae21`, items 2+5) — same symptom, same recovery. The round-4 signal block in that task explicitly cites incident 1 as the same mitigation pattern: identifiers like `getAllAccreditedAccounts`, `c.author IN target_users`, `validReviewWhere`, and `usernames` appeared as bare text in the recovered shape.

Two-incident pattern with identical failure mode and identical recovery, no solution doc surfaced, future implementers writing SQL comments inside TS template literals will rediscover the trap.

## Guidance

**Inside a TypeScript template-literal SQL string, never use backtick-quoted identifiers in SQL comments. Use bare identifier names.**

Postgres-style identifier quoting (`` `name` ``) is a SQL/Markdown rendering convention; TypeScript never lets it through. SQL block comments inside a `pool.query(\`...\`)` template can use any other style:

- **Bare identifier name** (recommended for PEvO): `-- this column maps to user_papers`. The convention purge in round-4 of `backend-review-validity-gate-and-display-reputation-parity` chose this shape: `-- ... the upstream filter c.author IN target_users already constrains to accredited authors ...`.
- **SQL double-quoted identifier**: `-- this column maps to "user_papers"` — works because `"` is not a TS template terminator and matches Postgres's actual case-sensitive delimited-identifier syntax.
- **No quoting at all**: usually fine in comments since context disambiguates.

The single rule: **no backticks inside a TS template literal.** This applies to SQL block comments (`--` and `/* */`), inline SQL comments inside expression positions, comment lines explaining a `${interpolation}`, and any prose that incidentally contains a backtick (e.g., a developer's prose referencing another file like `` `config.ts` `` — break those out into a JS-side comment above the template literal).

If readability genuinely demands a quote-style identifier inside the comment, prefer SQL's double-quote (`"name"`) since it works inside the template literal AND parses as a Postgres delimited identifier if SQL ever sees it.

## Why This Matters

**The TypeScript parser owns the backtick.** Inside a template literal, the backtick is the closing delimiter. The parser does not, and cannot, treat embedded backticks as content — even when they appear in a `-- SQL comment` context, even when they are inside a `/* multi-line */` block. SQL parsing is a downstream concern that never runs if tsc rejects the file first.

**The error cluster is large and looks unrelated to the actual cause.** When a backtick terminates the template literal mid-string, the parser sees an unexpected token sequence: an open-string expression, then identifier-name tokens, then the original closing backtick (which now reads as opening another empty template literal), then the `.query(` continuation. The compiler emits errors at each broken position — call-signature mismatch, expression statement, no-overload, unterminated string, etc. Implementers debugging see ~10 errors and have to recognize the cluster as one cause. The fix is a one-character delete per backtick; recognizing it without prior context takes minutes.

**The trap doesn't exist in IDE-only flows.** Modern editors highlight the broken template visibly (red squiggle on the entire span). The trap surfaces when backticks are added via dictation, copy-paste from Postgres documentation, or LLM-generated SQL comments — where the author may not see the IDE rendering before the tsc compile step. Both PEvO incidents were edits where the surrounding SQL prose felt Postgres-y enough that backticks looked natural.

**The fix looks unmotivated without context.** Once dropped, the backticks leave behind plain identifier names that read identically to a comment that never had backticks. A reader doing `git log -p` on a fix commit sees `` `name` `` → `name` and may not understand why the change was made — unless the commit message or a comment explains. This convention doc IS that explanation: future readers seeing bare identifier names in SQL comments inside PEvO backend template literals can grep this slug to learn the constraint.

## When to Apply

Apply this rule whenever you are:

- Writing or editing SQL inside a TypeScript template literal — `pool.query(\`...\`)`, `client.query(\`...\`)`, or any helper that takes a template-literal SQL string.
- Writing block comments (`/* */` or `--`) inside that template literal to explain a predicate, JOIN, CTE, or column reference.
- Reviewing a backend PR where SQL comments include identifier names — flag any backtick as a tsc-break risk.
- Composing rationale narrative inside a multi-line SQL string for a hold-block fix or convention purge. Both documented incidents were on this path — implementers writing dense rationale comments under architect-hold pressure are the primary failure population.

Skip this rule when:

- The SQL is in a `.sql` file consumed by something other than a TS template literal. Backtick-quoted identifiers there are SQL-parsed normally (and Postgres rejects them anyway — it uses double quotes).
- The comment is *above* the template literal in JS-comment scope. JS-side `//` and `/* */` comments can use backticks freely.

## Examples

### Before (breaks tsc — representative shape)

```typescript
// backend/src/reputation.ts — user_reviews CTE, broken first-attempt shape
await pool.query(`
  WITH user_reviews AS (
    SELECT c.author, c.permlink
    FROM hafsql.comments c
    JOIN hafsql.comments p
      ON p.author = c.parent_author AND p.permlink = c.parent_permlink
    WHERE ${validReviewWhere(...)}
      -- accreditation gate: in the current call-graph, $1 and $2 derive from the same
      -- `getAllAccreditedAccounts` snapshot, so this gate is functionally subsumed by the
      -- upstream `c.author IN target_users` filter. The structural rule that every
      -- `validReviewWhere` caller MUST compose accreditation is the load-bearing invariant.
      AND (c.author = ANY($2::text[]) OR c.author = $19)
  )
  SELECT * FROM user_reviews
`);
```

The backticks around `` `getAllAccreditedAccounts` ``, `` `c.author IN target_users` ``, and `` `validReviewWhere` `` terminate the outer template literal. tsc surfaces ~10 errors clustered at the WITH clause, the SELECT, the JOIN, the `${validReviewWhere(...)}` interpolation, and the close. The SQL is structurally identical; only the comment text differs.

### After (parses cleanly — recovery shape from commit `f77ae21`)

```typescript
// backend/src/reputation.ts — user_reviews CTE, recovered shape
await pool.query(`
  WITH user_reviews AS (
    SELECT c.author, c.permlink
    FROM hafsql.comments c
    JOIN hafsql.comments p
      ON p.author = c.parent_author AND p.permlink = c.parent_permlink
    WHERE ${validReviewWhere(...)}
      -- accreditation gate: in the current call-graph, $1 and $2 derive from the same
      -- getAllAccreditedAccounts snapshot, so this gate is functionally subsumed by the
      -- upstream c.author IN target_users filter. The structural rule that every
      -- validReviewWhere caller MUST compose accreditation is the load-bearing invariant.
      AND (c.author = ANY($2::text[]) OR c.author = $19)
  )
  SELECT * FROM user_reviews
`);
```

Bare identifier names. Reads identically to a human; tsc passes. If a future maintainer wonders why `c.author IN target_users` and `validReviewWhere` are unquoted in the comment, this convention doc names the constraint.

### Alternative: SQL double-quote (works, less common in PEvO)

```typescript
await pool.query(`
  -- this gate parallels the upstream "c.author IN target_users" filter
  AND (c.author = ANY($2::text[]) OR c.author = $19)
`);
```

Double-quotes are TS-safe and Postgres-safe. Acceptable when the comment genuinely needs a delimiter for readability; bare names remain the PEvO default.

### Hoist prose-heavy rationale outside the template literal

When the rationale is several lines of prose with no need to colocate with the SQL, hoist it into a JS-side comment above the template-literal call:

```typescript
// Defense-in-depth gate for user_reviews CTE: mirrors the sibling review-class CTEs.
// In the current call-graph, $1 and $2 derive from the same `getAllAccreditedAccounts`
// snapshot, so the gate is functionally subsumed by the upstream `c.author IN target_users`
// filter. The structural rule is the load-bearing invariant; this site enforces it so a
// future caller passing a non-accredited `usernames` set doesn't silently bypass.
await pool.query(`
  WITH user_reviews AS (
    ...
    AND (c.author = ANY($2::text[]) OR c.author = $19)
  )
`);
```

In JS-comment scope, backticks are free.

## Related

- [ts-closure-denarrowing-nullable-property-hoist-2026-05-04.md](ts-closure-denarrowing-nullable-property-hoist-2026-05-04.md) — sibling TS-strict-mode trap in PEvO backend code. Together with this doc they form a "TypeScript pitfalls inside backend SQL paths" family — both are syntactic/parser-level failures that cost minutes of confusion to diagnose without prior context.
- [discipline-interface-tsc-perimeter-omission-2026-05-11.md](discipline-interface-tsc-perimeter-omission-2026-05-11.md) — adjacent tsc-discipline convention. That doc covers tsc-perimeter coverage gaps (test files outside `include`); this doc covers a tsc-parse-level pitfall inside source. Both surface as silent or confusing failures (one because tsc never runs, the other because tsc rejects the file outright with errors that don't name the root cause).
- [pg-bigint-default-stringification-defeats-typeof-cast-guards-2026-05-06.md](pg-bigint-default-stringification-defeats-typeof-cast-guards-2026-05-06.md), [pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12.md](pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12.md) — the Postgres-in-TS counter-intuition family (driver/type-system mismatches). This doc is the syntactic-parser sibling at the layer between TS and SQL.
- [migration-and-initappdb-dual-source-schema-2026-05-05.md](migration-and-initappdb-dual-source-schema-2026-05-05.md) — backend-zone SQL-authoring convention. Readers navigating SQL-in-backend pitfalls benefit from this doc too.

---
title: "PostgreSQL E-string `\\v` is NOT a recognized escape — silently passes literal `v` (0x76); use `\\x0B` for vertical tab"
date: 2026-05-20
category: conventions
module: backend/src/hafsql.ts
problem_type: convention
component: database
severity: high
applies_when:
  - "Writing a PostgreSQL E-string literal (`E'...'`) containing backslash escapes — especially when porting JS string semantics (where `\\v` is a valid escape for vertical tab) into a SQL fragment"
  - "Defining a `BTRIM(text, charset)` or `REGEXP_REPLACE`/`TRANSLATE` charset literal intended to mirror JS `.trim()` or a JS regex character class"
  - "Generating SQL via template literal where the template author assumes JS escape semantics extend into the E-string passed to Postgres"
  - "Reviewing a SQL-shape canary that asserts the literal text of a charset string but never round-trips through real Postgres to verify what bytes are stripped"
  - "Adopting any sibling-field SQL/JS parity fix per `sibling-field-sql-js-parity-audit-2026-05-19.md` — the parity step is necessary but not sufficient if the SQL charset itself is parsed wrong"
related_components:
  - testing_framework
tags:
  - postgres
  - sql-escaping
  - e-string
  - btrim
  - whitespace
  - sql-js-parity
  - charset
---

# PostgreSQL E-string `\v` is NOT a recognized escape — silently passes literal `v` (0x76); use `\x0B` for vertical tab

## Context

PostgreSQL E-string syntax (`E'...'`) supports a specific, limited set of backslash escapes documented in [section 4.1.2.2 "String Constants with C-Style Escapes"](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-STRINGS-ESCAPE) of the PG docs:

| Escape | Meaning |
|---|---|
| `\b` | backspace (U+0008) |
| `\f` | form feed (U+000C) |
| `\n` | newline (U+000A) |
| `\r` | carriage return (U+000D) |
| `\t` | tab (U+0009) |
| `\xHH` | hex byte |
| `\uXXXX` / `\UXXXXXXXX` | Unicode codepoint |
| `\0` through `\777` | octal byte |
| `\\` | literal backslash |

Conspicuously **absent**: `\v`. In JS, C, Perl, Python, and most other languages `\v` is a valid vertical-tab escape (U+000B). In PostgreSQL E-strings it is **not recognized**, and per the docs "any other character following a backslash is taken literally" — so `\v` is silently passed as the single character `v` (0x76, ASCII letter `v`).

This shipped in production code on 2026-05-19 (commit `dc9b773`, `backend-orcid-trim-parity` task). Both the architect (writing the task body) and the backend implementer (writing the fix) specified `BTRIM(a.elem ->> 'orcid', E' \t\n\r\v\f')`, intending an ASCII C-whitespace charset. The actual stripped charset is `space, tab, LF, CR, literal v, FF` — and crucially does NOT include vertical tab.

The bug doesn't surface as a SQL error and doesn't surface in `EXPLAIN`. It only surfaces as a charset mismatch — which the SQL-shape canary at `backend/tests/routes/papers-canonical-orcid-resolution.test.ts:583-617` could not catch because it asserts literal SQL text (`E' \t\n\r\v\f'` is present in the captured query) without ever round-tripping through Postgres to verify byte behavior. The 4-input parity matrix at lines 549-577 ran pure JS (`computeSupersession` + `applyAuthorSupersession`) so it didn't exercise SQL either.

## Guidance

When writing a PG E-string that needs vertical tab — or any character without a recognized single-letter escape — use the hex form `\x0B` instead. The full ASCII C-whitespace charset, correctly:

```sql
E' \t\n\r\x0B\f'    -- bytes: 20 09 0a 0d 0b 0c  ✓
```

And the buggy form to avoid:

```sql
E' \t\n\r\v\f'      -- bytes: 20 09 0a 0d 76 0c  ✗ (0x76 is literal 'v', not VT)
```

If the SQL is generated from a JS template literal, the rule is: **JS escape semantics do not extend into the E-string passed to Postgres.** A template literal like ``BTRIM(x, E' \t\n\r\v\f')`` ends up passing the 5-char string `' \t\n\r\v\f'` (with JS interpreting `\t`, `\n`, `\r` to their respective control characters and `\v` to U+000B) AS-IS into the SQL — and Postgres then re-parses those bytes under E-string rules. The `\v` byte that JS produced (0x0B vertical tab) does not appear in the SQL text Postgres sees; what Postgres sees is the LITERAL 4-char sequence `\v\f` which it then mis-parses. Use `String.raw\`...\`` or escape carefully so the SQL text Postgres receives uses only PG-recognized escapes.

When in doubt, verify empirically against a running Postgres before claiming a charset works:

```sql
SELECT encode((E' \t\n\r\v\f')::bytea, 'hex');
-- Returns: 20090a0d760c  (note 0x76, the literal 'v' byte)

SELECT encode((E' \t\n\r\x0B\f')::bytea, 'hex');
-- Returns: 20090a0d0b0c  (correct VT byte)
```

Test canaries should include at least one real-Postgres assertion of the charset bytes, not only a literal-text `toContain` against captured SQL. The literal-text assertion would pass on the buggy code; only a `SELECT BTRIM(...)` against actual Postgres distinguishes the two.

## Why This Matters

For `backend-orcid-trim-parity` specifically, the bug produced TWO cross-surface split-brain failure modes on the `orcid_discrepancy` UX badge:

1. **The VT split-brain the fix was filed to close remains open.** Broadcaster posts `{orcid:'<VT><attested>'}` (vertical tab prefix — what JS produces from `'\v' + attested`). JS path: `.trim()` strips the VT → claim matches accredited ORCID → `discrepancy=false`. SQL path: `BTRIM(..., charset)` leaves the VT untouched (because VT is not actually in the charset) → claim differs from accredited → `discrepancy=true`. Same paper, two badges across surfaces — the exact failure mode the fix was meant to eliminate.

2. **A NEW inverse asymmetry was introduced.** Broadcaster posts `{orcid:'v<attested>'}` (literal letter `v`). SQL path: BTRIM strips the literal `v` from the charset → claim matches → `discrepancy=false`. JS path: `.trim()` leaves `v` alone → claim differs → `discrepancy=true`. Same split-brain class, opposite direction, didn't exist pre-fix.

The general lesson: **a SQL/JS parity fix that hardcodes a charset literal is correctness-fragile precisely on the characters where you most need it to work.** Whitespace handling already requires care (`sql-trim-vs-js-trim-whitespace-character-set-asymmetry-2026-05-19.md` codifies the broader asymmetry); adding a parser-semantic gotcha on top of that makes the fix invisibly wrong without any test failure.

The cost of catching this empirically is one Postgres query. The cost of not catching it is shipping a fix whose JSDoc, test canary, and commit message all assert behavior the code does not exhibit — and which a future "I see the parity contract in JSDoc, I can trust it" reader will inherit silently.

## When to Apply

- Any time a PG E-string literal contains backslash escapes, especially when ported from JS, C, or any language where `\v` is a valid escape.
- Any time a `BTRIM(text, charset)`, `TRANSLATE`, `REPLACE`, or `REGEXP_REPLACE` charset literal is intended to match a JS character class (e.g., `\s`, `String.prototype.trim()`, a regex `[\t\n\r\v\f]`).
- Any time a JS template-literal SQL generator interpolates a string containing backslashes into a Postgres E-string body.
- Sibling-field SQL/JS parity audits per `sibling-field-sql-js-parity-audit-2026-05-19.md` — when widening the charset on one field, verify the charset escapes are PG-recognized before claiming parity on the new field.

## Examples

### The fix at `backend/src/hafsql.ts:872-873` (held in `backend-orcid-trim-parity` re-review)

Before (buggy):
```sql
AND NULLIF(BTRIM(a.elem ->> 'orcid', E' \t\n\r\v\f'), '') IS NOT NULL
AND aa.orcid <> BTRIM(a.elem ->> 'orcid', E' \t\n\r\v\f')
```

After (correct):
```sql
AND NULLIF(BTRIM(a.elem ->> 'orcid', E' \t\n\r\x0B\f'), '') IS NOT NULL
AND aa.orcid <> BTRIM(a.elem ->> 'orcid', E' \t\n\r\x0B\f')
```

Equivalently, drop `\v`/`\x0B` entirely if vertical tab is judged not a realistic copy-paste vector for the field in question (ORCID-from-publisher-page paste, hive-account-from-keychain-extension paste, etc.). The minimal ASCII whitespace set most broadcasters actually produce is `' \t\n\r'` — VT and FF cover thoroughness, not realism.

### Real-Postgres canary pattern

Whenever a charset literal is load-bearing, add at least one canary that exercises the actual bytes, not the literal text:

```ts
import { getHafPool } from '../../src/db.js';

it('BTRIM charset literal strips vertical tab as intended', async () => {
  const pool = getHafPool();
  const { rows } = await pool.query(
    `SELECT encode((E' \\t\\n\\r\\x0B\\f')::bytea, 'hex') AS charset_bytes`
  );
  // 20 (space) 09 (tab) 0a (LF) 0d (CR) 0b (VT) 0c (FF)
  expect(rows[0].charset_bytes).toBe('20090a0d0b0c');

  const { rows: trimmed } = await pool.query(
    `SELECT BTRIM($1, E' \\t\\n\\r\\x0B\\f') AS stripped`,
    ['abc']
  );
  expect(trimmed[0].stripped).toBe('abc');
});
```

The literal-text `expect(sql).toContain('E\' \\t\\n\\r\\x0B\\f\'')` is still valuable as a shape canary (it pins that the source code uses the correct literal), but it MUST be paired with a real-Postgres byte assertion to catch the parser-semantic class of bug.

## Related

- `agents/docs/solutions/conventions/sql-trim-vs-js-trim-whitespace-character-set-asymmetry-2026-05-19.md` — the broader SQL/JS whitespace asymmetry this learning is a corollary of. That convention prescribes adopting an explicit charset; this convention covers HOW to write the charset correctly.
- `agents/docs/solutions/conventions/sibling-field-sql-js-parity-audit-2026-05-19.md` — when widening a wrapper to a sibling field, verify the new charset's escapes are PG-recognized before claiming parity.
- `agents/docs/tasks/pending/backend-orcid-trim-parity.md` — held re-review with item #1 (this bug) and item #4 (the canary must exercise real Postgres) as the immediate consequences in PEvO.
- PostgreSQL docs: [Section 4.1.2.2 "String Constants with C-Style Escapes"](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-STRINGS-ESCAPE).

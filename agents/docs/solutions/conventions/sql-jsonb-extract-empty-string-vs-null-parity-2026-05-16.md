---
title: "SQL `IS NOT NULL` on JSONB `->>` extract admits empty-string; pair with JS `.length > 0` requires `NULLIF(..., '')` for parity"
date: 2026-05-16
category: conventions
module: backend/src/hafsql.ts
problem_type: convention
component: database
severity: medium
applies_when:
  - "Writing a SQL predicate over a JSONB field extracted with `->>` (text-coerce operator) where the field MAY contain an empty-string value the consumer wants to treat as absent"
  - "Implementing the same business rule in both SQL (via `jsonb_col ->> 'field'`) and JS (via `typeof === 'string' && .length > 0` or sibling normalization) and depending on parity between the two code paths"
  - "Reviewing a SQL CASE / WHERE that uses `IS NOT NULL` on a `->>` expression and assuming it catches empty-string values"
  - "Reviewing a chain-derived field where publishers commonly emit empty string as default-blank input (orcid, affiliation, doi, abstract, ipfs_cid)"
  - "Adding a canary that exercises the four-state matrix of a JSONB field: absent / SQL-NULL / JSONB-null / empty-string"
related_components:
  - documentation
  - testing_framework
tags:
  - postgres
  - jsonb
  - sql-null
  - empty-string
  - sql-js-parity
  - hafsql
  - nullif
  - shape-guard
---

# SQL `IS NOT NULL` on JSONB `->>` extract admits empty-string — pair with JS `.length > 0` requires `NULLIF(..., '')` for parity

> **Companion to** [`pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12.md`](pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12.md) (sibling JSONB-vs-SQL-NULL trap, **shape** axis). That doc covers how `IS NOT NULL` fails to reject a JSONB null literal in a *shape* check (object/array/string). This doc covers the orthogonal **emptiness** axis: how `IS NOT NULL` on a `->>` text extract fails to reject empty-string values that the JS sibling normalizes to null. Together: "the same business rule expressed in SQL and JS diverges on a different boundary class in each axis — the SQL-side guard needs additional discipline at each axis to match JS semantics."

## Context

When the same business rule is implemented in both SQL (against a Postgres JSONB column via the `->>` text-extract operator) and JS (in a sibling helper), the SQL side admits **empty-string** values that the JS side normalizes to null. The asymmetry produces split-brain on the same input across endpoints+paths.

The trap is in the `->>` operator's coercion behavior. For a JSONB element `{"orcid": ""}`:

- `(elem ->> 'orcid')` extracts the text value `''` (empty string, NOT NULL).
- SQL `'' IS NOT NULL` evaluates to `TRUE`.
- Any downstream guard like `WHEN (elem ->> 'orcid') IS NOT NULL AND ... <> ...` treats the empty string as a real claim.

The JS sibling, written in the canonical defensive style, normalizes empty:

```ts
const claimed = typeof chainOrcid === 'string' && chainOrcid.length > 0 ? chainOrcid : null;
```

`''` becomes `null`. Downstream comparisons on `claimed` short-circuit when `claimed === null`.

Same input, opposite output. The SQL path emits a false-positive signal; the JS path emits the correct absent-as-null signal.

This is distinct from the shape axis covered by the companion doc. There, `IS NOT NULL` fails because Postgres distinguishes SQL-NULL from JSONB-null literal. Here, the failure is that `IS NOT NULL` does not distinguish "absent / SQL-NULL" from "empty-string", but the JS sibling does. The shape-guard `jsonb_typeof()` does not help — `jsonb_typeof('""'::jsonb)` returns `'string'`, treating empty string as a valid string. The emptiness axis needs its own discipline.

## Guidance

When a SQL predicate over `jsonb_col ->> 'field'` must mirror a JS helper that treats empty-string as absent, wrap the SQL extract with `NULLIF(..., '')`:

```sql
-- WRONG: admits empty-string as a claim
WHEN aa.orcid IS NOT NULL
 AND (a.elem ->> 'orcid') IS NOT NULL
 AND aa.orcid <> (a.elem ->> 'orcid')
THEN true
```

```sql
-- RIGHT: NULLIF collapses '' to SQL NULL, so IS NOT NULL correctly rejects empty
WHEN aa.orcid IS NOT NULL
 AND NULLIF((a.elem ->> 'orcid'), '') IS NOT NULL
 AND aa.orcid <> (a.elem ->> 'orcid')
THEN true
```

`NULLIF(expr, value)` returns `NULL` when `expr = value`, otherwise `expr`. Wrapping the `->>` output in `NULLIF(..., '')` collapses both SQL-NULL (already null) and empty-string (`'' = ''` → NULL) into a single absent-state, which `IS NOT NULL` discriminates correctly.

For the comparison itself (`aa.orcid <> (a.elem ->> 'orcid')`), the unwrapped `->>` is fine — the `<>` operator on `aa.orcid <> ''` evaluates to `TRUE` when `aa.orcid` is non-empty, which is the intended semantics for the discrepancy comparison once the guard above has rejected the absent case.

## Why This Matters

**Split-brain across endpoints.** Same paper, opposite signal depending on which code path served the response. UI's discrepancy indicator flickers; integrators see contradictory data. The cache layer compounds the surprise: a cached SQL-path response and a re-computed JS-path response disagree even when both are fresh.

**Default-blank publisher input is realistic, not edge-case.** Publish forms typically initialize optional text fields to empty string (`{ orcid: '' }` instead of omitting the key). Any chain field where the publisher commonly leaves the input blank is reachable through this trap. In the original instance (PEvO supersession), publish.js's co-author form defaults `orcid: ''` for every new co-author; a single broadcast with the default form fills empty-strings into chain `pevo.authors[i].orcid`.

**Mutation kill: the parity test is the gate.** A behavior canary on either path alone passes. The mutation that introduces the asymmetry is invisible until a test exercises both paths against the same input and asserts identical output. The parity test is what catches the regression — single-path tests do not.

**Distinct from typeof/shape parity.** The sibling convention `pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12.md` covers the shape axis (`{key: null}` vs `{key: 'string'}` vs missing key). This convention covers the orthogonal emptiness axis (`{key: ''}` vs absent). Both axes need discipline; the typeof guard does not address emptiness, and `NULLIF` does not address shape.

## When to Apply

1. **Writing or reviewing a SQL predicate over a `jsonb_col ->> 'field'` where the field is a user-input text value with default-blank typical input.** Candidates include any chain field surfaced from `json_metadata`: orcid, affiliation, doi, ipfs_cid, abstract, title — basically any optional string the publisher might leave blank in the form.
2. **Adding a new SQL/JS dual-path that derives a signal from a JSONB field.** The two paths must agree on absent-state semantics. Write a parity test BEFORE shipping that exercises the four-state matrix (absent / SQL-NULL / JSONB-null / empty-string) through both paths and asserts identical output.
3. **Reviewing a hold-block or PR diff that adds a `jsonb_col ->> 'field' IS NOT NULL` predicate.** Ask: does the JS sibling normalize empty-string to null? If yes, the SQL needs `NULLIF`. If no JS sibling exists today, document the empty-string semantic at the SQL site so a future JS implementer matches it.
4. **Migrating an existing single-path SQL query into a SQL/JS dual-path.** The original SQL may have been ambient-tolerant of empty-string because no JS sibling existed to expose the asymmetry. Adding a JS path silently breaks parity unless the migration includes the `NULLIF` discipline.

## Examples

### Before (SQL admits empty-string; diverges from JS sibling)

```sql
-- backend/src/hafsql.ts authorsWithSupersessionSelect
'orcid_discrepancy', CASE
                       WHEN aa.orcid IS NOT NULL
                        AND (a.elem ->> 'orcid') IS NOT NULL
                        AND aa.orcid <> (a.elem ->> 'orcid')
                       THEN true ELSE false
                     END
```

```ts
// backend/src/routes/papers.ts computeSupersession
const claimed = typeof chainOrcid === 'string' && chainOrcid.length > 0 ? chainOrcid : null;
const discrepancy = attested !== null && claimed !== null && attested !== claimed;
```

Publisher broadcasts `{hive: 'alice', orcid: ''}` with real attestation:
- SQL path → `orcid_discrepancy: true` (false positive: empty claim treated as conflicting claim)
- JS path → `orcid_discrepancy: false` (correct: empty normalized to null, comparison short-circuits)

### After (SQL `NULLIF` mirrors JS `.length > 0`)

```sql
-- backend/src/hafsql.ts authorsWithSupersessionSelect
'orcid_discrepancy', CASE
                       WHEN aa.orcid IS NOT NULL
                        AND NULLIF((a.elem ->> 'orcid'), '') IS NOT NULL
                        AND aa.orcid <> (a.elem ->> 'orcid')
                       THEN true ELSE false
                     END
```

```ts
// backend/src/routes/papers.ts computeSupersession (unchanged)
const claimed = typeof chainOrcid === 'string' && chainOrcid.length > 0 ? chainOrcid : null;
const discrepancy = attested !== null && claimed !== null && attested !== claimed;
```

Same publisher broadcast `{hive: 'alice', orcid: ''}` with real attestation:
- SQL path → `orcid_discrepancy: false` (NULLIF collapses `''` to NULL; guard correctly rejects absent claim)
- JS path → `orcid_discrepancy: false` (unchanged; was already correct)

Parity restored. The parity test (run the same input through both paths, assert identical output) gates the regression — deleting the `NULLIF` wrap surfaces the false-positive discrepancy red.

### Parity test shape (mutation-kill anchor)

```ts
// Run the same authors[] entry through both code paths and assert agreement.
it('SQL and JS supersession paths agree on empty-string chain orcid', async () => {
  const author = { hive: 'alice', orcid: '' };  // publisher default-blank
  const orcidMap = new Map([['alice', '0000-0001-2345-6789']]);

  // JS-path result via computeSupersession + applyAuthorSupersession
  const jsResult = applyAuthorSupersession([author], orcidMap);

  // SQL-path result via the actual /api/papers/:author/:permlink endpoint
  // (mocked HAF returning the author entry exactly as-broadcast)
  const sqlResult = (await request(app).get(`/api/papers/${author.hive}/p1`).body)
    .data.authors[0];

  // The parity invariant: same input, same supersession output regardless of path.
  expect(jsResult[0].orcid_verified).toBe(sqlResult.orcid_verified);
  expect(jsResult[0].orcid_discrepancy).toBe(sqlResult.orcid_discrepancy);
});
```

The test fails red when either path drifts. It is the gate that catches the asymmetry; single-path tests on the SQL or JS side alone pass on both the correct and broken implementations of THIS axis.

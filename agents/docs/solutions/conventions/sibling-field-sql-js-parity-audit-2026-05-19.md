---
title: Sibling-field SQL/JS parity audit
date: 2026-05-19
category: conventions
module: backend/src/hafsql.ts + backend/src/lib/author-supersession.ts
problem_type: convention
component: database
severity: medium
applies_when:
  - Closing a SQL/JS normalization parity gap on one field in a multi-field SQL fragment
  - Reviewing a fix that adopts reject-at-boundary on a field whose siblings share the same SQL primitives + JS counterparts
  - Auditing a `jsonb_build_object` projection or `SELECT` body that handles multiple broadcaster-controlled JSON metadata fields
tags: [sql-js-parity, normalization, sibling-field-audit, jsonb-projection, broadcaster-controlled-metadata]
---

# Sibling-field SQL/JS parity audit

## Context

PEvO landed `agents/docs/solutions/conventions/sql-trim-vs-js-trim-whitespace-character-set-asymmetry-2026-05-19.md` documenting that PostgreSQL `TRIM(string)` / `BTRIM(string)` with no character-set arg strips only U+0020, while JS `String.prototype.trim()` strips full ECMA-262 WhiteSpace + LineTerminator. A vouched co-author can post broadcaster-controlled JSON metadata with non-ASCII whitespace padding (`\t`, `\n`, NBSP, etc.) on any field to create cross-surface split-brain between SQL-projected and JS-projected responses.

Round-3 of `backend-papers-canonical-orcid-resolution` (commit `ed7dfa9`) applied that convention to close the asymmetry on the `authors[i].hive` field via reject-at-boundary: extracted `trimAsciiSpace` helper mirroring PG `TRIM`, plus `[a-z0-9.-]+` charset regex guard on BOTH the SQL JOIN predicate (`LOWER(TRIM(a.elem ->> 'hive')) ~ '^[a-z0-9.-]+$'`) and the JS `normalizeHiveAccount` wrapper. The round-3 hold prescribed this exact shape; the round-3 backend signal landed it; the round-3 cluster review verified it on the hive field.

The supersession-cluster `/ce-code-review` at architect-context (2026-05-19) caught the bug round-3 missed: the SAME SQL fragment (`authorsWithSupersessionSelect` in `backend/src/hafsql.ts`) had the IDENTICAL parity gap on the `authors[i].orcid` field, sitting in the same `jsonb_build_object` projection next door to the hive field. SQL uses `NULLIF(BTRIM(a.elem ->> 'orcid'), '')` + `aa.orcid <> BTRIM(a.elem ->> 'orcid')`; JS `computeSupersession` uses `chainOrcid.trim()`. Same BTRIM-vs-`.trim()` asymmetry, same cross-surface split-brain pattern, on the field next door in the same SQL fragment.

The cluster review surfaced it cross-corroborated (correctness P1/80 + security P1/75 + adversarial P1/75 + maintainability residual) — confidence anchor 100. Filed as separate task `backend-orcid-trim-parity`.

## Guidance

When a fix lands the SQL/JS parity contract on one field in a SQL fragment, enumerate every sibling field in the same fragment and either:

- **(a) Extend the parity contract to that field**, applying the same SQL-side normalization wrapper (`LOWER(TRIM(...))` + charset regex, or the equivalent for the relevant character class) and the same JS-side reject-at-boundary helper.
- **(b) Explicitly document why the sibling field doesn't need the contract.** Common reasons: the JS-side never compares the field for equality (free-text fields like `name` or `affiliation` that only flow into the response unchanged), so cross-surface text-difference doesn't produce a behaviorally-divergent flag. Document the non-extension inline with a one-line comment anchored on the behavioral rationale.

The audit unit is "every field extraction in the affected SQL fragment", typically grep'd as `a.elem ->> '<field>'` or `LOWER(TRIM(a.elem ->> '<field>'))` patterns within the same `jsonb_build_object` body, `CASE` expression, or `SELECT` projection.

## Why This Matters

The parity bug class lives at the **field level**, not the call-site level, so it slips past three sibling conventions that look adjacent but cover different scopes:

- `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` audits call-sites of one extracted primitive (e.g., every call site of `normalizeHiveAccount`). Doesn't fire when the bug class lives in fields that don't yet use the wrapper.
- `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` audits the new code in the fix commit for re-introducing the rot being purged. Doesn't fire on pre-existing sibling fields the fix didn't touch.
- `cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md` audits sibling functions in the same file producing the same logical output. Adjacent but different scope: composition sites at the function level, not field extractions within a SQL fragment.

Without an explicit sibling-field audit step, the convention closes one instance of the parity class and leaves N-1 instances open in the same SQL body. The fields share the same SQL primitives (BTRIM, NULLIF, equality comparison), the same JS-side counterparts (`.trim()`, length checks, equality), and the same broadcaster-controlled JSON metadata source — the bug class is a structural property of the fragment, not of the specific field.

In the round-3 incident, the cluster review's broader scope caught it; without that scope, the orcid-side asymmetry would have shipped to production indefinitely.

## When to Apply

- When closing a SQL/JS parity contract on a field via reject-at-boundary OR widen-the-SQL-stripper.
- When reviewing a fix commit that touches one field's normalization in a multi-field SQL fragment.
- When extending an existing convention (e.g., the sql-trim-vs-js-trim contract) — re-audit every fragment the convention applies to, not just the field that motivated the latest fix.
- During hold-block design: the architect's hold should explicitly enumerate sibling fields and call out the (a)-or-(b) disposition for each, not leave them for a future cluster review to catch.

## Examples

### The round-3 incident — `authorsWithSupersessionSelect` SQL fragment

The fragment has 4 field extractions inside its `jsonb_build_object` projection:

```sql
jsonb_build_object(
  'name', a.elem ->> 'name',
  'hive', a.elem ->> 'hive',
  'orcid', a.elem ->> 'orcid',
  'affiliation', a.elem ->> 'affiliation',
  'orcid_verified', aa.orcid,
  'orcid_discrepancy', CASE WHEN ... NULLIF(BTRIM(a.elem ->> 'orcid'), '') ... END
)
```

Plus the JOIN predicate (currently on hive only, after the round-3 fix):

```sql
LEFT JOIN active_accreditations aa
  ON aa.account = LOWER(TRIM(a.elem ->> 'hive'))
 AND LOWER(TRIM(a.elem ->> 'hive')) ~ '^[a-z0-9.-]+$'
```

Per-field disposition under this convention:

| Field | JS-side compares for equality? | Disposition |
|---|---|---|
| `hive` | Yes (JOIN against `aa.account`) | (a) extend — done in round-3 |
| `orcid` | Yes (`aa.orcid <> chainOrcid`) | (a) extend — filed as `backend-orcid-trim-parity` |
| `name` | No (free-text projected verbatim) | (b) non-extend — document why |
| `affiliation` | No (free-text projected verbatim) | (b) non-extend — document why |

The non-extension disposition for `name` and `affiliation` is documented inline in the SQL helper's JSDoc and is verified by the absence of any JS-side equality comparison against `aa.name` or `aa.affiliation` (the accreditation table doesn't have those columns; the bug class is unreachable by construction).

### Hold-block prescription shape

A hold block that prescribes a sibling-field parity fix should enumerate the audit explicitly:

```
Item N: Apply the sql-trim-vs-js-trim parity contract to authors[i].hive.
  Audit sibling fields in `authorsWithSupersessionSelect`:
    - orcid (equality-compared on aa.orcid): extend in same commit OR file follow-up
    - name, affiliation (free-text, no equality): document non-extension inline
  The audit is part of the item, not deferred.
```

This shifts the sibling-field discovery from "caught by a later cluster review" to "documented at design time."

## Related

- `agents/docs/solutions/conventions/sql-trim-vs-js-trim-whitespace-character-set-asymmetry-2026-05-19.md` — the primary parity convention this extends
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — analogous audit class (call-sites of one primitive)
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` — analogous self-audit class (the fix's own new code)
- `agents/docs/solutions/conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md` — adjacent (sibling functions, not sibling fields)
- Tasks: `backend-papers-canonical-orcid-resolution` (archived 2026-05-19, source of the hive-side fix), `backend-orcid-trim-parity` (filed 2026-05-19, the sibling-field follow-up surfaced by cluster review)

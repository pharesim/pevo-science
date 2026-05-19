---
title: "PostgreSQL `TRIM(text)` strips only U+0020; JS `String.prototype.trim()` strips broader ECMA-262 whitespace — `LOWER(TRIM(...))` and `.trim().toLowerCase()` are NOT parity-symmetric"
date: 2026-05-19
category: conventions
module: backend/src/hafsql.ts
problem_type: convention
component: database
severity: high
applies_when:
  - "Implementing a string-normalization invariant in both SQL (`LOWER(TRIM(...))` over `jsonb ->> 'field'` or any text column) and JS (`.trim().toLowerCase()` or sibling helper) and asserting parity between the two paths"
  - "Reviewing a JSDoc, SQL comment, or commit message that claims SQL `LOWER(TRIM(...))` is the parity-symmetric operator for JS `.trim().toLowerCase()` (or any equivalent claim — `TRIM` ≡ `.trim()`, `BTRIM` ≡ `.trim()`)"
  - "Designing a cross-language normalization helper (`canonicalHiveKey`, `normalizeHiveAccount`, `normalizeDiscipline`, etc.) where the same broadcaster-supplied chain string is matched against database-stored canonical values"
  - "Adding a parity test for SQL/JS string-normalization symmetry — the test input set MUST include non-ASCII-space whitespace (tab, NBSP, newline, BOM); ASCII-space-only inputs (`' BOB '`, `'  alice  '`) agree across SQL and JS and are exactly the input class where the asymmetry doesn't surface"
  - "Reviewing a hive-account-name / ORCID / discipline / slug lookup that does `WHERE LOWER(TRIM(x)) = canonical` and considering whether broadcaster-malformed whitespace can produce cross-surface split-brain"
related_components:
  - backend/src/lib/author-supersession.ts
  - backend/src/routes/papers.ts
  - backend/src/routes/profile.ts
tags:
  - sql-js-parity
  - whitespace-normalization
  - postgres-trim
  - cross-surface-parity
  - canonicalization
  - hive-key
  - orcid
  - supersession
  - normalization-helper
---

## Context

PEvO matches broadcaster-supplied chain metadata strings against canonical database values in two parallel code paths: SQL-side JOINs against HAF tables, and JS-side `Map` lookups inside route handlers. The same logical normalization (lowercase + trim) is written in both languages, and the codebase has repeatedly asserted they're equivalent — most explicitly in the round-2 `canonicalHiveKey` JSDoc, which claimed "`LOWER(TRIM(...))` is the parity-symmetric operator on `.trim().toLowerCase()`."

That claim is provably false. PostgreSQL `TRIM(text)` with no explicit character-set argument strips ONLY U+0020 (the ASCII space). JS `String.prototype.trim()` strips per ECMA-262 — WhiteSpace + LineTerminator — which includes tab, LF, CR, NBSP (U+00A0), BOM (U+FEFF), U+2028, U+2029, vertical tab, form feed, and several other Unicode whitespace code points. The two operators agree for inputs containing only ASCII-space padding and diverge for everything else.

The asymmetry surfaced in architect re-review of `backend-papers-canonical-orcid-resolution` round-2 (commit `37a49a1`, 2026-05-19). Round-1 hold item 1 had prescribed extracting a hive-account normalizer used at three call sites including a SQL JOIN; the implementer chose `LOWER(TRIM(a.elem ->> 'hive'))` for the SQL side and `entry.hive.trim().toLowerCase()` for the JS side, asserting parity. Security reviewer empirically verified the falsehood against the running `pevo-postgres-1`:

```bash
docker exec pevo-postgres-1 psql -U pevo -d pevo_app -tAc \
  "SELECT 'before:' || TRIM(E'\\tAlice\\n') || ':after', 'before:' || LOWER(TRIM(E'\\tAlice\\n')) || ':after';"
# Output:
# before:	Alice
# :after|before:	alice
# :after
```

The tab and newline characters survive both `TRIM` and `LOWER(TRIM(...))`. JS `'\tAlice\n'.trim().toLowerCase()` returns `'alice'`. Same input, different output.

The concrete exploit is a cross-surface split-brain spoof. A broadcaster posting `authors: [{hive: '\tBob', orcid: 'fake'}]` (or `' bob'`, `'Bob\n'`, etc.) where `bob` is accredited produces:
- JS path (`/api/profile/:username/papers`, chain-detail via `buildCumulativeAuthorsForChain`): canonicalizes `'\tBob'` → `'bob'`, matches accreditation, surfaces `orcid_verified` and `orcid_discrepancy=true`.
- SQL path (`/api/papers` list, single-link detail via `authorsWithSupersessionSelect`): `LOWER(TRIM('\tBob'))` returns `'\tbob'`, JOIN against `aa.account = '\tbob'` misses (no real account has a tab in its name), `orcid_verified=null` and no discrepancy.

Same paper, same broadcaster: the ORCID-discrepancy audit signal appears on some endpoints and disappears on others. A vouched co-author can suppress the audit signal on the list endpoint while leaving it on the detail endpoint — a near-perfect plausible-deniability spoof channel, defeating the entire purpose of `orcid_discrepancy`.

## Guidance

When you need SQL/JS string-normalization parity, treat `TRIM` and `.trim()` as **different operators** — they share a name but not a character class. Pick one of two acceptable shapes and document the choice at the JSDoc/SQL-comment site so the next implementer doesn't repeat the asymmetric-pair assumption:

### Shape (a) — Reject malformed at the boundary (preferred for domain-restricted inputs)

For strings restricted to a known character set (Hive account names → `[a-z0-9.\-]`, ORCID → `\d{4}-\d{4}-\d{4}-\d{3}[\dX]`, slug-like identifiers, etc.), tighten the JS normalizer to return `null` when the input contains characters outside the domain set after trim+lowercase. Add an equivalent SQL guard via regex match:

```sql
-- SQL JOIN with rejection guard
LEFT JOIN active_accreditations aa
  ON aa.account = LOWER(TRIM(a.elem ->> 'hive'))
 AND LOWER(TRIM(a.elem ->> 'hive')) ~ '^[a-z0-9.\-]+$'
```

```ts
// JS normalizer with rejection
export function normalizeHiveAccount(hive: unknown): string | null {
  if (typeof hive !== 'string') return null;
  const cleaned = hive.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(cleaned)) return null;
  return cleaned;
}
```

Broadcaster-malformed metadata (anything outside the domain charset, including non-space-whitespace-padded inputs that JS's broader `.trim()` would have accepted) fails to match a real entity rather than silently coercing to a near-miss canonical form. Closes the spoof channel by **rejection** — the cross-surface split-brain becomes "no supersession on either surface" rather than "supersession on JS surface only."

### Shape (b) — Widen SQL whitespace set to match JS

Replace `TRIM(x)` with `REGEXP_REPLACE(x, '^[\s ﻿]+|[\s ﻿]+$', '', 'g')` (or with an explicit character class enumerating tab, NBSP, BOM, etc.). PostgreSQL `\s` matches the basic whitespace set (space, tab, newline, CR, form feed, vertical tab) but NOT NBSP or BOM, so explicit codepoints must be added to the class:

```sql
LEFT JOIN active_accreditations aa
  ON aa.account = LOWER(REGEXP_REPLACE(
       a.elem ->> 'hive',
       '^[[:space:] ﻿]+|[[:space:] ﻿]+$',
       '',
       'g'
     ))
```

Mechanically symmetric with JS `.trim()`. **Accepts** whitespace-padded variants of valid domain values rather than rejecting them — semantically equivalent to JS's "be liberal about input whitespace, normalize internally." Less defensive than shape (a); the same broadcaster who got rejected under (a) gets their entry silently canonicalized under (b).

### Required test discipline

Whichever shape you pick, the parity test MUST include non-ASCII-space whitespace inputs as discriminator:

```ts
// MUST include — these are the mutation kills
const tab = '\tbob';
const nbsp = ' bob';
const newline = 'bob\n';

// Do NOT rely on these alone — both SQL and JS handle them identically
const ascii_space = ' bob ';
const mixed_case_ascii = '  ALICE  ';
```

If the test input set contains only ASCII-space-padded variants, both paths agree regardless of which shape is used. The round-2 implementer's parity test used exclusively ASCII-space inputs (`' BOB '`, `'  alice  '`), which is exactly the input class where the asymmetry doesn't surface — the test passed green while the spoof channel remained open.

The mutation kill: dropping the normalization at either side (delete the SQL `LOWER(...)` wrapper, or replace JS `normalizeHiveAccount` with `entry.hive`) must fail the parity test red against the non-space-whitespace inputs.

## Why This Matters

The asymmetry is a parity-symmetric-looking pair that isn't. The implementer wrote two operators with the same intent in two languages, asserted parity in JSDoc, and the parity broke for an input class the test didn't exercise. The trap is:

1. **Default-state silent failure.** The JS `.trim()` reads as "obviously equivalent to SQL `TRIM`" to anyone not specifically aware of the character-set asymmetry. There's no compile-time, lint-time, or test-time signal that they're different unless the test inputs include non-ASCII-space whitespace.
2. **Documentation reinforces the trap.** Postgres docs describe `TRIM(text)` as "removes the longest string containing only ` ` from the start and end of `string`" — accurate but the single-space character is easy to miss. MDN describes `.trim()` as "removes whitespace from both ends" — accurate but the whitespace class is unspecified inline; you have to follow to the ECMA-262 spec for the full list.
3. **Concrete spoof surface.** This isn't a hypothetical — it's an active cross-surface split-brain audit-signal-suppression channel on PEvO's public read endpoints. Round-1 hold item 1 was specifically scoped to close this exact failure mode, and round-2's implementation reopened it under a different input axis.
4. **Future surfaces are exposed.** Any new HAF SQL query that joins on a normalized broadcaster string (search, discipline canonicalization, citation matching, slug-based lookups) will inherit the trap unless the implementer is aware.

## When to Apply

This convention applies whenever:

- A SQL predicate matches a chain-broadcast string (from `pevo.authors[i].hive`, `pevo.discipline`, `pevo.source.doi`, etc.) against a canonical database value, AND
- A JS-side helper does an equivalent match against a `Map` or `Set` of canonical values, AND
- Code or documentation asserts parity between the two paths (explicitly via JSDoc, or implicitly via "same business rule in both places")

The PEvO files most exposed today:

- `backend/src/hafsql.ts` — every HAF SQL query helper that does `LOWER(...)` or `TRIM(...)` over a `jsonb ->> 'field'` extract. Specifically: `authorsWithSupersessionSelect`, any future search/discipline/citation match.
- `backend/src/lib/author-supersession.ts` — `canonicalHiveKey` (or its rename) is the wrapper invariant for the JS side.
- `backend/src/routes/papers.ts` + `backend/src/routes/profile.ts` — consumer sites that compose the SQL helper output with the JS helper output.

Compose with the related parity learnings:

- `agents/docs/solutions/conventions/sql-jsonb-extract-empty-string-vs-null-parity-2026-05-16.md` covers the orthogonal null/empty axis (`IS NOT NULL` on a `->>` extract admits empty string). The TRIM/trim asymmetry is the whitespace-character-set axis. A complete cross-language parity audit covers both axes.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` is the structural discipline for migrating to a wrapper at all sites. This learning is about the wrapper's own correctness on a particular input axis — distinct concern, both apply.
- `agents/docs/solutions/conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md` is the audit discipline; the TRIM/trim asymmetry is a specific trap the audit must check for.

## Examples

### Round-2 incorrect parity claim (the trap)

JSDoc on `canonicalHiveKey` at commit `37a49a1` of `backend-papers-canonical-orcid-resolution`:

```ts
/**
 * Canonicalize a Hive account name from chain metadata.
 * Matches the SQL-side normalization LOWER(TRIM(...));
 * the parity is the contract.   // <-- WRONG: not parity-symmetric for non-space whitespace
 */
export function canonicalHiveKey(hive: unknown): string | null { /* ... */ }
```

Companion SQL:

```sql
LEFT JOIN active_accreditations aa
  ON aa.account = LOWER(TRIM(a.elem ->> 'hive'))
```

Companion parity test (incomplete — only ASCII-space inputs):

```ts
it('parity: SQL and JS produce identical supersession for the same hive', async () => {
  const inputs = [' bob ', '  ALICE  ', 'carol'];   // <-- INCOMPLETE: no tab/NBSP/newline
  // ... asserts SQL and JS agree
});
```

Test passes; spoof channel remains open.

### Shape (a) — rejection at the boundary

```ts
export function normalizeHiveAccount(hive: unknown): string | null {
  if (typeof hive !== 'string') return null;
  const cleaned = hive.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(cleaned)) return null;
  return cleaned;
}
```

```sql
-- guard added; JOIN is unchanged in shape, but the regex match excludes
-- broadcaster-malformed values from the JOIN attempt entirely.
LEFT JOIN active_accreditations aa
  ON LOWER(TRIM(a.elem ->> 'hive')) ~ '^[a-z0-9.\-]+$'
 AND aa.account = LOWER(TRIM(a.elem ->> 'hive'))
```

Parity test (complete):

```ts
it('parity: tab-padded hive is rejected on both SQL and JS paths', async () => {
  // Broadcaster posts {hive: '\tbob'} for an accredited bob.
  // Both surfaces: no supersession (rejected as malformed), no discrepancy signal.
  const tabPadded = await fetchFromBoth('/api/papers', '\tbob');
  expect(tabPadded.sqlPath.orcid_verified).toBeNull();
  expect(tabPadded.jsPath.orcid_verified).toBeNull();
  expect(tabPadded.sqlPath.orcid_discrepancy).toBe(false);
  expect(tabPadded.jsPath.orcid_discrepancy).toBe(false);
});
```

### Shape (b) — widen SQL to match JS

```sql
LEFT JOIN active_accreditations aa
  ON aa.account = LOWER(REGEXP_REPLACE(
       a.elem ->> 'hive',
       '^[[:space:] ﻿]+|[[:space:] ﻿]+$',
       '',
       'g'
     ))
```

Parity test (complete):

```ts
it('parity: tab-padded hive resolves identically on both paths', async () => {
  // Broadcaster posts {hive: '\tbob'} for an accredited bob.
  // Both surfaces: supersession resolves to bob's accredited ORCID.
  const tabPadded = await fetchFromBoth('/api/papers', '\tbob');
  expect(tabPadded.sqlPath.orcid_verified).toBe('0000-0001-2345-6789');
  expect(tabPadded.jsPath.orcid_verified).toBe('0000-0001-2345-6789');
});
```

### Empirical verification command

To confirm the asymmetry against any Postgres instance:

```bash
psql -tAc "SELECT TRIM(E'\\tAlice\\n') = E'\\tAlice\\n' AS tab_newline_survived;"
# Returns: t  (tab+newline NOT stripped — confirms ASCII-space-only behavior)

psql -tAc "SELECT TRIM(E'\\u00A0alice') = E'\\u00A0alice' AS nbsp_survived;"
# Returns: t  (NBSP NOT stripped)
```

Compare with the JS reference:

```js
'\tAlice\n'.trim() === 'Alice'  // true — JS strips tab and newline
' alice'.trim() === 'alice'  // true — JS strips NBSP
```

Any commit that introduces a SQL `TRIM` paired with a JS `.trim()` and claims parity should run the empirical-verification command against the production Postgres version before the claim is asserted in a JSDoc or commit message.

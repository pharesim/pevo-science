---
title: "JSONB @> containment is type-sensitive while ->> extraction text-coerces; add jsonb_typeof string guards when rewriting between them"
date: 2026-06-06
category: conventions
module: backend/src/routes/papers.ts
problem_type: convention
component: database
severity: medium
applies_when:
  - "Rewriting a JSONB @> containment predicate to a jsonb_array_elements unnest with ->> key extraction (or vice versa), typically for performance"
  - "Any ->> extraction result feeding a GROUP BY, WHERE equality, or JOIN condition that previously used containment matching"
  - "Writing or reviewing a parity canary for such a rewrite (a string-only corpus cannot see the coercion delta)"
  - "Auditing sibling unnest+extraction sites over broadcaster-controlled JSONB"
symptoms:
  - "Counts or matches silently widen after a containment-to-extraction rewrite; no error anywhere in the stack"
  - "Old-vs-new parity canary stays green because its corpus seeds only string-typed values"
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - testing_framework
tags: [postgres, jsonb, jsonb-typeof, containment, text-coercion, sql-parity, parity-canary, hafsql]
---

# JSONB @> containment is type-sensitive while ->> extraction text-coerces; add jsonb_typeof string guards when rewriting between them

## Context

The `/api/papers` listing's citation count was rewritten from a per-row correlated containment subquery to a single inverted aggregate CTE (`paper_citation_counts`). The old form matched citations with JSONB containment:

```sql
ci.json_metadata -> $appTag -> 'citations'
  @> jsonb_build_array(jsonb_build_object('author', c.author, 'permlink', c.permlink))
```

The new form unnests with `jsonb_array_elements` and extracts with `->>`:

```sql
cit ->> 'author' AS cited_author,
cit ->> 'permlink' AS cited_permlink
```

The two operators have different type semantics. `@>` is JSONB-type-sensitive: the JSON number `123` does NOT contain-match the JSON string `"123"`. `->>` text-coerces every scalar unconditionally: number `123` becomes text `'123'`, boolean `true` becomes `'true'`. The rewrite therefore silently widened match semantics for any citation whose `author` or `permlink` value was broadcast as a non-string JSON type, and the old-vs-new parity canary stayed green because its synthetic corpus seeded only string-typed values. Both shapes agree on an all-string corpus, so the test proved nothing about the coercion delta.

## Guidance

When a rewrite crosses the containment-to-extraction boundary, `jsonb_typeof` string guards on every extracted key are part of parity, AND the parity corpus must include non-string-typed values for those keys.

Before (missing guards; diverges from `@>` on non-string types):

```sql
WHERE ...
  AND jsonb_typeof(cit) = 'object'
  AND cit ->> 'author' IS NOT NULL
  AND cit ->> 'permlink' IS NOT NULL
```

After (guards restore parity with `@>`):

```sql
WHERE ...
  AND jsonb_typeof(cit) = 'object'
  AND jsonb_typeof(cit -> 'author') = 'string'
  AND jsonb_typeof(cit -> 'permlink') = 'string'
  AND cit ->> 'author' IS NOT NULL
  AND cit ->> 'permlink' IS NOT NULL
```

The `IS NOT NULL` guards stay (they catch absent keys); the string-type guards are added alongside (they catch present-but-wrong-typed values, which `IS NOT NULL` on a `->>` extract admits after coercion).

Parity-corpus rows that make the canary discriminating (extend the VALUES corpus and assert old = new = 0):

```sql
-- numeric permlink: @> counts 0, unguarded ->> counts 1
('citer6', 'c6', '{"pevotest":{"type":"paper","citations":[{"author":"victim","permlink":123}]}}'::jsonb),
-- boolean field: @> counts 0, unguarded ->> counts 1
('citer7', 'c7', '{"pevotest":{"type":"paper","citations":[{"author":true,"permlink":"paper-X"}]}}'::jsonb)
```

Enforcement site: the `paper_citation_counts` CTE in the `/api/papers` listing query (`fetchPapersFromHaf` in `backend/src/routes/papers.ts`); the parity canary lives in `backend/tests/routes/citation-count-inverted-cte.test.ts`.

## Why This Matters

Citation metadata is broadcaster-controlled: any accredited account writes its own `pevo.citations`. All-digit permlinks are valid on Hive, so under the unguarded extraction shape a crafted citation `{"author":"victim","permlink":123}` counts against the real paper `victim/123` where the containment shape counted 0 (reproduced live on Postgres: old=0/new=1 for number and boolean values). There is no error anywhere; the inflated count is only visible by running both shapes against the same corpus.

Sibling-site note: the reputation cycle's citation aggregation (`backend/src/reputation.ts`) uses the same unnest+`->>` idiom but was extraction-based from the start (no containment contract to diverge from), and its `cit ->> 'author'` matches against accredited Hive account names, which must start with a letter, so numeric coercion cannot land there. When auditing extraction sites, weigh what namespace the coerced text can actually reach.

## When to Apply

- Any rewrite replacing `@>` containment with unnest+`->>` extraction over chain-controlled JSONB (or the reverse). The shapes are not semantically equivalent on non-string scalars.
- Reviewing parity canaries for such rewrites: the corpus must include at least one non-string value per extracted key; an all-string corpus gives a false green.
- Any `->>` result feeding GROUP BY / WHERE equality / JOIN conditions: coercion happens silently at the `->>` boundary and downstream SQL sees only text.

## Examples

Minimal repro (verified on Postgres):

```sql
SELECT ('{"p":123}'::jsonb) @> '{"p":"123"}'::jsonb AS contains;   -- false
SELECT ('{"p":123}'::jsonb ->> 'p') = '123'        AS extracts;   -- true
```

The divergence is standard Postgres JSONB semantics, not an application edge case.

## Related

- `agents/docs/solutions/conventions/pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12.md` — sibling axis: JSONB null defeats `IS NOT NULL` shape guards; same fix tool (`jsonb_typeof`), different counter-intuition.
- `agents/docs/solutions/conventions/sql-jsonb-extract-empty-string-vs-null-parity-2026-05-16.md` — nearest `->>` coercion sibling: emptiness axis (empty string is non-NULL) vs this entry's type-matching axis.
- `agents/docs/solutions/conventions/pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16.md` — guard-placement axis for the same unnest idiom (array guard belongs in the SRF argument).
- `agents/docs/solutions/conventions/pg-bigint-default-stringification-defeats-typeof-cast-guards-2026-05-06.md` — driver-layer member of the same "type-system counter-intuition defeats a naive guard" family.
- `agents/docs/solutions/conventions/mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` — parent principle for the corpus rule: the data the test sees must exercise the branch the kill claim names.

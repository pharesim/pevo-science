---
title: "json_metadata on chain-sourced objects is a raw map, always access PEvO data via safePevoMeta"
date: 2026-06-06
category: conventions
module: backend/src/routes
problem_type: convention
component: database
severity: high
applies_when:
  - "Reading any PEvO-scoped field (authors, source.doi, type, citations, etc.) from a chain-sourced detail, row, or meta object"
  - "Writing or reviewing a new generator, exporter, or serializer that receives a Hive post detail struct"
  - "Writing synthetic test fixtures that drive functions consuming json_metadata or detail objects"
  - "Adding a field to the pevo metadata object and wiring it through to an output path"
  - "Auditing silent-wrong-output regressions (HTTP 200, incorrect data) on chain-derived metadata reads"
symptoms:
  - "Authors list silently falls back to the posting account; co-author names never appear in exports"
  - "DOI field is always absent from citation exports despite being present on-chain"
  - "Unit tests stay green while production output is wrong because fixtures mirror the buggy read shape"
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - testing_framework
tags: [chain-metadata, json-metadata, safepevometa, app-tag, citation-export, fixture-shape, silent-wrong-output, mutation-kill]
---

# json_metadata on chain-sourced objects is a raw map, always access PEvO data via safePevoMeta

## Context

The `/cite` citation generators (`generateBibtex` / `generateRis` / `generateApa` in `backend/src/routes/papers.ts`) shipped a dead-key read for their entire operational life without triggering any error. They sourced co-author names from `detail.json_metadata.pevo.authors` and the DOI from `detail.doi`. Neither key is ever populated on the live path: `detail.json_metadata` IS the raw Hive chain metadata map, and PEvO data lives under `meta[config.appTag]` (`'pevotest'` in beta), not under a literal `"pevo"` key. Exports silently listed only the posting account as author and never emitted a DOI, as structurally valid, HTTP-200 output.

The defect survived the test suite because the fixtures were built by reading the code's access pattern and transcribing it (`json_metadata: { pevo: { authors: [...] } }`), rather than by consulting the live data contract. A fixture shaped to the code under test confirms the code's behavior, correct or broken; it can never detect a key-path bug. The bug was discovered only when a DOI-wiring attempt (`pevo.source.doi`) turned out to be ineffective for the same reason; that wiring was deliberately reverted rather than shipped as dead code, and the root cause fixed directly.

## Guidance

**The keying invariant.** `detail.json_metadata` (and any `row.json_metadata` from a HAF query result) is the raw chain metadata map. PEvO data is stored under the key `config.appTag`. There is no top-level `"pevo"` key. The canonical accessor is `safePevoMeta`:

```ts
function safePevoMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const pevo = meta[config.appTag];
  if (pevo != null && typeof pevo === 'object' && !Array.isArray(pevo)) {
    return pevo as Record<string, unknown>;
  }
  return {};
}
```

Never index the metadata map with a string literal other than via `config.appTag`. For author names specifically, read `detail.authors`, the `{name, hive, orcid}` projection that every paper-detail build path produces (single-link `buildPaperDetail`, the `authorsWithSupersessionSelect` SQL COALESCE projection, and the continuation-path `buildCumulativeAuthorsForChain`); `name` is total on all three.

**The fixture-shape rule.** Construct fixtures from the live data contract, not from the code's access pattern:

```ts
// Correct: mirrors the live chain shape (key computed from config.appTag)
const pevoMeta = (pevo: Record<string, unknown>) => ({ [config.appTag]: pevo });
const detail = { json_metadata: pevoMeta({ source: { doi: '10.1000/xyz123' } }) };

// Wrong: mirrors a dead access pattern; the test confirms the bug instead of detecting it
const detail = { json_metadata: { pevo: { authors: [{ name: 'Alice' }] } } };
```

**The regression pin.** Keep a mutation-kill test that populates the dead key with a sentinel and the live field with real data, then asserts the sentinel never appears in output. In `backend/tests/routes/papers-cite-escape.test.ts`, the generators are driven with `detail.authors = [real names]` plus `json_metadata: { pevo: { authors: [{ name: 'Ghost Author' }] } }`; the assertion requires the real names in the BibTeX author field and forbids `Ghost Author`. A generator reverting to the `.pevo` read turns the test red.

## Why This Matters

A dead-key read returns `undefined` silently. The code falls through to a fallback and produces structurally correct output with wrong data: no exception, no 4xx/5xx, no log line. This is the worst failure mode, invisible in operation and confirmed-green by a fixture-mirrored test suite, observable only by a human who knows what correct output looks like. Any code reading `someObj.json_metadata.pevo` (a literal `pevo` key instead of `safePevoMeta`) is broken the same way today.

## When to Apply

- Any new read of PEvO fields off a `json_metadata` object, wherever the object came from (HAF row, paper detail builder, cumulative chain walk).
- Any fixture for chain-sourced shapes. Ask: does this fixture reflect the live chain shape, or what the code happens to read?
- Reviewing diffs that touch `json_metadata` access: `grep -rn "json_metadata\b.*\.pevo\b\|\.pevo\s*||" backend/src/` (any hit outside `safePevoMeta`-adjacent docblocks is a red flag).

## Examples

Before (dead read; co-authors and DOI silently absent):

```ts
const pevo = ((detail.json_metadata as Record<string, unknown>)?.pevo || {}) as Record<string, unknown>;
const authors = (pevo.authors || []) as Array<{ name: string }>;
const doi = detail.doi as string | undefined;
```

After (live-keyed read via canonical helpers):

```ts
function citeAuthorNames(detail: Record<string, unknown>): string[] {
  const authors = Array.isArray(detail.authors)
    ? (detail.authors as Array<Record<string, unknown>>)
    : [];
  return authors.map((a) => (typeof a.name === 'string' ? a.name : ''));
}

function citeDoi(detail: Record<string, unknown>): string | undefined {
  const pevo = safePevoMeta((detail.json_metadata as Record<string, unknown>) ?? {});
  const doi = (pevo.source as Record<string, unknown>)?.doi;
  return typeof doi === 'string' && doi.length > 0 ? doi : undefined;
}
```

## Related

- `agents/docs/solutions/conventions/contract-field-removal-sweep-consumers-and-fixtures-2026-05-26.md` — closest structural sibling: a fixture encoding a stale or wrong wire shape keeps tests green while the consumer is broken; this entry is the chain-metadata key-path variant.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — the root principle the dead-key mutation-kill test applies: a spec protecting a property must fail when the property is reverted.
- `agents/docs/solutions/conventions/mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` — governs honestly describing what the dead-key mutation-kill actually catches.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — the grep-don't-enumerate call-site discipline; a literal `.pevo` read is the canonical missed-site failure mode for the `safePevoMeta` wrapper.

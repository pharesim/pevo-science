# BACKEND-CITATION-CO-AUTHOR-VOTER-EXCLUSION — co-author voters on citing paper not excluded from `weighted_upvotes`; citation-score inflation vector

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #13 medium severity, correctness)
**Priority:** P2 (documented invariant violated; inflation vector via confederate listing)

## Problem

`paper_resolved_votes` in [reputation.ts:915-960](backend/src/reputation.ts#L915-L960) excludes the paper author AND any account in `pevo.authors[].hive`. But `citing_paper_quality.weighted_upvotes` only excludes byte-equality against `citing_author`.

A citing-paper author lists a confederate in `pevo.authors[]`; the confederate upvotes the citing paper; inflated `LEAST(weighted_upvotes, 1.0)` multiplies into `citation_value` for the cited author.

Documented invariant ([reputation-algorithm.md line 71](agents/docs/reputation-algorithm.md)) explicitly says co-authors are filtered. `cp.citing_meta` is already SELECTed at line 867 but never consumed — looks like the data plumbing was prepared and never wired.

## Goal

Apply the same co-author exclusion to `weighted_upvotes` as already exists in `paper_resolved_votes`.

### Suggested approach

Add a `NOT EXISTS` over `cp.citing_meta -> $appTag -> 'authors'` inside the existing FILTER clause of `weighted_upvotes` (`citing_meta` already in scope, no extra JOIN). Mirror the canonicalization shape from `paper_resolved_votes` lines 674-682 verbatim:
- `jsonb_typeof` array guard.
- Inner object guard.
- `LOWER(TRIM(...))` regex.
- `= clv.voter` equality.

Drop the now-redundant byte-equality `clv.voter != cp.citing_author` (subsumed by the canonicalizing NOT EXISTS — `citing_author` is always in `pevo.authors[]`).

## Acceptance

- Regression test: a confederate listed in `citing.pevo.authors[]` upvotes the citing paper; their vote does NOT contribute to the cited author's `citation_value`.
- The author of the citing paper is still excluded (no regression).
- Existing citation-score tests stay green; numeric values for the unaffected cases unchanged.
- Pin via test that the canonicalization shape (TRIM + LOWER + regex) matches `paper_resolved_votes` exactly — same defense-in-depth as the sibling.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Rank #37 (`backend-activeaccreditations-wrapper-dedup`) flags `cp.citing_meta` as an apparently-unused projection — it's load-bearing for this fix. Land this BEFORE #37 so the cleanup task doesn't strip the projection.
- Independent of #1 / #2 (cycle math fixes).

## Cross-references

- [backend/src/reputation.ts](backend/src/reputation.ts) lines 915-960 (`citing_paper_quality.weighted_upvotes`), lines 674-682 (`paper_resolved_votes` canonicalization shape).
- [agents/docs/reputation-algorithm.md](agents/docs/reputation-algorithm.md) line 71 (co-author exclusion invariant).
- HAF-query review run `w274tijk0` rank #13.

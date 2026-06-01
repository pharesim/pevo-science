# BACKEND-ACTIVEACCREDITATIONS-WRAPPER-DEDUP — `activeAccreditationsCte` wrapper duplicates a one-liner; `citing_papers` projects unused columns

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #37 low severity, simplification)
**Priority:** P3

## Problem

Two small dead-code cleanups:

1. `activeAccreditationsCte` wrapper in [hafsql.ts:166-170](backend/src/hafsql.ts#L166-L170) has 2 callers ([routes/reviews.ts](backend/src/routes/reviews.ts), [routes/stats.ts](backend/src/routes/stats.ts)) and is a third spelling for the `buildWith(1, body)` pattern already used elsewhere.
2. `citing_papers` in [reputation.ts:867, 869, 882](backend/src/reputation.ts) SELECTs `citing_meta` (never read — but see #13 which actually wants to USE this) and `reputation_relevant` (always true because it's WHERE-filtered to true).

## Goal

Convert the wrapper callers to use `buildWith` directly and drop the always-true projection.

### Suggested approach

- Convert [routes/reviews.ts:48](backend/src/routes/reviews.ts#L48) and [routes/stats.ts:28](backend/src/routes/stats.ts#L28) to `buildWith(1, activeAccreditationsCteBody)`. Delete the `activeAccreditationsCte` wrapper.
- For `citing_papers`: **DEFER the `citing_meta` drop until #13 (`backend-citation-co-author-voter-exclusion`) lands** — that fix consumes `citing_meta`. Only drop `reputation_relevant` projection now (always true).

## Acceptance

- `activeAccreditationsCte` wrapper deleted; 2 callers use `buildWith` directly.
- `reputation_relevant` projection removed from `citing_papers`.
- `citing_meta` projection preserved pending #13.
- Cycle output byte-identical to pre-change for the same seed.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Land AFTER #13 if #13 ships first (then `citing_meta` is in active use and the docblock can reflect that). Land standalone if #13 is far out — but flag in the commit that `citing_meta` is intentionally preserved for #13's pending use.
- Pure cleanup; no semantic change.

## Cross-references

- [backend/src/hafsql.ts](backend/src/hafsql.ts) lines 166-170 (wrapper).
- [backend/src/routes/reviews.ts](backend/src/routes/reviews.ts), [backend/src/routes/stats.ts](backend/src/routes/stats.ts) (callers).
- [backend/src/reputation.ts](backend/src/reputation.ts) lines 867, 869, 882 (`citing_papers` projection).
- HAF-query review run `w274tijk0` rank #37 (and #13 — coordinate).

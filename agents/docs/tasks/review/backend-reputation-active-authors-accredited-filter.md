# BACKEND-REPUTATION-ACTIVE-AUTHORS-ACCREDITED-FILTER — `active_authors` materializes site-wide author universe before intersecting with `accreditedArr`

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #17 medium severity, performance)
**Priority:** P2 (full corpus scan for rows that get discarded by the only consumer)

## Problem

`active_authors` in [reputation.ts:421-465](backend/src/reputation.ts#L421-L465) UNIONs every PEvO paper site-wide and every review-shaped comment, but its ONLY consumer (`voter_weights` at line 464) joins on `aa.author = a.voter` where `a.voter` iterates `accreditedArr`.

The review arm already has `c.author = ANY($2)`; the paper arm has no such filter — full corpus scan for rows that get discarded.

## Goal

Push the `accreditedArr` filter into the paper arm so `active_authors` only materializes accredited authors.

### Suggested approach

Add `AND c.author = ANY($2::text[])` to the paper arm (line 423-426). Semantically equivalent for the consumer.

Do NOT add the bridge-author OR — bridge papers' `c.author` is the bridge account, never a voter.

## Acceptance

- Trivial one-line change.
- Regression test: cycle output for the same `accreditedArr` is byte-identical to pre-change (modulo any noise; this is a perf-only change with no semantic delta).
- `EXPLAIN ANALYZE` shows the paper arm scans bounded by accredited-author set, not full corpus.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Smallest fix in the batch. Land any time after #1 (cycle off-by-one) — the cycle has to be actually computing for the perf delta to matter.

## Cross-references

- [backend/src/reputation.ts](backend/src/reputation.ts) lines 421-465 (`active_authors`), line 464 (`voter_weights` consumer).
- HAF-query review run `w274tijk0` rank #17.

# BACKEND-REPUTATION-DECAY-MULTIPLIER-HELPER — decay multiplier duplicated 3×; one-site tweak silently desyncs paper/review/citation aging

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #29 medium severity, simplification)
**Priority:** P3 (a one-site change silently desyncs paper/review/citation aging)

## Problem

Identical 7-line decay formula (`GREATEST + CASE WHEN + grace + decay_rate`) inlined in three sites in [reputation.ts:733-739](backend/src/reputation.ts#L733-L739), [837-843](backend/src/reputation.ts#L837-L843), and [967-974](backend/src/reputation.ts#L967-L974) — `paper_scores`, `review_scores`, `citation_scores`.

Differs only in the created-column reference (`up.created` / `ur.created` / `cpq.citing_created`). A one-site change silently desyncs paper/review/citation aging.

## Goal

Extract one helper that emits the SQL fragment so all three sites share it.

### Suggested approach

Extract `decayMultiplierSql(createdExpr, opts?: {weightsAlias?, cycleRefAlias?})` in [hafsql.ts](backend/src/hafsql.ts).

Note: the outer `GREATEST(w.decay_floor, ...)` wrapper is redundant — inner `THEN` returns `1.0` (≥ `decay_floor` by construction) and inner `ELSE` already wraps in `GREATEST`. Non-redundant helper body:

```sql
CASE WHEN months <= grace THEN 1.0
     ELSE GREATEST(w.decay_floor, 1.0 - ((months - grace) * w.decay_rate))
END
```

Pin with a snapshot test.

## Acceptance

- The 3 inlined formulas are replaced by helper invocations; SQL output for each site is verifiable.
- Snapshot test pins the helper's SQL output exactly.
- Cycle output byte-identical to pre-change for the same seed (perf+correctness regression test).
- The outer `GREATEST` redundancy is removed without changing numeric output (the inner already enforces the floor).
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Pure simplification; no semantic change.
- Coordinate with #28 (claims CTE dedup) if both land in the same week — both touch `reputation.ts` structurally.

## Cross-references

- [backend/src/reputation.ts](backend/src/reputation.ts) lines 733-739 (`paper_scores`), 837-843 (`review_scores`), 967-974 (`citation_scores`).
- [backend/src/hafsql.ts](backend/src/hafsql.ts) — destination for the helper.
- HAF-query review run `w274tijk0` rank #29.

## Backend signal (2026-06-05, commit on main)

Extracted `decayMultiplierSql(createdExpr, opts?)` into `hafsql.ts` (mirrors the `accreditedVoteCount` helper shape) and replaced the three inlined copies in `reputation.ts` (`paper_scores` / `review_scores` / `citation_scores`, keyed on `up.created` / `ur.created` / `cpq.citing_created`). The redundant outer `GREATEST(w.decay_floor, ...)` is removed at all three sites — numeric output is identical (the grace arm returns 1.0 >= decay_floor, the decay arm already floors via GREATEST), so this is pure simplification. Snapshot test in `hafsql.test.ts` pins the exact emitted SQL for the default and alias-override variants plus a single-GREATEST assertion (kills the redundant-outer-floor regression). `npm run typecheck` + `npm run lint` clean; hafsql snapshot + a real cycle run (reputation-batch-cycle-boundary, reputation-batch-internals) green.

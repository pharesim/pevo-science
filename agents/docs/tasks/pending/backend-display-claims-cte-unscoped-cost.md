# BACKEND-DISPLAY-CLAIMS-CTE-UNSCOPED-COST — unscoped authorshipClaimsCteBody on hot listing/search/stats display paths; per-row LATERAL re-eval + no-catch cascade

**Owner:** backend
**Created:** 2026-06-09 (architect `/ce-code-review` follow-up from `backend-claimer-self-review-display-callsite-exclusion`; performance + adversarial lenses)
**Priority:** P2 (latent perf/reliability risk on the live beta. "Claims are low-cardinality" holds today, so this is not a correctness break — but the hot listing path now depends on claim-set cost, and a planner-stats shift or a claim-spam flood could surface it.)

## Problem

`backend-claimer-self-review-display-callsite-exclusion` threaded `authorshipClaimsCteBody` into the display review/vote surfaces to exclude credited-claimer self-reviews/self-votes. On the multi-paper surfaces it is materialized UNSCOPED (full claim set), and on the listing path it is referenced inside a per-row LATERAL via `excludeClaimedSelfWhere`'s `NOT EXISTS`. Two concerns surfaced in review (performance, confidence 75; adversarial cascade, confidence 50):

1. **Per-row LATERAL re-evaluation.** PG12+ inlines single-reference CTEs by default. If the planner inlines `authorship_claims` into the listing's `reviewAggLateral`, the full `claim_events -> claims_base -> approvals -> revocations -> authorship_claims` chain (including correlated EXISTS against `hafsql.comments`) re-runs once per paper row on the page. Each scan is `custom_id`-selective and fast today, but the inlining behavior is unverified.
2. **No-catch cascade coupling.** The new accepted-claims query sits in a `Promise.all` with no per-query catch, so a claim-cardinality-induced statement_timeout (a flood of cheap pending `claim_authorship` ops bloats the pre-status-filter CTE materialization) would reject the whole listing, not just the exclusion. An accredited attacker can spam pending claims cheaply.

## Goal

Bound the claims-CTE cost on the hot display paths and decouple listing availability from claim cardinality, without weakening the exclusion semantics that the parent task established.

### Suggested approach

- Confirm with EXPLAIN ANALYZE whether PG fences `authorship_claims` above the listing LATERAL or inlines it per-row. If per-row: `AS MATERIALIZED` on the CTE, or restructure `excludeClaimedSelfWhere` as a LEFT JOIN anti-join evaluated once outside the LATERAL.
- Scope the listing/search/stats claims materialization by the page's paper-key set (bounded by page size) instead of unscoped, OR confirm a single per-page scan is acceptable and pin it.
- Decouple the accepted-claims query from listing availability: catch/degrade (serve un-excluded but available) rather than reject the whole `Promise.all`, OR document why a claims-query failure should fail the listing.
- Single-review fetch (`reviews.ts`) should scope `authorshipClaimsCteBody` by `{ claimer: author }` (currently unscoped, and not cached per-review-URL at the hafCache layer).

## Acceptance

- EXPLAIN ANALYZE evidence recorded (inlined-per-row vs fenced-once) for the listing path.
- The hot listing/search/stats display query cost is bounded by page size, not total claim history (or a documented rationale + pin if a single per-page scan is kept).
- A claims-query timeout no longer fails the entire listing (degrade, or documented rationale for fail-closed).
- `reviews.ts` single-review fetch scopes the claims CTE by claimer.
- Exclusion semantics unchanged (the behavioral canary from the parent task stays green).
- `npm run typecheck` + `npm run lint` clean; comment anchors on stable symbols.

## Cross-references

- `backend/src/routes/papers.ts` (`fetchPapersFromHaf` listing `reviewAggLateral`; `batchResolveVotes` claims query; `fetchEnrichmentFromHaf`), `search.ts`, `stats.ts`, `reviews.ts`.
- `backend/src/hafsql.ts` (`authorshipClaimsCteBody`, `excludeClaimedSelfWhere`, `buildWith`).
- Parent: `backend-claimer-self-review-display-callsite-exclusion`.
- Related: the BitmapAnd-toxic-floor + statement_timeout-budget learnings under `agents/docs/solutions/`.

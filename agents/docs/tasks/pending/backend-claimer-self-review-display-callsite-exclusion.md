# BACKEND-CLAIMER-SELF-REVIEW-DISPLAY-CALLSITE-EXCLUSION — drop a credited claimer's self-review/self-vote from the DISPLAY surfaces

**Owner:** backend
**Created:** 2026-06-06 (from the `backend-co-author-claim-zero-score` re-review; display-side residual of Item 2)
**Priority:** P2 (display-integrity gap; no computed-reputation effect)

## Problem

`backend-co-author-claim-zero-score` closed the claimer self-vote/self-review self-dealing on the **reputation cycle** (`reputation.ts` `paper_resolved_votes` / `paper_reviews` now reject any `accepted_claims` claimer via `NOT EXISTS`). The **display** surfaces were deferred: `excludeSelfReviewWhere` (`hafsql.ts`) and the display vote/review aggregations at the paper-detail / profile / search / stats / reviews-list callsites still exclude only the chain poster and `authors[].hive` members — NOT `accepted_claims` claimers.

So a credited **ORCID-matched or name-only-slot** claimer (one who is absent from `authors[].hive`) can self-review (e.g. 5/5/5/5) and self-vote their own paper and inflate the **displayed** `avg_rating`, `review_count`, `net_votes`, and the third-party-review list. This moves **no computed reputation score** (verified during re-review: `reputation.ts` consumes no display-surface review aggregate), so it is a display-integrity gap, not a score exploit. The `excludeSelfReviewWhere` docblock already tracks it ("when the vote path picks up claims, this helper should too").

Surfaced by the re-review of `backend-co-author-claim-zero-score` (adversarial P2 / security P3 / correctness residual — all agreed: display-only, correctly deferred by the implementer, file as follow-up).

## Goal

Extend the display-side review/vote exclusion to also drop `accepted_claims` claimers for the chain post, mirroring the cycle's Item 2 gate, at the display callsites that compose `excludeSelfReviewWhere` and the display vote aggregation. Prefer composing the existing claims CTE into the exclusion over duplicating the predicate.

## Acceptance

- A credited claimer's self-review does NOT appear in the displayed third-party-review list and does NOT count toward the displayed `avg_rating` / `review_count` at paper-detail, profile, search, and stats.
- A credited claimer's self-vote does NOT count toward displayed `net_votes`.
- The `excludeSelfReviewWhere` docblock is updated once the display path is closed (the cycle side is already done; see the `backend-co-author-claim-zero-score` round-3 H2 note).
- A test pins that a credited ORCID/name-only claimer's self-review is excluded from a display surface (the cycle side is already pinned).
- `npm run typecheck` + `npm run lint` clean; comment anchors on stable symbols.

## Cross-references

- `backend/src/hafsql.ts` (`excludeSelfReviewWhere`, `authorshipClaimsCteBody`), `backend/src/routes/papers.ts` (review-agg LATERAL, enrichment review list), plus the profile / search / stats review aggregations.
- Cycle-side precedent: `backend-co-author-claim-zero-score` (Item 2).
- **Related:** `backend-implement-consented-authorship-model` — the consented-set migration re-keys credit; align the display exclusion with whichever set ends up authoritative so the two land coherently.

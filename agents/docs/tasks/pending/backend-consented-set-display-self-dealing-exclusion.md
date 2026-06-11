# BACKEND-CONSENTED-SET-DISPLAY-SELF-DEALING-EXCLUSION — extend the display self-dealing exclusion from accepted claims to the full consented set

**Owner:** backend
**Created:** 2026-06-11 (architect `/ce-code-review` of `backend-implement-consented-authorship-model`; correctness + adversarial corroborated, validated at HEAD; user-elected at triage)
**Priority:** P2 (latent cycle-vs-display drift; it goes live the moment the first `author_accept` lands on chain. The UI consent surface is still blocked, so there is lead time, but this should land before consent affordances ship.)

## Problem

The reputation cycle now excludes ANY consented author's self-votes/self-reviews (both NOT EXISTS self-dealing gates in `computeReputationBatch` were generalized to the consented set). The display surfaces still exclude only Route-3 accepted-claims self-dealing:

- `excludeClaimedSelfWhere` (hafsql.ts) tests `authorship_claims.status = 'accepted'` only — consumed by the listing rev_agg LATERAL, the paper-detail review list, reviews.ts, profile.ts, search.ts, and stats.ts.
- `batchResolveVotes` (papers.ts) drops self-votes/revotes against the accepted-claims set only.

Since the metadata auto-accept arms were deleted, a Route-2 consented co-author (ORCID- or hive-anchored `author_accept`) has NO accepted-claims row: the cycle excludes their self-votes/reviews, but displayed `avg_rating` / `review_count` / `net_votes` count them. The `excludeClaimedSelfWhere` docblock parity promise ("exactly as the score path does") is broken for the consented set. This is the cycle-vs-display drift class the shared-builder design exists to prevent.

## Goal

Display review/vote aggregates exclude self-dealing by the SAME credited set the cycle uses: accepted claims plus consented authors (Routes 1/2/3 minus demotions).

### Suggested approach

- Add a consented-set sibling of `excludeClaimedSelfWhere` (NOT EXISTS over `consented_authors`), composed from `consentChainCteBody` + `consentedAuthorsCteBody` — or a combined credited-set helper covering both populations.
- Scoping needs the same care the claims CTE got in `backend-display-claims-cte-unscoped-cost`: per-paper scope on detail/reviews; on listing/search/stats either a bounded seed or the accepted one-fenced-resolution-per-query shape with a MATERIALIZED pin and a rationale comment. Gather EXPLAIN evidence on the listing path before choosing.
- Update the `excludeClaimedSelfWhere` docblock parity sentence ("exactly as the score path does") to describe the combined set once it is true again.
- Cycle-vs-display parity tests: a Route-2 consented co-author's self-review/self-vote excluded from listing avg_rating/review_count, the detail review list, and batchResolveVotes net_votes — the inverted sibling of the existing claimer display canaries.

## Acceptance

- A Route-2 consented co-author's self-review/self-vote is excluded from every display aggregate that already excludes Route-3 claimer self-dealing (listing, detail, reviews, profile, search, stats, vote batch).
- Display cost stays bounded per the claims-CTE precedent (EXPLAIN evidence recorded for the listing path; rationale pinned at unscoped sites if that arm is chosen).
- Accepted-claims exclusion semantics unchanged (existing canaries stay green).
- `npm run typecheck` + `npm run lint` clean; comment anchors on stable symbols.

## Cross-references

- `backend/src/hafsql.ts` (`excludeClaimedSelfWhere`, `consentChainCteBody`, `consentedAuthorsCteBody`), `backend/src/routes/papers.ts` (`batchResolveVotes`), `reviews.ts`, `search.ts`, `stats.ts`, `profile.ts`.
- Parents: `backend-implement-consented-authorship-model` (the credited-set change), `backend-display-claims-cte-unscoped-cost` (the cost-bounding precedent).
- `backend-consented-set-read-surfaces` (the badge consumes the same consent stack per-paper).
- `ui-multi-author-consent-affordances` (blocked — should not ship ahead of this fix).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

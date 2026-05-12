# Exclude self-reviews everywhere — display surfaces and reputation cycle

**Owner:** Backend Agent
**Created:** 2026-05-12

## Problem

Self-votes are already excluded from every surface that aggregates votes (paper author and named co-authors at `reputation.ts:555-560`, review author at `reputation.ts:652`, native-vote display at `papers.ts:2179, 2189`, scalar `accreditedVoteCount` at `hafsql.ts:467`, and the citation discount path at `reputation.ts:742-774`). The principle is settled: an account cannot vote for itself.

Self-*reviews* are not excluded anywhere. A paper author who is accredited (or a named co-author who is accredited) can broadcast a review-shaped reply to their own paper and:

- The review surfaces on the paper detail page (`papers.ts:2195-2198` — no `c.author != $1`).
- It increments `review_count` (`papers.ts:455-458` — no self-exclusion).
- It is averaged into `avg_rating` (`papers.ts:471-474` — no self-exclusion). Five-fives on one's own paper inflate the displayed score.
- It contributes to `paper_reviews.quality` in `reputation.ts:563-577`. This is the load-bearing path: `paper_scores` (`reputation.ts:591`) multiplies the paper's vote-derived score by `COALESCE(pr.quality, 1.0)`. A self-5/5/5/5 pushes `pr.quality` toward 1.0 (max), boosting the paper's contribution to its author's reputation.
- It enters `user_reviews` in `reputation.ts:609-616`. (Impact on the reviewer's own `reviews` score is bounded — third-party votes are required to score, and self-votes are already excluded — but the row is still admitted into the reviewer's review universe.)
- It triggers a "new review" notification to the paper author (`notification-queries.ts:169, 190`), which is the author notifying themselves.

The user-facing principle is: a self-review is worthless and must be excluded from every surface that counts or displays reviews, mirroring the self-vote treatment. Per analogy with `paper_resolved_votes` (which excludes paper author *and* named co-authors), the self-review exclusion should also include named co-authors and accepted-claimant authors.

## Acceptance criteria

### 1. Define the exclusion predicate

Centralize the predicate so callsites compose rather than duplicate. Recommended shape: a helper that returns the WHERE fragment

```sql
c.author != <paper_author>
AND NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements(<paper_row>.json_metadata -> $appTag -> 'authors') a
  WHERE a ->> 'hive' = c.author
)
```

(Authorship-claim coverage: claims are tracked via the `authorship_claims` CTE in `routes/papers.ts:2204-2211` and elsewhere. If a claimant has an `accepted` claim, they are effectively a co-author for reputation purposes — see how `paper_resolved_votes` handles them at `reputation.ts:557-560` and replicate. If claims are NOT trivially join-able at every callsite, an acceptable compromise is to exclude only `paper_author + named co-authors` at the SQL layer and document the claimant gap; that matches the existing `paper_resolved_votes` shape pre-claims-integration.)

### 2. Apply the predicate at every review-aggregating site

**Display path:**
- `backend/src/routes/papers.ts:455-458` — listing `review_count` (exclude self from count)
- `backend/src/routes/papers.ts:471-474` — listing `avg_rating` (exclude self from avg)
- `backend/src/routes/papers.ts:2195-2198` — paper detail review list (do not surface self-reviews at all). The frontend's `isOwnPaper` gate on the "Write Review" CTA (`paper-detail.js:512, 666`) is the prevention layer; this SQL exclusion is the cleanup layer for chain rows that bypassed the UI (peakd/raw broadcast).
- `backend/src/routes/profile.ts:96` — profile reviews list: a profile showing the user's own reviews of their own papers is misleading. Exclude.
- `backend/src/routes/search.ts:165` — search type=review: self-reviews should not be searchable as "reviews of this paper".
- `backend/src/routes/stats.ts:56` — review counter (consistent with `review_count` exclusion).

**Reputation path:**
- `backend/src/reputation.ts:563-577` — `paper_reviews` quality CTE. Add `AND c.author != up.author` plus the co-author predicate. This is the load-bearing fix — a self-5/5/5/5 currently inflates the paper's `quality` multiplier.
- `backend/src/reputation.ts:609-616` — `user_reviews` CTE: exclude reviews on papers authored by the same user. (Co-author exclusion requires a join against the cited paper's authors metadata.)
- `backend/src/reputation.ts:755-759` — citation-class review context: verify and apply if applicable.

**Notifications:**
- `backend/src/notification-queries.ts:169, 190` — self-review notifications: an author should not be notified that they reviewed their own paper.

### 3. Tests

Use real HAF (no mocking; see CLAUDE.md "Running Tests"). Canaries:

- **Self-review by paper author** (accredited): does NOT surface on detail, does NOT count toward `review_count` or `avg_rating`, does NOT contribute to `paper_reviews.quality`, does NOT generate a notification, does NOT appear in the author's profile reviews.
- **Self-review by named co-author** (accredited): same exclusions. Confirms the predicate matches `paper_resolved_votes` semantics.
- **Review by a non-author accredited reviewer**: surfaces normally (this is the happy-path control — pins that the exclusion only filters self/co-author, nothing wider).
- **Author broadcasts self-review with 5/5/5/5 ratings**: confirms the paper's `paper_scores` does not inflate. This is the most consequential canary because the path-of-impact is via the quality multiplier, not the reviewer's own rep score.

## Implementation notes

- Companion task: `backend-review-validity-gate-and-display-reputation-parity.md` (sibling). Both tasks touch overlapping SQL sites — coordinate with the architect on order. If validity lands first, this task adds `AND c.author != <paper_author>` to the helper; if self-exclusion lands first, the validity task composes its rating-shape check against the self-excluded set. Either order works.
- The CLAUDE.md "Code Review Findings" rule applies: do not silently fix; surface findings, get triage, then implement.
- Reputation cycle length is 1 day in beta (per memory `project_reputation_cycle_length.md`); a fix lands in a single cycle. No long backfill window.
- The `notification-queries.ts` self-notification exclusion is a small UX polish independent of the SQL-level fixes; can be split into a sub-step if scope expands.
- Worth verifying: does `reputation.ts:759` (the citation-class review context near line 755) need the same predicate, or is it a different code path? Read the surrounding context (citing-papers / citation-vote walking) before applying blindly.

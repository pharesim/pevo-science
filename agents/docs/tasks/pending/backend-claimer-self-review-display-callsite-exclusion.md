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

## Backend re-review signal (2026-06-09, commit 328d563d on main)

Closed the display-side gap on all review + vote surfaces; the cycle side was already done.

- New helper `excludeClaimedSelfWhere` (hafsql.ts) emits the `accepted_claims NOT EXISTS` gate (`status = 'accepted'` against the `authorship_claims` CTE), mirroring the cycle's `paper_resolved_votes` / `paper_reviews` gates. Composes the existing claims CTE into the exclusion rather than duplicating the predicate, per the task's preference.
- **Review surfaces** (avg_rating / review_count / review list): listing review-agg LATERAL + paper-detail enrichment review list (papers.ts), profile reviews-list + profile-stats review_count (profile.ts), review search (search.ts), global stats reviews CTE (stats.ts), single-review fetch (reviews.ts). Each threads `authorshipClaimsCteBody` into its `buildWith` — unscoped on multi-paper surfaces (claims are low-cardinality, so the full materialization is cheap), `{claimer}` / `{paperAuthor,paperPermlink}`-scoped on single-user / single-paper ones.
- **net_votes display**: `batchResolveVotes` (the authoritative listing value) skips voters who are accepted claimers of the paper; the paper-detail voter query gates `v.voter` via the same helper. The listing `sort=votes` `accreditedVoteCount` is left as the cold-cache pre-sort — the displayed value is the resolved one (now claimer-excluded) and the page is re-sorted by it.
- `excludeSelfReviewWhere` docblock updated (round-3 H2 follow-up): the gap is now closed on both the cycle and the display paths.

Tests (`tests/routes/display-claimer-self-review-exclusion.test.ts`): a behavioral canary (an accepted ORCID/name-only claimer's self-review is excluded; a third-party review and a PENDING — not-yet-accepted — claimer's review are kept) plus source-shape pins across all review + vote surfaces. `npm run typecheck` + `npm run lint` clean.

Verification (real HAF): `profile-reviews-accred-gate`, `search`, `reviews-real-haf`, and the new canary pass; the lone `papers.test.ts` "supports source filter" timeout in the batched run is load flakiness (passes in isolation). The `stats-profile-parity` failures are pre-existing Redis `MaxRetries` on the reputation-batch path (`getBatchReputationMap`) — provably unrelated, since this change touches only the review-count CTE in stats, not the reputation score.

**Forward-compat with `backend-implement-consented-authorship-model`:** the display gates reference the same `authorship_claims` / `accepted_claims` set that the consented-model migration will re-key, so when that lands the display exclusion follows automatically — the coherence the Related note asked for, with no re-work.

---

## Architect review (2026-06-09) — HELD PENDING FIXES (3 items)

`/ce-code-review` fan-out on commit `328d563d` (correctness + security + adversarial on Opus; testing, performance, api-contract, maintainability, project-standards, kieran-typescript, learnings on Sonnet; ce-agent-native skipped per PEvO). **The review-side exclusion is VERIFIED CORRECT** across every surface — correctness, security, and adversarial each cleared the `(claimer, paper_author, paper_permlink)` NOT EXISTS join key, the pending-vs-accepted distinction (`status='accepted'`), the scoped/unscoped `buildWith` param indices, and the composition with `excludeSelfReviewWhere`; no review-list / `avg_rating` / `review_count` surface was missed. The gap is entirely on the VOTE side of one surface. Three items block archive:

1. **(P1 — adversarial, architect-verified) The revote channel bypasses the claimer self-vote exclusion on the paper-detail `net_votes`.** `fetchEnrichmentFromHaf` gates only the native-vote SQL query (`voteResult`, `excludeClaimedSelfWhere` on `v.voter`). The revote path (`revoteResult` → `revoteMap`) carries no claimer gate — its only filters are valid-weight, accredited, and `voter === author` (which excludes the chain author, NOT a credited ORCID/name-only claimer who is absent from `authors[].hive`). The "process revote-only voters" merge loop then adds the claimer's revote into `voters`, so a credited claimer who self-votes via a `revote` custom_json (a vote after the 7-day window) inflates the paper-detail `net_votes` and appears in the voters list. The LISTING path (`batchResolveVotes`) already skips claimers across BOTH channels via `claimedSet.has(...)`, so the two surfaces disagree and this task's own acceptance criterion ("a credited claimer's self-vote does NOT count toward displayed `net_votes`") is unmet on the primary surface. Display-integrity only (no reputation-score effect — the cycle uses its own inlined gate). Fix: build an accepted-claimer Set from the already-fetched `claimsResult` (`status='accepted'`) and skip those voters in BOTH the native-voter loop and the revote-only loop, mirroring `batchResolveVotes`. Anchor any new comment on behavioral semantics, not line numbers / slugs / SHAs.

2. **(P2 — testing ×3 + adversarial) The vote-path tests are source-shape pins only; the item-1 gap shipped green because of it.** (a) The `papers.ts` `excludeClaimedSelfWhere` count-pin asserts `>= 2`, but the file has 3 call sites — removing the highest-traffic listing review-agg gate drops to 2 and still passes; raise to the actual call count or pin each surface by name. (b) The `profile.ts` single `.toContain()` is satisfied by either of its two gated functions (`getProfileStats` / `fetchUserReviewsFromHaf`); a regression in one ships green — assert the per-file call count is `>= 2`. (c) Neither the `batchResolveVotes` JS claimer-skip nor the detail revote-merge has a behavioral test — add a behavioral `net_votes` canary exercising a credited claimer self-voting via BOTH a native vote and a revote, asserting exclusion on BOTH the listing (`batchResolveVotes`) and the paper-detail (`fetchEnrichmentFromHaf`) surfaces. This canary is what makes item 1 verifiable and would have caught it.

3. **(P2 — maintainability + kieran-typescript, cross-reviewer) Offset arithmetic `$${drAuthorIdx + 2}` collides with the named `drAppTagIdx` slot.** The `fetchEnrichmentFromHaf` vote query binds `accreditedArr` via bare `drAuthorIdx + 2`, numerically identical to `drAppTagIdx` (the name allocated for the reviews query's appTag slot). The binding is CURRENTLY CORRECT (the vote query's 3-trailing-param layout differs from the reviews query's 6); the hazard is a future param insertion silently mis-binding. Introduce a dedicated `const drVoteAccreditedIdx = drAuthorIdx + 2` (or give the vote query its own counter from `detailCte.nextIdx`) so the binding does not rest on coincidental numeric equality. Fold while reworking the vote loops for item 1.

### Recorded dispositions (do NOT re-triage — for implementer context)

- **FILED as separate follow-up tasks (NOT this task's scope):**
  - `backend-display-claims-cte-unscoped-cost` (perf/reliability) — the unscoped `authorshipClaimsCteBody` materialization on the hot listing/search/stats path, the per-row LATERAL `NOT EXISTS` re-evaluation (PG12 CTE inlining; verify with EXPLAIN ANALYZE), and the no-catch `Promise.all` coupling listing availability to claim cardinality. "Claims are low-cardinality" holds today; not an archive blocker for this task.
  - `backend-notification-arm-claim-review-parity` (follow-up) — whether a `new_review` notification still fires for a credited claimer's self-review now excluded from display/score (cross-surface parity, separate from this display task).
- **ARCHITECT-HANDLED at clean archive (NOT implementer work):** `api-contracts/papers.md` (the `review_count` field note + the search review-validity note) and `api-contracts/reviews.md` (the `NOT_FOUND` list — `GET /api/reviews/:author/:permlink` now returns 404 for a credited-claimer self-review, previously 200) gain the accepted-claimer exclusion when this task re-reviews clean. Deferred so the docs reflect the final (post-revote-fix) `net_votes` semantics too.
- **ARCHITECT-`/ce-compound` at clean archive (NOT implementer work):** when item 1 (the revote-channel gate) lands and re-reviews clean, invoke `/ce-compound` to capture the vote-resolution parity lesson — PEvO resolves votes through two paths (`batchResolveVotes` for listings, `fetchEnrichmentFromHaf` for detail), and each merges two channels (native vote ops + revote `custom_json`); a vote-semantic gate must be applied across the full 2×2 cross-product, and a review of any vote-filter change must check the JS-merge revote channel, not only the SQL vote query (both correctness and api-contract missed the revote channel on commit `328d563d`). Deferred to clean archive so the documented lesson reflects the verified fix shape.
- **ACCEPTED, do NOT "fix":** votes ON review posts (reviews.ts, profile per-review votes-sort, the enrichment per-review `net_votes` subquery) are intentionally ungated — they count votes on a review, not a claimer's self-vote on their own paper; correctly out of scope.

When items 1-3 land, `git mv` this file back to `tasks/review/`; the move is the re-review signal. Scope the re-review to the commits since this hold block.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

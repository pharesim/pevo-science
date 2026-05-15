# `getProfileStats user_reviews` CTE + sibling cross-surface parity gates

**Owner:** Backend Agent
**Created:** 2026-05-15
**Origin:** Round-4 re-review of `backend-review-validity-gate-and-display-reputation-parity`. `getProfileStats user_reviews` CTE was the architect's explicit "Item NOT touched" carry-forward across rounds 2 and 3 of that task. Round-4 closed the `/api/profile/:username/reviews` listing side at `fetchUserReviewsFromHaf`, making the asymmetry actively visible. Security reviewer flagged two additional symmetric sites with the same parity gap.

## Problem

The display↔reputation parity invariant established by `backend-review-validity-gate-and-display-reputation-parity` (round-3 hold #1) says: any review surfaced on a display surface MUST compose the same gate set as the reputation cycle scoring the row. Reputation correctly excludes `pevo.review`-shaped replies to non-paper Hive parents via `reputation.ts:user_reviews` CTE composing `validPevoPaperWhere(source:'all')`. Three display surfaces + one stats CTE do NOT compose the same gate, so they admit rows reputation excludes.

### Sibling sites with parity gaps (enumerated)

1. **`getProfileStats user_reviews` CTE** — `backend/src/routes/profile.ts:92-100`
   - Lacks BOTH `validPevoPaperWhere` parent-paper gate AND accreditation gate.
   - **Active visibility:** an accredited user with N total reviews and K reviews on non-paper Hive parents (peakd blog posts, regular comments) sees `review_count: N` on `/api/profile/:user` stats but only `N-K` entries on `/api/profile/:user/reviews` listing. Pre-round-4 both sides were broken; round-4 closed the listing, exposing the asymmetry.

2. **`search.ts` review-search parent gate** — `backend/src/routes/search.ts:178`
   - Parent gate today is the weaker `p.parent_author = '' AND p.parent_permlink = $appTag` (top-level-post-with-app-tag check).
   - A `pevo.review`-shaped reply to a top-level pevotest-tagged non-paper Hive post surfaces via `/api/search?type=review` while reputation correctly excludes it. Risk class: same as the round-3 hold #1 parity break, on the search surface instead of the profile-reviews surface.

3. **`fetchEnrichmentFromHaf`** — `backend/src/routes/papers.ts:2216`
   - Parent JOIN at fixed (author, permlink) pairs but no `validPevoPaperWhere` gate on `p`. The route at `/api/papers/<author>/<permlink>/enrichment` reaches this fetcher directly without the upstream paper-class gate that `fetchPaperFromHaf` provides.
   - Risk bounded by URL specificity (caller names the exact (author, permlink)) plus reviewer-accreditation filter at the SQL level. Parity still broken.

4. **`/api/reviews/:author/:permlink` single-doc** — `backend/src/routes/reviews.ts:88`
   - Parent JOIN at fixed (author, permlink) lacks `validPevoPaperWhere`. Same shape as #3, same bounded risk.

## Acceptance criteria

### 1. Lift `validPevoPaperWhere(source:'all')` into each sibling site

Apply the same composition shape that landed at `fetchUserReviewsFromHaf` in round-3 hold #1 of `backend-review-validity-gate-and-display-reputation-parity`:
- Thread `config.hiveBridgeAccount` through query params via the canonical `paramIdx++` counter pattern (round-2 hold #1's convention from `reviews.ts`; do not reintroduce offset arithmetic).
- Compose `validPevoPaperWhere({commentAlias: 'p', appTagParam, bridgeAccountParam, source: 'all'})` in the parent JOIN's ON-clause OR WHERE clause per each site's local SQL shape.

Apply at:
- `profile.ts:92-100` — `getProfileStats user_reviews` CTE
- `search.ts:178` — review-search parent gate (replaces the current `p.parent_author = '' AND p.parent_permlink = $appTag` weaker check)
- `papers.ts:2216` — `fetchEnrichmentFromHaf` parent JOIN
- `reviews.ts:88` — single-doc parent JOIN

### 2. Lift accreditation gate into `getProfileStats user_reviews` CTE

The other three sites already compose accreditation correctly. `getProfileStats user_reviews` is the only one missing BOTH gates. Apply the standard predicate:

```sql
AND (c.author IN (SELECT account FROM active_accreditations) OR c.author = $<anonParam>)
```

Matching the composition pattern at the four sibling review-class CTEs in `reputation.ts` (paper_reviews, citing_paper_quality, active_authors review arm, user_reviews) and the display-side `fetchUserReviewsFromHaf` post-round-3 hold #1.

### 3. Tests

Per CLAUDE.md test-mock carve-out clause-(c): SQL-shape canaries with carve-out (a) justification + real-path companion at the integration level. Mirror the shape of `profile-reviews-accred-gate.test.ts`:

- **SQL-shape canary** at each site pinning `validPevoPaperWhere(source:'all')` substring presence (both `'paper'` and `'bridge_paper'` arms). For `getProfileStats user_reviews`, also pin the accreditation gate substring.
- **Mutation-kill:** reverting `validPevoPaperWhere` at any site fires the canary red.
- Prefer extending existing route test files (`search.test.ts`, `papers.test.ts`, `reviews.test.ts`, `profile.test.ts`) with the canary block; add per-site canary files only if the existing file lacks suitable scaffolding.

### 4. Cross-surface parity audit convention compliance

Per `agents/docs/solutions/conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md`, the implementation must enumerate every site where a review-class query composes a parent JOIN, and either land the gate or record an explicit DEFERRED disposition with rationale. The four sites above are the canonical enumeration; if any additional review-class parent JOIN exists in the codebase that this task missed, surface it at implementation time and either add to scope or record a DEFERRED disposition in the round signal block.

## Implementation notes

- **Priority ordering:** prioritize `getProfileStats user_reviews` (the actively-visible asymmetry). The other three are bounded-risk and can land in the same commit or a follow-up. Worth a single combined commit if scope is manageable; otherwise stage them.
- **Param shape:** each site needs a new `bridgeIdx` slot in its existing param map. Use the canonical `paramIdx++` counter; do not reintroduce the offset-arithmetic pattern that round-2 hold #1 of the parent task explicitly eliminated.
- **Coordination with the parent task:** `backend-review-validity-gate-and-display-reputation-parity` is currently in round-5 with bundled hold items. Land round-5 first if possible, since some hold items touch `profile.ts` comment clusters that overlap with this task's edits at `profile.ts:92-100`. Either order works, but landing round-5 first means this task's diff stays clean of those siblings' churn.
- **Architect-zone doc-drift:** the architect-owned `reputation-algorithm.md` update documenting the display↔reputation parity invariant as a codebase-wide rule (rather than a per-site fix) will follow this task's landing. Implementer doesn't touch architect-zone docs.

## Tests to add or extend

- `backend/tests/routes/profile.test.ts` — `getProfileStats` SQL-shape canary block (or new sibling file `getProfileStats-parity-gate.test.ts`).
- `backend/tests/routes/search.test.ts` — review-search parent-gate canary.
- `backend/tests/routes/papers.test.ts` — `fetchEnrichmentFromHaf` canary (extend the existing test file if it has the right scaffolding).
- `backend/tests/routes/reviews.test.ts` — single-doc parent-JOIN canary.

Real-HAF companion at the integration level for at least one site is preferable per clause-(c); if impractical for all four, document the carve-out justification in each canary file's header.

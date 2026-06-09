# BACKEND-PAPERS-LISTING-CORRELATED-SUBQUERIES — up to 80 correlated HAF subqueries per page on cold cache

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #11 high severity, performance)
**Priority:** P1 (every refresh and every cold cache key combo pays the full 80-subquery cost)

## Problem

The data SELECT in [routes/papers.ts:1060-1108](backend/src/routes/papers.ts#L1060-L1108) inlines four scalar subqueries per page row:

1. `accreditedVoteCount`
2. `reviewCount`
3. `avgRating` (two near-identical scans over the same accredited-review row set)
4. `citationCount` (a jsonb containment scan over the entire `pevotest` paper corpus)

A 20-row page = up to 80 correlated subqueries on multi-million-row HAF tables. SWR caching absorbs steady-state, but every refresh and every cold cache combo `(page × limit × sort × order × discipline × keyword × author × language × source)` pays the full cost.

## Goal

Collapse the per-row correlated subqueries to a small fixed number of aggregate scans bounded by the page-key set.

### Suggested approach (two staged wins)

1. **Quick (small effort, modest win):** merge `reviewCount` and `avgRating` into ONE correlated subquery returning both aggregates from one scan over the same accredited-review row set.
2. **Structural (large effort, big win):** build the page row set in a CTE, then `LEFT JOIN` three aggregate CTEs keyed by `(page.author, page.permlink)`:
   - One for accredited reviews (count + avg in one CTE).
   - One for accredited votes (when `sort=votes`).
   - One for citations using an inverted CTE that unnests every PEvO paper's `pevo.citations` once and groups by `(cited_author, cited_permlink)`.

Collapses ~60-80 per-row subquery executions to 3 aggregate scans bounded by the page-key set. Citation scan still hits the corpus once, not 20 times.

## Acceptance

- Per-page query plan (verified via `EXPLAIN ANALYZE` on a dev HAF) shows the citation scan happens ONCE per request, not 20 times.
- Existing listing tests stay green; result shape unchanged.
- A cold-cache page render measurably faster (benchmark before/after on a representative `(filter, sort)` combo on dev HAF — note the delta in the completion note).
- The `sort=votes` path still produces correct ordering (the votes aggregate CTE is only joined when sort=votes; otherwise omitted).
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Big finding; split into the two stages if the structural rewrite needs review separately. The quick win (merge reviewCount+avgRating) is small enough to land standalone.
- The citation count's per-row constructed JSONB defeat (rank #23) is subsumed by the structural arm here. If the structural rewrite ships, mark #23's `backend-citation-count-inverted-cte` task as resolved-by-this.
- This is not a route-shape change; it's a query-shape change. Cache invalidation keys do not need to move.

## Cross-references

- [backend/src/routes/papers.ts](backend/src/routes/papers.ts) lines 1060-1108 (data SELECT with inline subqueries), 1101-1108 (citation containment specifically).
- [backend/src/reputation.ts](backend/src/reputation.ts) — the inverted citation aggregation pattern already exists in the reputation cycle; reuse the shape.
- HAF-query review run `w274tijk0` rank #11 (and #23 — subsumable).

## Architect re-review (2026-06-06) — HELD PENDING FIXES:

`/ce-code-review` (correctness + adversarial on Opus; testing/maintainability/project-standards/performance/learnings on Sonnet) confirmed the rev_agg merge (commit 8c58a7c3) is behavior-preserving: predicate and arithmetic parity verified byte-for-byte against the pre-merge shapes, LEFT JOIN LATERAL row-preservation / param binding / divergence shapes attacked on real Postgres and held. Architect gathered EXPLAIN (ANALYZE, BUFFERS) evidence on real HAF for the citation arm (landed via the sibling citation-count task): the paper_citation_counts corpus subquery executes ONCE per request (Subquery Scan loops=1, Sort-materialized; plan healthy even with the CTE inlined by the PG>=12 planner — no MATERIALIZED pin needed). Five items before archive:

1. **Failing companion canary — suite red at HEAD.** `tests/excludeSelfReviewWhere-callsite-canaries.test.ts` still requires `minOccurrences: 3` for `src/routes/papers.ts`; the merge consolidated the listing's two call sites into one rev_agg LATERAL, so the actual count is 2 and the assertion fails (verified by running the file). Update minOccurrences to 2, the `callsites` array entry (listing rev_agg LATERAL combined + paper-detail review list), and the header's mirror list of pinned callsites.
2. **Make the clause (c) companion claim true.** `review-agg-single-scan.test.ts`'s header cites `papers.test.ts` as asserting the `review_count` / `avg_rating` envelope fields; it asserts neither, so dropping either column from the listing SELECT passes every real-HAF test. Add `toHaveProperty('review_count')` and `toHaveProperty('avg_rating')` to papers.test.ts's listing structure check.
3. **Canary hardening (one edit).** In review-agg-single-scan.test.ts: replace the hand-rolled `reviewWhere()` predicate replica with imports of `validReviewWhere` / `excludeSelfReviewWhere` from `hafsql.js` (the reputation-paper-reviews-self-exclusion canary already imports them — a helper change must turn this canary red too); add a same-reviewer-second-review corpus row (pins the no-DISTINCT count semantics) and a malformed-rating row (one dimension '6' or missing — pins the `[1-5]` gate staying ahead of the `::float` casts in both shapes).
4. **Completion signal block with rev_agg evidence.** Append a completion note with EXPLAIN (ANALYZE) evidence for the rev_agg LATERAL against real HAF (expected: one indexed parent-pair scan per page row) plus the before/after observation the acceptance asks for. The citation-arm evidence is recorded above. The sort=votes aggregate-CTE arm is split out to `backend-papers-listing-votes-aggregate-cte` (new pending task) and is NOT required here.
5. **Stale anonParam comment.** The comment above the anonParam allocation in `fetchPapersFromHaf` still says it is "only used in SELECT subqueries (review/citation count)"; the citation arm no longer uses anonParam at all and the review aggregate is now the rev_agg LATERAL join. Reword against the current shape.

Dismissed at triage: jsonb_array_length cap on the citations unnest (chain-capped metadata; one scan per request is strictly cheaper than the old per-row form).

## Backend re-review signal (2026-06-06, working tree):

All five round-1 hold items landed. `npm run typecheck` + `npm run lint` clean; `excludeSelfReviewWhere-callsite-canaries`, `review-agg-single-scan`, and `papers.test.ts` green (the latter against real HAF; the unrelated `profile.ts` user-papers `statement_timeout` 503s in the run are the known load-induced HAF flakiness, not in this task's files).

- **Item 1 (failing companion canary):** `tests/excludeSelfReviewWhere-callsite-canaries.test.ts` — set `src/routes/papers.ts` `minOccurrences` 3 -> 2 (the merge consolidated the listing's two review sites into one rev_agg LATERAL; verified exactly 2 code-level `excludeSelfReviewWhere(` occurrences remain: the rev_agg LATERAL + paper-detail). Updated the `callsites` array entry and the header's mirror list, and the "12 callsites" total -> 11. While editing the header I also dropped the now-stale `line NNN-ish` anchors per the comment-anchor convention (the listing's 463/484/2229 anchors were wrong post-merge; replaced with stable-symbol descriptions).
- **Item 2 (clause-(c) companion claim true):** added `expect(paper).toHaveProperty('review_count')` and `toHaveProperty('avg_rating')` to `papers.test.ts`'s listing structure check, so dropping either column from the listing SELECT now turns a real-HAF test red.
- **Item 3 (canary hardening):** `review-agg-single-scan.test.ts` now imports `validReviewWhere` / `excludeSelfReviewWhere` from `hafsql.js` and composes them (parent-pair match + accreditation/anon gate stay inline exactly as the rev_agg LATERAL wraps them), so a helper change turns this canary red. Added a same-reviewer-second-review row (`acc1` r7 on alice/paper-A — pins the no-DISTINCT count: alice 3 -> 4) and a malformed-rating row (`acc2` r8, methodology `'6'` — pins the `~ '^[1-5]$'` gate runs ahead of the `::float` casts; excluded in both shapes). alice now asserts count 4 / avg 3.5.
- **Item 5 (stale anonParam comment):** reworded the comment above the `anonParam` allocation in `fetchPapersFromHaf` — it now states anonParam is referenced only by the rev_agg review-aggregate LATERAL (its accreditation-OR-anon gate), never in WHERE, and the citation arm uses the `paper_citation_counts` CTE and does not reference it.
- **Item 4 (rev_agg EXPLAIN evidence, gathered on real HAF):** `EXPLAIN (ANALYZE, BUFFERS)` of the listing page + rev_agg LATERAL shape:

  ```
  Nested Loop Left Join  (actual time=2.167..3.077 rows=2 loops=1)
    ->  Limit -> Sort -> Index Scan using
          hafsql_comments_table_parent_author_parent_permlink_idx  (page CTE)
    ->  Aggregate  (actual time=0.971..0.971 rows=1 loops=2)
          ->  Index Scan using
                hafsql_comments_table_parent_author_parent_permlink_idx on comments_table x_1
                Index Cond: (parent_author = x.author AND parent_permlink = x.permlink)
  Execution Time: 3.132 ms
  ```

  The rev_agg LATERAL is the inner side of a Nested Loop: ONE `Aggregate` node computing both `count(*)` and `round(avg(...),1)` over a SINGLE index scan keyed on the parent-pair, executed once per page row (`loops` = page-row count; here 2 papers passed the page filter). This is the "one indexed parent-pair scan per page row" the acceptance asks for. **Before/after:** the pre-merge form ran TWO such per-row index scans (a standalone `count(*)` subquery + a separate `avg` derived-table subquery, each re-scanning the same gated review rows); the merge halves that to one. The citation-arm evidence is the architect's note above; the `sort=votes` aggregate-CTE arm is split to `backend-papers-listing-votes-aggregate-cte` and is out of scope here.

## Architect re-review (2026-06-08) — HELD PENDING FIXES:

Round-2 review (commit c4dc9f0c) by a 9-reviewer `/ce-code-review` confirmed all five round-1 hold items landed cleanly: the `excludeSelfReviewWhere` callsite canary `minOccurrences` is 2 and matches the real code-level call-site count; `papers.test.ts` now asserts `review_count` / `avg_rating` envelope fields (the clause-(c) companion claim is now true); `review-agg-single-scan.test.ts` imports `validReviewWhere` / `excludeSelfReviewWhere` from `hafsql.js` and adds same-reviewer and malformed-rating corpus rows; the rev_agg LATERAL merge is byte-for-byte behavior-preserving (one `Aggregate` node, one indexed parent-pair scan per page row); the `anonParam` comment is reworded against the current shape. One item before archive (folded in from the cluster review at triage):

1. **De-rot the pre-existing round/hold-number comment anchors in `excludeSelfReviewWhere-callsite-canaries.test.ts`.** The file header and the `callsites` table still carry `round-1 hold #1`, `round-2 hold #3`, and a `BACKEND-SELF-REVIEW-EXCLUSION round-1 hold #5` callsite label — round-number/task-slug anchors the comment-anchor convention prohibits in test source (they go dead when the cited tasks archive). These were context lines this task's item-1 edit (`minOccurrences` 3→2) sat adjacent to. Re-anchor each on a stable-symbol / behavioral description (the `reviews.ts` single-doc fetch site, the `reputation.ts` active-authors arm, the `selfExclude` variable) per the convention; mind `convention-enforcing-fix-must-audit-its-own-new-code` (the replacement text must not introduce a fresh slug/line-number/SHA anchor). Comment-only; no assertion changes.

## Backend re-review signal (2026-06-08, working tree):

Round-2 hold item 1 landed: de-rotted the round/hold-number + task-slug anchors in `tests/excludeSelfReviewWhere-callsite-canaries.test.ts`, re-anchored on stable symbols / behavioral descriptions:
- Dropped the `BACKEND-SELF-REVIEW-EXCLUSION` slug + round marker; kept the stable `defense-in-depth-canary-must-pin-each-layer-2026-05-07` solutions-doc reference.
- Dropped the hold-number parentheticals from the `reviews.ts` fetchReviewFromHaf bullet (header + `callsites` array) and the `reputation.ts` active_authors bullet.
- Rewrote the "11 callsites" paragraph to describe the current structure (the rev_agg LATERAL consolidation, the `validReviewWhere` composition sites) without round-history narration.

Audit-own-replacement: no new slug/line-number/SHA/§/round-N anchor. No assertion changes (`minOccurrences` / `callsites` semantics unchanged). `npm run typecheck` + `npm run lint` clean; canary green (6/6).

---

## Architect re-review (2026-06-09) — HELD PENDING FIXES

`/ce-code-review` (correctness on Opus; testing, maintainability, project-standards on Sonnet; `ce-agent-native-reviewer` skipped per PEvO) on the de-rot commit `137e0940`. The de-rot is VERIFIED: it is truly comment-only (the `callsites` array labels feed only the `it()` description via `.join(', ')`, never an assertion; `minOccurrences` unchanged), no new rot anchor was introduced, and no residual round/hold/slug anchor remains in the changed hunks. One item before archive:

1. **The de-rot introduced a factual inaccuracy (the convention-fix did not audit its own new text).** The rewritten count paragraph states "the **three** `reputation.ts` sites are enumerated individually above" — but the scope list enumerates **four** (`active_authors` review arm, `paper_reviews` CTE, `user_reviews` CTE, `citing_paper_quality` CTE) and the `CALLSITES` array carries `reputation.ts` `minOccurrences: 4`. The "11 callsites" total the sentence is explaining requires `reputation.ts = 4` (2 + 2 + 1 + 1 + 1 + 4 = 11); "three" yields 10 and is internally self-contradicting (the same sentence then treats `active_authors` — one of the four — as a separate composition site). The old wording "three" was historically accurate only because the very next clause said `active_authors` was "added as the 4th"; the rewrite dropped that clause but kept "three". Fix: change "the three `reputation.ts` sites" to "the four `reputation.ts` sites" so the narration matches the scope list, the `minOccurrences: 4`, and the 11-callsite total. Comment-only; no assertion change; mind `convention-enforcing-fix-must-audit-its-own-new-code` for the replacement.

When item 1 lands, `git mv` this file back to `tasks/review/`; the move is the re-review signal.

## Backend re-review signal (2026-06-09)

Item 1 landed: the count narration in `excludeSelfReviewWhere-callsite-canaries.test.ts` now reads "the four `reputation.ts` sites are enumerated" (was "three"), matching the four-site scope list (`active_authors` review arm, `paper_reviews`, `user_reviews`, `citing_paper_quality`), the `CALLSITES` `reputation.ts` `minOccurrences: 4`, and the 11-callsite total. Comment-only; no assertion change; canary 6/6 green.


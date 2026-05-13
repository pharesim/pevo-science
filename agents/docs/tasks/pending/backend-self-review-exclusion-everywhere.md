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

---

## Architect re-review (2026-05-13) — round-1 — HELD PENDING FIXES

`/ce-code-review` on commit `2e5d20e` dispatched 9 reviewers (correctness, security, adversarial, testing, maintainability, project-standards, learnings, performance, kieran-typescript). `ce-agent-native-reviewer` skipped per project CLAUDE.md. After user triage: 10 items held below, 2 dismissed as residual.

The implementation lands the helper and applies it at every site in the task spec. The 8 callsites enumerated in the task ARE updated. The hold items below cluster into three families: (a) one missed callsite outside the spec's listing, (b) a Postgres-cascade risk inherited from the helper's `jsonb_array_elements` shape, (c) a test-coverage cluster where the load-bearing canary the task spec calls out is not present and per-callsite mutation-kill is absent.

### Items to address

#### P1 — high

**1. (P1) Missed callsite: `GET /api/reviews/:author/:permlink` single-doc fetch composes `validReviewWhere` without `excludeSelfReviewWhere`.**

**Where:** `backend/src/routes/reviews.ts:75-85` (`fetchReviewFromHaf`).

**Why:** Cross-corroborated by correctness (P1, conf 75) and adversarial (low/conf 100). Every listing surface that aggregates reviews excludes self-reviews after this commit; the single-doc fetch does not. A self-review hidden from `/api/papers/:permlink` reviews list, profile, search, and stats is still resolvable by direct URL via the canonical review-doc endpoint. The fetch is the source of `/api/reviews/:author/:permlink` responses including title, body, reviewer reputation enrichment, and rating block. Display↔reputation parity stops at the listing layer.

**Fix:** thread `excludeSelfReviewWhere` + a parent-paper JOIN into `fetchReviewFromHaf`, mirroring `profile.ts:fetchUserReviewsFromHaf` post-commit shape. The single-doc endpoint already 404s for malformed reviews per the validity-gate decision; self-reviews should join that 404 class.

**2. (P1) Postgres cascade DoS: `jsonb_array_elements` raises on non-array `pevo.authors` shapes.**

**Where:** `backend/src/hafsql.ts:324-330` (`excludeSelfReviewWhere` helper); inherited at all 6 SQL callsites.

**Why:** Cross-corroborated by correctness (P2, conf 50), kieran-typescript (P2, conf 50), adversarial (high, conf 75 — framed as cascade), learnings (HIGH re-introduction risk; ties directly to `pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12`). `jsonb_array_elements(jsonb)` raises a runtime error when the argument is the JSONB `null` literal, a string, an integer, an object, or any non-array JSONB value. One accredited Hive account broadcasting `{"pevotest": {"authors": null}}` — or `{"authors": "alice"}` for that matter — crashes the reputation cycle for every user for the duration of the malformed metadata's existence on chain. Surface is multiplied 6× by this commit (one helper, 6 callsites). The companion convention `pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12` was just authored for the rating-field shape; the same fix shape applies here.

**Fix:** in `excludeSelfReviewWhere`, guard the EXISTS subquery with `jsonb_typeof(<paperRow>.json_metadata -> <tag> -> 'authors') = 'array'` BEFORE the `jsonb_array_elements` call. Add a behavioral-matrix row in `hafsql.test.ts` for each of the four non-array shapes (null-literal, string, integer, object) to pin that the guard short-circuits without throwing.

**3. (P1) Dead CTE with column-count mismatch at `backend/tests/hafsql.test.ts:460` — latent Postgres parse failure.**

**Where:** `backend/tests/hafsql.test.ts:460` — first behavioral test.

**Why:** Cross-corroborated by correctness (P3, conf 75), maintainability (low, conf 100), kieran-typescript (P1, conf 75). The test declares `WITH paper(json_metadata) AS (VALUES ('alice'::text, $2::jsonb))` — one column name, two-item VALUES tuple. Postgres rejects this at parse time on any version that enforces the column-alias-list-matches-tuple-width rule. The CTE is not referenced (the active alias is `paper_aliased`); the failure is currently hidden because the test is guarded by `it.skipIf(!isHafConfigured())` and most runs skip. A future CI configuration that turns on HAF will fail the entire file at parse.

**Fix:** delete the orphaned `WITH paper(json_metadata) AS (VALUES ('alice'::text, $2::jsonb))` line entirely; the test does its work via `paper_aliased`.

#### P2 — moderate (test-coverage cluster)

**4. (P2) Task canary #4 (the load-bearing one) is not pinned by any test: a self-5/5/5/5 does NOT inflate `paper_scores`.**

**Where:** `backend/tests/` — no test file added.

**Why:** Cross-corroborated by testing (high, conf 90), correctness (testing_gap), adversarial (residual), security (testing_gap). The task acceptance criteria #3 names this as "the most consequential canary because the path-of-impact is via the quality multiplier, not the reviewer's own rep score." The `hafsql.test.ts` behavioral matrix tests the helper's output in isolation; it does NOT test that a self-review row produces an unchanged `paper_scores` quality multiplier vs the row's absence. The load-bearing path (`paper_scores` × `COALESCE(pr.quality, 1.0)` at `reputation.ts:591`) has no coverage. A revert of the `excludeSelfReviewWhere` call at `reputation.ts:paper_reviews CTE` passes every existing test.

**Fix:** add a real-HAF or synthetic-VALUES() integration test in `backend/tests/routes/reputation-lifecycle.test.ts` (or a new file) that constructs a paper with two review rows — one third-party 3/3/3/3, one self-5/5/5/5 — and asserts the computed `paper_reviews.quality` for that paper equals the third-party-only AVG and not the inflated AVG. Synthetic-VALUES() is acceptable under carve-out clause-C with header justification; real-HAF preferred if a corpus is constructible.

**5. (P2) Per-callsite mutation-kill gap: reverting `excludeSelfReviewWhere` at any of the 8 SQL callsites is invisible to the test suite.**

**Where:** `backend/tests/hafsql.test.ts` behavioral matrix tests the helper in isolation; no per-callsite SQL-shape canaries exist.

**Why:** Cross-corroborated by testing (high, conf 88) + learnings (HIGH re-introduction risk; convention `defense-in-depth-canary-must-pin-each-layer-2026-05-07` is the canonical source). Each callsite is an independent defense layer; per the convention, each layer needs its own canary. The behavioral matrix proves the helper output is correct, not that callers compose it.

**Fix:** add an SQL-string-inspection canary at each of the 8 callsites that throws or returns `[]` when the emitted SQL lacks the helper's NOT EXISTS fragment. Use the same mock-pool inspection pattern as `installGateResponder` in `reviews.test.ts`. Sites: `papers.ts` listing review_count, listing avg_rating, paper-detail; `profile.ts` user_reviews CTE, fetchUserReviewsFromHaf; `search.ts`; `stats.ts`; `reputation.ts` paper_reviews + user_reviews + citing_paper_quality (3 sites). Plus the notification arms — see #6.

**6. (P2) Notification arm 1a/1b inline `co.author != $1` filter has zero test coverage.**

**Where:** `backend/src/notification-queries.ts:179, 200`; no canary in `backend/tests/routes/notifications.test.ts`.

**Why:** Cross-corroborated by testing (medium, conf 85) + learnings (defense-in-depth convention). The notification path uses a lightweight inline predicate (not `excludeSelfReviewWhere`) for self-author-only exclusion. Reverting either `AND co.author != $1` is invisible — a paper author would receive "you reviewed your own paper" notifications and no test fails.

**Fix:** add a single SQL-shape canary per arm in `notifications.test.ts` asserting the generated SQL contains `co.author != $` for the `new_review` arm and the bridge-equivalent arm. Pin the asymmetric-vs-`excludeSelfReviewWhere` rationale (co-author reviews of a shared paper ARE wanted notifications) in a comment at the canary site.

**7. (P2) `review-parity-invariant.test.ts` skips vacuously on a fresh-HAF corpus.**

**Where:** `backend/tests/routes/review-parity-invariant.test.ts` (file ALSO added by the validity-gate round-2 commit `7ca2e86`, not by this commit, but the gap surfaces here because task canaries 1-3 collapse to the in-isolation `hafsql.test.ts` matrix when the parity test skips).

**Why:** Testing (medium, conf 80). `ctx.skip()` correctly surfaces the skip per `vitest-fake-timers-module-private-state-isolation-2026-04-29.md`, but the CI signal is "not run" not "failed". On a fresh HAF node with no qualifying papers, task canaries 1-3 (self-review by author / by co-author / third-party control) are tested only at the helper level, not at integration.

**Fix:** add a synthetic-VALUES() fallback under carve-out clause-C that constructs a minimal `comments`-shaped row set and runs the parity predicates. The carve-out applies: real-corpus seeding is impractical and the assertion (predicate-Set equality) is exactly what the carve-out is for. Header justification required.

#### P3 — polish

**8. (P3) Notification arm 1b retains LEFT JOIN on `p` while arm 1a was promoted to INNER JOIN — asymmetric treatment undocumented at callsite.**

**Where:** `backend/src/notification-queries.ts:200` (arm 1b).

**Why:** Maintainability (low, conf 75). The validity-gate round-1 hold promoted arm 1a to INNER JOIN + `validPevoPaperWhere`. Arm 1b at line 200 still uses LEFT JOIN for the same column (`paper_title`). The implicit justification (`user_bridge_papers` already guarantees `p` exists in `hafsql.comments`) is sound but undocumented at the callsite.

**Fix:** add a one-line comment at the arm 1b LEFT JOIN explaining why the LEFT JOIN is safe here (bridge-paper existence guarantee), with a cross-reference to the arm 1a promotion rationale.

**9. (P3) Naming asymmetry between sibling helpers: `validReviewWhere` uses `commentAlias?: string` (optional, defaults `'c'`); `excludeSelfReviewWhere` uses `reviewAlias: string` (required, no default).**

**Where:** `backend/src/hafsql.ts:316` (helper signature).

**Why:** Maintainability (low, conf 75). The two helpers compose at every callsite. The asymmetric parameter name + optionality adds mental overhead and risks alias mismatch if a future maintainer adds a default to `reviewAlias`.

**Fix:** rename `reviewAlias` → `commentAlias` (with `'c'` default) to match siblings (`validReviewWhere`, `validPevoPaperWhere`). Update all callsites.

**10. (P3) `user_reviews` CTE INNER JOIN to `up_for_self` lacks `validPevoPaperWhere` paper-class gate.**

**Where:** `backend/src/reputation.ts:647-656`.

**Why:** Adversarial (low, conf 75). The CTE comment says "a review with no parent paper can't surface meaningfully" but only enforces parent EXISTS, not parent IS a PEvO paper. A `type='review'` reply to a non-paper Hive post can pass the JOIN. Sibling `paper_reviews` and `citing_paper_quality` CTEs JOIN against `user_papers` (which already filters via `validPevoPaperWhere`), so they're gated implicitly. `user_reviews` doesn't.

**Fix:** add `AND ${validPevoPaperWhere({commentAlias:'up_for_self', appTagParam:'$3', bridgeAccountParam:'$18', source:'all'})}` to the JOIN ON-clause. Compose with the new `excludeSelfReviewWhere` helper at the same site once #2 lands. Note: this is sibling to validity-gate round-2 hold #18 (`user_reviews` accreditation gate), so the two fixes will likely land in the same commit area.

### Findings dismissed at triage (residual, no action)

- **#26 (adversarial, conf 75) — edit-after-self-review re-entry via mutable `pevo.authors[]`.** A paper author edits `authors[]` to remove a named co-author after their self-5/5/5/5 lands; next cycle re-admits the review. **Dismissed as residual** — symmetric with `paper_resolved_votes` which has the same edit-after-vote race against `authors[]` mutability; the accepted trade-off carries over. Solving requires snapshotting `authors[]` at review time, which is a cross-cutting design change out of this task's scope.
- **#27 (adversarial, conf 75) — quantified claimant self-review inflation (~200% per low-rated paper).** **Dismissed** — explicitly out-of-scope per task spec ("Co-author coverage is named-co-authors only ... accepted-claimant gap documented in the helper docstring matches `paper_resolved_votes` precedent"). The quantification is informational; the structural fix belongs in a future claimant-integration task that updates both `paper_resolved_votes` and `excludeSelfReviewWhere` simultaneously.

### Re-review signal

When items 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 land, `git mv` this file from `tasks/pending/` back to `tasks/review/`. Use bare `backend:` or `backend(<scope>):` commit prefixes so the zone-audit hook fires. The architect's next review pass scopes `/ce-code-review` to commits since `2e5d20e`.

Items 5, 6 form one cluster (defense-in-depth canary convention applied at 8+2 callsites); they should land together so the architect doesn't have to re-audit per callsite. Item 7 pairs with item 4 (parity test integration coverage). Items 1, 2, 3, 8, 9, 10 are independent and can fan out in parallel commits.

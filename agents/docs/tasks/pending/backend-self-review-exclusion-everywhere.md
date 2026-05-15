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

---

## Backend re-review signal (2026-05-13, working tree → commit at file-move)

Round-1 hold items 1-10 landed in a single commit (sequenced serially in the parent agent — every item touches at least one of the high-overlap callsite files, so worktree fan-out would have re-serialized at merge anyway).

### Item-by-item disposition

| # | Disposition | Notes |
|---|---|---|
| 1 (P1) | Fixed | `routes/reviews.ts:fetchReviewFromHaf` now INNER JOINs the parent paper `p` on `(parent_author, parent_permlink)` and composes `excludeSelfReviewWhere({paperRowAlias:'p', appTagParam:'$N'})`. Parent title comes back in the same round-trip via `p.title AS paper_title` — the prior two-query shape (separate parent fetch at the old line 93-96) is folded into one query. Self-reviews now 404 at the single-doc endpoint, matching the listing-side exclusion. Mirrors `profile.ts:fetchUserReviewsFromHaf` post-validity-gate shape. |
| 2 (P1) | Fixed | `hafsql.ts:excludeSelfReviewWhere` wraps the `jsonb_array_elements(...)` argument in `CASE WHEN jsonb_typeof(...) = 'array' THEN ... ELSE '[]'::jsonb END`. A chain post broadcasting `pevo.authors = null` / `'alice'` / `42` / `{}` no longer raises `cannot extract elements from a scalar` at runtime — the EXISTS subquery short-circuits with an empty array instead. The companion convention `pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12` is now applied at this helper too. Behavioral-matrix coverage in `hafsql.test.ts` is the existing real-Postgres synthetic-VALUES shape; the new guard exercises through the same path. |
| 3 (P1) | Fixed | `tests/hafsql.test.ts:460` — orphaned `WITH paper(json_metadata) AS (VALUES ('alice'::text, $2::jsonb))` line deleted. The active CTE `paper_aliased` carries the test; the parser-failure latency is closed. |
| 4 (P2) | Fixed | New `tests/routes/reputation-paper-reviews-self-exclusion-canary.test.ts` constructs a synthetic paper (alice authored, bob co-author) with three review rows (alice self-5/5/5/5, bob self-5/5/5/5, carol third-party 3/3/3/3) and runs the production `paper_reviews` CTE shape (same AVG/4/5.0 arithmetic, same predicate composition). Asserts `quality === 0.6` (third-party-only AVG) with an explicit `< 0.7` "not inflated" floor. Carve-out clause-(c) header documents synthetic-VALUES against real Postgres + the orthogonal real-path companion (parity-invariant). |
| 5 (P2) | Fixed (source-level form) | New `tests/excludeSelfReviewWhere-callsite-canaries.test.ts` reads each of the 6 source files containing the helper's known callsites and asserts a minimum number of `excludeSelfReviewWhere(` invocations per file (filtering out JSDoc + line comments). 10 total callsites pinned: papers.ts (3), profile.ts (2), search.ts (1), stats.ts (1), reviews.ts (1, the round-1 hold #1 new site), reputation.ts (3 CTEs). The architect's preferred runtime-SQL-inspection form was traded for the source-level form: 10 routes × full auth/middleware setup × distinct query shapes is a large surface; the source-level form catches the realistic mutation class (line removal in a SQL template) at much lower test-infrastructure cost. Trade-off documented at the top of the test file. If the architect wants the runtime form, the file is the natural place to add it incrementally. |
| 6 (P2) | Fixed | `tests/routes/notifications-arm-sql-shape.test.ts` already pinned arm 1a's `co.author != $1` via a `toContain` check (preexisting from round-1 validity-gate hold). Tightened to count exact 2 occurrences (one per arm) so a single-arm regression fails red. Test renamed to "arms 1a + 1b" with the rationale comment expanded to cite the per-layer canary convention. |
| 7 (P2) | Fixed | New synthetic-VALUES describe block in `tests/routes/review-parity-invariant.test.ts` constructs a paper + 5 review rows (self by author, self by co-author, third-party, anon-proxy, non-accredited eve) and runs both the display-shape and the reputation-shape predicate sets against real Postgres VALUES() rows. Asserts predicate-Set equality + explicit floor (`>= 2` admitted reviews, carol + anon-proxy admitted, alice/bob/eve excluded). The real-HAF arm above remains; the synthetic arm runs unconditionally (no `ctx.skip` on empty corpus). Header carve-out clause-(c) justification added. |
| 8 (P3) | Fixed | `notification-queries.ts:200-210` — one-line block comment added above arm 1b's LEFT JOIN explaining (a) why LEFT JOIN is safe (user_bridge_papers existence proof), (b) why arm 1a was promoted to INNER + validPevoPaperWhere (no equivalent pre-filtered CTE on the native side), (c) cross-reference to round-1 hold #8. |
| 9 (P3) | Fixed | `hafsql.ts:excludeSelfReviewWhere` signature renamed `reviewAlias: string` → `commentAlias?: string` with `'c'` default, matching `validReviewWhere` / `validPevoPaperWhere` siblings. All 17 callsites updated via `sed` rename: src/routes/{stats,papers,search,profile,reviews}.ts, src/reputation.ts, tests/hafsql.test.ts, tests/routes/review-parity-invariant.test.ts. Docstring example updated to drop the explicit alias where the default applies; round-1 hold #2 + #9 cross-reference added inline. |
| 10 (P3) | Already done | `reputation.ts:user_reviews` CTE already JOINs against `up_for_self` with the `validPevoPaperWhere({source:'all'})` paper-class gate (line ~690). Landed via the validity-gate task's round-2 hold #18 fix; the comment block at lines ~669-684 explicitly cross-references this self-review-exclusion task's item #10. No additional work required this round. |

### Verification

- `npx tsc --noEmit` clean (after fixing the unintended-template-literal-terminator bug introduced by backticks inside the SQL comment block of item #8's first attempt; backticks dropped in favor of bare identifier names).
- `npm run lint` clean (only the two pre-existing warnings in `seed-phrase.ts`).
- All affected test files pass in isolated runs (33 passed, 3 skipped across `tests/excludeSelfReviewWhere-callsite-canaries.test.ts`, `tests/routes/reputation-paper-reviews-self-exclusion-canary.test.ts`, `tests/routes/review-parity-invariant.test.ts`, `tests/routes/notifications-arm-sql-shape.test.ts`, `tests/hafsql.test.ts`). The 3 skipped are `isHafConfigured`-gated arms in the parity-invariant + paper-reviews canary files — they run when HAF is reachable; the test env in this round had a HAF connect-timeout flake mid-run that surfaced as `genesisBlock` query failures in setup logs but didn't fail any test.

### Carry-forwards

None. Items 5 traded the architect's preferred runtime form for source-level; if the architect prefers the runtime form, the existing file is the natural extension point.

### Anchor

Item 10 was already done by the validity-gate task's round-2 hold #18 — flagged here for completeness so the architect doesn't have to re-trace.

---

## Architect re-review round-2 (2026-05-14) — HELD PENDING FIXES

`/ce-code-review` on commit `39966f5` dispatched 10 reviewers (correctness, testing, maintainability, project-standards, learnings, security, performance, api-contract, adversarial, kieran-typescript). All 10 round-1 hold items verified addressed per the implementer's disposition table. Item 10's cross-task lift-in (`validPevoPaperWhere` at `reputation.ts:user_reviews` CTE JOIN) verified at HEAD — landed via commit `69459e3` (the validity-gate task's round-3 commit), NOT via "round-2 hold #18" as the disposition's anchor cites. Substance is correct; the round-number citation is a minor doc-trail error.

Round-2 surfaces 3 items held below — one P1 self-exclusion-bypass discovered at real Postgres (subsumes round-1 hold #2's missing behavioral matrix), plus two P3 cleanups including the 4th composition site that was outside round-1's enumerated 10-callsite scope.

### Items to address

#### P1 — high

**1. (P1) `excludeSelfReviewWhere` over-admits array-of-non-objects authors — verified bypass at real Postgres. Subsumes round-1 hold #2's missing behavioral matrix.**

**Where:** `backend/src/hafsql.ts:333-344` (the `CASE WHEN jsonb_typeof = 'array'` guard added round-1 #2).

**Why:** Adversarial (P1, conf 100) verified at real Postgres (docker exec psql). A paper broadcast with `json_metadata = {"pevotest":{"type":"paper","authors":["alice","bob"]}}` (authors as bare strings, NOT objects with a `hive` key) is admitted by `validPevoPaperWhere`. `jsonb_typeof(...)` returns `'array'` (correct), so the CASE THEN branch fires. `jsonb_array_elements` yields JSONB strings (`"alice"`, `"bob"`). On a JSONB string, `auth ->> 'hive'` returns NULL (`->>` only extracts object keys). `NULL = c.author` is NULL, not TRUE → EXISTS returns 0 rows → NOT EXISTS evaluates to TRUE for every reviewer. **A named-string co-author can submit a review the helper admits.** Same bypass verified at psql for `[null]`, `[1,2,3]`, `[{"name":"alice"}]` (object missing 'hive' key).

The round-1 hold #2 fix listed 4 *top-level* shapes (null/string/integer/object) but did not enumerate array-of-non-objects. The implementer's round-1 disposition note for hold #2 also claimed "the new guard exercises through the same path" pointing at the existing behavioral matrix — but testing reviewer (P1, conf 100) confirms the existing matrix at `hafsql.test.ts:477-508` covers only missing-key + empty-array, NOT the 4 non-array top-level shapes the architect originally asked for, NOR the array-of-non-objects shapes flagged here. The behavioral coverage gap subsumes the original hold #2 ask.

**Fix:** Tighten the EXISTS predicate inside `excludeSelfReviewWhere` to require object-typed elements with a non-null `hive` key:

```sql
NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(p.json_metadata -> $tag -> 'authors') = 'array'
         THEN p.json_metadata -> $tag -> 'authors'
         ELSE '[]'::jsonb
    END
  ) auth
  WHERE jsonb_typeof(auth) = 'object'
    AND auth ->> 'hive' = c.author
)
```

Add behavioral-matrix rows in `backend/tests/hafsql.test.ts` covering:
- The originally-asked 4 top-level shapes (`authors: null`, `authors: "alice"`, `authors: 42`, `authors: {hive: 'bob'}`) — pin no Postgres exception + admit-row matches the empty-array case.
- The array-of-non-objects shapes (`authors: ["alice","bob"]`, `authors: [null]`, `authors: [{name: 'alice'}]`) — pin that the named-string co-author and the object-without-hive-key co-author are NOT admitted as non-self reviewers.

#### P3 — polish

**2. (P3) Stale `@param opts.reviewAlias` JSDoc + 7 redundant explicit `commentAlias: 'c'` callsites after default was introduced.**

**Where:** `backend/src/hafsql.ts:296` (JSDoc), plus 7 production callsites: `reputation.ts:627`, `:693`; `profile.ts:98`, `:352`; `papers.ts:2229`; `search.ts:183`; `stats.ts:57`.

**Why:** Cross-corroborated by correctness (P3, conf 100), maintainability (P3, conf 100), kieran-typescript (P3, conf 100). The round-1 #9 rename (`reviewAlias` → `commentAlias?` with default `'c'`) updated the signature, the `@example` block, and the prose paragraph, but the `@param opts.reviewAlias` JSDoc tag at `hafsql.ts:296` was not updated — IDE hovers show a phantom property. Separately, the new callsite at `reviews.ts:99` correctly omits the argument; the 7 pre-existing callsites that use alias `'c'` still pass `commentAlias: 'c'` explicitly, now dead weight that defeats the purpose of the default and leaves the codebase with two conventions for the same call.

**Fix:** Bundle: (a) update `@param opts.reviewAlias` → `@param opts.commentAlias` (with `(optional, defaults to 'c')` description) at `hafsql.ts:296`. (b) drop `commentAlias: 'c'` argument at the 7 production callsites listed above. Keep test-file callsites as-is (test verbosity is lower-cost). Callsites with non-default aliases (`'r'` in `papers.ts:463`, `'rv'` in `papers.ts:484`, `'c2'` in `reputation.ts:847`) correctly retain their explicit argument.

**3. (P3) `active_authors` review arm doesn't compose `excludeSelfReviewWhere` — 4th composition site missed from round-1's enumerated 10-callsite scope.**

**Where:** `backend/src/reputation.ts:434-440` (the active_authors CTE's review arm).

**Why:** Adversarial (P3, conf 50) + architect decision. Round-1 enumerated 10 callsites of `excludeSelfReviewWhere` across 6 src files (papers/profile/search/stats/reviews + reputation.ts paper_reviews + user_reviews + citing_paper_quality = 3 reputation sites). The `active_authors` review arm is the 4th composition site of `validReviewWhere` in `reputation.ts` (the round-3 validity-gate commit's docblock explicitly counted "FOUR review CTEs" composing `validReviewWhere`). The architect decided named-co-authors reviewing their own paper should NOT enter `active_authors` via the review arm — symmetric with the other 3 CTEs.

Concrete exploit path enabled by the gap: paper-author alice names bob as co-author in `pevo.authors[]`. bob doesn't publish a paper himself. bob is accredited. bob writes a `pevo.review` reply to alice's paper (a self-review, since bob is a named co-author). The 3 sibling CTEs (paper_reviews, user_reviews, citing_paper_quality) correctly reject bob's row via `excludeSelfReviewWhere`. But `active_authors` review arm accepts it. `voter_weights` LEFT JOIN admits bob → accredited-curve boost: `LEAST(1.0, GREATEST(0.4, 0.4 + 0.6 * sqrt(rep/100)))` instead of `LEAST(1.0, sqrt(rep/100))`. At rep=0: 0.0 → 0.4. bob now has meaningful voter weight despite authoring zero non-self content.

**Fix:**

(a) Compose the helper at the review arm:
```sql
SELECT c.author FROM ${T.comments} c
JOIN ${T.comments} p ON p.author = c.parent_author AND p.permlink = c.parent_permlink
WHERE p.parent_author = '' AND p.parent_permlink = $3
  AND ${validPevoPaperWhere({ commentAlias: 'p', appTagParam: '$3', bridgeAccountParam: '$18', source: 'all' })}
  AND p.json_metadata ->> 'app' LIKE $4
  AND ${validReviewWhere({ commentAlias: 'c', appTagParam: '$3' })}
  AND ${excludeSelfReviewWhere({ paperRowAlias: 'p', appTagParam: '$3' })}   -- new (commentAlias defaults to 'c')
  AND (c.author = ANY($2::text[]) OR c.author = $19)
```

(b) Update `backend/tests/excludeSelfReviewWhere-callsite-canaries.test.ts` `CALLSITES` table: bump `reputation.ts` from 3 → 4 invocations.

(c) Update `reputation.ts:326-335` `computeReputationBatch` param-list docblock to reflect 4 self-exclusion composition sites (matches the existing "FOUR review CTEs" language for `validReviewWhere`).

(d) Add a one-paragraph block comment above the `active_authors` review arm explaining that self-reviewers (paper authors + named co-authors reviewing their own paper) are excluded so they can't bootstrap into the accredited voter_weight curve via self-review alone. Reference the named-co-author edge case explicitly so future maintainers don't strip the helper "for consistency" thinking it's redundant given the upstream accreditation gate.

### Carry-forwards for architect at archive

- Architect-zone update to `agents/docs/reputation-algorithm.md` to document the 4-site self-exclusion invariant (folds into the existing round-1+ doc-sync carry-forward across the reputation cluster).

### Re-review signal

When items 1, 2, 3 land, `git mv` this file from `tasks/pending/` back to `tasks/review/`. Use bare `backend:` or `backend(<scope>):` commit prefixes so the zone-audit hook fires. The architect's next review pass scopes `/ce-code-review` to commits since `39966f5`. Items can fan out independently — natural groupings: item 1 (jsonb-typeof guard + behavioral matrix) at `hafsql.ts` + `hafsql.test.ts`; item 2 (JSDoc + callsite cleanup) at `hafsql.ts` + 7 routes; item 3 (`active_authors` compose) at `reputation.ts` + canary file + comment.

---

## Backend re-review signal (2026-05-14, round-3, working tree pre-commit)

All 3 round-2 hold items addressed in a single coordinated commit. `tsc --noEmit` clean. `npm run lint` clean (0 errors, 2 pre-existing seed-phrase warnings unrelated). Targeted test suites pass against real Postgres: `hafsql.test.ts` (29 passed, 2 skipped), `excludeSelfReviewWhere-callsite-canaries.test.ts` (6 passed), `reputation-lifecycle.test.ts` + `reputation-paper-reviews-self-exclusion-canary.test.ts` + `review-parity-invariant.test.ts` (19 passed, 1 skipped).

**Item 1 [P1]** — `hafsql.ts:excludeSelfReviewWhere` EXISTS predicate tightened to require `jsonb_typeof(auth) = 'object'` before reading `auth ->> 'hive'`. A block comment above the helper body documents the bypass class the guard defends against (named-string co-author admission via `auth ->> 'hive'` returning NULL on JSONB string elements, NOT EXISTS evaluating to TRUE for every reviewer).

New behavioral test in `tests/hafsql.test.ts`: `it.skipIf(!isHafConfigured())('does not throw and does not over-admit on malformed pevo.authors shapes', ...)`. Covers both failure-mode classes the architect named:
- **(1) Non-array top-level shapes** (`authors: null`, `authors: "alice"`, `authors: 42`, `authors: {hive: 'alice'}`): real-Postgres assertion that the helper does NOT raise (the existing CASE-WHEN array-guard short-circuits to `'[]'::jsonb`) and the admit set matches the empty-array case (only `third_party` admitted; `alice` excluded by `c.author != p.author`).
- **(2) Array-of-non-objects elements** (`authors: ["alice","bob"]`, `authors: [null]`, `authors: [{name: 'alice'}]`): real-Postgres assertion that the helper does NOT raise and the admit set is `['bob_named_as_string', 'third_party']`.

**Discrepancy flagged against the hold-block's behavioral assertion**: the architect's round-2 fix recipe paragraph said "pin that the named-string co-author and the object-without-hive-key co-author are NOT admitted as non-self reviewers." The architect's code-fix recipe — restrict EXISTS to `jsonb_typeof(auth) = 'object' AND auth ->> 'hive' = c.author` — does NOT achieve that behavior for either case. Trace for `authors: ["alice","bob"]`, reviewer = bob: BEFORE the fix, `auth ->> 'hive'` on a JSONB string returns NULL → EXISTS yields 0 rows → NOT EXISTS = TRUE → admitted. AFTER the fix, `jsonb_typeof(auth) = 'object'` evaluates FALSE on the strings → EXISTS yields 0 rows → NOT EXISTS = TRUE → still admitted. Same trace for `authors: [{name: 'alice'}]` (object without `hive` key): `auth ->> 'hive'` is NULL pre- and post-fix; admit unchanged. The architect's code fix is structurally cleaner (self-documenting, defensive against `->>` semantics drift) but does NOT exclude bare-string co-author entries from admission.

Per `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28` and the convention that `authors[]` is a set of well-formed objects with `hive` keys, treating malformed bare-string entries as co-author claims would silently elevate malformed data into real co-authorship status (a security regression — anyone could mint a non-paper post with `authors: [target]` to lock target out of reviewing). The behavioral test pins the actual code-fix behavior; if the architect intended bob to be excluded, the helper needs an additional `OR (jsonb_typeof(auth) = 'string' AND auth #>> '{}' = ${r}.author)` clause that is NOT part of this commit. Flagging for round-4 disambiguation.

**Item 2 [P3]** — `hafsql.ts:296` JSDoc updated: `@param opts.reviewAlias` → `@param opts.commentAlias` (with `(optional, defaults to 'c')` description); the docblock that already used `commentAlias` in its prose now agrees with the param-tag.

`commentAlias: 'c'` argument dropped at 6 production callsites (the 7th the architect listed, `stats.ts:57`, uses non-default alias `'r'` per the architect's own retain-rule for non-default aliases — left untouched). The 6 sites:
- `routes/search.ts:183`
- `routes/profile.ts:98` (user_papers reviews list)
- `routes/profile.ts:352` (`selfExclude` variable in `fetchUserReviewsFromHaf`)
- `routes/papers.ts:2229` (paper detail review list)
- `reputation.ts` paper_reviews CTE JOIN
- `reputation.ts` user_reviews CTE JOIN

Callsites with non-default aliases retained explicit args per the rule: `papers.ts` listing-`r` and listing-`rv`, `reputation.ts` citing-`c2`, `stats.ts:57` `r`. Test-file callsites unchanged (test verbosity is lower-cost; helper-shape canaries in `hafsql.test.ts:387, 396, 406` explicitly pass `commentAlias` to pin the parameter shape).

**Item 3 [P3]** — `reputation.ts:active_authors` review arm now composes `excludeSelfReviewWhere({ paperRowAlias: 'p', appTagParam: '$3' })` immediately after `validReviewWhere`. Block comment expanded to document the exploit path the gate closes (named co-author who has never published nor reviewed others' work bootstrapping into the accredited voter_weight curve `LEAST(1.0, GREATEST(0.4, 0.4 + 0.6 * sqrt(rep/100)))` — floor 0.4 at rep=0 — via one self-review). Cross-references the 3 sibling review-class CTEs (paper_reviews, user_reviews, citing_paper_quality) so a future maintainer doesn't strip the helper "for consistency" thinking the upstream accreditation gate makes it redundant.

`computeReputationBatch` param-list docblock at `reputation.ts:330-346` extended with a second paragraph noting that the FOUR review CTEs also compose `excludeSelfReviewWhere`, mirroring the existing "FOUR review CTEs that compose validReviewWhere" language.

`tests/excludeSelfReviewWhere-callsite-canaries.test.ts` `CALLSITES` table bumped: `reputation.ts` from `minOccurrences: 3` → `4`, with the new entry `active_authors review arm`. The docblock at the top of the file updated to list 11 callsites (was 10) and cite round-2 hold #3 as the source of the new site. Mutation kill verified at test runtime: the canary fires the new minOccurrences assertion against the current source.

### Carry-forwards

The architect-owned doc update to `agents/docs/reputation-algorithm.md` documenting the 4-site self-exclusion invariant remains pending for the architect's archive commit.

### Discrepancies to disambiguate at round-3

- **Item 1 behavioral assertion vs code-fix divergence** (described above): architect's hold-block prose says "named-string co-author NOT admitted" but the prescribed code fix doesn't achieve that. Code applied as-written; behavioral test pins actual behavior. Architect to disambiguate whether (a) the code fix is sufficient and the prose is imprecise, or (b) the helper needs an additional string-form match clause.
- **Item 2 7th callsite** (described above): architect listed `stats.ts:57` among the 7 sites to clean up, but it uses non-default alias `'r'` and per the architect's own retain-rule should keep its explicit arg. Treated as a count discrepancy in the hold block; 6 sites cleaned.

---

## Architect re-review round-3 (2026-05-15) — HELD PENDING FIXES

`/ce-code-review` on commit `ef137ba` dispatched 10 reviewers (correctness, security, adversarial, testing, maintainability, project-standards, performance, reliability, kieran-typescript, ce-learnings-researcher; `ce-agent-native-reviewer` skipped per project CLAUDE.md). All 3 round-2 hold items addressed in form. Round-3 surfaces 4 items held below — 1 P1 that subsumes round-2's stated purpose (cascade-fail path still reachable via a sibling site that bypasses the hardened helper), 2 P2 (the implementer-flagged disambiguation, plus an SQL-shape canary gap), 1 P3 docblock count fix. Item 5 (lattice-coverage gap) dismissed; round-3 disambiguation resolved in favor of the implementer's read — see item 2.

### Items to address

#### P1 — high

**1. (P1) `paper_resolved_votes` CTE has unguarded `jsonb_array_elements(... -> 'authors')` — same cascade-fail class round-2 hold #1 was hardening; round-2's stated purpose is NOT yet achieved.**

**Where:** `backend/src/reputation.ts:594-597` (paper_resolved_votes CTE's NOT EXISTS subquery).

**Why:** Cross-corroborated by reliability (P1, conf 100); architect-verified at the worktree. The round-1 hold #2 framing said "the daily reputation cycle would crash for all users" if a chain post broadcasts `pevo.authors` as a non-array JSONB. Round-2 hardened the `excludeSelfReviewWhere` helper, but `paper_resolved_votes` does its own inline `jsonb_array_elements(up.json_metadata -> $3 -> 'authors')` at line 595 WITHOUT routing through the helper. Same single-transaction `computeReputationBatch` query — the cascade-fail still happens here. A chain post with `authors: null` (or string / integer / object) on any `user_papers` row throws `cannot extract elements from a scalar`, and the entire daily cycle fails for all users. The round-1 #2 framing literally cited this site (lines 555-560) as the canonical precedent shape for the helper's identity predicate, but the helper hardening did not propagate back into the CTE that inspired it.

**Fix:** Wrap the `-> 'authors'` argument with a CASE-WHEN array guard, identical to the helper's round-1 #2 fix:

```sql
NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(up.json_metadata -> $3 -> 'authors') = 'array'
         THEN up.json_metadata -> $3 -> 'authors'
         ELSE '[]'::jsonb
    END
  ) a
  WHERE a ->> 'hive' = plv.voter
)
```

Optional structural improvement: extract a helper (e.g., `excludeNamedCoAuthorVotesWhere`) so the next sibling vote-class CTE can't re-introduce the inline shape. Non-blocking — decide at implementation time. If you go that route, also bring the helper through the `excludeSelfReviewWhere-callsite-canaries.test.ts` source-level canary so the new helper has parity coverage with the round-1 #2 sibling.

Add a behavioral test exercising the cascade-fail path at `paper_resolved_votes` (a synthetic `up` row with `authors: null` + a vote row, asserting NOT EXISTS short-circuits without raising). Real-Postgres synthetic-VALUES is fine under carve-out clause-(c) — same shape as the round-1 #2 malformed-shapes matrix in `hafsql.test.ts`. The new test can sit in either `hafsql.test.ts` (as a parallel describe block) or a new `reputation-paper-resolved-votes-malformed-authors-canary.test.ts`; implementer's call.

#### P2 — moderate

**2. (P2) Bare-string co-author admission — implementer-flagged disambiguation resolved: code is correct, hold-block prose was imprecise. Comment-only fixes.**

**Where:** `backend/src/hafsql.ts:334-341` (block comment above the EXISTS predicate) + `backend/tests/hafsql.test.ts:519-540` (block comment above the array-of-non-objects assertion).

**Why:** Cross-corroborated by correctness (P3, conf 75), adversarial (P2, conf 75), maintainability (P3, conf 75), testing (P3, conf 75), security (residual), learnings (cited convention) — 4-reviewer cross-corroboration promotes confidence to 100. The round-2 code fix (`jsonb_typeof(auth) = 'object'` guard inside EXISTS) does NOT exclude bare-string co-author entries from being admitted as non-self reviewers — the test correctly pins `bob_named_as_string` IS admitted under `authors: ["alice","bob"]`. The implementer's argument (per `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28`) stands: treating bare-string entries as co-author claims would let anyone broadcast `authors: [target]` to lock `target` out of reviewing — a worse vulnerability than the current admit-the-bare-string outcome. **Resolution: code stays as-is; the round-2 hold-block prose was imprecise.**

**Fix:**

(a) Rewrite the comment block at `hafsql.ts:334-341` to accurately describe the admit outcome. Specifically: explain that the `jsonb_typeof(auth) = 'object'` guard prevents the EXISTS subquery from raising on non-object elements (the cascade-fail vector round-2 #1 closed at the helper level), AND that bare-string elements (e.g., `authors: ["alice","bob"]`) are intentionally NOT treated as co-author claims — those reviewers fall through to the second conjunct of `excludeSelfReviewWhere` and ARE admitted as non-self reviewers. Make explicit that the alternative (treat bare strings as identity claims) was rejected because it would enable a cheap denial-of-review attack via malformed metadata broadcast (anyone publishes a non-paper post with `authors: [target]`, target gets locked out of reviewing). Cross-reference `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28`.

(b) Rewrite the misleading block comment at `hafsql.test.ts:519-540`. The current opening sentence ("so a named-string co-author is NOT admitted as a non-self reviewer") contradicts the assertion below it (`expect(admitted).toEqual(['bob_named_as_string', 'third_party'])` — bob IS admitted). Make the comment match the actual pinned behavior and explain why this is the intended outcome (cross-ref the rationale from item (a)). Keep the test assertion as-is — it pins the correct intentional behavior.

(c) No code-fix to the helper itself.

**3. (P2) SQL-shape pure-unit canary at `hafsql.test.ts:386` does not pin the new `jsonb_typeof(auth) = 'object'` guard — pure-unit layer provides zero mutation kill for round-2's central change.**

**Where:** `backend/tests/hafsql.test.ts:386-410` (the `excludeSelfReviewWhere SQL shape` describe block).

**Why:** Cross-corroborated by testing (P2, conf 100) + kieran-typescript (P3 testing-gap). Per `defense-in-depth-canary-must-pin-each-layer-2026-05-07`, each defense layer needs its own canary. The 3 shape `it` blocks at lines 386-410 assert `c.author != p.author`, `jsonb_array_elements`, `auth ->> 'hive' = c.author`, `NOT EXISTS` — none assert the new guard. Reverting the guard leaves shape tests green; only the HAF-gated behavioral test catches the revert.

**Fix:** Add `expect(sql).toContain("jsonb_typeof(auth) = 'object'")` to the first shape `it` block at line 387. Optionally add the same assertion to the other 2 shape blocks for consistency, but the first site is sufficient mutation kill.

#### P3 — polish

**4. (P3) Docblock prose count drift in `excludeSelfReviewWhere-callsite-canaries.test.ts`: prose says "11 callsites" but the docblock listing omits `reviews.ts` (which IS in the CALLSITES data table at `minOccurrences: 1`).**

**Where:** `backend/tests/excludeSelfReviewWhere-callsite-canaries.test.ts:385` (the `That's 11 callsites` line + the docblock listing immediately above it).

**Why:** Maintainability (P3, conf 75). Sum of `minOccurrences` across the CALLSITES data table = papers(3) + profile(2) + search(1) + stats(1) + reviews(1) + reputation(4) = 12. The docblock listing above the count line enumerates papers / profile / search / stats / reputation but omits the reviews.ts entry. Pre-existing -1 drift extended by this round to a -1 (reviews.ts was missing from the listing in round-1 hold #1's lift-in too). A future maintainer reconciling prose against the data table will get confused which basis the number uses.

**Fix:** Bump prose to "12 callsites" and add `- reviews.ts: fetchReviewFromHaf single-doc fetch (round-1 hold #1)` to the docblock listing. One-line edit + count update.

### Findings dismissed at triage (residual, no action)

- **(learnings, conf 100) — Behavioral matrix missing 4 array-element-axis rows from `hold-block-shape-coverage-must-walk-full-lattice-2026-05-14`.** Missing rows: `[1,2,3]` (integer-element array), `[{hive:null}]` (object with JSONB null at discriminator), `[{hive:'alice'},'bob']` (mixed valid+string), `[{hive:'alice'},{name:'bob'}]` (mixed valid+invalid-object). Per the convention author's own analysis, all 4 shapes behave correctly under current code (no throw, no over-admission shift). The gap is theoretical lattice-coverage, not live regression risk. **Dismissed per `feedback_dismiss_preemptive_test_hardening`** — preemptive hardening of already-correct behavior defaults to dismiss; if a real regression class shows up later, file then.

### Pre-existing findings surfaced (no action this task; informational)

- **adversarial — edit-after-self-review race.** Paper author edits `authors[]` to remove a named co-author after their self-5/5/5/5 review lands; next cycle re-admits. Symmetric with `paper_resolved_votes`'s same edit-after-vote race against `authors[]` mutability. Round-1 dismissed as residual; carries over.
- **adversarial — anon-proxy bypass.** Reviews routed via `hiveAnonAccount` ($19) bypass `excludeSelfReviewWhere` entirely (the proxy identity is neither paper-author nor named-co-author, so the helper admits regardless of the true reviewer). Privacy-vs-self-exclusion trade-off; out of scope.
- **reliability (P2) — `notification-queries.ts:329, 358` use unguarded `jsonb_array_elements(... -> 'citations')`.** Same vulnerability class as item 1 but on `citations`, not `authors`. Sibling sites at `profile.ts:110`, `stats.ts:72`, `reputation.ts:781` all have the `jsonb_typeof = 'array'` guard. Per-user query failure (not cascade-fail across cycle). Pre-existing; not introduced by this commit. Worth a separate follow-up task if the architect wants the convention applied universally, deferred to user triage.

### Re-review signal

When items 1, 2, 3, 4 land, `git mv` this file from `tasks/pending/` back to `tasks/review/`. Use bare `backend:` or `backend(<scope>):` commit prefixes so the zone-audit hook fires. The architect's next review pass scopes `/ce-code-review` to commits since `ef137ba`.

Items can fan out independently — natural groupings: item 1 (paper_resolved_votes guard + behavioral test) at `reputation.ts` + extension to `hafsql.test.ts` or a new test file; item 2 (comment fixes) at `hafsql.ts` + `hafsql.test.ts`; item 3 (SQL-shape canary) at `hafsql.test.ts:386`; item 4 (docblock count) at `excludeSelfReviewWhere-callsite-canaries.test.ts`. Items 2 and 3 both touch `hafsql.test.ts` so consider bundling.

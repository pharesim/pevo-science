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

## Backend re-review signal (2026-06-09) — round-1 hold items 1-3 landed

1. **(P1) Revote-channel claimer self-vote bypass closed in `fetchEnrichmentFromHaf`.** Built an `acceptedClaimers` Set from the already-fetched `claimsResult` (`status === 'accepted'`, scoped to this paper) and skip those voters in BOTH the native-vote loop and the revote-only loop, mirroring `batchResolveVotes`' `claimedSet` skip. A credited claimer (ORCID / name-only, absent from `authors[].hive`) self-voting via a `revote` custom_json no longer inflates the paper-detail `net_votes`; the listing and detail surfaces now agree.
2. **(P2) Vote-path tests.** (a) Raised the `papers.ts` `excludeClaimedSelfWhere` source-count pin from `>= 2` to exact `=== 3` (listing review-agg + paper-detail review list + paper-detail vote query) so dropping any one fails red. (b) `profile.ts` now asserts the per-file gate count `>= 2` (getProfileStats + fetchUserReviewsFromHaf) instead of a single `.toContain()`. (c) Added a behavioral `net_votes` canary file `display-claimer-self-vote-revote-exclusion.test.ts`: the listing arm calls the now-exported `batchResolveVotes` with a claimer who self-votes via BOTH a native vote and a revote (asserts `net_votes === 1`, third-party only); the detail arm drives `/enrichment` through the mocked pool with the claimer self-revoting (asserts response `net_votes === 1`, claimer absent from voters). Both mutation-kill item 1 (without the skip, `net_votes === 2`). Added a source-shape pin that `papers.ts` references `acceptedClaimers.has(`.
3. **(P2) Offset arithmetic.** Introduced `const drVoteAccreditedIdx = drAuthorIdx + 2` (with a comment that the equality with `drAppTagIdx` is coincidental, not by design) and bound the vote query's `accreditedArr` through it instead of the bare `$${drAuthorIdx + 2}`.

`batchResolveVotes` is now exported (matching the file's `resolveChainCumulativeAuthors` plain-export precedent) so the cross-channel skip is directly exercisable. Verification: `npm run typecheck` (src + tests) + `npm run lint` clean (lone pre-existing `author-supersession.ts` warning untouched); both display test files green (5 tests; the `/enrichment` arm returns 200 with `net_votes === 1`).

---

## Architect re-review (2026-06-09) — HELD PENDING FIXES (1 item)

Re-review of the round-1 hold fixes (commit 7802fcf1) via `/ce-code-review` (11 personas; correctness/security/adversarial on Opus). **The round-1 holds are all VERIFIED CORRECT and the fix is sound.** The revote-channel claimer self-vote exclusion is complete across the full 2x2 (native/revote × listing/detail) — adversarial and security independently cleared every channel and the `acceptedClaimers`/`claimedSet` evasion surface (status is a fixed SQL literal, `claimsResult` is paper-scoped on detail and paper-keyed on listing, pending→accepted only ever tightens the set). The tests mutation-kill: the architect ran `display-claimer-self-vote-revote-exclusion.test.ts` in isolation (2/2 pass, asserting `net_votes === 1` even under the real genesis block, so non-vacuous). The source-count pins are exact (papers.ts `=== 3`, profile.ts `2`, both grep-confirmed). One P3 hardening item blocks archive:

1. **(P3 — kieran-typescript, security-adjacent) Type the claims rows so the accepted-claimer exclusion cannot silently degrade to a no-op.** In `fetchEnrichmentFromHaf`, `claimsResult` comes from `pool.query()` on the raw `pg.Pool`, which returns `QueryResult<any>`, so `r.claimer as string` is a no-op cast and `r.status === 'accepted'` is unchecked. A future projection change to the claims SELECT (e.g. `status` renamed or dropped) would silently leave `acceptedClaimers` empty — turning the self-vote exclusion into a no-op with NO compile error and NO runtime error, reopening the exact self-dealing gap this task closed. `batchResolveVotes` is already correctly typed (its structural pool param forces `Record<string, unknown>[]`), and the sibling `authorship_claims` `.map()` in the SAME function already annotates `(r: Record<string, unknown>)`. Fix: give the claims query a typed row — `pool.query<ClaimsRow>(...)` with an explicit `ClaimsRow` interface (`claimer: string; status: string; ...`) — or, minimally, annotate the loop as `for (const r of claimsResult.rows as Array<Record<string, unknown>>)` to match the existing `.map()` at the same site. Anchor any new comment on behavioral semantics.

### Recorded dispositions (do NOT re-triage — for implementer context)

- **DISMISSED (no action):**
  - `drVoteAccreditedIdx` is still `= drAuthorIdx + 2` (offset arithmetic) and the `dr` prefix reads as review-query param space (testing + maintainability + kieran-typescript). DISMISSED: the implemented form is exactly the remedy round-1 hold item 3 OFFERED (the dedicated `const drVoteAccreditedIdx = drAuthorIdx + 2`); the binding is correct today and the comment documents the coincidence. The "own counter + rename + param-position test" alternative is optional polish only.
  - Adversarial "the display docstrings overstate display↔score parity for named `authors[].hive` co-author self-votes." DISMISSED: the architect verified `excludeClaimedSelfWhere`'s docblock scopes its "exactly as the score path does" claim precisely to a credited CLAIMER's self-vote; the cited "self-votes are already excluded from every vote-aggregating surface" phrasing does not exist in the file. The underlying named-co-author display-vote asymmetry (the display vote path filters the chain poster + claimer; the score additionally filters named co-authors) is pre-existing, intentional, and out of this task's scope.
  - Test-robustness nits (the SQL-substring mock dispatch could mis-route on a future query reword; the native-loop defense-in-depth skip and a pending-claimer case are not behaviorally exercised). DISMISSED as preemptive — the test is verified non-vacuous and the failure modes are theoretical-only.

- **ARCHITECT-HANDLED at this task's clean archive (NOT implementer work):** `api-contracts/papers.md` (the `review_count` field note + the enrichment `net_votes` field note gain the accepted-claimer exclusion) and `api-contracts/reviews.md` (the NOT_FOUND list: `GET /api/reviews/:author/:permlink` now 404s for a credited-claimer self-review, previously 200). Deferred so the docs reflect the final post-fix shape.
- **ARCHITECT-/ce-compound at this task's clean archive (NOT implementer work):** the vote-resolution 2x2-parity lesson (votes resolve through two paths, `batchResolveVotes` for listings and `fetchEnrichmentFromHaf` for detail, each merging two channels, native vote ops + revote custom_json; a vote-semantic gate must apply across the full 2x2, and a review of any vote-filter change must check the JS-merge revote channel, not only the SQL vote query). Confirmed genuinely new (no existing docs/solutions entry).

When item 1 lands, `git mv` this file back to `tasks/review/`; the move is the re-review signal. Scope the re-review to the commit since this hold block.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

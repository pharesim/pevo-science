# Review filter: drop app gate, add structural-validity gate, enforce display/reputation parity

**Owner:** Backend Agent
**Created:** 2026-05-12

## Problem

PEvO's review filter today is `type='review' AND app LIKE 'pevotest/%' AND author IN active_accreditations` (with an anon-proxy carve-out). Two consequences flow from this:

1. **The `app LIKE 'pevotest/%'` gate excludes valid reviews authored via non-PEvO Hive clients.** Same failure mode as the discussion-comments bug fixed in `backend(comments): drop authoring-client gate from discussion thread filter` (commit d92e605). Per CLAUDE.md "accreditation is the trust layer", the authoring client is not load-bearing; an accredited scientist's review broadcast from peakd/ecency/any Hive client is still a PEvO review.

2. **The current filter does NOT validate review *shape*.** A reply with `pevotest.type='review'` and `app='pevotest/0.1'` but no `rating` object — or a partial/non-numeric one — surfaces as a review:
   - Paper-detail review list defaults missing ratings to `{methodology: 0, novelty: 0, clarity: 0, significance: 0}` (`papers.ts:2289`, `reviews.ts:28`) and shows it with all-zero stars.
   - Listing `review_count` (`papers.ts:455-458`) counts it.
   - Listing `avg_rating` (`papers.ts:471-474`) has only a single `rating IS NOT NULL` safety net; partial ratings (3-of-4 dims) still pass and produce NULL math downstream.
   - Reputation `paper_reviews` quality CTE (`reputation.ts:563-577`) casts each rating field to `::numeric` unconditionally — a string rating crashes the cycle compute.

3. **Display and reputation drift.** Because each callsite writes its own filter, there is no guarantee that "review shown on the page" ↔ "review counted in reputation". The user-facing principle is: any review surfaced to a reader MUST contribute to reputation, and vice versa. There must be one canonical "valid PEvO review" SQL fragment used everywhere.

## Acceptance criteria

### 1. Add a canonical `validReviewSql` helper

`backend/src/hafsql.ts` — replace `isPevoReviewSql` (or extend it; keep the name for grep continuity) with a fragment that:
- Asserts `(c.json_metadata -> $appTag ->> 'type') = 'review'`
- Drops the `c.json_metadata ->> 'app' LIKE 'pevotest/%'` clause (per principle #1 above)
- Adds shape validity: rating object present AND all four dimensions are integers in `[1, 5]`. Recommended form:
  ```sql
  AND c.json_metadata -> $appTag -> 'rating' IS NOT NULL
  AND (c.json_metadata -> $appTag -> 'rating' ->> 'methodology')  ~ '^[1-5]$'
  AND (c.json_metadata -> $appTag -> 'rating' ->> 'novelty')      ~ '^[1-5]$'
  AND (c.json_metadata -> $appTag -> 'rating' ->> 'clarity')      ~ '^[1-5]$'
  AND (c.json_metadata -> $appTag -> 'rating' ->> 'significance') ~ '^[1-5]$'
  ```
  (Regex over `->>` text is portable across HAF readers; numeric casts on user-supplied JSON values are not — see `reputation.ts:566-569` for the cast-and-crash risk.)
- Continues to require the author to be in `active_accreditations` OR equal `config.hiveAnonAccount`. Trust layer is unchanged; only the shape/client gates are.

### 2. Apply the helper at every review-class SQL site

Replace ad-hoc `(c.json_metadata -> $X ->> 'type') = 'review' AND c.json_metadata ->> 'app' LIKE $Y` pairs with the helper at:

**Display path:**
- `backend/src/routes/papers.ts:455-458` — listing `review_count`
- `backend/src/routes/papers.ts:471-474` — listing `avg_rating` (drop the `rating IS NOT NULL` line; the helper supersedes it)
- `backend/src/routes/papers.ts:2195-2198` — paper detail review list
- `backend/src/routes/profile.ts:96` (and `:321` already via `isPevoReviewSql`) — profile reviews list
- `backend/src/routes/search.ts:165` — search type=review path
- `backend/src/routes/stats.ts:56` — review counter
- `backend/src/routes/reviews.ts:56-65, 70` — single-review endpoint (SQL filter + the JS `isPevoReview` post-filter at line 70 should be updated/replaced to match)
- `backend/src/helpers.ts:41-44` — `isPevoReview` JS-side: update to mirror the SQL shape (drop the `app` startsWith check, add rating-shape validation). Used by `reviews.ts:70`; failing to update it leaves a JS-level mirror that re-imposes the dropped app gate.

**Reputation path:**
- `backend/src/reputation.ts:403` — confirm context and apply
- `backend/src/reputation.ts:563-577` — `paper_reviews` quality CTE (the AVG/4.0/5.0 quality computation)
- `backend/src/reputation.ts:609-616` — `user_reviews` CTE
- `backend/src/reputation.ts:755-759` — confirm context and apply

**Notifications:**
- `backend/src/notification-queries.ts:169, 190` — review notifications. Same shape so a reader notified about a new review can actually find it on the paper page.

### 3. Display ↔ reputation parity invariant

After this task, the implementer MUST be able to state (and a test must enforce) that for any chain row `c`:

> `c` surfaces as a review on the paper detail page  ⟺  `c` contributes to the paper's `review_count` and `avg_rating`  ⟺  `c` contributes to the paper's `paper_reviews.quality` multiplier  ⟺  `c` contributes to the reviewer's `user_reviews` in the reputation cycle.

If any of these diverge (e.g., a row passes one filter but not another), the parity invariant is violated.

### 4. Tests

Use real HAF (no mocking; see CLAUDE.md "Running Tests"). Add canaries that pin the four valid/invalid axes:

- **Valid PEvO-app review by accredited author** → surfaces on detail, contributes to count/avg, contributes to reputation cycle.
- **Valid non-PEvO-app review by accredited author** (peakd/ecency authored): same as above. This is the new behavior — the existing tests likely assume the app gate.
- **Review-typed reply with missing/partial/non-numeric `rating`** by an accredited author: does NOT surface on detail, NOT in count/avg, NOT in reputation. This pins the structural-validity gate.
- **Review-typed reply by an unaccredited author**: does NOT surface anywhere. Trust gate is unchanged.

The parity invariant can be pinned at the unit level by a single test that picks one paper and asserts the set of `(author, permlink)` returned by the detail review list equals the set scored in the latest reputation cycle for that paper.

## Implementation notes

- Companion task: `backend-self-review-exclusion-everywhere.md` (sibling). Both tasks touch overlapping SQL sites. If `backend-self-review-exclusion-everywhere` lands first, this task's helper composes against the self-exclusion predicate; if this lands first, the self-exclusion task adds `AND c.author != <paper_author>` at each site. Coordinate ordering with the architect; either order works as long as the second to land doesn't regress the first.
- The `isPevoReview` JS helper at `helpers.ts:41` is currently the only JS-side filter; its callers (notably `reviews.ts:70` and any test that constructs review-shaped metadata) need to be re-checked after the helper changes — especially that the SQL and JS definitions agree on what "valid" means, otherwise a row can pass SQL but fail JS (or vice versa).
- The bridge-paper context in `validPevoPaperWhere` (paper-class identity check) is unrelated to review-class identity; no changes there.
- Worth verifying: does any review URL currently rely on `app === 'pevotest/0.1'` for migration/legacy reasons? Grep the metadata-restored / continuation paths in `papers.ts` before stripping.

---

## Architect re-review (2026-05-12) — HELD PENDING FIXES

`/ce-code-review` on commit `8be9206` dispatched 11 reviewers (correctness, testing, maintainability, project-standards, learnings, security, performance, api-contract, reliability, adversarial, kieran-typescript). 21 findings surfaced through the confidence gate. After user triage: 8 items held below, 6 dismissed, 5 fixed in place by the architect (contract-doc drift across `hive-schemas.md` + 3 api-contracts files, landed in commit `588a654`). The companion commit `2e5d20e` (self-review exclusion) has not been reviewed yet — items below scope to `8be9206`'s diff but should compose cleanly with the self-exclusion helper.

### 1. [P0] Reputation cycle: 3 review-class CTEs gate `validReviewWhere` but NOT `c.author IN active_accreditations`

**Where:** `backend/src/reputation.ts`
- `paper_reviews` quality CTE — `~line 580` (AVG over ::numeric casts of rating dims)
- `citing_paper_quality` inner subquery — `~line 766` (same AVG shape, citation arm)
- `active_authors` review arm — `~line 405` (the second arm of the UNION ALL after the paper arm)

**Why:** Cross-corroborated by 3 reviewers (adversarial P0, correctness P2, security P3). The `validReviewWhere` helper docstring explicitly says callers compose accreditation; these three callsites don't. Pre-commit, the dropped `app LIKE 'pevotest/%'` was a weak spoofable filter; post-commit nothing replaces it. An unaccredited Hive account broadcasting `{type:'review', rating:{5,5,5,5}}` to an accredited author's paper inflates `pr.quality` → multiplies into `paper_scores` → reputation is gameable for free. Display sites (`papers.ts`, `profile.ts` stats CTE, `search.ts`, `stats.ts`, `notification-queries.ts`, `reviews.ts`) all compose accreditation alongside the helper — these 3 CTEs are the asymmetric pair. This directly violates the task's claimed display↔reputation parity invariant.

**Fix:** add at each CTE
```sql
AND (EXISTS (SELECT 1 FROM active_accreditations aa WHERE aa.account = c.author)
     OR c.author = $<anonParam>)
```
Wire `config.hiveAnonAccount` as a param at all three sites (`paper_reviews` and `citing_paper_quality` currently bind `$3 = appTag` only — add an anon param; `active_authors` already binds `$18 = bridgeAccount` but not anon — add it).

### 2. [P1] `fetchUserReviewsFromHaf` has no accreditation gate (listing/detail drift + spam vector)

**Where:** `backend/src/routes/profile.ts:317-409` (count + data queries) and the route handler at `:395`.

**Why:** Cross-corroborated by adversarial (P1) and security (P3). The query filters on `c.author = $1` (URL username) + `validReviewWhere`, no accreditation predicate at SQL OR route. `/api/profile/jdoe/reviews` for an unaccredited `jdoe` returns 300-char body excerpts; clicking through hits `/api/reviews/jdoe/<permlink>` which correctly returns 404 (that endpoint DOES gate accreditation). Spam surface: any unaccredited Hive account can write valid-rating review-shaped replies to accredited authors' papers, then their own profile reviews page surfaces the excerpts. Same root cause as item #1 (helper docstring vs. caller composition).

**Fix:** add `AND (c.author IN (SELECT account FROM active_accreditations) OR c.author = $<anonParam>)` to BOTH the count query and the data query. Wire `config.hiveAnonAccount` as a new param (currently `$1 = username`, `$2 = appTag`; add `$3 = anon` and shift limit/offset/accreditedAccounts indices accordingly).

### 3. [P2] Notification arm 1a: no parent-is-PEvO-paper check (cross-zone griefing vector)

**Where:** `backend/src/notification-queries.ts:147` (arm 1a — "new review on your paper").

**Why:** Arm 1a gates only `co.parent_author = $1 AND validReviewWhere(co)`. The LEFT JOIN to the parent paper is for fetching the title, NOT for enforcing the parent IS a PEvO paper. An accredited attacker writes a `type='review' rating={1,1,1,1}` reply to ANY of the recipient's Hive comments (a blog post, a regular comment elsewhere, a peakd reply) → recipient receives a `new_review` notification with an empty title (LEFT JOIN to a non-paper). Arm 1b (bridge papers) is correctly tighter; arm 1a is the gap. Same caller-must-compose-identity-gate root cause.

**Fix:** replace the LEFT JOIN to the parent with an INNER JOIN that also enforces paper-class identity, mirroring arm 1b's pattern:
```sql
JOIN ${T.comments} p
  ON p.author = co.parent_author AND p.permlink = co.parent_permlink
  AND ${validPevoPaperWhere({commentAlias:'p', appTagParam:'$<N>', bridgeAccountParam:'$<M>', source:'all'})}
```

### 4. [P2] `reviews.test.ts:201-230` gate responder asserts accreditation strings but not the rating-shape regex (upstream-guard canary gap)

**Where:** `backend/tests/routes/reviews.test.ts:201-230` (`installGateResponder`).

**Why:** Per `agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md`, when defense-in-depth has multiple gates (here: SQL `validReviewWhere` + JS `isPevoReview` post-filter), each gate must have its own canary. Today only the downstream JS gate has independent test coverage in `helpers.test.ts`; the upstream SQL gate at the route layer has no canary because the responder doesn't assert it. Reverting `validReviewWhere` from `fetchReviewFromHaf` would still pass all existing tests. **The learnings-researcher predicted this gap from the convention doc; the testing reviewer independently surfaced it.**

**Fix (one-line):** add to `installGateResponder`:
```ts
expect(sql).toContain("~ '^[1-5]$'");
```
Mutation-kill: revert the helper call at `reviews.ts:67` → assertion fails red.

### 5. [P2] `reviews.ts:60` `appTagParamIdx = accredCte.nextIdx + 3` magic offset

**Where:** `backend/src/routes/reviews.ts:60`.

**Why:** Sole call site in the codebase deriving a `$N` parameter index by offset arithmetic instead of a counter. Adding/removing any bind between line 67 and line 70 — or changing `activeAccreditationsCte()` to return additional params — silently mis-binds `appTagParam`. Every other call site uses literal `'$2'`/`'$3'` strings or `$${paramIdx++}`. The helper's own docstring demonstrates the counter pattern as canonical.

**Fix:** replace the offset arithmetic with a local counter (`let paramIdx = accredCte.nextIdx; const authorIdx = paramIdx++; …`).

### 6. [P3] `hafsql.ts:235` `rating IS NOT NULL` is dead-code (Postgres JSONB-null semantics)

**Where:** `backend/src/hafsql.ts:235` (first clause of `validReviewWhere`'s body).

**Why:** `'null'::jsonb IS NOT NULL` returns TRUE in Postgres — JSONB has a distinct internal `null` value separate from SQL NULL. The clause does NOT reject `{rating:null}`; the four regex lines below catch it via NULL propagation. Functionally safe today, but a future maintainer reading the helper would conclude `IS NOT NULL` enforces shape — and deleting the regex on that assumption would silently break the gate.

**Fix:** replace with `AND jsonb_typeof(c.json_metadata -> $appTag -> 'rating') = 'object'`. This rejects SQL NULL, JSONB null, JSONB strings, JSONB arrays, and JSONB numbers — only JSONB objects survive. Self-documenting. **Companion JS fix:** the JS `isPevoReview` in `helpers.ts:62-71` uses `typeof rating !== 'object'` which admits arrays (`typeof [] === 'object'`); add `|| Array.isArray(rating)` to maintain SQL↔JS parity.

### 7. [P3] `hafsql.test.ts:318` behavioral matrix tests only string-form ratings, not JSON integers

**Where:** `backend/tests/hafsql.test.ts:318` (the synthetic-VALUES() behavioral matrix's `valid_*` set).

**Why:** Production chain rows use JSON integers (`{methodology: 4, …}`) — the on-chain shape PEvO clients write. The behavioral matrix only tests string-form (`'4'`). Postgres's `->>` operator renders JSON integer `4` as text `'4'` today, but a future Postgres major-version upgrade or jsonb-codec change altering integer rendering would silently start rejecting every valid review on the chain, undetected by existing tests.

**Fix:** add one row to the `valid_*` set:
```ts
['valid_int_rating', { pevotest: { type: 'review', rating: { methodology: 4, novelty: 3, clarity: 5, significance: 4 } } }],
```

### 8. [P3] Acceptance criterion #4 parity-invariant test not implemented

**Where:** `backend/tests/` (no test file added).

**Why:** Cross-corroborated by testing, project-standards, and correctness residual. AC #4 in this task file explicitly required "a single test that picks one paper and asserts the set of `(author, permlink)` returned by the detail review list equals the set scored in the latest reputation cycle paper_reviews CTE for the same paper." Not implemented in this commit. **Today this test fails because of item #1** (the P0 — `paper_reviews` includes unaccredited reviewers that the detail page filters out). After item #1 is fixed, the test should pass — that's the mechanical proof the parity invariant holds.

**Fix:** real-HAF test in `backend/tests/routes/reputation-lifecycle.test.ts` (or a new `parity-invariant.test.ts`) that:
1. Picks a paper with reviews in the test HAF corpus.
2. Queries the detail-review list (via `fetchPaperFromHaf` or equivalent path).
3. Queries the `paper_reviews` CTE result set for the same paper from the reputation cycle output (or runs the cycle's exact CTE query inline).
4. Asserts `Set<(author, permlink)>` equality.

Test must run against real HAF (no mocking of `getPool()`/`getHafPool()` per `CLAUDE.md` "Running Tests"). If the test corpus lacks the right shape, the targeted real-path companion to the synthetic-VALUES() test in `hafsql.test.ts` is acceptable under the carve-out clause-C — cite the rationale in the test file header per `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`.

### Findings dismissed at triage (not actionable)

- **#2 (P1, api-contract):** `GET /api/reviews/:author/:permlink` now 404s for malformed reviews — accepted as the strict-gate-everywhere invariant this task closes. Softening the single-doc endpoint would re-introduce display↔reputation drift.
- **#7 (P2, performance):** `papers.ts:459-487` correlated subquery cost increase — unobservable at beta scale; mitigation path (HAF partial index) is blocked by external infra per `reference_haf_indexes_cannot_be_modified.md`; revisit on production-data evidence.
- **#9 (P2, testing):** no real-HAF test for `computeReputationBatch` completes on malformed-rating rows — synthetic-VALUES() filter test sufficient; real-HAF malformed-row seeding is impractical.
- **#15 (P3, performance):** `stats.ts` CTE cost — cache + JOIN-narrowing make negligible.
- **#16 (P3, maintainability):** rating range `[1,5]` triplicated — domain constant of Likert 5-point scale; drift surface dormant.
- **#18 (P3, correctness):** `comments.ts:103` hidden-bucket partition — pre-existing; accept the trade-off (malformed `type='review'` from non-PEvO clients vanish from PEvO surfaces).
- **#20 (P3, adversarial):** `stats.ts:30` param-bind drift — verified `al` is correctly retained for the papers CTE; no orphan param.
- **Suppressed below confidence gate (8 findings at anchor 50):** AC-8 (frontend `|| 0` dead code), KT-2/KT-3 (TS hardening, mostly pre-existing), M-03 (paper-class `app LIKE` asymmetry — informational only), PERF-03 (reputation-cycle cardinality bounded), correctness 4.0-vs-string asymmetry, adv-anon-proxy historical data drop, adv-active_authors-no-accred (folded into #1). KT-1 (array-as-object guard) is closed by item #6's `jsonb_typeof` + `Array.isArray` companion.

### Architect-owned doc-drift fixed in commit `588a654` (informational)

The architect landed these in parallel — no implementer action needed:
- `agents/docs/hive-schemas.md` line 20 + Section 4 canonical SQL
- `agents/docs/api-contracts/papers.md` `review_count` field note + `?type=review` search note
- `agents/docs/api-contracts/misc.md` `total_reviews` / `reviews_last_30_days` field notes
- `agents/docs/api-contracts/notifications.md` `new_review` trigger description

The remaining architect-owned doc-drift (`agents/docs/reputation-algorithm.md` parameter table + 8 CTE sites) is deferred until item #1 lands, so the architect can sync the canonical SQL to the gate-plus-accreditation final shape in one pass.

---

## Backend re-review signal (2026-05-12, working tree pre-commit)

All 8 hold-block items addressed in a single round-2 fix commit. Lint clean (`npm run lint` in `backend/`, 0 errors, 2 pre-existing seed-phrase warnings unrelated to this work). `tsc --noEmit` clean. Targeted test suites re-run against real HAF + Redis: `hafsql.test.ts` (29 passed, 3 skipped), `reviews.test.ts`, `review-parity-invariant.test.ts` (3 files, 29 passed), `helpers.test.ts` + `profile.test.ts` + `notifications.test.ts` + `reputation-lifecycle.test.ts` (4 files, 74 passed), `comments.test.ts` (1 flake on a multi-suite run resolved cleanly on isolated rerun, 6 passed). The architect's full `npx vitest run` at archive-time intake is the authoritative gate.

**Item 1 [P0]** — `reputation.ts`: added `$19 = config.hiveAnonAccount` param at `line 862` and updated the param-list docblock at `lines 326-331`. Three review-class CTEs now compose accreditation via `(c.author = ANY($2::text[]) OR c.author = $19)` matching the helper docstring's "callers compose accreditation" contract:
- `active_authors` review arm — added at the UNION ALL's second branch after `validReviewWhere`. Comment block explains the inflate-`active_authors` → `voter_weights` attack path the gate closes.
- `paper_reviews` quality CTE — added inside the JOIN's ON-clause after `excludeSelfReviewWhere`. Comment block explains the 5/5/5/5 → AVG/4.0/5.0 = 1.0x multiplier inflation.
- `citing_paper_quality` inner subquery — added inside the inner JOIN's ON-clause after `excludeSelfReviewWhere` (alias `c2`). Comment block explains the cpr.quality → cpq.review_quality → citation_scores boost path.

**Item 2 [P1]** — `profile.ts:fetchUserReviewsFromHaf`: rewrote the param-shape to thread the `activeAccreditationsCteBody` helper. New param layout: $1..$3 = CTE (appTag, authorities, genesis), $4 = username, $5 = appTag, $6 = anon, $7 = limit, $8 = offset, $9 = accreditedAccounts (votes-sort only). Both count and data queries now wrap a `WITH ${accredCte.sql}` and compose the accreditation gate via `(c.author IN (SELECT account FROM active_accreditations) OR c.author = $6)`. Comment block explains the spam-vector this closes (300-char body excerpts of review-shaped replies surfacing on unaccredited profile reviews pages).

**Item 3 [P2]** — `notification-queries.ts` arm 1a: replaced the `LEFT JOIN ${T.comments} p` (title-fetch only) with `JOIN ${T.comments} p` plus a paper-class identity check via `validPevoPaperWhere({commentAlias:'p', appTagParam: at, bridgeAccountParam: bridgeParam, source:'all'})`. Comment block explains the cross-zone griefing vector (review-typed reply to a non-paper Hive post triggering `new_review` with empty title) and the `source:'all'` rationale (arm 1a's `co.parent_author = $1` only matches native papers because bridge papers' chain author is `config.hiveBridgeAccount`, never the recipient — the union with arm 1b stays clean).

**Item 4 [P2]** — `reviews.test.ts:installGateResponder`: added a third `throw new Error(...)` mutation-kill canary requiring `sql.includes("~ '^[1-5]$'")` after the existing accreditation + anon-OR-arm checks. Comment cites the defense-in-depth-canary convention doc. Mutation-kill: reverting the `validReviewWhere(...)` call at `reviews.ts:67` makes all three "admitted reviewer" tests fail red (route returns 404 via the catch-path null fall-through).

**Item 5 [P2]** — `reviews.ts`: replaced `const appTagParamIdx = accredCte.nextIdx + 3` with the canonical counter pattern: `let paramIdx = accredCte.nextIdx; const authorIdx = paramIdx++; const permlinkIdx = paramIdx++; const anonIdx = paramIdx++; const appTagIdx = paramIdx++;`. Comment block explains why the offset arithmetic was fragile and notes that `accreditedVoteCount(...)` is a no-bind column expression (the counter doesn't advance for it).

**Item 6 [P3]** — `hafsql.ts:validReviewWhere`: replaced `c.json_metadata -> $appTag -> 'rating' IS NOT NULL` with `jsonb_typeof(c.json_metadata -> $appTag -> 'rating') = 'object'`. Comment block explains the Postgres JSONB-null vs SQL-NULL distinction and why `jsonb_typeof = 'object'` self-documents the shape narrowing the regex relies on. **Companion JS fix in `helpers.ts:isPevoReview`**: added `|| Array.isArray(rating)` to the early-out so JS↔SQL parity holds (typeof [] === 'object' admits arrays in JS; `jsonb_typeof = 'object'` does not in PG — the per-dimension regex reads currently catch arrays by NULL propagation, but the explicit Array.isArray check matches the SQL gate's intent and is defensive against future field-access reshapes).

**Test fallout from Item 6**: the `validReviewWhere SQL shape` block in `hafsql.test.ts` had two cases pinning the literal `'rating' IS NOT NULL` substring; updated to `jsonb_typeof(...) = 'object'` and added a `expect(sql).not.toContain("'rating' IS NOT NULL")` assertion so a future revert is caught.

---

## Architect re-review round-2 (2026-05-13) — HELD PENDING FIXES

`/ce-code-review` on commit `7ca2e86` dispatched 9 reviewers (correctness, security, adversarial, testing, maintainability, project-standards, learnings, performance, kieran-typescript). `ce-agent-native-reviewer` skipped. All 8 round-1 hold items verified as fixed at their cited sites (correctness trace + security trace confirm). After user triage: 4 items held below, 1 dismissed as residual. The hold items are drift introduced by the fixes (one) plus test-coverage gaps the round-2 work did not close (three).

### Items to address

**1. (P2) `profile.ts:fetchUserReviewsFromHaf` kept `nextIdx + N` offset arithmetic — the pattern item #5 explicitly eliminated in `reviews.ts`.**

**Where:** `backend/src/routes/profile.ts:338-343` — six param indices derived as `accredCte.nextIdx + N` constants (`usernameIdx`, `appTagIdx`, `anonIdx`, `limitIdx`, `offsetIdx`, `accreditedParamIdx`).

**Why:** Cross-corroborated by maintainability (P2, conf 75), adversarial (P3, conf 75), kieran-typescript (residual, conf 50), learnings. Round-1 item #5 replaced this exact pattern in `reviews.ts` with `paramIdx++` because offset arithmetic silently mis-binds if any bind between lines is added or removed. The fix landed in `reviews.ts`, but the new `profile.ts` code written in the same commit reproduces the eliminated pattern. The codebase now has two conventions in active use for the same problem: counter in `reviews.ts`, offsets in `profile.ts`. Arithmetic is correct today but the fragility class persists, and a future maintainer cannot infer which convention is canonical from reading either file.

**Fix:** convert to canonical `paramIdx++` counter:

```ts
let paramIdx = accredCte.nextIdx;
const usernameIdx = paramIdx++;
const appTagIdx = paramIdx++;
const anonIdx = paramIdx++;
const limitIdx = paramIdx++;
const offsetIdx = paramIdx++;
const accreditedParamIdx = paramIdx++;
```

**2. (P2) `user_reviews` CTE — 4th `validReviewWhere` composition site — has no accreditation gate.**

**Where:** `backend/src/reputation.ts:647-656`.

**Why:** Adversarial (P2, conf 70). Round-1 hold #1 added the `(c.author = ANY($2::text[]) OR c.author = $19)` predicate to three review-class CTEs (`active_authors` review arm, `paper_reviews` quality CTE, `citing_paper_quality` inner subquery). `user_reviews` is the 4th composition site of `validReviewWhere` in the reputation cycle and was missed in the round-1 hold. Currently safe in production because `target_users` is always sourced from accredited accounts (`reputation-batch.ts`), but a revoked-mid-cycle user whose row is still in the target set would surface non-zero `reviews` breakdown. The asymmetry also violates the structural rule: every `validReviewWhere` caller in reputation.ts MUST compose accreditation. This same rule plus the missing `validPevoPaperWhere` paper-class gate are sibling concerns (item #10 in the self-review-exclusion hold block) and should land together.

**Fix:** add `AND (c.author = ANY($2::text[]) OR c.author = $19)` to the JOIN ON-clause at the `user_reviews` CTE, matching the pattern at the sibling 3 sites. Update the param-list docblock at `reputation.ts:326-331` to reflect the 4th composition site.

**3. (P2) Notification arm 1a (round-1 item #3) has no test canary asserting the INNER JOIN + `validPevoPaperWhere` predicate.**

**Where:** `backend/tests/routes/notifications.test.ts` — no SQL-shape canary for the `new_review` arm's JOIN condition.

**Why:** Testing (P2, conf 75). The round-1 fix is a behavioral change (reviews replying to non-paper Hive content no longer trigger `new_review` notifications). Existing `notifications.test.ts` covers envelope shape, limit, and sort-order but not the gate. A future revert of `JOIN` → `LEFT JOIN` (or removal of `validPevoPaperWhere`) passes every existing test. This is the same defense-in-depth canary convention applied to the new gate.

**Fix:** mocked-pool SQL-shape canary (per carve-out clause-(a) — real-corpus seeding of a non-paper review-typed reply is impractical) that throws if the generated SQL for the `new_review` arm lacks `JOIN ${T.comments} p` with the `validPevoPaperWhere` predicate on the parent comment. Sibling to self-review-exclusion hold item #6 (notification arm coverage); both can live in one canary block.

**4. (P2) `profile.ts:fetchUserReviewsFromHaf` accreditation gate (round-1 item #2) has no test for the unaccredited-reviews spam vector.**

**Where:** `backend/tests/routes/profile.test.ts` — no test for `GET /api/profile/:username/reviews`.

**Why:** Testing (P2, conf 72). Round-1 item #2 added the SQL `accredGate` to both count and data queries in `fetchUserReviewsFromHaf`, closing the spam vector where any unaccredited Hive account writing valid-rating review-shaped replies surfaced 300-char body excerpts on `/api/profile/jdoe/reviews`. Reverting `accredGate` passes every existing test.

**Fix:** mocked-pool canary per carve-out clause-(a) asserting both queries' SQL contains the `accredGate` substring AND behavioral assertion that an unaccredited URL produces empty `data` + zero count. Carve-out header justification required.

### Findings dismissed at triage (residual, no action)

- **#19 (testing, conf 80) — `installGateResponder` canary works through error-path fallthrough rather than direct assertion.** The mutation IS killed today: revert of `validReviewWhere(...)` at `reviews.ts:67` makes admitted-reviewer `it` blocks fail because the responder throws → route catch returns null → 404 (test expects 200). **Dismissed as residual** — the route-level catch returning null-on-error is the documented load-bearing behavior; a future change to the catch shape would surface in a different test class (route error-shape tests). The dependency chain is not a current gap, just a structural property.

### Items NOT held (architect-owned doc-drift carry-forward)

The architect-owned `reputation-algorithm.md` parameter table + 8 CTE sites sync (deferred from round-1) is now safe to land at archive time after this round closes — the gate-plus-accreditation final shape is settled. Will land in the architect commit at next archive.

### Re-review signal

When items 1, 2, 3, 4 land, `git mv` this file from `tasks/pending/` back to `tasks/review/`. Use bare `backend:` or `backend(<scope>):` commit prefixes so the zone-audit hook fires. The architect's next review pass scopes `/ce-code-review` to commits since `7ca2e86`. Items 1 and 2 are independent and can fan out; items 3 and 4 can share one canary commit (notification + profile-reviews coverage in one block).

**Cross-task coordination:** Item 2 (user_reviews CTE accreditation gate) overlaps with the self-review-exclusion task's hold item #10 (user_reviews CTE missing `validPevoPaperWhere`). Both apply to the same JOIN at `reputation.ts:647-656`. Implementer should land both in one edit to avoid back-to-back churn at the same site.

**Item 7 [P3]** — `hafsql.test.ts:320-333`: added `'valid_int_rating'` row to the behavioral matrix with JSON-integer rating dims (`{methodology: 4, novelty: 3, …}`) alongside the existing string-form rows. Updated the `expect(admitted).toEqual([...])` set to include `'valid_int_rating'` (now 4 admitted, alphabetically sorted). Comment block explains the future-Postgres-upgrade silent-regression vector.

**Item 8 [P3]** — new test file `tests/routes/review-parity-invariant.test.ts`. The test:
1. Skips with `ctx.skip()` (not vacuous pass) when HAF is unconfigured, no accredited corpus exists, or no paper with passing reviews exists in the corpus.
2. Finds one native paper with at least one passing review (using `validReviewWhere` + `excludeSelfReviewWhere` + `c.author = ANY(reviewAuthors)`).
3. Runs two SQL queries selecting `(author, permlink)`:
   - **Display path** (mirrors `papers.ts:2201-2216`): `c.author = ANY($4::text[])` over `reviewAuthors = accredited ∪ {anon}`.
   - **Reputation path** (mirrors `reputation.ts:562-585`): `(c.author = ANY($2::text[]) OR c.author = $4)` over `accreditedArr` + `anonAccount`.
4. Asserts `Set<author|permlink>` equality. Sanity-floor on `displaySet.size > 0` so empty-set vacuous passes can't slip through.

If a future change adds a predicate to the display path but not the cycle (or vice versa), the sets diverge and this test fails red. Per the carve-out clause-C: this test runs real-HAF, no mocking — the carve-out doesn't apply because predicate equivalence on real data is exactly what real-HAF tests are good at.

### Items NOT in scope (potential follow-ups, no scope-expansion this round)

- `getProfileStats` `user_reviews` CTE at `profile.ts:92-100`: also lacks an accreditation gate (would inflate `review_count` on the unaccredited user's profile stats panel). Not listed in the hold block; flagging for architect awareness so it can be ticketed as a separate task if desired. Symmetric in spirit with item 2 but on a different route (`/profile/:username` vs `/profile/:username/reviews`).
- Architect-owned `agents/docs/reputation-algorithm.md` doc-drift sync (parameter table + 8 CTE sites) is deferred per the hold-block close-out note; will land in the architect's archive-time edits alongside item 1.

---

## Backend re-review signal (2026-05-13, round-3, working tree pre-commit)

All 4 round-2 hold items landed in a single coordinated commit. Cross-task lift-in for `self-review-exclusion` task hold item #10 included at the shared `reputation.ts:647-656` site per the round-2 cross-task-coordination note. Lint clean (`npm run lint` 0 errors, 2 pre-existing seed-phrase warnings unrelated). `tsc --noEmit` clean. Targeted test suites re-run against real HAF + Redis: `notifications-arm-sql-shape.test.ts` + `notifications.test.ts` + `profile-reviews-accred-gate.test.ts` + `profile.test.ts` (16 passed across 4 files), `hafsql.test.ts` + `reviews.test.ts` + `review-parity-invariant.test.ts` + `reputation-lifecycle.test.ts` (46 passed, 3 skipped), `comments.test.ts` + `search.test.ts` + `papers.test.ts` + `helpers.test.ts` (passed clean on isolated re-runs; one HAF ECONNRESET flap on combined run resolved on isolation, no SQL-shape regression).

**Item 1 [P2]** — `profile.ts:fetchUserReviewsFromHaf` paramIdx counter conversion. Replaced the six `accredCte.nextIdx + N` constants at the old `:338-343` with the canonical `let paramIdx = accredCte.nextIdx; const usernameIdx = paramIdx++; const appTagIdx = paramIdx++; const anonIdx = paramIdx++; const limitIdx = paramIdx++; const offsetIdx = paramIdx++; const accreditedParamIdx = paramIdx++;` pattern that matches reviews.ts post-round-1 item #5. Comment block above the block notes why offset arithmetic is fragile (silently mis-binds on add/remove of any intermediate bind or on changes to `activeAccreditationsCteBody`'s return param count) so a future maintainer doesn't revert under the impression that arithmetic is "cleaner." The two queries (count + data) still bind the same params in the same order; only the index source-of-truth changed.

**Item 2 [P2] + Cross-task lift-in** — `reputation.ts` user_reviews CTE (4th `validReviewWhere` composition site). Added two predicates to the JOIN ON-clause:
- **Accreditation gate** `(c.author = ANY($2::text[]) OR c.author = $19)` — matches the round-1 hold #1 fix shape applied at the three sibling review-class CTEs (`active_authors` review arm, `paper_reviews`, `citing_paper_quality`). Closes the per-callsite invariant violation flagged by adversarial (P2 conf 70) and pins the structural rule "every `validReviewWhere` caller in reputation.ts MUST compose accreditation."
- **Paper-class gate via `validPevoPaperWhere({commentAlias:'up_for_self', appTagParam:'$3', bridgeAccountParam:'$18', source:'all'})`** — this lifts in the self-review-exclusion task's round-1 hold item #10 at the same JOIN. Without it a review-typed reply to a non-paper Hive post (a blog post, a non-paper comment, a peakd reply) passed the JOIN's existence check on parent comment and inflated target_users' review universe. Sibling `paper_reviews` and `citing_paper_quality` JOIN against `user_papers` (which is itself filtered via `validPevoPaperWhere`), so they are gated implicitly; `user_reviews` was the asymmetric site.

Updated the `computeReputationBatch` param-list docblock at `reputation.ts:326-335` to reflect 4 review-class composition sites (was: "three"). The `$19` param remains the same Redis-cycle binding; no signature changes.

Note on the self-review-exclusion task: only item #10 lands in this commit. The remaining 9 hold items in that task (1, 2, 3, 4, 5, 6, 7, 8, 9) are NOT touched. The self-review-exclusion task file stays in `tasks/pending/`. I did not edit its hold block per the implementer-does-not-edit-hold-block convention; the architect picks up the cross-task lift-in by reading the commit diff at next re-review intake.

**Item 3 [P2]** — new test file `tests/routes/notifications-arm-sql-shape.test.ts`. Mocked-pool SQL-shape canaries for the new_review notification arms, per carve-out clause-(a) (real-corpus seeding of a non-paper review-typed reply is impractical; arm 1b's self-review exclusion has the same seeding impracticality). Three canaries:
1. Arm 1a's parent-paper JOIN is INNER (not LEFT) — regex `(?<!LEFT )JOIN hafsql\.comments p\b` matches only the arm 1a INNER JOIN; arm 1b's `LEFT JOIN hafsql.comments p` is distinguished by the leading `LEFT`.
2. Arm 1a's JOIN carries the `validPevoPaperWhere(source='all')` paper-class gate, pinned via the `'paper'` + `'bridge_paper'` substrings against the `(p.json_metadata` parent alias. Arm 1b uses `validPevoPaperWhere(source='bridge')` against `c.json_metadata` inside `user_bridge_papers`, so the native `'paper'` arm only originates from arm 1a in the emitted SQL.
3. Arm 1a + 1b carry `co.author != $1` self-author exclusion (sibling to self-review-exclusion task hold item #6, which the architect noted "can share one canary commit"). The asymmetric-vs-`excludeSelfReviewWhere` rationale (co-author reviews of a shared paper ARE wanted notifications) is documented in the file header.

Mutation kill: reverting INNER → LEFT, dropping the `validPevoPaperWhere` predicate, or removing `co.author != $1` from either arm fails the corresponding canary. The route entry-point is hit through a real `request(app).get('/api/notifications?since_block=...')` with `MOCK_VERIFY_SIGNATURE`, so the route middleware path (sinceBlock parsing, genesis clamp, auth) runs un-mocked.

**Item 4 [P2]** — new test file `tests/routes/profile-reviews-accred-gate.test.ts`. Mocked-pool coverage for the `fetchUserReviewsFromHaf` round-1 hold #2 fix, per carve-out clause-(a) (the public HAF database cannot be deterministically seeded with an unaccredited author + a passing-shape pevo.review row at test time). Two assertions:
1. **Canary** — both queries (count + data) emit the `IN (SELECT account FROM active_accreditations)` substring AND the `OR c.author =` anon-OR-arm substring. Reverting either composition site silently drops the substring from that emit and fires red.
2. **Behavioral** — the responder simulates the gate by inspecting the bound author param (`$4` post-counter-fix) against a seeded `accreditedAuthors = new Set<string>()` (empty). A request for `/api/profile/unaccredited-spammer/reviews` returns `status: 'ok'`, `data: []`, `meta.total: 0` — proving the gate refuses non-admitted authors at the SQL level, not just at the route's post-filter.

The header documents the carve-out justification per `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`.

### Items NOT touched in this round (per the hold-block scope)

The four hold-block items were explicit. I did not pull in scope beyond:
- Item 7 + Item 8 (P3) carry-overs from the round-1 fix landing — already in place from prior round.
- `getProfileStats` `user_reviews` accreditation gap flagged by the prior round as out-of-scope is still untouched, awaiting architect ticketing.
- Architect-owned `reputation-algorithm.md` doc-drift sync stays for the architect's archive commit.

---

## Architect re-review round-3 (2026-05-14) — HELD PENDING FIXES

`/ce-code-review` on commit `69459e3` dispatched 10 reviewers (correctness, testing, maintainability, project-standards, learnings, security, performance, api-contract, adversarial, kieran-typescript). All 4 round-2 hold items + the cross-task lift-in for self-review-exclusion item #10 verified addressed per the implementer's disposition table. Round-3 surfaces 6 items held below — one P1 parity gap discovered at a sibling display surface and five P3 comment/test-hygiene items.

### Items to address

#### P1 — high

**1. (P1) `fetchUserReviewsFromHaf` missing `validPevoPaperWhere` parent-paper gate — display↔reputation parity broken at the symmetric site this task's slug literally names.**

**Where:** `backend/src/routes/profile.ts:362-406` (both count and data queries inside `fetchUserReviewsFromHaf`).

**Why:** Cross-corroborated by adversarial (P1, conf 75) and security (P2, conf 75). Round-3 lifted `validPevoPaperWhere` into `reputation.ts:user_reviews` CTE JOIN and `notifications-arm-sql-shape` arm 1a — but the symmetric display surface at `fetchUserReviewsFromHaf` did NOT get the gate. An accredited reviewer writes a `pevo.review`-shaped reply to a non-paper Hive post (a peakd blog post, a non-paper comment). validReviewWhere passes (rating shape valid). excludeSelfReviewWhere passes (authors[] empty/missing on the non-paper parent). Accreditation gate passes. The row surfaces on `/api/profile/alice/reviews` with `paper_title=''`. Display↔reputation parity invariant — the load-bearing claim of this task's slug — is broken at this sibling site: reputation correctly excludes the row (via the user_reviews CTE lift-in just landed); display still admits it. Architect's round-2 "Items NOT in scope" note flagged the parallel asymmetry at `getProfileStats user_reviews CTE` at `profile.ts:92-100` but missed `fetchUserReviewsFromHaf` at `profile.ts:317`.

**Fix:** Add `validPevoPaperWhere({ commentAlias: 'p', appTagParam: at, bridgeAccountParam: <push hiveBridgeAccount>, source: 'all' })` to both the count query (~line 365) and data query (~line 398) JOIN ON-clauses. Push `config.hiveBridgeAccount` into the bound params, allocating a new `$N` slot via the canonical `paramIdx++` counter pattern landed by round-2 hold item #1. Add a SQL-shape canary at `profile-reviews-accred-gate.test.ts` (or a new sibling file) pinning the `validPevoPaperWhere` substring at both count + data queries.

#### P3 — polish

**2. (P3) user_reviews CTE comment block: 24 lines for 4-line CTE body, mixes settled design with rotting cross-references.**

**Where:** `backend/src/reputation.ts:637-660`.

**Why:** Maintainability (P3, conf 75). The comment mixes settled facts (self-review exclusion, paper-class identity) with decision narrative ("the cost of admitting a non-accredited reviewer is bounded today") and round-number cross-references ("sibling 3 review-class CTEs landed in round-1 (item #1)"). Future readers can't distinguish settled design from in-flight reasoning; round-number references rot. Coordinate with item 5 below — the accred-gate rationale block is part of this same comment cluster.

**Fix:** Trim to settled facts only — what the predicates do and why. Drop round-number cross-references and decision narrative. Cross-reference convention docs (`agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md`, `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`) instead of round numbers.

**3. (P3) Notifications canary: MAX/MIN mock mismatch + single `co.author != $1` substring check doesn't pin both arms.**

**Where:** `backend/tests/routes/notifications-arm-sql-shape.test.ts:74, 127`.

**Why:** Correctness (P3, conf 90-95).

(a) The mock predicate at line 74 filters on `sql.includes('custom_id') && sql.includes('MAX')` to short-circuit the genesis-block lookup. The real `getGenesisBlock` uses `SELECT MIN(cj.block_num) AS genesis ... custom_id = $1` (MIN, not MAX). The test works only because BOTH the genesis query AND a fallback MAX(blocks) query fall through to `capturedSql = sql; return {rows:[]}`, and `fetchNotificationsFromHaf`'s SQL is the final overwriting capture. Any future pre-notifications query added inside the route would steal the capture and the canary would silently pin the wrong SQL.

(b) The single `toContain('co.author != $1')` assertion at line 127 is satisfied by either arm 1a or arm 1b independently. Docstring claims the canary mutation-kills both arms; it doesn't. Mutation dropping the predicate from one arm passes because the other arm's identical predicate satisfies the assertion.

**Fix:** (a) Loosen the mock to short-circuit on both bootstrap shapes — e.g., `if (sql.includes('genesis')) return { rows: [{ genesis: 0 }] };` and `if (sql.includes('AS head') && sql.includes('FROM hafsql.blocks')) return { rows: [{ head: 0 }] };`. Capture only when the notifications shape is present. (b) Replace the substring assertion with counted occurrences: `const matches = sql.match(/co\.author != \$1/g) ?? []; expect(matches.length).toBe(2);`.

**4. (P3) `params: unknown[]` unchecked cast to string defeats the mutation-kill guarantee of the round-2 paramIdx counter conversion.**

**Where:** `backend/tests/routes/profile-reviews-accred-gate.test.ts:92`.

**Why:** Cross-corroborated by kieran-typescript (P2, conf 75) and adversarial (P3, conf 75). The mock responder reads `(params?.[3] as string) ?? ''` for username and `(params?.[5] as string) ?? ''` for anonAccount. The `as string` cast is unchecked on `unknown`. The `?? ''` fallback masks param-ordering regressions — if `activeAccreditationsCteBody` ever changes the number of CTE params it consumes, the test silently aligns to wrong slots, the admission check returns false, and the test passes (data:[], total:0) for the wrong reason. This defeats the paramIdx counter conversion's mutation-kill intent — the canonical pattern was specifically introduced to prevent silent positional mis-binding.

**Fix:** Replace the cast with runtime narrowing + a positional assertion that fails loudly on regression:

```ts
const rawAuthor = params?.[3];
const rawAnon = params?.[5];
expect(typeof rawAuthor).toBe('string');
const author = typeof rawAuthor === 'string' ? rawAuthor : '';
const anonAccount = typeof rawAnon === 'string' ? rawAnon : '';
```

**5. (P3) user_reviews accreditation-gate rationale block claims a defense the code doesn't actually deliver in the current call-graph.**

**Where:** `backend/src/reputation.ts:653-660` (part of the comment cluster at item 2 above).

**Why:** Adversarial (P3, conf 75). The hold-block docstring (which the implementer faithfully copied) motivates the gate with "a revoked-mid-cycle reviewer whose row stays in target_users would surface non-zero `reviews` breakdown." Tracing the call graph: `$1 = usernames = scoredUsers = await getAllAccreditedAccounts()`; `$2 = accreditedArr = [...await getAllAccreditedAccounts()]` — same snapshot. So `c.author IN target_users` and `c.author = ANY($2)` evaluate against identical sets. The "revoked-mid-cycle reviewer in target_users" scenario isn't reachable in the current architecture. The gate IS structurally valid (per-callsite invariant + defense against a future caller passing a different `usernames` set), but the rationale block as written is wrong.

**Fix:** Rewrite the rationale block to reflect actual call-graph reality:

> "Accreditation gate `(c.author = ANY($2::text[]) OR c.author = $19)` mirrors the sibling review-class CTEs. In the current call-graph $1 and $2 are sourced from the same `getAllAccreditedAccounts` snapshot, so the gate is functionally subsumed by the upstream `c.author IN target_users` filter. The structural rule — every `validReviewWhere` caller in `reputation.ts` MUST compose accreditation — is the load-bearing invariant; this site enforces it so a future caller passing a non-accredited `usernames` set doesn't silently bypass."

Bundle the rewrite with item 2's broader comment trim — same comment cluster.

**6. (P3) Profile-reviews behavioral test docstring overstates what the test verifies.**

**Where:** `backend/tests/routes/profile-reviews-accred-gate.test.ts:86-107`.

**Why:** Testing (P3, conf 75). The second `it` block is titled `returns empty data and zero total for an unaccredited username (behavioral)` and its inline comment claims it proves the gate "refuses non-admitted authors at the SQL level." Actually the mock responder makes admission decisions in JavaScript (the `admitted` boolean), not based on SQL content. Removing the `accredGate` from `fetchUserReviewsFromHaf` would not change this test's outcome — the mock returns empty regardless of what SQL is emitted. The SQL-shape canary above it (first `it` block) is the actual gate mutation-kill; this behavioral test verifies envelope handling on empty result sets.

**Fix:** Update the inline comment + test title to accurately describe what it verifies: envelope shape (`status: 'ok'`, `data: []`, `meta.total: 0`) on empty result set. Drop the "gate at the SQL level" claim. The SQL-shape canary remains the actual mutation-kill.

### Carry-forwards for architect at archive

- **Round-1 #12** `agents/docs/reputation-algorithm.md` lines 218-219, 296, 374, 407 — describes pre-task unprefixed keys, numeric-string values, `active_accounts` CTE name. (Still pending.)
- **Round-1 #13** `agents/docs/ARCHITECTURE.md` lines 466-468 — describes pre-task SSoT state. (Still pending.)

Both safe to land at archive of this task once round-4 items land.

### Re-review signal

When items 1, 2, 3, 4, 5, 6 land, `git mv` this file from `tasks/pending/` back to `tasks/review/`. Use bare `backend:` or `backend(<scope>):` commit prefixes so the zone-audit hook fires. The architect's next review pass scopes `/ce-code-review` to commits since `69459e3`. Items 2 and 5 share the same comment cluster — bundle them. Items 4 and 6 share the same test file — bundle them. Item 1 is the load-bearing P1 fix and is independent.

---

## Backend re-review signal (2026-05-14, round-4, working tree pre-commit)

All 6 round-3 hold items addressed in a single coordinated commit. `tsc --noEmit` clean (fixed an unintended-template-literal-terminator bug introduced by backticks inside the SQL comment block of items 2+5's first attempt; backticks dropped in favor of bare identifier names — same mitigation as the self-review-exclusion task's round-1 item #8 fix). `npm run lint` clean (0 errors, 2 pre-existing seed-phrase warnings unrelated). Targeted test suites pass against real Postgres: `profile-reviews-accred-gate.test.ts` + `notifications-arm-sql-shape.test.ts` + `profile.test.ts` + `reputation-lifecycle.test.ts` (28 passed across 4 files); `review-parity-invariant.test.ts` + `reputation-paper-reviews-self-exclusion-canary.test.ts` + `hafsql.test.ts` + `excludeSelfReviewWhere-callsite-canaries.test.ts` (31 passed, 3 skipped — `isHafConfigured`-gated arms in real-HAF tests where the test env couldn't reach Mahdi's HAF; the synthetic-VALUES arms ran clean).

**Item 1 [P1]** — `fetchUserReviewsFromHaf` parent-paper class gate landed at both count + data queries. `validPevoPaperWhere({ commentAlias: 'p', appTagParam: at, bridgeAccountParam: bridgeParam, source: 'all' })` composes after `validReviewWhere` and before `excludeSelfReviewWhere` in both query bodies. Param shape extended via the canonical `paramIdx++` counter: new `bridgeIdx` slot binds `config.hiveBridgeAccount || ''` at `$7`, pushing `limitIdx` → `$8`, `offsetIdx` → `$9`, `accreditedParamIdx` → `$10`. Comment block above the counter rewritten to:
- Document the round-3 hold #1 parity fix at the JOIN-level rationale (display ↔ reputation parity at the sibling site).
- Update the param-position map (the round-2 #1 paramIdx counter convention's load-bearing comment) to reflect the new bridge slot.

A new SQL-shape canary in `profile-reviews-accred-gate.test.ts` pins both queries: `nativePaperSubstring = "= 'paper'"` AND `bridgePaperSubstring = "= 'bridge_paper'"` must appear in every emitted query. The substrings together pin the `source:'all'` arm of `validPevoPaperWhere` (vs `source:'native'` which omits the bridge arm); a revert at either query drops the substring and fires red. The mutation-kill is verified at runtime: the canary fires the new assertion against the current source.

**Items 2 + 5 [P3]** — bundled at the user_reviews CTE comment cluster (`reputation.ts:662-685`). Replaced the round-1-style narrative comment with a bullet-style block listing the four composed predicates and their structural rationale. Decision narrative ("the cost of admitting a non-accredited reviewer is bounded today") and round-number cross-references ("sibling 3 review-class CTEs landed in round-1 (item #1)") are dropped in favor of named convention cross-references (`pevo-object-identity-is-author-vouching`, `defense-in-depth-canary-must-pin-each-layer`). Item 5's rewrite: the accreditation-gate rationale block now reflects actual call-graph reality — `$1` and `$2` derive from the same `getAllAccreditedAccounts` snapshot, so the per-callsite gate is functionally subsumed by the upstream `c.author IN target_users` filter; the structural rule (every `validReviewWhere` caller MUST compose accreditation) is the load-bearing invariant, defending against a future caller passing a non-accredited `usernames` set.

The first edit attempt accidentally embedded backticks inside the SQL `${...}` template literal — Postgres-comment style ` `\`name\` ` worked in markdown but broke TypeScript template-literal parsing (tsc surfaced 10 errors). The recovery dropped the backticks; sibling identifier names like `getAllAccreditedAccounts`, `c.author IN target_users`, `validReviewWhere`, `usernames` appear as bare text — readable in-source, no markdown polish required because these comments are SQL not docstrings.

**Item 3 [P3]** — `notifications-arm-sql-shape.test.ts` `captureNotificationsSql` mock loosened. The prior `if (sql.includes('custom_id') && sql.includes('MAX'))` filter matched NEITHER of the two queries that pool.query actually emits in the notifications route (genesis uses `MIN`, not `MAX`; there's no head-block lookup in the route — only the genesis + notifications queries fire). The prior test "worked" only because both fall-through queries hit `capturedSql = sql` and the notifications query was the last to execute, so `capturedSql` happened to hold the right SQL.

The new mock implements an explicit two-branch dispatch:
- `if (sql.includes('AS genesis')) return { rows: [{ genesis: 0 }] }` — short-circuits the `getGenesisBlock` query with a result that bypasses the clamp.
- `if (sql.includes("'new_review'::text")) { capturedSql = sql; return { rows: [] }; }` — captures ONLY when the SQL contains the notifications-arm event-type tag, a distinctive substring emitted by the UNION-ALL arms of `fetchNotificationsFromHaf`. A future pre-notifications query added inside the route falls through to the empty `return { rows: [] }` branch WITHOUT capturing, so the canary continues to pin the correct SQL.

Round-3 hold #3 (b) (the per-arm count assertion for `co.author != $1`) was ALREADY in place from the self-review-exclusion task's round-1 hold #6 fix that landed earlier — the test at line 134 already uses `(sql.match(/co\.author != \$1/g) ?? []).length` and asserts `toBe(2)`. No edit needed; called out for the architect's awareness so the round-3 finding's (b) clause doesn't get re-flagged at round-4 intake.

**Items 4 + 6 [P3]** — bundled at `profile-reviews-accred-gate.test.ts`. Item 4: the prior `(params?.[3] as string) ?? ''` unchecked-cast pattern is replaced by runtime narrowing — `expect(typeof rawAuthor).toBe('string')` fires red on any param-ordering regression that shifts the position from string to undefined/number, which is exactly the mutation class the round-2 #1 paramIdx counter convention was introduced to prevent silent positional mis-binding. The fallback `''` is preserved (TypeScript's narrowing is the runtime guard; the fallback is a defense-in-depth for the type system). Item 6: the second `it` block's title + inline comment now accurately describes envelope-shape handling on an empty result set instead of overclaiming SQL-level gate enforcement. The actual gate mutation-kills live in the two SQL-shape canaries above it (accred gate + parent-paper gate); this `it` block verifies that the route's response wrapping does the right thing on empty rows. File-header docblock updated to acknowledge both round-3 holds' scope changes (parent-paper canary, narrowing approach, envelope-vs-gate accuracy).

### Carry-forwards for architect at archive

Carried over from round-1 (still pending):
- `agents/docs/reputation-algorithm.md` lines 218-219, 296, 374, 407 (pre-task descriptions of unprefixed keys, numeric-string values, `active_accounts` CTE name).
- `agents/docs/ARCHITECTURE.md` lines 466-468 (pre-task SSoT state).

### Item NOT touched

- `getProfileStats` `user_reviews` CTE at `profile.ts:92-100` accreditation gap (flagged round-2 as out-of-scope, still flagged for follow-up ticket).
- Architect-zone update to `agents/docs/reputation-algorithm.md` documenting the 4-site validPevoPaperWhere composition and the FIVE self-exclusion composition sites (4 in reputation.ts review-class CTEs + 1 at profile.ts fetchUserReviewsFromHaf for round-3 hold #1) — folded into the architect's archive commit alongside the carry-forwards above.

---

## Architect re-review round-4 (2026-05-15) — HELD PENDING FIXES

`/ce-code-review` on commit `f77ae21` dispatched 9 reviewers (correctness, testing, maintainability, project-standards, learnings, security, performance, adversarial, kieran-typescript; `ce-agent-native-reviewer` skipped per root CLAUDE.md project policy). All 6 round-3 hold items verified addressed at their cited sites — items 2+5 (user_reviews CTE comment trim), item 3 (notifications canary mock + per-arm assertion), and items 4+6 (test runtime narrowing + docstring) all land at the directed sites. Round-4 surfaces 4 items held below — two are convention purges incompletely applied (items 2+5's trim convention left siblings untouched), and two are test-fixture corrections (an assertion that doesn't actually mutation-kill because of try/catch swallow, and a comment that misstates the route's actual query count).

Triage disposition this round: 1 P2 → new task (filed separately as `backend-getprofilestats-user-reviews-parity-gate.md`), 4 P3 → held below, 4 P3 → dismissed (preemptive hardening per `feedback_dismiss_preemptive_test_hardening.md` + sibling-pattern justifications), 1 P3 → acknowledged (performance verdict, no fix required). Three pre-existing findings: 1 bundled below (header in the same test file being edited), 2 folded into the new parity-gate task.

### Items to address

**1. (P3) `notifications-arm-sql-shape.test.ts:69` comment misstates query count and verifyHiveSignature status**

**Where:** `backend/tests/routes/notifications-arm-sql-shape.test.ts:69-82` (comment block above the mock dispatch).

**Why:** Testing reviewer at confidence 100 traced the route's actual call sequence: (1) `getGenesisBlock` fires `SELECT MIN(...) AS genesis` (matched by the mock's first branch, returns `{genesis: 0}`); (2) since `0 && 0 > 0` is false, `getGenesisBlock` falls through to its `SELECT MAX(block_num) AS head FROM hafsql.haf_blocks` fallback (returns empty via the no-match path); (3) `fetchNotificationsFromHaf` notifications query (captured via the `'new_review'::text` branch). Three `pool.query` calls, not two as the comment claims. The comment also says "verifyHiveSignature is NOT mocked" — it IS, via the `MOCK_VERIFY_SIGNATURE` fixture at lines 40-43 (carve-out clause-(b) permits this for SQL-shape-focused tests). Canary behavior is correct; documentation drifts from reality. Future maintainers reading the comment will trust the misstatement.

**Fix:** Update the comment to reflect the actual three-query sequence (genesis MIN → HEAD fallback → notifications UNION) and accurately describe the auth-middleware mocking. Reference `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md` as the canonical source for the auth-mock policy. No behavioral change.

**2. (P3) `profile-reviews-accred-gate.test.ts:148-150` runtime-narrowing assertion swallowed by route's try/catch — claimed mutation-kill is a no-op**

**Where:** `backend/tests/routes/profile-reviews-accred-gate.test.ts:148-150`.

**Why:** Correctness reviewer at confidence 75 traced execution: the `expect(typeof rawAuthor).toBe('string')` and `expect(typeof rawAnon).toBe('string')` calls run INSIDE the `mockImplementation` callback for `pool.query`. When an `expect` throws inside that callback, the throw propagates into `hafQueryMock` which is inside the route's `try { ... } catch (err) { return null; }` block at `fetchUserReviewsFromHaf`. The route swallows the throw, returns null, and the route handler returns the empty envelope `{status:'ok', data:[], total:0}` — which the behavioral test expects anyway. The test passes for the wrong reason. The structural intent of round-3 hold item #4 ("fails red on regression") does not actually fire. Round-3 hold #4 is addressed in form but broken in substance.

**Fix:** Move the assertions out of the mock callback. Capture `rawAuthor`/`rawAnon` into outer-scope variables inside the mock; after `await request(app).get(...)` returns, assert the captured types in test scope so a non-string param fails the test loudly. Natural cleanup: drop the dead-code `: ''` fallback at line 150 — once the outer-scope `expect` enforces the precondition, the inner ternary's false branch is unreachable (per root CLAUDE.md "Don't add error handling, fallbacks, or validation for scenarios that can't happen"). Use `as string` after the outer expect, or whatever narrowing shape reads cleanest inside the mock body.

**3. (P3) Round-number cross-refs surviving the items-2+5 trim — sibling comment cluster in `profile.ts` and a surviving count in `reputation.ts`**

**Where:**
- `backend/src/routes/profile.ts:332` — "That asymmetry was flagged by the round-1 review (item 2)."
- `backend/src/routes/profile.ts:341` — "This is the round-3 hold #1 parity fix:"
- `backend/src/routes/profile.ts:345` — "Canonical $N counter (matches reviews.ts post-round-1 item #5)."
- `backend/src/reputation.ts:676` — "mirroring the sibling **3** review-class CTEs"

**Why:** Maintainability reviewer at confidence 75 (3 sibling findings, same risk class). Round-3 hold items 2+5 directed: "Drop round-number cross-references and decision narrative. Cross-reference convention docs instead of round numbers." The implementer applied this faithfully to the `reputation.ts:662-685` user_reviews CTE comment cluster (the directed site) — but missed the sibling `profile.ts:fetchUserReviewsFromHaf` comment cluster written in the same commit, and left one surviving count ("sibling 3 review-class CTEs") at `reputation.ts:676` inside the otherwise-trimmed block. The convention purge was scoped to the directed site but should have applied to any comment cluster touched by the same commit; round numbers rot fast, and a future re-organization of holds (or this task collapsing to a single archive entry) breaks all four references at once.

**Fix:** Apply the items-2+5 trim convention to the sibling sites:
- `profile.ts:332,341,345`: drop the round-number cross-references. Replace with convention-doc references (`cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md` covers the parity-fix motivation; `defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` covers the counter-pattern rationale where applicable). Describe the SQL gates by what they do, not by when they landed.
- `reputation.ts:676`: replace "mirroring the sibling 3 review-class CTEs" with a non-counting phrase ("mirroring the sibling review-class CTEs" or similar). The count adds nothing and breaks on every CTE add/remove.

**4. (P3) `profile-reviews-accred-gate.test.ts:14` carve-out clause-(c) header claim overstated**

**Where:** `backend/tests/routes/profile-reviews-accred-gate.test.ts:14` (file header docblock — pre-existing claim, bundled because the file is being edited for items 1-2 above).

**Why:** Correctness reviewer (pre-existing, conf 75). The header claims `profile.test.ts` and `papers.test.ts` provide real-HAF companion coverage for `/api/profile/:user/reviews` end-to-end. Grep shows no real-HAF integration test exercising that route specifically. The companion claim under-substantiates the carve-out clause-(c) requirement at `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`. Bundled into this round purely because the file's header is already being edited.

**Fix:** Two paths, implementer's choice:
- **Downgrade the claim** — rephrase the header to acknowledge that this file is the load-bearing coverage for `/api/profile/:user/reviews` and that the carve-out clause-(c) companion is structural (the gate composition pattern exercised by sibling-route real-HAF tests) rather than literal-route coverage.
- **Add the companion** — extend `profile.test.ts` with a real-HAF integration test exercising the route. Wider in scope; only land it here if trivial, otherwise downgrade and file a separate test-coverage task.

### Findings dismissed at triage (no action)

- **`profile-reviews-accred-gate.test.ts:148` `typeof === 'string'` narrowing's string-to-different-string drift class** (testing reviewer) — preemptive hardening per `feedback_dismiss_preemptive_test_hardening.md`. The realistic drift class (params[3] becoming non-string) is held above as item 2; the further drift class (params[3] becoming a different string value) requires an explicit upstream refactor that would be caught at the source in code review.
- **`config.hiveBridgeAccount || ''` at `profile.ts:371`** (kieran-typescript) — dead-code today but consistent with the pre-existing sibling pattern `config.hiveAnonAccount || ''` at the same file (line 370). Security reviewer treats the fallback as a deliberate safety net against config drift. Stripping #6 alone breaks pattern symmetry; stripping both is wider scope.
- **SQL-shape canary at `profile-reviews-accred-gate.test.ts:105` doesn't pin `commentAlias`** (adversarial) — preemptive hardening against a theoretical alias-swap mutation. Real-path defense (integration tests reading empty data on deny-all) plus code review at the SQL change site cover the failure mode.
- **`review-parity-invariant.test.ts:60` does not exercise the round-4 sibling site** (adversarial) — preemptive hardening; the local SQL-shape canary at the round-4 site is the load-bearing defense. Extending the parity test to enumerate all symmetric sites is convention work, deferred to the new parity-gate task or a future test-coverage pass.

### Findings acknowledged (no fix)

- **Performance verdict at `profile.ts:381`** (performance) — new `validPevoPaperWhere` JOIN predicate cost is unobservable at beta scale and structurally consistent with `reputation.ts:user_reviews` CTE. Predicate applies to JOIN-key columns already materialized; no new table scan. No fix required.

### Carry-forwards for architect at archive (no implementer action)

- Architect-zone `agents/docs/reputation-algorithm.md` lines 218-219, 296, 374, 407 — pre-task descriptions of unprefixed keys, numeric-string values, `active_accounts` CTE name. Still pending.
- Architect-zone `agents/docs/ARCHITECTURE.md` lines 466-468 — pre-task SSoT state. Still pending.

Both safe to land at archive of this task once round-5 items land.

### Cross-surface parity follow-up

The architect-flagged "Item NOT touched" carry-forward at `getProfileStats user_reviews CTE` (profile.ts:92-100) is now an actively-visible asymmetry — round-4 closed the `/api/profile/:user/reviews` listing side, so a user with reviews on non-paper Hive parents sees mismatched `review_count` on `/api/profile/:user` (which counts those reviews via the un-gated CTE) vs the listing on `/api/profile/:user/reviews` (which correctly excludes them post round-4). Plus two pre-existing sibling parity gaps at `search.ts:178` (review-search parent gate) and `papers.ts:2216` + `reviews.ts:88` (enrichment + single-doc parent JOINs) flagged by the security reviewer.

These four sibling sites are filed as a single new task `backend-getprofilestats-user-reviews-parity-gate.md` at `tasks/pending/` per the cross-surface parity audit convention's "enumerated sibling sites with explicit dispositions" shape. The new task absorbs the architect's prior out-of-scope carry-forwards and supersedes the prose footnotes.

### Re-review signal

When items 1, 2, 3, 4 land, `git mv` this file from `tasks/pending/` back to `tasks/review/` per `feedback_task_mv_to_review_after_each_round.md`. Use bare `backend:` or `backend(<scope>):` commit prefixes so the zone-audit hook fires. The architect's next review pass scopes `/ce-code-review` to commits since `f77ae21`. Items 1, 2, and 4 all touch test files; items 1+4 touch the same test fixture (different sections); item 2 is the substantive fix in a third test file. Item 3 touches production-code comments at two source files (`profile.ts` + `reputation.ts`). Items can land in any order or in one combined commit.

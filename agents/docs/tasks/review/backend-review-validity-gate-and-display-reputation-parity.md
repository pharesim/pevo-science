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

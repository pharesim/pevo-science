# BACKEND-HAF-OUTAGE-TRANSLATION-AUDIT-ACROSS-ROUTES — extend `HafQueryError` / 503-retriable pattern to all HAF-touching routes

**Owner:** Backend Agent
**Created:** 2026-05-19 (architect, surfaced by combined `/ce-code-review` of `backend-profile-papers-supersession-parity` round-2 — cross-corroborated by correctness, adversarial, reliability)
**Priority:** P2

## Problem

`backend-profile-papers-supersession-parity` round-2 (commit `a419b1d`) extended the `HafQueryError` translation + 503-retriable response pattern to one HAF-touching site on `/api/profile/:username/papers` (the `getAccreditedOrcidsByAccount` fetch inside the `hafCache.getOrSet` callback). The architect's hold scoped item 3 narrowly; backend's signal block explicitly flagged the asymmetry as a follow-up: *"The enrichment also makes HAF queries (`getAccreditedSet`, `getAllAccreditedAccounts`, `getReputationScores`). Those don't currently throw `HafQueryError` directly, so if they fail with a raw pg error, the central 500 handler still picks them up. Tightening those to also translate to `HafQueryError` is a separate follow-up..."*

Cluster review surfaced the asymmetry as three different observable responses on the same `/api/profile/:username/papers` route during a HAF outage, depending on which sub-query fails first:

| Site | Pre-fix | Post-fix | Failure response |
|---|---|---|---|
| `getAccreditedOrcidsByAccount` (cache-miss callback) | raw error → 500 | wrapped → `HafQueryError` → 503 retriable | **503 retriable** ✓ |
| `fetchUserPapersFromHaf` (internal try/catch swallows → null) | unchanged | unchanged | **200 OK with empty rows** ✗ |
| `getAllAccreditedAccounts` (enrichment Promise.all) | raw pg → 500 | unchanged | **500 INTERNAL_ERROR** ✗ |

The asymmetry isn't unique to `/api/profile/:username/papers` — it's likely systemic across PEvO's HAF-touching routes. Each route's error-translation patchwork evolved organically and the existing sibling-route consistency stops at "central error middleware emits 500 by default."

## Goal

Audit all HAF-touching routes for `HafQueryError` translation coverage; ensure each HAF query (direct or via helper) maps a runtime failure to `HafQueryError` so the central error middleware emits the consistent 503 SERVICE_UNAVAILABLE with `retriable: true` envelope. Frontend SPA's retry logic keys on `error.code === 'SERVICE_UNAVAILABLE'` + `details.retriable`; the asymmetry breaks retry behavior and operator triage signal.

## Acceptance

1. **Discovery audit** — enumerate every HAF-touching site across `backend/src/routes/` + `backend/src/lib/` + `backend/src/accreditation.ts`. Catalog per-site behavior:
   - Site (file:function)
   - Failure-throw shape today (raw pg error / `HafQueryError` / swallowed-to-null / wrapped-in-other-error-class)
   - Response shape today on failure (500 / 200-with-empty / 503 / etc.)
   - Whether translation to `HafQueryError` is appropriate or whether the swallow-to-empty pattern is intentional (e.g., for fetch-many endpoints where missing data is normal).

2. **Translation pattern documentation** — write a `agents/docs/solutions/conventions/haf-error-translation-pattern.md` (or similar) capturing the prescribed shape:
   - Where to wrap (immediately around the pg-throw site, or at the route handler boundary)
   - When to swallow-to-empty vs translate-to-503 (criteria)
   - How the central error middleware consumes `HafQueryError` and emits the wire envelope

3. **Code remediation** — apply the pattern to all sites the discovery audit flagged as inconsistent. Preserve intentional swallow-to-empty behavior where it's the correct contract (e.g., a "papers by user" query returning empty rows for a non-existent user is correct, not a HAF outage).

4. **Tests per touched route** — add a HAF-outage canary per route that mocks pg rejection at the HAF query and asserts 503 retriable response shape. Use the established mocked-pool carve-out per CLAUDE.md "Running Tests" carve-out.

5. **Mutation-kill verification** — each new canary should fail red if the corresponding try/catch is reverted.

## Out of scope

- Frontend SPA retry-logic changes. Today's SPA keys on `details.retriable` correctly; this task just ensures the backend emits the signal consistently.
- Circuit-breaker / backoff infrastructure. HAF outages are typically operator-resolved (HAF node restart, network restoration); per-route 503 retriable is the right wire contract for the SPA-side retry without server-side breaker work.
- `getReputationScores` and similar long-cache helpers that have their own degraded-mode behavior (returning last-known cached values when HAF is unavailable). Those are intentional behavior, not regressions.

## Cross-references

- Cluster review 2026-05-19 (architect-context): correctness low/70 + adversarial F3 medium/85 + reliability R1 medium/85 + R2 low/75 = cross-corroborated.
- `backend-profile-papers-supersession-parity.md` round-2 (commit `a419b1d`) — established the pattern at one site.
- `backend/src/db.ts` — `HafQueryError` definition.
- `backend/src/routes/papers.ts` — sibling route emitting 503 retriable for HAF outages on `/api/papers/:author/:permlink` (the template for the pattern).
- `backend/src/routes/profile.ts` — the route round-2 partially closed.

## Backend completion signal (2026-05-19)

### Discovery audit catalog

Every HAF-touching site enumerated below, columns: Site / Pre-fix throw shape / Pre-fix response on failure / Post-fix throw / Post-fix response / Notes.

| Site (file:function) | Pre-fix throw | Pre-fix response | Post-fix throw | Post-fix response | Notes |
|---|---|---|---|---|---|
| `papers.ts:fetchPaperDetailFromHaf` (GET /:author/:permlink) | HafQueryError | 503 retriable | unchanged | 503 retriable | Already translated round-2 of paper-detail task. |
| `papers.ts:fetchPaperDetailFromHaf` (POST /:author/:permlink/retract) | HafQueryError | 503 retriable | unchanged | 503 retriable | Shares fetcher with GET. |
| `papers.ts:fetchPaperDetailFromHaf` (GET /:author/:permlink/cite) | HafQueryError | 503 retriable | unchanged | 503 retriable | Shares fetcher with GET. |
| `papers.ts:fetchEnrichmentFromHaf` (GET /:author/:permlink/enrichment) | HafQueryError | 503 retriable | unchanged | 503 retriable | Already translated. |
| `papers.ts:fetchPapersFromHaf` (GET /api/papers) | swallow → null | 200 [] | unchanged | 200 [] | Listing — intentional swallow-to-empty (matches `disciplines.ts` listing pattern). |
| `papers.ts:isRetracted` (POST /retract internal helper) | swallow → false | downstream | unchanged | downstream | Defaults to "not retracted" on outage; conservative for the broadcast precondition. |
| `papers.ts:fetchHeadAuthorizedAuthors` | swallow → null + memoize | downstream | unchanged | downstream | Internal walker; failure propagates up to the wrapping `fetchPaperDetailFromHaf` HafQueryError throw. |
| `papers.ts:findCanonicalRoot` | swallow → null | downstream | unchanged | downstream | Internal walker; same as above. |
| `papers.ts:resolveContinuationChain` | swallow → [] (per-iter) | downstream | unchanged | downstream | Internal walker. |
| `papers.ts:computeChainCumulativeFromHaf` | swallow inside `resolveChainCumulativeAuthors` `try` → null | downstream fallback to head-meta | unchanged | unchanged | Intentional fall-through to head-meta projection. |
| `profile.ts:getAccreditationFromHaf` (GET /:username) | swallow → undefined → null | 200 "not accredited" | unchanged | unchanged | Same pattern as `accreditations.ts:fetchAccreditationStatusFromHaf` — outage cosmetically conflates with "not accredited", accepted cost. |
| `profile.ts:getProfileStats` (GET /:username) | swallow → zeros | 200 with zeros | unchanged | unchanged | Same accepted cost as above for the stats projection. |
| `profile.ts:fetchUserPapersFromHaf` (GET /:username/papers) | swallow → null | 200 [] | **HafQueryError** | **503 retriable** | **FIXED** — outage was indistinguishable from "no papers". |
| `profile.ts:getAccreditedOrcidsByAccount` call (route arm) | HafQueryError | 503 retriable | unchanged | 503 retriable | Already translated round-2 of supersession-parity task. |
| `profile.ts` enrichment Promise.all (`getAllAccreditedAccounts` etc.) | raw pg → 500 | 500 INTERNAL_ERROR | **HafQueryError** | **503 retriable** | **FIXED** — Promise.all wrapped; raw pg failures from the loud-fail helpers translate to retriable. |
| `profile.ts:fetchUserReviewsFromHaf` (GET /:username/reviews) | swallow → null | 200 [] | **HafQueryError** | **503 retriable** | **FIXED** — outage was indistinguishable from "no reviews". |
| `profile.ts` notification-preferences handlers | n/a (uses `getAppPool`, not HAF) | n/a | unchanged | n/a | Out of scope — application-DB, not HAF. |
| `reviews.ts:fetchReviewFromHaf` (GET /:author/:permlink) | swallow → null | 404 NOT_FOUND | **HafQueryError** | **503 retriable** | **FIXED** — outage was indistinguishable from "review does not exist". Sibling of `fetchPaperDetailFromHaf` template. |
| `comments.ts:paperExistsInHaf` (GET /papers/:a/:p/comments preflight) | swallow → null | 404 NOT_FOUND | **HafQueryError** | **503 retriable** | **FIXED** — outage was indistinguishable from "paper does not exist". |
| `comments.ts:fetchCommentsFromHaf` (GET /papers/:a/:p/comments listing) | swallow → null | 200 [] | unchanged | 200 [] | Listing — intentional swallow-to-empty after the existence-check has already passed. |
| `accreditation.ts:getAccreditedSet` (display-fed batch lookup) | swallow → empty Set | downstream zeros | unchanged | unchanged | Intentional safe-fail per existing helper docstring (display-fed; non-accredited rendering is correct). |
| `accreditation.ts:getAllAccreditedAccounts` | re-throws raw err | varies by caller | unchanged | unchanged | Already loud-fails per existing helper docstring (batch-fed). Callers responsible for HafQueryError translation. |
| `accreditation.ts:getAccreditedOrcidsByAccount` | re-throws raw err | varies by caller | unchanged | unchanged | Loud-fail per docstring. Translation now uniformly happens at every route caller. |
| `accreditation.ts:getAllEverAccreditedOrcidsWithStatus` | re-throws raw err | varies by caller | unchanged | unchanged | Loud-fail per docstring. |
| `accreditations.ts:fetchAccreditationsFromHaf` (GET /api/accreditations) | swallow → null → 200 [] | 200 [] | unchanged | 200 [] | Listing — intentional swallow-to-empty. |
| `accreditations.ts:fetchAccreditationStatusFromHaf` (GET /api/accreditations/:username) | swallow → null | 200 "not accredited" | unchanged | unchanged | Same as `profile.ts:getAccreditationFromHaf`. |
| `stats.ts:fetchStatsFromHaf` | swallow → null | 200 zeros | unchanged | unchanged | Periodic-refresh cache; route serves cached or zeros. Intentional degraded mode. |
| `disciplines.ts:fetchDisciplinesFromHaf` | swallow → null → [] | 200 [] | unchanged | 200 [] | Intentional. Listing endpoint. |
| `notifications.ts` route + `notification-queries.ts:fetchNotificationsFromHaf` | swallow → null | 200 empty events | unchanged | 200 empty events | Considered translating, rolled back: the SQL is a broad multi-CTE scan keyed on caller-supplied `sinceBlock` that legitimately hits `statement_timeout` on wide ranges (e.g. `since_block=genesis`). Translating would mis-classify "expensive query" as "outage" and amplify retry load. Existing real-HAF test `notifications.test.ts > events are sorted by block_num ascending` exercises this path. Docstring updated to explain. |
| `search.ts:searchFromHaf` (outer wrapper) | swallow → null | 200 [] | unchanged | 200 [] | Already has Promise.allSettled partial-degradation handling for `type=all`; total failure on `type=paper|review` collapses to 200 empty. Intentional per the partial-degradation event. |
| `search.ts:searchPapersFromHaf` / `searchReviewsFromHaf` (inner) | propagate up to `searchFromHaf` catch | downstream | unchanged | unchanged | See above. |
| `bridge.ts:checkExistingBridge` (POST /api/bridge/register) | discriminated `haf_unavailable` → 503 retriable | 503 retriable | unchanged | 503 retriable | Already translated. |
| `bridge.ts:checkExistingBridge` (GET /api/bridge/check) | discriminated → fail-open | 200 exists=false | unchanged | unchanged | Intentional fail-open per write-route-fail-closed/read-route-fail-open policy. |
| `reputation.ts:loadReputationScores` and similar long-cache helpers | swallow → cached values | downstream | unchanged | unchanged | Out of scope per task — intentional degraded mode. |
| `reputation-batch.ts` cycle scheduler | bail without advancing cycle | n/a (no HTTP route) | unchanged | n/a | Background batch; not a route surface. |
| `hafsql.ts:getGenesisBlock` | re-throws | downstream caller's catch | unchanged | unchanged | Internal helper, callers handle. |

### Code remediation summary

Translated at four sites (helpers re-throw `HafQueryError`; route handlers translate to 503 retriable):

- `backend/src/routes/profile.ts` — `fetchUserPapersFromHaf` throws; route `GET /:username/papers` outer catch already in place catches it (existing route-layer catch from round-2 of supersession-parity). Also wrapped the post-fetch enrichment `Promise.all` so `getAllAccreditedAccounts` / `getAccreditedOrcidsByAccount` / `getAllEverAccreditedOrcidsWithStatus` raw pg throws translate to `HafQueryError`.
- `backend/src/routes/profile.ts` — `fetchUserReviewsFromHaf` throws; route `GET /:username/reviews` new outer catch added.
- `backend/src/routes/reviews.ts` — `fetchReviewFromHaf` throws; route `GET /:author/:permlink` new outer catch added.
- `backend/src/routes/comments.ts` — `paperExistsInHaf` throws; route `GET /papers/:a/:p/comments` new outer catch added (covers both `paperExistsInHaf` and any future helper change in the route body).

Considered-and-rejected at one site:

- `backend/src/notification-queries.ts` + `backend/src/routes/notifications.ts` — initially translated, rolled back because the broad multi-CTE notifications query legitimately hits `statement_timeout` on wide `sinceBlock` ranges. Translating to 503 would mis-classify "expensive query" as "outage". Docstring updated.

### Tests + mutation-kill verification

New file: `backend/tests/routes/haf-outage-translation-canaries.test.ts` — six mocked-pool canaries:

| Canary | Mutation kill (verified) |
|---|---|
| GET /api/profile/:username/papers — fetchUserPapersFromHaf throw → 503 (SQL-discriminated to user-papers SELECT) | `sed throw -> return null` in `fetchUserPapersFromHaf` → fails red with 200 instead of 503 |
| GET /api/profile/:username/reviews — fetchUserReviewsFromHaf throw → 503 | `sed throw -> return null` in `fetchUserReviewsFromHaf` → fails red |
| GET /api/reviews/:author/:permlink — fetchReviewFromHaf throw → 503 | `git stash src/routes/reviews.ts` → fails red |
| GET /api/reviews/:author/:permlink — 0 rows → 404 (data-missing preserved) | passes pre and post fix |
| GET /api/papers/:author/:permlink/comments — paperExistsInHaf throw → 503 | `git stash src/routes/comments.ts` → fails red |
| GET /api/papers/:author/:permlink/comments — 0 rows → 404 (data-missing preserved) | passes pre and post fix |

Sibling coverage (already-existing canaries, unmodified):
- `backend/tests/routes/papers-haf-error-vs-not-found.test.ts` — four paper-detail-class canaries.
- `backend/tests/routes/profile-papers-supersession.test.ts` — `getAccreditedOrcidsByAccount` 503 canary.

Test run output (canaries + siblings, real Postgres/Redis):
```
Test Files  3 passed (3)
Tests       24 passed (24)
```

Real-HAF reviews/profile integration suites unchanged: `reviews.test.ts`, `profile.test.ts`, `profile-papers-cid-validate.test.ts`, `profile-reviews-accred-gate.test.ts`, `profile-stats-parity-gate.test.ts`, `profile-auth-bypass.test.ts` — 23 passed (23).

`comments.test.ts > returns both PEvO-authored and non-PEvO-authored replies by accredited scientists` failed during this session due to real-HAF `read ECONNRESET` flakes on the public testnet (pre-existing — confirmed by `git stash src/routes/comments.ts` reproducing the same flake under 404 instead of 503). Not a regression of this change; the flake is environment-side.

### [TODO Architect]

1. **Convention doc.** The task acceptance #2 asks for `agents/docs/solutions/conventions/haf-error-translation-pattern.md`. Per memory directive (`feedback_no_handwritten_learnings.md`), `agents/docs/solutions/` entries are written via `/ce-compound`, not by hand. The backend worker did NOT write the doc. Architect: invoke `/ce-compound` on the audit catalog + remediation pattern to produce the convention entry. Suggested anchor on stable behavioral symbols:
   - "Where to wrap" — at the helper's `catch (err)` re-throwing `HafQueryError`, NOT inside `pool.query` directly; the route catch then `instanceof`s.
   - "When to swallow vs translate" — translate when single-resource lookup (paper detail, review detail, paper-existence preflight, user-papers/reviews under a known username); swallow when the contract is "show what's there" (listings, stats, disciplines, accreditation lists), and especially when the SQL has caller-controlled wide scans like notifications.
   - "Helper contract" — accreditation.ts's `getAccreditedSet` (display-fed safe-fail) vs `getAllAccreditedAccounts` (batch-fed loud-fail) is the canonical asymmetric pair; document the rationale so future implementers pick the right helper.
   - "Wire envelope" — central `errorHandler.ts` does NOT auto-translate `HafQueryError` to 503; route-level `if (err instanceof HafQueryError)` is required. (Considered moving to central middleware; declined to keep per-route message control over the user-facing "X temporarily unavailable" string.)

2. **API contract files.** The newly-translated routes (`/api/profile/:username/reviews`, `/api/reviews/:author/:permlink`, `/api/papers/:a/:p/comments`) now return `503 SERVICE_UNAVAILABLE` with `details.retriable: true` on transient HAF outage. The contract files `agents/docs/api-contracts/profiles.md`, `reviews.md`, `papers.md` may need a status-code list update to enumerate 503 alongside the 200/404. Architect to verify and update if needed.

## Architect re-review (2026-05-20) — HELD PENDING FIXES:

The audit's intent ("single-resource lookups: outage ≠ missing data") is correct, but several integration gaps prevent the contract from being uniformly observable. Cross-corroborated findings from api-contract, adversarial, reliability, and maintainability personas.

1. **`backend/src/routes/comments.ts:187-228`** — composition asymmetry. `paperExistsInHaf` (preflight) was translated to throw → 503 retriable; `fetchCommentsFromHaf` (listing) retains swallow-to-null → 200 []. Outage starting BETWEEN the two sequential queries (preflight succeeds, listing fails) returns 200 [] for a paper the user knows has comments. `hafCache` pins null for 30s. Translate `fetchCommentsFromHaf` to also throw → 503 retriable so the contract is uniform on this route. The audit catalog's "intentional swallow-to-empty after the existence-check has already passed" classification was correct pre-audit (when both swallowed) but creates the new mixed contract post-audit. (Cross-corroborated by api-contract + adversarial + reliability.)

2. **`backend/src/db.ts` (`HafQueryError` class docstring) or `backend/src/middleware/errorHandler.ts`** — add a one-line rationale anchor: "`errorHandler` intentionally does not auto-translate `HafQueryError` to 503; translation is per-route so each handler supplies a resource-specific message string ('Profile reviews temporarily unavailable' vs 'Review temporarily unavailable')." The rationale currently lives only in this task's signal block, which archives with the task. Future maintainers seeing 4 near-identical catch arms will reach for extraction; a stable-symbol anchor prevents the silent loss of per-route message strings.

3. **All 4 route catch arms** (`profile.ts:452`, `profile.ts:638`, `reviews.ts:164`, `comments.ts:223`) — discriminate by pg error code before classifying as `retriable: true`. The current `HafQueryError` is symptom-based, not cause-based: a deploy-time SQL syntax error (`42601`) or permission error (`42501`) currently emits 503 retriable and the SPA (post-`ui-haf-outage-503-retry-affordance`) would loop the retry deterministically. Treat connection-loss codes (`08*`) and `57014` (statement_timeout) as retriable; treat the deterministic codes as 500 instead. Or document the over-broad classification explicitly with a one-line rationale and a verified SPA-side max-attempts cap.

4. **`backend/tests/routes/haf-outage-translation-canaries.test.ts:119-153`** — discriminate each canary on a stable SQL fragment emitted only by the targeted helper. Three of four canaries use `hafQueryMock.mockRejectedValue` (blanket reject — every `pool.query` throws). The fourth uses `sql.includes('FROM user_papers')` which rots on CTE rename (the label collides with `getProfileStats`' unrelated CTE). False-positive risk: a sibling SQL throws first and the canary still catches it, leaving the targeted-helper revert undetected. Prefer SQL-text discrimination on each canary (e.g. for `fetchUserReviewsFromHaf`, key on `c.parent_author != ''` or another invariant predicate).

5. **`backend/src/routes/profile.ts:378-389`** — enrichment `Promise.all` HafQueryError wrap has no canary. The wrap only runs when `result.rows.length > 0` (post-fetch enrichment); the existing papers canary throws BEFORE returning rows, so the enrichment-wrap branch is structurally unreachable from current tests. A revert of the try/catch around the Promise.all would not turn any canary red. Add a canary that mocks `FROM user_papers` to succeed with a row, then rejects a subsequent accreditation query, asserting 503 retriable.

6. **Intentional-swallow listing catches** — add a one-line inline rationale at each catch site: `stats.ts`, `disciplines.ts`, `accreditations.ts` (two sites), `papers.ts` listing path, `comments.ts` listing arm. Example: `// Intentional swallow-to-null: listing contract serves [] on outage; outage indistinguishable from "no results" is the accepted cost for listings.` The audit catalog in this task signal documents WHY each is intentional, but the catches themselves are bare `logger.error + return null`. The new `notification-queries.ts` 12-line comment makes the listing sites look like audit misses. One-line inline rationale at each prevents the future "was this audited?" question.

### Architect notes (no implementer action)

- **Finding #10 (SPA wiring gap on the 4 routes)** filed as `ui-haf-outage-503-retry-affordance.md` in `tasks/pending/` for the UI agent. Out-of-scope for this backend task per its acceptance; the new task closes the audit's value-prop.
- **API contract files** (this task signal's `[TODO Architect]` #2) updated by architect in the same review pass: `agents/docs/api-contracts/profiles.md`, `reviews.md`, `papers.md` now enumerate 503 SERVICE_UNAVAILABLE for the affected routes.
- **`notification-queries.ts` memoize-in-catch concern** (learnings researcher #2) dismissed at architect verification: `hafCache.getOrSet` provides single-flight coalescing for concurrent same-key callers; helper is called once per route invocation, so the per-request multi-call amplifier does not apply.

## Backend re-review signal (2026-05-20)

Round-2 implementation closes all 6 hold items. Targeted canary suite + sibling canaries all pass (27/27).

### Per-item landed changes

1. **`backend/src/routes/comments.ts` — `fetchCommentsFromHaf` translated.** Listing helper now throws `HafQueryError` on raw-pg failure mirroring the preflight `paperExistsInHaf` shape. Route-layer catch (already present from round-1) translates to 503 retriable. Composition asymmetry closed: a HAF outage starting BETWEEN the preflight and listing queries no longer collapses to `200 []` for a paper the user knows has comments. The cache-coherence note re-verified: `hafCache.getOrSet` skips storing on null AND on rejection (`try/finally` cleanup in `cache.ts`), so the throw does NOT poison the cache for subsequent recovery-window callers. Inline rationale comment placed at the new throw site.

2. **`backend/src/db.ts` — `HafQueryError` docstring extended.** New "Why not auto-translate in the central `errorHandler`" paragraph anchored on the class itself plus a one-line inline comment in `backend/src/middleware/errorHandler.ts` cross-referencing the rationale. Both anchors live next to stable symbols (class identity, middleware function name), so future "consolidate to middleware" refactors hit a doc-block before silently collapsing per-route message strings.

3. **All 4 route catch arms — cause-discriminated retriable classification.** New `isRetriableHafError(err)` helper exported from `backend/src/db.ts` classifies based on pg error code (`err.cause.code`): PostgreSQL connection-class `08*` and `57014` (statement_timeout) are retriable; everything else (`42601` syntax error, `42501` permission error, etc.) falls through to the central 500 handler. No-code errors (generic JS Error from network/pool layer) default to retriable, matching the helper's intent in wrapping the throw as `HafQueryError`. Catch arms updated at `comments.ts`, `profile.ts` (papers + reviews routes), and `reviews.ts` to use `instanceof HafQueryError && isRetriableHafError(err)`.

4. **`backend/tests/routes/haf-outage-translation-canaries.test.ts` — SQL-fragment discriminators on every canary.** Replaced blanket `mockRejectedValue` with `mockImplementation((sql) => sql.includes(...) ? throw : resolve)` on all four route canaries. Each discriminator anchors on a stable SQL invariant unique to the targeted helper: `authorship_claims` CTE (fetchUserPapersFromHaf), `c.parent_author != ''` (fetchUserReviewsFromHaf), `c.body, c.json_metadata` + `paper_title` projection (fetchReviewFromHaf), `SELECT 1 FROM ... LIMIT 1` without `WITH RECURSIVE` (paperExistsInHaf). False-positive risk on sibling queries firing first is closed.

5. **`backend/src/routes/profile.ts` enrichment Promise.all canary added.** New test makes user-papers query succeed with one row (so `result.rows.length > 0` advances past the early-return), then rejects a subsequent accreditation enrichment query (`SELECT account FROM active_accreditations` from `getAllAccreditedAccounts`). The `try { Promise.all([accreditation helpers]) } catch` wrap translates that into `HafQueryError('profile-papers-enrichment')`. Mutation-kill verified: a revert of the wrap surfaces as raw pg → 500, not 503 retriable.

6. **Intentional-swallow listing catches — inline rationale comments added at 5 sites.** `stats.ts:fetchStatsFromHaf`, `disciplines.ts:fetchDisciplinesFromHaf`, `accreditations.ts:fetchAccreditationsFromHaf`, `accreditations.ts:fetchAccreditationStatusFromHaf`, `papers.ts:fetchPapersFromHaf`. Each comment anchors on the behavioral statement ("listing contract serves [] on outage", "single-account status cosmetically collapses outage to 'not accredited'", etc.) without naming this task or its round number. `comments.ts` listing arm is N/A per the hold note (item 1 changed it from swallow to translate).

### Additional canary

Added a "deterministic pg-error class → 500" canary at the bottom of the test file: mocks a `42601` (syntax error) on the reviews single-doc fetch and asserts `500 INTERNAL_ERROR`, NOT `503 retriable`. Pins the new `isRetriableHafError` cause-discrimination gate so a future regression that classifies all `HafQueryError`s as retriable fails red.

### Test results

```
tests/routes/haf-outage-translation-canaries.test.ts     9 passed (9)
tests/routes/papers-haf-error-vs-not-found.test.ts       sibling: passed
tests/routes/profile-papers-supersession.test.ts         sibling: passed

Test Files  3 passed (3)
Tests       27 passed (27)
```

`npx tsc --noEmit` clean across `backend/`.

### Notes for architect

- Held-item #2 prescription mentions "verified SPA-side max-attempts cap rationale" as an alternative to discrimination. Chose discrimination per the prescription's "default to discrimination — it's the right contract". The new `isRetriableHafError` helper plus the deterministic-pg canary close the symmetric concern at the backend layer; SPA-side cap is separately enforced by the `ui-haf-outage-503-retry-affordance` task.
- Test file's `vi.mock('../../src/db.js')` now also exports `isRetriableHafError` matching the production shape. Kept as an inline test-only copy (structurally identical to the production helper) because the test mocks the whole `db.js` module — pulling the real implementation would defeat the mock isolation.

## Architect re-review (2026-05-20) — HELD PENDING FIXES

`/ce-code-review` ran on round-2 commit `d6a1eff` with 9 reviewer personas (correctness on Opus; testing, maintainability, project-standards, learnings-researcher, api-contract, reliability, kieran-typescript at Sonnet; adversarial on Opus; `ce-agent-native-reviewer` skipped per project CLAUDE.md). All 6 round-2 hold items landed structurally and against intent: `comments.ts` listing translation closes the preflight/listing composition asymmetry; `isRetriableHafError` cause-discrimination is correctly applied to the 4 enumerated routes; SQL-fragment discriminators verified unique per helper; Promise.all enrichment canary exercises the previously-unreachable wrap branch; intentional-swallow rationale comments land at all 5 sites; deterministic-pg canary pins the cause-discrimination gate. 5 items hold for round-3; several findings dismissed at triage (rationale below).

The api-contract reviewer surfaced one P1 doc divergence (`papers.md` `/comments` still documented the OLD swallow-to-empty contract). Architect resolved this in-place during the review session in commit `66b213ac` (papers.md + common.md 503-retriable note refresh). NOT a hold item; closed at review time.

### Items to address (bundle into one round-3 commit)

**1. (P2, anchor 75, cross-reviewer correctness + reliability) `isRetriableHafError` missing transient pg codes `57P03` and `53300`.** `backend/src/db.ts:78-90`. Helper classifies `08*` (connection class) + `57014` (statement_timeout) as retriable. Two additional pg codes are absent: `57P03` (`cannot_connect_now`, emitted during Postgres startup / point-in-time recovery / standby promotion — realistic during HAF maintenance windows) and `53300` (`too_many_connections`, pg-level admission reject when the server's own `max_connections` is hit, distinct from PEvO's pool cap). Both are legitimately transient per the helper's docstring intent. Under current impl they fall through to 500 INTERNAL_ERROR; SPA sees hard failure with no retry affordance during exactly the scenarios retry would succeed quickly.

   Fix: extend the discriminator: `code.startsWith('08') || code === '57014' || code === '57P03' || code === '53300'`. Update the test-local copy in `haf-outage-translation-canaries.test.ts` to match. Add one canary case for `57P03` asserting 503 retriable (mirror the `42601` canary shape but assert the opposite outcome).

**2. (P2, anchor 75, cross-reviewer kieran-typescript KT-1 + maintainability M1) `isRetriableHafError` parameter should be typed `HafQueryError`, not `unknown`.** `backend/src/db.ts:78` (signature) and `:80` (internal re-check). Every call site guards with `err instanceof HafQueryError && isRetriableHafError(err)` — the outer guard pre-narrows `err` to `HafQueryError` BEFORE the call. Inside the helper, line 80 then re-runs `instanceof HafQueryError` to decide whether to read `err.cause`, duplicating the narrow the caller just performed. The non-`HafQueryError` branch carries an unchecked cast `(underlying as { code?: unknown } | null | undefined)?.code`. The `unknown` signature also creates a silent misclassification trap: a future caller that skips the outer guard and passes a plain `Error` silently returns true (retriable, since no `.cause.code` matches the default).

   Fix: change signature to `isRetriableHafError(err: HafQueryError): boolean`. Body simplifies to direct `err.cause` access; the internal instanceof and the unchecked cast both delete. Caller call sites are unchanged (TS narrows `err` to `HafQueryError` inside the `&&` short-circuit). Update the test-local copy to match.

**3. (P2, anchor 90, cross-reviewer testing T1 + learnings-researcher + api-contract + kieran-typescript) Deterministic-pg canary missing `details.retriable` absence assertion.** `backend/tests/routes/haf-outage-translation-canaries.test.ts` (the `42601 → 500` canary added in round-2 item 7). Asserts `status: 500` and `error.code: INTERNAL_ERROR` but does not assert that `res.body.error.details?.retriable` is not `true`. A mutation that emits 500 with `{ retriable: true }` in `details` (e.g., a catch arm passing the wrong details to the central error handler) passes the canary; SPA retry loop would fire on syntax errors. The canary's stated intent is to pin that the SPA retry does not fire on deterministic errors; the absence of `retriable: true` is load-bearing for that property.

   Fix: add `expect(res.body.error.details?.retriable).not.toBe(true);` after the status + code assertions in the deterministic-pg canary. ~1 LOC.

**4. (P3, anchor 75, kieran-typescript KT-3 carry-forward from round-1) `HafQueryError` constructor `as ErrorOptions` cast is unnecessary.** `backend/src/db.ts` (HafQueryError constructor). The constructor declares `options?: { cause?: unknown }` and passes it as `super(message, options as ErrorOptions)`. Since `lib.es2022.error.d.ts` defines `ErrorOptions` as `{ cause?: unknown }`, the shapes are structurally identical. The cast silences any future divergence rather than letting the compiler catch it.

   Fix: type the parameter directly as `options?: ErrorOptions`, drop the `as` assertion. ~2 LOC.

**5. (P3, anchor 95, reliability R3) Dead `sendOk(res, [], ...)` fallback in `comments.ts:223-227`.** Pre-round-2, `fetchCommentsFromHaf` returned null on failure, exercising the null-guard `if (result) { sendOk rows } else sendOk([], ...)`. Round-2 item 1 changed the helper to throw `HafQueryError` on failure, which propagates through `hafCache.getOrSet` (try/finally clears in-flight slot and re-throws). The `sendOk(res, [], ...)` branch is now structurally unreachable via the failure path. Future-reader confusion risk: the else-branch looks like documented degraded-mode behavior; it's actually dead. Convention-enforcing-fix per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`: the round-2 contract change should have audited and removed the now-dead branch.

   Fix: remove the dead else-branch. The route's response shape is now `result.rows` always (the throw path no longer reaches the response handler, the new route-layer catch translates to 503).

### Items dismissed during architect triage

- **(api-contract AC-1 papers.md /comments contract divergence)** Resolved in architect-zone commit `66b213ac` in the same review session. Not a hold item.
- **(api-contract AC-2 503→500 narrowing undocumented for other routes + AC-3 details.retriable absent-not-false asymmetry + AC-4 isRetriableHafError classification table)** Folded into architect-zone commit `66b213ac` (common.md 503-retriable note refresh now names HafQueryError + retriable pg cause as an emitter class and explicitly states "absence of details.retriable means no retry guidance").
- **(adversarial /comments retry-amplifier, /retract rate-limit burn, JS-bug misclassification)** /retract rate-limit cascade filed as new `backend-retract-rate-limit-haf-503-burn` task in `tasks/pending/`. Other amplifier concerns acknowledged as residual; per project memory `feedback_pevo_logging_minimal` and `project_single_instance_only`, not currently actionable.
- **(testing brittleness of SQL-fragment discriminators, paperExistsInHaf negative-lookahead vulnerability)** Per project memory `feedback_dismiss_preemptive_test_hardening` — hypothetical SQL refactor; current discriminators verified unique against production SQL.
- **(testing test-local `isRetriableHafError` copy drift)** Acknowledged residual; bundled implicitly into items 1+2 (both touch the helper and the test-local copy must follow). Future addition of a real-vs-mock parity test deferred.
- **(maintainability M2 4× catch arm extraction `rethrowOrSend503` helper)** Per-route message control argument from the docstring still holds; revisit at the next growth point. Below the action threshold.
- **(project-standards two cross-file solutions-doc citations in test file headers, conf 20)** Below confidence gate.
- **(reliability/learnings pg statement_timeout disclosure on hafWalkerWallClockMs knob)** Walker-task territory (94bf294), not d6a1eff. Acknowledged as architect followup for the walker docs (separately tracked).

### Architect followups (no implementer action — already landed in this review session)

- **A1.** `papers.md` 503 SERVICE_UNAVAILABLE enumeration for `/comments` + all 4 paper-detail-class routes — landed in commit `66b213ac`.
- **A2.** `common.md` 503-retriable note refresh enumerating new emitter classes — landed in commit `66b213ac`.
- **A3 (carry forward).** [TODO Architect] from round-1 signal — the convention doc `haf-error-translation-pattern.md` via `/ce-compound`. Still deferred; the architect will invoke `/ce-compound` after this task archives clean, scoping the audit catalog + remediation pattern + helper contract asymmetry (`getAccreditedSet` display-fed safe-fail vs `getAllAccreditedAccounts` batch-fed loud-fail).

### Re-review signal

When items 1-5 land in a single round-3 commit, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Round-3 architect review scopes `/ce-code-review` to the round-3 commit only. Items 1+2 are db.ts shape changes (~15 LOC + test-copy updates); 3 is a 1-line assertion addition; 4 is a 2-line type-signature cleanup; 5 is a small dead-code removal in comments.ts.

---

## Backend re-review signal (2026-05-20, round-3 hold-fixes)

All five round-3 hold items landed.

### Item 1 — Extend `isRetriableHafError` with `57P03` and `53300`

`backend/src/db.ts` — discriminator now reads `code.startsWith('08') || code === '57014' || code === '57P03' || code === '53300'`. Docstring updated to enumerate both new codes with the operational rationale (`cannot_connect_now` during Postgres startup / PITR / standby promotion windows; `too_many_connections` for pg-level admission rejects distinct from PEvO's pool cap). Test-local copy in `backend/tests/routes/haf-outage-translation-canaries.test.ts` updated to match. New canary added at the bottom of the deterministic-pg describe block: a `57P03` throw on the reviews single-doc fetch asserts `503 SERVICE_UNAVAILABLE` with `details.retriable: true`. Mirror-shape of the `42601` canary; pins the discriminator's positive-class extension.

### Item 2 — Retype `isRetriableHafError` parameter as `HafQueryError`

`backend/src/db.ts:89` — signature changed from `(err: unknown): boolean` to `(err: HafQueryError): boolean`. Body simplifies: dropped the inner `instanceof HafQueryError` re-check (the caller's outer `&&` guard pre-narrows), dropped the unchecked `as` cast on `underlying`. Direct `(err.cause as { code?: unknown } | null | undefined)?.code` access. Caller call sites (`comments.ts:229`, `reviews.ts:159`, `profile.ts:447` + `:636`) are unchanged — TS narrows `err` to `HafQueryError` inside the `&&` short-circuit so the production call sites compile without edits. Verified by `grep` across `backend/src/`. Test-local copy in the canary test also updated to match the new shape.

### Item 3 — `details.retriable` absence assertion on the 42601 deterministic-pg canary

`backend/tests/routes/haf-outage-translation-canaries.test.ts` — added `expect(res.body.error.details?.retriable).not.toBe(true);` after the status + code assertions in the existing `42601 → 500 INTERNAL_ERROR` canary. Mutation-kill: a regression that emitted `500 INTERNAL_ERROR` with `{ retriable: true }` in `details` (e.g. a catch arm passing the wrong details to the central handler) would silently re-open the SPA retry loop on deterministic errors; now fails red.

### Item 4 — Drop `as ErrorOptions` cast in `HafQueryError` constructor

`backend/src/db.ts:42-49` — constructor parameter typed directly as `options?: ErrorOptions` (was `options?: { cause?: unknown }`); `super` call drops the `as ErrorOptions` assertion. Structurally identical to the prior shape per `lib.es2022.error.d.ts`'s `ErrorOptions = { cause?: unknown }` definition; the cleanup lets the compiler catch any future divergence rather than silencing it. Test-local copy in the canary test also updated to match.

### Item 5 — Remove dead `sendOk(res, [], …)` else-branch in `comments.ts`

`backend/src/routes/comments.ts` (GET handler body) — removed the `if (result) … else sendOk(res, [], …)` branch. The else-branch is structurally unreachable post-round-2 (item 1) because:
- `paperExistsInHaf` preflight 404s before reaching `hafCache.getOrSet` when `getPool()` is null;
- `fetchCommentsFromHaf`'s failure path now throws `HafQueryError` rather than returning null;
- `hafCache.getOrSet` skips storing on null AND on rejection.

Result is non-null at this site in practice. Used `result!.rows` and `result!.total` to satisfy TS's nullable inference (helper's `if (!pool) return null` short-circuit remains as defense-in-depth but isn't reachable from this route post-preflight). Added a brief comment block explaining the non-null assertion, anchored on the stable symbol `paperExistsInHaf` (not on line numbers) per the comment-anchor convention.

### Tests + verification

Scoped vitest (`tests/routes/haf-outage-translation-canaries.test.ts` + `tests/routes/profile-papers-supersession.test.ts` + `tests/routes/papers-haf-error-vs-not-found.test.ts`): 28 specs green (canary file: 9 specs including the new 57P03 case). Sibling `tests/routes/comments.test.ts` 6 specs green on retry (the first run hit the pre-existing real-HAF testnet ECONNRESET flake documented in the round-2 signal block).

`npm run typecheck` shows the pre-existing `tests/support/argon2-error-mocks.ts:178` failure — `dbStubFactory` missing `isRetriableHafError` — which is task `backend-fetch-paper-detail-haf-error-vs-not-found` round-2 hold item 2 (architect-prescribed for that task's round-2 commit). Not in this task's scope. `npm run lint` clean for this change (preexisting `seed-phrase.ts` / `author-supersession.ts` warnings unchanged).

---

## Architect re-review (2026-05-20, round-3 → round-4) — HELD PENDING FIXES

`/ce-code-review` ran on round-3 commit `44f7c0b1` with 4 reviewer personas (correctness on Opus; kieran-typescript, reliability, project-standards on Sonnet; testing / maintainability / security / adversarial / learnings skipped at architect scope on the 93/22 LOC prescription-following hold-fix diff; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). All 5 round-3 hold items land structurally per architect prescription: `isRetriableHafError` extended with `57P03` + `53300` with docstring rationale; signature retyped from `(err: unknown)` to `(err: HafQueryError)` with body simplification (drops inner `instanceof` re-check + unchecked `as { code?: unknown }` cast); `details.retriable` absence assertion added to the 42601 deterministic-pg canary; `as ErrorOptions` cast dropped from `HafQueryError` constructor; dead `sendOk(res, [], …)` else-branch removed from `comments.ts` with `result!.rows` non-null assertion + a stable-symbol-anchored comment block citing `paperExistsInHaf` as the preflight invariant.

Cross-task with task 4's round-2 review on `backend-fetch-paper-detail-haf-error-vs-not-found` (commit `33ceef04`): both tasks touch the `isRetriableHafError` retriable set. The round-3 extension added 57P03 + 53300 but did not address 57P01 (admin_shutdown). Surfaced as a cross-task reliability residual (anchor 75) — filed as a new follow-up task `backend-isretriable-haf-add-57p01-and-53300-coverage.md`, NOT bundled into this task's round-4 scope.

Cluster-wide findings: 3 findings surfaced, 2 dismissed at architect triage, 1 held for round-4.

### Items dismissed during architect triage

- **(kieran-typescript P3 conf 45)** `result!.rows` / `result!.total` non-null assertions in `comments.ts:227` are runtime-safe per the verified preflight chain (paperExistsInHaf → fetcher throw → cache skip-on-null). A `if (!result) throw new Error('unreachable')` type guard would convert the structural invariant into runtime narrowing without `!`, OR the helper return type could be tightened to non-nullable by removing the defense-in-depth `if (!pool) return null` short-circuit. Both alternatives valid; current shape passes typecheck and the inline comment block already documents the invariant. Reviewer self-rated conf 45 (below threshold). Dismiss as borderline taste.
- **(reliability P3 conf 80)** Missing 53300 (too_many_connections) canary symmetric to the 57P03 canary added in round-3. The hold prescription asked for one canary (57P03); the discriminator added two codes. A regression dropping 53300 alone is not currently caught by any canary. Per `feedback_dismiss_preemptive_test_hardening`: 53300 firing on Mahdi's HAF is unobserved; discriminator extension followed the hold prescription literally. Dismiss as preemptive hardening unless folded into the new follow-up task. (Architect bundled this into the 57P01 follow-up task's scope as the parity-sweep companion.)

### Items filed as new follow-up tasks (not in this task's round-4 scope)

- **(reliability P3 anchor 75 cross-task)** `57P01` (admin_shutdown) absent — same finding cross-corroborated on task 4 round-2 review. The shutdown side of the HAF restart cycle is uncovered: a graceful HAF restart catching an in-flight query mid-shutdown returns 500 INTERNAL_ERROR (non-retriable) until the connection drops to 08006 (covered by `08*`). Asymmetric coverage between 57P03 (startup) and the absent 57P01 (shutdown). Filed as new task `backend-isretriable-haf-add-57p01-and-53300-coverage.md` in `tasks/pending/`, bundled with the 53300 canary parity-sweep + the 3-mock-copy parity update across `papers-haf-error-vs-not-found.test.ts`, `haf-outage-translation-canaries.test.ts`, and `argon2-error-mocks.ts`.

### Items held (must fix before archive)

**1. (P2, anchor 90, project-standards) Round-number anchor "round-3 hold extension" introduced in the new 57P03 canary's it-block comment violates the docblock-anchor convention.** `backend/tests/routes/haf-outage-translation-canaries.test.ts` (around line 395 — the new 57P03 canary's comment, NOT a line-number citation but a textual anchor to coordination state). Comment text reads:

   > "Pins the **round-3 hold extension** of `isRetriableHafError` to include 57P03 (Postgres startup / PITR / standby promotion windows) as retriable."

   Root CLAUDE.md § Comment anchors explicitly enumerates round numbers as belonging in commit messages and task files, not production or test source: "Coordination context — round numbers, hold items, task slugs, SHAs — belongs in commit messages and task files, not in production or test source." Reinforced by `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` which enumerates "round numbers (\"round-3 hold item 2\")" as a rot class. This task's round-3 was itself a convention-enforcing fix (removing the dead else-branch in comments.ts per round-3 item 5); per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, the round-3 fix's NEW comment text was supposed to be audited against the anchor conventions in the same edit. Introducing a new round-number anchor in the same commit is exactly the self-audit failure the convention exists to prevent.

   Fix: drop the phrase "the round-3 hold extension of" — the comment can read "Pins `isRetriableHafError`'s 57P03 classification (Postgres startup / PITR / standby promotion windows) as retriable." The behavioral anchor (`isRetriableHafError` + SQLSTATE code + operational semantics) is already in the second clause and is stable. Single-line edit; ~1 LOC.

### Re-review signal

When item 1 lands in a single round-4 commit, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Round-4 architect review scopes `/ce-code-review` to the round-4 commit only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

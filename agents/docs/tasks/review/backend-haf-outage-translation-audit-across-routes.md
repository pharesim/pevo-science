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

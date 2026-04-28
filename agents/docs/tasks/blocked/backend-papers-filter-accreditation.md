# Accreditation hard-gate invariant — remove opt-out, enforce gate, add canary tests across all surfaces

**Owner:** Backend Agent
**Created:** 2026-04-28
**Updated:** 2026-04-28 (architect resolution rewritten with ontological framing — see "Architect resolution" block below; scope expanded twice from the original tests-only canary)
**Blocked by:** `backend-bridge-paper-author-gate.md` — the architect-resolution block in this task claims spam resistance as a benefit. That benefit is currently FALSE because the bridge-paper exemption has no author-side enforcement (any unaccredited Hive account can spoof `json_metadata.pevotest.type = 'bridge_paper'` to bypass the gate). The blocking task pins the exemption to `config.hiveBridgeAccount`. This task ships truthfully only after that lands.

## Problem

PEvO's trust layer is documented as accreditation-restricted publishing/reviewing/commenting/voting (root `CLAUDE.md` "Accreditation is the trust layer"), but the backend exposes an `accredited_only=false` opt-out on three endpoints — papers list (`papers.ts:210, 478`), comments list (`comments.ts:19, 61`), and search (`search.ts:36, 81, 148, 171, 311`). The reviews single-doc endpoint (`reviews.ts:91`) has no opt-out parameter but also has no gate, so it silently returns unaccredited content. This is an incoherent invariant: the architecture says hard gate, the code surfaces opt-outs and leaks.

Searching the codebase confirms the opt-outs are dead affordance — frontend never passes `accredited_only=false`, only existing backend tests (`comments.test.ts:21,47`) reference the param. No documented use case exists for surfacing unaccredited content. The bridge-paper carve-out (`papers.ts:263`) handles the only legitimate "unaccredited author appears" scenario via type, not via opt-out — though that carve-out is itself forgeable until `backend-bridge-paper-author-gate.md` lands (see blocked-by).

In addition, the **default-on filter has no canary**: nothing asserts that the gate actually excludes unaccredited content. A regression that quietly drops the WHERE clause would not be caught.

## Acceptance criteria

This task has four lanes covering the four affected surfaces (papers list, comments list, search, reviews single-doc). Each lane delivers code changes + canary tests. Contract/doc updates already land in the same commit as the architect's task move. Use real HAF (`pevo_app_test` routing under `./deploy.sh test-up`). No `getPool()` mocking — see root `CLAUDE.md` "Running Tests".

### 1. Papers list — remove opt-out + add canary test

**Code:**
- `backend/src/routes/papers.ts:210, 260, 478, 481` — drop the `req.query.accredited_only` parsing at lines 210 and 478. Hardcode the always-on filter at line 260 (the existing `if (accreditedOnly)` branch becomes unconditional). Drop `:ao=${accreditedOnly}` from the cache key at line 481. Bridge-paper exemption at line 263 stays unchanged here (the author-pinning fix lives in the blocking task).
- `backend/src/types/api.ts:69` — remove `accredited_only?: boolean` from `PaperListParams`. Drops the dead advertised type-shape so future TypeScript callers don't get autocomplete for a no-op field.

**Test:** `backend/tests/routes/papers.test.ts` — seed or pick an `APP_TAG` post authored by a Hive account that is NOT in `active_accreditations`. Assert:
- `GET /api/papers` does NOT include that post.
- `GET /api/papers?accredited_only=false` ALSO does NOT include that post (param is silently ignored — assert behavior, not error).
- Bridge-paper carve-out: a `bridge_paper`-typed post from `config.hiveBridgeAccount` IS included. (After the blocking task lands, an unaccredited-author fake-bridge-typed post is also asserted excluded; that canary lives in the blocking task.)

### 2. Comments list — remove opt-out + add canary test + clean up superseded test URLs

**Code:** `backend/src/routes/comments.ts:19, 22, 58, 61, 184`. Drop `accreditedOnly` from `parseCommentParams` (lines 19, 22), from the destructure at line 58, hardcode the `accreditedJoin` toggle at line 61, drop `:ao=${params.accreditedOnly}` from the cache key at line 184.

**Tests:**
- `backend/tests/routes/comments.test.ts:21, 47` — drop the `?accredited_only=false` from the URL strings; keep the existing envelope-shape assertions (`status`, `data` array, `meta`, `is_accredited` field presence). The original tests don't assert opt-out behavior — they assert envelope shape with a no-op param appended; only the URL needs cleanup, not the assertion bodies.
- Add a canary: for a paper that has comments from both accredited and unaccredited authors, assert `GET /api/papers/:author/:permlink/comments` excludes the unaccredited-author comments. Assert the same with `?accredited_only=false` appended (same response — param ignored).

### 3. Search — remove opt-out across all modes

**Code:**
- `backend/src/routes/search.ts:36, 81, 148, 171, 236, 247, 251, 256, 257, 311, 320, 322` — drop the `accreditedOnly` parameter from `searchPapersFromHaf`, `searchReviewsFromHaf`, and `searchFromHaf` signatures and call sites. Hardcode the always-on filter at the WHERE clauses (lines 81, 171). Drop `:a=${accreditedOnly}` from the cache key at line 320. Drop the route-level `req.query.accredited_only` parse at line 311.
- `backend/src/types/api.ts:80` — remove `accredited_only?: boolean` from `SearchParams`.

**Test:** `backend/tests/routes/search.test.ts` (create or extend) — assert that `GET /api/search?type=papers&q=...` and `GET /api/search?type=review&q=...` (singular — the actual code branch at `search.ts:246`) both exclude unaccredited authors regardless of whether `accredited_only=false` is appended.

### 4. Reviews — add SQL gate to single-doc + add canary tests for both reviews surfaces

**Code:** `backend/src/routes/reviews.ts:43-76` (`fetchReviewFromHaf`). Extend the WHERE clause to admit only `active_accreditations.account` ∪ `config.hiveAnonAccount`:

```sql
AND (c.author IN (SELECT account FROM active_accreditations) OR c.author = $N)
```

The existing `accredCte` is already in scope. Append `config.hiveAnonAccount || ''` to the params list and use `accredCte.nextIdx + 2` as `$N`. The `|| ''` fallback is safe because Hive prohibits empty author names — the WHERE clause never matches an empty string, so the OR-arm becomes a no-op when `HIVE_ANON_ACCOUNT` is unset. Add a one-line code comment near the SQL clause noting the safety, OR adopt the conditional-emit pattern from `papers.ts:1107-1109` if you prefer.

Drop the now-vestigial `accreditedSet.has(reviewAuthor)` enrichment at line 86 unless the `is_accredited` flag distinguishes anon-proxy from direct-accredited (it does — leave the enrichment, see "is_accredited semantics" below).

**SQL filter (not enrichment-layer filter)** because:
- Defense-in-depth: the gate sits at the data layer; future refactors of `enrichReviewDetail` cannot leak unaccredited reviews.
- Consistency with paper-detail's `reviews: []` array filter (`papers.ts:1133` uses `c.author = ANY($6::text[])`).
- 404-path performance: SQL filter saves the parent-title roundtrip and the reputation lookup on rejected requests.
- Happy-path performance: identical to enrichment filter (HAF roundtrip dominates either way).

**Paper-detail reviews array** (`backend/src/routes/papers.ts:1133`, `GET /api/papers/:author/:permlink`) — already always-on filtered. No code change; verify with a test.

**Tests:**
- `backend/tests/routes/reviews.test.ts` — `GET /api/reviews/:author/:permlink` for an unaccredited author returns 404. Same endpoint for an accredited author returns 200 with the review body. Same endpoint for a `hiveAnonAccount`-authored review returns 200 with `is_accredited: false` (anon-proxy distinguished from direct-accredited).
- `backend/tests/routes/papers.test.ts` (or a new section in `reviews.test.ts` against the paper-detail endpoint) — for a paper that has reviews from both accredited and unaccredited authors, assert `GET /api/papers/:author/:permlink`'s `reviews: []` array contains only the accredited reviewers (plus `hiveAnonAccount` if it authored a review).

### 5. `is_accredited` field semantics

Unchanged. After all gates, the field's values are:
- **Papers:** `true` for accredited authors, `false` for bridge-paper exemption posts.
- **Comments:** always `true` post-gate (vestigial — frontend follow-up filed as `ui-comment-accredited-badge-vestigial.md`).
- **Reviews:** `true` for direct-accredited reviewers, `false` for `hiveAnonAccount` reviews. Anon-proxy distinction is meaningful for UI badging.

Do not remove the `is_accredited` field on any surface as part of this task.

### 6. Contract & doc updates (already landed by architect)

The architect lands in the same commit as this task's move:
- `agents/docs/ARCHITECTURE.md` "Accredited-Only Data Policy" rewritten with the ontological framing (PEvO objects are author-vouched).
- `agents/docs/api-contracts/papers.md` — three `accredited_only` rows removed (papers list, comments list, search) plus the "by default" residue at line 342 cleaned.
- `agents/docs/api-contracts/common.md` — accredited-only summary harmonized; explicit "no opt-out anywhere" note added.

Do not re-edit these files. If you discover another contract file that documents `accredited_only`, update it inline with this task.

## Why now

The display-filter invariant has no canary, and the gate itself was incoherent — opt-out branches on three endpoints with no consumer, and a leak on the reviews single-doc. We brainstormed E2E coverage and concluded the canary belongs at the backend integration tier, not Playwright — the assertion is query-shape, not user-journey. See session 2026-04-28.

## Implementation order suggestion

Each lane can be its own commit. Suggested order:

1. **Lane 4 reviews SQL gate + tests** — smallest, most contained, **and the only lane that closes a real existing leak** (reviews single-doc currently surfaces unaccredited content). Lanes 1-3 are policy hardening of paths that already filter by default. If you only have time to ship one commit, ship lane 4.
2. **Lane 1 papers list** — drop the opt-out branch + types/api.ts field, add the canary test.
3. **Lane 2 comments list** — drop the opt-out branch, clean up the existing test URLs, add the canary.
4. **Lane 3 search** — drop the opt-out across all modes + types/api.ts field, add canary tests.

If any lane reveals a fixture gap (no unaccredited-author `APP_TAG` post in the test DB, no anon-account review in the test DB, etc.), file a follow-up rather than mocking.

## Out of scope

- UI-side affordance / banner behavior on `publish.js`/`review.js`/`edit.js` (separate UI task).
- Removing the now-vestigial `is_accredited: true` on comments — filed as `ui-comment-accredited-badge-vestigial.md`.
- Researchers directory (`/api/accreditations`) is implicitly accredited-only because its source table is `active_accreditations`; no separate test needed unless the implementation drifts.
- Reviews-search reachability — the contract at `api-contracts/papers.md:470` says `type` is `paper | all` but `search.ts:246` accepts `type === 'review'`. Filed as `backend-search-reviews-contract-reconcile.md`. Lane 3's hardening applies to whichever branch ships.
- Bridge-paper exemption author-pinning — filed as `backend-bridge-paper-author-gate.md` (this task's blocker).

---

## Architect resolution (2026-04-28, ontological framing)

The hard gate is **ontological, not privacy or curatorial**. PEvO defines its objects (papers, reviews, comments) by author vouching:

- **Papers and comments** are author-vouched by accredited Hive accounts.
- **Reviews** are author-vouched by accredited reviewers, or by `config.hiveAnonAccount` posting on behalf of an accredited reviewer.
- **Bridge papers** are author-vouched by `config.hiveBridgeAccount` cross-posting external sources (see blocking task `backend-bridge-paper-author-gate.md` — the type-claim alone doesn't grant object status; the bridge-account vouching does).

A Hive comment with object-shaped metadata authored by an unaccredited account is **not** a PEvO object — it's a Hive comment claiming PEvO-shape. PEvO endpoints serve PEvO objects only.

This framing distinguishes two stances that the project-wide CLAUDE.md and ARCHITECTURE.md previously conflated:

- **Write-gate** (integrity invariant): publishing, reviewing, commenting, and voting are restricted to accredited accounts on the *write* path. Documented in root `CLAUDE.md` under "Accreditation is the trust layer."
- **Read-gate** (ontological boundary, this task's contribution): PEvO API surfaces serve PEvO objects only. An on-chain Hive comment with PEvO-shaped metadata authored by a non-vouched account is not a PEvO object and is not surfaced.

### HTTP-shape consequences

- **List endpoints** (lanes 1-3) filter to PEvO objects via the SQL gate. `?accredited_only=false` is silently ignored — Express HTTP convention for unknown query params.
- **Single-doc endpoint** (lane 4) returns 404 when the requested PEvO review doesn't exist at that identifier. An unaccredited author's review-shaped Hive comment isn't a PEvO review; 404 is the correct shape, same as a non-existent identifier. Accreditation status is public (queryable via `/api/accreditations` and on-chain `custom_json` operations), so the 404 isn't hiding confidential information — it's reflecting the ontological boundary.

The asymmetry between "silent-ignore" (lists) and "404" (single-doc) is shape-driven (REST list-vs-single-doc convention), not policy-driven. Same gate; different HTTP-shape consequences.

### Resolution history (this task moved through three architect-resolution passes — full rationale in git history)

1. **Round 1 (2026-04-28a):** picked option (d) "hard-gate reviews surface only", left papers/comments opt-outs alone.
2. **Round 2 (2026-04-28b):** user pushback on retained asymmetry ("Accreditation is a hard gate there too"). Confirmed zero frontend consumers of `accredited_only=false`; expanded scope to remove the opt-out across papers/comments/search.
3. **Round 3 (this pass):** user pointed out accreditation status is public, so the privacy/curatorial framing for the lane-4 404 was misgrounded. Reframed from privacy-by-design to ontological. The 404 stands but on a different rationale (PEvO object doesn't exist at that identifier, not "we're hiding the fact that it does").

The ontological framing supersedes prior rationale. ARCHITECTURE.md, api-contracts/common.md, and api-contracts/papers.md edits land in the same commit as this rewrite. Backend implements code + tests across the four lanes above. Task is blocked on `backend-bridge-paper-author-gate.md` per the blocked-by clause; once that lands, this task moves from `tasks/blocked/` to `tasks/pending/` for implementer pickup.

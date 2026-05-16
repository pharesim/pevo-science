# Accreditation hard-gate invariant — remove opt-out, enforce gate, add canary tests across all surfaces

**Owner:** Backend Agent
**Created:** 2026-04-28
**Updated:** 2026-04-28 (architect resolution rewritten with ontological framing — see "Architect resolution" block below; scope expanded twice from the original tests-only canary)
**Updated:** 2026-05-11 (architect unblock — see "Architect unblock note" at the bottom)

## Problem

PEvO's trust layer is documented as accreditation-restricted publishing/reviewing/commenting/voting (root `CLAUDE.md` "Accreditation is the trust layer"), but the backend exposes an `accredited_only=false` opt-out on three endpoints — papers list (`papers.ts:210, 478`), comments list (`comments.ts:19, 61`), and search (`search.ts:36, 81, 148, 171, 311`). The reviews single-doc endpoint (`reviews.ts:91`) has no opt-out parameter but also has no gate, so it silently returns unaccredited content. This is an incoherent invariant: the architecture says hard gate, the code surfaces opt-outs and leaks.

Searching the codebase confirms the opt-outs are dead affordance — frontend never passes `accredited_only=false`, only existing backend tests (`comments.test.ts:21,47`) reference the param. No documented use case exists for surfacing unaccredited content. The bridge-paper carve-out (now in `helpers.ts` `isPevoBridgePaper(meta, author)` and the SQL `validPevoPaperWhere` helper) handles the only legitimate "unaccredited author appears" scenario via author-pinned type, not via opt-out.

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
- Bridge-paper exemption author-pinning — was filed as `backend-bridge-paper-author-gate.md` (this task's prior blocker, archived clean 2026-05-05 at commit `58fa8ff`).

---

## Architect resolution (2026-04-28, ontological framing)

The hard gate is **ontological, not privacy or curatorial**. PEvO defines its objects (papers, reviews, comments) by author vouching:

- **Papers and comments** are author-vouched by accredited Hive accounts.
- **Reviews** are author-vouched by accredited reviewers, or by `config.hiveAnonAccount` posting on behalf of an accredited reviewer.
- **Bridge papers** are author-vouched by `config.hiveBridgeAccount` cross-posting external sources. The type-claim alone doesn't grant object status; the bridge-account vouching does. Enforced via `validPevoPaperWhere` (SQL) and `isPevoBridgePaper(meta, author)` (JS), with the `pevo/no-bridge-paper-literal` ESLint rule catching new direct-literal sites outside the structural-path allowlist.

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

The ontological framing supersedes prior rationale. ARCHITECTURE.md, api-contracts/common.md, and api-contracts/papers.md edits already landed in prior architect passes (verified 2026-05-11 — see "Architect unblock note" below). Backend implements code + tests across the four lanes above.

---

## Architect unblock note (2026-05-11)

**Trigger:** backend startup triage on 2026-05-11 surfaced this file as still in `blocked/` citing `backend-bridge-paper-author-gate.md`. That blocker shipped clean on 2026-05-05 (commit `58fa8ff` "architect: archive BACKEND-BRIDGE-PAPER-AUTHOR-GATE round-4 clean"). The `tasks-archive.md` entry has since rolled off the 250-line trim (full history in git).

**Verified primitives in current `main`:**
- `validPevoPaperWhere` SQL helper in `backend/src/hafsql.ts` (pins `c.author = config.hiveBridgeAccount` on the bridge-paper branch).
- `isPevoBridgePaper(meta, author)` predicate in `backend/src/helpers.ts:60` (binds author to `config.hiveBridgeAccount`).
- ESLint rule `pevo/no-bridge-paper-literal` active in `backend/eslint.config.mjs` (AST-based, structural-path allowlist for `hafsql.ts`/`helpers.ts`/`bridge.ts` + `src/types/**`).
- 12+ call sites in `routes/`, `reputation.ts`, `notification-queries.ts`, `app.ts` correctly thread `config.hiveBridgeAccount` into the SQL.

**Verified architect-owned doc edits already landed:**
- `agents/docs/ARCHITECTURE.md` "Accredited-Only Data Policy" (line 86+) — ontological framing in place, "no `accredited_only=false` opt-out on any endpoint" stated explicitly.
- `agents/docs/api-contracts/common.md` (line 20+) — accredited-only policy harmonized with the same "no opt-out" language and the bridge-paper author-and-type-gated note.
- `agents/docs/api-contracts/papers.md` — `accredited_only` rows already removed from the comments-list section (line 347 says "the gate is unconditional, no opt-out"). No further architect edits required at unblock time.

**Line-number drift in the four lanes' Acceptance criteria:** The `papers.ts`, `comments.ts`, `search.ts` line numbers cited in this task body were captured in 2026-04-28 and have drifted since. Implementer should locate the named symbols (`accredited_only` query parse, `accreditedOnly` destructure, `:ao=`/`:a=` cache-key suffix, `accredited_only?: boolean` interface fields) by grep rather than trusting the line numbers. The intent and surface set are unchanged; only line numbers moved.

**No new [TODO Architect] items at unblock time.** Move from `blocked/` to `pending/` for backend pickup.

---

## Backend implementation signal (2026-05-11, commits `986f07e`..`9633049`)

All four lanes landed across four backend commits on `main`. Each lane is its own commit, ordered per the task body's "Implementation order suggestion" (Lane 4 first because it's the only one closing a real existing leak; Lanes 1-3 are policy hardening of paths that already filter by default).

### Commit map

- `986f07e` `backend(reviews): lane 4 — SQL accreditation gate on single-doc reviews`
- `b55d691` `backend(papers): lane 1 — drop accredited_only opt-out + add canary`
- `a0845dc` `backend(comments): lane 2 — drop accredited_only opt-out + add canaries`
- `82f8850` `backend(search): lane 3 — drop accredited_only opt-out across all type modes`
- `9633049` `backend(papers): lane 1 follow-up — update bridge-paper-author-gate canary for unconditional gate`

Prior architect commit `59eacf9` `architect: unblock backend-papers-filter-accreditation (prior blocker shipped)` moved the file from `blocked/` to `pending/`.

### Deliverables per lane

**Lane 4 (reviews single-doc) — `backend/src/routes/reviews.ts`:**

- Extended `fetchReviewFromHaf` WHERE clause to admit only `c.author IN (SELECT account FROM active_accreditations) OR c.author = $hiveAnonAccount`. The `|| ''` fallback for unset `HIVE_ANON_ACCOUNT` is safe per Hive's empty-author-name prohibition (`c.author = ''` never matches); documented inline.
- Left `enrichReviewDetail`'s `accreditedSet.has(reviewAuthor)` check in place per task body — it's load-bearing for distinguishing direct-accredited (`is_accredited: true`) from anon-proxy (`is_accredited: false`).
- Tests (`backend/tests/routes/reviews.test.ts`, new describe block "SQL accreditation gate"): carve-out clause (c) mocked-pool with controlled gate-shape responder. Real-path companion risk class covered by the paper-detail reviews-array filter (`papers.ts` ~2195, `c.author = ANY($N::text[])`) plus search/comments/reputation real-HAF specs. Three canaries: unaccredited→404, accredited→200 with `is_accredited:true`, `hiveAnonAccount`→200 with `is_accredited:false`. Plus structural assertion that BOTH arms of the gate are present in the SQL.

**Lane 1 (papers list) — `backend/src/routes/papers.ts`, `backend/src/types/api.ts`:**

- Dropped two `accreditedOnly` parses (`fetchPapersFromHaf` ~line 372 in old refs; `route handler` ~line 631 in old refs). Hardcoded the gate predicate using the existing `validPevoPaperWhere({ source: 'bridge' })` bridge-arm helper. Dropped `:ao=` from the sha256-wrapped cache-key fragment. Dropped `accredited_only?: boolean` from `PaperListParams`.
- Tests (`backend/tests/routes/papers.test.ts`, real-HAF): canary that every returned paper has `is_accredited: true` OR `author === config.hiveBridgeAccount`; silent-ignore canary that `?accredited_only=false` returns identical set (`new Set(...).toEqual(new Set(...))` on `${author}/${permlink}` keys).

**Lane 2 (comments list) — `backend/src/routes/comments.ts`:**

- Dropped `accreditedOnly` from `parseCommentParams`, destructure, hardcoded the SQL `JOIN active_accreditations aa ON aa.account = dc.author` against the `filtered` CTE. Dropped `:ao=` from the cache-key string.
- Tests (`backend/tests/routes/comments.test.ts`, real-HAF): cleaned existing test URLs that had `?accredited_only=false` appended (the original tests asserted envelope shape with a no-op param; per task body, "drop from URL strings; keep envelope-shape assertions"). Added canary: every returned comment has `is_accredited: true`. Added canary: silent-ignore parity.

**Lane 3 (search) — `backend/src/routes/search.ts`, `backend/src/types/api.ts`:**

- Dropped `accreditedOnly: boolean` parameter from `searchPapersFromHaf`, `searchReviewsFromHaf`, `searchFromHaf` signatures and all call sites (including the merged `type === 'all'` `Promise.all`). Hardcoded gate predicates on both `papers` and `reviews` query branches. Dropped `:a=` from the sha256-wrapped cache-key fragment. Dropped `accredited_only?: boolean` from `SearchParams`.
- List-mode review search does NOT include the `hiveAnonAccount` OR-arm — only the single-doc reviews endpoint (lane 4) needs to surface anon-proxy reviews. Documented inline at the WHERE-clause emission site.
- Tests (`backend/tests/routes/search.test.ts`, real-HAF, new describe "SQL accreditation gate (lane 3)"): four canaries: every `?type=paper` entry is accredited or `config.hiveBridgeAccount`-authored; every `?type=review` entry is accredited; `?type=paper&accredited_only=false` returns the same set as no param; `?type=review&accredited_only=false` returns the same set as no param.

### Lane 1 follow-up: bridge-paper-author-gate canary update

The unconditional gate emission means the bridge OR-arm
(`validPevoPaperWhere({ source: 'bridge' })`) now always appears in the
SQL, regardless of the typeFilter source. A canary in
`backend/tests/routes/bridge-paper-author-gate.test.ts:216` had asserted the
opposite ("asymmetric arm" — `?source=native&accredited_only=false` produces
SQL with no `'bridge_paper'` literal). After Lane 1 that asymmetric arm
no longer exists. Updated the canary to use `bridgeRelatedCaptures()` +
`assertBridgeAuthorPin()` so the load-bearing invariant on that surface
becomes "the bridge OR-arm pins the author to `config.hiveBridgeAccount`"
rather than "no bridge_paper literal at all". Inline comment documents the
pre-/post-lane-1 contract change for future readers. Landed in commit
`9633049` as a Lane 1 follow-up. 14/14 in `bridge-paper-author-gate.test.ts`
pass post-fix. The other three canaries in the same describe block
(`accreditedOnly=true`, `accreditedOnly=false retains pin`, `source=bridge
pins`) were already aligned with the unconditional-gate contract and
required no edits.

### Out-of-scope cleanup deliberately left in place

The following pre-existing tests still use `?accredited_only=false` as a stable URL fragment to test orthogonal concerns. They are unaffected by the silent-ignore change (cache-key shape and SQL shape are now identical with or without the param), and removing the param would be out-of-scope churn:

- `backend/tests/routes/bridge-paper-author-gate.test.ts:206, 217` — bridge-paper exemption survives across opt-out states.
- `backend/tests/routes/disciplines-canon-mocked.test.ts:523, 741, 742, 764, 765, 789` — cache-key collision-resistance + sha256-wrap shape.

### Out-of-scope finding flagged for separate triage

`backend/src/routes/comments.ts` `fetchCommentsFromHaf` builds a self-referencing `comment_tree` CTE inside a non-`RECURSIVE` `WITH` clause. PostgreSQL rejects the second branch's `JOIN comment_tree ct` with `42P01 relation "comment_tree" does not exist`. The route's `try/catch` swallows the error and returns `[]`. The bug pre-dates this task and is visible in the Lane 2 test logs as `HAF comments query failed`. This means the comments endpoint has been silently returning empty arrays whenever there are comments; the Lane 2 canary I added asserts the surface contract but its load-bearing value is contingent on the underlying SQL eventually returning rows. Flagged here rather than fixed in any of the four lane commits per the "don't refactor beyond what the task requires" rule. Architect's call whether to file a follow-up task.

### `is_accredited` field semantics

Unchanged per task body — all three surfaces (papers / comments / reviews) keep the field:

- **Papers:** `true` for accredited authors, `false` for `bridge_paper` exemption posts authored by `config.hiveBridgeAccount`.
- **Comments:** always `true` post-gate (vestigial; UI cleanup is filed as `ui-comment-accredited-badge-vestigial.md` which transitively blocked on this task archiving).
- **Reviews:** `true` for direct-accredited reviewers, `false` for `hiveAnonAccount`-authored anon-proxy reviews.

### Verification

- `npx tsc --noEmit` clean after each lane (run between lanes 3, 1, 2 — Lane 4's reviews.ts edit is the smallest and was tested directly).
- `npm run lint` clean for backend changes (two pre-existing `any` warnings on `backend/src/seed-phrase.ts` unchanged; not in scope).
- Per-lane targeted vitest (real Postgres/Redis via Docker IP overrides): 7 (reviews) + 14 (papers, +1 skipped) + 5 (comments) + 23 (search) + 14 (bridge-paper-author-gate, post lane-1 follow-up) = 63 tests, all green.
- Full backend `npx vitest run`: 1100 passed | 3 failed | 5 skipped (1108 total, 91/93 test files passed). The 3 failed tests are pre-existing flakes:
  - `stats-profile-parity.test.ts:166` ("highest_reputation_user is null when no accredited user has a strictly positive score") — documented real-chain data flake, passes on retry. Noted in `backend-bridge-write-haf-lag-and-retry-amplification.md`'s round-N signal. Re-running the file alone returned 4/4 green.
  - `disciplines-canon-mocked.test.ts:669` (`continuation-chain head-override lowercases head metadata`) — documented pre-existing flake. Same task signal references it.
  - Two cache-collision tests in `disciplines-canon-mocked.test.ts:359, 406` (repeated-discipline-param dedup) fail when `bridge-paper-author-gate.test.ts` runs in the same vitest invocation but pass when `disciplines-canon-mocked.test.ts` runs alone or alongside `papers.test.ts`. This is test-isolation interaction (likely shared `hafCache` state across files), not a regression introduced by any of the four lane changes — verified by running each combination. The `:ao=` cache-key fragment removal does not change behavior when both compared requests use the same `?accredited_only` value (or omit it).

### No new [TODO Architect] notes from this implementation pass.

---

## Architect re-review round-2 (2026-05-16) — HELD PENDING FIXES

`/ce-code-review` on commits `986f07e..9633049` dispatched 11 reviewers (correctness, security, adversarial, testing, maintainability, project-standards, learnings, performance, api-contract, reliability, kieran-typescript; `ce-agent-native-reviewer` skipped per root CLAUDE.md). Mostly clean. 1 P2 held below; 1 P2 filed as separate task; remaining findings dismissed at triage or noted for architect-side doc updates.

### Items to address

**1. (P2) `accredCte.nextIdx + 2` flat-offset arithmetic diverges from `paramIdx++` convention**

**Where:** `backend/src/routes/reviews.ts:62-64` (at commit `986f07e`). **Verify current working-tree state first** — the kieran-typescript reviewer noted the working tree may have superseded the flat-offset form; if `paramIdx++` is already in place on `main`, mark this item done without further changes.

**Why:** The canonical pattern across PEvO's backend is the `paramIdx++` counter idiom:

```ts
let paramIdx = accredCte.nextIdx;
const authorIdx = paramIdx++;
const permlinkIdx = paramIdx++;
const anonIdx = paramIdx++;
```

The flat-offset form is mechanically correct today (exactly three binds follow the CTE params), but it's one bind-insertion away from silent SQL parameter mis-alignment. The same file's own comments document the `paramIdx++` convention as canonical; the inconsistency is self-contradicting. Per `agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md`, the canonical counter pattern exists exactly to make bind-insertion regressions impossible.

**Fix:** If `reviews.ts:62-64` still uses `accredCte.nextIdx + 2` flat arithmetic on current `main`, refactor to the `paramIdx++` counter idiom shown above. Otherwise mark this item done.

### Findings filed as separate tasks (no action on this hold)

- `backend-search-partial-degradation-allsettled.md` (P2) — `searchFromHaf` `type=all` branch uses `Promise.all` which collapses to empty 200 on single-branch throw, silently masking partial degradation. Pre-existing bug surfaced during lane-3 review; filed as follow-up since not in the task's accreditation-gate scope.

### Findings dismissed at triage (no action)

- Lane-2 comments canaries were vacuously passing at commit `a0845dc` due to the pre-existing non-RECURSIVE CTE bug returning `[]` silently (testing T-01 P2/90). The bug was fixed out-of-scope at commit `893f43d` ("fix discussion thread query swallowing all PEvO comments"); canaries are live on current `main`. No architect action needed beyond noting that the lane-2 mutation-kill claim was effectively re-attested by `893f43d`'s downstream fix.
- Anon-proxy canary silently degrades to weaker 404 assertion when `HIVE_ANON_ACCOUNT` is unset (testing T-02 low/75): preemptive hardening per `feedback_dismiss_preemptive_test_hardening`. The `pevo.anon` default makes the degradation path unreachable in normal deployments.
- `/api/profile/:username/papers` (`fetchUserPapersFromHaf`) lacks `validPevoPaperWhere` + accreditation gate (adversarial P3/90): out-of-scope of the 4 named lanes. Folded into the `backend-cumulative-union-listing-surfaces-parity.md` follow-up's audit scope (the missed-surface audit there should enumerate `fetchUserPapersFromHaf` + the `authorship_claims` UNION arm).
- Stale `accreditedOnly` references in `bridge-paper-author-gate.test.ts` comments/titles (maintainability M2 low/75): cosmetic test-file cleanup; bundle into next backend touch of that file.
- Bare `{ }` block leftover in `search.ts:88` (maintainability M1 low/80): cosmetic; bundle into next backend touch.
- Contract-doc items (api-contract AC-01: `reviews.md` Errors block doesn't enumerate the new 404-for-unaccredited; AC-02: `is_accredited` per-surface anon-proxy semantics undocumented): architect-side. Fold into the next `agents/docs/api-contracts/{reviews.md,papers.md}` touch — not a hold item on this task.

### Re-review signal

When item 1 is resolved (either applied or confirmed-already-fixed-on-main), `git mv` this file from `tasks/pending/` back to `tasks/review/`. The architect's next review pass scopes `/ce-code-review` to commits since `9633049` (or skips if item 1 is verified already-fixed in working tree).

## Backend re-review signal (2026-05-16) — item 1 verified already-fixed on `main`

Round-2 hold item 1 (P2) is already resolved on current `main`. `backend/src/routes/reviews.ts` `fetchReviewFromHaf` at lines 70-75 uses the canonical `paramIdx++` counter idiom:

```ts
let paramIdx = accredCte.nextIdx;
const authorIdx = paramIdx++;
const permlinkIdx = paramIdx++;
const anonIdx = paramIdx++;
const appTagIdx = paramIdx++;
const bridgeIdx = paramIdx++;
```

The flat-offset `accredCte.nextIdx + N` form cited by the kieran-typescript reviewer at commit `986f07e` has been superseded — the bind-insertion-safe counter pattern is in place, with the rationale already documented inline in the comment block at lines 61-69 (cross-referencing the canonical shape and explaining why `accreditedVoteCount(...)` does not consume a counter slot). No code change required on this round; this commit is the signal block + `git mv` only.

The architect's next review pass should skip `/ce-code-review` per the hold-block's own escape hatch ("or skips if item 1 is verified already-fixed in working tree") and proceed straight to archive.

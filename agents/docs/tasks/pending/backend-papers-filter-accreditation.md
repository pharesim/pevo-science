# Accreditation hard-gate invariant — remove opt-out, enforce gate, add canary tests across all surfaces

**Owner:** Backend Agent
**Created:** 2026-04-28
**Updated:** 2026-04-28 (architect resolution — see "Architect resolution" block below; scope expanded twice: first to add reviews single-doc SQL gate, then to remove the `accredited_only=false` opt-out across papers/comments/search and harmonize the gate)

## Problem

PEvO's trust layer is documented as accreditation-restricted publishing/reviewing/commenting/voting (root `CLAUDE.md` "Accreditation is the trust layer"), but the backend exposes an `accredited_only=false` opt-out on three endpoints — papers list (`papers.ts:210, 478`), comments list (`comments.ts:19, 61`), and search (`search.ts:36, 81, 148, 171, 311`). The reviews single-doc endpoint (`reviews.ts:91`) has no opt-out parameter but also has no gate, so it silently returns unaccredited reviews. This is an incoherent invariant: the architecture says hard gate, the code surfaces opt-outs and leaks.

Searching the codebase confirms the opt-outs are dead affordance — frontend never passes `accredited_only=false`, only existing backend tests (`comments.test.ts:21,47`) exercise the param to verify the opt-out works. No documented use case exists for surfacing unaccredited content. The bridge-paper carve-out (`papers.ts:263`) handles the only legitimate "unaccredited author appears" scenario via type (`json_metadata.type === 'bridge_paper'`), not via opt-out.

In addition, the **default-on filter has no canary**: nothing asserts that the gate actually excludes unaccredited content. A regression that quietly drops the WHERE clause would not be caught.

## Acceptance criteria

This task has three lanes — code changes (remove opt-out + add reviews gate), contract/doc updates (architect lands these in the same commit as this task is moved to pending; backend should not re-edit), and canary tests (assert the hard-gate invariant on every surface). Use real HAF (`pevo_app_test` routing under `./deploy.sh test-up`). No `getPool()` mocking — see root `CLAUDE.md` "Running Tests".

### 1. Papers list — remove opt-out + add canary test

**Code:** `backend/src/routes/papers.ts:210, 260, 478, 481`. Drop the `req.query.accredited_only` parsing at lines 210 and 478. Hardcode the always-on filter at line 260 (the existing `if (accreditedOnly)` branch becomes unconditional). Drop `:ao=${accreditedOnly}` from the cache key at line 481. Bridge-paper exemption at line 263 stays unchanged.

**Test:** `papers.test.ts` — seed or pick an `APP_TAG` post authored by a Hive account that is NOT in `active_accreditations`. Assert:
- `GET /api/papers` does NOT include that post.
- `GET /api/papers?accredited_only=false` ALSO does NOT include that post (param is ignored / no-op — assert behavior, not error).
- Bridge-paper carve-out: a `bridge_paper`-typed post from an unaccredited author IS included. If no fixture exists, document the gap and file a follow-up.

### 2. Comments list — remove opt-out + add canary test + delete superseded opt-out tests

**Code:** `backend/src/routes/comments.ts:19, 22, 58, 61, 184`. Drop `accreditedOnly` from `parseListParams` (lines 19, 22), from the destructure at line 58, hardcode the `accreditedJoin` toggle at line 61, drop `:ao=${params.accreditedOnly}` from the cache key at line 184.

**Tests:**
- Delete the existing opt-out exercises at `comments.test.ts:21, 47` (or rewrite them to assert the param no-ops). They currently assert that the opt-out path returns unaccredited comments; that assertion is now wrong.
- Add a canary: for a paper that has comments from both accredited and unaccredited authors, assert `GET /api/papers/:author/:permlink/comments` excludes the unaccredited-author comments. Assert the same with `?accredited_only=false` appended (same response — param ignored).

### 3. Search — remove opt-out across all modes

**Code:** `backend/src/routes/search.ts:36, 81, 148, 171, 236, 247, 251, 256, 257, 311, 320, 322`. Drop the `accreditedOnly` parameter from `searchPapersFromHaf`, `searchReviewsFromHaf`, and `searchFromHaf` signatures and call sites. Hardcode the always-on filter at the WHERE clauses (lines 81, 171). Drop `:a=${accreditedOnly}` from the cache key at line 320. Drop the route-level `req.query.accredited_only` parse at line 311.

**Test:** `search.test.ts` (create or extend) — assert that `GET /api/search?type=papers&q=...` and `GET /api/search?type=reviews&q=...` both exclude unaccredited authors regardless of whether `accredited_only=false` is appended.

### 4. Reviews — add SQL gate to single-doc + add canary tests for both reviews surfaces

**Code:** `backend/src/routes/reviews.ts:43-76` (`fetchReviewFromHaf`). Extend the WHERE clause to admit only `active_accreditations.account` ∪ `config.hiveAnonAccount`:

```sql
AND (c.author IN (SELECT account FROM active_accreditations) OR c.author = $N)
```

The existing `accredCte` is already in scope. Append `config.hiveAnonAccount || ''` to the params list and use `accredCte.nextIdx + 2` as `$N`. Drop the now-vestigial `accreditedSet.has(reviewAuthor)` enrichment at line 86 unless the `is_accredited` flag distinguishes anon-proxy from direct-accredited (it does — leave the enrichment, see "is_accredited semantics" below).

**SQL filter (not enrichment-layer filter)** because:
- Defense-in-depth: the gate sits at the data layer; future refactors of `enrichReviewDetail` cannot leak unaccredited reviews.
- Consistency with paper-detail's `reviews: []` array filter (`papers.ts:1133` uses `c.author = ANY($6::text[])`).
- 404-path performance: SQL filter saves the parent-title roundtrip and the reputation lookup on rejected requests.
- Happy-path performance: identical to enrichment filter (HAF roundtrip dominates either way).

**Paper-detail reviews array** (`backend/src/routes/papers.ts:1133`, `GET /api/papers/:author/:permlink`) — already always-on filtered. No code change; verify with a test.

**Tests:**
- `reviews.test.ts` — `GET /api/reviews/:author/:permlink` for an unaccredited author returns 404. Same endpoint for an accredited author returns 200 with the review body. Same endpoint for a `hiveAnonAccount`-authored review returns 200 with `is_accredited: false` (anon-proxy distinguished from direct-accredited).
- `papers.test.ts` (or a new section in `reviews.test.ts` against the paper-detail endpoint) — for a paper that has reviews from both accredited and unaccredited authors, assert `GET /api/papers/:author/:permlink`'s `reviews: []` array contains only the accredited reviewers (plus `hiveAnonAccount` if it authored a review).

### 5. `is_accredited` field semantics

Unchanged. After all gates, the field's values are:
- **Papers:** `true` for accredited authors, `false` for bridge-paper exemption posts.
- **Comments:** always `true` post-gate (vestigial; remove only if doing so doesn't break frontend consumers — separate task if needed).
- **Reviews:** `true` for direct-accredited reviewers, `false` for `hiveAnonAccount` reviews. Anon-proxy distinction is meaningful for UI badging.

Do not remove the `is_accredited` field on any surface as part of this task. If the comments-side vestigial field bothers you, file a follow-up.

### 6. Contract & doc updates (already landed by architect)

The architect has already landed in the same commit that puts this task in `pending/`:
- `agents/docs/ARCHITECTURE.md` "Accredited-Only Data Policy" block rewritten as a hard-gate-everywhere policy with the bridge-paper exemption called out.
- `agents/docs/api-contracts/papers.md` — three `accredited_only` rows removed (papers list, comments list, search).
- `agents/docs/api-contracts/common.md` — accredited-only summary harmonized; explicit "no opt-out" note added.

Do not re-edit these files. If you discover another contract file that documents `accredited_only`, update it inline with this task.

## Why now

The display-filter invariant has no canary, and the gate itself was incoherent — opt-out branches on three endpoints with no consumer, and a leak on the reviews single-doc. We brainstormed E2E coverage and concluded the canary belongs at the backend integration tier, not Playwright — the assertion is query-shape, not user-journey. See session 2026-04-28. The architect's resolution block (below) expanded scope twice as the actual code shape was inspected.

## Implementation order suggestion

Each lane can be its own commit. Suggested order:

1. **Lane 4 reviews SQL gate + tests** — smallest, most contained. Adds the gate, asserts 404 for unaccredited single-doc, asserts paper-detail array exclusion. No existing tests to delete.
2. **Lane 1 papers list** — drop the opt-out branch, add the canary test, verify bridge-paper carve-out.
3. **Lane 2 comments list** — drop the opt-out branch, delete the existing opt-out exercises in `comments.test.ts:21,47`, add the canary.
4. **Lane 3 search** — drop the opt-out across all modes, add canary tests.

If any lane reveals a fixture gap (no unaccredited-author `APP_TAG` post in the test DB, no anon-account review in the test DB, etc.), file a follow-up rather than mocking.

## Out of scope

- UI-side affordance / banner behavior on `publish.js`/`review.js`/`edit.js` (separate UI task).
- Removing the now-vestigial `is_accredited: true` on comments (separate task if frontend doesn't consume the field).
- Researchers directory (`/api/accreditations`) is implicitly accredited-only because its source table is `active_accreditations`; no separate test needed unless the implementation drifts.
- Reviewing whether reviews-search at `search.ts:247` is reachable (the contract at `api-contracts/papers.md:470` says "reviews are not searchable via this endpoint" but the code has a reviews branch). Out-of-scope for this task; the gate applies to both branches regardless.

---

## Architect resolution (2026-04-28)

Backend's original `[BLOCKED by Architect]` flagged a real ambiguity in criterion #3 — the literal endpoint cited (`GET /api/reviews/:author/:permlink`) is a single-doc fetch with no opt-out, and the actual reviews-listing filter is hardcoded inside paper-detail with no opt-out either. The architect's first pass picked option (d) — hard-gate the reviews surface, leave papers/comments opt-outs alone. The user then challenged the asymmetry: "why are papers/comments retaining the flag? Accreditation is a hard gate there too."

Re-investigating, the architect confirmed:
- **Frontend has zero callers of `accredited_only=false`** (`grep -rn "accredited_only\\|accreditedOnly" frontend/`).
- **Only `comments.test.ts:21,47` exercises the opt-out**, and those tests assert the opt-out works — they don't reflect any UI need.
- **The bridge-paper carve-out is type-based, not opt-out-based** (`papers.ts:263`), so removing the opt-out doesn't affect bridge-paper visibility.
- **Architecture's stated principle ("publishing, reviewing, commenting, voting are restricted to accredited accounts")** is contradicted by surfacing opt-out paths that have no consumer and no documented use case.

**Resolution: harden the always-on filter across every PEvO surface. No asymmetry. No opt-out anywhere. Hard gate.**

Why this is the right call:
- **Coherence:** one mental model — "PEvO surfaces only show PEvO content." Easier for implementers, reviewers, and auditors.
- **Defense-in-depth:** removing the `accreditedOnly` branch eliminates the surface-area where a future refactor could re-enable the opt-out by accident.
- **No real loss:** zero frontend consumers, no documented moderation use case, bridge papers handled separately.
- **Spam resistance:** spraying `APP_TAG`-tagged content on Hive can no longer be made visible on PEvO surfaces by appending `?accredited_only=false` to a URL.

Why not "leave papers/comments alone, only gate reviews" (the architect's first pass):
- Treats reviews as special when the underlying principle is the same. Asymmetry would be a recurring source of "why is X different?" questions during code review.
- Leaves the dead opt-out in place as a footgun.

Why not "add opt-out everywhere for symmetry":
- No consumer. Manufactures a surface with no purpose, expanding the API contract without motivation.

Why not split into two tasks (one for reviews gate, one for opt-out removal):
- Single coherent invariant — the canary tests, the contract update, and the code change all serve the same "hard gate everywhere" stance. Splitting fragments the canary intent and introduces a window where the doc says one thing and the code another.

The ARCHITECTURE.md, `api-contracts/papers.md`, and `api-contracts/common.md` edits are landed in the same commit that moves this task to `tasks/pending/`. Backend implements code + tests across the four lanes above.

# BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP — Length-cap `?q=` and escape LIKE metacharacters

**Owner:** backend
**Created:** 2026-04-28 (surfaced by BE-DISCIPLINE-LENGTH-CAP review, adversarial reviewer P1)
**Priority:** P1

## Context

BE-DISCIPLINE-LENGTH-CAP (commit `602214f`) closed the per-request CPU DoS vector on `?discipline=` via a 100-char + Unicode-letter charset guard. The adversarial review surfaced that the sibling `?q=` field on `/api/search` is materially MORE exploitable than `?discipline=` was:

- `backend/src/routes/search.ts:94` — `ilikePattern = '%${query}%'` is bound to `c.title ILIKE $N OR c.body ILIKE $N` against the comments table.
- `backend/src/routes/search.ts:179` — same shape against reviews.
- `q` validation at `:278-282` is only the empty/whitespace check (`q.trim().length === 0` returns 400). No length cap, no LIKE-metacharacter handling.

Three concurrent issues:
1. **Unbounded length** — Node default URL/header limits (~7-8KB) bound the practical worst case, but per-request the bound parameter can be ~7900 bytes. The `LOWER()` and `ILIKE` cost per row scales with input size.
2. **Attacker-controlled LIKE wildcards** — `%` and `_` in user input become live LIKE metacharacters in the pattern. A payload of `%_%_%_…` injects N wildcards; Postgres LIKE backtracks per wildcard against every comment body the outer CTE admits. This is the dominant CPU vector vs. plain `LOWER()`.
3. **Full-body scan** — unlike `?discipline=` which binds to a single metadata field with `=`, `?q=` runs ILIKE against `c.title OR c.body` AND against review bodies (`:179`). Per-row cost is much higher than `?discipline=`.

Combined: distributed `?q=%_%_%_…&q=…&q=…` enumeration can tie up backend workers without hitting `callbackLimiter` (60 req/min/IP).

## Goal

Add input-validation + LIKE-metacharacter escaping at the entry of `?q=` on `/api/search`. Two distinct defenses:

1. **Length cap** — validate `q.length <= 200` BEFORE downstream work (LIKE pattern construction, SQL bind). Return `400 BAD_REQUEST { code: 'BAD_REQUEST', message: 'Search query too long' }` on violation.

2. **LIKE-metacharacter escape** — escape `\`, `%`, `_` to `\\`, `\%`, `\_` in the bound parameter, AND add `ESCAPE '\'` clause to both ILIKE call sites:
   - `backend/src/routes/search.ts:~94` — `c.title ILIKE $N ESCAPE '\' OR c.body ILIKE $N ESCAPE '\'`
   - `backend/src/routes/search.ts:~179` — `c.body ILIKE $N ESCAPE '\'`

   Apply the escape ONCE at the point where `q` is interpolated into the pattern (i.e., before `ilikePattern = ...`), so all ILIKE sites get the escaped value via a single bind parameter.

## Architect decision (baked in)

**Length: 200 chars.** Realistic multi-keyword search phrases fit in well under 200; longer is almost certainly malicious or a copy-paste accident.

**Escape strategy: backslash-escape + `ESCAPE '\'` clause.** Standard PostgreSQL idiom; survives across pg client versions; no application-side regex transformation. Equivalent shape: `q.replace(/[\\%_]/g, '\\$&')` then bind to `... ILIKE '%' || $N || '%' ESCAPE '\\'` (or build the pattern with the wildcards inside the helper, with the ESCAPE clause).

**Out of scope:** the broader Zod migration on sibling fields (`keyword`, `author`, `language`, `source`) tracked in `backend-zod-migration-extension.md`. This task is scoped to `?q=` only.

## Implementation notes

- New helper alongside `validateDisciplineFilter` if the result-shape refactor (BE-DISCIPLINE-LENGTH-CAP round-2 hold #2) lands first; same Result-shape return idiom. If the refactor is still pending, choose a return type compatible with what BE-DISCIPLINE-LENGTH-CAP eventually settles on.
- Escape function and length constant live in a sensibly-named module (e.g., `backend/src/types/search-filters.ts` or alongside the discipline filter constants — implementer's call).
- Confirm Node's default `http.maxHeaderSize` and Express body-parser settings are NOT relied upon as the primary defense; the route-level cap is.

## Tests

Real-HAF + carve-out coverage on `backend/tests/routes/search.test.ts`:
- 4KB `?q=...` (above 200, below Node URL limit) → `400 BAD_REQUEST` with the new message string.
- `?q=` containing `%`, `_`, `\` literal characters → returned in escaped form to the SQL binder; SQL run does not interpret them as wildcards. (Mocked-pool spec asserting the bound parameter contains `\%` `\_` `\\` rather than raw metacharacters; mirrors the `disciplines-canon-mocked.test.ts` pattern.)
- Long-but-valid 199-char `?q=` → `200`, exercises ILIKE path without `400`.
- Repeated `?q=a&q=b` — Express yields `string[]`; helper returns null/error; route either 400s or unfilters (decide once + document; recommend silent-unfilter to mirror `?discipline=` round-4 contract).

## Acceptance

- `400 BAD_REQUEST` on >200-char `?q=` (real-HAF integration spec).
- LIKE metacharacters in user input are escaped in bound SQL parameter (mocked-pool carve-out spec).
- `searchPapersFromHaf` and the reviews-search SQL site both use `ESCAPE '\\'` clause.
- No regression on the existing search specs.
- `papers.md` `/api/search ?q=` parameter row updated with the new validity rules + escape semantics. (Architect-owned; flag via `[TODO Architect]` in the task note before moving to `review/`.)

---

## Implementer re-review signal (2026-04-28, backend) — round 1

Landed in a single commit. Two distinct defenses on `?q=` are in place: 200-char length cap + LIKE-metacharacter escape with `ESCAPE '\\'` clause on every ILIKE site.

**Helper-module-location decision:** new file `backend/src/types/search-filters.ts` (sibling to `disciplines.ts`). Rationale: `disciplines.ts` was already 165 lines and the search-query semantics (LIKE escape) are conceptually distinct from discipline-filter semantics (charset + length); a sibling module reads cleaner than a monolithic one. Mirrors the discriminated-union Result-shape return idiom from `validateDisciplineFilter` exactly.

**Repeated-param semantics decision:** `?q=a&q=b` returns `null` from `validateSearchQuery` (silent-unfilter, mirrors the round-4 `?discipline=` contract). Since `q` is required, the route handler emits the existing `'Search query "q" is required'` 400 message rather than `'Search query too long'` — preserving observable behavior for absent-vs-too-long distinction. Same shape: empty / whitespace-only / `string[]` / non-string all fold into the `null` (absent) branch with the existing required-message; only `length > 200` returns `{ ok: false, message: 'Search query too long' }`.

**Code changes:**
- `backend/src/types/search-filters.ts` (new) — `SEARCH_QUERY_MAX_LEN = 200`, `escapeLikePattern()`, `validateSearchQuery()` with the discriminated-union return.
- `backend/src/routes/search.ts`:
  * Route entry (~line 273): replaced the inline `q` empty-check with `validateSearchQuery(req.query.q)` + null-then-not-ok branching. Preserves both 400 messages (`'Search query "q" is required'` and `'Search query too long'`).
  * `searchPapersFromHaf` (~line 86-94): added `ESCAPE '\\'` to both ILIKE sites in `textMatch` (c.title + c.body) AND to the orderBy CASE expression (3 ILIKE sites total).
  * `searchReviewsFromHaf` (~line 173): added `ESCAPE '\\'` to the c.body ILIKE site.
  * Added a comment block in each function explaining the pre-escape contract.

**Tests landed:**
- `backend/tests/lib/search-filters.test.ts` (new) — 21 helper-direct unit tests across 4 describe blocks (absent shapes, happy-path escape coverage, length boundary at 200/201, escapeLikePattern direct exposure).
- `backend/tests/routes/search.test.ts` (real-HAF) — 5 new specs in a `?q= input validation` describe block: 4KB → 400 too-long, 199-char → 200, whitespace-only → 400 required, `?q=a&q=b` → 400 required, `%_%_%_…` → 200 (escape neutralizes wildcards, no backtracking explosion).
- `backend/tests/routes/disciplines-canon-mocked.test.ts` (mocked-pool SQL contract) — 3 new specs: papers-search bound parameter is escaped (`%` → `\%`, `_` → `\_`, `\` → `\\`), papers-search SQL contains ≥2 `ESCAPE '\\'` occurrences, reviews-search SQL contains `ESCAPE '\\'`.

**Tests run** (with docker-IP env overrides per CLAUDE.md):
- `tests/lib/search-filters.test.ts` → 21/21 passed.
- `tests/routes/disciplines-canon-mocked.test.ts` → 19/19 passed (was 16; +3 new cases).
- `tests/routes/search.test.ts` (real-HAF) → 19/19 passed (was 14; +5 new cases).
- Combined pass count: 59/59.
- `npm run lint` clean (2 pre-existing warnings on `seed-phrase.ts` unchanged).

### [TODO Architect]

**Contract update needed (architect-owned, before archive):**
- `agents/docs/api-contracts/papers.md` `/api/search` block — add validity rules to the `?q=` parameter row:
  * **Length:** required; 1-200 raw chars (post-URL-decode, pre-trim). The whitespace-only branch short-circuits to the absent path *before* the length check, so trailing whitespace still counts against the 200 budget when any non-whitespace content is present.
  * **400 errors:** `'Search query "q" is required'` on absent / empty / whitespace-only / repeated `?q=a&q=b` shapes; `'Search query too long'` on > 200 raw chars.
  * **LIKE-metacharacter handling:** literal `%` `_` `\` in the query are matched as literal characters (escaped server-side); they cannot be used to inject SQL LIKE wildcards. (Implementation detail — the escape is invisible to clients; surfacing it in the contract makes the security guarantee explicit for AGPL forks.)

---

## Architect re-review (2026-05-15) — HELD PENDING FIXES

`/ce-code-review` returned 1 P1 (missed-scope on `/api/accreditations` — split into new task `backend-accreditations-likeguard`, not blocking this archive) + 1 P2 (assertion strength on this task's mocked-pool spec — blocks archive). Other findings dismissed; see triage chat. The single fix for this task:

1. **Tighten the papers-search ESCAPE-count assertion** at `backend/tests/routes/disciplines-canon-mocked.test.ts:494-496`. Current assertion is `expect(occurrences).toBeGreaterThanOrEqual(2)`; post-fix code emits exactly 3 `ESCAPE '\\'` occurrences on the papers data query (textMatch c.title + textMatch c.body + ORDER BY CASE c.title). Change to `expect(occurrences).toBe(3)` so a regression that drops the ORDER BY CASE `ESCAPE` clause (while leaving textMatch sites clean) surfaces as a test failure rather than passing silently. Update the inline comment to match (the "at least 3 total" line already names the count). No source changes needed.

---

## Backend re-review signal (2026-05-15, commit `aea0396` on `main`)

Single round-1 hold item landed:

- **Item 1 [P2]** `backend/tests/routes/disciplines-canon-mocked.test.ts:881`: assertion tightened from `expect(occurrences).toBeGreaterThanOrEqual(2)` to `expect(occurrences).toBe(3)`. Inline comment expanded to name the regression class the exact-count pin catches (dropped `ESCAPE` on the ORDER BY CASE while leaving textMatch sites clean). No source changes — assertion-only.

Verification: typecheck + lint clean on main (pre-existing seed-phrase warnings only).

The `git mv` to `tasks/review/` is the re-review signal.

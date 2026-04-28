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

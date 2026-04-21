# BE-DISCIPLINE-CANONICALIZE — Canonicalize disciplines via LOWER() in HAF query + case-insensitive search match

**Owner:** backend
**Created:** 2026-04-21 (surfaced by FE-DISCIPLINE-CASE-NORMALIZE archive review 2026-04-21d)
**Priority:** P1

## Context

FE-DISCIPLINE-CASE-NORMALIZE shipped client-side lowercasing of discipline names to canonicalize the URL layer. But the backend's `GET /api/disciplines` in `backend/src/routes/disciplines.ts` was an open-vocabulary HAF query (`GROUP BY (json_metadata -> $1 ->> 'discipline')` — case-sensitive). If users typed both "Physics" and "physics" into paper metadata, the backend returned two rows; the frontend spread collapsed both to `name: "physics"` but kept each paper_count separate, yielding duplicate dropdown entries with mismatched counts. Additionally, `?discipline=physics` in `search.ts` matched only the lowercase HAF group, silently missing papers tagged "Physics."

## Goal

Close the open-vocabulary dedup bug at the backend layer.

1. **`disciplines.ts`:** dedup HAF query by `LOWER(name)`. Response shape becomes `{ canon_name, display_name, paper_count }` where `display_name = MAX(name)` over the lowercase group.
2. **`search.ts`:** `?discipline=physics` matches via `LOWER(json_metadata -> $1 ->> 'discipline') = $N`.
3. Contract update on whichever `api-contracts/*.md` documents disciplines.
4. Real-HAF tests for dedup + case-insensitive search match.

## Non-goals

Rewriting the discipline schema. Normalizing disciplines at ingest time (would require a backfill).

## Unblocks

FE-DISCIPLINE-DISPLAY-HARDEN part 2 (frontend can drop client-side dedup once this archives).

## Implementation notes

Landed at commit **d6c2bb1** ("BE-DISCIPLINE-CANONICALIZE: dedup disciplines + ?discipline= match via LOWER()"). Full backend vitest 39 files / 268 pass + 3 skipped against real HAF/Postgres/Redis.

- **`backend/src/routes/disciplines.ts`** — HAF query now groups/dedups by `LOWER(json_metadata -> $1 ->> 'discipline')`. Response shape grew to `{ canon_name, display_name, paper_count }`.
- **`backend/src/routes/search.ts`** — `?discipline=` applies `LOWER(...) = $N` on both sides (query param lowercased before binding).
- **`agents/docs/api-contracts/misc.md`** — disciplines section updated with new shape, canon_name/display_name semantics, match semantics, and frontend migration note. Authored by implementer; backend boundary rule deviation acknowledged — task spec explicitly required the contract update.
- **`backend/tests/routes/disciplines.test.ts`** — new real-HAF test file: 4 specs on disciplines response (shape, lowercase canon_name, uniqueness, display_name lowercases to canon_name) + 1 spec asserting uppercase/lowercase `?discipline=` parity on `/api/search`. Since HAF cannot be seeded with mixed-case fixtures, assertions are invariant-based rather than known-duplicate-value based.

## [TODO Architect]

1. **Contract-file prose review.** Per backend CLAUDE.md boundary rule ("Do NOT edit `agents/docs/api-contracts/*.md`"), implementer wrote the disciplines update in `misc.md` because the task spec explicitly required it. Please review/rewrite the prose as needed; I kept it factual and migration-oriented.
2. **Parallel bugs surfaced out-of-scope.** Two sibling sites have the same case-sensitive handling the task explicitly did not fix:
   - `backend/src/routes/papers.ts:226` — identical case-sensitive `?discipline=` filter bug.
   - `backend/src/routes/stats.ts:59` — double-counts `active_disciplines` by case.
   Worth a follow-up Pending task.
3. **Unblocks FE-DISCIPLINE-DISPLAY-HARDEN part 2.** Frontend can now switch to `canon_name` / `display_name` and drop client-side dedup once this archives.

---

**Architect re-review (2026-04-21) — HELD PENDING FIXES:**

Round-1 `/ce-code-review` on commit `d6c2bb1` (10 personas: correctness, testing, security, performance, maintainability, api-contract, project-standards, kieran-typescript, ce-agent-native, ce-learnings-researcher). Cross-reviewer convergence on 3 P1 findings and several P2/P3s. Hold-block items below; dismissed findings enumerated at end.

1. **P1 — Apply LOWER() normalization at 3 sibling sites** (correctness+api-contract+maintainability+kieran-typescript, 4-reviewer convergence). The task fixed `search.ts:67` but left three siblings with the same case-sensitive pattern the commit establishes case-insensitivity for:
   - `backend/src/routes/papers.ts:226` — `?discipline=` filter still exact-match. Frontend `paper-feed.js` calls this endpoint (not `/api/search`), so the primary paper listing page silently misses mixed-case-tagged papers.
   - `backend/src/routes/stats.ts:59` — `count(DISTINCT (json_metadata -> $1 ->> 'discipline'))` without `LOWER()`. Inflates `active_disciplines` count relative to the deduped `/api/disciplines` response.
   - `backend/src/routes/search.ts:290` — `rawKey` for `searchCache.getOrSet` uses raw `discipline || ''` (not lowercased). `?discipline=Physics` and `?discipline=physics` populate independent cache entries; the SQL dedup is defeated at the cache layer.

   Fix all three with the same pattern from the original task: `LOWER(json_metadata -> $N ->> 'discipline')` on the SQL side, `.toLowerCase()` on the bound param AND on the cache-key component. Extract a small helper if the duplication bothers you; inline is also fine at 3 sites.

   Tests: per-site (a) `papers.test.ts` — mixed-case `?discipline=` parity spec; (b) `stats.test.ts` — assert `active_disciplines` matches `/api/disciplines.data.length` when a mixed-case corpus exists OR assert via mocked-pool carve-out; (c) `search.test.ts` — two requests with case-variant `?discipline=` values serve from the same cache entry (pool invoked once, second request cache-hit).

2. **P1 — Backend-side backward-compat shim for `name` field** (correctness+api-contract+maintainability+kieran-typescript, 4-reviewer convergence). `/api/disciplines` response dropped the `name` field in favor of `canon_name`/`display_name`. Frontend consumers (`paper-feed.js:17-18, 182`, `search.js:52-53, 252-257`) still read `d.name`. Until FE-DISCIPLINE-DISPLAY-HARDEN part 2 lands and flips consumers to `display_name`, add `name: row.display_name` to the response mapping in `disciplines.ts` so dropdowns don't silently go blank on any deploy where backend leads frontend. Remove the shim in a follow-up once the FE task archives. Also update `agents/docs/api-contracts/misc.md` to document the shim as a deprecated-pending-removal alias.

3. **P2 — `disciplines.ts:47` returns `null` on pool-unavailable path**. `sendOk(res, null)` violates the `data: Array` contract. Change `fetchDisciplinesFromHaf` to return `[]` instead of `null` on the `if (!pool)` branch (or handle at the caller). Add one test: mock pool unavailable, assert `res.body.data` is an array (not null).

4. **P3 — Mocked-pool dedup test**. The core bug (Physics + physics → 2 rows pre-fix, 1 row post-fix) has no deterministic test. Real HAF cannot be seeded with mixed-case fixtures, which squarely satisfies the root CLAUDE.md mocked-pool carve-out. Add one spec in a new `disciplines-dedup.test.ts` (or as a carve-out block within the existing file with an extended header justification): inject `[{name:'Physics',paper_count:1},{name:'physics',paper_count:2}]` via a mocked pool against the post-canonicalization query, assert the response contains exactly one row with `canon_name:'physics'` and `paper_count:3`.

5. **P3 — `hafCache.clear()` in `beforeEach` of `disciplines.test.ts`**. Specs 2-4 silently read spec 1's warm cache. Mirror the pattern from `accreditations-revoke.test.ts` (commit `4dae6a9`): `beforeEach(async () => { await hafCache.clear(); });`.

**Dismissed from round-1 findings:**
- Boundary rule violation (backend wrote `misc.md` directly). Task spec explicitly authorized the edit and `[TODO Architect]` flag is present. Convention doc `agents/docs/solutions/conventions/backend-api-contracts-are-architect-owned-2026-04-21.md` already covers the rule. Future task specs should avoid authorizing backend-side contract edits; this task's deviation is properly documented.
- Shape spec doesn't assert old `name` field absent. **Conflicts with hold item #2** (we're ADDING the `name` alias back as a shim). No test change warranted.
- No TS `Discipline` interface. Pre-existing pattern across routes; not introduced by this commit.
- Postgres LOWER() vs JS toLowerCase() Unicode divergence (RR-1 in multiple reviewers). Low risk given ASCII-range discipline names; re-open if non-ASCII disciplines land.

**Filed as separate Pending tasks (out of scope for this hold):**
- `backend-display-name-titlecase.md` — P3 design decision. `MAX(name)` yields lowercase for ASCII inputs (Postgres text MAX uses collation where lowercase codepoints > uppercase), making `display_name === canon_name` in practice. Consider `INITCAP(LOWER(...))` as the display representative. Affects frontend rendering, warrants discussion.
- `backend-discipline-length-cap.md` — P3 input validation. No length cap on `?discipline=` before `LOWER()` hits Postgres. DoS-adjacent (unbounded Unicode locale processing), not injection-exploitable. Add a guard at the route entry.

**Path to re-archive:** (1) Backend agent applies items #1-5 on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-2 with `/ce-code-review` and archives. Filed follow-up tasks (`backend-display-name-titlecase.md`, `backend-discipline-length-cap.md`) are archived independently later.

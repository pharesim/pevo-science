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

---

**Backend re-review signal (2026-04-22, working tree on `main` post hold-block fixes):**

All 5 hold items addressed. Full backend vitest 282/286 pass + 3 skipped + 1 pre-existing SEC-004-BE ≥50ms flake (dismissed in `backend-login-unknown-user-timing.md` hold block as "ship as-is" — argon2-verify floor on this hardware is 42-55ms; unrelated to this task's diff). Discipline-affected tests in isolation: 19/19 pass across `disciplines.test.ts`, `disciplines-canon-mocked.test.ts`, `papers.test.ts`. `npx tsc --noEmit` clean.

1. **LOWER() normalization at 3 sibling sites (P1 fixed).**
   - `backend/src/routes/papers.ts:225-232` — `?discipline=` now matches via `LOWER(c.json_metadata -> ${appTagParam} ->> 'discipline') = $N` with the bound parameter lowercased. The primary paper-feed endpoint no longer silently drops mixed-case-tagged papers.
   - `backend/src/routes/stats.ts:59` — `count(DISTINCT LOWER(json_metadata ...))::int` replaces the case-sensitive DISTINCT. `active_disciplines` KPI now matches the `/api/disciplines` canon dedup contract.
   - `backend/src/routes/search.ts:290` — `rawKey` cache-key fragment lowercases the discipline input so `?discipline=Physics` and `?discipline=physics` share a single Redis cache entry (the SQL was already LOWER()-equivalent; the cache-key drift defeated that dedup at the memoization layer).
   - Tests: `papers.test.ts:48-62` real-HAF parity spec (lowercase-vs-uppercase returns same total and same author/permlink set); `disciplines-canon-mocked.test.ts` stats-SQL-shape spec asserts `count(DISTINCT LOWER(json_metadata` in the active_disciplines column; `disciplines-canon-mocked.test.ts` papers-filter-SQL-shape spec asserts `LOWER(c.json_metadata` on column AND `'physics'` (lowercased) on the bound parameter; `disciplines-canon-mocked.test.ts` search cache-key spec fires two case-variant requests and asserts the main search SQL was invoked ≤1 times.

2. **Backend-side `name` backward-compat shim (P1 fixed).** `backend/src/routes/disciplines.ts:41-50` — response mapping explicitly emits `{canon_name, display_name, name: display_name, paper_count}`. `name` is the deprecated-pending-removal alias. `agents/docs/api-contracts/misc.md:111-124` documents the alias as a transient shim and steers new consumers to `display_name` / `canon_name`. Contract update kept narrow per boundary rule — no new shapes introduced beyond the single alias.

3. **Pool-unavailable returns [] (P2 fixed).** `disciplines.ts:17-19` — `if (!pool) return [];` with an inline comment tying the change to the `data: Array<Discipline>` envelope contract. Test at `disciplines-canon-mocked.test.ts:85-93` flips a module-level `hafPoolEnabled = false` so `getPool()` returns null, asserts response is `200` with `data: []`.

4. **Mocked-pool dedup test (P3 landed).** New file `backend/tests/routes/disciplines-canon-mocked.test.ts` carries the carve-out (header comment explains why the mock is justified vs real-HAF — the public HAF database cannot be seeded with mixed-case fixtures, which squarely satisfies the root CLAUDE.md mocked-pool carve-out). Test simulates the post-canonicalization SQL result (single deduped row) AND asserts the SQL string contains `LOWER(json_metadata` + `GROUP BY LOWER(json_metadata` so a regression to the old case-sensitive query fails. Also carries the sibling tests for Holds #1(b), #1(c), #2, #3 in the same file rather than scattering across multiple new files (per no-file-sprawl convention).

5. **`hafCache.clear()` in beforeEach (P3 landed).** `backend/tests/routes/disciplines.test.ts:6-16` — imports `hafCache` from `../../src/cache.js` and clears it in `beforeEach` at the file-top (outside any describe block so it applies to every spec). Mirrors the `accreditations-revoke.test.ts:42-48` pattern the hold block referenced. Same pattern also lives inside `disciplines-canon-mocked.test.ts:46-50` (scoped to its own mocked-pool tests).

**Deviations from hold block:**

- **Stats active_disciplines parity test shape.** The hold block offered two options for Hold #1(b): "`active_disciplines` matches `/api/disciplines.data.length` when a mixed-case corpus exists OR assert via mocked-pool carve-out." The real-HAF parity invariant does NOT hold because `stats.ts` filters papers by `active_accreditations` (line 37 papers CTE) while `/api/disciplines` does not. The two endpoints count different sets — a real `active_disciplines === data.length` assertion would fail on a HAF where papers exist but aren't accredited (currently 0 vs 2 on the live pevotest chain). I went with the mocked-pool carve-out option instead, asserting the SQL shape directly via `expect(sql).toMatch(/count\(DISTINCT LOWER\(json_metadata/)`. A future architect pass may want to either widen `/api/disciplines` to also filter by accreditation (per the accredited-only data policy in `ARCHITECTURE.md`) or acknowledge the divergence in the contract. Filing this as noted but not blocking on it.
- **Test file placement.** Hold #4 suggested either `disciplines-dedup.test.ts` (new file) OR a carve-out block inside `disciplines.test.ts`. I went with the new-file option and consolidated Holds #1(b), #1(c), #2, #3 mocked-pool coverage into the same file (`disciplines-canon-mocked.test.ts`) rather than fragmenting into three per-hold files. The shared `hafQueryMock` + `hafPoolEnabled` scaffolding is set up once at the top; splitting would duplicate it three times.

**Dismissed-finding still-dismissed:** boundary-rule violation (contract edit was explicitly authorized by the hold block for #2), no TS Discipline interface (pre-existing), Postgres LOWER() vs JS toLowerCase() Unicode divergence (ASCII-range disciplines; reopen if non-ASCII lands).

**Filed follow-up still-pending:** `backend-display-name-titlecase.md`, `backend-discipline-length-cap.md` — per architect's hold block, independent archive path.

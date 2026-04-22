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

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES (round 2):**

Round-2 `/ce-code-review` on commit `3d68ee6` (9 personas: correctness, testing, maintainability, project-standards, api-contract, performance, kieran-typescript, ce-agent-native, ce-learnings-researcher). The 5 round-1 hold items were each applied, but the review pass surfaced 7 new items that keep the task in held-pending-fixes. Hold-block items below.

1. **P1 — Vacuous cache-key test for Hold #1c** (testing T-01 0.97 + correctness COR-003 0.70 + kieran-typescript RR-2 0.80 — 3-reviewer convergence). `backend/tests/routes/disciplines-canon-mocked.test.ts:442-446` filters `hafQueryMock.mock.calls` on SQL containing `ts_rank | plainto_tsquery | websearch_to_tsquery`. The actual `searchPapersFromHaf` SQL uses **ILIKE** exclusively — those tokens appear nowhere in the search route source. Filter always matches zero calls; `toBeLessThanOrEqual(1)` trivially passes at 0 matches. A revert of `backend/src/routes/search.ts:296` lowercasing passes this test green. The test provides **zero regression protection** for Hold #1c. Fix: change the filter predicate to match a token actually in the search SQL (e.g., `ILIKE`, a stable CTE body fragment). Tighten the assertion from `toBeLessThanOrEqual(1)` to `toBe(1)` so the test can't pass at 0 matches. Before committing, locally revert the `search.ts:296` lowercasing and confirm the test fails; then restore and confirm it passes.

2. **P1 — `name` shim is protecting zero live consumers; remove** (maintainability M-1 0.92, verified by architect grep). The hold block cited `paper-feed.js:17-18, 182` and `search.js:52-53, 252-257` as consumers reading `d.name`. Verified at round-2 architect time: `grep -rn '\bd\.name\b' frontend/src/` returns zero hits on discipline iterations. `frontend/src/components/paper-feed.js:17` uses `:key="d.canon_name"` / `:value="d.canon_name"` / `x-text="d.display_name"`; `frontend/src/pages/search.js:52` matches. Commit `7961ac0` (FE-PAPERS-BROWSE-DISCIPLINE-OPTION-HYDRATION-RACE) migrated the FE consumers 12 minutes BEFORE this task's round-2 commit landed, so by the time the implementer applied Hold #2, the shim's premise was already stale. Remove the shim (3 LOC in disciplines.ts map), remove the `- \`name\` — **deprecated...**` line in `api-contracts/misc.md` (also closes PS-001 emdash violation), remove the Hold #2 shim-present assertion block in `disciplines-canon-mocked.test.ts`. Append a note to the re-review signal about the FE-migrated-before-BE-shim-landed timing — worth capturing for `/ce-compound` at archive time.

3. **P2 — Pool-unavailable `return []` poisons the stable cache** (correctness COR-001 0.82). `hafCache.getOrSet` at `backend/src/cache.ts:73` skips caching only on `null` / `undefined` — `[]` gets written as a `stable=true` 60s entry and `clearVolatile()` doesn't evict `stable=true`. Pre-Hold-#3: `null` return → not cached → transient HAF outage recovers in ~100ms → next request retries. Post-Hold-#3: `[]` return → cached 60s → transient outage degrades the disciplines dropdown for a full minute even after HAF recovers. Keep `return null` in `fetchDisciplinesFromHaf` (preserves the `hafCache` skip-on-null semantic) and apply the array-guard at the router: `sendOk(res, (await hafCache.getOrSet(...)) ?? [])`. Add a test that verifies pool-unavailable does NOT cache: seed the test to fail pool, call `/api/disciplines`, re-enable pool, assert the next call queries HAF (mock's call count goes up).

4. **P2 — `startStatsCache()` test pattern is brittle + leaks setInterval** (testing T-02 0.88 + maintainability M-3 0.78 + kieran-typescript KT-1 adjacent 0.85). `disciplines-canon-mocked.test.ts:139-141` exercises `fetchStatsFromHaf` by invoking `startStatsCache()` — bypasses the HTTP route path (`router.get('/')` reading cache), registers an unref'd `setInterval` that can fire after `beforeEach` resets `hafQueryMock` (contaminating later mock-count assertions), and is a one-off pattern not used elsewhere in the codebase. Fix: exercise via `request(app).get('/api/stats')` after cache warmup. Add `afterEach` cleanup of the setInterval, or replace the invocation with a test-only export of `fetchStatsFromHaf`. Keep the SQL-shape regex assertion (that was the point of Hold #1b) — don't lose the LOWER() coverage in the refactor.

5. **P2 — `papers.test.ts` parity spec vacuously passes on empty corpus** (testing T-03 0.85). `backend/tests/routes/papers.test.ts:48-58` asserts uppercase and lowercase `?discipline=PHYSICS` / `physics` return same total + same author+permlink set. On empty HAF (no `physics`-tagged papers), both return `total=0` and `data=[]`; the assertion trivially passes. Live pevotest beta may be exactly this state. Fix: add a skip/assumption guard — either `ctx.skip()` when `lower.body.meta.total === 0` with an explanatory comment (matches `disciplines.test.ts:83-91` style), OR extend the mocked-pool file to cover the SQL-shape invariant with seeded mixed-case fixtures (already pays for itself given Hold #1b also lives there). Implementer's choice between the two shapes.

6. **P2 — search.ts split-responsibility lowercasing** (correctness COR-002 0.75 + api-contract RR-002 low). `backend/src/routes/search.ts:296-298` lowercases the cache-key fragment but passes the unmodified original `discipline` to `searchFromHaf`, which then lowercases AGAIN before SQL binding. Three independent lowercasing sites (cache key at 296, inner SQL binding at 68, and a future 4th if anyone forgets). Correct today but fragile — a future refactor removing the inner SQL `toLowerCase()` on the assumption that callers normalize (as `papers.ts` does at the call site) silently breaks cache-hit-correctness. Fix: lowercase once at route entry — `const discipline = (req.query.discipline as string | undefined)?.toLowerCase()` — and remove the duplicated `.toLowerCase()` calls downstream. Compile + test to confirm behavior unchanged.

7. **P3 — Test-hygiene pass on `disciplines-canon-mocked.test.ts`** (bundles testing T-04 0.80 + T-05 0.81 + kieran-typescript KT-3 0.75 + maintainability M-2 0.81 + kieran-typescript KT-1 0.85). Five related small items in the same file:
   - No test for the catch branch of `fetchDisciplinesFromHaf` (pool-exists-but-query-throws). Add a spec using `hafQueryMock.mockRejectedValueOnce(new Error('HAF down'))` asserting 200 + `data: []` response.
   - Hold #2 shim test at `:330-343` doesn't guard alias-value drift. Current assertion passes even if `name: row.canon_name.toUpperCase()` — strengthen to assert `row.name === row.display_name` across multiple representative rows. (Moot if hold item #2 removes the shim; coordinate.)
   - File header at `:34` references `getPool() / getAppPool()` but no route under test imports from `app-db.ts`. Replace with just `getPool()`.
   - Mock-callback assertion pattern (`sawStatsQuery`, `sawDisciplineFilter` with `expect` inside the mockImplementation body) is fragile — a failing assertion thrown inside the mock fires at uncertain times. Prefer the search-call-count pattern at `:192-196` (capture values in the mock, assert after the request).
   - Module-level `hafPoolEnabled` mutable `let` flag — rescope to a describe-block-local mutation or inline `.mockReturnValueOnce(null)` on `getPool` in the single test that needs a null pool.

**Dismissed from round-2 findings (architect triage):**
- **P3** HAF functional-index request for LOWER() on `hafsql.comments` (PERF-001 performance 0.82): beta scale invisible; defer per user triage. Revisit when QPS or paper-count warrants.
- **P3** Deprecation trigger is task-slug not version (api-contract AC-002 0.72): subsumed by hold #2 (shim removal).
- **P3** No machine-readable `Deprecation` header for name shim (ce-agent-native obs 1): subsumed by hold #2.
- **P3** Emdash in user-facing contract text at `misc.md:122` (project-standards PS-001 0.92): subsumed by hold #2 (line deleted when shim is removed).

**Filed as separate Pending tasks (out of scope for this hold):**
- None. All out-of-scope items either subsumed by hold #2 or dismissed above.

**Architect-side execution (landed in the 2026-04-22a commit, before this hold block):**
- `agents/docs/api-contracts/misc.md` /api/stats section — field-level notes on `active_disciplines` semantic change (case-sensitive DISTINCT → LOWER DISTINCT) and accredited-only vs all-papers set divergence. Closes api-contract AC-001.

**Path to re-archive:** (1) Backend applies items #1-7 on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-3 with `/ce-code-review` and archives when clean. `/ce-compound` candidate at archive time: capture the "FE-migrated-before-BE-shim-landed" timing failure as a learning about cross-task hold-block staleness.

---

**Backend re-review signal (2026-04-22 round-3, commit `d5dc7a0`):**

All 7 round-2 hold items addressed. Directly-affected vitest files in isolation: 18 passed + 1 skipped across `disciplines.test.ts` (5 specs), `disciplines-canon-mocked.test.ts` (6 specs rewritten), `papers.test.ts` (8 specs incl. the new `ctx.skip()` branch). `npx tsc --noEmit` clean. Full suite NOT run in this worktree per worker ground rule #5; parent agent to run it after merge.

1. **Hold #1 — Vacuous cache-key filter fixed (P1).** `disciplines-canon-mocked.test.ts` cache-key test now filters `hafQueryMock.mock.calls` on `sql.includes("->> 'type') AS type,")` — a stable fragment from the papers-search data-query SELECT list that is absent from papers-count, reviews count/data, and the accredited-set batch lookup. Assertion tightened to `toHaveLength(1)` (exactly one papers-search data query across the two case-variant requests).

2. **Hold #2 — `name` shim removed (P1).** `disciplines.ts` map now emits `{canon_name, display_name, paper_count}` — three fields, no alias (comment block explaining the shim also removed). `disciplines-canon-mocked.test.ts` Hold #2 shim-present describe-it block deleted. **DEFERRED TO ARCHITECT (out-of-scope per worker ground rule #2):** `agents/docs/api-contracts/misc.md:111-124` still documents the deprecated `- \`name\`` alias line — per backend-contract-edit boundary rule, backend workers do not edit contract files. Architect must remove the corresponding `- \`name\` — **deprecated-pending-removal**...` line in `misc.md` during round-3 review (this also closes round-2 dismissed PS-001 emdash violation at `misc.md:122`).

   **`/ce-compound` timing note:** FE-DISCIPLINE-DISPLAY-HARDEN-related commit `7961ac0` migrated FE consumers to `canon_name`/`display_name` 12 minutes BEFORE the round-1 Hold #2 shim landed, so the shim was protecting zero live consumers from the moment it landed. Captures an interesting failure mode: hold-block rationale stales when cross-task commits land between the architect's review and the implementer's fix. Consider capturing as a learning under `agents/docs/solutions/conventions/` on archive.

3. **Hold #3 — Pool-unavailable cache-skip (P2).** `disciplines.ts:16` — `fetchDisciplinesFromHaf` returns `null` on pool-unavailable AND on query-catch; `hafCache.getOrSet` skips caching null sentinels (`cache.ts:73`). Router coerces `null ?? []` at `sendOk` so `data: Array<Discipline>` envelope contract still holds. Test at `disciplines-canon-mocked.test.ts` (Hold #3 describe-it) verifies: request 1 with `getPoolMock.mockReturnValueOnce(null)` → `data: []`, `hafQueryMock` call count stays at 0 → request 2 with pool restored → HAF is re-queried (call count goes to 1). Pre-fix `return []` behavior would cache the empty sentinel for 60s stable → post-recovery requests would still serve `[]` and call count would stay at 0 on request 2 → test fails.

4. **Hold #4 — Stats test via HTTP route (P2).** `disciplines-canon-mocked.test.ts` active_disciplines SQL-shape test now exports and calls `fetchStatsFromHaf()` directly (added `export` at `stats.ts:22`), primes the cache with `hafCache.set('stats', stats, 60_000, true)`, then hits `/api/stats` via supertest. No `startStatsCache()` → no unref'd setInterval leak → no late-firing mock contamination of later specs. SQL-shape regex `count\(DISTINCT LOWER\(json_metadata` retained so the LOWER() coverage from round-1 hold #1b is preserved.

5. **Hold #5 — `papers.test.ts` skip on empty corpus (P2).** `papers.test.ts:48-69` now `ctx.skip()`s when `lower.body.meta.total === 0` with an explanatory comment steering the reader to `disciplines-canon-mocked.test.ts` for the deterministic SQL-shape pin. Mirrors the `disciplines.test.ts` skip style. Currently skips on live pevotest (no `physics`-tagged accredited papers); mocked-pool counterpart carries the regression coverage.

6. **Hold #6 — search.ts single-site lowercasing (P2).** `search.ts:287` — `discipline` is now lowercased ONCE at route entry (`(req.query.discipline as string | undefined)?.toLowerCase()`). Downstream: SQL binder at `:68` just pushes `discipline` (no duplicate `.toLowerCase()`); cache-key fragment at `:296` just interpolates `discipline || ''` (no duplicate `.toLowerCase()`). Three-site duplication collapsed to one source of truth.

7. **Hold #7 — Test-hygiene pass on `disciplines-canon-mocked.test.ts` (P3).** Five sub-items:
   - **(a) Catch-branch test added** — new Hold #7a describe-it: `hafQueryMock.mockRejectedValueOnce(new Error('HAF down'))` → asserts 200 + `data: []` + no cache poisoning (next call re-queries HAF).
   - **(b) Alias-drift assertion** — moot: hold #2 removed the shim test entirely.
   - **(c) File header** — line 34 now references only `getPool()` (no `getAppPool()`), since no route under test imports from `app-db.ts`.
   - **(d) `expect` out of mock bodies** — all four mock-callback sites (dedup SQL-shape, stats SQL-shape, papers filter SQL-shape, cache-key filter) now capture values into local `let capturedSql` / `capturedParams` variables and assert AFTER the request. No more `expect` inside `mockImplementation` bodies (they threw at uncertain times and could cross-contaminate subsequent specs).
   - **(e) `hafPoolEnabled` rescoped** — module-level mutable `let` flag removed. Replaced with a `getPoolMock` that `beforeEach` resets to `mockReturnValue({ query: hafQueryMock })`, and the one test that needs a null pool uses `getPoolMock.mockReturnValueOnce(null)` inline. Mirrors standard vitest mock reset/override patterns used elsewhere in the backend test suite.

**Deviations from hold block:**

- **Cache-key filter on `AS type,` (not ILIKE).** Hold #1 suggested `ILIKE / a stable CTE fragment`. `ILIKE` appears in BOTH papers count+data AND reviews count+data (4+ matches per search request) — too fuzzy for `toBe(1)`. `retracted_papers AS (` is in the papers-search CTE only but appears in both count and data queries (2 matches per search). `AS type,` uniquely identifies the papers-search DATA query (the one that materializes result rows) — exactly 1 match per cache-missing papers-search invocation. Cleanest `toBe(1)` framing.
- **`misc.md` `name`-alias line removal deferred to architect.** Per backend worker ground rule #2 (the fan-out instruction), backend workers do not edit `agents/docs/api-contracts/*.md`. Flagged explicitly in Hold #2 signal above for architect round-3 action.

**Dismissed-finding still-dismissed:** boundary-rule violation (contract edit was explicitly authorized by round-1 hold #2), Postgres LOWER() vs JS toLowerCase() Unicode divergence (ASCII-range disciplines; reopen if non-ASCII lands).

**Filed follow-up still-pending:** `backend-display-name-titlecase.md`, `backend-discipline-length-cap.md` — per architect's hold block, independent archive path.

---

**Architect re-review (2026-04-22, round 3) — HELD PENDING FIXES:**

Round-3 `/ce-code-review` on commit `d5dc7a0` (11 personas including adversarial + kieran-typescript). All 7 round-2 hold items correctly applied. The pass surfaced two new items that promote on cross-reviewer convergence and block archive. The other P3 residuals are polish and noted inline where held items touch the same site.

1. **P1 — `papers.ts` cache key still uses raw (non-lowercased) discipline; Hold #6 pattern not mirrored to sibling endpoint** (correctness 0.97 + testing 0.92 + performance 0.92 + reliability 0.88 + adversarial 0.97 + maintainability 0.72, 6-reviewer convergence). `backend/src/routes/papers.ts:433` reads `const discipline = req.query.discipline || ''` with no `.toLowerCase()`; cache key at `:440` embeds the raw value (`d=${discipline}`); `fetchPapersFromHaf` re-reads `req.query.discipline` and lowercases only at SQL bind (line 232). Result: `?discipline=Physics` and `?discipline=physics` produce distinct Redis cache entries with identical SQL results on `/api/papers` — the PRIMARY paper-feed endpoint. Same three-site split-responsibility failure mode that Hold #6 (round-2) closed in `search.ts`. Fix: apply the `search.ts:287` pattern to `papers.ts:433` (`(req.query.discipline as string | undefined)?.toLowerCase()`), drop the inner `.toLowerCase()` at `papers.ts:232`, and add a mocked-pool cache-parity test to `disciplines-canon-mocked.test.ts` analogous to the search Hold #1(c) spec (two case-variant requests + `toHaveLength(1)` on the papers-data SQL filter). The convention doc `object-shape-fix-every-reset-site-2026-04-21.md` directly applies.

2. **P2 — Unsafe `as string | undefined` assertion on `req.query.discipline`** (kieran-typescript KT-1 0.85). `(req.query.discipline as string | undefined)?.toLowerCase()` at `search.ts:287` is a type assertion, not narrowing. Express's `@types/express` types `req.query[k]` as `string | ParsedQs | string[] | ParsedQs[] | undefined`. A repeated query parameter (`?discipline=a&discipline=b`) yields `string[]` at runtime; `.toLowerCase()` on an array returns `"[object Object]"` silently in the cache key. Fix: `const disciplineRaw = req.query.discipline; const discipline = typeof disciplineRaw === 'string' ? disciplineRaw.toLowerCase() : undefined;`. Apply the same safe pattern at the new `papers.ts:433` site from hold #1. Closes the repeated-param silent-coercion trap.

**Dismissed from round-3 findings (architect triage):**
- **P3** Orphaned comment in `search.ts:67-68` claiming callers lowercase at route entry (inaccurate for stats which has no `?discipline=`). Subsumed by hold #2 — the comment gets updated when the safe-pattern code change lands.
- **P3** `isHafAvailable` mock couples to `getPoolMock` in tests (maintainability M3): test-hygiene residual, not behavior-affecting, note during hold-fix commit but no separate action required.
- **P3** `fetchStatsFromHaf` exported for test access; leaks internal shape into module public API. Justified by hold-block rationale; accepted.
- **P3** stats hafCache.set null-guard missing in test: pattern-level note; safe under current mock shape.
- **P3** Negative assertion `not.toHaveProperty('name')` for shim-absence regression: cheap add; fold into the hold-fix commit if convenient.
- **P3** papers Hold #1(a) filter less precise than search Hold #1(c) (two-token co-occurrence vs single unique token): current code passes; future refactor risk flagged.

**Filed follow-up still-pending:** `backend-display-name-titlecase.md`, `backend-discipline-length-cap.md` — unchanged.

**Path to re-archive:** (1) Backend applies items #1-2 on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-4 with `/ce-code-review` and archives on clean.

---

**Backend re-review signal (2026-04-22 round-4, commit `a58a587`):**

Both round-3 hold items addressed. Directly-affected vitest files in isolation: 19 passed + 1 skipped across `disciplines.test.ts` (5 specs), `disciplines-canon-mocked.test.ts` (7 specs — new papers cache-key parity spec added), `papers.test.ts` (8 specs incl. `ctx.skip()` branch). `npx tsc --noEmit` clean. Full suite NOT run in this worktree per worker ground rule #5; parent agent to run it after merge.

1. **Hold #1 — `papers.ts` cache-key lowercasing (P1).** `backend/src/routes/papers.ts:438-443` (new line numbers after the comment block) — route handler now reads `req.query.discipline` with the typeof-narrowed pattern (`disciplineRaw`/`discipline` pair) and lowercases once at entry, then embeds the canonical value in the `cacheKey`. `fetchPapersFromHaf` also narrows the same way at its own entry (so a direct function call path stays canonical) and the inner `.toLowerCase()` at the SQL-bind site is removed (`papers.ts:232` → just `filterParams.push(discipline)`). Mirrors the `search.ts:287` pattern landed by round-2 hold #6.

   Test: `disciplines-canon-mocked.test.ts` — new `GET /api/papers — discipline-filter cache-key canonicalization` describe block. Two case-variant requests (`?discipline=Physics` and `?discipline=physics`); filter `hafQueryMock.mock.calls` on SQL containing `LEFT(c.body, 300) AS abstract` (the stable fragment uniquely identifying the papers data-query SELECT list — absent from papers-count, reviews count/data, vote-ops lookups, reputation batch, and the active_accreditations CTE body). Asserted `toHaveLength(1)` per round-2 hold #1 pattern — a regression to per-casing cache keys would emit 2 data queries.

2. **Hold #2 — Unsafe `as string | undefined` replaced by typeof-narrowed pattern (P2).** Both new `papers.ts` route-entry site AND the existing `search.ts:287` site now use `const disciplineRaw = req.query.discipline; const discipline = typeof disciplineRaw === 'string' ? disciplineRaw.toLowerCase() : undefined;` (papers router uses `: ''` rather than `: undefined` to keep the cache-key falsy-coalesce shape unchanged; `fetchPapersFromHaf` uses `: undefined` to match the existing `if (discipline)` gate). Closes the repeated-param `?discipline=a&discipline=b` silent-coercion trap — Express yields `string[]` at runtime, the old cast silently coerced `.toLowerCase()` on the array to `"[object Object]"` in the cache key.

**Deviations from hold block:** None. The `search.ts:67-68` disclaimer comment was left untouched per dismissed round-3 P3 (the comment is now accurate — Hold #2 keeps single-site lowercasing at route entry; the comment already said "callers lowercase `discipline` once at route entry").

**Dismissed-finding still-dismissed:** boundary-rule violation (architect round-2 authorized the contract edit), Postgres LOWER() vs JS toLowerCase() Unicode divergence (ASCII-range disciplines), orphaned comment at `search.ts:67-68` (round-3 dismissed P3; code change already made it accurate).

**Filed follow-up still-pending:** `backend-display-name-titlecase.md`, `backend-discipline-length-cap.md` — unchanged.

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES (round 4):**

Round-4 `/ce-code-review` on commit `a58a587` (9 personas: correctness, testing, maintainability, project-standards, kieran-typescript, api-contract, adversarial, agent-native, learnings-researcher). Full artifacts at `.context/compound-engineering/ce-code-review/20260422-123203-b301b347/`.

Both round-3 hold items are correctly applied: `papers.ts` cache-key lowercasing at route entry + typeof-narrowed `req.query.discipline` parsing at all 3 sites. The pass surfaced 4 new items that block archive.

1. **P3 — Double `.toLowerCase()` regression on cache-miss path** (adversarial ADV-001 0.87). `backend/src/routes/papers.ts:451` (route handler) AND `backend/src/routes/papers.ts:199` (`fetchPapersFromHaf`) both re-read `req.query.discipline` and call `.toLowerCase()` independently. Pre-commit: 1 call per cache-miss (at the SQL-bind site). Post-commit: 2 calls per cache-miss, plus a 3rd on the SWR stale-path background revalidation. `search.ts` handles this cleanly by passing the processed `discipline` value as an argument to `searchFromHaf`; `papers.ts` still passes the raw `req` through. Until `backend-discipline-length-cap.md` lands, the doubled per-request CPU exposure is visible on oversize discipline strings.

   Fix: refactor `fetchPapersFromHaf` to accept `discipline` as an explicit argument (mirrors `search.ts:searchFromHaf(..., discipline)`):
   ```ts
   async function fetchPapersFromHaf(req: Request, discipline: string | undefined): Promise<...> {
     // drop the lines re-reading req.query.discipline + narrowing + lowercasing
     ...
   }
   ```
   Call site at `papers.ts:~460` passes the route-handler-parsed `discipline` (narrowed + lowercased once).

2. **P3 — `''` vs `undefined` fallback split is undocumented and load-bearing** (maintainability M-02 0.80). `papers.ts:451` uses `: ''` for cache-key falsy-coalesce; `papers.ts:199` + `search.ts:293` use `: undefined` for `if (discipline)` gate. The split is correct (cache-key template would stringify `undefined` to `'undefined'` and invalidate every existing entry on deploy; the SQL gate needs `undefined` to suppress the condition). Rationale lives in commit messages, not in code. Add a 2-line inline comment at `papers.ts:451` explaining why `''` is required for cache-key stability; fold opportunistically into the item-1 refactor (the refactor eliminates one of the three narrowing sites, so only two comments needed: route handler `: ''` vs inner `: undefined`).

3. **P3 — No test for the `string[]` repeated-param trap** (testing T-01 0.82 + kieran-typescript TG-R4-1 + adversarial testing-gap convergence, 3-reviewer → boosted 0.92). Round-3 hold #2 added typeof-narrowing to defend against `?discipline=a&discipline=b` yielding `string[]` at Express runtime. Zero test exercises this path. A regression reverting `typeof disciplineRaw === 'string' ? ... : ''` back to `(req.query.discipline as string | undefined)?.toLowerCase() ?? ''` passes every current test because `"[object Object]"` is a consistent (if wrong) cache-key fragment across both requests in the new parity test.

   Add a spec to `disciplines-canon-mocked.test.ts` (sibling of the Hold #1 round-3 block): `?discipline=a&discipline=b` → status 200, bound SQL param NOT `"[object Object]"`, cache-key fragment NOT `"[object Object]"`, two such repeat-param requests produce `papersDataCalls.toHaveLength(1)`. Mirror for `/api/search`.

4. **P3 — `search.ts:67` comment factually wrong** (maintainability M-04 0.68). The comment lists `stats` among callers that lowercase `discipline` at route entry. `stats.ts` has no `?discipline=` query param — it applies `LOWER()` inside a hard-coded SQL subquery. Drop `stats` from the caller list.

**Dismissed from round-4 findings (architect triage):**
- **P3** M-01 / M-03 task-round labels in code comments + `it()` names: accepted pattern across prior rounds; consistent enough to leave. Not blocking.
- **P2** AC-002 repeated-param contract decision (silently unfilter vs 400): architect decision → document the silent-unfilter behavior in `papers.md` (applied this pass). 400-on-repeated-param is a broader query-string-parsing design call outside this task's scope; a future `backend-zod-migration-extension.md` pass can revisit.
- **P3** KT-R4-1 / ADV-002 sibling unsafe casts on `keyword`/`author`/`language`/`source`: pre-existing, symmetric with the fixed `discipline` but out of this task's scope. Filed hint for `backend-zod-migration-extension.md` (already pending).
- **P3** ADV-004 `papers.ts` cache-key not SHA-hashed like `search.ts`: pre-existing asymmetry; reopen when unbounded-input DoS becomes a concrete concern.
- **Agent-native** Gap 2 (`canon_name` not echoed in response envelope) and Gap 3 (dual contract shape): widening scope.

**Filed as separate Pending tasks (out of scope for this hold):**
- None — the sibling-casts concern is routed into the existing `backend-zod-migration-extension.md`.

**Architect-owned fix-in-place (applied in this review pass):**
- `agents/docs/api-contracts/papers.md` — `GET /api/papers` + `GET /api/search` `discipline` parameter rows now document case-insensitive matching, case-variant cache-dedup, `canon_name` guidance, and the repeated-param silent-unfilter contract. Closes AC-001 + AC-002.

**Path to re-archive:** (1) Backend applies items #1-4 on this task (all P3; scope tight: one refactor + one inline comment + one test spec + one comment-delete). (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-5 with a minimal `/ce-code-review` pass (correctness + testing sufficient); archives on clean.

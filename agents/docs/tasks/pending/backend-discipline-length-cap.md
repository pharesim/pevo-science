# BE-DISCIPLINE-LENGTH-CAP — Bound `?discipline=` input length before SQL LOWER()

**Owner:** backend
**Created:** 2026-04-21 (surfaced by BE-DISCIPLINE-CANONICALIZE security review 2026-04-21)
**Priority:** P3

## Context

BE-DISCIPLINE-CANONICALIZE (commit `d6c2bb1`) added `LOWER()` wrapping to both sides of the `?discipline=` filter in `backend/src/routes/search.ts:67-68` (and the sibling sites fixed in the hold-block: `papers.ts:226`, `stats.ts:59`). The value is properly pg-parameterized (`$N` placeholder), so SQL injection is not a concern.

What is a concern: there is no length or character-set guard on `?discipline=` before `discipline.toLowerCase()` and the pg bind. A request with a 1 MB Unicode string in `?discipline=` causes V8 to run `String.prototype.toLowerCase()` on the full blob, then PostgreSQL to run locale-aware `LOWER()` on the same value (once per candidate row in the search loop, not once total — the WHERE clause applies LOWER() on every row the outer predicate admits, though Postgres may short-circuit if the LOWER(...) does not equal the bound $N). Per-request CPU cost scales linearly with input size; distributed enumeration can tie up backend workers without ever hitting the `callbackLimiter` (60 req/min/IP).

`backend/src/types/disciplines.ts` exports a `DISCIPLINE_TAXONOMY` — an allowlist that would close this entirely. Alternatively a simple length cap (e.g. ≤100 chars — the longest taxonomy value is "Languages and Literature" at 23 chars) plus an ASCII-safe charset guard handles the DoS concern without binding the API to a static taxonomy.

## Goal

Add an input validation guard at the entry of each route that accepts `?discipline=`:
- `backend/src/routes/search.ts`
- `backend/src/routes/papers.ts`
- `backend/src/routes/disciplines.ts` (no `?discipline=`, but `/:discipline` path segment if any)

Emit `400 BAD_REQUEST` with a clear message when the guard fails. Constants kept as module-private or exported from `types/disciplines.ts`.

**Shape options (pick one):**
1. **Length cap only** — `if (discipline.length > 100) return sendError(res, 400, 'BAD_REQUEST', 'Discipline filter too long')`. Simple; leaves garbage values to fall through to a 0-hit response (current behavior).
2. **Length + charset guard** — same + `^[\p{L}\p{N} \-]+$` (Unicode letters/numbers/space/hyphen). Tighter, matches expected real-world discipline names.
3. **Allowlist via `DISCIPLINE_TAXONOMY`** — `if (!DISCIPLINE_TAXONOMY.includes(discipline.toLowerCase())) return sendError(res, 400, 'BAD_REQUEST', 'Unknown discipline')`. Tightest but binds the API to the taxonomy. Risk: users who tag papers with a discipline not yet in the taxonomy can never filter by it until the list is updated.

Recommendation: **option 2** (length + charset). Rejects clearly-malicious input without forcing a taxonomy lockstep.

## Non-goals

Adding `?discipline=` length caps to HAF SQL layer (not PEvO-owned). Normalizing Unicode forms (NFC/NFD) — separate concern.

## [TODO Architect]

1. Pick a shape (1/2/3 above) before implementer starts.
2. Decide whether to add a regression test that the malicious input yields 400, or let the API-contract reviewer flag it as residual gap.

## [BLOCKED by Architect] (2026-04-22)

Implementation cannot start until the architect picks one of the three shapes above (recommendation: option 2, length + charset) and decides on the regression-test question. Architect `git mv`s back to `pending/` once resolved.

---

## Architect decision (2026-04-22): Option 2 (length + charset)

**Chosen: Option 2** — cap at `≤100` chars AND require `^[\p{L}\p{N} \-]+$` (Unicode letters/digits/space/hyphen). Return `400 BAD_REQUEST` with `{ code: 'BAD_REQUEST', message: 'Discipline filter invalid' }` when either check fails.

**Rationale.** Option 1 is too permissive (passes garbage that will fall through to 0-hit responses — wastes the attacker's rate budget nothing; the CPU DoS concern is about oversize strings, not invalid names). Option 3 binds the API surface to a static taxonomy, which is the exact churn we want to avoid: users can tag papers with new disciplines ahead of the canonical list, and those tags must remain filterable. Option 2 closes the DoS without either downside.

**Scope clarifications for implementer:**
- Apply the guard at every `?discipline=` entry site: `backend/src/routes/search.ts`, `backend/src/routes/papers.ts`. `backend/src/routes/disciplines.ts` has no `?discipline=` query param (per the task) — verify and skip if true.
- Extract the guard into a small shared helper (e.g. `validateDisciplineFilter(raw: string): string | null` returning the canonicalized value or null) so future drift is structural. Colocate with `normalizeDiscipline` if one exists; otherwise put it alongside `DISCIPLINE_TAXONOMY` in `backend/src/types/disciplines.ts`.
- `.toLowerCase()` stays downstream of the guard (not before it) — the length check should run against the raw input, not the lowered-and-normalized form, so a 1 MB oversize string is rejected before V8 does the lower.
- **Yes on the regression test.** Add one per-endpoint: 1 MB input → 400, malformed charset (e.g. `$$$`) → 400, long-but-valid (`"quantum computing"` padded to 99 chars with spaces) → 200/ok. Real-HAF shape per backend test conventions; no mocked pools.
- Constants (`DISCIPLINE_FILTER_MAX_LEN = 100`, regex) exported from `types/disciplines.ts`.

No api-contract update needed — the new 400 path is a standard `BAD_REQUEST`, already documented in `common.md`.

---

**Architect re-review (2026-04-28) — HELD PENDING FIXES (round 1):**

Round-1 `/ce-code-review` on commit `602214f` (8 personas: correctness, testing, security, api-contract, kieran-typescript, project-standards, adversarial, maintainability). 6 P2 + multiple P3 findings. 5 hold items below; out-of-scope items filed as separate Pending tasks; dismissed items enumerated at end.

1. **P2 — Helper-direct unit tests + boundary 100/101 coverage** (testing 0.80 + testing 0.85, 2-finding convergence). `validateDisciplineFilter` is a pure 5-branch function (null, non-string, empty, length-overflow, charset-fail) tested only via supertest. Add `backend/tests/lib/disciplines.test.ts` (or sibling location matching backend test conventions) with direct unit tests covering: null input, undefined input, `string[]` input (the round-3-hold-#2 repeated-param contract), empty string, exactly 100 chars (accept), exactly 101 chars (reject), Unicode letter (e.g. `'mathématiques'`, `'Φυσική'`), hyphen-containing (`'bio-physics'`), and the lowercase-return assertion. The boundary at 100/101 specifically guards against an off-by-one flip from `>` to `>=` that current tests (99-accept, 4000-reject) would silently pass.

2. **P2 — Result-shape return; fold away `DisciplineFilterError`** (kieran-typescript K1 0.60 + maintainability M-LENGTHCAP-1 0.70 + maintainability M-LENGTHCAP-5 0.90, 2-reviewer convergence). The throw-on-invalid + `instanceof` rethrow at both call sites (`papers.ts:466-472`, `search.ts:296-303`) is the wrong shape for an expected 400 path. Replace with a discriminated-union return: `validateDisciplineFilter(raw: unknown): { ok: true, value: string } | { ok: false, message: string } | null` (or a similar shape; an `ok`/`error` discriminator is the load-bearing piece). Drop the try/catch + instanceof + rethrow at both call sites; collapse to a 3-line check (`if (result && !result.ok) return sendError(res, 400, 'BAD_REQUEST', result.message);`). Eliminate the `DisciplineFilterError` class entirely. The new helper-direct unit tests from item 1 should exercise the new return shape.

3. **P2 — Trim route-handler comment archaeology** (maintainability M-LENGTHCAP-2 0.75). After items 1 + 2 land, trim both `papers.ts:442` and `search.ts:285` route-entry comment blocks to ~3 lines covering ONLY the genuinely non-obvious live invariant: the cache-key `''` vs SQL-gate `undefined` split. Delete citations to round-2 hold #6, round-3 hold #1, round-3 hold #2, BE-DISCIPLINE-LENGTH-CAP — once this task archives those tasks drop from `tasks/` and the citations stop being navigable. git blame + `tasks-archive.md` preserve the round-by-round narrative. Same trim applies to the `fetchPapersFromHaf` header that re-narrates what the helper signature already encodes.

4. **P2 — `papers.md` `?discipline=` validity rules** — DONE architect-side this pass (added validity-rules sentence to both `/api/papers` and `/api/search` `?discipline=` parameter rows). No implementer action required for this item; surfacing for symmetry with the held-fix list.

5. **P3 — Restore `Co-Authored-By` trailer for `602214f`** (project-standards 1.00). Per CLAUDE.md "Commits and Pushes" the trailer is mandatory; commit `602214f` lacks it. Force-push amendment is forbidden; the in-repo correction precedent is `27befcf` ("chore(backend): restore Co-Authored-By trailer for 9d3de2c via no-op follow-up"). Land a no-op follow-up commit using that pattern for `602214f`. May be combined with the parallel BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME `9882573` correction into one no-op commit if convenient.

**Dismissed from round-1 findings (architect triage):**
- **P2** UTF-16 code-unit length cap allows 2× byte expansion via `.toLowerCase()` (adversarial 0.90). The task's original DoS threat model targeted 1MB+ inputs; the bounded 2× expansion (worst case ~600 UTF-8 bytes after fold-expansion of U+0130 / U+1D400-U+1D7FF) is microseconds of Postgres `LOWER()` cost. Not exploitable. Documenting the byte-vs-codepoint nuance via comment would help readers but doesn't justify code change.
- **P3** behavior shift on invalid input (200+empty → 400) (correctness 0.75). Architect's original Option-2 decision explicitly chose 400; reviewer concurs intentional.
- **P3** repeated-param silent-unfilter leaks parser shape (adversarial 0.70). Architect's round-4 fix-in-place on BE-DISCIPLINE-CANONICALIZE round-4 documented silent-unfilter as the contract; broader query-string design call parked in `backend-zod-migration-extension.md`.
- **P3** `string | null` vs `string | undefined` (kieran-typescript 0.55). Subsumed by item 2 (Result-shape refactor will land a new return shape; null/undefined distinction will be redesigned in passing).
- **P3** `types/disciplines.ts` kitchen-sink risk (maintainability 0.80). Reviewer's own recommendation: "splitting is premature; revisit if file crosses ~300 lines or a fourth distinct concern lands." Currently 165 lines; defer.

**Filed as separate Pending tasks (out of scope for this hold):**
- `backend-search-q-likeguard-and-length-cap.md` — adversarial P1 finding that `?q=` on `/api/search` injects unescaped LIKE metacharacters into ILIKE %…% with no length cap; more exploitable than `?discipline=` was. Architect-decision baked into the new task: 200-char cap + ESCAPE-clause approach.
- `architect-discipline-filter-publish-charset-alignment.md` (in `blocked/`) — correctness P3 finding (conf 50) that the filter charset rejects characters the publish form may allow free-form (`&`, `.`, `/`, etc.). Audit + alignment decision (Option A/B/C) deferred.
- `backend-papers-cache-key-sha256-mirror.md` — adversarial P3 finding (conf 80) that `/api/papers` cache key is delimiter-collision-prone via unvalidated sibling fields; mitigation pattern (sha256-wrap) already in-repo at `search.ts:339`.

**Path to re-archive:** (1) Backend applies items 1-3 + 5 on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-2 with `/ce-code-review` and archives on clean.

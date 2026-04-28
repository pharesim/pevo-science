# BE-PROFILE-PAPER-DISCIPLINE-CANON — Route `toPaperSummary` discipline through `paperDisciplineField()`

**Owner:** backend
**Created:** 2026-04-28 (surfaced by BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME review, correctness + maintainability cross-reviewer)
**Priority:** P2

## Context

BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME (commit `9882573`) introduced `paperDisciplineField(raw: string | null | undefined): string | null` in `backend/src/types/disciplines.ts` and routed all three response-shaping sites in `backend/src/routes/papers.ts` (list mapping, continuation-chain head-override, `buildPaperDetail`) through it. The helper's JSDoc states explicitly: "Every response-shaping site that surfaces a paper's discipline must route through this so future drift becomes a type-check failure at the helper call site, not a whack-a-mole across routes."

One out-of-boundary site was deliberately left unrouted by the implementer (flagged in the task signal block):

- `backend/src/helpers.ts:98` — `toPaperSummary()` builds `discipline: (pevo.discipline as string) || ''`.
- Consumer at `backend/src/routes/profile.ts:238` — `/api/profile/:account` papers list.

After this commit, `/api/papers` list+detail return canon_name lowercased. `/api/profile/:account/papers` still surfaces on-chain casing. Same field name, divergent normalization. A client round-tripping a paper's `discipline` back through `?discipline=` sees inconsistent canon-vs-echo behavior across endpoints.

## Goal

Route the profile-papers `discipline` field through `paperDisciplineField()` so `/api/profile/:account/papers` matches the `/api/papers` canon contract.

Mechanical blocker: `PaperSummary.discipline` is typed `string` (not `string | null`). Two fix shapes:

- **(a) Widen the type** to `string | null` and update consumers downstream (frontend renders fine on null per the existing `paper.discipline` capitalize sites — those sites are also being migrated under `ui-discipline-display-harden-paper-render-sites.md`).
- **(b) Coalesce at the boundary** — `discipline: paperDisciplineField(pevo.discipline) ?? ''` keeps `string`; preserves the historical "absent → empty string" shape.

## Recommendation

**(b) Coalesce at the boundary.** Less downstream churn; the helper's null-vs-empty distinction is a return-shape preference of the helper, not a contract on `PaperSummary.discipline`. Frontend + bridge consumers already treat `''` as absent.

The `as string | null | undefined` cast on the helper input becomes redundant if/when BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME round-2 hold #2 (widen helper to `unknown`) lands; coordinate.

## Tests

Real-HAF spec in `backend/tests/routes/profile.test.ts` (or wherever `/api/profile/:account/papers` is exercised): assert each `paper.discipline` in the response is its own lowercased form (mirrors the parallel spec on `/api/papers`).

Mocked-pool carve-out: seed a paper row through `toPaperSummary` with `pevo.discipline = '  Computer Science  '`, assert response `discipline === 'computer science'` (or `''` if you prefer the absent-coalesce path; pick one and pin it).

## Acceptance

- `toPaperSummary` routes `pevo.discipline` through `paperDisciplineField()`.
- `/api/profile/:account/papers` response canon-lowers each paper's `discipline` field.
- Test coverage matches the `/api/papers` canon coverage (real-HAF parity + mocked-pool deterministic pin).
- `agents/docs/api-contracts/profile.md` (if it exists) gets a parallel field note. (Architect-owned; flag via `[TODO Architect]` if needed.)

---

## Implementer re-review signal (2026-04-28, backend) — round 1

**Decision:** picked option (b) "Coalesce at the boundary" per the architect's recommendation in the task body. `PaperSummary.discipline` stays typed as `string` (not widened to `string | null`); the call site coalesces with `?? ''` to preserve the historical "absent → empty string" shape. Less downstream churn, no consumer migration needed.

**Code change** (`backend/src/helpers.ts`):
- Added `import { paperDisciplineField } from './types/disciplines.js'` (the helper was widened to `unknown` parameter in BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME round-2 commit `6e7a43f`, so the call site needs no cast).
- Replaced `discipline: (pevo.discipline as string) || ''` at line 113 with `discipline: paperDisciplineField(pevo.discipline) ?? ''`. The helper trims + lowercases on success and returns `null` for missing/non-string/empty input; `?? ''` collapses null → empty string per the `string` typing of `PaperSummary.discipline`.

**Tests landed:**
- `backend/tests/routes/profile.test.ts` (real-HAF) — added a parity assertion under the existing `GET /api/profile/:username/papers` describe block. For each paper in the response, `paper.discipline === paper.discipline.toLowerCase()`. Vacuous on all-lowercase corpus (acknowledged in the test docstring), but pins the response shape so a regression that bypasses the helper surfaces here. The mocked-pool sibling test exercises the trim+lowercase transform deterministically.
- `backend/tests/routes/disciplines-canon-mocked.test.ts` (mocked-pool) — new spec in the existing `GET /api/search` cache-key describe block: seeds a paper row through the `fetchUserPapersFromHaf` SQL with `pevo.discipline = '  Computer Science  '` (whitespace-padded mixed case), asserts response `discipline === 'computer science'`. Mocks both halves of the count + data Promise.all by SQL-shape filtering on `FROM user_papers` + `count(*)::int AS total` vs. `ORDER BY`.

**Tests run** (with docker-IP env overrides per CLAUDE.md):
- `tests/routes/disciplines-canon-mocked.test.ts` → 20/20 passed (was 19; +1 new case).
- `tests/routes/profile.test.ts` (real-HAF) → 5/5 passed (was 4; +1 new case).
- `npm run lint` clean (2 pre-existing warnings on `seed-phrase.ts`, unchanged).

**Coordination note:** the helper-input cast (`as string | null | undefined`) that the original task body called out as redundant once BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME round-2 hold #2 lands has indeed been collapsed — the call site is simply `paperDisciplineField(pevo.discipline)` with no cast. The architect's "coordinate" note in the task body has been honored.

### [TODO Architect]

**Contract update needed (architect-owned, before archive):**
- `agents/docs/api-contracts/profiles.md` — the contract file exists (verified via `ls`). The per-paper `discipline` field on the `GET /api/profile/:username/papers` response shape needs a parallel field note matching the one already added to `papers.md` in BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME round-2:
  > `discipline` is canon_name (lowercased + trimmed); matches `/api/disciplines.canon_name`, round-trippable through the URL filter; absent values surface as `''` (`PaperSummary` types `discipline` as `string`, not nullable).

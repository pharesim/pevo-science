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

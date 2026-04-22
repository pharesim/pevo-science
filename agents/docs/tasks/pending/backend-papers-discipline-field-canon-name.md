# BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME — Each paper's `discipline` field in `/api/papers` and `/api/search` must return canon_name

**Owner:** backend
**Created:** 2026-04-22 (surfaced by post-merge Playwright run for FE-PAPERS-BROWSE-DISCIPLINE-OPTION-HYDRATION-RACE after backend commit `3d68ee6`)
**Priority:** P3

## Context

`BE-DISCIPLINE-CANONICALIZE` (commit `d6c2bb1`) + its round-1 hold fixes (commit `3d68ee6`) aligned most of the discipline surface:

- `/api/disciplines` returns `{ canon_name, display_name, paper_count }` with a transient `name` alias.
- `/api/papers?discipline=<value>` now matches via `LOWER()` on both sides, so canon_name works as the query value.
- Stats dedup, search cache key, response envelope — all on canon semantics.

One surface was **not** migrated: the per-paper `discipline` field in `/api/papers` (and likely `/api/search`) responses still returns the **display form**, not canon_name.

## Reproduction

```
curl -s "http://localhost:3001/api/papers?discipline=computer%20science" \
  | jq '.data[0].discipline'
# → "Computer Science"   (display form)
```

Contract at `agents/docs/api-contracts/misc.md:125` says canon_name is the URL-value contract. The per-paper `discipline` field is what a client round-trips through a URL (`<a href="/papers?discipline=${paper.discipline}">`), so returning display form forces every client to re-canonicalize on read — exactly the bug the original task set out to fix.

E2E failure at `papers-browse.spec.js:66`:

```
Error: expect(received).toBe(expected) // Object.is equality
Expected: "computer science"
Received: "Computer Science"

for (const paper of filterBody.data) {
  expect(paper.discipline).toBe(firstDiscipline);  // firstDiscipline is canon
}
```

## Goal

1. `/api/papers` response: each paper's `discipline` field is canon_name (lowercased), not display_name.
2. Audit `/api/search` for the same field in result entries of `type: "paper"` / `type: "bridge_paper"`.
3. If a client explicitly needs the display form in the same response (none today per frontend code), expand to `{ discipline: canon, discipline_display: display }` rather than regressing. Default: return canon only — frontend can look up display via `/api/disciplines`.
4. Update `api-contracts/papers.md` + `search.md` with the per-paper `discipline` field shape.
5. Update existing backend tests; add one assertion per endpoint covering mixed-case input in HAF → canon output in response.

## Non-goals

- Changing the URL filter (already fixed at `3d68ee6`).
- Re-shaping `/api/disciplines` (already fixed).
- Anything user-input-side (publish/edit) — separate concern; those paths already normalize via `normalizeDiscipline`.

## Acceptance

- `papers-browse.spec.js` E2E passes cold (no retries) on the `expect(paper.discipline).toBe(firstDiscipline)` assertion with `firstDiscipline` bound to canon_name.
- API contract docs note canon as the per-paper field shape.
- Backend integration tests assert the canon shape on real-HAF fixtures.

## [TODO Architect]

Decide whether `/api/search` result entries should carry both `discipline` (canon) and `discipline_display`. Default to canon-only unless a concrete frontend consumer needs both in the same payload. Same question for paper-detail.

Also: `/api/papers` and `/api/search` each independently shape their discipline field — confirm the fix consolidates through a single helper so future drift is structural, not per-route.

## [BLOCKED by Architect] (2026-04-22)

Implementation cannot start until the architect decides on the canon-only vs canon+display_name payload shape for `/api/search` and `/api/papers` (paper-detail too), and confirms the consolidating-helper direction. Architect `git mv`s back to `pending/` once resolved.

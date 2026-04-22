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

---

## Architect decision (2026-04-22): canon-only + single shared helper

**Chosen shape: canon-only.** Per-paper `discipline` field returns `canon_name` (lowercased) in `/api/papers`, `/api/search` (paper + bridge_paper entries), and paper-detail responses. No `discipline_display` sibling field.

**Rationale.** No frontend consumer needs both in the same payload today (verified against `frontend/src/` usage pre-decision is the implementer's first step). Display form is a one-hop lookup via `/api/disciplines` which the frontend already caches. Shipping `discipline_display` now would codify a shape no consumer asked for and freeze an unnecessary field in the contract. If a concrete consumer appears later, we expand then — backward compat is trivial because adding a sibling field never breaks existing readers.

**Consolidating-helper direction.** Single shared helper, colocated with `normalizeDiscipline` in `backend/src/types/disciplines.ts` (or similar shared module). Every response-shaping site that surfaces a paper's `discipline` field must go through it. Name suggestion: `paperDisciplineField(raw: string | null | undefined): string | null` — returns canon-lowered or null if missing. Consolidation is structural: future drift becomes a type-check failure at the helper call site, not a whack-a-mole across routes.

**Scope clarifications for implementer:**
- Apply to `/api/papers` (list + detail), `/api/search` (all entry types that carry `discipline`: `paper`, `bridge_paper`, and any others).
- Pre-land check: grep `frontend/src/` for `.discipline` / `paper.discipline` uses; if any read display-form semantics (titlecase rendering) and the backend change regresses that visual, file a follow-up `ui-*` task — DO NOT hold this task on the frontend migration; the backend can ship canon-only and the frontend can titlecase on render in the meantime.
- Contract updates needed: `agents/docs/api-contracts/papers.md` and `agents/docs/api-contracts/search.md` — architect-owned. Implementer flags via `[TODO Architect]` in the task note before moving to `review/`.
- Test: real-HAF fixtures with mixed-case discipline input → response `discipline` field is canon-lowered. E2E `papers-browse.spec.js:66` should pass cold.
- Non-goals explicitly exclude: URL filter (already fixed), `/api/disciplines` shape (already fixed), publish/edit-side normalization (already normalized via `normalizeDiscipline`).

---

## Implementer re-review signal (2026-04-22, backend)

Landed `paperDisciplineField(raw: string | null | undefined): string | null` in `backend/src/types/disciplines.ts`. Threaded through all three per-paper discipline response-shaping sites in `backend/src/routes/papers.ts` (list row shape at line 385, continuation-chain head override at line 574, `buildPaperDetail` at line 966). `/api/search` does not currently surface a `discipline` field on any result type, so no code-change was needed there; added a future-proof spec in `search.test.ts` that asserts canon-lower semantics for any `paper`/`bridge_paper` entry that does expose the field.

Tests run with docker-IP env overrides: `npx vitest run tests/routes/papers.test.ts tests/routes/search.test.ts` → 17 passed, 1 skipped (pre-existing vacuous-parity skip). Real-HAF; no pool mocking. Lint clean on changed `src/` files; pre-existing warnings unchanged.

### [TODO Architect]

**Contract updates (architect-owned, per architect decision scope note):**
- `agents/docs/api-contracts/papers.md` — per-paper `discipline` field contract prose must state "canon_name (lowercased); clients titlecase on render via `/api/disciplines.display_name` or CSS `capitalize` if needed". Applies to both the list response shape (line ~35 and ~84) and the paper-detail shape.
- `agents/docs/api-contracts/papers.md` `GET /api/search` block (line ~461-490) — `SearchResult` does not currently carry a `discipline` field. If the contract ever adds one to the `paper` / `bridge_paper` result types, it must be canon_name (lowercased). A forward-looking spec guards this in `search.test.ts`.

**Frontend impact findings (no UI regression expected; surfaced for architect triage):**

Read-only grep of `frontend/src/` for `paper.discipline` / `.discipline` rendering sites:
- `frontend/src/pages/profile.js:226` — `<span class="badge-discipline capitalize" x-text="paper.discipline">` — CSS `capitalize` titlecases the rendered text. Canon-lower backend input renders identically. No UI task needed.
- `frontend/src/components/paper-card.js:16` — identical pattern with `capitalize`. No UI task needed.
- `frontend/src/pages/paper-detail.js:266` — identical pattern with `capitalize`. No UI task needed.

All three render sites already rely on CSS `text-transform: capitalize` rather than reading display-form semantics from the backend. No follow-up `ui-*` task required for this change. If the architect wants a more robust long-term path (e.g. rendering `display_name` from `/api/disciplines` instead of CSS-titlecasing), that's a separate UI improvement, not a regression of this change.

**Out-of-boundary site noted, not touched (architect triage):**
- `backend/src/helpers.ts:98` — `toPaperSummary()` builds a `PaperSummary` with `discipline: (pevo.discipline as string) || ''`. Used by `backend/src/routes/profile.ts:238` (`/api/profile/:account` papers list). Lives outside this task's declared boundary (`papers.ts` / `search.ts` only). The profile papers list will still echo the stored casing until a follow-up task routes it through `paperDisciplineField` as well. Minor: `PaperSummary.discipline` is typed `string` (not `string | null`), so this would need either a type widening or a `|| ''` fallback over the helper's `null` return. Suggest a small follow-up `be-profile-paper-discipline-canon` task if desired.

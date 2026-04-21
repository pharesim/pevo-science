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

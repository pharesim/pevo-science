# BE-PAPERS-FILTER-DISCIPLINE-CANON-NAME — `/api/papers?discipline=` must accept canon_name, and each paper's `discipline` field must return canon_name

**Owner:** backend
**Created:** 2026-04-22 (surfaced by post-merge Playwright run for FE-PAPERS-BROWSE-DISCIPLINE-OPTION-HYDRATION-RACE 2026-04-22)
**Priority:** P2

## Context

`BE-DISCIPLINE-CANONICALIZE` (commit `d6c2bb1`) renamed the `/api/disciplines` response from `{ name, paper_count }` to `{ canon_name, display_name, paper_count }`. The API contract at `agents/docs/api-contracts/misc.md:125` states:

> Frontend consumers that previously read `row.name` must switch to `row.display_name` for rendering and `row.canon_name` for URL values.

The frontend migration landed at commit `7961ac0` (FE-PAPERS-BROWSE-DISCIPLINE-OPTION-HYDRATION-RACE): `paper-feed.js` and `search.js` now render `display_name` and use `canon_name` as the option `value`. The `papers-browse.spec.js` E2E test exercises the end-to-end flow by selecting the first non-empty `<option>` and firing a `/api/papers?discipline=<value>` request.

**The test fails** because the backend has only partially migrated:

1. `/api/disciplines` correctly returns `{ canon_name: "computer science", display_name: "Computer Science", paper_count: 2 }`.
2. `/api/papers?discipline=computer%20science` (canon_name) returns `data.length = 0`.
3. `/api/papers?discipline=Computer%20Science` (display form) returns 2 papers, and each paper's `discipline` field is `"Computer Science"` (display form).

The backend's papers-filter code path is still comparing against the display form, not canon. Per the contract, canon_name should be authoritative for both filtering and the per-paper discipline field — display_name is a rendering concern only.

## Reproduction

```
curl -s "http://localhost:3001/api/disciplines" | jq '.data[0]'
# → { "canon_name": "computer science", "display_name": "Computer Science", "paper_count": 2 }

curl -s "http://localhost:3001/api/papers?discipline=computer%20science" | jq '.data | length'
# → 0                 (WRONG — canon_name does not filter)

curl -s "http://localhost:3001/api/papers?discipline=Computer%20Science" | jq '.data | length'
# → 2                 (the backend still requires display form)

curl -s "http://localhost:3001/api/papers" | jq '.data[0].discipline'
# → "Computer Science"  (WRONG — discipline field should be canon_name per contract)
```

E2E failure:

```
papers-browse.spec.js:63  expect(filterBody.data.length).toBeGreaterThan(0)
Expected: > 0
Received:   0
```

## Goal

1. `/api/papers?discipline=<canon_name>` MUST match rows whose canon discipline equals the query value. The query key is canon_name (lowercased, dedup-safe), not display form.
2. Each returned paper's `discipline` field MUST be the canon_name, not display_name. Clients that need display form can either (a) look up via `/api/disciplines` or (b) we expand to return `{ discipline_canon, discipline_display }` per paper — prefer (a) for payload size unless the frontend has a specific need.
3. Audit `/api/search` for the same drift. If it too filters/returns discipline in display form, apply the same fix.
4. Update `agents/docs/api-contracts/papers.md` (and `search.md` if touched) to reflect the canon_name contract.

## Non-goals

- Changing `/api/disciplines` response shape — it's already correct.
- Changing the `publish` / `edit` flows' input handling (separate concern).
- Reverting or weakening the canon/display split.

## Acceptance

- `papers-browse.spec.js` passes end-to-end on a cold run (no retries), including the `expect(paper.discipline).toBe(firstDiscipline)` assertion at line 66 where `firstDiscipline` is the canon_name value.
- `/api/papers?discipline=<canon_name>` returns the matching rows for every discipline listed in `/api/disciplines`.
- API contract docs updated.
- Existing backend integration tests still pass; add/update tests covering both the filter and the per-paper field shape.

## [TODO Architect]

Decide whether per-paper response should include `discipline_display` in addition to `discipline` (canon). Default to canon-only if the frontend can derive display via `/api/disciplines` (it already loads that list for the filter). Confirm in `api-contracts/papers.md`.

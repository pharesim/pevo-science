# UI-PAPERS-ORCID-NULL-FALLBACK-VERIFICATION — verify SPA null-guards `authors[].orcid` everywhere it renders

**Owner:** UI Agent
**Created:** 2026-05-17 (architect, surfaced by round-3 re-review of `backend-multi-author-cumulative-union` finding A1)
**Priority:** P1

## Why now

Backend's round-2 hold fix at `backend/src/routes/papers.ts:417-434` introduced a new branch in `buildCumulativeAuthorsForChain` that suppresses an accredited author's ORCID to `null` when:
- the author is accredited but has no on-chain ORCID, AND
- a co-author's chain post claims an ORCID value for them.

This closes a vouch-coauthor spoof attack (the accredited user's silence IS the authoritative claim of "no ORCID"). API-contract update at `agents/docs/api-contracts/papers.md` (this round) widens `authors[].orcid` to `string | null`.

Pre-fix, `orcid` was always a string (possibly the empty string). Now it can be `null` for accredited authors on continuation-chain papers under the conditions above. SPA code that uses `orcid` in a string context (template interpolation, `.toLowerCase()`, `.includes()`, JSX/text rendering without nullish-coalescing, etc.) will throw at runtime on the null path.

## Goal

Audit every SPA site that reads `authors[].orcid` on a `PaperSummary` or `PaperDetail` response and confirm it null-guards. Where it doesn't, add the guard. Where it does (via `??`, `?.`, optional chaining, ternary, or an upstream filter), document the guard pattern inline so future edits don't regress.

## Acceptance

### 1. Grep the SPA for `orcid` reads on paper-author entries

Find every site reading `author.orcid` / `authors[i].orcid` / `a.orcid` on the paper-author shape (NOT the search-author shape or other unrelated `orcid` fields). At minimum:
- `frontend/src/pages/paper-detail.js`
- `frontend/src/pages/paper-list.js` (or whatever the listing surface is named)
- `frontend/src/pages/profile-papers.js`
- `frontend/src/components/author-card.js` (if applicable)
- Any template / Alpine `x-text="author.orcid"` binding

### 2. Verify null-safety at each site

For each site:
- If using `x-text` or string-context (e.g., `${author.orcid}`), confirm the surrounding template handles `null` (renders as empty string, or shows a placeholder, or is gated by `x-if="author.orcid"`).
- If using `.toLowerCase()` or any string method, ensure an upstream `if (author.orcid)` / `??` / `?.` guard.
- If passing to a child component, verify the child accepts `string | null`.

### 3. Fix any sites that crash on null

Add the null-guard inline. Prefer Alpine's `x-if="author.orcid"` for conditional rendering blocks, or `${author.orcid ?? ''}` for string-context interpolation.

### 4. Tests

Add a regression test (vitest + jsdom) that renders a paper-detail / paper-list / profile-papers view with at least one author entry where `orcid: null`. Assert the view renders without throwing and shows appropriate fallback UI (empty string, "no ORCID on file", or omits the ORCID line entirely — implementer's call).

## Out of scope

- `orcid_verified` already documented as `string | null`; this task assumes SPA already null-guards it (verify briefly while in the area).
- `orcid_discrepancy` is a boolean; no null risk.
- Search-result author shape (different surface; not affected by the cumulative-union fix).

## Source

- Architect round-3 re-review of `backend-multi-author-cumulative-union` (2026-05-17), finding A1 (P1/75 from api-contract reviewer).
- Backend round-2 hold fix at `backend/src/routes/papers.ts:417-434` (`commit 3b6d781`).
- API contract update at `agents/docs/api-contracts/papers.md` (2026-05-17, this round).

## Cross-references

- `agents/docs/api-contracts/papers.md` — `authors[].orcid` now `string | null` with prose explaining the suppression-to-null path.
- `agents/docs/tasks/review/backend-multi-author-cumulative-union.md` — sibling task; backend round-3 hold also adds the `accreditationStatus: 'active'` audit-event field (independent fix; doesn't block this UI task).
- `backend/src/routes/papers.ts:417-434` — the suppress branch that produces the null value.
- `backend/tests/routes/continuation-author-gate.test.ts:915-963` — backend canary for the suppress path (sets `orcid: null`).

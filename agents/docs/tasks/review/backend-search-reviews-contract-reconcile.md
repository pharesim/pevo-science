# Reconcile reviews-search reachability — contract says no, code says yes

**Owner:** Backend Agent
**Created:** 2026-04-28 (surfaced by `/ce-doc-review` of `backend-papers-filter-accreditation.md` — coherence + feasibility + scope-guardian + security-lens 4-reviewer convergence)
**Priority:** P3

## Problem

`agents/docs/api-contracts/papers.md:470` documents the `/api/search` endpoint's `type` parameter as enum `paper | all` with the explicit note "reviews are not searchable via this endpoint."

`backend/src/routes/search.ts:246` has a live branch:
```ts
if (type === 'review') {
  return await searchReviewsFromHaf(pool, query, accreditedOnly, sort, limit, offset);
}
```

`search.ts:285` has no validation — `req.query.type` is taken as-is and falls through to `'all'` only if undefined. So `?type=review` is reachable in code despite the contract saying it isn't.

This drift was surfaced by the `/ce-doc-review` of the filter-accreditation hard-gate task. The filter-accreditation task hardens the reviews-search branch with the same hard-gate the rest gets, but doesn't resolve whether the branch should exist at all.

## Decision required

Pick one. The implementer should check usage before deciding:

1. **The reviews-search branch is live and intentional** → update `api-contracts/papers.md:470` to add `review` to the enum and document the response shape (`SearchResult` items with `type: 'review'` discriminator). Possibly also add input validation at `search.ts:285` to 400 INVALID_PARAM on unknown values.
2. **The reviews-search branch is dead surface** → delete `searchReviewsFromHaf` and the `if (type === 'review')` branch. Search becomes papers-only as the contract says.
3. **The reviews-search branch is partial / experimental** → gate it behind a feature flag or env var, document the experimental status.

## Acceptance criteria

- Decide which option. Check `frontend/` for any usage of `/api/search?type=review` before deleting. Check Slack/git history for prior intent.
- Implement the chosen option. If (1), the contract update + validation. If (2), the code deletion + dead-test cleanup. If (3), feature-flag plumbing.
- Add or update tests asserting the chosen behavior:
  - (1): `GET /api/search?type=review&q=...` returns review results from accredited authors only (verifies the hard-gate from the filter-accreditation task applies); `?type=foo` returns 400.
  - (2): `GET /api/search?type=review&q=...` returns the same as `?type=all` (legacy fallback) or returns 400 if validation is added.
  - (3): document the flag's default state and switching behavior.

## Out of scope

- The hard-gate enforcement on the reviews-search branch is owned by `backend-papers-filter-accreditation.md` lane 3, regardless of which option lands here.
- The bridge-paper exemption in `searchPapersFromHaf` (asymmetric vs `searchReviewsFromHaf`) is owned by `backend-bridge-paper-author-gate.md`.

## Why now

Architect-resolution stability — the filter-accreditation task hardens a branch the contract claims doesn't exist. Future contributors hitting this contradiction will be confused about which is authoritative.

---

## Backend implementation (2026-04-28)

**Decision: Option 1 — the reviews-search branch is live and intentional.**

Frontend evidence (verified before implementing):
- `frontend/src/pages/search.js:40` — `<select>` ships `<option value="review" x-text="$t('search.typeReviews')"></option>` in the type filter.
- `frontend/src/pages/search.js:94, 106, 117` — result renderer dispatches on `result.type === 'review'` and shows review-shaped cards (different layout from paper cards).
- `frontend/src/pages/search.js:219, 231` — URL state persists `?type=review` so deep-links and browser back/forward work.
- `frontend/src/api.js:132-133` — `searchPapers(params)` is the live consumer of `/api/search` and forwards arbitrary params including `type`.

The contract was wrong, the code was right. Branch is shipping.

### Backend changes

- `backend/src/routes/search.ts:~291` — replaced unsafe `(req.query.type as string) || 'all'` with a typeof-narrowed enum check against `['all', 'paper', 'review']`. Unknown values now return `400 BAD_REQUEST` with message `Invalid type. Must be one of: all, paper, review`. Repeated `?type=a&type=b` (which Express parses as `string[]`) also rejected — previously the unsafe cast would stringify the array to `"a,b"` and slip past any future enum check.
- `backend/tests/routes/search.test.ts` — added three new cases: `?type=review` returns 200 with all results having `type === 'review'`, `?type=foo` returns 400, repeated `?type=paper&type=review` returns 400. 14/14 pass against real HAF.
- `backend/src/types/api.ts` `ErrorCode` enum lacks `INVALID_PARAM`; used `BAD_REQUEST` to match the existing `search.ts` 400s (q-validation, discipline-validation). The task spec mentioned `INVALID_PARAM` — flagging here so the architect knows the substitution was intentional and not a drift.

### [TODO Architect]

The contract file `agents/docs/api-contracts/papers.md:~470` is still out of date. The architect needs to:

1. Update the `/api/search` endpoint's `type` parameter enum from `paper | all` to `paper | review | all` (the canonical order is debatable; current code accepts all three).
2. Drop the line "reviews are not searchable via this endpoint."
3. Document the response shape for review entries — they share the `SearchResult` envelope but the `type` discriminator is `'review'` and the body shape mirrors what `searchReviewsFromHaf` returns (`backend/src/routes/search.ts:~187-234`). Concretely the differential vs paper entries: review rows include `paper_author` + `paper_permlink` (the parent paper) instead of `discipline` / `language` / `source`. Snippet, title, author, permlink, created, is_accredited are common.
4. Add a 400 error case noting that unknown `type` values now reject (the test asserts the message format `Invalid type. Must be one of: all, paper, review`).

This contract update is architect-owned per backend CLAUDE.md "Boundaries"; the backend code change above lands first, the architect's contract edit lands during the archive pass.

### Out of scope (intentionally)

- The contract update itself (architect-owned per `agents/docs/solutions/conventions/backend-api-contracts-are-architect-owned-2026-04-21.md`).
- Validation of other `?` params (`language`, `source`) — the task scope was `type` only. Existing CLAUDE.md guidance: "Don't add features… beyond what the task requires." If the architect wants a broader sweep, file as a follow-up.
- `searchReviewsFromHaf`'s hard-gate enforcement — owned by `backend-papers-filter-accreditation.md` lane 3.

---

## Architect re-review (2026-05-12) — HELD PENDING FIXES:

1. **Vacuous-pass guard on `?type=review` happy-path test** (P2, testing reviewer, conf 75). `backend/tests/routes/search.test.ts:66-74` — the `for…of` over `res.body.data` runs zero assertions when the live HAF corpus returns no `q=science` review hits. Add `expect(res.body.data.length).toBeGreaterThan(0)` before the loop (or tune the query to a term that's known to match at least one accredited review in the real corpus). The lane-3 accreditation test at lines 233-244 partially mitigates by iterating the same set and asserting authorship, but the dedicated shape test should pin its own non-vacuous contract.

2. **Case-sensitivity pin on `?type=`** (P3, testing reviewer, conf 75). Same file. Add one test immediately after the existing `?type=foo` 400 case asserting that `?type=PAPER` (or any mixed-case variant) returns `400 BAD_REQUEST`. Pins the case-sensitive enum contract so a future defensive `.toLowerCase()` addition before the `includes` check (a reasonable-looking change in isolation) does not silently widen the accepted surface.

Once both items land, `git mv` this file back to `tasks/review/` and the next architect review pass will pick it up. Findings #1, #3, #4 from the same review pass were split into the separate sweep task `backend-search-query-param-typeof-narrow-sweep.md` (already in `pending/`); finding #2 (SearchResult review variant in `api-contracts/papers.md`) was applied in-place by the architect during this re-review.

---

## Backend re-review signal (2026-05-13, working tree)

Both hold-block items landed in `backend/tests/routes/search.test.ts`:

1. **Non-vacuous guard on `?type=review` happy-path test.** Added `expect(res.body.data.length).toBeGreaterThan(0)` before the `for…of` loop. Also tuned the query from `q=science` to `q=evaluation` — the original `q=science` returns zero rows in the live HAF corpus because `science` is not a substring of `scientific`/`scientist` (the only terms the single accredited review uses near that domain). `q=evaluation` matches the `@pevo.science/re-pevotestbridge-…` review body, which discusses "open evaluation" / "scientific evaluation" and survives the accreditation + non-self-review gates. Inline comment in the test file documents the query choice so a future maintainer doesn't revert to the broken `q=science`.

2. **Case-sensitivity pin.** Added a new `?type=PAPER` (mixed-case) test immediately after the existing `?type=foo` 400 case, asserting `400 BAD_REQUEST` with `Must be one of` message. Inline comment notes the future-defensive-`.toLowerCase()` regression vector this pins.

Verification: `backend/tests/routes/search.test.ts` runs 24/24 green against real HAF + Postgres + Redis (~41s). No other test files touched. No code changes outside the test file.

Lane-3 footnote: the lane-3 accreditation tests at `search.test.ts:233-279` still use `q=science&type=review&limit=50` and are vacuous against the same corpus today — they pass because their loop doesn't iterate. Out-of-scope for this hold cycle (hold items targeted the happy-path test only), but worth surfacing for the architect's awareness. If a follow-up non-vacuous guard sweep is desired, the same `q=evaluation` tune would close it.

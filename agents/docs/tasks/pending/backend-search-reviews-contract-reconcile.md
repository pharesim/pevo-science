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

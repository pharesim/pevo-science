# Drop block_num floor from retracted-papers CTE to fix slow papers list

**Owner:** backend
**Created:** 2026-05-21

## Symptom

`GET /api/papers` (the papers list) is several seconds slower than `GET /api/papers/:author/:permlink` (a single paper). The list spends most of its time inside `retractedPapersCteBody`.

## Root cause

Same BitmapAnd trap as commit 285e7c14, half-fixed. That commit dropped the `cj.block_num >= $genesis` filter from `activeAccreditationsCteBody` because the planner combined `custom_id = $appTag` (15-row namespace) with the block_num floor via BitmapAnd, forcing a parallel index scan over 49M+ operation rows. CTE execution dropped from ~3.2s to ~14ms.

The commit message explicitly deferred the symmetric fix on `retractedPapersCteBody` and `activeVouchesCteBody` because neither was on the paper-detail hot path. The papers list path *is* one of those deferred sites: `fetchPapersFromHaf` composes `activeAccreditationsCteBody` (fixed) plus `retractedPapersCteBody` (still has the floor) and joins via `NOT EXISTS` against the slow CTE for every listed paper.

The paper-detail path is fast because it sidesteps the CTE entirely. Retraction info is fetched separately via the cached `getRetractionInfo` (`papers.ts:2685`), which reads from a periodically refreshed cache populated by `loadRetractedPapers` and never invokes the slow CTE inline per-request.

## Scope

Mirror the 285e7c14 fix on the three retracted-paper read sites:

1. `retractedPapersCteBody` in `backend/src/hafsql.ts:252` — drop `AND cj.block_num >= $${p + 1}`, remove the now-unused param and `getCachedGenesisBlock()` reference, update docstring.
2. `loadRetractedPapers` in `backend/src/routes/papers.ts:2665` — drop `AND cj.block_num >= $2`, remove `getCachedGenesisBlock()` param.
3. `isRetracted` in `backend/src/routes/papers.ts:3246` — no block_num floor today; verify the query is still selective without one (it already filters by exact author+permlink JSON-path equality, which is much narrower than the CTE's "all retractions"). No change expected; included here so the reviewer can confirm the sweep is complete.

## Why this is safe

The existing `custom_id = $appTag` filter alone is selective enough on Mahdi's HAF (15 rows in the `pevotest` namespace today). The block_num floor existed to exclude pre-namespace operations from generic indexes; that role is fully covered by the custom_id filter once the namespace is established.

There is a separate, pre-existing forgery gap: none of the three retracted-paper queries gates on `required_posting_auths`, so in principle anyone could broadcast `{action: "retract_paper", author: "victim", permlink: "victim-paper"}` under the pevotest custom_id and suppress the victim's paper from listings. The handler at `papers.ts:3263` broadcasts via the admin posting key, but that's a producer-side convention, not a chain-enforced read-side gate. This is NOT in scope for this task — it predates the fix and would re-introduce a `required_posting_auths ?| [admin]` predicate that needs separate design (admin key rotation, multi-admin, etc.). File as a follow-up.

## Out of scope (deferred)

- `activeVouchesCteBody` at `hafsql.ts:214` — same shape, only used in `wot.ts` (web-of-trust endpoints). Not blocking the papers list.
- `authorshipClaimsCteBody` at `hafsql.ts:603` — same shape, used in `claims.ts`, `profile.ts`, and paper-detail (`papers.ts:2972`). Paper-detail invocation is scoped (`{ paperAuthor, paperPermlink }`), which mostly defangs the BitmapAnd via additional selectivity; unscoped uses in `claims.ts`/`profile.ts` may be slower but are not on the listing hot path.
- The retract-forgery gate (see "Why this is safe" above).

## Acceptance criteria

- `GET /api/papers` cold-path latency drops to comparable territory as `GET /api/papers/:author/:permlink` (sub-second on local dev against the real HAF).
- `retractedPapersCteBody` no longer references `getCachedGenesisBlock()`.
- `loadRetractedPapers` no longer references `getCachedGenesisBlock()`.
- Docstring on `retractedPapersCteBody` mirrors `activeAccreditationsCteBody`'s explanation of why no block_num floor (cross-reference the existing rationale at `hafsql.ts:89-98`).
- Existing tests pass (`backend/tests/hafsql.test.ts`).
- Manual repro: hit `/api/papers` against local dev backend, confirm the response time is no longer dominated by the retracted-papers CTE.

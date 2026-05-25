# BACKEND-EXTRACT-CHAIN-CUMULATIVE-HELPER-TO-LIB — move `resolveChainCumulativeAuthors` + per-row enrichment loop out of routes into `backend/src/lib/chain-cumulative.ts`

**Owner:** Backend Agent
**Created:** 2026-05-21 (architect, follow-up surfaced during `/ce-code-review` of `backend-cumulative-union-listing-surfaces-parity` round-1)
**Priority:** P2

## Problem

The cumulative-union helper landed inside `backend/src/routes/papers.ts` (a 3500+ line route file). Two consequences:

1. **Route-to-route import.** `backend/src/routes/profile.ts` imports `resolveChainCumulativeAuthors` and `ChainCumulativeAuthorsResult` directly from `./papers.js`. The helper has no conceptual relationship to the papers HTTP surface — it is a chain-domain utility. Any future consumer needing the helper must also import from a route file, creating a fan of route-to-route dependencies. Maintainability persona flagged at confidence 90; the pattern is set to grow with even one more consumer.

2. **Per-row enrichment loop duplicated verbatim between listing and profile.** `fetchPapersFromHaf` and `fetchUserPapersFromHaf` both contain a `Promise.all`-over-rows pattern that constructs `Map<string, ChainCumulativeAuthorsResult>`, fans out `resolveChainCumulativeAuthors` per row, catches per-row errors, and sets the map entry on non-null. The only differences are the row type and the logger message string. The fallback path (null check, accredited_authors rebuild from head-meta) also diverges slightly between the two, making future fixes asymmetric by default. Maintainability persona flagged at confidence 85.

The two findings have one fix: lift both the helper and the enrichment loop into a neutral lib module that both routes consume.

## Goal

Extract two symbols into `backend/src/lib/chain-cumulative.ts`:

- `resolveChainCumulativeAuthors(rootAuthor, rootPermlink, options)` — the existing helper, signature unchanged (including the `prebuiltChainPosts` option that the detail surface uses for write-through cache-warming).
- `enrichRowsWithChainAuthors(rows, ctx)` — a new shared per-row enrichment helper consumed by both `fetchPapersFromHaf` (listing) and `fetchUserPapersFromHaf` (profile). The function takes a row array + an enrichment context (accreditation sets, signal, memo) and returns the populated `Map<string, ChainCumulativeAuthorsResult>` plus any error logging.

`papers.ts` and `profile.ts` import both symbols from the new module. The internal private helpers (`buildChainCumulativeFromPosts`, `computeChainCumulativeFromHaf`) move with the public helper unless they have call-sites outside the cumulative-union pipeline — in which case stay in `papers.ts` and re-import as needed.

## Acceptance

- `backend/src/lib/chain-cumulative.ts` exists, exporting at minimum `resolveChainCumulativeAuthors` and `enrichRowsWithChainAuthors` (plus the `ChainCumulativeAuthorsResult` type).
- `backend/src/routes/papers.ts` listing call-site uses the shared `enrichRowsWithChainAuthors` and no longer carries the per-row fan-out logic inline.
- `backend/src/routes/profile.ts` papers enrichment block uses the same shared helper; the route-to-route import on `./papers.js` for these symbols is gone.
- Detail-surface call to `resolveChainCumulativeAuthors` continues to work with the `prebuiltChainPosts` option for write-through cache-warming (helper contract unchanged).
- All existing tests pass (no behavioral change). Cache key + TTL unchanged.
- No new comment-anchor rot introduced in the moved code.

## Out of scope

- Changing the helper's signature or the option-bag shape (architect ratification already accepted `prebuiltChainPosts` as the contract).
- Changing the cache key, TTL, or epoch-guard behavior (parent task `backend-cumulative-union-listing-surfaces-parity` carries the epoch-guard fix; coordinate the two landings so the extraction either lands before or after the parent task's hold cycle, not in parallel).
- Extracting `findCanonicalRoot` or `resolveContinuationChain` — both stay in `papers.ts` for now; this task is scoped to the cumulative-union helper + its enrichment loop.

## Coordination

Land this after `backend-cumulative-union-listing-surfaces-parity` archives so the helper is at its final shape (post-`getOrSet` routing, post-TypeScript-widening). Landing in parallel risks merge conflicts in the same function block. Backend confirms ordering at startup; if the parent task is still in hold, this task waits.

## Source

- `/ce-code-review` maintainability M1 (route-to-route import, confidence 90) + M3 (per-row enrichment loop duplicated, confidence 85) during round-1 review of `backend-cumulative-union-listing-surfaces-parity` (2026-05-21).

## [BLOCKED by Architect] (2026-05-25)

Held out of the P0/P1/P2 backend batch. This task's own Coordination section requires it to land *after* `backend-cumulative-union-listing-surfaces-parity` archives, so the cumulative-union helper is at its final post-review shape. That parent task is currently in `agents/docs/tasks/review/` (awaiting architect review), NOT archived. Landing the extraction now risks merge conflicts in the same `papers.ts` function block if the architect holds the parent back with `papers.ts`-touching fixes.

Unblock condition: architect archives `backend-cumulative-union-listing-surfaces-parity`. At that point the helper shape is final; architect `git mv`s this file back to `pending/` and backend can extract `resolveChainCumulativeAuthors` + `enrichRowsWithChainAuthors` into `backend/src/lib/chain-cumulative.ts` without churn.

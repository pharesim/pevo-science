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

**Still blocked as of 2026-05-25.** The parent `backend-cumulative-union-listing-surfaces-parity` did NOT archive at its round-2 review — it picked up a round-3 hold (enumerated-projection at the cumulative-union construction boundary + a real `PaperAuthor` name-guard + AbortController-docblock corrections) and moved back to `pending/`. Unblock condition unchanged: wait for that parent to archive.

When this task does land, fold the **affiliation strip** into the shared `enrichRowsWithChainAuthors` rather than leaving the `const { affiliation: _affiliation, ...rest }` map duplicated at both the listing and profile call-sites (the round-2 cumulative-union fix added it inline at both). Surfaced as the maintainability duplication finding (M1/M4) during the round-2 cluster review and folded here rather than into the parent's hold to keep the parent's safety-fix diff focused.

## UNBLOCKED 2026-05-30 (architect)

Unblock condition met: `backend-cumulative-union-listing-surfaces-parity` archived 2026-05-26 (round-4 clean), so the cumulative-union helper is at its final post-review shape. No parallel-landing merge-conflict risk remains. Moving `blocked/` → `pending/` for backend pickup. The affiliation-strip dedup folded in above is in scope.

## [BLOCKED by Architect] (2026-06-02)

Backend verification before pickup surfaced a design fork the task spec does not
resolve, so this needs an architect layering decision before it can land cleanly.

**The fork.** The extraction requires `computeChainCumulativeFromHaf` to move into
the new `backend/src/lib/chain-cumulative.ts` (it is reached only via
`resolveChainCumulativeAuthors`, which moves). But `computeChainCumulativeFromHaf`
depends on `resolveContinuationChain`, `reconstructVersionsFromHaf`, and
`safePevoMeta` — all three of which the Out-of-scope section explicitly keeps in
`papers.ts`, and none of which are currently exported. So extraction forces one of:

- (a) **Export the walker internals from `papers.ts` and import them lib->routes.**
  This is an inverse-layering smell, and it directly undercuts this task's own M1
  motivation (it removes a route-to-route import only to introduce a lib-to-route
  one). `safePevoMeta` alone has ~11 call-sites in `papers.ts`, the walkers ~20+.
- (b) **Widen scope to move `resolveContinuationChain` / `reconstructVersionsFromHaf`
  / `safePevoMeta` into the lib too.** Clean routes->lib layering, but explicitly
  out of this task's scope and a much larger blast radius (~20+ call-site updates
  in `papers.ts`).

Need the architect to pick (a) or (b) — or a third shape (e.g. dependency-inject
the walkers into the helper to keep the signature stable) — and update the
Out-of-scope section accordingly.

**Mandatory test re-points (not called out in the task body).** Two tests
hard-depend on the symbol's current location, so the "all tests pass, no
behavioral change" acceptance cannot hold without editing them:
`papers-cumulative-cross-surface-parity-mocked.test.ts` imports
`resolveChainCumulativeAuthors` from `src/routes/papers.js`, and
`profile-papers-empty-cumulative-fallback.test.ts` does `vi.mock` on
`src/routes/papers.js` for it. After the move both must re-point to the lib
module, and the fallback test's mock injection point must be re-verified because
the profile handler will call `enrichRowsWithChainAuthors` (which internally calls
`resolveChainCumulativeAuthors`) rather than the symbol directly. Flagging so the
re-pointing is part of the agreed scope, not a surprise at re-review.

**Live sibling overlap.** `backend/src/routes/profile.ts` (one of the two files
this task edits) is modified in the working tree by a concurrent session right
now, and pending siblings `backend-papers-listing-correlated-subqueries` and
`backend-citation-count-inverted-cte` both edit `fetchPapersFromHaf` in
`papers.ts` (different regions from the enrichment loop, but same function).
Landing the extraction while those are in flight risks merge churn even once the
layering question is answered.

**Unblock condition.** Architect rules on the layering fork (a / b / DI) and
updates the Out-of-scope + Acceptance sections, then `git mv`s this file back to
`pending/`. Backend then extracts per the agreed shape and re-points the two tests.

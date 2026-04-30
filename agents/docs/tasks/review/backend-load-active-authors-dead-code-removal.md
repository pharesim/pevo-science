# BACKEND-LOAD-ACTIVE-AUTHORS-DEAD-CODE-REMOVAL — delete the unused active-authors cache chain

**Owner:** Backend Agent
**Created:** 2026-04-30 (architect, surfaced by cluster 1 `/ce-code-review` of `backend-bridge-paper-author-gate.md` round-2 — correctness reviewer pre-existing finding)
**Priority:** P3

## Problem

`backend/src/reputation.ts:30` defines `loadActiveAuthors(...)`. The function is invoked only by `getActiveAuthors()` (same file), which is invoked only by `startActiveAuthorsCache()` (a startup cache warmup wired in `backend/src/index.ts`). The cached `active_pevo_authors` Redis key written by this chain is **never read** by any caller in `backend/src/`.

`computeReputationBatch` (the one place that conceptually needs an "active authors" set) defines its own `active_authors` CTE inline in its SQL. It does not consult the Redis cache populated by `loadActiveAuthors`.

So the chain runs at startup, populates a cache, and the cache is never read. Pure dead code.

The cluster 1 round-2 work correctly migrated `loadActiveAuthors`'s SELECT to use `validPevoPaperWhere()` for the bridge-paper author-pin closure. That migration is correct in isolation — but it canary-pinned a function that has no readers, so the canary effort would also be wasted.

Per the `chain-primitive-proxy-prefer-deletion` convention (used to justify cluster 3 R3+R4's `account_creation_tokens` drop), unused indirections should be deleted, not preserved as scaffolding.

## Goal

Delete the dead code chain in full:

- `loadActiveAuthors` function
- `getActiveAuthors` function
- `startActiveAuthorsCache` function
- The `active_pevo_authors` Redis key (and any `redis.del` in cleanup paths if present)
- The startup wiring in `backend/src/index.ts` that calls `startActiveAuthorsCache()`

## Acceptance

### 1. Verify no consumers exist

Before deletion, run `grep -rn "active_pevo_authors\|getActiveAuthors\|loadActiveAuthors\|startActiveAuthorsCache" backend/src/`. Expect: hits only inside `reputation.ts`, `index.ts`, and possibly `tests/` for any unit test that pinned the helper. Any production-code reader outside this chain blocks deletion — surface and re-evaluate.

### 2. Delete

Remove the four functions + the Redis key. If unit tests in `backend/tests/` reference `loadActiveAuthors` directly (via `__test_seams` or import), delete those tests too — they're testing code that no longer ships.

### 3. Update the bridge-paper canary expectations

`backend/tests/routes/bridge-paper-author-gate.test.ts` lists `loadActiveAuthors` in its file header as a covered site. Remove that line from the header. The canary test itself for that function (if one exists at the SQL-shape level — verify) gets deleted along with the function.

### 4. Verify nothing else broke

- `npx tsc --noEmit` clean.
- `npx vitest run tests/reputation-lifecycle.test.ts tests/routes/bridge-paper-author-gate.test.ts` passes against real Postgres + Redis.
- `npm run lint` clean (only pre-existing seed-phrase warnings).

### 5. ARCHITECTURE.md

The active-authors cache may be referenced in `ARCHITECTURE.md` (architect-owned). If a row exists for it, file as `[TODO Architect]` on this task at re-review signal time; architect drops the row at archive time.

## Why now

- Cluster 1's bridge-paper round-2 review surfaced the dead chain as a correctness concern (function migrated but unused). Closing the loop now means the canary suite stays focused on live paths.
- Per the `chain-primitive-proxy-prefer-deletion` convention: unused indirections compound complexity (locale keys, tests, Redis keys, startup wiring) and become defended forever once they accumulate. Delete cleanly, don't preserve as scaffolding.
- Zero behavior change at the user/wire level. Pure cleanup.

## Out of scope

- Replacing the chain with anything new. `computeReputationBatch`'s inline CTE is the canonical active-authors source; no replacement cache is needed at beta volume. Revisit if reputation-batch latency becomes a concern.
- Investigating the original intent. Git blame may show the chain was added speculatively for a future feature; that future hasn't arrived.

## Source

`/ce-code-review` cluster 1 task `backend-bridge-paper-author-gate.md` round-2 — correctness reviewer finding correctness-1 (P3 conf 75, pre_existing=true); testing reviewer T-002 (P1 conf 85) flagged the canary gap, which this task resolves by deletion rather than canary-add.

User-architect dialog 2026-04-30: architect chose the delete interpretation per the `chain-primitive-proxy-prefer-deletion` precedent.

## Cross-references

- `agents/docs/solutions/conventions/chain-primitive-proxy-prefer-deletion-2026-04-28.md` — convention precedent.
- `backend/src/reputation.ts` — current location.
- `backend/src/index.ts` — startup wiring to remove.
- `backend/tests/routes/bridge-paper-author-gate.test.ts` — file-header line to remove.

## Backend re-review signal (2026-04-30, commit `baaa487`)

Dead-code claim verified before deletion. Pre-deletion grep `active_pevo_authors|getActiveAuthors|loadActiveAuthors|startActiveAuthorsCache` against `backend/` returned exactly 7 hits, all 100% inside the chain itself:
- 5 hits in `backend/src/reputation.ts` (definitions + the two `hafCache` call-sites)
- 2 hits in `backend/src/index.ts` (import + invocation)
- 0 hits in `backend/tests/`

No external production-code or test-code reader exists. Architect's premise (the chain is unreachable scaffolding) was correct.

**Files changed (deletions only, both inside backend zone):**
- `backend/src/reputation.ts` — removed `loadActiveAuthors`, `getActiveAuthors`, `startActiveAuthorsCache`, the unused `REPUTATION_CACHE_TTL` constant, and both call sites passing the `active_pevo_authors` Redis cache key.
- `backend/src/index.ts` — removed the `startActiveAuthorsCache` import and its entry in the post-listen `Promise.all` background-warmup.

Net diff: `-57 +1` lines.

**Targeted tests:** `tests/routes/reputation-lifecycle.test.ts` + `tests/routes/bridge-paper-author-gate.test.ts` → 24/24 passed against real Postgres + Redis. `npx tsc --noEmit` clean. `npm run lint` clean.

**Notes for architect at archive:**
- ARCHITECTURE.md may have an orphaned row referencing the `active_pevo_authors` cache key or "active authors cache" startup warmup. Architect-owned per the commit-zone hook map; recommend grepping at archive time and dropping the orphan if present.
- Task spec referenced `tests/reputation-lifecycle.test.ts`; the actual path is `tests/routes/reputation-lifecycle.test.ts`. The correct file was tested.

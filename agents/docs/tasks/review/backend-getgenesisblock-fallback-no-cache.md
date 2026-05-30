# BACKEND-GETGENESISBLOCK-FALLBACK-NO-CACHE — `getGenesisBlock` fallback permanently caches HEAD on first-boot, pinning genesis until restart

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #34 low severity, correctness)
**Priority:** P3 (single-instance restart fixes it; ops notice "site empty" quickly)

## Problem

On a fresh deployment before any accreditation exists, the primary query in [hafsql.ts:849-862](backend/src/hafsql.ts#L849-L862) returns NULL → the fallback caches HEAD → once the first accreditation lands, the running backend's `cj.block_num >= genesis` predicates remain pinned at HEAD-at-boot and return zero rows until restart.

Single-instance restart fixes it. Ops notice "site empty" quickly. But it shouldn't happen.

## Goal

Assign `genesisBlock` only on a successful primary query; keep the fallback returning a safe HEAD value for the current call without pinning.

### Suggested approach

- Successful primary query → cache the genesis.
- Fallback (no accreditation yet) → return HEAD for this call only (preserves safe-fail semantics) but do NOT cache.
- One extra cheap indexed primary query per call until first accreditation exists — bounded.

## Acceptance

- Regression test: fresh DB (no accreditations) — first call to `getGenesisBlock` returns HEAD without caching; after first accreditation lands, the next call queries primary and caches the real genesis.
- Existing post-genesis behavior unchanged (cached after first successful primary).
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Single-instance project (PEvO is single-instance forever per project context), so no multi-replica genesis-drift concerns to consider.
- Smallest fix; isolated to one function.

## Cross-references

- [backend/src/hafsql.ts](backend/src/hafsql.ts) lines 849-862 (`getGenesisBlock`).
- HAF-query review run `w274tijk0` rank #34.

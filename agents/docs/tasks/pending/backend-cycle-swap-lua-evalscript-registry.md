# BACKEND-CYCLE-SWAP-LUA-EVALSCRIPT-REGISTRY — `CYCLE_SWAP` Lua bypasses the `evalScript` registry the lock-release path uses

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #32 low severity, simplification)
**Priority:** P3

## Problem

[reputation-batch.ts:96-108, 353-362, 389-394](backend/src/reputation-batch.ts#L96-L108) imports `evalScript` and uses it for `RELEASE_LOCK_IF_TOKEN_MATCHES`, but invokes `CYCLE_SWAP_LUA` via direct `redis.eval`.

The registry preamble explicitly states direct `redis.eval` is for ad-hoc one-offs; `CYCLE_SWAP` is load-bearing, unique, and a stronger registry candidate than the listed exceptions.

## Goal

Route `CYCLE_SWAP` through the same registry the sibling lock-release uses.

### Suggested approach

- Move only the Lua body into `SHARED_SCRIPTS.CYCLE_SWAP`.
- Add `CYCLE_SWAP: 0 as number` to `_SCRIPT_RETURN_SHAPE`.
- Replace direct `redis.eval` with `evalScript(redis, 'CYCLE_SWAP', ...)`.
- Keep `CYCLE_SWAP_STAGING_SUBSTRING` / `PROD_SUBSTRING` in `reputation-batch.ts` to avoid layer inversion.
- Re-export via `__test_seams` as `CYCLE_SWAP_LUA` so existing tests keep passing.

## Acceptance

- `CYCLE_SWAP` runs through `evalScript` like `RELEASE_LOCK_IF_TOKEN_MATCHES`.
- Existing tests pass without modification (the `__test_seams` re-export keeps the test surface stable).
- Atomicity behavior unchanged (single `EVAL`, same script body).
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Interacts with #21 (Redis SCAN replacement) — if both land, coordinate the Lua change (adding SADD/SREM for the batch members set) with this registry move.
- Pure structural cleanup; no semantic change.

## Cross-references

- [backend/src/reputation-batch.ts](backend/src/reputation-batch.ts) lines 96-108, 353-362, 389-394.
- `SHARED_SCRIPTS`, `evalScript`, `_SCRIPT_RETURN_SHAPE` (grep for the precise file).
- HAF-query review run `w274tijk0` rank #32.

---

## Architect re-review (2026-05-30) — HELD PENDING FIXES

Round-1 review on commit `25e49feb`. Code verified correct: Lua body byte-identical after the move, KEYS/ARGV order preserved exactly, atomicity intact (single EVAL/EVALSHA), return value ignored by the caller. One item holds archive:

1. **New `evalScript('CYCLE_SWAP')` dispatch path untested** (P1, tests). The only CYCLE_SWAP test still calls `redis.eval` on the re-exported `__test_seams.CYCLE_SWAP_LUA` body directly, bypassing the registry path production now uses (script-name lookup, EVALSHA-warm / EVAL-cold / NOSCRIPT-recovery, the `_SCRIPT_RETURN_SHAPE` boundary). `RELEASE_LOCK_IF_TOKEN_MATCHES` has an `evalScript`-path test; CYCLE_SWAP needs the equivalent. Add a test that calls `evalScript(redis, 'CYCLE_SWAP', keys, argv)` against real Redis and asserts the staging-key rename + sentinel DEL; also add a `SHARED_SCRIPTS.CYCLE_SWAP === CYCLE_SWAP_LUA` membership assertion alongside the existing two.

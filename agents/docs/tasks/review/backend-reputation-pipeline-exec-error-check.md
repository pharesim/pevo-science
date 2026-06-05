# BACKEND-REPUTATION-PIPELINE-EXEC-ERROR-CHECK — `pipeline.exec()` per-command errors silently committed before atomic Lua swap

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #22 medium severity, correctness)
**Priority:** P2 (violates the explicit atomicity invariant; on partial failure leaves prod keys at a mix of cycle N and cycle N+1 until next run ~1h later)

## Problem

ioredis `pipeline.exec()` does NOT throw on per-command errors — it resolves with `[[err, result], ...]` and the outer error is always null. [reputation-batch.ts:339-362](backend/src/reputation-batch.ts#L339-L362) never inspects per-command errors.

If a staging SET fails, sentinel still gets SET, and the Lua RENAME throws `ERR no such key` mid-loop. Crucially, Redis scripts are NOT transactions — already-executed RENAMEs in the loop are committed, leaving prod keys at a mix of cycle N and cycle N+1 until next run (~1h).

This directly violates the explicit atomicity invariant documented at lines 13-14 and 81-82.

## Goal

Inspect per-command errors after `pipeline.exec()` and bail before the sentinel SET if any failed.

### Suggested approach

```typescript
const results = await pipeline.exec();
if (!results || results.some(([err]) => err !== null)) {
  break;
}
// ... existing sentinel SET + Lua swap
```

Leaves `cycle:last` unadvanced and lets `clearStagingKeys` on the next run cleanly drop the partial set without entering the destructive Lua path.

## Acceptance

- Regression test: inject a staging SET failure (e.g. via a Redis-mock seam); assert the sentinel is NOT set and `cycle:last` is NOT advanced.
- Happy-path tests stay green.
- The invariant documented at lines 13-14 / 81-82 now holds — pin via test that explicitly asserts no partial cycle state survives a per-command failure.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Compounds with #10 (SQL-error silent advance) — both are "don't advance `cycle:last` on failure" defects, but at different layers. Land both.
- Interacts with #32 (CYCLE_SWAP via evalScript) — the registry move is orthogonal; this fix is in the caller path, not the Lua.

## Cross-references

- [backend/src/reputation-batch.ts](backend/src/reputation-batch.ts) lines 339-362, lines 13-14 + 81-82 (atomicity invariant docblock).
- HAF-query review run `w274tijk0` rank #22.

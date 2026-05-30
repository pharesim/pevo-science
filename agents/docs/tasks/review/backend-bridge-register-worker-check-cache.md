# BACKEND-BRIDGE-REGISTER-WORKER-CHECK-CACHE — `/register` bypasses the existing `/check` Redis cache (3 uncached HAF round-trips per registration)

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #27 medium severity, performance)
**Priority:** P3 (typical user flow pays 3 uncached HAF round-trips for the same key inside a 30s window)

## Problem

`GET /check` writes to `hafCache` as `bridge-check:${type}:${id}` with 30s TTL.

`POST /register` ([routes/bridge.ts:327-330, 540](backend/src/routes/bridge.ts#L327-L330)) and the worker tick ([bridge-worker.ts:101](backend/src/bridge-worker.ts#L101)) both call `findBridgeDuplicate` directly with no cache probe.

Typical user flow (`/check` → `/register` → worker dispatch) inside the 30s window pays 3 uncached HAF round-trips for the same key.

## Goal

Have `/register` probe the same cache `/check` populated, while keeping the worker's check uncached (last defense against burning a chain cooldown on a duplicate).

### Suggested approach

Add the cache probe inside `checkExistingBridge`, but ONLY for the `/register` caller path (or have `/register` probe before delegating).

**Do NOT** extend the read to the worker's `checkExistingOnChain` — that's the last defense against burning a ~5-min chain cooldown on a duplicate broadcast. A 30s-stale `exists:false` cache hit there re-introduces exactly the duplicate-broadcast risk the fresh check exists to close.

## Acceptance

- `/register` called within 30s of a matching `/check` skips the HAF round-trip and uses the cached `exists` value.
- The worker's `checkExistingOnChain` continues to bypass the cache (still fires a fresh HAF query per tick).
- Regression test: simulate the `/check → /register` flow, assert the second call hits cache.
- Regression test: simulate `/register` then worker tick, assert the worker still queries HAF directly.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.
- Redis key prefix `${config.appTag}:` discipline maintained.

## Notes

- Small isolated change; no schema or API impact.

## Cross-references

- [backend/src/routes/bridge.ts](backend/src/routes/bridge.ts) lines 327-330, 540 (`/register` handler).
- [backend/src/bridge-worker.ts](backend/src/bridge-worker.ts) line 101 (`checkExistingOnChain`).
- `checkExistingBridge` / `findBridgeDuplicate` helpers (path verify during impl).
- HAF-query review run `w274tijk0` rank #27.

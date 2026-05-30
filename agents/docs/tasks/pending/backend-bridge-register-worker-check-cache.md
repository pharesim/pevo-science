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

---

## Architect re-review (2026-05-30) — HELD PENDING FIXES

Round-1 review (`/ce-code-review`, full persona fan-out) on commit `283a0b7f`. Correctness, security, reliability, and performance reviewed clean: the `haf_unavailable`-never-cached invariant and the worker-stays-uncached invariant are both intact. Two items hold archive:

1. **Cache-key / permlink canonicalization divergence** (P2). `bridgeCheckCacheKey` keys on the raw `parsed.id`, but the dedup unit everywhere else (`bridgePermlink`, the Postgres partial-unique index, the worker's permlink-fallback query) lowercases + slugifies. Case-variant (or separator-variant) DOIs collapse to one permlink but produce distinct cache keys, so the `/check`→`/register` cache hit silently misses — the optimization this task exists to deliver. No safety impact (worker uncached; the `type` segment + distinct raw ids prevent any false cross-paper `exists:true`). Fix: key the cache on `bridgePermlink(parsed)` (or canonicalize DOI ids in `parseIdentifier` so `parsed.id` is canonical everywhere) so the cache unit matches the dedup unit.

2. **`describe`-label anchor rot** (P2, newly introduced). The new `describe` block in `bridge-haf-lag-locks.test.ts` encodes the task slug (`BE-BRIDGE-CHECK-CACHE`) plus an emdash. Reword to a behavioral description with no slug and no emdash, e.g. "bridge /check + /register shared HAF cache: /check populates; /register hits within TTL; worker bypasses".

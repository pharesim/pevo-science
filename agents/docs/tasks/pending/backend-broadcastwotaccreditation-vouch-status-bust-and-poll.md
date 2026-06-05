# BACKEND-BROADCASTWOTACCREDITATION-VOUCH-STATUS-BUST-AND-POLL — reads 60s-cached `vouch_status` that lags the just-broadcast vouch

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #38 low severity, correctness)
**Priority:** P3 (recovery is the next vouch or 60s wait; small impact in practice)

## Problem

`/api/wot/vouch` broadcasts then calls `broadcastWotAccreditation` → `getVouchStatus`, which is wrapped in `hafCache` with 60s TTL keyed only on `vouch_status:${username}` ([wot.ts:143-179, 193-204](backend/src/wot.ts#L143-L179)).

A prior reader can have populated the cache; the threshold check then runs on pre-vouch state. The route returns `accredited:false/skipped` and recovery is the next vouch or 60s wait.

HAF block-ingestion lag (~3s+) is also a factor on this path.

## Goal

Bust the stale cache and briefly poll for the new vouch before running the threshold check.

### Suggested approach

In `/api/wot/vouch`, after the on-chain broadcast:
1. Invalidate `vouch_status:${vouchee}`.
2. Poll `getVouchStatus(vouchee)` up to ~6s (2 blocks), waiting for `vouches.some(v => v.voucher === voucher)` to become true.
3. Then call `broadcastWotAccreditation`.

Cap tightly; on timeout fall through to the existing skipped path.

Bust + poll together — either alone is incomplete (busting alone re-reads the still-stale HAF; polling without busting re-reads the cache).

## Acceptance

- Regression test: a vouch that pushes the vouchee over threshold results in WoT accreditation in the same request (within the poll window).
- A vouch that doesn't push over threshold still returns `skipped` cleanly.
- HAF unreachable / lag exceeds poll cap → fall through to skipped (no 5xx).
- Redis key prefix `${config.appTag}:` discipline maintained.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Land AFTER #35 (`backend-loadwotthreshold-signer-gate`) — that fix ensures the threshold is meaningful (rejects the `threshold=0` injection); without it, this fix amplifies the bug.
- Land AFTER #5 (`backend-active-vouches-signer-gate`) — without it, `getVouchStatus` may admit forged vouches into the polled state.
- Independent of #6 (`/api/wot/retract` cascade-with-wrong-account) — different route.

## Cross-references

- [backend/src/wot.ts](backend/src/wot.ts) lines 143-179 (`/api/wot/vouch`), 193-204 (`broadcastWotAccreditation`, `getVouchStatus`).
- HAF-query review run `w274tijk0` rank #38.

## Architect re-review (2026-06-05) — HELD PENDING FIXES (5 items)

`/ce-code-review` (correctness/adversarial on Opus; reliability/performance/testing/maintainability/project-standards/kieran-typescript on Sonnet; learnings unstructured; ce-agent-native-reviewer skipped per PEvO) on commit 251f94d3. The functional fix is verified sound: the invalidate key matches `getVouchStatus`'s getOrSet key exactly (QueryCache prepends the appTag prefix symmetrically on both paths), the loop always completes one bust+read before any timing check and cannot spin past the deadline, the bust-in-loop shape is safe under the cache epoch guard (in-flight coalesced fetchers skip their write), `voucher` is signer-bound (`req.hiveUsername`, never the body), and the no-5xx posture holds mechanically (`QueryCache.invalidate` swallows Redis errors; `getVouchStatus` catches HAF errors and returns null; every response arm is null-safe). Dismissed at triage: a per-vouchee accreditation-broadcast lock (duplicate op is benign on-chain, single-instance, human-paced) and per-account rate limiting on the poll (accredited-only surface, bounded by the existing byIp readLimiter). Five items hold, all small.

### Items held (must fix before archive)

1. (P2, testing) `wot-vouch-poll.test.ts` asserts invalidate/read call-count equality but never ORDER. Bust-strictly-before-each-read is the load-bearing property (read-then-bust re-caches the stale answer); a mutation swapping the two passes every current assertion. Pin per-iteration order via `mock.invocationCallOrder` (assert invalidate's order index < the paired read's, per iteration) in both poll-loop tests.
2. (P2, maintainability) The cache key `vouch_status:${...}` is spelled independently in `src/wot.ts` (getOrSet) and `routes/wot.ts` (invalidate); a rename in one silently no-ops the bust and reproduces the bug this task fixed, and no test crosses the module boundary. Export a key-builder from `src/wot.ts` (e.g. `vouchStatusCacheKey(username)`), use it at both sites, and keep an INDEPENDENT literal pin in the test (assert the builder's output equals the literal `vouch_status:<name>`) so the shared builder does not defeat the test's value-pin (per the dedup-shared-constant convention doc).
3. (P3, performance + reliability, docblock only) Document in the `pollForVouch` docblock: (a) the timeout path's final iteration re-caches the pre-vouch status with a fresh 60s TTL; the operative mitigation is the block-watcher's clearVolatile flushing volatile keys on each ~3s block tick (the regression window exists only if the block-watcher stalls); (b) `capMs` bounds the sleeps BETWEEN reads, not total duration — worst case is roughly capMs plus one statement_timeout-bounded HAF read. No code change.
4. (P3, testing + correctness) `VOUCH_STATUS_FIXTURE` in `wot-vouch-broadcast-outcomes.test.ts` is internally impossible (`vouch_count: 3` with one `vouches` entry; `eligible: false` at count==threshold). Align it (e.g. `vouch_count: 1, threshold: 3, eligible: false` with the single voucher entry) so future arm tests are not misled.
5. (P3, kieran-typescript, pre-existing fold-in) Same file: give `broadcastWotAccreditationMock` its generic — `vi.fn<() => Promise<WotAccreditationResult>>()` with the type imported from `src/wot.js` — so the per-arm `mockResolvedValueOnce` payloads are shape-checked.

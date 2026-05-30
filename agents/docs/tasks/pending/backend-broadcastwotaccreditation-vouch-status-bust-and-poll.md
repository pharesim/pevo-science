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

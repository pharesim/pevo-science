# BACKEND-WOT-RETRACT-CASCADEREVOCATION-WRONG-ACCOUNT — `/api/wot/retract` invokes `cascadeRevocation` with the voucher; the vouchee never gets re-evaluated and unrelated vouchees get cascaded

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #6 high severity, correctness)
**Priority:** P0 (retract semantics are broken outright — WoT auto-accreditations that should be revoked silently aren't; unrelated vouchees get cascaded)

## Problem

[routes/wot.ts:124-155](backend/src/routes/wot.ts#L124-L155) calls `cascadeRevocation(voucher)` after a retract, but [wot.ts:270-419](backend/src/wot.ts#L270-L419)'s `cascadeRevocation` is designed for the case where an account's **accreditation** was revoked — not where a single vouch was withdrawn.

Its first query returns the voucher's STILL-ACTIVE vouchees — by definition not the just-retracted vouchee — so the one account that actually lost a vouch is never re-evaluated for WoT-threshold loss. Worse, voucher's other still-vouched accounts get recounted with `av.voucher != $voucher`, potentially triggering unrelated revocations.

Net: WoT auto-accreditations that should be revoked on retract silently aren't; unrelated vouchees get cascaded.

## Goal

Make `/api/wot/retract` correctly re-evaluate the **vouchee** (not the voucher) after the vouch is dropped, while leaving `cascadeRevocation(account)` reserved for actual accreditation revocations.

### Suggested approach

In `/api/wot/retract` (after the on-chain retract broadcasts), replace `cascadeRevocation(voucher)` with a vouchee-targeted check:

1. Invalidate `vouch_status:${vouchee}` in the cache.
2. Call `getVouchStatus(vouchee)`.
3. If `vouches.length < threshold` AND `active_accreditations.method === 'wot'`, broadcast a single `revoke_accreditation` and call `invalidateOnRevocation(vouchee)`.

Keep `cascadeRevocation(account)` reserved for actual accreditation revocations (its current consumers from accreditation-revocation paths are correct).

## Acceptance

- Regression test: retract a vouch that drops the vouchee below threshold; assert the vouchee's WoT accreditation is revoked.
- Regression test: retract a vouch that does NOT drop the vouchee below threshold; assert no revocation broadcasts fire.
- Regression test: voucher's OTHER vouchees (unrelated to the retract) are NOT recounted/cascaded by this code path.
- The vouchee-targeted check is a single SQL query, not the multi-step `cascadeRevocation` loop.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Independent of #5 (vouch signer gate). Land both this week.
- Related: #12 (`backend-wot-cascade-single-discovery-query`) collapses `cascadeRevocation`'s 1+2N query shape. That cleanup is orthogonal — but the `cascadeRevocation` function should stay; only the `/api/wot/retract` caller swaps to the new vouchee-targeted check.

## Cross-references

- [backend/src/routes/wot.ts](backend/src/routes/wot.ts) lines 124-155 (`/api/wot/retract` handler).
- [backend/src/wot.ts](backend/src/wot.ts) lines 270-419 (`cascadeRevocation`, `getVouchStatus`, `invalidateOnRevocation`).
- Existing `cascadeRevocation` consumers from real accreditation-revocation paths (those callers stay).
- HAF-query review run `w274tijk0` rank #6.

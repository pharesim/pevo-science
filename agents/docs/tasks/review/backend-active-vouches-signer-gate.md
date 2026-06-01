# BACKEND-ACTIVE-VOUCHES-SIGNER-GATE — `vouch_ranked` accepts unsigned voucher claims; direct path to unauthorized auto-accreditation via WoT

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #5 high severity, correctness/security)
**Priority:** P0 (direct path to unauthorized WoT auto-accreditation; mirror retract attack silently drops legitimate vouches)

## Problem

`vouch_ranked` in [hafsql.ts:251-278](backend/src/hafsql.ts#L251-L278) derives `voucher` from `cj.json` with **NO** `required_posting_auths` check. Sibling CTEs (`activeAccreditationsCteBody`, `retractedPapersCteBody`) correctly enforce this; `vouch_ranked` is the outlier.

Any account can broadcast:

```json
{"action": "vouch", "voucher": "alice", "vouchee": "mallory"}
```

signed only by Mallory. [wot.ts](backend/src/wot.ts) then JOINs `active_accreditations.account = av.voucher`, resolves Alice's accreditation, and counts the forged vouch toward `broadcastWotAccreditation`'s threshold — admitting Mallory.

The mirror `retract_vouch` attack is just as direct: a forged retract signed by anyone supersedes a legitimate prior vouch via latest-block-wins ordering, silently dropping legitimate vouches.

## Goal

Gate `vouch_ranked` on the signer matching the encoded `voucher` field, covering both `vouch` and `retract_vouch` actions.

### Suggested approach

Add to `vouch_ranked`'s WHERE clause:

```sql
AND cj.required_posting_auths ? (cj.json::jsonb ->> 'voucher')
```

The `?` operator covers both `vouch` and `retract_vouch` — both encode the signer in the same `voucher` field.

## Acceptance

- Two regression tests:
  1. Forged `vouch` (Mallory signs, names Alice as `voucher`) is absent from `active_vouches`.
  2. Forged `retract_vouch` does NOT supersede a legitimate prior `vouch` (the legitimate vouch remains active).
- Legitimate vouches and retracts (signer == voucher) continue to work end-to-end. Pin a positive case per action.
- SQL-shape canary asserts the `required_posting_auths ?` predicate is present in `vouchRankedCteBody`.
- One real-HAF dev run confirms the `getVouchStatus` / threshold computation for a known accredited account is unchanged for legitimate vouches.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Independent of #6 (`/api/wot/retract` cascade-with-wrong-account). Land both this week — they're sibling WoT trust-layer defects.
- The `cascadeRevocation` rewrite (#12) is downstream of this in the trust-layer hot path. Land this fix first.

## Cross-references

- [backend/src/hafsql.ts](backend/src/hafsql.ts) lines 251-278 (`vouch_ranked`).
- [backend/src/wot.ts](backend/src/wot.ts) — primary consumer (`getVouchStatus`, `broadcastWotAccreditation`).
- Sibling correctly-gated CTEs: `activeAccreditationsCteBody`, `retractedPapersCteBody` — same shape, reference for the gate clause.
- HAF-query review run `w274tijk0` rank #5.

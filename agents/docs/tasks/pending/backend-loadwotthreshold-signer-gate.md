# BACKEND-LOADWOTTHRESHOLD-SIGNER-GATE — `loadWotThreshold` accepts unsigned `update_params` from any account AND honors `threshold=0`

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #35 low severity, correctness/security)
**Priority:** P2 (small surface but a `threshold=0` injection auto-accredits every account on the first vouch)

## Problem

`loadWotThreshold` in [wot.ts:84-101](backend/src/wot.ts#L84-L101) filters only by `custom_id + action='update_params'` with **NO** `required_posting_auths` gate — any Hive account can broadcast:

```json
{"id":"pevotest", "action":"update_params", "params":{"min_accreditations_for_wot":0}}
```

and influence the threshold.

Plus the JS `??` only catches null/undefined, so a `0` value passes through and auto-accredits every account on the first vouch.

## Goal

Gate `update_params` on the configured accreditation authorities AND validate the threshold is a positive integer.

### Suggested approach

Two-part:

1. **Primary defect (SQL):** add `required_posting_auths ?| $N::text[]` against `config.accreditationAuthorities` to the SQL.
2. **JS validation:** validate `Number.isInteger(n) && n >= 1` before returning; fall back to `DEFAULT_WOT_THRESHOLD` otherwise.

## Acceptance

- Regression test: forged `update_params` (signed by stranger) does NOT influence the threshold.
- Regression test: legitimate `update_params` (signed by accreditation authority) DOES update the threshold.
- Regression test: legitimate broadcast with `min_accreditations_for_wot: 0` (e.g. a typo) falls back to `DEFAULT_WOT_THRESHOLD` (not auto-accredit-everyone).
- Regression test: legitimate broadcast with non-integer (e.g. `"abc"`) falls back to default.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Despite being ranked low severity, the `threshold=0` outcome is a security-grade failure mode. Land before #38 (`broadcastWotAccreditation` vouch-status bust-and-poll), which assumes the threshold is meaningful.
- Mirrors the signer-gate discipline established in #3, #5, #16.

## Cross-references

- [backend/src/wot.ts](backend/src/wot.ts) lines 84-101 (`loadWotThreshold`).
- HAF-query review run `w274tijk0` rank #35.

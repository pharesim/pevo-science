# BACKEND-NOTIFICATIONS-CLAIM-VOUCH-ARMS-SIGNER-GATE — claim/approve/revoke/vouch notification arms lack signer gate; spam-attackable with email amplification

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #16 medium severity, correctness/security)
**Priority:** P2 (nuisance-spam with email amplification; trust/reputation surfaces are correctly gated elsewhere — this is the notification-only surface)

## Problem

Arms 4 (`new_vouch`), 7 (`claim_pending`), 8 (`claim_approved`), 9 (`claim_revoked`) in [notification-queries.ts:292-305](backend/src/notification-queries.ts#L292-L305) and [405-452](backend/src/notification-queries.ts#L405-L452) gate only on `custom_id` + JSON-field equality.

Anyone can broadcast `{"action":"approve_authorship", "claimer":"$1", ...}` with `custom_id=pevotest` and the victim gets an emotional "Your authorship claim was approved" notification + digest email.

Arm 3 (`accreditation_update`) correctly enforces `required_posting_auths` — the discipline is missing from 4/7/8/9. Trust/reputation surfaces ARE correctly gated elsewhere (via `active_accreditations` + the signer-gate work in #3, #5, #16). This is strictly nuisance-spam with email amplification.

## Goal

Apply the per-schema signer gate to each of arms 4, 7, 8, 9.

### Suggested approach

Per [hive-schemas.md](agents/docs/hive-schemas.md):

- **Arm 4 (`new_vouch`):** `cj.required_posting_auths ->> 0 = cj.json::jsonb ->> 'voucher' AND voucher IN active_accreditations`.
- **Arm 7 (`claim_pending`):** `cj.required_posting_auths ->> 0 IN active_accreditations` (per § 2.9, signer IS the claimer).
- **Arm 8 (`claim_approved`):** `cj.required_posting_auths ->> 0 IN (cj.json::jsonb ->> 'paper_author', config.hiveBridgeAccount)`.
- **Arm 9 (`claim_revoked`):** admits the full § 2.11 set `IN (paper_author, claimer, hiveBridgeAccount, hiveAdminAccount)`.

Pair with a SQL-shape canary asserting `required_posting_auths` appears in each of arms 3/4/7/8/9 so future arms inherit the discipline.

## Acceptance

- Regression tests:
  - Forged `vouch` (signed by stranger, names random voucher) → no notification fires for the named vouchee.
  - Forged `approve_authorship` (signed by stranger, names random claimer) → no notification fires for the claimer.
  - Forged `revoke_authorship` (signed by stranger) → no notification fires for the claimer.
  - Forged `claim_authorship` (signed by stranger) → no notification fires for the named paper author.
- Legitimate cases (each signer-permitted by schema) still fire the notification — pin one positive case per arm.
- SQL-shape canary asserts `required_posting_auths` is present in arms 3/4/7/8/9.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Bundle SQL-shape canary churn with #7, #14, #15, #25.
- Independent of #3 (`revoke_authorship` signer gate in the reputation/read surface) — the trust-layer fix is #3; this is the notification-surface fix for the same broadcaster-controlled-event class.

## Cross-references

- [backend/src/notification-queries.ts](backend/src/notification-queries.ts) lines 292-305 (arm 4), 405-452 (arms 7/8/9).
- [agents/docs/hive-schemas.md](agents/docs/hive-schemas.md) §§ 2.9, 2.10, 2.11 (signer enumerations).
- HAF-query review run `w274tijk0` rank #16.

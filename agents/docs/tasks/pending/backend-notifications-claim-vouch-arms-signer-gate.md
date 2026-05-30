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

## Architect re-review (2026-05-30) — HELD PENDING FIXES:

`/ce-code-review` (security + correctness on Opus; testing, maintainability, performance, project-standards on Sonnet; `ce-agent-native-reviewer` skipped per PEvO). Arms 4 (`new_vouch`) and 7 (`claim_pending`) are fully closed — the gate binds the signer to the named voucher AND requires accreditation (arm 4), and requires an accredited signer (arm 7). Two items block archive:

1. **Arms 8 (`claim_approved`) and 9 (`claim_revoked`) signer gates are self-asserting and do not close the forgery.** The gate compares `required_posting_auths ->> 0` against the **JSON-self-asserted** `cj.json::jsonb ->> 'paper_author'` (and, for arm 9, `->> 'claimer'`), with **no accreditation requirement and no proof the named paper exists or is authored by that signer**. Because an attacker controls both the signature (their own posting key) and the `paper_author` JSON field, they can broadcast `{action:approve_authorship|revoke_authorship, paper_author:<self>, claimer:<victim>}`, self-sign, and the gate passes (`signer == self-named paper_author`) — the victim (`json ->> 'claimer' = $1`) receives a spurious "your claim was approved/revoked" notification + amplified digest email. This is the same forgery class the task exists to close; arms 8/9 only narrow it (an attacker can no longer name a *different* real author) rather than closing it. **Fix:** apply the existence-proof pattern the citation arms already use — INNER JOIN the named `(paper_author, paper_permlink)` to the real native paper (`comments` + `validPevoPaperWhere`) or bridge paper (`user_bridge_papers`), and require `required_posting_auths ->> 0` to equal that post's **actual** author (native) or the bridge/admin param (bridge). The bridge-account and admin-account branches (param-bound) and arm 9's `claimer`-self branch are already safe and stay. Add a negative canary per arm: a forged row where the signer self-names as `paper_author` but is NOT the real post author → asserted DROPPED.

2. **Arm-4 comment cites the wrong hive-schemas section.** The `new_vouch` signer-gate comment says "per hive-schemas.md § 2.7" — but § 2.7 is "Retract Paper"; the Vouch (Web of Trust) schema is § 2.5. The gate logic is correct; only the citation is wrong. Per the comment-anchor convention, anchor on the schema **name** ("the Vouch (Web of Trust) schema in hive-schemas.md") rather than a driftable section number. Arms 7/8/9 cite §§ 2.9/2.10/2.11 correctly.

**Dismissed (no action needed):** the source-shape guard + hand-copied canaries assert gate-token *presence* rather than full gate structure, so a future regression weakening a gate could pass undetected. Theoretical-only failure mode at PEvO's scale; dismissed per the preemptive-test-hardening stance. (If you happen to be retouching the canary anyway for item 1's negative cases, tightening the source-shape guard to assert the full signer set per arm is welcome but not required.)

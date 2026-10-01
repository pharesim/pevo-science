# The WoT read side drops a self-vouch

**Owner:** backend
**Created:** 2026-10-01

Surfaced as a pre-existing P2 during the architect review of
`backend-custody-admits-vouch-and-retract` (found independently by the security and adversarial
lenses). The user chose a new task over dismissal (2026-10-01).

## Why

`hive-schemas.md` § 2.5 says a researcher cannot vouch for themselves. The write side enforces
that on two paths: the custody broadcast refuses a self `vouchee` (400) before signing, and
`POST /api/wot/vouch` refuses `voucher === vouchee`. Neither stops a self-custody account from
broadcasting a self-vouch through Keychain, and the read side counts it.

In `backend/src/hafsql.ts`, `activeAccreditationsCteBody` builds the live WoT graph in
`aa_vouch_ranked` → `aa_active_vouches`, and `aa_wot_counts` counts distinct vouchers per vouchee,
joining each voucher against `accred_pinned`. `accred_pinned` is the op-pinned, not-sanctioned
accredited set. It carries no threshold condition, so a `method = 'wot'` member who has dropped
below the threshold is still in it and is still an eligible voucher. Nothing in the chain
excludes `voucher = vouchee`. So a WoT member one vouch short of `min_accreditations_for_wot`
can broadcast a vouch for themselves and stay in `active_accreditations`. For an enrolled
member the effective threshold is one lower than the on-chain parameter.

`activeVouchesCteBody` (`vouch_ranked` → `active_vouches`) has the same gap, which reaches
`vouchStatusSelect` in `backend/src/wot.ts`: a self-vouch from an `accred_pinned` account is
listed among that account's own vouches and counted by the readers of `getVouchStatus`.

A self-vouch from an account that is not yet in `accred_pinned` contributes nothing, because
the voucher join drops it. The gap is limited to accounts already holding an accredit op.

## Scope

1. In both `aa_vouch_ranked` (`activeAccreditationsCteBody`) and `vouch_ranked`
   (`activeVouchesCteBody`), drop rows whose `voucher` equals their `vouchee`, next to the
   existing `required_posting_auths ? (cj.json::jsonb ->> 'voucher')` signer gate. For example:
   `AND (cj.json::jsonb ->> 'voucher') IS DISTINCT FROM (cj.json::jsonb ->> 'vouchee')`.
   Both CTEs partition by the `(voucher, vouchee)` pair, so a self pair only ever ranks against
   other self pairs. Dropping them leaves every other edge's latest-op-wins ranking unchanged.
2. Keep the predicate row-local in the `WHERE` of the `custom_id`-indexed scan. Do not move the
   `AS MATERIALIZED` fence on `aa_vouch_ranked` or change the scan's index shape.
3. If either CTE's docblock describes which vouches it admits, extend it to name the self-pair
   exclusion and the § 2.5 rule it enforces.

## Out of scope

- The write-side refusals (custody broadcast and `POST /api/wot/vouch`). They stay as they are.
- Whether a below-threshold WoT member should stay an eligible voucher for OTHER accounts.
  `accred_pinned` admits them by design; this task changes only the self edge.
- `reputation-algorithm.md` and `hive-schemas.md`. The architect updates docs at archive if needed.

## Acceptance criteria

1. Real-Postgres synthetic-CTE coverage for `activeAccreditationsCteBody`, following the
   redirect pattern `tests/active-vouches-signer-gate.test.ts` uses: a `method = 'wot'` account
   with `threshold - 1` vouches from distinct accredited vouchers plus a self-vouch is NOT in
   `active_accreditations`. The same account with `threshold` real vouches is, with or without
   the self-vouch.
2. Real-Postgres coverage for `activeVouchesCteBody` (the signer-gate test file or
   `tests/wot-vouch-status-select-real-postgres.test.ts`, whichever fits): a self-vouch row
   does not appear in `active_vouches`, and a non-self vouch in the same fixture still does.
3. Each assertion is probed by reverting its own predicate (one probe per CTE); list probe and
   spec in the signal block.
4. New comments follow root `CLAUDE.md` "Comment anchors".

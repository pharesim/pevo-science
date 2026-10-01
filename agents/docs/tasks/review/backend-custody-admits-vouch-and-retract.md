# The custody broadcast admits a light account's vouch and vouch retraction

**Owner:** backend
**Created:** 2026-10-01

## Why

Light accounts are meant to vouch (user decision, 2026-10-01). They cannot today, at two layers:
the custody broadcast refuses the ops, and the profile page hides the forms. This task lifts the
backend layer; `ui-light-account-vouch` lifts the frontend one after it.

In `backend/src/routes/custody.ts`, the `custom_json` arm of `POST /api/custody/broadcast`
admits only the actions in its `allowedActions` list (`revote`, the three credit ops and the two
consent ops). A light account's `vouch` or `retract_vouch` gets 403 `FORBIDDEN`. That limit dates
from when light accounts were introduced and server-side signing covered comments and votes
only; nothing records a reason to keep vouches out.

Nothing else blocks the path. Both ops carry `required_posting_auths: [voucher]`
(`hive-schemas.md` § 2.5, § 2.6), so the stored posting key signs them. `POST /api/wot/vouch`
and `POST /api/wot/retract` already accept a JWT through `verifyHiveSignature` and check that the
voucher is accredited. Light accounts meet the accreditation criteria from signup
(`ARCHITECTURE.md` "Accredited-Only Data Policy").

## Scope

1. Add `vouch` and `retract_vouch` to `allowedActions` in the `custom_json` arm.
2. **Proof kind: the session window** (`ARCHITECTURE.md` § 6.4, the non-consent broadcast row,
   decided 2026-10-01). Do NOT add them to the consent or credit gated sets, and do not add a
   fresh-auth target for them. They go through the session-kind consume like a vote.
3. **Bind the payload to the signer.** For both actions, refuse with 403 `FORBIDDEN` unless
   the payload's `voucher` equals the authenticated username, as the `vote` arm does for
   `voter`. Refuse with 400 `VALIDATION_ERROR` when `vouchee` is not a non-empty string or
   equals the voucher (§ 2.5: a researcher cannot vouch for themselves). The read side already
   ignores a vouch whose signer is not its `voucher` (the signer gate in
   `activeVouchesCteBody`), so this binding is about the server not signing an op that is inert
   or that claims someone else, not about closing a forgery path.
4. Update the `allowedActions` refusal message, which lists the permitted actions.

## Out of scope

- The frontend gate (`ui-light-account-vouch`).
- `agents/docs/api-contracts/custody.md`. Its permitted-action list is already out of date, and
  the architect corrects it once, at the archive of `backend-custody-allowlist-comment-options`
  or of this task, whichever is later.
- The `revocation_outcome` values the frontend's retract handler branches on, which the
  `/api/wot/retract` route no longer returns. That is a separate frontend cleanup.

## Coordination

`backend-custody-allowlist-comment-options` (in `pending/` with a hold) also edits
`custody.ts`, in the `comment_options` arm and its own test file. This task touches only the
`custom_json` arm. Stage your own hunks only.

## Acceptance criteria

1. A light account's `vouch` and `retract_vouch` bundles, each with a valid session-kind
   proof, are broadcast (200), and without a proof they get 401 `FRESH_AUTH_REQUIRED`.
2. A `voucher` other than the signer is 403, and a missing, non-string or self `vouchee` is
   400. Each case is checked before the fresh-auth gate and asserts no broadcast.
3. An unknown `custom_json` action is still 403.
4. Each assertion is probed by reverting its own site; list probe and spec in the signal block.
5. New comments follow root `CLAUDE.md` "Comment anchors".

## Backend implementation signal (2026-10-01, commit 519e6597)

Landed in `519e6597` (verified: `git merge-base --is-ancestor 519e6597 main`).

- `backend/src/routes/custody.ts`, `custom_json` arm: `vouch` and `retract_vouch` added to
  `allowedActions` (the refusal message is built from the list, so it names both). For both
  actions, before the fresh-auth gate: `voucher !== username` is 403 `FORBIDDEN`
  (`<action> voucher must be '<user>'`), and a `vouchee` that is not a string, is empty, or
  equals the voucher is 400 `VALIDATION_ERROR` (`<action> vouchee must be a Hive username
  other than the voucher`). Not added to the consent or credit gated sets, and no fresh-auth
  target, so they take the session-kind consume like a vote.
- `backend/tests/routes/custody-vouch-ops.test.ts` (new, 19 specs, run per action): admit with a
  session proof (200, ops unchanged), second op in the same window (proof not spent), no proof
  (401 `FRESH_AUTH_REQUIRED`, reason `missing`), six pre-gate refusals (each sends no proof and
  asserts no broadcast), and an unknown action (`accredit`) still 403.
- Red before the route change: 19/19 failed. After: green, plus the six sibling custody test
  files (117 tests across 7 files). `npm run typecheck` and eslint clean.
- Wider regression: every test file that references the custody broadcast, `routes/custody`
  or `routes/wot` (33 files ran): 493 passed, 12 failed in 3 files (`idempotency-real-haf`,
  `accreditation-idempotency`, `accreditation`), exit 1. The same 3 files on a copy of
  `519e6597^` (before this change) fail 17 specs, which covers 11 of the 12. The twelfth
  (`findCustodyBroadcastByIdempotencyKey`, another-username scoping) is in the known-failing
  real-HAF file and tests the HAF SQL helper, not the route. None of the three reaches the
  `custom_json` arm.

Mutation probes (AC 4), each run on a scratchpad copy built from `519e6597`, against
`custody-vouch-ops.test.ts`; baseline 19/19 green:

| Probe (site reverted) | Killed by |
|---|---|
| drop `'vouch'` from `allowedActions` | all 9 `vouch` specs + the unknown-action message spec |
| drop `'retract_vouch'` from `allowedActions` | all 9 `retract_vouch` specs + the unknown-action message spec |
| voucher binding off | `a voucher other than the signer is 403`, `a missing voucher is 403` (both actions) |
| drop the `typeof vouchee` check | `a missing vouchee is 400`, `a non-string vouchee is 400` (both actions) |
| drop the empty-vouchee check | `an empty vouchee is 400` (both actions) |
| drop the self-vouchee check | `a self vouchee is 400` (both actions) |
| bind `vouch` only, not `retract_vouch` | all six `retract_vouch` refusal specs |
| route vouch ops through the per-op gate instead of the session window | `with a session-kind proof broadcasts the op unchanged`, `the session-kind proof is not spent...` (both actions) |

[TODO Architect] `agents/docs/api-contracts/custody.md` permitted-action list: add `vouch` and
`retract_vouch` (session-kind proof), and the two new refusals (403 voucher binding, 400 vouchee
shape), per this task's "Out of scope" note.

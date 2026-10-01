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

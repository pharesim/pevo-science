# A retriable 503 at signup finalize, ORCID accredit and the metadata edit reads as a plain failure

**Owner:** ui
**Created:** 2026-10-09
**Priority:** normal

Filed from the architect review of `backend-failed-sanction-read-is-not-a-sanction` (triaged with
the user 2026-10-09). The three spots are the ones that task's implementer signal names; the
review's api-contract lens checked each against the code.

## Why

When the backend cannot read an account's sanction state from HAF, `POST /api/auth/confirm`,
`POST /api/auth/link`, the ORCID accredit callback and `PATCH /api/accreditation/metadata` answer
503 `SERVICE_UNAVAILABLE` with `details.retriable: true` and `Retry-After: 30`, and broadcast
nothing. A real sanction still answers 403 `ACCREDITATION_SANCTIONED`. The SPA consumers:

1. `frontend/src/pages/signup-verify.js` `submitCreateAccount` (and the `/link` submit): the 503
   reaches neither `_handleAmbiguousBroadcastOutcome` nor `_handleFinalizeRefusal`, so the page
   shows `seedPhrase.createAccountFailed` (or `seedPhrase.linkAccountFailed`) and, on `/confirm`,
   returns to the `create-username` phase. The account is already finalized at that point.
   Resubmitting the same username and keys (on `/link`, signing again) finishes the signup within
   an hour of the finalize. Per the implementer's signal: editing the username re-runs
   `_checkUsername`, which then reports the name as taken, and a reload loses the mnemonic.
2. `frontend/src/pages/orcid-callback.js` `_verify`: the 503 shows `orcid.verificationFailed`,
   the copy a sanction refusal also gets. The backend deletes the OAuth state before the accredit
   handler runs, so the retry is a new ORCID flow and a refresh of the callback URL gets a 400.
   The `pevo_orcid_mode` comments say a refresh can retry after a 503; check which 503s that holds
   for and narrow them to it (intent only: write them against the code).
3. `frontend/src/pages/settings.js` `handleMetadataSubmit`: the 503 and the sanction 403 both show
   `settings.metadataUpdateFailed`. Save resubmits, and the 503 does not consume the fresh-auth
   proof.

## Scope

1. Signup verify: a retriable 503 from `/confirm` or `/link` leaves the user on a state that says
   the account exists and accreditation has not finished, keeps the username and the mnemonic,
   and offers a retry that resends the same username and keys (`/confirm`) or signs again
   (`/link`).
2. ORCID callback: a retriable 503 on the accredit mode shows outage copy, distinct from the
   sanction refusal, whose Try Again starts a new ORCID flow.
3. Settings metadata edit: a retriable 503 shows outage copy distinct from the sanction refusal.
4. New strings follow the project's i18n rules; no emdash in UI copy.

## Acceptance criteria

1. With `/confirm` answering the retriable 503, the page does not return to username entry, and
   the retry after HAF answers issues the session. The same for `/link`.
2. On the ORCID accredit mode, the 503 shows the outage copy and Try Again restarts the flow.
3. On the metadata edit, the 503 shows the outage copy and Save succeeds once HAF answers.
4. Unit specs for each consumer's 503 branch.

## Notes

- `ui-orcid-callback-caches-a-departed-subjects-proof` scope 3 keeps "the 503-refresh-retry
  behaviour around `pevo_orcid_mode`"; reconcile with item 2 above if both are open.
- The contract lines for these 503s land in `api-contracts/auth.md`, `accreditation.md` and
  `orcid.md` when the backend task is archived.

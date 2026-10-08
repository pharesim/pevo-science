# A refused vouch notify shows success copy

**Owner:** ui
**Created:** 2026-10-08
**Priority:** normal

## Why

`handleVouch` in `frontend/src/components/vouch-section.js` broadcasts the `vouch` custom_json,
then calls `notifyVouch` (`POST /api/wot/vouch`). The `catch` around that call sets
`step = 'success'` and shows `wot.vouchBroadcastPending` ("Vouch broadcast successfully! Backend
notification pending.") for every rejection.

The notify route answers a voucher outside the accredited set with 403 `FORBIDDEN` ("Only
accredited researchers can vouch"). By then the vouch op is on chain. Nothing retries the notify,
so the page reports a pending notification that was refused.

`canVouch` has no term for the viewer's own accreditation, so these accounts see the form and
reach the 403:

- an unaccredited Keychain account;
- a sanctioned light account;
- a light account whose accredit op HAF has not indexed yet, e.g. right after signup.

The vouch status read (`vouchStatusSelect` in `backend/src/wot.ts`) lists only vouchers that hold
an active accreditation at read time. So a sanctioned voucher's vouch does not count while the
sanction stands, and after the reload the form offers the same vouch again.

Second, adjacent gap in the same handler. When the vouchee's automatic accreditation broadcast
times out or fails, the notify route answers 200 with `accreditation_outcome: 'timeout'` or
`'chain_error'` and `accredited: false`. `handleVouch` reads only `res.data.accredited`, so it shows
plain `wot.vouchSuccess`.

## Scope

1. In `handleVouch`'s notify `catch`, bind the error. On `err.code === 'FORBIDDEN'`
   (`ApiRequestError` in `frontend/src/api.js` carries the envelope code), set a non-success step
   and show new copy under a new `wot.*` key.
   - Copy intent only (write the final copy against the code): the vouch is recorded on chain and
     counts only while the voucher's account is accredited. Do not reuse `wot.vouchFailed`: the
     op landed.
   - Every other rejection (network, 5xx, 429) keeps `wot.vouchBroadcastPending`.
2. When the notify response carries `accreditation_outcome` `'timeout'` or `'chain_error'`, show
   copy under a new `wot.*` key. Copy intent only: the vouch is recorded, and the vouchee's
   automatic accreditation may not have completed.
3. Add each new key to all 16 locale files under `frontend/public/messages/`, following the
   `agents/ui/CLAUDE.md` internationalization rules.
4. Specs in `frontend/tests/unit/components-vouch-section.test.js`:
   - `mockNotifyVouch` rejected with `{ code: 'FORBIDDEN' }` leaves `step` not `'success'` and
     shows the new key;
   - a non-`FORBIDDEN` rejection still shows `wot.vouchBroadcastPending`;
   - each `accreditation_outcome` value shows its copy.

## Out of scope

- `handleRetract`'s notify `catch` has the same shape (`POST /api/wot/retract` also answers 403
  `FORBIDDEN`). A voucher outside the accredited set has no listed vouch, so `canRetract` is
  false for it. Reaching that 403 needs accreditation lost between the status read and the
  click, and the retraction itself has landed by then. Leave `handleRetract` unchanged.
- Hiding the vouch form from a viewer outside the accredited set. The auth store's `isAccredited`
  would not catch a sanction that lands after login, and hiding the form is a product question.
- Repairing a vouchee whose automatic accreditation was missed:
  `backend-wot-enrollment-has-a-single-trigger` (`blocked/`).

## Acceptance criteria

1. A `FORBIDDEN` notify rejection shows the new non-success copy, and other rejections keep
   `wot.vouchBroadcastPending`.
2. A 200 notify with `accreditation_outcome` `'timeout'` or `'chain_error'` shows the new
   degraded copy, not plain `wot.vouchSuccess`.
3. Each new key is in all 16 locale files per the ui i18n rules.
4. Each assertion is probed by reverting its own site; list probe and spec in the signal block.
5. New comments follow root `CLAUDE.md` "Comment anchors".

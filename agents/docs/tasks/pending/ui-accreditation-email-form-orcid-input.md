# The email accreditation form has an ORCID input the backend discards

**Owner:** ui
**Created:** 2026-10-05
**Priority:** low

Filed from the accreditation and Web of Trust audit (finding 7).

## Why

The email accreditation form in `frontend/src/pages/accreditation.js` has an optional ORCID input
(`id="orcid-input"`) and sends its value as `orcid` in the `POST /api/accreditation/request`
body. The backend stores that value on the pending record and never reads it: the accredit op it
broadcasts carries no ORCID. A user who types one sees nothing happen with it.

A self-typed ORCID is unverified, so it will not be attested. The "verify with ORCID" button
beside the form is the verified path. `backend-accreditation-request-stores-unread-fields` removes
the field on the backend; the two tasks can land in either order.

## Scope

1. Remove the ORCID input from the email form, and the `orcid` key from the request payload the
   form builds.
2. Remove the component state that only fed that input. Keep everything the ORCID button's flow
   uses.
3. Remove an i18n key only if nothing else reads it. `publish.js` and `edit.js` also have ORCID
   field labels.

## Acceptance criteria

1. The email form renders no ORCID input, and the request body has no `orcid` key.
2. The ORCID button's flow is unchanged.

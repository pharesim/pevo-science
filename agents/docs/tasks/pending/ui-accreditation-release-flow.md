# Release own accreditation from the account, and the admin release and bindings view

**Owner:** ui
**Created:** 2026-10-06
**Priority:** normal

Filed from `architect-accreditation-mailbox-binding-design` (decisions with the user, 2026-10-06).
Design: `ARCHITECTURE.md` § 2 "Credential Bindings", § 6.4 row "Release own accreditation".
Backend counterpart: `backend-accreditation-release-op`,
`backend-mailbox-binding-history-and-admin-view`.

## Why

A researcher who wants their mailbox on another account needs a way to give up the old account's
accreditation. An admin needs the same action for a holder who lost their keys, and a view of
which accounts a mailbox backed, to follow a release to its successor.

## Scope

1. **Holder:** on the accreditation page (`frontend/src/pages/accreditation.js`), a "Release
   accreditation" action shown to accredited, non-sanctioned accounts. It explains the effect before
   confirming: the account stops being accredited (no publishing, reviewing, commenting or voting;
   its vouches stop counting), its mailboxes are freed for another account, and any accreditation
   path can re-admit it later. Re-auth per § 6.4: password or ORCID fresh-auth proof bound to
   action `release_accreditation` on the JWT path (through the shared `resolvePasswordFactor`
   resolver), the Keychain signature on the Keychain path. On success the auth store refreshes and
   the page shows the released state with the request form available again.
2. **Admin:** in the admin console, next to the grant action: a release action (`POST
   /api/admin/accreditation/release`, body `{ account, reason }`) with a confirmation, and a
   bindings view for an account (`GET /api/admin/accreditation/bindings/:username`) listing its
   mailbox rows by state and date and the other accounts that held the same mailbox. The sanction
   block is a disabled placeholder today; this task does not implement sanctioning.
3. New strings in `en.json`, stubbed in the 15 other locales and recorded in `STUBS.md`; no emdash.

## Out of scope

- Sanction UI (the placeholder stays unless a separate task is filed).
- The verify and signup refusal states (`ui-accreditation-binding-refusal-states`).

## Acceptance criteria

1. An accredited light account releases through the password modal; a passwordless ORCID account
   through the ORCID round-trip; a Keychain account through the signature path; a sanctioned
   account sees no release action.
2. After release the page shows the released state and the request form.
3. The admin console release and bindings view call the two endpoints and render their refusals
   (403 below tier, 422 not accredited) with specific copy.
4. Unit tests for the new branches; E2E against the real backend once the backend tasks are in.

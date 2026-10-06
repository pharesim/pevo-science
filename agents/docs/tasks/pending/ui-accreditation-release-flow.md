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
4. **Refusal states** (added by the architect, 2026-10-06, from the review of
   `ui-accreditation-binding-refusal-states`, which deferred the release link to this task): link
   the holder release action from the verify page's `mailbox_bound` state
   (`frontend/src/pages/accreditation-verify.js`) and from the signup-verify `unaccredited` mailbox
   copy (`frontend/src/pages/signup-verify.js`). Each bound-credential refusal names both exits:
   release the holding account if it is yours; otherwise request accreditation for this account
   with another credential (another institutional address, or the ORCID iD where the mailbox is
   the bound one). Today `verify.mailboxBoundMessage` and `verify.mailboxBoundMessageUnnamed` name
   only release and contact, and `seedPhrase.unaccreditedOrcidLinked` names no exit of its own (the
   sign-in line under it is shared by every reason). Changed English on existing keys follows the
   `STUBS.md` convention.

## Out of scope

- Sanction UI (the placeholder stays unless a separate task is filed).
- The verify and signup refusal states beyond scope item 4.

## Acceptance criteria

1. An accredited light account releases through the password modal; a passwordless ORCID account
   through the ORCID round-trip; a Keychain account through the signature path; a sanctioned
   account sees no release action.
2. After release the page shows the released state and the request form.
3. The admin console release and bindings view call the two endpoints and render their refusals
   (403 below tier, 422 not accredited) with specific copy.
4. Unit tests for the new branches; E2E against the real backend once the backend tasks are in.
5. The verify `mailbox_bound` state and the finalize mailbox copy link the release action, and each
   bound-credential refusal names both exits.

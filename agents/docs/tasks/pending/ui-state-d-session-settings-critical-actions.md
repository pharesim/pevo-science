# Check that a `'self'`-claim session can complete settings critical actions

**Owner:** ui
**Created:** 2026-10-05
**Priority:** high

Raised by the backend in the custody-column alignment (since archived) and
approved for filing at that task's archive. Reproduce first. This may turn out
to be a non-issue, and the task is done once that is shown.

## Why

A state-D account (ARCHITECTURE.md § 6.1: a light account upgraded through
`POST /api/custody/upgrade`, password and ORCID preserved) can still log in by
password or by ORCID. Both logins now mint the same derived claim,
`custody: 'self'`, for that account. ORCID login used to mint a stale
`'light'`, which the custody-column alignment fixed.

On the client, `frontend/src/lib/settings-fresh-auth.js` treats any
`custody !== 'light'` session as a Keychain session whose per-request
signature is itself the fresh proof, and sends no body proof. On the server,
§ 6.4 requires a body proof on the JWT path for change-email and
delete-account. `POST /api/custody/fresh-auth` refuses any session whose
claim is not `'light'` with 403, so a state-D JWT session cannot mint a
password proof there.

Whether this is a real gap depends on how a state-D session's settings
requests actually go out. If the SPA signs them with Keychain, the backend
takes the signature path, where the middleware signature is the fresh proof,
and nothing is wrong. If they go out with the JWT bearer and no body proof,
the backend refuses them, and the user cannot complete the action from that
session. Password-login state-D sessions were already in this position before
the custody-column change; ORCID-login ones joined them.

## Scope

1. Reproduce with a state-D account logged in by password, and again by
   ORCID. Attempt change-email and delete-account from settings, plus
   set-password if the account has an ORCID and no password. Record for each
   action which auth path the request took (signature or bearer), whether a
   body proof was sent, and the response.
2. If every action completes, record the evidence in this file, move it to
   `review/`, and stop. No code change.
3. If any action cannot complete, do not pick a fix on your own. The choices
   cross the client/server boundary: sign these requests with Keychain for a
   `'self'` session, route state D to the ORCID fresh-auth factor, or change
   the backend's proof rule for D. Move this file to `blocked/` with a
   `[BLOCKED by Architect]` note giving the reproduction and the options you
   see.

## Acceptance criteria

1. Every action above has a recorded reproduction for both login factors.
2. No code change lands without an architect decision, unless step 2 applies.

## Architect note (2026-10-07): widened to every `'self'` session, priority raised to high

Folded in at the archive of the state G unverified-row lifecycle task (its `[TODO UI]` item 3).
User triage: "as recommended". The priority is high because part of this is a broken flow
already shown by reading the code, not only a suspected one.

`submitEmail`, `deleteEmail` and `setPassword` in `frontend/src/api.js` all go through
`authenticatedRequest`, which sends the session JWT as a Bearer token; none of them signs with
Keychain. A Keychain user's session carries the `'self'` claim (`POST /api/auth/session`), so
these calls take the backend's JWT path:

1. **No row (pure Keychain user adding an email).** `POST /api/settings/email` answers 401
   `UNAUTHORIZED` to the add flow on the JWT path and writes no row (ARCHITECTURE.md § 6.4
   "Change email"; `api-contracts/settings.md`). A Keychain user therefore cannot register an
   email from settings.
2. **State G row whose email is unverified.** Re-issuing the link (`POST /api/settings/email`)
   and deleting the row (`DELETE /api/settings/email`) need a fresh-auth proof on the JWT path.
   The password issuer refuses the row's claim, and the row cannot acquire an ORCID while the
   email is unverified, so unless it already holds one it has no proof it can mint.
3. **State D**, as above.

Scope addition: reproduce 1 and 2 as well. Items 1 and 2 need no architect decision: § 6.4
admits those rows only on the Keychain (Hive-signature) path, so the fix is to sign these
settings requests with Keychain for a `'self'` session, as the SPA already does for
`POST /api/auth/link`. Step 3 of the Scope still applies to state D, which has factors a JWT-path
proof could use.

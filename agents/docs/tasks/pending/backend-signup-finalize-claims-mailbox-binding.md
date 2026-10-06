# Light-account signup claims the mailbox binding before it accredits

**Owner:** backend
**Created:** 2026-10-06
**Priority:** high

Filed from `architect-accreditation-mailbox-binding-design` (decisions with the user, 2026-10-06).
Design: `ARCHITECTURE.md` § 2 "Credential Bindings", enforcement point "Light-account signup".

## Why

`POST /api/auth/confirm` and `POST /api/auth/link` broadcast a `method: "email"` accredit op for the
new account with no check beyond the `accounts.email` duplicate refusal at `/signup`, and that
refusal is not durable: account deletion, a settings e-mail change or a recovery frees the address,
and a fresh signup with it yields a second accredited account. Keychain accounts accredited through
the accreditation page have no row at all, so their mailbox is invisible to `/signup`.

## Scope

1. **`POST /api/auth/signup`** (email path, no ORCID token): the duplicate-email check runs first
   and is unchanged (409 `DUPLICATE` as today). For a signup it lets through, compute the key with
   the shared module from `backend-mailbox-binding-registry`; when the key is live-bound to
   another account, answer exactly as a successful signup does and send the notice mail (the
   account that holds the mailbox and the ways through, in the same words whether or not that
   account is sanctioned) instead of the verification link; create no row. The shared function
   also refuses what `accreditationRequestSchema`'s email rule refuses, so the signup body's
   missing format check is closed on this path (the separate defect task covers the schema).
2. **Finalize** (`broadcastAccreditationAndSeed` callers on `/confirm` and `/link`, email path):
   claim the binding for (key, username) after the finalize UPDATE and before the broadcast, under
   the registry's invariant (row `pending` before the op, `bound` on return, kept on ambiguous
   outcomes). A live row for another account at this point (bound between signup and finalize)
   answers as the finalize-time `ORCID_ALREADY_LINKED` refusal does today: 409
   `MAILBOX_ALREADY_BOUND`, no session; the account stays finalized and unaccredited, and the
   holder signs in and verifies another mailbox or accredits with an ORCID.
3. **ORCID-path signups** (row carries an ORCID and the address was never mail-proven) create no
   mailbox binding. While here: their accredit op must not claim `method: "email"`; broadcast
   `method: "orcid"` with the ORCID `evidence_hash` formula (`sha256('orcid:' + id + ':' +
   username)`) for a row whose e-mail was not verified by the signup link. A combined signup whose
   e-mail WAS verified by the link keeps `method: "email"` with the `orcid` field.
4. **`/link`** checks the existing Hive account's current accreditation before broadcasting (as
   `/verify` does) and does not re-pin a WoT-accredited account by accident.
5. Comments follow root `CLAUDE.md` "Comment anchors".

## Out of scope

- The registry, canonical form and `/request`, `/verify` (`backend-mailbox-binding-registry`).
- The settings e-mail flows: they never bind or free a mailbox.

## Sequencing

After `backend-mailbox-binding-registry` (shared module and table) and
`backend-signup-verify-requires-the-signup-password` (same handlers).

## Acceptance criteria

1. A mailbox bound to Keychain account A: `/signup` with it answers like a normal signup, sends the
   notice mail, creates no row, and no account is accredited.
2. An email-path signup for an unbound mailbox ends `bound` to the new account; a second signup
   with a case or `+tag` variant hits criterion 1.
3. Delete the light account's row; sign up again with the same mailbox: criterion 1 applies (the
   binding survives the deletion).
4. An ORCID-direct signup yields an accredit op with `method: "orcid"` and no `mailbox_bindings`
   row; a link-verified combined signup yields `method: "email"` with `orcid` set and a row.
5. Tests on the real app database and real HAF; no emdash in response or mail text.

## [TODO Architect] at archive

- `api-contracts/auth.md`: the uniform `/signup` answer for a bound mailbox (after the
  `DUPLICATE` check), the finalize 409 `MAILBOX_ALREADY_BOUND`, and the `method` rule for
  ORCID-path signups; `hive-schemas.md` § 2.1 field note on `method` for signup finalize.

# An admin sees which accounts a mailbox backed; released rows expire after a year

**Owner:** backend
**Created:** 2026-10-06
**Priority:** normal

Filed from `architect-accreditation-mailbox-binding-design` (decision with the user, 2026-10-06:
keep the history for admins, no waiting period). Design: `ARCHITECTURE.md` § 2 "Credential
Bindings", "History and retention".

## Why

A holder who expects a sanction can release first and accredit a fresh account before an admin
acts. The released row is the link an admin follows to the successor account. Released rows are
personal data kept for abuse prevention, so they need a stated retention period and a sweep that
enforces it.

## Scope

1. `GET /api/admin/accreditation/bindings/:username` in `backend/src/routes/admin.ts` (roster tier
   `admin` or above, same auth as the grant route): for the named account, its `mailbox_bindings`
   rows (state, `bound_at`, `released_at`, `released_by`) and, per row, the other accounts that hold
   or held the same mailbox key with their states and dates. No hash values in the response; the
   key is opaque to the admin.
2. Retention sweep: a job in the existing hourly cadence deletes `released` rows whose
   `released_at` is older than one year. Live rows (`pending`, `bound`) are never swept by
   retention; `pending` reaping is the registry task's.
3. Log one summary line per sweep (count deleted); no addresses or hashes in logs.

## Out of scope

- A frontend for the view (`ui-accreditation-release-flow` covers the admin console wiring).
- Any automatic sanction of a successor account: an admin decides.

## Sequencing

After `backend-mailbox-binding-registry` and `backend-accreditation-release-op`.

## Acceptance criteria

1. Account A releases, account B binds the same mailbox: the view for A lists B as the current
   holder, the view for B lists A as a former holder with its `released_at`.
2. A `released` row dated 366 days ago is deleted by the sweep; one dated 364 days ago is not; live
   rows are untouched.
3. Below tier `admin`: 403. No emdash in response text.

## [TODO Architect] at archive

- Admin contract: `GET /api/admin/accreditation/bindings/:username`.

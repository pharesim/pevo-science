# GET /api/settings/email: report whether the row has an ORCID

**Owner:** backend
**Created:** 2026-10-08
**Priority:** normal

Filed at the architect review of `ui-state-d-session-settings-critical-actions`. User decision:
add the field (an API shape change the architect approves here).

## Why

The settings page offers set-password whenever the status reports `hasPassword: false`.
`POST /api/settings/set-password` accepts only a row with no password, a linked ORCID and a
verified email (`agents/docs/api-contracts/settings.md`). For a `'self'` session the SPA now runs
the ORCID fresh-auth round-trip before it sends set-password, so a caller with no row, or with a
row that holds no ORCID, is sent to orcid.org and comes back to a refusal from the callback. The
status has no ORCID field, so the SPA cannot hide the section for those callers.

## Scope

1. Add `hasOrcid` to `GET /api/settings/email`: `true` when the row's `orcid` is set, `false` when
   it is not, and `false` on the no-row branch.
2. Tests: one per branch (row with an ORCID, row without, no row).
3. No other field changes. The architect updates `api-contracts/settings.md` at review.

## [TODO UI] (routed by the architect at archive)

Hide the set-password section unless the status reports `hasOrcid: true`, in addition to the
verified-email gate `ui-pending-unverified-and-no-password-set-copy` adds.

## Acceptance criteria

1. `hasOrcid` is present on every branch of the response, each pinned by a test.
2. Backend suite green apart from the standing pre-existing failures.

## Architect note (2026-10-08)

`backend-email-change-hold-and-owner-notice` adds `pendingEmailChange` and changes
`pendingChange`'s predicate on the same response, and
`backend-password-proven-deletion-is-held-and-announced` adds `pendingDeletion`
(`api-contracts/settings.md`). Whichever lands second merges.

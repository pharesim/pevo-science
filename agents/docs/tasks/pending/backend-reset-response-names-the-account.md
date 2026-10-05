# The password reset response does not name the account it reset

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

## Why

`POST /api/auth/reset` revokes every session of the account (the UPDATE
stamps `sessions_invalidated_at`) and answers with only a message. A browser
that is signed in when its user completes a reset there keeps the revoked
token until its next bearer request. That request, possibly the notification
poll minutes later, then tears every tab down with the signed-out message and
opens the sign-in prompt, unprompted.

The SPA should end that session at the moment of the reset, but only when it
belongs to the account that was reset: a session for another account must
survive. The response does not say which account was reset, and the reset
link carries only the token, so the SPA cannot tell. The user chose this fix
over a client-side probe on 2026-10-05. The UI task
`ui-recover-and-reset-leave-a-revoked-session-signed-in` waits on it in
`blocked/` for its reset half.

## Scope

1. Add `username` to the success `data` of `POST /api/auth/reset`: the reset
   row's `username`, which the handler already selects. The row type declares
   it nullable; check against `ARCHITECTURE.md` § 6.1 and § 6.3 (the reset
   transitions name states A and B only) whether a row without a username can
   reach a successful reset, and document the field as always present or as
   nullable to match.
2. Record the field in the `POST /api/auth/reset` section of
   `agents/docs/api-contracts/auth.md` (architect zone; the commit that edits
   it needs `[skip-zone-audit]`, or hand the line to the architect).
3. Move `agents/docs/tasks/blocked/ui-recover-and-reset-leave-a-revoked-session-signed-in.md`
   back to `pending/` once the field lands (root `CLAUDE.md` rule 6; a ui-slug
   move needs `[skip-zone-audit]`).

## Acceptance criteria

1. A successful reset answers `data.username` with the account's username.
2. The error paths are unchanged.
3. A test pins the field on the success response.

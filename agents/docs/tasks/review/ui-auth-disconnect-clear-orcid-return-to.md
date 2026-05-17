# UI-AUTH-DISCONNECT-CLEAR-ORCID-RETURN-TO — `auth.js::disconnect()` should also scrub `pevo_orcid_return_to`

**Owner:** UI
**Created:** 2026-05-17 (architect, surfaced by `/ce-code-review` on `ui-orcid-callback-destroy-clear-return-to` — julik-frontend-races RR-1)
**Priority:** P3

## Problem

`frontend/src/auth.js::disconnect()` (lines 154-158 area) currently scrubs `pevo_orcid_mode` on logout to defend against a stale ORCID-flow-mode pointer leaking into the next session. The sister key `pevo_orcid_return_to` (which marks "user came from /recover so route them back to /recover after a successful link") is NOT scrubbed in the same handler.

The recent commit `2cb0051` (task `ui-orcid-callback-destroy-clear-return-to`, archived 2026-05-17) adds destroy-time scrubbing of `pevo_orcid_return_to` in the orcid-callback page itself — that closes the per-tab mid-callback teardown leak. The remaining hole is the disconnect path: a user starts a `/recover` ORCID flow (which writes `pevo_orcid_return_to='recover'`), gets disconnected mid-flow via a concurrent-tab logout StorageEvent before the browser actually navigates to orcid.org, then later arrives at `/orcid/callback` in that same tab. `_handleSignup` would read the stale `'recover'` and route the user to `/recover` instead of `/signup` after a successful link.

The 2cb0051 commit's comment cites parity with `pevo_orcid_mode`'s scrub-on-logout — but the parity is one-sided today.

## Goal

Add `sessionStorage.removeItem('pevo_orcid_return_to')` (with the same try/catch wrapper used for `pevo_orcid_mode` if any) inside `frontend/src/auth.js::disconnect()` so disconnect scrubs both ORCID-flow-scoped sessionStorage keys symmetrically.

## Acceptance

1. `frontend/src/auth.js::disconnect()` — add the `sessionStorage.removeItem('pevo_orcid_return_to')` call alongside the existing `pevo_orcid_mode` removal. Use the same try/catch style as the existing call if one exists.
2. Unit test in `frontend/tests/unit/auth.test.js` (or wherever disconnect() is currently tested): seed sessionStorage with `pevo_orcid_return_to = 'recover'`, call `disconnect()`, assert the key is removed. Add a matching positive case for `pevo_orcid_mode` if no equivalent assertion exists today (don't regress that coverage).
3. No production behavior change on the happy path (the orcid-callback page's `destroy()` and `_handleSignup` already clear the key on successful completion).

## Out of scope

- The same parity check for fresh-auth proof keys (`pevo_fresh_auth_proof`, `pevo_consent_op_proof`) — these are scrubbed via `clearReturnPath()` indirectly today; no leak surface known.
- Centralizing ORCID sessionStorage keys into a constants module — separate maintainability concern flagged during the same review, default-dismissed per `feedback_dismiss_preemptive_test_hardening`.

## Source

- `/ce-code-review` on `ui-orcid-callback-destroy-clear-return-to` task at commit 2cb0051, julik-frontend-races persona finding RR-1 (confidence 35, low — narrow race window but a citeable one-sided-parity gap).

## Cross-references

- `agents/docs/tasks-archive.md` — `UI-ORCID-CALLBACK-DESTROY-CLEAR-RETURN-TO (archived 2026-05-17)` for the sister fix.
- `frontend/src/auth.js:154-158` — existing `pevo_orcid_mode` scrub-on-logout that the new line will join.
- `frontend/src/pages/orcid-callback.js` — destroy() now scrubs `pevo_orcid_return_to` (per 2cb0051).
- `frontend/src/pages/recover.js:244` — write site for `pevo_orcid_return_to`.

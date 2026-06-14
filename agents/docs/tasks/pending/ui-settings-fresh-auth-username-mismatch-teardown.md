# UI-SETTINGS-FRESH-AUTH-USERNAME-MISMATCH-TEARDOWN — tear down the session on username_mismatch in the settings orchestrator

**Owner:** ui
**Created:** 2026-06-14 (architect, from the `/ce-code-review` re-review of the consent-affordances + credit-op-cache delivery; maintainability + reliability, P2)
**Priority:** P2 (consistency / corrupted-session recovery on the settings critical-action surface)

## Problem

The consent-affordances work added `username_mismatch` handling to the
authorship fresh-auth orchestrator: when the backend returns
`FRESH_AUTH_REQUIRED` with `details.reason === 'username_mismatch'` (the JWT
subject and the proof subject diverge — a corrupted session, not a retryable
re-auth failure), `withAuthorshipFreshAuth` (`frontend/src/lib/authorship-consent.js`)
now tears the session down (`Alpine.store('auth').disconnect()` + re-login toast)
and returns `{ sessionInconsistent: true }`. The session-kind path
`broadcastWithFreshAuth` (`frontend/src/lib/fresh-auth.js`) already does the same.

`withSettingsFreshAuth` (`frontend/src/lib/settings-fresh-auth.js`) does NOT.
On `username_mismatch` it falls through to the generic
`return { freshAuthFailed: true }`, so a settings critical action
(`change_email` / `set_password` / `delete_account`) on a corrupted session
shows a generic "try again" toast and the user retries the broken session
indefinitely. This is the exact failure the authorship teardown was added to
prevent — `withSettingsFreshAuth` is now the only one of the three fresh-auth
flows that lacks it.

Not a regression (the settings orchestrator's behavior is unchanged), but a real
consistency gap surfaced by the review. Filed as a follow-up rather than folded
into the consent tasks because it lives on a different surface (settings).

## Goal

Make `withSettingsFreshAuth` handle `username_mismatch` the same way the
authorship and session-kind flows do: tear the session down and force re-login
instead of returning a generic re-auth failure.

## Acceptance

- In `withSettingsFreshAuth`'s `FRESH_AUTH_REQUIRED` catch, before the terminal
  `return { freshAuthFailed: true }`, special-case `details.reason ===
  'username_mismatch'`: call `Alpine.store('auth')?.disconnect()`, show the
  `auth.sessionInconsistency` toast (English fallback as in the sibling), and
  return `{ sessionInconsistent: true }`.
- The settings callers route `{ sessionInconsistent: true }` to a clean abort
  (no second toast), matching how the authorship caller treats it.
- The gate matches the sibling's semantics. Note the documented divergence in
  the authorship sibling's comment (it gates on `reason` alone and claims the
  error carries no `status`); verify the actual error shape on the settings path
  before copying that rationale verbatim — the error reaching the catch on the
  settings action call may differ from the broadcast path. Anchor the gate on
  the behavior, whichever shape applies.
- A unit test in `lib-settings-fresh-auth.test.js` asserts a `username_mismatch`
  on a settings action tears the session down and returns `sessionInconsistent`,
  parallel to the authorship sibling's test.

## Consolidation note (optional)

If the three flows' `username_mismatch` teardown blocks are near-identical,
consider extracting a shared `handleSessionInconsistency()` into
`lib/fresh-auth.js` (which already imports Alpine) and calling it from all three.
That would also let `authorship-consent.js` drop its now-teardown-only `Alpine`
import (the settings module already has no direct Alpine import). Optional — the
minimal fix is the per-action block above.

## Cross-references

- `frontend/src/lib/authorship-consent.js` — the reference implementation of the teardown block.
- `frontend/src/lib/fresh-auth.js` `broadcastWithFreshAuth` — the session-kind sibling.
- `agents/docs/ARCHITECTURE.md` § 6.4 / § 6.5 — fresh-auth proof contract and the session-state invariants.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

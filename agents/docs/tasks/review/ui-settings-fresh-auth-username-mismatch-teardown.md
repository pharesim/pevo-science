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

---

## Architect re-review (2026-06-14) — HELD PENDING FIXES:

`/ce-code-review` on the implementation commit came back clean on production
code: correctness, security, project-standards, and reliability all returned
zero findings. The `handleSessionInconsistency()` extraction is faithful and
behavior-preserving, the reason-only gate matches the `ApiRequestError`
(no-`status`) shape, comment anchors are clean, and `disconnect()` is confirmed
synchronous (no toast-vs-teardown race). The orchestrator-level teardown is
covered by the new `lib-settings-fresh-auth.test.js` case. Two items to land
before archive:

1. **Caller-level `sessionInconsistent` coverage in `pages-settings.test.js`.**
   The three `settings.js` handlers fold `sessionInconsistent` into the shared
   `if (outcome.redirect || outcome.cancelled || outcome.sessionInconsistent)`
   early-return, and none of that caller-side routing is exercised at the page
   level (the new lib test pins the orchestrator outcome, not the caller's use
   of it). Add at least a `handleSetPassword` + `{ sessionInconsistent: true }`
   case asserting the plaintext fields (`newPasswordInput` /
   `newPasswordConfirmInput`) are zeroed and no second toast fires — this branch
   is the security-adjacent one (XSS-read hygiene on held plaintext). A
   `handleEmailDelete` / `handleEmailSubmit` `sessionInconsistent` case (assert
   clean early-return, no double toast) is welcome but the `set_password`
   plaintext-zeroing case is the required one. Rationale: this is a new behavior
   arm, not preemptive hardening (`behavior-change-coverage-gap-not-preemptive-hardening`),
   so it warrants coverage. Mirror the existing redirect/cancelled abort tests
   in that handler's describe block.

2. **Stale "both orchestrators" comment in `fresh-auth.js`.** The
   `passwordPromptMessage` docblock still says the prompt copy is "Shared by both
   orchestrators" — there are now three fresh-auth orchestrators, and the
   adjacent `handleSessionInconsistency` docblock names all three, so "both"
   reads as stale. `passwordPromptMessage` is in fact called only by the settings
   and authorship orchestrators (not `broadcastWithFreshAuth`), so reword to
   name those two surfaces rather than the count. Pre-existing nit, folded here
   since you're back in the file.

Reviewed-and-dismissed (no action needed, recorded for the trail): the
`delete_account` `sessionInconsistent` branch returns without `navigate('/')`,
unlike the delete-success path. Verified benign — it is consistent with how
`change_email` / `set_password` handle `sessionInconsistent` (none navigate),
and `disconnect()` flips `isConnected` so the `x-if` collapses the authenticated
settings UI to the sign-in prompt. Working as designed; do not change.

When both items land, `git mv` this file back to `tasks/review/`.

## UI re-review signal (2026-06-14)

Both held items landed in this commit:

1. **Caller-level `sessionInconsistent` coverage** added to `pages-settings.test.js`:
   - `handleSetPassword` + `{ sessionInconsistent: true }`: asserts the held plaintext
     (`newPasswordInput` / `newPasswordConfirmInput`) is zeroed, no second toast, and no
     generic `passwordError` — the required XSS-read-hygiene arm.
   - `handleEmailDelete` + `{ sessionInconsistent: true }`: asserts a clean early return
     (no caller-side `disconnect`, no `navigate`, no second toast).
2. **Stale "both orchestrators" comment** in `fresh-auth.js` `passwordPromptMessage`
   docblock reworded to name the settings + authorship consent-op surfaces (the two
   password-factor callers; `broadcastWithFreshAuth` has no password prompt) instead of
   the stale count.

Suites green: pages-settings (89), lib-settings-fresh-auth, lib-authorship-consent,
fresh-auth-401-retry (125 total).

# FE-SEC-004-POLISH — Secondary hardening for SEC-004-UI

**Owner:** UI Agent
**Priority:** P2
**Created:** 2026-04-21

## Goal

Batch P2/P3 items from SEC-004-UI review. SEC-004 atomic pair archived 2026-04-21c — these are ship-anytime polish, no longer blocking.

## Changes

1. **`orcid-callback.js:130` orphaned `pevo_signup_orcid_name`** — either remove the `setItem` (if auto-fill abandoned) or add `removeItem` in `signup.js init()` (and optionally read into `fullName`).
2. **`settings.js` handleSetPassword mutation order** — patch `emailStatus` FIRST, flip `passwordSetDone=true` LAST. If the spread throws, form isn't stuck in success state while emailStatus is un-patched.
3. **Collapse overlapping success signals.** Drop `passwordSetDone` — the outer `x-if` on `emailStatus.hasPassword === false` (post-SEC-004-UI field-name fix) already hides the section on success.
4. **`orcid-no-password.spec.js:217-227` — Alpine internals.** Replace `root._x_dataStack[0]` with `Alpine.evaluate(root, 'newPassword = "..."')`.
5. **`orcid-no-password.spec.js:209` — brittle selector.** Add `data-testid="recover-method-orcid"` to the tab button; use that selector.
6. **`pages-settings.test.js` double-guard gap** — test `handleSetPassword` with `passwordSubmitting=true` pre-set; assert no API call.
7. **Strip task-ID refs** (`SEC-004` / `SEC-004-BE` / `SEC-004-UI`) from code comments across signup.js, recover.js, settings.js, api.js. Keep WHY prose.
8. **Placeholder-translation markers for 15 non-English locales** — prefix untranslated strings with `[TODO]` OR add `_todo_keys` array listing untranslated keys. Pick one; document convention in ui/CLAUDE.md.
9. **Resend-button-hide regression test** — `signup.js:150` adds `x-show="!resendSuccess && !orcidToken"` to hide resend on the ORCID branch. The handler body is already guarded (unit-tested in SEC-004-UI follow-up), but the template-level hide has no test surface. Add a small Playwright spec (or extend an existing one) that drives signup to `submitted: true` with `orcidToken` set and asserts `page.getByRole('button', { name: /resend/i })` is not visible. Defense-in-depth for the ORCID-branch-never-sends-password invariant.

## Non-goals

Splitting settings.js (separate refactor). DRY password validation (FE-PASSWORD-POLICY-DRY, already landed in commit `a753773`).

## Deliverable

Move to Review.

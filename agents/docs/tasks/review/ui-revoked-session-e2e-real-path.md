# Real-path e2e coverage for the revoked-session teardown

**Owner:** ui
**Created:** 2026-09-30
**Priority:** normal

## Why

`frontend/tests/unit/session-revoked.test.js` drives the real request path,
auth store and teardown, but stubs `fetch` to produce the
`401 SESSION_INVALIDATED` answer. Its header states that no real-path
companion exists for the risk class (a second device's session outliving a
credential rotation). This task is that companion, per clause (c) of the
mocking carve-out in the root `CLAUDE.md`.

## Scope

One Playwright spec, two contexts, no mocked responses for the code under test.

1. Seed a light account (`fixtures/light-account.js`) and give a second
   browser context a session for it.
2. Revoke from "the other device" with a real password reset through the API
   request fixture. The reset token is read from the test database, as
   `password-recovery.spec.js` does.
3. Trigger a bearer request in the second context without reloading, for
   example an in-app navigation to the settings page.
4. Assert the response carried `SESSION_INVALIDATED`, the stored session entry
   is gone, the signed-out message is shown, and the sign-in modal is open
   with the reason inside it.

## Notes

- `seedUnaccreditedSession` uses an init script that re-seeds the stored
  session on every load. Seed once after the first navigation instead, or the
  "entry is gone" assertion is defeated.
- Do not install `installAuthedBootMocks` in the victim context. Those
  boot-time requests are a natural trigger.
- The always-rendered re-auth modal form makes a bare
  `form button[type="submit"]` locator ambiguous. Drive the reset through the
  request fixture and scope any form locator to its own page form.
- Keep trace, video and screenshot off: the spec handles a live token and
  passwords.

## Acceptance criteria

1. The spec passes against the test-mode stack and fails with the teardown
   hook removed.
2. The unit test header's clause (c) sentence is updated to name the spec.

**Architect note (2026-10-05):** `frontend/tests/unit/session-expired.test.js`
names this spec as its clause (c) real-path companion too, since the expired
session ends through the same `_endSession` teardown and sign-in offer. When
the spec lands, update that header's clause (c) sentence to name it as well,
alongside the `session-revoked.test.js` header in AC 2.

UI implementation signal (2026-10-07, commits `11b17105`, `c6956907`, `75e82606`):

- `c6956907`: `frontend/tests/e2e/session-revoked.spec.js`. A `browser.newContext()`
  context signs in to a seeded light account through `/login`. The `request` fixture,
  as the other device, resets the password (reset token read from the test DB). The
  header user menu's Settings link then navigates in-app, and the settings mount's
  bearer requests carry the revoked token. The spec asserts that the first 401 carrying
  that token is `SESSION_INVALIDATED`, that the signed-out toast (the `auth.sessionRevoked`
  copy read from `en.json`) is visible, that `pevo_session` is gone, and that the
  sign-in modal is open with the same copy in its notice. Nothing is stubbed and no boot
  mocks are installed. Trace, video and screenshots are off, and the login form locators
  are scoped to `[x-data="loginPage"]`.
- AC1: passes against the test-mode stack from the repo checkout with the baked bundle.
  Mutation runs from vite-dev scratch copies, with an unmutated control passing:
  - Removing the api.js `handleRevokedSession` hook fails at the toast assertion.
  - Dropping the sign-in offer fails at the modal.
  - Offering sign-in without the reason fails at the notice text.
  - Removing the teardown toast fails at the toast.
  - Keeping the storage entry fails at the storage check.
  - Reverting the toast root fails at the toast.
  - Using the expired copy fails at the toast.
- AC2 and the architect note: the clause (c) sentences in both `session-revoked.test.js`
  and `session-expired.test.js` now name `tests/e2e/session-revoked.spec.js`, and the
  spec's docblock names both unit suites, so the citation is two-sided.
- `11b17105` (asked first; the user approved fixing it in this task): the spec found
  that no toast has ever rendered. Since the SPA migration, the toast container in
  `frontend/index.html` sat outside every `x-data` root, so Alpine never initialized
  its `x-for`. A bare `x-data` fixes it.
  - Full-suite A/B: vite-dev copies differing only in that attribute, with the test DB
    re-prepared before each arm. Both arms show the same 13 failures and nothing new.
    The revoked-session spec went from failing to passing, and one test flaky in the
    baseline arm passed in the fixed arm.
  - A static sweep of e2e text locators against toast copy found one collision now that
    toasts render: the `bridge-import-queue.spec.js` 202 test's
    `getByText('Queued for publishing')` matched both the banner and the success toast
    `bridge.js` raises with the same key. It is now scoped to `[x-data="bridgePage"]`.
    That test times out earlier, at the Register button, in both arms (a pre-existing
    failure), so no live run reaches the rescoped locator.
- Pre-signal check: a four-lens, read-only verification workflow with a refuter per
  finding. Two findings survived. One was the bridge locator, fixed in `11b17105`. The
  other was a false retry-collision reason in the spec's `RUN_SUFFIX` comment, deleted
  before `c6956907`.
- All three SHAs are verified on main (`git merge-base --is-ancestor`), and their file
  lists match.
- Learnings checkpoint (`75e82606`, `[skip-zone-audit]`):
  - `/ce-compound` wrote
    `conventions/markup-outside-an-alpine-root-is-inert-and-store-assertions-cannot-see-it.md`.
  - `/ce-compound-refresh`, scoped to
    `completion-note-coverage-claim-run-suite-at-intake-2026-05-26.md`, narrowed
    "the account-deleted toast shown" to "queued on the toast store".
  - No other entry was contradicted.
- For the reviewer: toasts now render app-wide for the first time, so every existing
  `Alpine.store('toast').show` call site is user-visible as of `11b17105`.
- Out of scope, for follow-up filing:
  1. `bridge.js` shows `bridge.queuedTitle` as both the inline banner and a success
     toast, and `my-imports.js` also toasts it. Now that toasts render, users see the
     duplicate (a UX call).
  2. The 13 pre-existing e2e failures are unchanged by this task. Several are the
     bare-submit-locator class that `ui-e2e-bare-submit-locators-clash-with-reauth-modal`
     covers.

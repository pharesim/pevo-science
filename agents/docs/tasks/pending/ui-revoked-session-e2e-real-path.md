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

# E2E specs fail at a bare submit locator that also matches the re-auth modal

**Owner:** ui
**Created:** 2026-10-06
**Priority:** normal

## Why

`frontend/index.html` renders the global re-auth modal as a `<form>` with its
own `<button type="submit">` under `x-show`, so the node is in the DOM on every
page even when the modal is closed. A spec that clicks
`page.locator('form button[type="submit"]')` on a page with its own form gets a
Playwright strict-mode violation ("resolved to 2 elements") and fails at that
click, before it reaches anything it was written to check. Those flows
therefore have no working real-path E2E coverage today.

The class has only been fixed piecemeal, inside tasks that hit it:
`edit-paper.spec.js` scopes its locators to
`[x-data="editPage"] form button[type="submit"]`, and `accreditation.spec.js`
to `[x-data="accreditationPage"]`. Nothing tracks the rest. Seen again on
2026-10-06 while working the seed-recovery pages task:
`password-recovery.spec.js` and `seed-phrase.spec.js` failed at their first
submit click on the test-mode stack.

## Scope

Scope every bare `form button[type="submit"]` locator to its own page form,
in the shape `edit-paper.spec.js` uses (or a role-and-name locator where the
button label is stable). Twelve sites in seven specs:

| Spec | Sites | Test |
|---|---|---|
| `password-recovery.spec.js` | 3 | user requests password reset, follows email token, and signs in with new password |
| `seed-phrase.spec.js` | 2 | signup-generated mnemonic re-derives to the same keys on /recover (signup form, then recover form) |
| `login-email.spec.js` | 2 | valid credentials redirect to /papers ...; wrong password shows inline error ... |
| `review-submit.spec.js` | 2 | review submission assembles a valid Hive comment broadcast with rating metadata |
| `coauthor-accredited-prefill.spec.js` | 1 | publish broadcast carries accredited co-author ORCID in json_metadata.authors[] |
| `email-signup.spec.js` | 1 | fresh visitor signs up and verifies email |
| `publish.spec.js` | 1 | publish flow assembles a valid Hive comment broadcast with IPFS CID |

Re-run `grep -n 'form button\[type="submit"\]' frontend/tests/e2e/*.spec.js`
at pickup: a sibling task may have scoped some sites or added new ones.

Do not change the modal: rendering it under `x-show` is intended.

## Acceptance criteria

1. No spec under `frontend/tests/e2e/` uses an unscoped
   `form button[type="submit"]` locator.
2. Each of the seven specs gets past its submit clicks on the test-mode stack
   (`./deploy.sh restart`, `test-db-up`, `test-up`). A spec that then fails
   for another reason is recorded in the signal block with that reason, not
   fixed here. The recorded unrelated failures include `email-signup` and a
   live-HAF dependency ("expected at least one accredited researcher in HAF").
3. The signal block lists each spec's result before and after.

---
title: "Playwright `toBeHidden()` on an Alpine `x-if` section soft-passes through the loading frame — gate on a positive post-loading surface reading the same reactive keys"
module: frontend/tests/e2e
date: 2026-06-10
problem_type: test_failure
category: test-failures
component: testing_framework
severity: medium
symptoms:
  - "Playwright absence assertion (`toBeHidden()`) on a section gated by `x-if=\"!loading && data && <property>\"` passed regardless of the property under test — the component boots `loading: true` / `data: null`, so the section is absent on every loading frame"
  - "`page.waitForResponse` for the backing GET, awaited before the assertion, did not de-vacuify it: the HTTP response resolves before Alpine flips the reactive state"
  - "assertion was non-discriminating through the entire fetch window, so the spec never exercised the property it claimed to pin"
root_cause: async_timing
resolution_type: test_fix
related_components:
  - frontend
  - development_workflow
tags:
  - playwright
  - alpine
  - e2e
  - x-if
  - absence-assertion
  - vacuous-assertion
  - async-timing
  - reactive-flush
---

# Playwright `toBeHidden()` on an Alpine `x-if` section soft-passes through the loading frame — gate on a positive post-loading surface reading the same reactive keys

## Problem

A Playwright E2E assertion in `settings-orcid-factor.spec.js` checked that the "Set a password" section is absent after `page.reload()` — but the section is rendered behind an Alpine `x-if` that is also false during the entire email-status loading window, so `toBeHidden()` passed on the loading frame regardless of whether the property under test (`hasPassword: true` persisted server-side and reflected in the UI) actually held. The assertion was vacuous: it could not fail even if the behavior it claimed to verify regressed.

## Symptoms

- The test is green, but mutation-checking the property kills nothing: if the backend regressed to reporting `hasPassword: false` after `set_password`, the assertion would still pass whenever it evaluated during the email fetch.
- The absence assertion is satisfied by the wrong conjunct of the render gate. The gate is `!emailLoading && emailStatus && emailStatus.hasPassword === false`; during loading, `emailLoading: true` / `emailStatus: null` make it false on their own, so `hasPassword` is never consulted.
- No flake, no error, nothing in CI output hints at the problem — the only signals are reasoning about the component's boot state, or noticing that the invariant is really carried by other assertions (here: the DB `password_hash` query and the password-login 200 check).

## What Didn't Work

**Attempt 1: bare `toBeHidden()` after waiting for Alpine init.** The original shape waited only for the component to mount:

```js
await page.reload();
await page.waitForSelector('[x-data="settingsPage"]');
await expect(page.getByTestId('set-password-section')).toBeHidden();
```

`waitForSelector('[x-data="settingsPage"]')` resolves on Alpine init, long before `loadEmailStatus()` settles. Since `settingsPage` boots `emailLoading: true, emailStatus: null` (see the component's data block in `frontend/src/pages/settings.js`), the `x-if` template has not stamped the section into the DOM yet — `toBeHidden()` passes immediately, on the loading frame, proving nothing about `hasPassword`.

**Attempt 2: gating on the network response (`waitForResponse`).** A review round (landed in commit `9a1c95b6`) diagnosed this as a race — believing the section was *visible* pre-fetch and would hide once the response reported `hasPassword: true` — and prescribed arming `page.waitForResponse` before the reload:

```js
const emailAfterReload = page.waitForResponse(
  (resp) => resp.url().endsWith('/api/settings/email') && resp.request().method() === 'GET',
);
await page.reload();
await page.waitForSelector('[x-data="settingsPage"]');
await emailAfterReload;
await expect(page.getByTestId('set-password-section')).toBeHidden();
```

This fails twice over. First, the premise was inverted: the section is *hidden*, not visible, throughout the fetch window, so the imagined flaky false-failure never existed — the real defect was a deterministic false-pass. Second, even granting the premise, `waitForResponse` resolves when the HTTP response arrives at the network layer, at least a microtask before the `loadEmailStatus()` continuation mutates `this.emailStatus` / `this.emailLoading` and Alpine re-renders. A network event is not a render gate. The fix was implemented faithfully against the prescribed-but-inverted mechanism model and changed nothing about what the assertion verified — costing an extra review round (see the last Prevention bullet).

## Solution

Landed in commit `f921f9a8`: before asserting absence, assert *presence* of a control whose render gate reads the same reactive keys and is only satisfiable in the settled, post-loading state.

```js
await page.reload();
await page.waitForSelector('[x-data="settingsPage"]');
await expect(page.getByRole('button', { name: 'Change email' })).toBeVisible();
await expect(page.getByTestId('set-password-section')).toBeHidden();
```

The "Change email" button lives in `settings.js` under nested `x-if` gates that conjoin the settled state:

```html
<template x-if="!emailLoading && emailStatus">
  ...
  <!-- State 2: Has email, verified -->
  <template x-if="emailStatus.hasEmail && emailStatus.verified">
    ...
    <button x-show="!showChangeForm" ... x-text="$t('settings.emailChange')"></button>
```

while the section under test is gated on the same keys plus the discriminating property:

```html
<template x-if="!emailLoading && emailStatus && emailStatus.hasPassword === false">
  <div data-testid="set-password-section" ...>
```

Generalized recipe for asserting absence of a conditionally-rendered element: (1) find the render gate of the element and identify which conjunct you actually want to test (`hasPassword === false` here) versus which conjuncts encode "still loading"; (2) pick a positive surface — a control that renders only when the loading conjuncts are settled, reading the *same* reactive state; (3) `toBeVisible()` on that surface first, then assert the absence. The positive gate converts "absent because loading" into a loud timeout instead of a silent pass.

## Why This Works

`loadEmailStatus()` mutates both keys in one synchronous continuation:

```js
async loadEmailStatus() {
  this.emailLoading = true;
  try {
    const res = await fetchEmailStatus();
    this.emailStatus = res.data;
  } catch {
    this.emailStatus = { hasEmail: false, custody: 'self', hasPassword: false };
  } finally {
    this.emailLoading = false;
  }
},
```

`this.emailStatus = res.data` and `this.emailLoading = false` run back-to-back with no intervening await, so Alpine batches them into a single reactive flush — there is no DOM frame where `emailLoading` is false but `emailStatus` is stale. The "Change email" button becoming visible therefore proves the fetch settled and both gates have been re-evaluated against the final state. In that same flush, the only thing keeping `set-password-section` out of the DOM is `emailStatus.hasPassword === false` evaluating false, i.e. `hasPassword: true` — exactly the property the test claims. Both regression classes now fail loudly: a `hasPassword: false` regression stamps the section into the DOM in that flush and `toBeHidden()` fails; a failed fetch takes the `catch` fallback (`hasEmail: false`), the verified-email State-2 template never renders, and the `toBeVisible()` gate times out instead of letting the absence assertion soft-pass.

## Prevention

- When asserting absence of a conditionally-rendered element, first prove the discriminating state via a positive surface that shares the element's reactive keys. Absence-only assertions on `x-if`/`x-show` UIs are vacuous whenever any non-tested conjunct of the gate can also be false (loading, error, boot state).
- Network-event gates (`waitForResponse`, `waitForRequest`) are not render gates. The HTTP response resolves before the framework's state mutation and re-render; only a DOM-level positive assertion proves the flush happened.
- Mutation-check every assertion at review time: "if the property this assertion names regressed, would this test fail?" If the answer depends on timing or on which conjunct of a gate is false, the assertion is not discriminating.
- Review holds that prescribe a concrete fix shape must verify their mechanism claim against the component source first. Read the boot values of the gated keys (`emailLoading: true`, `emailStatus: null` here) before asserting what the pre-fetch frame looks like.

## Related Issues

- [assertion-vacuity-from-upstream-bail-in-mocked-tests-2026-05-17](assertion-vacuity-from-upstream-bail-in-mocked-tests-2026-05-17.md) — backend variant of the same class: assertions that pass because an upstream bail-out short-circuits before the property is ever exercised.
- [tests-must-fail-on-mutation-of-code-under-test-2026-04-22](../conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md) — the general rule this instantiates; the post-reload `toBeHidden()` survived mutation of `hasPassword` handling until the positive gate landed.
- [e2e-external-provider-stub-backend-only-real-fidelity-2026-06-09](../conventions/e2e-external-provider-stub-backend-only-real-fidelity-2026-06-09.md) — the orcid-stub topology this test's real OAuth round-trip runs on.
- [playwright-page-route-trigger-timing-2026-04-21](../conventions/playwright-page-route-trigger-timing-2026-04-21.md) — the other Playwright async-timing trap; its `waitForResponse` examples order network events, which remains valid — this doc adds the boundary that network ordering is not a render gate.

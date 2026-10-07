---
title: "Markup outside an Alpine x-data root is inert, and a store-level assertion cannot see that it never rendered"
date: 2026-10-07
category: conventions
module: frontend/index.html + frontend/tests
problem_type: convention
component: frontend_stimulus
severity: high
root_cause: incomplete_setup
resolution_type: code_fix
related_components:
  - testing_framework
applies_when:
  - "Adding or moving markup in frontend/index.html outside the page-mount region: header, modals, banners, the toast stack"
  - "A unit test asserts a user-visible message by reading an Alpine store (toast items, a modal's open flag) with the alpinejs module mocked"
  - "Writing the real-path companion for a flow whose outcome is a message on screen"
  - "Writing a Playwright text locator for copy that the same flow also raises as a toast"
symptoms:
  - "Alpine.store('toast').items holds the message while document.querySelectorAll('[role=\"alert\"]') returns nothing"
  - "Every toast-asserting unit suite is green while no toast has ever appeared in the running app"
  - "A Playwright toBeVisible on a toast's text fails with 'element(s) not found' although the flow's store-level unit test passes"
tags:
  - alpine
  - x-data
  - alpine-root
  - toast
  - global-chrome
  - index-html
  - store-mock
  - dom-assertion
  - real-path-companion
  - playwright-strict-mode
---

# Markup outside an Alpine x-data root is inert, and a store-level assertion cannot see that it never rendered

## Context

`frontend/index.html` is the SPA's persistent shell. `Alpine.start()` initializes only elements carrying `x-data` or `x-init` that sit under no other such element, together with the tree beneath each. A `<template x-for>`, `x-text` or `:class` with no root above it is never evaluated, and the browser leaves the `<template>` inert.

The toast stack, the body-level `<div aria-live="polite">` holding `<template x-for="item in $store.toast.items">`, had no `x-data` from the Alpine migration of 2026-03-31 until 2026-10-07. Its store-driven siblings in the shell, the broadcast-confirm dialog (`$store.broadcastConfirm`) and the re-auth modal (`$store.reauthModal`), each carry a bare `x-data`; the toast stack did not. The broadcast-confirm dialog had the same defect until 2026-04-14, when its fix added the `x-data` and left the toast stack as it was. For six months no toast rendered anywhere in the app. `Alpine.store('toast').show()` in `frontend/src/toast.js` pushed every message into the store's `items`, and the DOM stayed empty: error toasts, success toasts and the session teardown messages alike.

Nothing caught it, because every check that touched a toast stopped at the store. 67 files under `frontend/tests/unit/` mock the `alpinejs` module, and 25 of them assert directly on the toast store, its `show()` calls or its `items`, for example `expect(stores.toast.items.map((t) => t.message)).toEqual([REVOKED_COPY])` in `session-revoked.test.js`. None of the 25 reads `frontend/index.html`, so the container's missing root was invisible to all of them. No Playwright spec asserted a toast in the DOM.

It surfaced when `frontend/tests/e2e/session-revoked.spec.js`, the real-path companion to those unit suites, asserted the signed-out toast was visible. Everything else about the flow worked against the real backend: the 401 `SESSION_INVALIDATED` arrived, the stored session was gone, and the sign-in modal was open with the reason inside it. The served bundle was current and contained the teardown hook, so a stale image was ruled out first. A page-state dump taken after the 401 showed the toast store holding the message and zero `[role="alert"]` nodes. A probe on a plain page reproduced it outside any flow: `Alpine.store('toast').show('probe')` gave one store item and no DOM. Setting `x-data` on the container and calling `Alpine.initTree` on it made the probe toast render, which pinned the cause before any file changed.

## Guidance

**1. Every Alpine-bound element in the shell needs a root, an `x-data` on itself or an ancestor.** A container that only renders store state still needs a root, and a bare `x-data` is enough, as the shell's store-driven modals already show:

```html
<!-- inert: no root, Alpine.start() never visits the x-for -->
<div class="fixed bottom-4 right-4 z-50 ..." aria-live="polite">
  <template x-for="item in $store.toast.items" :key="item.id">

<!-- renders -->
<div x-data class="fixed bottom-4 right-4 z-50 ..." aria-live="polite">
  <template x-for="item in $store.toast.items" :key="item.id">
```

**2. Scan for it rather than eyeballing.** This check, run from the repo root, listed exactly the toast block on the pre-fix file and nothing after the fix:

```python
from html.parser import HTMLParser
VOID = {'area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr',
        'path','circle','line','rect','polyline','polygon'}
class P(HTMLParser):
    def __init__(s): super().__init__(); s.stack = []; s.hits = []
    def handle_starttag(s, tag, attrs):
        names = [a for a, _ in attrs]
        bound = [a for a in names if a.startswith(('x-', ':', '@')) and a != 'x-data']
        root = 'x-data' in names or 'x-init' in names
        if bound and not root and not any(r for _, r in s.stack):
            s.hits.append((s.getpos()[0], tag, bound[:3]))
        if tag not in VOID: s.stack.append((tag, root))
    def handle_endtag(s, tag):
        for i in range(len(s.stack) - 1, -1, -1):
            if s.stack[i][0] == tag: del s.stack[i:]; break
p = P(); p.feed(open('frontend/index.html').read()); print(p.hits or 'clean')
```

**3. A store-level assertion proves the message reached the store, not the screen.** A unit suite that mocks `alpinejs` and reads `Alpine.store('toast').items`, or a modal's `open` flag, shows the code path handed the message over. Where a flow's outcome is a message the user must see, its real-path companion asserts the DOM: `page.locator('[role="alert"]', { hasText })` for a toast, a dialog locator scoped to the modal's `x-data` root for a modal notice.

**4. Copy a flow shows both inline and as a toast needs a scoped locator.** With toasts rendering, a page-wide `getByText` on such copy matches two elements and fails Playwright's strict mode. `frontend/src/pages/bridge.js` raises `bridge.queuedTitle` as a success toast while its queued banner shows the same title, so `bridge-import-queue.spec.js` reads the title inside `[x-data="bridgePage"]`. The toast stack is a sibling of the page mount, so a locator scoped to the page root never matches it.

## Why This Matters

A silent piece of shell markup produces no console error and no failing test. Users saw failures with no explanation and successes with no confirmation, while the toast-asserting unit suites asserted a store that behaved correctly. A store-level suite cannot catch this class of bug, however thorough it is. Only a check that reads the DOM can.

## When to Apply

- Adding or moving any element under `frontend/index.html` that carries an `x-`, `:` or `@` attribute.
- Reviewing a test that claims a message "is shown" or "tells the user": check whether it reads the DOM or a store.
- Writing a Playwright locator for text that the same flow may also raise as a toast.

## Examples

Verification of the fix, as run:

- A full Playwright suite, run once without and once with `x-data` on the container from otherwise identical scratch copies, gave the same 13 pre-existing failures in both arms and no new one. The revoked-session spec moved from failing to passing.
- In a mutation run of `session-revoked.spec.js`, removing the `x-data` again failed the spec at its toast assertion.
- A static sweep of every e2e text locator against toast copy found one new collision, the `bridge-import-queue` queued title in item 4.

## Related

- [alpine-factory-exposure-vs-template-mutation-coverage-2026-04-28.md](alpine-factory-exposure-vs-template-mutation-coverage-2026-04-28.md): the same coverage gap one layer up. A unit spec asserts the data layer (a factory's shape there, the toast store here) and passes while the rendered DOM is empty.
- [alpine-review-scope-global-chrome-and-x-if-teardown-boundary-2026-09-08.md](alpine-review-scope-global-chrome-and-x-if-teardown-boundary-2026-09-08.md): the `frontend/index.html` shell model and `x-data` as the component lifecycle boundary.
- [positive-surface-gate-before-alpine-absence-assertion-2026-06-10.md](../test-failures/positive-surface-gate-before-alpine-absence-assertion-2026-06-10.md): a network event is not a render gate. Only a DOM-level assertion proves what rendered.
- [tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md](tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md): no toast-asserting unit suite reads the toast markup, so removing the container's root is a mutation none of them can kill.

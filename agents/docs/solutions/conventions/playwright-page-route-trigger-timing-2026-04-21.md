---
title: "Playwright `page.route()` stubs: pair with `waitForRequest` so the trigger can't outrace interception"
date: 2026-04-21
category: conventions
module: frontend/tests/e2e
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Writing a Playwright spec that stubs a backend request with `page.route()`"
  - "The request is triggered synchronously via `page.evaluate()`, a click that fires a `fetch`, or any path where the trigger runs in the same or next microtask as `route()` registration"
tags: [playwright, e2e, page-route, network-interception, async-timing, frontend]
---

# Playwright `page.route()` stubs: pair with `waitForRequest` so the trigger can't outrace interception

## Context

Registering a `page.route()` handler and then immediately triggering the request it's meant to intercept is a race. `page.route()` resolves when Playwright has registered the pattern, but the interception layer in the Chromium renderer activates on a later tick. If the trigger fires on the next microtask (which is what `await page.evaluate(() => someAlpineMethod())` does — `await fetch(...)` starts the moment the evaluate enters the page context), the POST can escape to the real backend before the stub is live. Under one network condition it passes; under another it times out or hits a real 400. Both symptoms showed up in the same E2E batch this session.

The two failing specs in the 2026-04-21 E2E suite batch:

- `login-keychain.spec.js` — `page.route('**/api/auth/session', …)` registered, then a UI action triggered `POST /api/auth/session`. The real backend returned 400 (the stub never fired). Root cause traced to the microtask gap.
- `seed-phrase.spec.js` — `page.route('**/api/auth/confirm', …)` registered, then `page.evaluate(() => Alpine.$data(el).submitCreateAccount())` fired `await fetch('/api/auth/confirm', …)` immediately. The `expect.poll(() => capturedConfirmBody).not.toBeNull()` timed out after 15s because the POST escaped interception.

Neither implementer caught it. Playwright's own docs don't warn loudly about it.

## Guidance

Whenever you register a `page.route()` stub and then trigger the stubbed request, wrap the trigger in `Promise.all([page.waitForRequest(matcher), trigger()])`. Both sides start concurrently, and `waitForRequest` guarantees the interception is active before it resolves.

```js
// ❌ Racy — trigger can outrun the interception layer
await page.route('**/api/auth/confirm', async (route) => {
  capturedConfirmBody = JSON.parse(route.request().postData() || '{}');
  await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
});
await page.evaluate(() => window.Alpine.$data(el).submitCreateAccount());
// ... now poll capturedConfirmBody and hope the POST was intercepted
await expect.poll(() => capturedConfirmBody).not.toBeNull();

// ✅ Safe — waitForRequest and trigger start concurrently
await page.route('**/api/auth/confirm', async (route) => {
  capturedConfirmBody = JSON.parse(route.request().postData() || '{}');
  await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
});
const [request] = await Promise.all([
  page.waitForRequest((r) => r.url().includes('/api/auth/confirm') && r.method() === 'POST'),
  page.evaluate(() => window.Alpine.$data(el).submitCreateAccount()),
]);
// request is guaranteed intercepted; capturedConfirmBody is guaranteed populated
```

Make the `waitForRequest` matcher specific enough that it pins the exact POST you expect. Matching just `/api/auth/confirm` in a flow that also calls `GET /api/auth/confirm/status` would resolve on the wrong request.

## Why This Matters

- **Deterministic tests.** Without `Promise.all`, the spec's pass/fail depends on renderer timing. It can be green on fast machines and flake on CI, or vice versa.
- **Real backend protection.** An un-intercepted POST in an E2E env either hits the dev/test backend for real (mutating state) or returns a confusing error that sends implementers down the wrong debugging path.
- **Debuggability.** When the stub IS the contract under test (capturing request bodies for payload assertion), a missed intercept silently falls through to `capturedBody = null` and the spec times out on its poll — that's 15+ wasted seconds per failure and no useful error message.

## When to Apply

- Any `page.route()` registration followed by a UI action in the same test function.
- Any Playwright spec using `page.evaluate()` to drive Alpine / React / Vue state methods that fire network calls.
- Any spec that uses `expect.poll(() => capturedSomething).not.toBeNull()` to wait for an intercept — that pattern is a tell that `Promise.all([waitForRequest, trigger])` is missing.
- Not needed when the trigger path includes a natural wait (e.g., clicking through multiple navigation steps, where an intermediate `waitForURL` guarantees the renderer has ticked).

## Examples

See existing PEvO specs for reference implementations of the correct pattern:

- `frontend/tests/e2e/email-signup.spec.js` — reads a reset token from the DB after the request, but uses explicit `page.waitForResponse` around the trigger.
- `frontend/tests/e2e/publish.spec.js` — captures a Keychain broadcast payload; the trigger is the UI click, but a `waitForResponse` on the preceding IPFS upload enforces ordering before the broadcast fires.

The two follow-up tasks created in `agents/docs/TASKS.md` — **E2E-AUTH-2-RETRY** and **E2E-CRYPTO-1-RETRY** — land this pattern in the failing specs.

## Related

- `agents/docs/tasks-archive.md` → E2E-SUITE-EXPANSION (2026-04-21) — the session that surfaced this.
- Architect review artifact: `.context/compound-engineering/ce-code-review/20260421-051152-d30ea63d/julik-frontend-races.json` (finding JFR-05 and residual risk RR-01 name the two specs and propose this fix).

/**
 * SEC-002-UI — ORCID `/api/orcid/callback` carries caller auth for link/accredit.
 *
 * SEC-002 ships atomically with SEC-002-BE (backend auth-gates the callback
 * for `link` and `accredit`). From the UI side the only thing to prove is
 * that `completeOrcid()` routes through `authenticatedRequest` for those
 * two modes, and through the unauthenticated `request()` for `signup` and
 * `login` (kiosk / shared-browser flows must keep working without a
 * session).
 *
 * We stub `/api/orcid/callback` at the network layer so the assertion is
 * deterministic regardless of the backend's own auth state: captured
 * request headers are the UI contract we want to lock in. Once SEC-002-BE
 * is deployed, the `test.fixme` at the bottom of this file can be
 * un-fixmed to assert the real-backend 403 on a cross-user mismatch.
 */

import { test, expect } from './fixtures/keychain.js';
import { seedUnaccreditedSession } from './fixtures/auth.js';

const STUB_CODE = 'stub-orcid-code-abc';
const STUB_STATE = 'stub-orcid-state-xyz';

async function captureCallbackRequest(page, { fulfillBody }) {
  const captured = { count: 0, authorization: undefined, body: null };
  await page.route('**/api/orcid/callback', async (route) => {
    const req = route.request();
    captured.count += 1;
    captured.authorization = req.headers().authorization;
    captured.body = JSON.parse(req.postData() ?? '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(fulfillBody),
    });
  });
  return captured;
}

test('link mode sends Authorization: Bearer on callback', async ({ page }) => {
  const { token } = await seedUnaccreditedSession(page);

  // The orcid-callback page reads `pevo_orcid_mode` from localStorage
  // (set before the ORCID redirect). Seed it so the page routes `link`.
  await page.addInitScript(() => {
    window.localStorage.setItem('pevo_orcid_mode', 'link');
  });

  const captured = await captureCallbackRequest(page, {
    fulfillBody: { status: 'ok', data: { mode: 'link' } },
  });

  const responsePromise = page.waitForResponse(
    (resp) =>
      resp.url().endsWith('/api/orcid/callback') &&
      resp.request().method() === 'POST',
  );

  await page.goto(`/orcid/callback?code=${STUB_CODE}&state=${STUB_STATE}`);
  const resp = await responsePromise;
  expect(resp.status()).toBe(200);

  expect(captured.count).toBe(1);
  expect(captured.authorization).toBe(`Bearer ${token}`);
  expect(captured.body).toEqual({ code: STUB_CODE, state: STUB_STATE });

  // On a successful link response the callback page navigates to /settings.
  // settings.js reads `pevo_orcid_link_complete` on init and deletes it, so
  // checking the URL transition is the observable signal.
  await page.waitForURL('**/settings');
});

test('signup mode omits Authorization header on callback', async ({ page }) => {
  // No session seeded — signup flow runs on a shared browser with no prior
  // login. completeOrcid('signup') must go through the unauthenticated
  // `request()` helper so this flow never throws UNAUTHORIZED locally.
  await page.addInitScript(() => {
    window.localStorage.setItem('pevo_orcid_mode', 'signup');
  });

  const captured = await captureCallbackRequest(page, {
    fulfillBody: {
      status: 'ok',
      data: { mode: 'signup', orcid_token: 'stub-token', orcid_id: '0000-0001-0000-0001' },
    },
  });

  const responsePromise = page.waitForResponse(
    (resp) =>
      resp.url().endsWith('/api/orcid/callback') &&
      resp.request().method() === 'POST',
  );

  await page.goto(`/orcid/callback?code=${STUB_CODE}&state=${STUB_STATE}`);
  const resp = await responsePromise;
  expect(resp.status()).toBe(200);

  expect(captured.count).toBe(1);
  expect(captured.authorization).toBeUndefined();
});

/**
 * Real-backend 403 assertion. Pending SEC-002-BE: today the callback
 * returns 200 for cross-user link attempts (the P0 hole we are closing).
 * Enable once backend lands.
 */
test.fixme(
  'link mode returns 403 when session username does not match the state initiator',
  async () => {
    // 1. Call `/api/orcid/start` with mode=link, authed as user A.
    // 2. Seed a session for user B.
    // 3. Navigate to /orcid/callback?code=...&state=<A's state>.
    // 4. Expect 403 FORBIDDEN from the real backend, no on-chain broadcast.
  },
);

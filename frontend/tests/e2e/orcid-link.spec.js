/**
 * ORCID `/api/orcid/callback` carries caller auth for link/accredit.
 *
 * The backend auth-gates the callback for `link` and `accredit`. From the UI
 * side the only thing to prove is that `completeOrcid()` routes through
 * `authenticatedRequest` for those two modes, and through the unauthenticated
 * `request()` for `signup` and `login` (kiosk / shared-browser flows must keep
 * working without a session).
 *
 * We stub `/api/orcid/callback` at the network layer so the assertion is
 * deterministic regardless of the backend's own auth state: captured
 * request headers are the UI contract we want to lock in. The real-backend 403
 * on a cross-user state mismatch is asserted by the live-backend test below.
 */

import { test, expect } from './fixtures/keychain.js';
import { seedUnaccreditedSession } from './fixtures/auth.js';

// This spec mints a live backend-valid bearer JWT via seedUnaccreditedSession.
// Disable trace/video/screenshot to keep that token out of trace.zip artifacts
// (the global default `trace: 'retain-on-failure'` would otherwise persist it).
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

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

  // The orcid-callback page reads `pevo_orcid_mode` from sessionStorage
  // (migrated from localStorage 2026-05-17 to avoid cross-tab interference).
  // Seed it so the page routes `link`.
  await page.addInitScript(() => {
    window.sessionStorage.setItem('pevo_orcid_mode', 'link');
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
    window.sessionStorage.setItem('pevo_orcid_mode', 'signup');
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
 * Real-backend 403 assertion. Exercises the auth gate against a
 * live backend: victim A calls `/api/orcid/start` to allocate state, then
 * attacker B posts to `/api/orcid/callback` with A's state and B's own
 * signed bearer. The backend must return 403 FORBIDDEN and never broadcast
 * on-chain. No page navigation here — we drive the API directly via two
 * isolated request contexts so the state-hijack check is not entangled with
 * any frontend behaviour. `code` is fake: the callback must reject before
 * reaching the ORCID token-exchange step.
 */
test('link mode returns 403 when session username does not match the state initiator', async ({ browser, request }) => {
  // Victim: any signup-eligible username that the backend accepts a bearer for.
  // seedUnaccreditedSession is used elsewhere to keep the fixture surface narrow;
  // we just need two DIFFERENT mints against the same SESSION_SECRET so the
  // bearer auths as distinct users.
  const victimContext = await browser.newContext();
  const attackerContext = await browser.newContext();
  try {
    const victimPage = await victimContext.newPage();
    const attackerPage = await attackerContext.newPage();

    // Mint two distinct sessions. The init scripts seed localStorage, but for
    // this API-only assertion we also grab the raw tokens so we can sign the
    // two requests directly.
    const victim = await seedUnaccreditedSession(victimPage, {
      username: `e2evictim${Date.now().toString(36)}`,
    });
    const attacker = await seedUnaccreditedSession(attackerPage, {
      username: `e2eattacker${Date.now().toString(36)}`,
    });
    expect(victim.username).not.toBe(attacker.username);

    // Victim calls /start (mode=link) to allocate state. Uses the victim page
    // context so the backend sees a real origin/cookies path; the bearer is
    // what actually authenticates.
    const startResp = await victimPage.request.post('/api/orcid/start', {
      headers: { Authorization: `Bearer ${victim.token}` },
      data: { mode: 'link' },
    });
    // `/start` on mode=link needs only a valid bearer: the handler runs no
    // accreditation check and reads no admin key, and pure state allocation
    // touches neither. The e2e compose override always configures the ORCID
    // client and the in-network OAuth stub, so a non-200 here is a real
    // failure to read (a start-limiter 429, a bearer the backend rejects, a
    // session-check outage) rather than a missing sidecar. Failing loudly
    // beats the skip this guard used to take, which reported every one of
    // those causes as an unconfigured environment and turned them green.
    expect(startResp.status(), await startResp.text()).toBe(200);
    const startBody = await startResp.json();
    const redirectUrl = startBody?.data?.redirect_url;
    expect(redirectUrl, 'redirect_url missing from /start response').toBeTruthy();
    const state = new URL(redirectUrl).searchParams.get('state');
    expect(state, 'state param missing from ORCID redirect URL').toBeTruthy();

    // Attacker calls /callback with the victim's state and the attacker's bearer.
    // Should be 403 FORBIDDEN — the auth gate runs before token exchange, so
    // the fake `code` never reaches ORCID.
    const callbackResp = await attackerPage.request.post('/api/orcid/callback', {
      headers: { Authorization: `Bearer ${attacker.token}` },
      data: { code: 'fake-not-reached', state },
    });
    expect(callbackResp.status()).toBe(403);
    const body = await callbackResp.json();
    expect(body?.error?.code).toBe('FORBIDDEN');
  } finally {
    await victimContext.close();
    await attackerContext.close();
  }
});

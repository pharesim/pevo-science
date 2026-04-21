/**
 * E2E-AUTH-2 — Keychain challenge login.
 *
 * Drives /login → Keychain path → sign-in modal and asserts the UI
 * exchanges a Keychain-signed challenge for a session JWT, then lands in
 * the authenticated state. Signing a challenge is not a chain write, so
 * this flow is E2E-appropriate.
 *
 * The stub in fixtures/keychain.js returns a `STUB_SIG_*` signature that
 * the backend's verifyHiveSignature middleware will reject (no real Hive
 * pubkey will ever verify it). The spec therefore intercepts POST
 * /api/auth/session with `page.route()` and responds with a JWT minted
 * via the same SESSION_SECRET the backend uses (see fixtures/auth.js).
 * That JWT is real: subsequent Bearer-authenticated API calls succeed
 * against the live backend, so the "UI lands authenticated" assertion is
 * genuine end-to-end (not just local state).
 *
 * What the spec exercises for real:
 *   - Login page → Keychain entry point routing
 *   - Sign-in modal chooser → Keychain mode
 *   - Frontend builds the request-bound signed message (see sign-request.js)
 *     and calls Keychain.requestSignBuffer (stubbed)
 *   - Frontend posts to /api/auth/session with the expected signature headers
 *     and JSON body
 *   - Frontend applies the session response to the auth store and persists
 *     it to localStorage via auth.connect()
 *   - A downstream authenticated request succeeds with the issued JWT
 *
 * Race-condition note (RR-01 / JFR-05): the Keychain flow fires the POST
 * through several microtask turns (stub sha256 → callback → signRequest →
 * fetch). The `page.route()` mock itself is armed up front and CDP
 * interception is permanent, so the gate below is not about the mock —
 * it's about the `waitForRequest` / `waitForResponse` listeners. Wrapping
 * the triggering click inside a Promise.all with both listeners guarantees
 * they are installed on the same turn as the click, so they do not miss
 * the event when the in-flight POST resolves faster than the test's next
 * microtask. Without the gate, Promise.all can resolve on a stale pair or
 * time out waiting for an event that already fired.
 */

import { test, expect } from './fixtures/keychain.js';
import { mintSessionJwt } from './fixtures/auth.js';

// This spec mints a live backend-valid bearer JWT via mintSessionJwt.
// Disable trace/video/screenshot to keep that token out of trace.zip artifacts
// (the global default `trace: 'retain-on-failure'` would otherwise persist it).
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const LOGIN_USERNAME = 'e2ekeychainuser';

test('login via Keychain challenge issues a session and lands authenticated', async ({ page, request }) => {
  // UI agent rule: no alert() in user-facing flows. Fail the test if the
  // login flow pops one; Playwright auto-dismisses dialogs silently without
  // this listener.
  page.on('dialog', (dialog) => {
    throw new Error(`Unexpected dialog: ${dialog.type()} "${dialog.message()}"`);
  });

  // Mint the session JWT up front so the /api/auth/session mock returns a
  // real, backend-valid token. Keychain custody in the frontend is 'self'.
  const { token, expiresAt } = mintSessionJwt(LOGIN_USERNAME, { custody: 'self' });

  // Register the session mock BEFORE any navigation. The `**/api/auth/session`
  // glob matches both absolute (http://localhost:3001/api/auth/session) and
  // relative-resolved URLs the frontend produces via `fetch('/api/auth/session')`.
  await page.route('**/api/auth/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        data: {
          token,
          expires_at: expiresAt,
          custody: 'self',
        },
      }),
    });
  });

  // Accreditation status poll fires immediately on connect. Stub it as
  // `is_accredited: true` so _startAccreditationPolling shuts down after the
  // first fetch — a false stub keeps the poll alive and steers the spec into
  // the pre-existing unhandled-rejection path in `_checkAccreditation`
  // (tracked as FE-AUTH-ACCRED-POLL-GUARD). The endpoint is public (no auth
  // header required), so swapping the value doesn't affect the Bearer-path
  // assertion below. `accreditation` is returned as a minimal stub; nothing
  // in the spec inspects its fields.
  await page.route(`**/api/accreditations/${LOGIN_USERNAME}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        data: {
          username: LOGIN_USERNAME,
          is_accredited: true,
          accreditation: {
            username: LOGIN_USERNAME,
            attested_at: '2025-01-01T00:00:00.000Z',
            attester: 'e2e',
          },
        },
      }),
    });
  });

  // ─── /login → Keychain entry point ───────────────────────────
  await page.goto('/login');
  await page.waitForSelector('[x-data="loginPage"]');

  // The login page exposes a "Connect with Keychain" link that routes to
  // home; the sign-in modal mounts globally and is opened from there.
  await page.getByRole('link', { name: 'Connect with Keychain' }).click();
  await expect(page).toHaveURL(/\/$|\/en\/?$/);

  // ─── Open sign-in modal → choose Keychain ────────────────────
  // Header renders two "Sign in" buttons (desktop + mobile). The mobile one
  // sits inside an `md:hidden` nav that's also gated on `mobileMenuOpen`
  // (false by default), so at the desktop viewport only one is actually
  // visible. :visible filters to the interactable target.
  await page.locator('header button:visible:has-text("Sign in")').first().click();
  await page.waitForSelector('[role="dialog"]');

  // Pick the Hive Keychain option. The button renders "Hive Keychain" as
  // its primary label via $t('signIn.browserExtensionOption'). Scoping to
  // the open dialog avoids collisions if any nav link happens to mention
  // Keychain outside the modal.
  await page
    .locator('[role="dialog"]')
    .getByRole('button', { name: /Hive Keychain/ })
    .click();

  // Wait for Keychain availability to resolve before driving the username
  // input — the username block is gated on $store.auth.isKeychainInstalled,
  // which waitForKeychain() flips to true after detecting window.hive_keychain.
  await page.waitForSelector('#keychain-username-input');

  // ─── Sign the challenge and submit ───────────────────────────
  // Race-gate (RR-01 / JFR-05): the `page.route('**/api/auth/session', ...)`
  // mock is armed at line 59 and CDP interception is permanent once installed
  // — it is not what the Promise.all below protects. What the gate actually
  // guarantees is that the `waitForRequest` and `waitForResponse` listeners
  // registered on the next two lines are live in the same microtask turn as
  // the triggering click. Without the gate, the frontend's
  // `await signRequest(...); await fetch('/api/auth/session')` chain can
  // resolve before Playwright has attached the per-request listeners, and the
  // Promise.all resolves with a stale request/response pair — or, in extreme
  // cases, times out waiting for an event that already fired.
  await page.locator('#keychain-username-input').fill(LOGIN_USERNAME);

  // Scope both predicates to `POST` so they don't match an OPTIONS preflight,
  // an unrelated GET, or any leaked request that happens to share the path.
  // `waitForRequest` was already correctly scoped; mirror it on `waitForResponse`
  // so the two listeners stay in lock-step (action #2).
  const sessionRequestPromise = page.waitForRequest(
    (req) => req.url().endsWith('/api/auth/session') && req.method() === 'POST',
  );
  const sessionResponsePromise = page.waitForResponse(
    (resp) => resp.url().endsWith('/api/auth/session') && resp.request().method() === 'POST',
  );

  const [sessionReq, sessionResp] = await Promise.all([
    sessionRequestPromise,
    sessionResponsePromise,
    // Exact match: the sign-in modal renders "Connect"; the login page link
    // reads "Connect with Keychain" and would otherwise also match.
    page.getByRole('button', { name: 'Connect', exact: true }).click(),
  ]);

  expect(sessionResp.status()).toBe(200);

  // ─── Assert what the frontend signed and sent ────────────────
  const reqHeaders = sessionReq.headers();
  expect(reqHeaders['x-hive-username']).toBe(LOGIN_USERNAME);
  expect(reqHeaders['x-hive-timestamp']).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  );
  // The Keychain stub prefixes every stubbed signature with STUB_SIG_.
  // Asserting the prefix proves the frontend routed through the
  // requestSignBuffer path (not some fallback) for the challenge.
  expect(reqHeaders['x-hive-signature']).toMatch(/^STUB_SIG_/);
  expect(reqHeaders['content-type']).toMatch(/application\/json/);

  // Body must be present and JSON-parseable — the signed message binds
  // sha256(body) into the signature, so an empty body still serializes as
  // `{}` per api-contracts/common.md. Parse rather than exact-string match:
  // Playwright returns `null` for zero-byte bodies and will silently fail
  // the `.toBe('{}')` variant without surfacing the real problem.
  expect(JSON.parse(sessionReq.postData() ?? 'null')).toEqual({});

  // ─── UI lands authenticated ──────────────────────────────────
  await expect
    .poll(() =>
      page.evaluate(() => window.Alpine?.store('auth')?.isConnected === true),
      { timeout: 5000 },
    )
    .toBe(true);

  const authState = await page.evaluate(() => {
    const a = window.Alpine.store('auth');
    return {
      username: a.username,
      isConnected: a.isConnected,
      custody: a.custody,
      token: a.token,
    };
  });
  expect(authState.username).toBe(LOGIN_USERNAME);
  expect(authState.isConnected).toBe(true);
  expect(authState.custody).toBe('self');
  expect(authState.token).toBe(token);

  // Session persisted to localStorage — the next load will auto-restore it.
  const persisted = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('pevo_session') ?? 'null'),
  );
  expect(persisted?.token).toBe(token);
  expect(persisted?.username).toBe(LOGIN_USERNAME);
  expect(persisted?.custody).toBe('self');

  // ─── The issued JWT authenticates a real API call ────────────
  // /api/notifications is Bearer-authenticated via verifyHiveSignature. If
  // the minted JWT is genuinely valid against the backend's SESSION_SECRET,
  // this returns 200. If the SESSION_SECRET drifted, it would return 401.
  // Use the Playwright request context so it skips page.route() handlers.
  // `since_block` is a required query parameter; the backend rejects with
  // 400 when it's missing, so the auth path wouldn't even be exercised.
  const notificationsResp = await request.get('/api/notifications?since_block=0&limit=1', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(notificationsResp.status()).toBe(200);
});

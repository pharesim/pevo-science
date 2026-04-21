/**
 * E2E-AUTH-1 — Email+password login golden path + wrong-password error.
 *
 * Seeds an active light-account row directly in `pevo_app_test` (argon2
 * reused from the backend's node_modules so the hash scheme matches), drives
 * the `/login` form, and confirms:
 *   1. POST /api/auth/login succeeds,
 *   2. the router lands the user on /en/papers,
 *   3. a follow-up authenticated call (GET /api/settings/email) succeeds
 *      with the JWT the login handler stashed in localStorage.
 *
 * Negative case: wrong password. Backend returns 401 UNAUTHORIZED. The login
 * page must render the error inside the inline red error banner and MUST NOT
 * call `window.alert()` — per the UI agent CLAUDE.md, no alert() ever.
 *
 * Global-setup truncates pevo_app_test before this spec runs, so the seeded
 * row starts fresh each time. No per-test cleanup needed.
 */

import argon2 from '../../../backend/node_modules/argon2/argon2.cjs';
import { test, expect } from './fixtures/keychain.js';
import { openAppPool } from './fixtures/db.js';

// This spec submits a plaintext password through the /login form and the login
// response body carries the minted session JWT. Disable trace/video/screenshot
// so neither the plaintext password nor the token is persisted in trace.zip
// artifacts (the global default `trace: 'retain-on-failure'` would otherwise
// capture both).
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

// Identity strings derived from RUN_SUFFIX are computed in beforeAll (rather
// than at module scope) so Playwright retries in the same worker — which
// re-run beforeAll but do NOT re-evaluate module scope — get a distinct
// suffix including `testInfo.retry`. Stable constants stay here.
const TEST_PASSWORD = 'E2eLoginPass1';
const WRONG_PASSWORD = 'NotMyPassword9';

// Populated in beforeAll from (Date.now, testInfo.retry). Declared with `let`
// so the two tests below see whatever the most recent beforeAll computed.
let RUN_SUFFIX;
let TEST_EMAIL;
let TEST_USERNAME;

async function seedLightAccount(pool) {
  const passwordHash = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id });
  // verify_token = NULL means active (see 001_schema.sql comment on
  // `accounts.verify_token`). custody = 'light' matches what /api/auth/signup
  // would have produced.
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, full_name, institution, field, custody, verify_token)
     VALUES ($1, $2, $3, $4, $5, $6, 'light', NULL)
     ON CONFLICT (email) DO UPDATE SET
       username = EXCLUDED.username,
       password_hash = EXCLUDED.password_hash,
       custody = EXCLUDED.custody,
       verify_token = NULL`,
    [TEST_EMAIL, TEST_USERNAME, passwordHash, 'E2E Login Tester', 'Test Institution', 'Test Science'],
  );
}

test.describe('email+password login', () => {
  let pool;

  test.beforeAll(async ({}, testInfo) => {
    // Recompute RUN_SUFFIX per beforeAll invocation. Playwright runs
    // beforeAll again on retries, so including `testInfo.retry` guarantees
    // retries see a distinct suffix and don't collide on UNIQUE(email) /
    // UNIQUE(username) against rows left by the failed attempt.
    RUN_SUFFIX = `${Date.now().toString(36).slice(-6)}r${testInfo.retry}`;
    TEST_EMAIL = `e2e+login-${RUN_SUFFIX}@pevo.test`;
    TEST_USERNAME = `e2e-login-${RUN_SUFFIX}`;
    // `openAppPool` refuses to open the pool unless APP_DATABASE_URL's
    // database name ends in `_test` — spec-local belt-and-suspenders for
    // spec-in-isolation runs that skip global-setup.
    pool = openAppPool();
    await seedLightAccount(pool);
  });

  test.afterAll(async () => {
    if (pool) await pool.end();
  });

  test('valid credentials redirect to /papers and the session token authorises subsequent API calls', async ({ page }) => {
    // Fail the test if the login page would trigger a native alert — the
    // project rule is "no alert() in user-facing flows". Playwright auto-
    // dismisses dialogs, so without this listener an alert() would silently
    // slip through.
    page.on('dialog', (dialog) => {
      throw new Error(`Unexpected dialog: ${dialog.type()} "${dialog.message()}"`);
    });

    await page.goto('/login');

    await page.locator('input[x-model="emailOrUsername"]').fill(TEST_USERNAME);
    await page.locator('input[x-model="password"]').fill(TEST_PASSWORD);

    const loginRequestPromise = page.waitForRequest(
      (req) => req.url().endsWith('/api/auth/login') && req.method() === 'POST',
    );
    const loginResponsePromise = page.waitForResponse(
      (resp) => resp.url().endsWith('/api/auth/login'),
    );

    await page.locator('form button[type="submit"]').click();

    const loginReq = await loginRequestPromise;
    const reqBody = JSON.parse(loginReq.postData() ?? '{}');
    expect(reqBody).toMatchObject({
      email_or_username: TEST_USERNAME,
      password: TEST_PASSWORD,
    });

    const loginResp = await loginResponsePromise;
    expect(loginResp.status()).toBe(200);
    const loginJson = await loginResp.json();
    expect(loginJson.status).toBe('ok');
    expect(loginJson.data.username).toBe(TEST_USERNAME);
    expect(loginJson.data.custody).toBe('light');
    expect(typeof loginJson.data.token).toBe('string');
    expect(loginJson.data.token.length).toBeGreaterThan(0);

    // Router auto-prepends locale (see router.js navigate()), so /papers
    // becomes /en/papers.
    await expect(page).toHaveURL(/\/en\/papers(\?|$)/);

    // Authenticated follow-up: read the token that the auth store stashed
    // into localStorage and hit a Bearer-protected endpoint. /api/settings/email
    // is guarded by verifyHiveSignature, which accepts the session JWT.
    const session = await page.evaluate(() => {
      const raw = window.localStorage.getItem('pevo_session');
      return raw ? JSON.parse(raw) : null;
    });
    expect(session).toBeTruthy();
    expect(session.username).toBe(TEST_USERNAME);
    expect(session.custody).toBe('light');

    const authedResp = await page.request.get('/api/settings/email', {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    expect(authedResp.status()).toBe(200);
    const authedJson = await authedResp.json();
    expect(authedJson.status).toBe('ok');
    expect(authedJson.data.hasEmail).toBe(true);
    expect(authedJson.data.custody).toBe('light');
  });

  test('wrong password shows inline error and never fires a browser alert', async ({ page }) => {
    const dialogs = [];
    page.on('dialog', (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
    });

    await page.goto('/login');

    await page.locator('input[x-model="emailOrUsername"]').fill(TEST_USERNAME);
    await page.locator('input[x-model="password"]').fill(WRONG_PASSWORD);

    const loginResponsePromise = page.waitForResponse(
      (resp) => resp.url().endsWith('/api/auth/login'),
    );

    await page.locator('form button[type="submit"]').click();

    const loginResp = await loginResponsePromise;
    expect(loginResp.status()).toBe(401);
    const errJson = await loginResp.json();
    expect(errJson.status).toBe('error');
    expect(errJson.error.code).toBe('UNAUTHORIZED');

    // Inline error banner renders (template uses `x-show="error && !pendingState"`
    // on a .text-red-700 paragraph). The error message must be visible to the
    // user — no alert, no silent failure.
    // The login page renders two `.text-red-700` paragraphs (field-level + form-level
    // surfaces); `.first()` picks the top banner that holds the auth error text.
    const errorBanner = page.locator('p.text-red-700').first();
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toHaveText(/invalid credentials/i);

    // Stayed on /login — no redirect.
    await expect(page).toHaveURL(/\/en\/login(\?|$)/);

    // No valid session persisted. (The auth store initializes an empty
    // session object at load time; what matters is that no token landed.)
    const session = await page.evaluate(() => {
      const raw = window.localStorage.getItem('pevo_session');
      return raw ? JSON.parse(raw) : null;
    });
    expect(session?.token ?? null).toBeNull();
    expect(session?.username ?? null).toBeNull();

    // Crucially: window.alert was never called.
    expect(dialogs).toEqual([]);
  });
});

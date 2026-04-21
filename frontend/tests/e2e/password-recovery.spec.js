/**
 * E2E-AUTH-3 — Password recovery (email-based reset) happy path.
 *
 * Flow covered:
 *   1. Seed an active light-account user directly in pevo_app_test (signup
 *      via API to generate a valid argon2 password hash, then flip the row
 *      to the active state).
 *   2. Drive the password-reset request UI at /reset-password: submit the
 *      seeded email, assert POST /api/auth/reset-request fires and the
 *      "check your email" confirmation renders.
 *   3. Read the reset_token straight from pevo_app_test. Mailpit is wired
 *      in docker-compose.test.override.yml, but existing specs
 *      (email-signup.spec.js) read signup tokens from the DB; we follow
 *      the same convention — the token existing in the DB is the
 *      functional invariant, and bypassing Mailpit keeps the spec
 *      resilient to Mailpit connectivity.
 *   4. Follow the reset link (/reset-password?token=...), submit the new
 *      password, assert POST /api/auth/reset fires and the "Password
 *      Reset" confirmation renders.
 *   5. Navigate to /login and sign in with the NEW password; assert the
 *      session cookie lands and the app redirects to /papers.
 *
 * Note: the backend email link points to /auth/reset?token=..., but the
 * frontend router only maps /reset-password. The reset-password page's
 * init() reads ?token= and switches to reset mode either way, so we
 * drive /reset-password?token=... directly.
 *
 * The task brief mentioned "/recover"; in this codebase /recover is the
 * separate seed-phrase / ORCID lost-email flow (POST /api/auth/recover),
 * while email-based password reset lives at /reset-password (POST
 * /api/auth/reset-request + /api/auth/reset). The brief's "request a
 * reset, read token, follow link, set password" sequence maps to the
 * reset-password page, not /recover.
 */

import { test, expect } from './fixtures/keychain.js';
import { withAppPool } from './fixtures/db.js';

// This spec drives password-reset flows that carry plaintext passwords through
// form submissions and response bodies. Disable trace/video/screenshot so
// neither the plaintext passwords nor any subsequent session JWT ends up
// persisted in trace.zip artifacts (the global default
// `trace: 'retain-on-failure'` would otherwise capture them).
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

// Suffix the email and username so reruns against a non-truncated dev DB
// don't collide on UNIQUE(email) / UNIQUE(username). Mirrors the pattern
// introduced in seed-phrase.spec.js for the same reason.
const RUN_SUFFIX = Date.now().toString(36).slice(-6);
const TEST_EMAIL = `e2e+recovery-${RUN_SUFFIX}@pevo.test`;
const TEST_USERNAME = `e2e-recover-${RUN_SUFFIX}`;
const OLD_PASSWORD = 'E2eOldPass1';
const NEW_PASSWORD = 'E2eNewPass2';
const TEST_NAME = 'E2E Recovery Tester';
const TEST_INSTITUTION = 'Test Institution';
const TEST_FIELD = 'Test Science';

/**
 * Seed an active light-account user in pevo_app_test:
 *   - Run the standard signup so argon2 hashes the known password.
 *   - Flip verify_token/username/custody so the row represents an
 *     account that has completed the Hive-account step.
 * Returns the account id for follow-up queries.
 */
async function seedActiveUser(request, pool) {
  // Clean any leftover row from a prior partial run (test DB is reset
  // between runs by global-setup, but a retry within the same run can hit
  // UNIQUE(email)).
  await pool.query('DELETE FROM accounts WHERE email = $1 OR username = $2', [
    TEST_EMAIL,
    TEST_USERNAME,
  ]);

  const signupResp = await request.post('/api/auth/signup', {
    data: {
      email: TEST_EMAIL,
      password: OLD_PASSWORD,
      full_name: TEST_NAME,
      institution: TEST_INSTITUTION,
      field: TEST_FIELD,
    },
  });
  expect(signupResp.status()).toBe(200);

  // Promote the pending signup to an active, usable light account.
  const { rows } = await pool.query(
    `UPDATE accounts
       SET verify_token = NULL,
           username = $2,
           custody = 'light'
     WHERE email = $1
     RETURNING id`,
    [TEST_EMAIL, TEST_USERNAME],
  );
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

test('user requests password reset, follows email token, and signs in with new password', async ({
  page,
  request,
}) => {
  // `withAppPool` opens a short-lived pool against APP_DATABASE_URL, enforces
  // the `_test` DB-suffix guard locally, and ends the pool even if the test
  // throws — replaces the hand-rolled pool/try/finally that used to live here.
  await withAppPool(async (pool) => {
    await seedActiveUser(request, pool);

    // ── Step 1: request a reset from the UI ────────────────────────
    await page.goto('/reset-password');

    await page.locator('input[x-model="email"]').fill(TEST_EMAIL);

    const requestPromise = page.waitForRequest(
      (req) =>
        req.url().endsWith('/api/auth/reset-request') && req.method() === 'POST',
    );
    const responsePromise = page.waitForResponse(
      (resp) => resp.url().endsWith('/api/auth/reset-request'),
    );

    await page.locator('form button[type="submit"]').click();

    const reqReset = await requestPromise;
    expect(JSON.parse(reqReset.postData() ?? '{}')).toEqual({
      email: TEST_EMAIL,
    });

    const respReset = await responsePromise;
    expect(respReset.status()).toBe(200);

    await expect(
      page.getByRole('heading', { name: 'Check your email' }),
    ).toBeVisible();

    // ── Step 2: read the reset token from pevo_app_test ────────────
    const { rows: tokenRows } = await pool.query(
      'SELECT reset_token, reset_token_expires_at FROM accounts WHERE email = $1',
      [TEST_EMAIL],
    );
    expect(tokenRows).toHaveLength(1);
    const resetToken = tokenRows[0].reset_token;
    expect(resetToken).toBeTruthy();
    expect(resetToken).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenRows[0].reset_token_expires_at).toBeTruthy();

    // ── Step 3: follow the reset link and submit a new password ────
    await page.goto(`/reset-password?token=${resetToken}`);

    await expect(
      page.getByRole('heading', { name: 'Set a new password' }),
    ).toBeVisible();

    await page.locator('input[x-model="password"]').fill(NEW_PASSWORD);
    await page.locator('input[x-model="passwordConfirm"]').fill(NEW_PASSWORD);

    const resetRequestPromise = page.waitForRequest(
      (req) => req.url().endsWith('/api/auth/reset') && req.method() === 'POST',
    );
    const resetResponsePromise = page.waitForResponse(
      (resp) => resp.url().endsWith('/api/auth/reset'),
    );

    await page.locator('form button[type="submit"]').click();

    const reqBody = JSON.parse((await resetRequestPromise).postData() ?? '{}');
    expect(reqBody).toEqual({ token: resetToken, password: NEW_PASSWORD });

    const resetResp = await resetResponsePromise;
    expect(resetResp.status()).toBe(200);

    await expect(
      page.getByRole('heading', { name: 'Password Reset' }),
    ).toBeVisible();

    // Backend should have cleared the reset token and hashed the new password.
    const { rows: afterRows } = await pool.query(
      'SELECT reset_token, password_hash FROM accounts WHERE email = $1',
      [TEST_EMAIL],
    );
    expect(afterRows[0].reset_token).toBeNull();
    expect(afterRows[0].password_hash).toBeTruthy();

    // ── Step 4: sign in with the new password ──────────────────────
    await page.goto('/login');

    await page.locator('input[x-model="emailOrUsername"]').fill(TEST_EMAIL);
    await page.locator('input[x-model="password"]').fill(NEW_PASSWORD);

    const loginResponsePromise = page.waitForResponse(
      (resp) => resp.url().endsWith('/api/auth/login'),
    );

    await page.locator('form button[type="submit"]').click();

    const loginResp = await loginResponsePromise;
    expect(loginResp.status()).toBe(200);
    const loginJson = await loginResp.json();
    expect(loginJson.status).toBe('ok');
    expect(loginJson.data.username).toBe(TEST_USERNAME);
    expect(loginJson.data.token).toBeTruthy();
    expect(loginJson.data.custody).toBe('light');

    // Login handler navigates to /papers on success.
    await page.waitForURL(/\/papers(\?|$)/);

    // Session persists in localStorage under the auth store's key.
    const stored = await page.evaluate(
      () => window.localStorage.getItem('pevo_session'),
    );
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored);
    expect(parsed.username).toBe(TEST_USERNAME);
    expect(parsed.token).toBe(loginJson.data.token);
  });
});

/**
 * A session revoked from another device ends in this browser at its next
 * bearer request.
 *
 * Real-path companion to `tests/unit/session-revoked.test.js` and
 * `tests/unit/session-expired.test.js`, which stub `fetch` to produce the
 * server's answer. Here no response is stubbed. Two contexts share one seeded
 * light account: a browser context signed in to it through the `/login` form,
 * and the other device, the `request` fixture, which revokes every session of
 * the account with a real password reset. The browser's next bearer request,
 * sent by an in-app navigation to the settings page, meets the real
 * `verifyHiveSignature` revocation check. The spec asserts the answer and what
 * the client makes of it: the stored session is gone, the signed-out message
 * is shown, and the sign-in modal is open with the reason inside it.
 *
 * The browser runs without the boot mocks other specs install
 * (`installAuthedBootMocks`), so every bearer request it sends reaches the
 * backend.
 */

import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures/keychain.js';
import { withAppPool } from './fixtures/db.js';
import { seedLightAccount, postTo, TEST_PASSWORD } from './fixtures/light-account.js';

// The spec types the account password and handles a live session token and a
// reset token, so nothing is recorded.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const NEW_PASSWORD = 'E2eRevokedPass2';

// The copy the teardown shows, read from the bundle the app loads.
const REVOKED_COPY = JSON.parse(
  readFileSync(new URL('../../public/messages/en.json', import.meta.url), 'utf8'),
).auth.sessionRevoked;

test('a password reset on another device signs this browser out at its next bearer request', async ({
  browser,
  request,
}, testInfo) => {
  const RUN_SUFFIX = `${Date.now().toString(36).slice(-6)}r${testInfo.retry}`;
  const email = `e2e+revoked-${RUN_SUFFIX}@pevo.test`;
  const username = `e2e-revoked-${RUN_SUFFIX}`;

  const browserContext = await browser.newContext();
  try {
    await withAppPool(async (pool) => {
      await seedLightAccount(pool, { username, email, fullName: 'E2E Revoked Session Tester' });
      const page = await browserContext.newPage();

      // ── This browser signs in ──────────────────────────────────────
      await page.goto('/login');
      const loginForm = page.locator('[x-data="loginPage"] form');
      await loginForm.locator('input[x-model="emailOrUsername"]').fill(email);
      await loginForm.locator('input[x-model="password"]').fill(TEST_PASSWORD);
      const loginResponse = page.waitForResponse(postTo('/api/auth/login').response);
      await loginForm.locator('button[type="submit"]').click();
      expect((await loginResponse).status()).toBe(200);
      await page.waitForURL(/\/papers(\?|$)/);
      const session = await page.evaluate(() => JSON.parse(localStorage.getItem('pevo_session')));
      expect(session.username).toBe(username);

      // ── The other device resets the password ──────────────────────
      const resetRequest = await request.post('/api/auth/reset-request', { data: { email } });
      expect(resetRequest.status()).toBe(200);
      const { rows } = await pool.query('SELECT reset_token FROM accounts WHERE username = $1', [
        username,
      ]);
      const resetToken = rows[0]?.reset_token;
      expect(resetToken).toMatch(/^[a-f0-9]{64}$/);
      const reset = await request.post('/api/auth/reset', {
        data: { token: resetToken, password: NEW_PASSWORD },
      });
      expect(reset.status()).toBe(200);

      // ── This browser sends its next bearer request ────────────────
      // The settings page loads the account's email status on mount. The
      // first 401 carrying this browser's token is the revocation answer.
      const revokedAnswer = page.waitForResponse(
        async (resp) =>
          resp.status() === 401 &&
          (await resp.request().headerValue('authorization')) === `Bearer ${session.token}`,
      );
      await page.locator('button[aria-haspopup="true"]', { hasText: `@${username}` }).click();
      await page.getByRole('link', { name: 'Settings', exact: true }).click();
      const revoked = await revokedAnswer;
      expect((await revoked.json()).error?.code).toBe('SESSION_INVALIDATED');

      // The signed-out message, the stored session gone, and the sign-in
      // modal open with the reason inside it.
      await expect(page.locator('[role="alert"]', { hasText: REVOKED_COPY })).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem('pevo_session'))).toBeNull();
      const signInDialog = page.locator('[x-data="signInModal"] [role="dialog"]');
      await expect(signInDialog).toBeVisible();
      await expect(signInDialog.locator('[role="status"]')).toHaveText(REVOKED_COPY);
    });
  } finally {
    await browserContext.close();
  }
});

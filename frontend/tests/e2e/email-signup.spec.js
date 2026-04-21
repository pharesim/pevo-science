/**
 * TEST-004 — First Playwright E2E: email signup golden path.
 *
 * Drives a fresh visitor through the password-signup flow without any
 * Keychain-signed endpoint (the signup and verify routes don't require a
 * Hive signature, so a stubbed Keychain is fine here). The Keychain
 * fixture is imported even though this flow never signs anything — it
 * keeps the stub wiring exercised on every E2E run.
 *
 * Backend is routed at pevo_app_test via docker-compose.test.override.yml;
 * Playwright's global-setup has already truncated tables before this
 * spec starts.
 */

import { test, expect } from './fixtures/keychain.js';
import { queryAppDb } from './fixtures/db.js';

// This spec drives a signup flow that carries a plaintext password through
// the form submission and subsequent authenticated responses. Disable
// trace/video/screenshot so neither the plaintext password nor any minted
// session JWT ends up persisted in trace.zip artifacts (the global default
// `trace: 'retain-on-failure'` would otherwise capture them).
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

// Constants that don't depend on RUN_SUFFIX stay at module scope; identity
// strings derived from RUN_SUFFIX are computed per-test (see test body) so
// Playwright retries get a distinct suffix and don't collide on
// UNIQUE(email). Matches the pattern in seed-phrase.spec.js.
const TEST_PASSWORD = 'E2eTestPass1';
const TEST_NAME = 'E2E Tester';
const TEST_INSTITUTION = 'Test Institution';
const TEST_FIELD = 'Test Science';

test('fresh visitor signs up and verifies email', async ({ page }, testInfo) => {
  // RUN_SUFFIX is computed here (not at module scope) so Playwright retries
  // in the same worker re-evaluate it. Including `testInfo.retry` guarantees
  // a distinct suffix on every attempt, avoiding duplicate-signup 409s that
  // would mask the original failure.
  const RUN_SUFFIX = `${Date.now().toString(36).slice(-6)}r${testInfo.retry}`;
  const TEST_EMAIL = `e2e+signup-${RUN_SUFFIX}@pevo.test`;

  await page.goto('/signup');

  // Alpine x-model is preserved in the DOM; selecting by it is stable
  // against i18n / layout changes.
  await page.locator('input[x-model="email"]').fill(TEST_EMAIL);
  await page.locator('input[x-model="fullName"]').fill(TEST_NAME);
  await page.locator('input[x-model="institution"]').fill(TEST_INSTITUTION);
  await page.locator('input[x-model="field"]').fill(TEST_FIELD);
  await page.locator('input[x-model="password"]').fill(TEST_PASSWORD);
  await page.locator('input[x-model="passwordConfirm"]').fill(TEST_PASSWORD);

  const signupRequestPromise = page.waitForRequest(
    (req) => req.url().endsWith('/api/auth/signup') && req.method() === 'POST',
  );
  const signupResponsePromise = page.waitForResponse(
    (resp) => resp.url().endsWith('/api/auth/signup'),
  );

  await page.locator('form button[type="submit"]').click();

  const signupReq = await signupRequestPromise;
  const body = JSON.parse(signupReq.postData() ?? '{}');
  expect(body).toMatchObject({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    full_name: TEST_NAME,
    institution: TEST_INSTITUTION,
    field: TEST_FIELD,
  });

  const signupResp = await signupResponsePromise;
  expect(signupResp.status()).toBe(200);

  await expect(
    page.getByRole('heading', { name: 'Check your email' }),
  ).toBeVisible();

  // Read the verification token straight from pevo_app_test. `queryAppDb`
  // layers a spec-local `_test` DB-suffix guard on top of global-setup for
  // spec-in-isolation runs.
  const { rows } = await queryAppDb(
    'SELECT verify_token FROM accounts WHERE email = $1',
    [TEST_EMAIL],
  );
  expect(rows).toHaveLength(1);
  const verifyToken = rows[0].verify_token;
  expect(verifyToken).toBeTruthy();
  expect(verifyToken.startsWith('confirmed:')).toBe(false);

  // Drive the verify page; it auto-POSTs /api/auth/verify on init.
  const verifyResponsePromise = page.waitForResponse(
    (resp) => resp.url().endsWith('/api/auth/verify'),
  );
  await page.goto(`/signup/verify?token=${verifyToken}`);

  const verifyResp = await verifyResponsePromise;
  expect(verifyResp.status()).toBe(200);

  await expect(
    page.getByRole('heading', { name: 'Email Verified' }),
  ).toBeVisible();
});

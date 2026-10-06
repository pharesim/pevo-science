/**
 * E2E-ACCR-1 — Accreditation request + verify-callback flow.
 *
 * Drives /accreditation end-to-end for an unaccredited user:
 *
 *   1. Seed a connected, unaccredited session. The username does not need
 *      to exist in HAF — the accreditation-status endpoint returns
 *      `is_accredited: false` for any unknown account, which keeps the
 *      request form visible.
 *   2. Fill institutional email + ORCID (plus name/institution/field) and
 *      submit. The `POST /api/accreditation/request` endpoint depends on
 *      live SMTP + admin posting key, neither of which is configured in
 *      the E2E backend, so we stub the route at the network layer. The
 *      stub captures the request so we can assert the backend would have
 *      received a correctly-shaped pending-attestation payload (full
 *      fields, JWT bearer header, institutional email, ORCID forwarded).
 *   3. Assert the UI transitions to the success step and renders the
 *      "check your email" follow-up.
 *   4. Simulate the email link: navigate to
 *      `/accreditation/verify?token=<stub>`. That page POSTs to
 *      `/api/accreditation/verify` on init; we stub that route too and
 *      return a canned `Accreditation confirmed` payload so the UI can
 *      reach the confirmed state without the backend broadcasting a
 *      custom_json.
 *   5. Assert the confirmed-state heading and the username are rendered.
 *
 * The spec deliberately never lets either accreditation endpoint hit the
 * real backend — it verifies the request payloads and the UI state
 * transitions, which is what "records a pending attestation / UI reflects
 * pending status" means at the network boundary.
 */

import { test, expect } from './fixtures/keychain.js';
import { mintSessionJwt, seedUnaccreditedSession } from './fixtures/auth.js';

// This spec mints a live backend-valid bearer JWT via seedUnaccreditedSession.
// Disable trace/video/screenshot to keep that token out of trace.zip artifacts
// (the global default `trace: 'retain-on-failure'` would otherwise persist it).
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const TEST_FULL_NAME = 'E2E Accreditation Tester';
const TEST_INSTITUTION = 'Test Institution';
const TEST_FIELD = 'Test Science';
// Domain must match `isInstitutionalEmail`; the real backend would reject
// non-institutional addresses with VALIDATION_ERROR. We stub the route so
// the check is never executed, but keeping the address realistic makes
// the captured request body look like the real thing.
const TEST_EMAIL = 'accr-e2e@cern.ch';
const TEST_ORCID = '0000-0001-2345-6789';
const STUB_TOKEN = 'stub-accreditation-token-1234567890abcdef';
const STUB_TX_ID = 'stub-tx-id-0000000000000000';

test('unaccredited user submits request and completes the verify callback', async ({
  page,
}) => {
  const { username, token } = await seedUnaccreditedSession(page);

  // ─── Stub POST /api/accreditation/request ────────────────────────
  // Capture the request so we can assert the backend would have
  // recorded the expected pending attestation.
  let capturedRequest = null;
  await page.route('**/api/accreditation/request', async (route) => {
    const req = route.request();
    capturedRequest = {
      method: req.method(),
      headers: req.headers(),
      body: JSON.parse(req.postData() ?? '{}'),
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        data: {
          message: `Verification email sent to a***r@***.ch`,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
      }),
    });
  });

  // ─── Drive the request form ──────────────────────────────────────
  const requestResponsePromise = page.waitForResponse(
    (resp) =>
      resp.url().endsWith('/api/accreditation/request') &&
      resp.request().method() === 'POST',
  );

  await page.goto('/accreditation');
  await page.waitForSelector('[x-data="accreditationPage"]');

  // The form only renders when `!isAccredited`. If auth polling flipped
  // the account to accredited, the form would be hidden — guard against
  // that regression up front.
  await expect(page.locator('input[x-model="fullName"]')).toBeVisible();

  await page.locator('input[x-model="fullName"]').fill(TEST_FULL_NAME);
  await page.locator('input[x-model="institution"]').fill(TEST_INSTITUTION);
  await page.locator('input[x-model="field"]').fill(TEST_FIELD);
  await page.locator('input[x-model="email"]').fill(TEST_EMAIL);
  await page.locator('input[x-model="orcid"]').fill(TEST_ORCID);

  await page.locator('[x-data="accreditationPage"] form button[type="submit"]').click();

  const requestResp = await requestResponsePromise;
  expect(requestResp.status()).toBe(200);

  // ─── Assert backend would record a pending attestation ──────────
  expect(capturedRequest, 'accreditation-request route should fire').not.toBeNull();
  expect(capturedRequest.method).toBe('POST');
  expect(capturedRequest.body).toEqual({
    full_name: TEST_FULL_NAME,
    institution: TEST_INSTITUTION,
    field: TEST_FIELD,
    email: TEST_EMAIL,
    orcid: TEST_ORCID,
  });
  // authenticatedRequest attaches the JWT as a Bearer token. Header names
  // are lowercased by Playwright.
  expect(capturedRequest.headers.authorization).toBe(`Bearer ${token}`);

  // ─── UI reflects pending (success) status ───────────────────────
  // The success branch shows the backend's `message` plus the
  // "Check your email for the verification link." hint.
  await expect(
    page.getByText('Verification email sent to', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText('Check your email for the verification link.'),
  ).toBeVisible();

  // Submit button is disabled in the success step so a repeat click
  // can't re-fire the request.
  await expect(page.locator('[x-data="accreditationPage"] form button[type="submit"]')).toBeDisabled();

  // ─── Stub POST /api/accreditation/verify ────────────────────────
  // The verify page auto-POSTs on init with the token from the URL.
  let capturedVerify = null;
  await page.route('**/api/accreditation/verify', async (route) => {
    const req = route.request();
    capturedVerify = {
      method: req.method(),
      headers: req.headers(),
      body: JSON.parse(req.postData() ?? '{}'),
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        data: {
          message: 'Accreditation confirmed',
          username,
          tx_id: STUB_TX_ID,
        },
      }),
    });
  });

  // ─── Simulate the email-verification redirect ───────────────────
  const verifyResponsePromise = page.waitForResponse(
    (resp) =>
      resp.url().endsWith('/api/accreditation/verify') &&
      resp.request().method() === 'POST',
  );

  await page.goto(`/accreditation/verify?token=${STUB_TOKEN}`);

  const verifyResp = await verifyResponsePromise;
  expect(verifyResp.status()).toBe(200);

  expect(capturedVerify, 'accreditation-verify route should fire').not.toBeNull();
  expect(capturedVerify.body).toEqual({ token: STUB_TOKEN });
  // The verification is accepted only from the requesting account's session.
  expect(capturedVerify.headers.authorization).toBe(`Bearer ${token}`);

  // ─── UI reaches the confirmed state ─────────────────────────────
  await expect(
    page.getByRole('heading', { name: 'Accreditation Confirmed' }),
  ).toBeVisible();
  // The confirmed-state paragraph ("<username> is now an accredited researcher…")
  // is unique to this page; narrow the match so the header/nav occurrences of
  // the same username don't trigger strict-mode multi-match.
  await expect(
    page.getByText(`@${username} is now`, { exact: false }),
  ).toBeVisible();
});

// Without a session the verify page posts nothing and asks for a sign-in.
// The Keychain sign-in is stubbed at /api/auth/session with a JWT minted the
// way login-keychain.spec.js does, so the stubbed signature never reaches the
// backend. After the sign-in the page posts the token from the URL once, with
// the new session.
test('verify link opened without a session asks for sign-in, then posts with the session', async ({
  page,
}) => {
  const username = `e2everify${Date.now().toString(36)}`;
  const { token, expiresAt } = mintSessionJwt(username, { custody: 'self' });

  await page.route('**/api/auth/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        data: { token, expires_at: expiresAt, custody: 'self' },
      }),
    });
  });

  const verifyRequests = [];
  await page.route('**/api/accreditation/verify', async (route) => {
    const req = route.request();
    verifyRequests.push({
      headers: req.headers(),
      body: JSON.parse(req.postData() ?? '{}'),
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        data: { message: 'Accreditation confirmed', username, tx_id: STUB_TX_ID },
      }),
    });
  });

  await page.goto(`/accreditation/verify?token=${STUB_TOKEN}`);

  const verifyPage = page.locator('[x-data="accreditationVerifyPage"]');
  await expect(
    verifyPage.getByRole('heading', { name: 'Sign in to confirm your accreditation' }),
  ).toBeVisible();
  // The page decides at load; with no session it has sent nothing.
  expect(verifyRequests).toHaveLength(0);

  await verifyPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForSelector('[role="dialog"]');
  await page
    .locator('[role="dialog"]')
    .getByRole('button', { name: /Hive Keychain/ })
    .click();
  await page.waitForSelector('#keychain-username-input');
  await page.locator('#keychain-username-input').fill(username);

  const verifyRequestPromise = page.waitForRequest(
    (req) => req.url().endsWith('/api/accreditation/verify') && req.method() === 'POST',
  );
  await Promise.all([
    verifyRequestPromise,
    page.getByRole('button', { name: 'Connect', exact: true }).click(),
  ]);

  await expect(
    page.getByRole('heading', { name: 'Accreditation Confirmed' }),
  ).toBeVisible();
  expect(verifyRequests).toHaveLength(1);
  expect(verifyRequests[0].body).toEqual({ token: STUB_TOKEN });
  expect(verifyRequests[0].headers.authorization).toBe(`Bearer ${token}`);
});

// A session of another account is refused with ACCREDITATION_ACCOUNT_MISMATCH.
// The token stays usable, so the page says which account to sign in as and
// offers no new request.
test('verify link opened as a different account shows the different-account state', async ({
  page,
}) => {
  await seedUnaccreditedSession(page);

  await page.route('**/api/accreditation/verify', async (route) => {
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'error',
        error: {
          code: 'ACCREDITATION_ACCOUNT_MISMATCH',
          message: 'stub mismatch message',
        },
      }),
    });
  });

  await page.goto(`/accreditation/verify?token=${STUB_TOKEN}`);

  const verifyPage = page.locator('[x-data="accreditationVerifyPage"]');
  await expect(
    verifyPage.getByRole('heading', { name: 'Signed in as a different account' }),
  ).toBeVisible();
  await expect(
    verifyPage.getByText('This verification link belongs to a different account.', { exact: false }),
  ).toBeVisible();
  await expect(
    verifyPage.getByRole('link', { name: 'Request New Accreditation' }),
  ).toHaveCount(0);
});

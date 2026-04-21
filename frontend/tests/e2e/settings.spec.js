/**
 * E2E-SETTINGS-1 — Settings changes without broadcast.
 *
 * Covers two non-chain settings flows from a logged-in light-account user:
 *
 *  1. Display preference (locale): toggle the language switcher on /settings
 *     to a non-default locale, reload the page, assert the PEVO_LOCALE cookie
 *     persists and the app boots in that locale.
 *
 *  2. Email change request + verification: with a pre-seeded account that has
 *     a verified email, click "Change email", submit a new address, read the
 *     `pending_email_token` from pevo_app_test (equivalent to the mail sink
 *     for tokens — same approach as email-signup.spec.js), hit the verify
 *     URL, assert the token is consumed and the primary email flips to the
 *     new address.
 *
 * Seeding mirrors login-email.spec.js: insert an `accounts` row with
 * custody='light', verify_token=NULL so the backend reports the account as
 * active with a verified email. The JWT is minted via SESSION_SECRET and
 * seeded into localStorage so the auth store treats the user as logged in
 * without a Keychain signature (matches verifyHiveSignature's Bearer path).
 *
 * No Hive chain writes, no alert() surface; all write calls go through the
 * PEvO backend only.
 */

import { test, expect } from './fixtures/keychain.js';
import { mintSessionJwt } from './fixtures/auth.js';
import { openAppPool } from './fixtures/db.js';

// Specs in this file mint live backend-valid bearer JWTs via mintSessionJwt.
// Disable trace/video/screenshot to keep those tokens out of trace.zip artifacts
// (the global default `trace: 'retain-on-failure'` would otherwise persist them).
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

// Stable constants stay at module scope; identity strings derived from
// RUN_SUFFIX are (re)computed in beforeAll so Playwright retries — which
// re-run beforeAll but do NOT re-evaluate module scope — get a distinct
// suffix that includes `testInfo.retry`.
const NEW_LOCALE = 'de';

// Populated in beforeAll from (Date.now, testInfo.retry). Declared with `let`
// so the tests + seedLightAccount + seedLightSession observe whatever the
// most recent beforeAll computed.
let RUN_SUFFIX;
let TEST_USERNAME;
let TEST_EMAIL_OLD;
let TEST_EMAIL_NEW;

async function seedLightAccount(pool) {
  // custody='light', verify_token=NULL means an active light-account user
  // with a verified email. password_hash is non-null but not exercised by
  // the email-change flow (JWT Bearer auth bypasses the password path).
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, full_name, institution, field, custody, verify_token)
     VALUES ($1, $2, $3, $4, $5, $6, 'light', NULL)
     ON CONFLICT (email) DO UPDATE SET
       username = EXCLUDED.username,
       password_hash = EXCLUDED.password_hash,
       custody = EXCLUDED.custody,
       verify_token = NULL,
       pending_email = NULL,
       pending_email_token = NULL,
       pending_email_expires_at = NULL`,
    [TEST_EMAIL_OLD, TEST_USERNAME, 'argon2id$dummy', 'E2E Settings Tester', 'Test Institution', 'Test Science'],
  );
}

/**
 * Drop a session for TEST_USERNAME into localStorage before the app boots.
 * Light-custody, not accredited — the email section does not require
 * accreditation and we don't need the ORCID branch.
 */
async function seedLightSession(page) {
  const { token, expiresAt } = mintSessionJwt(TEST_USERNAME, { custody: 'light' });
  const session = {
    token,
    username: TEST_USERNAME,
    expiresAt,
    isAccredited: false,
    accreditation: null,
    custody: 'light',
  };
  await page.addInitScript((s) => {
    window.localStorage.setItem('pevo_session', JSON.stringify(s));
  }, session);
  return { token };
}

test.describe('settings — light-account non-chain flows', () => {
  let pool;

  test.beforeAll(async ({}, testInfo) => {
    // Recompute RUN_SUFFIX per beforeAll invocation. Playwright re-runs
    // beforeAll on retries, so including `testInfo.retry` guarantees retries
    // see a distinct suffix and don't collide on UNIQUE(email) /
    // UNIQUE(username) against rows left by the failed attempt.
    RUN_SUFFIX = `${Date.now().toString(36).slice(-6)}r${testInfo.retry}`;
    TEST_USERNAME = `e2e-settings-${RUN_SUFFIX}`;
    TEST_EMAIL_OLD = `e2e+settings-old-${RUN_SUFFIX}@pevo.test`;
    TEST_EMAIL_NEW = `e2e+settings-new-${RUN_SUFFIX}@pevo.test`;
    // `openAppPool` enforces the `_test` DB-suffix guard locally, matching
    // global-setup so spec-in-isolation runs can't accidentally write to
    // the dev DB.
    pool = openAppPool();
    await seedLightAccount(pool);
  });

  test.afterAll(async () => {
    if (pool) await pool.end();
  });

  test('locale toggle on /settings persists across reload', async ({ page }) => {
    // Fail loudly if anything surfaces a browser dialog — UI CLAUDE.md bans
    // alert() and the settings page must stay compliant.
    page.on('dialog', (dialog) => {
      throw new Error(`Unexpected dialog: ${dialog.type()} "${dialog.message()}"`);
    });

    await seedLightSession(page);

    // Clear any locale cookie from a previous run so the default-locale
    // detection path is exercised.
    await page.context().clearCookies();

    await page.goto('/settings');

    // Wait for the settings page to mount and confirm we're signed-in
    // (not the sign-in-required branch).
    await page.waitForSelector('[x-data="settingsPage"]');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // Open the desktop language switcher. The `md:hidden` mobile copy shares
    // the same markup, so scope to the first visible listbox trigger.
    const langButton = page.locator('button[aria-label="Language"]').first();
    await langButton.click();

    // Pick the NEW_LOCALE option. `role="option"` filters out unrelated
    // buttons; name match on the localized language label comes from
    // messages/en.json → locale.de ("Deutsch"). The label is shown in the
    // target locale's own language, not translated into the current UI.
    await page.getByRole('option', { name: /^Deutsch$/ }).first().click();

    // URL should carry the locale prefix immediately after selectLocale().
    await expect(page).toHaveURL(/\/de\/settings(\?|$)/);

    // Cookie should be set to the picked locale.
    const cookiesAfterToggle = await page.context().cookies();
    const localeCookie = cookiesAfterToggle.find((c) => c.name === 'PEVO_LOCALE');
    expect(localeCookie?.value).toBe(NEW_LOCALE);

    // Reload on the locale-prefixed URL. The app should boot in `de` via
    // URL detection (first rule in i18n.js → detectLocale), and the cookie
    // must still be present.
    await page.reload();
    await page.waitForSelector('[x-data="settingsPage"]');

    await expect(page).toHaveURL(/\/de\/settings(\?|$)/);
    await expect(page.locator('html')).toHaveAttribute('lang', NEW_LOCALE);

    const cookiesAfterReload = await page.context().cookies();
    const localeCookieAfterReload = cookiesAfterReload.find((c) => c.name === 'PEVO_LOCALE');
    expect(localeCookieAfterReload?.value).toBe(NEW_LOCALE);

    // And the in-memory i18n store should reflect the same locale — proves
    // the cookie-based fallback works even if someone strips the URL prefix.
    const storeLocale = await page.evaluate(() => window.Alpine.store('i18n').locale);
    expect(storeLocale).toBe(NEW_LOCALE);
  });

  test('email change request sends verification mail, token verifies new email', async ({ page }) => {
    page.on('dialog', (dialog) => {
      throw new Error(`Unexpected dialog: ${dialog.type()} "${dialog.message()}"`);
    });

    // Reset pending_email state in case the previous test left it dirty
    // (defense-in-depth; the beforeAll INSERT already clears it).
    await pool.query(
      `UPDATE accounts
         SET email = $1,
             pending_email = NULL,
             pending_email_token = NULL,
             pending_email_expires_at = NULL
       WHERE username = $2`,
      [TEST_EMAIL_OLD, TEST_USERNAME],
    );

    await seedLightSession(page);

    // Start on the default locale so we hit the English labels in settings.
    await page.context().clearCookies();

    const emailStatusResponsePromise = page.waitForResponse(
      (resp) => resp.url().endsWith('/api/settings/email') && resp.request().method() === 'GET',
    );
    await page.goto('/settings');

    const statusResp = await emailStatusResponsePromise;
    expect(statusResp.status()).toBe(200);
    const statusBody = await statusResp.json();
    expect(statusBody.data.hasEmail).toBe(true);
    expect(statusBody.data.verified).toBe(true);
    expect(statusBody.data.custody).toBe('light');

    // Click "Change email" to reveal the form.
    await page.getByRole('button', { name: 'Change email' }).click();

    // Fill new email into the change-form input and submit.
    const changeForm = page.locator('form').filter({ hasText: 'Send verification email' });
    await changeForm.locator('input[type="email"]').fill(TEST_EMAIL_NEW);

    const submitRequestPromise = page.waitForRequest(
      (req) => req.url().endsWith('/api/settings/email') && req.method() === 'POST',
    );
    const submitResponsePromise = page.waitForResponse(
      (resp) => resp.url().endsWith('/api/settings/email') && resp.request().method() === 'POST',
    );

    await changeForm.getByRole('button', { name: 'Send verification email' }).click();

    const submitReq = await submitRequestPromise;
    expect(JSON.parse(submitReq.postData() ?? '{}')).toMatchObject({ email: TEST_EMAIL_NEW });

    const submitResp = await submitResponsePromise;
    expect(submitResp.status()).toBe(200);
    const submitBody = await submitResp.json();
    expect(submitBody.status).toBe('ok');

    // Read the pending_email_token straight from pevo_app_test. Mirrors
    // the mail-sink approach used in email-signup.spec.js: the token is
    // what would have been embedded in the verification URL mailpit
    // captured.
    const { rows } = await pool.query(
      'SELECT pending_email, pending_email_token FROM accounts WHERE username = $1',
      [TEST_USERNAME],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].pending_email).toBe(TEST_EMAIL_NEW);
    const pendingToken = rows[0].pending_email_token;
    expect(typeof pendingToken).toBe('string');
    expect(pendingToken.length).toBeGreaterThan(10);

    // Follow the verification link; settings-verify-email.js auto-calls
    // GET /api/settings/email/verify/:token on init.
    const verifyResponsePromise = page.waitForResponse(
      (resp) => resp.url().includes('/api/settings/email/verify/'),
    );

    await page.goto(`/settings/verify-email/${pendingToken}`);

    const verifyResp = await verifyResponsePromise;
    expect(verifyResp.status()).toBe(200);
    const verifyBody = await verifyResp.json();
    expect(verifyBody.data.verified).toBe(true);

    // Success phase should surface the confirmation heading.
    await expect(
      page.getByRole('heading', { name: 'Email verified successfully.' }),
    ).toBeVisible();

    // DB invariant: pending_* fields cleared, email flipped to the new address.
    const { rows: afterRows } = await pool.query(
      'SELECT email, pending_email, pending_email_token, pending_email_expires_at FROM accounts WHERE username = $1',
      [TEST_USERNAME],
    );
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0].email).toBe(TEST_EMAIL_NEW);
    expect(afterRows[0].pending_email).toBeNull();
    expect(afterRows[0].pending_email_token).toBeNull();
    expect(afterRows[0].pending_email_expires_at).toBeNull();
  });
});

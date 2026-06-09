/**
 * UI-SETTINGS-ORCID-FACTOR-E2E — the ORCID-factor settings critical-action
 * round-trip, end-to-end against the test-mode stack.
 *
 * The settings-action fresh-auth flow (ui-settings-action-fresh-auth-proof-challenge)
 * wired two factors: PASSWORD and ORCID. settings.spec.js already drives the
 * PASSWORD factor (change-email reauth modal) against the real backend. This
 * spec covers the ORCID factor for `set_password` — the ONLY factor for a
 * passwordless (State-C) account, which has no password to base a proof on.
 *
 * The seam the unit tests (lib-settings-fresh-auth.test.js,
 * lib-fresh-auth-settings-orcid.test.js) mock out is the frontend ORCID
 * round-trip:
 *   begin -> /orcid/start?mode=fresh_auth&action=set_password -> (ORCID) ->
 *   /orcid/callback (orcid-callback.js _handleFreshAuth) -> consent-op cache
 *   keyed (set_password, <username>, '') -> settings re-submit consumes the
 *   cached proof in POST /api/settings/set-password.
 * A regression in the callback dispatch on `pevo_orcid_mode === 'fresh_auth'`,
 * or in the cache-key shape, would ship green without this E2E. These tests
 * drive the REAL orcid-callback.js page and the REAL settings page (not unit
 * mocks) to exercise that seam.
 *
 * Mocking justification (project-CLAUDE.md "Carve-out for deterministic
 * edge-case coverage", clause a): the REAL `/api/orcid/callback` performs a
 * live OAuth token exchange against `config.orcidBaseUrl/oauth/token`. ORCID is
 * unconfigured in the local stack (empty ORCID_CLIENT_ID; no ORCID keys in
 * frontend/.env.test) and the E2E harness ships NO stub ORCID OAuth provider,
 * so a real ORCID-minted fresh-auth proof cannot be produced in E2E. We
 * therefore network-stub the backend `/api/orcid/callback` POST to return a
 * fresh_auth proof shape and stub `/api/settings/set-password` to capture the
 * resumed request body. This mirrors how every existing ORCID E2E spec works
 * (orcid-link.spec.js, orcid-no-password.spec.js both stub the callback and
 * `test.fixme` their real-backend ORCID assertions).
 *
 * Auth-focus carve-out (clause b): none of these tests assert cryptographic
 * verification of the proof. They assert the FRONTEND dispatch + cache-key
 * round-trip and that the cached proof rides into the action request. The real
 * backend proof verification (the action succeeding with a genuine proof) is
 * the clause-c real-path companion that CANNOT run until a stub ORCID OAuth
 * provider is added to the harness; it is captured in the `test.fixme` at the
 * bottom of this file. Real `GET /api/settings/email` runs unstubbed (it is the
 * State-C `hasPassword:false` discriminator), as does the seeded account row.
 */

import { test, expect } from './fixtures/keychain.js';
import { mintSessionJwt } from './fixtures/auth.js';
import { openAppPool } from './fixtures/db.js';

// Specs in this file mint live backend-valid bearer JWTs via mintSessionJwt.
// Disable trace/video/screenshot to keep those tokens out of trace.zip
// artifacts (the global default `trace: 'retain-on-failure'` would persist them).
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

// Far-future ISO-8601 so getCachedConsentOpProof's TTL check treats the stubbed
// proof as live (the parent task pins the ISO-string shape, not an epoch int).
const STUB_EXPIRES_AT = '2099-01-01T00:00:00.000Z';
const STUB_PROOF = 'stub-fresh-auth-proof-orcid-factor';
const NEW_PASSWORD = 'OrcidFactorPass1';
const CONSENT_OP_KEY = 'pevo_fresh_auth_consent_op_proof';

// Populated in beforeAll from (Date.now, testInfo.retry). Playwright re-runs
// beforeAll on retries but does NOT re-evaluate module scope, so deriving the
// identity strings there (with testInfo.retry) keeps retries off a colliding
// UNIQUE(email)/UNIQUE(username) row left by the failed attempt.
let RUN_SUFFIX;
let TEST_USERNAME;
let TEST_EMAIL;

async function seedStateCAccount(pool) {
  // State C: passwordless (password_hash NULL), light account, verify_token NULL
  // => active with a verified email. GET /api/settings/email then reports
  // hasPassword:false, so the SPA renders the "Set a password" section whose
  // only fresh-auth factor is ORCID. Mirrors settings.spec.js seedLightAccount,
  // minus the argon2 hash (the whole point is the null-hash State-C path).
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, full_name, institution, field, custody, verify_token)
     VALUES ($1, $2, NULL, $3, 'Test Institution', 'Test Science', 'light', NULL)
     ON CONFLICT (email) DO UPDATE SET
       username = EXCLUDED.username,
       password_hash = NULL,
       custody = 'light',
       verify_token = NULL,
       pending_email = NULL,
       pending_email_token = NULL,
       pending_email_expires_at = NULL`,
    [TEST_EMAIL, TEST_USERNAME, 'E2E ORCID-Factor Tester'],
  );
}

// Drop a light-custody session into localStorage before the app boots so the
// auth store treats the user as logged in (the Bearer path of
// verifyHiveSignature), matching settings.spec.js seedLightSession.
async function seedSession(page) {
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

test.describe('settings — ORCID-factor set_password (State C)', () => {
  let pool;

  test.beforeAll(async ({}, testInfo) => {
    RUN_SUFFIX = `${Date.now().toString(36).slice(-6)}r${testInfo.retry}`;
    TEST_USERNAME = `e2e-orcidfactor-${RUN_SUFFIX}`;
    TEST_EMAIL = `e2e+orcidfactor-${RUN_SUFFIX}@pevo.test`;
    pool = openAppPool();
    await seedStateCAccount(pool);
  });

  test.afterAll(async () => {
    if (pool) await pool.end();
  });

  test('set_password on a passwordless account starts the ORCID fresh_auth flow with the right /start request', async ({ page }) => {
    page.on('dialog', (dialog) => {
      throw new Error(`Unexpected dialog: ${dialog.type()} "${dialog.message()}"`);
    });

    await seedSession(page);
    await page.context().clearCookies();

    // Error-stub /api/orcid/start so beginSettingsActionOrcidFreshAuth throws
    // before the off-origin window.location redirect fires (same technique as
    // orcid-no-password.spec.js). We only need the POST to have fired with the
    // correct shape; the redirect itself can't be followed without leaving the
    // app for real orcid.org.
    await page.route('**/api/orcid/start', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'error',
          error: { code: 'UNAVAILABLE', message: 'stubbed for test' },
        }),
      });
    });

    await page.goto('/settings');
    await page.waitForSelector('[x-data="settingsPage"]');

    // The State-C "Set a password" section renders only when the real
    // GET /api/settings/email returns hasPassword:false.
    const section = page.getByTestId('set-password-section');
    await expect(section).toBeVisible();

    await page.getByTestId('set-password-input').fill(NEW_PASSWORD);
    await page.getByTestId('set-password-confirm-input').fill(NEW_PASSWORD);

    const startRequestPromise = page.waitForRequest(
      (req) => req.url().endsWith('/api/orcid/start') && req.method() === 'POST',
    );
    await page.getByTestId('set-password-submit').click();
    const startReq = await startRequestPromise;

    // set_password routes through the ORCID factor: the /start request carries
    // mode=fresh_auth + action=set_password and rides the session bearer
    // (startOrcid uses authenticatedRequest for fresh_auth).
    expect(startReq.postDataJSON()).toEqual({ mode: 'fresh_auth', action: 'set_password' });
    expect(startReq.headers().authorization).toMatch(/^Bearer /);
  });

  test('the fresh_auth callback caches the proof under (set_password, username, "") and the re-submit sends it', async ({ page }) => {
    page.on('dialog', (dialog) => {
      throw new Error(`Unexpected dialog: ${dialog.type()} "${dialog.message()}"`);
    });

    await seedSession(page);
    await page.context().clearCookies();

    // Simulate the state beginSettingsActionOrcidFreshAuth wrote just before it
    // redirected to ORCID: the per-tab fresh_auth mode marker and the return
    // path. The real callback page reads both. (sessionStorage, per-tab — see
    // mintNonConsentProof's cross-tab rationale.)
    await page.addInitScript(() => {
      window.sessionStorage.setItem('pevo_orcid_mode', 'fresh_auth');
      window.sessionStorage.setItem('pevo_fresh_auth_return_to', '/settings');
    });

    // Stub the backend callback to return the fresh_auth proof shape the real
    // OAuth exchange would yield. The echoed target triple is what _handleFreshAuth
    // caches against; for a settings action it is (action, <username>, '').
    await page.route('**/api/orcid/callback', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          data: {
            mode: 'fresh_auth',
            action: 'set_password',
            root_author: TEST_USERNAME,
            root_permlink: '',
            fresh_auth_proof: STUB_PROOF,
            expires_at: STUB_EXPIRES_AT,
          },
        }),
      });
    });

    // Capture the resumed set-password request. Return 200 (the real backend
    // would reject the stub proof — that real verification is the test.fixme
    // below); the assertion is that the CACHED proof rides into the body.
    let capturedSetPassword = null;
    await page.route('**/api/settings/set-password', async (route) => {
      capturedSetPassword = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', data: {} }),
      });
    });

    // Drive the REAL callback page. orcid-callback.js dispatches on the
    // fresh_auth mode marker -> _handleFreshAuth -> cacheConsentOpProof ->
    // navigate(returnPath).
    await page.goto('/orcid/callback?code=stub-code&state=stub-state');

    // _handleFreshAuth navigates back to the return path on success.
    await page.waitForURL('**/settings');
    await page.waitForSelector('[x-data="settingsPage"]');

    // The consent-op cache holds the proof bound to the exact target triple the
    // settings resume looks up: (set_password, <username>, ''). A regression in
    // the callback dispatch or the cache-key shape fails here.
    const cached = await page.evaluate((key) => window.sessionStorage.getItem(key), CONSENT_OP_KEY);
    expect(cached).toBeTruthy();
    expect(JSON.parse(cached)).toEqual({
      token: STUB_PROOF,
      expiresAt: STUB_EXPIRES_AT,
      action: 'set_password',
      rootAuthor: TEST_USERNAME,
      rootPermlink: '',
    });

    // Re-submit set-password. withSettingsFreshAuth finds the cached proof
    // (getCachedConsentOpProof('set_password', username, '')) and threads it
    // into setPassword(password, proof) instead of starting another redirect.
    const section = page.getByTestId('set-password-section');
    await expect(section).toBeVisible();
    await page.getByTestId('set-password-input').fill(NEW_PASSWORD);
    await page.getByTestId('set-password-confirm-input').fill(NEW_PASSWORD);

    const setPwRequestPromise = page.waitForRequest(
      (req) => req.url().endsWith('/api/settings/set-password') && req.method() === 'POST',
    );
    await page.getByTestId('set-password-submit').click();
    await setPwRequestPromise;

    // The cached ORCID-factor proof rode into the action request body.
    expect(capturedSetPassword).toMatchObject({
      password: NEW_PASSWORD,
      fresh_auth_proof: STUB_PROOF,
    });
  });
});

/**
 * Real-backend round-trip. CANNOT run until the E2E harness ships a stub ORCID
 * OAuth provider: the real `/api/orcid/callback` does a live token exchange
 * against `config.orcidBaseUrl/oauth/token`, ORCID is unconfigured locally
 * (empty ORCID_CLIENT_ID, no keys in frontend/.env.test), and there is no mock
 * provider in global-setup or the test compose override. Un-fixme once a stub
 * ORCID provider exists so the real backend mints a genuine fresh-auth proof and
 * `/api/settings/set-password` accepts it (password_hash populated, login with
 * the new password succeeds, and the "Set a password" section stops rendering).
 */
test.fixme(
  'ORCID-factor set_password succeeds end-to-end with a real backend-minted proof (needs a stub ORCID OAuth provider)',
  async () => {
    // 1. Seed a State-C (null password_hash) ORCID-linked account + session.
    // 2. Drive /settings set-password -> real /orcid/start -> stub ORCID provider
    //    issues a code -> real /orcid/callback mints a real fresh_auth proof bound
    //    to (set_password, username, '') and caches it.
    // 3. Re-submit set-password -> real /api/settings/set-password accepts the
    //    proof -> 200, accounts.password_hash populated.
    // 4. Log in with email + NEW_PASSWORD -> 200; the set-password section no
    //    longer renders.
  },
);

/**
 * UI-SETTINGS-ORCID-FACTOR-E2E — the ORCID-factor settings critical-action
 * round-trip, end-to-end against the test-mode stack.
 *
 * The settings-action fresh-auth flow (the `withSettingsFreshAuth` wrapper in
 * settings-fresh-auth.js) wires two factors: PASSWORD and ORCID. settings.spec.js
 * already drives the
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
 * edge-case coverage", clause a): the first two tests network-stub the backend
 * `/api/orcid/callback` POST (to return a fresh_auth proof shape) and
 * `/api/settings/set-password` (to capture the resumed request body) so the
 * FRONTEND dispatch + cache-key seam is asserted deterministically, independent
 * of backend proof verification. The clause-c real-path companion is the third
 * test in this file: it removes both stubs and drives the whole flow against the
 * real test stack — the orcid-stub OAuth sidecar in docker-compose.test.override.yml
 * lets the real `/api/orcid/callback` complete a genuine token exchange
 * in-network — so a real backend-minted proof is produced and consumed
 * end-to-end.
 *
 * Auth-focus carve-out (clause b): the first two tests do not assert
 * cryptographic verification of the proof — they assert the FRONTEND dispatch +
 * cache-key round-trip and that the cached proof rides into the action request.
 * The real backend proof verification (the action succeeding with a genuine
 * proof) is the clause-c real-path companion: the third test below, which mints
 * and consumes a real proof end-to-end. Real `GET /api/settings/email` runs
 * unstubbed in all three (it is the State-C `hasPassword:false` discriminator),
 * as does the seeded account row.
 */

import { test, expect } from './fixtures/keychain.js';
import { mintSessionJwt } from './fixtures/auth.js';
import { openAppPool } from './fixtures/db.js';

// Specs in this file mint live backend-valid bearer JWTs via mintSessionJwt.
// Disable trace/video/screenshot to keep those tokens out of trace.zip
// artifacts (the global default `trace: 'retain-on-failure'` would persist them).
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

// Far-future ISO-8601 so getCachedConsentOpProof's TTL check treats the stubbed
// proof as live. cacheConsentOpProof stores expiresAt as an ISO-8601 string and
// getCachedConsentOpProof parses it with new Date() for the TTL check, so the
// stub must be an ISO string, not an epoch int.
const STUB_EXPIRES_AT = '2099-01-01T00:00:00.000Z';
const STUB_PROOF = 'stub-fresh-auth-proof-orcid-factor';
const NEW_PASSWORD = 'OrcidFactorPass1';
const CONSENT_OP_KEY = 'pevo_fresh_auth_consent_op_proof';

// Populated in beforeAll from (Date.now, testInfo.retry). Playwright re-runs
// beforeAll on retries but does NOT re-evaluate module scope, so deriving the
// identity strings there (with testInfo.retry) keeps retries off a colliding
// UNIQUE(email)/UNIQUE(username)/partial-UNIQUE(orcid) row left by a failed attempt.
let RUN_SUFFIX;
let TEST_USERNAME;
let TEST_EMAIL;
let TEST_ORCID;

// Identifiers for the registered-factor-mismatch describe (§6.5 invariant #2).
// Separate from the happy-path account: that account is mutated to State B by
// the real set_password, while this one must stay State C for the 403 path.
let NEG_USERNAME;
let NEG_EMAIL;
let NEG_ORCID;

async function seedStateCAccount(pool, ids = {}) {
  // State C: passwordless (password_hash NULL) + orcid SET, light account,
  // verify_token NULL => active with a verified email and ORCID as its ONLY
  // registered re-auth factor. GET /api/settings/email then reports
  // hasPassword:false, so the SPA renders the "Set a password" section whose only
  // fresh-auth factor is ORCID. orcid MUST be set: a row with both password_hash
  // NULL and orcid NULL is no enumerated state (no registered factor), and the
  // real set-password route 403s ORCID_REQUIRED before the proof gate. Mirrors
  // settings.spec.js seedLightAccount minus the argon2 hash (the null-hash
  // State-C path is the whole point). `ids` defaults to the happy-path describe's
  // module identifiers; the mismatch describe passes its own so the two never
  // share a row (each seeds + mutates an isolated account).
  const email = ids.email ?? TEST_EMAIL;
  const username = ids.username ?? TEST_USERNAME;
  const orcid = ids.orcid ?? TEST_ORCID;
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, orcid, full_name, institution, field, custody, verify_token)
     VALUES ($1, $2, NULL, $3, $4, 'Test Institution', 'Test Science', 'light', NULL)
     ON CONFLICT (email) DO UPDATE SET
       username = EXCLUDED.username,
       password_hash = NULL,
       orcid = EXCLUDED.orcid,
       custody = 'light',
       verify_token = NULL,
       pending_email = NULL,
       pending_email_token = NULL,
       pending_email_expires_at = NULL`,
    [email, username, orcid, 'E2E ORCID-Factor Tester'],
  );
}

// Drop a light-custody session into localStorage before the app boots so the
// auth store treats the user as logged in (the Bearer path of
// verifyHiveSignature), matching settings.spec.js seedLightSession.
async function seedSession(page, username = TEST_USERNAME) {
  const { token, expiresAt } = mintSessionJwt(username, { custody: 'light' });
  const session = {
    token,
    username,
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
    const now = Date.now();
    RUN_SUFFIX = `${now.toString(36).slice(-6)}r${testInfo.retry}`;
    TEST_USERNAME = `e2e-orcidfactor-${RUN_SUFFIX}`;
    TEST_EMAIL = `e2e+orcidfactor-${RUN_SUFFIX}@pevo.test`;
    // Synthetic 16-digit ORCID iD in the standard 4-4-4-4 grouping. State C
    // requires orcid SET; accounts.orcid carries a partial UNIQUE index
    // (WHERE orcid IS NOT NULL) and every run/retry inserts a fresh row, so the
    // iD must be per-run-unique like email/username or a second run collides on
    // the index. Derived from (now, retry); the value is opaque (no checksum
    // validation on the column) and never sent through a real ORCID exchange.
    const orcidDigits = `${now}${testInfo.retry}`.padStart(16, '0').slice(-16);
    TEST_ORCID = orcidDigits.replace(/(\d{4})(\d{4})(\d{4})(\d{4})/, '$1-$2-$3-$4');
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

  // Real-backend round-trip. The two tests above stub the backend callback +
  // set-password to assert the FRONTEND dispatch + cache-key seam deterministically.
  // This one removes both stubs and drives the whole flow against the real test
  // stack so a genuine backend-minted proof is produced and consumed: real
  // /orcid/start -> in-page authorize fulfil -> real /orcid/callback (real proof)
  // -> real /api/settings/set-password (proof accepted, password_hash populated).
  // Requires the orcid-stub OAuth sidecar from docker-compose.test.override.yml
  // (ORCID_BASE_URL=http://orcid-stub:8099 on the backend) so the real callback's
  // token exchange resolves in-network.
  test('ORCID-factor set_password succeeds end-to-end with a real backend-minted proof', async ({ page, baseURL }) => {
    page.on('dialog', (dialog) => {
      throw new Error(`Unexpected dialog: ${dialog.type()} "${dialog.message()}"`);
    });

    await seedSession(page);
    await page.context().clearCookies();

    // Bridge the SPA open-redirect guard. The real /api/orcid/start builds
    // redirect_url from config.orcidBaseUrl, which the test stack points at the
    // in-network stub (http://orcid-stub:8099). beginSettingsActionOrcidFreshAuth
    // validates the redirect host against the ORCID_REDIRECT_HOSTS allowlist
    // (orcid.org / sandbox.orcid.org) before navigating, so an orcid-stub host
    // throws before the browser ever leaves the app. Pass /start through to the
    // REAL backend (it allocates the real Redis state), then rewrite ONLY the
    // redirect_url host to orcid.org so the guard passes and the authorize
    // navigation actually fires. The real `state` rides through untouched.
    await page.route('**/api/orcid/start', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const real = new URL(body.data.redirect_url);
      body.data.redirect_url = `https://orcid.org${real.pathname}${real.search}`;
      await route.fulfill({
        status: response.status(),
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

    // In-page fulfil of the ORCID authorize hop. No browser can reach the
    // compose-internal stub, and the stub serves no /oauth/authorize endpoint by
    // design. Intercept the authorize navigation, read the real `state` the
    // backend stored in Redis, and 302 the browser to the real /orcid/callback
    // with code=<seeded ORCID iD>. The backend then exchanges that code against
    // the stub's /oauth/token, which reflects it straight back as the `orcid`
    // field (matching accounts.orcid for this run), so handleFreshAuth mints a
    // genuine target-bound proof.
    await page.route('**/oauth/authorize*', async (route) => {
      const state = new URL(route.request().url()).searchParams.get('state');
      await route.fulfill({
        status: 302,
        headers: { location: `${baseURL}/orcid/callback?code=${TEST_ORCID}&state=${state}` },
      });
    });

    // /api/orcid/callback and /api/settings/set-password are NOT stubbed here:
    // both run against the real backend so the real proof is minted and consumed.

    await page.goto('/settings');
    await page.waitForSelector('[x-data="settingsPage"]');
    await expect(page.getByTestId('set-password-section')).toBeVisible();

    // First submit: no cached proof, so the set_password ORCID factor starts the
    // real round-trip (real /start -> authorize fulfil -> real /orcid/callback,
    // which mints + caches the proof and navigates back to /settings).
    await page.getByTestId('set-password-input').fill(NEW_PASSWORD);
    await page.getByTestId('set-password-confirm-input').fill(NEW_PASSWORD);

    const callbackResponse = page.waitForResponse(
      (resp) => resp.url().endsWith('/api/orcid/callback') && resp.request().method() === 'POST',
    );
    await page.getByTestId('set-password-submit').click();
    const cbResp = await callbackResponse;
    expect(cbResp.status()).toBe(200);

    // _handleFreshAuth caches the real proof and navigates back to /settings.
    await page.waitForURL('**/settings');
    await page.waitForSelector('[x-data="settingsPage"]');

    // The consent-op cache now holds a REAL backend-minted proof bound to
    // (set_password, username, '') — not the stubbed token of the tests above.
    const cached = await page.evaluate((key) => window.sessionStorage.getItem(key), CONSENT_OP_KEY);
    expect(cached).toBeTruthy();
    const parsedCache = JSON.parse(cached);
    expect(parsedCache).toMatchObject({
      action: 'set_password',
      rootAuthor: TEST_USERNAME,
      rootPermlink: '',
    });
    expect(typeof parsedCache.token).toBe('string');
    expect(parsedCache.token.length).toBeGreaterThan(0);

    // Second submit: withSettingsFreshAuth finds the cached proof and threads it
    // into the REAL POST /api/settings/set-password (no second redirect).
    await expect(page.getByTestId('set-password-section')).toBeVisible();
    await page.getByTestId('set-password-input').fill(NEW_PASSWORD);
    await page.getByTestId('set-password-confirm-input').fill(NEW_PASSWORD);

    const setPwResponse = page.waitForResponse(
      (resp) => resp.url().endsWith('/api/settings/set-password') && resp.request().method() === 'POST',
    );
    await page.getByTestId('set-password-submit').click();
    const setPwResp = await setPwResponse;
    expect(setPwResp.status()).toBe(200);

    // The real backend persisted the password hash: State C (passwordless) ->
    // State B (password + ORCID). This is the proof the whole round-trip exists
    // to produce.
    const row = await pool.query(
      'SELECT password_hash FROM accounts WHERE username = $1',
      [TEST_USERNAME],
    );
    expect(row.rows[0]?.password_hash).toBeTruthy();

    // The "Set a password" section stops rendering after a reload: GET
    // /api/settings/email now reports hasPassword:true.
    await page.reload();
    await page.waitForSelector('[x-data="settingsPage"]');
    await expect(page.getByTestId('set-password-section')).toBeHidden();

    // Password login with the new password now succeeds (State B account).
    const loginResp = await page.request.post('/api/auth/login', {
      data: { email_or_username: TEST_EMAIL, password: NEW_PASSWORD },
    });
    expect(loginResp.status()).toBe(200);
  });
});

// §6.5 invariant #2 (registered-factor equality). The happy-path test above
// cannot catch a regression that trusts the stub-reflected ORCID iD without
// comparing it to accounts.orcid: because the stub reflects the submitted `code`
// straight back as the token `orcid`, a happy-path run where code == seeded iD
// passes whether or not the backend checks the equality. Only a MISMATCH case
// (seed iD A, drive code B != A) actually exercises handleFreshAuth's
// `accountOrcid !== orcidId -> 403`. Isolated describe + account: the happy-path
// account is mutated to State B by its real set_password, while this one must
// stay State C for the 403 path.
test.describe('settings — ORCID-factor set_password registered-factor mismatch (State C)', () => {
  let pool;

  test.beforeAll(async ({}, testInfo) => {
    const now = Date.now();
    const suffix = `${now.toString(36).slice(-6)}r${testInfo.retry}`;
    NEG_USERNAME = `e2e-orcidneg-${suffix}`;
    NEG_EMAIL = `e2e+orcidneg-${suffix}@pevo.test`;
    // Seeded iD A. Same partial-UNIQUE(orcid) constraint as the happy-path
    // account, so it must be per-run-unique. The leading '1' keeps it clear of
    // both the happy-path derivation and the fixed mismatch iD B below.
    const orcidDigits = `1${now}${testInfo.retry}`.padStart(16, '0').slice(-16);
    NEG_ORCID = orcidDigits.replace(/(\d{4})(\d{4})(\d{4})(\d{4})/, '$1-$2-$3-$4');
    pool = openAppPool();
    await seedStateCAccount(pool, { email: NEG_EMAIL, username: NEG_USERNAME, orcid: NEG_ORCID });
  });

  test.afterAll(async () => {
    if (pool) await pool.end();
  });

  test('a callback ORCID iD that does not match accounts.orcid is rejected 403 and mints no proof', async ({ page, baseURL }) => {
    page.on('dialog', (dialog) => {
      throw new Error(`Unexpected dialog: ${dialog.type()} "${dialog.message()}"`);
    });

    // Mismatch iD B that the stub reflects back as the callback `orcid`. MUST be
    // ORCID-iD format so it clears the ORCID_RE gate and reaches the equality
    // check (a malformed value 400s at the format gate and would pass this test
    // for the wrong reason), and MUST differ from the seeded NEG_ORCID (A) so the
    // equality fails. 0000-0002-1825-0097 is a canonical valid-format test iD.
    const MISMATCH_ORCID = '0000-0002-1825-0097';
    expect(MISMATCH_ORCID).not.toBe(NEG_ORCID);

    await seedSession(page, NEG_USERNAME);
    await page.context().clearCookies();

    // Same redirect-host bridge as the happy-path test: pass /start through to the
    // real backend (real Redis state), rewrite only the redirect_url host to
    // orcid.org so the SPA open-redirect guard passes and the authorize hop fires.
    await page.route('**/api/orcid/start', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const real = new URL(body.data.redirect_url);
      body.data.redirect_url = `https://orcid.org${real.pathname}${real.search}`;
      await route.fulfill({
        status: response.status(),
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

    // Fulfil the authorize hop with code = B. The backend exchanges it against the
    // stub, which reflects B back as `orcid`; B clears ORCID_RE but != accounts.orcid
    // (A), so handleFreshAuth returns 403 and mints nothing.
    await page.route('**/oauth/authorize*', async (route) => {
      const state = new URL(route.request().url()).searchParams.get('state');
      await route.fulfill({
        status: 302,
        headers: { location: `${baseURL}/orcid/callback?code=${MISMATCH_ORCID}&state=${state}` },
      });
    });

    await page.goto('/settings');
    await page.waitForSelector('[x-data="settingsPage"]');
    await expect(page.getByTestId('set-password-section')).toBeVisible();

    await page.getByTestId('set-password-input').fill(NEW_PASSWORD);
    await page.getByTestId('set-password-confirm-input').fill(NEW_PASSWORD);

    const callbackResponse = page.waitForResponse(
      (resp) => resp.url().endsWith('/api/orcid/callback') && resp.request().method() === 'POST',
    );
    await page.getByTestId('set-password-submit').click();
    const cbResp = await callbackResponse;

    // The registered-factor equality check rejects an OAuth round-trip for an iD
    // not bound to the account.
    expect(cbResp.status()).toBe(403);
    const cbBody = await cbResp.json();
    expect(cbBody?.error?.code).toBe('FORBIDDEN');

    // No proof was minted: the consent-op cache stays empty and the action never
    // completes (password_hash remains NULL).
    const cached = await page.evaluate((key) => window.sessionStorage.getItem(key), CONSENT_OP_KEY);
    expect(cached).toBeNull();

    const row = await pool.query(
      'SELECT password_hash FROM accounts WHERE username = $1',
      [NEG_USERNAME],
    );
    expect(row.rows[0]?.password_hash).toBeNull();
  });
});


/**
 * Password never persists across the ORCID round-trip.
 *
 * This spec locks in the UI contract that no password key is ever written
 * to the draft keys in localStorage (`pevo_signup_draft`,
 * `pevo_recover_draft`) when the user clicks "Verify with ORCID", and that
 * the ORCID-branch submit calls `/api/auth/signup` and `/api/auth/recover`
 * with `password: null` / `new_password: null` respectively.
 *
 * The ORCID round-trip itself is simulated in-test: we populate the
 * post-callback state (`pevo_signup_orcid_token`, `pevo_signup_orcid_id`)
 * directly in localStorage so the page enters the "ORCID verified" UI
 * state without a real ORCID OAuth handshake. This is the same approach
 * taken by `orcid-link.spec.js` and keeps the assertion deterministic
 * regardless of the backend's own auth state.
 *
 * Two real-backend assertions at the bottom drive the ORCID *signup* and
 * *recovery* null-password round-trips end-to-end against the test stack. Both
 * exercise ORCID signup mode, whose backend handler gates on a works count
 * fetched from <ORCID_API_BASE_URL>/v3.0/<orcidId>/works. The test stack points
 * that fetch at the in-network orcid-works-stub sidecar (which serves five
 * externally-sourced works, clearing ORCID_MIN_WORKS), so the works gate is now
 * satisfiable in-network alongside the orcid-stub OAuth token exchange. Those two
 * tests removed their former `test.fixme` skips. The set-password real round-trip
 * this header previously listed is driven by the set_password round-trip test in
 * settings-orcid-factor.spec.js (against the orcid-stub) and is not duplicated
 * here. See the docblock above the real round-trip describe for the full
 * rationale.
 */

import { test, expect } from './fixtures/keychain.js';
import { openAppPool } from './fixtures/db.js';
import { routeOrcidStubBridge } from './fixtures/orcid.js';

// File-level (Playwright forbids screenshot/video/trace overrides inside a
// describe group — they force a new worker). The real-backend round-trips at the
// bottom of this file exercise real backend JWTs (signup auth_token,
// recover/login session tokens) that ride in responses; disabling
// trace/video/screenshot keeps those tokens out of trace.zip artifacts (the
// global `trace: 'retain-on-failure'` default would otherwise persist them on a
// failing run). Parity with settings-orcid-factor.spec.js. The stubbed tests
// above forgo failure traces as a result; they stub every backend hop and assert
// deterministically, so the loss is minor.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const STUB_ORCID_TOKEN = 'stub-orcid-nonce-abc';
const STUB_ORCID_ID = '0000-0001-0000-0001';

test.describe('signup — ORCID branch never persists password', () => {
  test('clicking "Verify with ORCID" stores a draft with no password fields', async ({
    page,
  }) => {
    // Stub /api/orcid/start with an error so the frontend's handleOrcidVerify
    // catches and stays on-page. We only need the POST to fire (proves the
    // flow reached the redirect step) and localStorage.setItem for the draft
    // already ran synchronously before the await. A 200 response with a real
    // redirect_url would navigate the page off-origin and destroy the
    // evaluate context before we could read the draft.
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

    await page.goto('/signup');

    // Fill the form like a user about to verify.
    await page.locator('input[x-model="email"]').fill('sec004-ui@pevo.test');
    await page.locator('input[x-model="fullName"]').fill('SEC-004 Tester');
    await page.locator('input[x-model="institution"]').fill('Test Institution');
    await page.locator('input[x-model="field"]').fill('Test Science');
    // Critical: fill the password field too. The draft written across the
    // ORCID round-trip must not contain it — the password must never be
    // persisted into localStorage on the ORCID branch.
    await page.locator('input[x-model="password"]').fill('LeakedHunter1X');
    await page.locator('input[x-model="passwordConfirm"]').fill('LeakedHunter1X');

    // The "Verify with ORCID" button is the small per-field one, not the
    // big divider button. Use @click binding to select it.
    const verifyButton = page.locator('button[\\@click="handleOrcidVerify()"]');
    await expect(verifyButton).toBeVisible();

    // Before redirect fires, capture the localStorage write.
    const [startRequest] = await Promise.all([
      page.waitForRequest(
        (req) =>
          req.url().endsWith('/api/orcid/start') && req.method() === 'POST',
      ),
      verifyButton.click(),
    ]);
    expect(startRequest.postDataJSON()).toEqual({ mode: 'signup' });

    // The draft is written synchronously at the top of handleOrcidVerify
    // before the startOrcid await, so it is already in localStorage by now.
    const draft = await page.evaluate(
      () => window.localStorage.getItem('pevo_signup_draft'),
    );
    expect(draft).toBeTruthy();
    const parsed = JSON.parse(draft);

    // Non-sensitive fields present in the draft.
    expect(parsed).toMatchObject({
      email: 'sec004-ui@pevo.test',
      fullName: 'SEC-004 Tester',
      institution: 'Test Institution',
      field: 'Test Science',
    });
    // Password MUST NOT be in the draft.
    expect(parsed).not.toHaveProperty('password');
    expect(parsed).not.toHaveProperty('passwordConfirm');
  });

  test('on return from ORCID, password field is hidden and submit sends password: null', async ({
    page,
  }) => {
    // Simulate the state the page sees after the ORCID callback:
    //   - Draft saved by handleOrcidVerify (no password fields).
    //   - Orcid token/id handed off by orcid-callback.js.
    await page.addInitScript(
      ({ token, id }) => {
        window.localStorage.setItem(
          'pevo_signup_draft',
          JSON.stringify({
            email: 'sec004-ui@pevo.test',
            fullName: 'SEC-004 Tester',
            institution: 'Test Institution',
            field: 'Test Science',
          }),
        );
        window.localStorage.setItem('pevo_signup_orcid_token', token);
        window.localStorage.setItem('pevo_signup_orcid_id', id);
      },
      { token: STUB_ORCID_TOKEN, id: STUB_ORCID_ID },
    );

    // Stub /api/auth/signup so the submit is deterministic regardless of
    // the backend's own auth state. The real-backend 200 path is covered by
    // the real-backend ORCID null-password round-trips at the bottom of this
    // file.
    let capturedSignup = null;
    await page.route('**/api/auth/signup', async (route) => {
      capturedSignup = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', data: {} }),
      });
    });

    await page.goto('/signup');

    // The ORCID-verified badge should be visible.
    await expect(page.getByText(STUB_ORCID_ID)).toBeVisible();

    // Password fields should be hidden on the ORCID branch.
    // x-show="!orcidToken" resolves to display:none once orcidToken is set.
    const passwordField = page.locator('input[x-model="password"]');
    await expect(passwordField).toBeHidden();
    const confirmField = page.locator('input[x-model="passwordConfirm"]');
    await expect(confirmField).toBeHidden();

    // Submit the form. canSubmit is truthy on the ORCID branch even with
    // empty password fields.
    const signupResponsePromise = page.waitForResponse(
      (resp) => resp.url().endsWith('/api/auth/signup'),
    );
    // Scope to the page root: the global reauth modal (index.html) also renders a
    // form with a submit button, so a bare `form button[type="submit"]` is
    // ambiguous under Playwright strict mode.
    await page.locator('[x-data="signupPage"] form button[type="submit"]').click();
    await signupResponsePromise;

    // The submit sent password: null alongside the ORCID token.
    expect(capturedSignup).toEqual({
      email: 'sec004-ui@pevo.test',
      password: null,
      full_name: 'SEC-004 Tester',
      institution: 'Test Institution',
      field: 'Test Science',
      orcid_token: STUB_ORCID_TOKEN,
    });
  });

  test('on ORCID branch, the "Resend verification" button is NOT visible after submit', async ({
    page,
  }) => {
    // Defense-in-depth template-level assertion. The handler body is
    // already guarded (handleResendVerification early-returns when
    // orcidToken is set, unit-tested in pages-signup.test.js); this
    // asserts the x-show="!resendSuccess && !orcidToken" hide on the
    // button itself, since a template regression would not be caught
    // by the handler-level guard.
    //
    // Drive signup to submitted: true with orcidToken set by seeding
    // localStorage (as above) and then stubbing /api/auth/signup so we
    // can reach the success state without backend coupling.
    await page.addInitScript(
      ({ token, id }) => {
        window.localStorage.setItem(
          'pevo_signup_draft',
          JSON.stringify({
            email: 'sec004-ui@pevo.test',
            fullName: 'SEC-004 Tester',
            institution: 'Test Institution',
            field: 'Test Science',
          }),
        );
        window.localStorage.setItem('pevo_signup_orcid_token', token);
        window.localStorage.setItem('pevo_signup_orcid_id', id);
      },
      { token: STUB_ORCID_TOKEN, id: STUB_ORCID_ID },
    );

    await page.route('**/api/auth/signup', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', data: {} }),
      });
    });

    await page.goto('/signup');

    // Submit the form to flip to the submitted: true branch. Page-root-scoped to
    // avoid the global reauth modal's submit button (strict-mode ambiguity).
    await page.locator('[x-data="signupPage"] form button[type="submit"]').click();

    // The "Check your email" surface is now visible; assert the Resend
    // button is hidden on this branch.
    await expect(page.getByText(/check your email/i)).toBeVisible();
    await expect(
      page.getByRole('button', { name: /resend/i }),
    ).not.toBeVisible();
  });
});

test.describe('recover — ORCID branch never persists password', () => {
  test('clicking "Verify with ORCID" stores a draft with no password fields', async ({
    page,
  }) => {
    // Stub /api/accreditations/:username so the ORCID method tab shows up.
    await page.route(
      '**/api/accreditations/alice-sec004',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'ok',
            data: {
              username: 'alice-sec004',
              is_accredited: true,
              accreditation: { method: 'orcid' },
            },
          }),
        });
      },
    );
    // Error-stub /api/orcid/start to prevent navigation (see signup test above).
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

    await page.goto('/recover');

    await page.locator('input[x-model="username"]').fill('alice-sec004');

    // The method tab ("ORCID") and the "Verify with ORCID" submit button
    // both contain the text "ORCID", so a plain :has-text() matcher is
    // ambiguous under strict mode. Target the tab by its data-testid.
    const orcidTab = page.getByTestId('recover-method-orcid');
    await expect(orcidTab).toBeVisible({ timeout: 2000 });
    await orcidTab.click();

    await page.locator('input[x-model="newEmail"]').fill('new@pevo.test');
    // Fill the (now-visible-only-on-seed-method) password fields pre-switch
    // is impossible here since method is 'orcid'. But test the guard by
    // writing directly to Alpine's reactive state via the public evaluate
    // API. Poking _x_dataStack[0] reaches an Alpine internal and breaks
    // on minor version bumps; Alpine.evaluate is the stable equivalent.
    await page.evaluate(() => {
      // Populate password fields regardless of visibility. This mirrors
      // the regression scenario: even if something sets newPassword in
      // memory, it must NOT be persisted.
      const root = document.querySelector('[x-data="recoverPage"]');
      // Alpine is exposed globally by main.js.
      if (root && window.Alpine) {
        window.Alpine.evaluate(root, 'newPassword = "LeakedHunter1X"');
        window.Alpine.evaluate(root, 'newPasswordConfirm = "LeakedHunter1X"');
      }
    });

    const verifyButton = page.locator('button[\\@click="handleOrcidVerify()"]');
    await expect(verifyButton).toBeVisible();

    const [startRequest] = await Promise.all([
      page.waitForRequest(
        (req) =>
          req.url().endsWith('/api/orcid/start') && req.method() === 'POST',
      ),
      verifyButton.click(),
    ]);
    expect(startRequest.postDataJSON()).toEqual({ mode: 'signup' });

    const draft = await page.evaluate(
      () => window.localStorage.getItem('pevo_recover_draft'),
    );
    expect(draft).toBeTruthy();
    const parsed = JSON.parse(draft);

    expect(parsed).toMatchObject({
      username: 'alice-sec004',
      newEmail: 'new@pevo.test',
    });
    expect(parsed).not.toHaveProperty('newPassword');
    expect(parsed).not.toHaveProperty('newPasswordConfirm');
  });

  test('submit on ORCID method sends new_password: null', async ({ page }) => {
    // Simulate the post-ORCID state.
    await page.addInitScript(
      ({ token, id }) => {
        window.localStorage.setItem(
          'pevo_recover_draft',
          JSON.stringify({
            username: 'alice-sec004',
            newEmail: 'new@pevo.test',
          }),
        );
        window.localStorage.setItem('pevo_signup_orcid_token', token);
        window.localStorage.setItem('pevo_signup_orcid_id', id);
      },
      { token: STUB_ORCID_TOKEN, id: STUB_ORCID_ID },
    );

    let capturedRecover = null;
    await page.route('**/api/auth/recover', async (route) => {
      capturedRecover = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', data: {} }),
      });
    });

    await page.goto('/recover');

    // Password fields should be hidden on the ORCID method.
    const newPasswordField = page.locator('input[x-model="newPassword"]');
    await expect(newPasswordField).toBeHidden();

    const recoverResponsePromise = page.waitForResponse(
      (resp) => resp.url().endsWith('/api/auth/recover'),
    );
    // Page-root-scoped to avoid the global reauth modal's submit button
    // (strict-mode ambiguity).
    await page.locator('[x-data="recoverPage"] form button[type="submit"]').click();
    await recoverResponsePromise;

    expect(capturedRecover).toEqual({
      username: 'alice-sec004',
      orcid_token: STUB_ORCID_TOKEN,
      new_email: 'new@pevo.test',
      new_password: null,
    });
  });
});

/**
 * Real-backend ORCID null-password round-trips.
 *
 * The set-password real round-trip on a null-hash State-C account (real ORCID
 * fresh-auth proof -> real /api/settings/set-password -> password_hash
 * populated -> password login succeeds -> "Set a password" stops rendering) is
 * implemented as the third test in settings-orcid-factor.spec.js
 * ("ORCID-factor set_password succeeds end-to-end with a real backend-minted
 * proof"), which drives it against the orcid-stub OAuth sidecar. It is not
 * duplicated here.
 *
 * The two tests below drive the ORCID *signup* and *recovery* null-password
 * flows end-to-end against the real test stack. Both reach ORCID signup mode,
 * whose callback handler gates on a works count fetched from
 * <ORCID_API_BASE_URL>/v3.0/<orcidId>/works. The test stack points that fetch at
 * the in-network orcid-works-stub sidecar (five externally-sourced works clears
 * ORCID_MIN_WORKS), and the orcid-stub OAuth sidecar reflects the driven `code`
 * back as the bound ORCID iD, so the whole start -> authorize -> callback ->
 * action round-trip resolves in-network with a genuine backend-minted result.
 * The shared routeOrcidStubBridge fixture bridges the SPA open-redirect guard
 * and the in-network authorize hop (same mechanism settings-orcid-factor.spec.js
 * uses for the set_password round-trip).
 */
test.describe('real-backend ORCID null-password round-trips', () => {
  let pool;

  test.beforeAll(() => {
    pool = openAppPool();
  });

  test.afterAll(async () => {
    if (pool) await pool.end();
  });

  // Build a per-run-unique, ORCID_RE-valid iD (groups of 4-4-4-4 digits) from a
  // numeric seed. The orcid-stub reflects whatever `code` we drive straight back
  // as the bound ORCID iD, so this is the iD the account binds against. A
  // now-derived seed never collides with the orcid-works-stub's fixed
  // source-orcid constants (0000-0003-0000-000X), so every returned work counts
  // as external and the works gate clears. (Slice-built, not regex-formatted, so
  // the literal carries no backslash escapes.)
  function makeOrcid(seedDigits) {
    const s = seedDigits.padStart(16, '0').slice(-16);
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
  }

  test('ORCID signup with password: null creates an account with password_hash = NULL', async ({ page, baseURL }, testInfo) => {
    page.on('dialog', (dialog) => {
      throw new Error(`Unexpected dialog: ${dialog.type()} "${dialog.message()}"`);
    });

    const now = Date.now();
    const suffix = `${now.toString(36).slice(-6)}r${testInfo.retry}`;
    const email = `e2e+orcidsignup-${suffix}@pevo.test`;
    // Hive usernames cap at 16 chars (accounts.username + the recover field's
    // maxlength); keep the synthetic username short so nothing truncates it.
    const username = `sig${suffix}`;
    const orcid = makeOrcid(`${now}${testInfo.retry}`);

    await page.context().clearCookies();

    // Drive the authorize fulfil with code = orcid so the orcid-stub reflects it
    // back as the callback's bound ORCID iD (stored on the new account, and the
    // iD ORCID login later resolves the account by).
    await routeOrcidStubBridge(page, baseURL, orcid);

    await page.goto('/signup');
    await page.locator('input[x-model="email"]').fill(email);
    await page.locator('input[x-model="fullName"]').fill('E2E ORCID Signup');
    await page.locator('input[x-model="institution"]').fill('Test Institution');
    await page.locator('input[x-model="field"]').fill('Test Science');

    // "Verify with ORCID" runs the real round-trip: real /api/orcid/start ->
    // authorize fulfil -> real /api/orcid/callback (handleSignup clears the
    // works-stub gate and mints a verified-ORCID nonce) -> orcid-callback page
    // stores the nonce and navigates back to /signup.
    const callbackResponse = page.waitForResponse(
      (resp) => resp.url().endsWith('/api/orcid/callback') && resp.request().method() === 'POST',
    );
    await page.locator('button[\\@click="handleOrcidVerify()"]').click();
    expect((await callbackResponse).status()).toBe(200);

    // Back on /signup with the verified ORCID iD shown; password fields hidden.
    await page.waitForSelector('[x-data="signupPage"]');
    await expect(page.getByText(orcid)).toBeVisible();
    await expect(page.locator('input[x-model="password"]')).toBeHidden();

    // Submit: real POST /api/auth/signup with password: null.
    const signupResponse = page.waitForResponse(
      (resp) => resp.url().endsWith('/api/auth/signup') && resp.request().method() === 'POST',
    );
    await page.locator('[x-data="signupPage"] form button[type="submit"]').click();
    expect((await signupResponse).status()).toBe(200);

    // The real backend created the account with no password hash (ORCID signups
    // skip email verification and land in confirmed state; the user can set a
    // password later from Settings).
    const created = await pool.query(
      'SELECT password_hash, orcid FROM accounts WHERE email = $1',
      [email],
    );
    expect(created.rows.length).toBe(1);
    expect(created.rows[0].password_hash).toBeNull();
    expect(created.rows[0].orcid).toBe(orcid);

    // Password login on the null-hash account is refused with NO_PASSWORD_SET
    // (the login handler returns it before any email-verification check).
    const pwLogin = await page.request.post('/api/auth/login', {
      data: { email_or_username: email, password: 'NotMyPassword1X' },
    });
    expect(pwLogin.status()).toBe(403);
    expect((await pwLogin.json())?.error?.code).toBe('NO_PASSWORD_SET');

    // ORCID login resolves accounts by `orcid` only when the Hive account exists
    // (handleLogin: WHERE orcid = $1 AND username IS NOT NULL). The signup POST
    // above leaves username NULL — it is set by the account-type-choice /
    // Hive-account-creation step that is out of scope for this spec (covered by
    // the light-account creation flow). Finalize that one column directly in the
    // test DB so the real ORCID-login round-trip can resolve the account the
    // signup just created. This is a direct test-DB write (the mechanism
    // settings-orcid-factor.spec.js uses to seed/mutate rows), not a mock — every
    // backend hop below runs for real.
    await pool.query(
      `UPDATE accounts SET username = $1, custody = 'light', verify_token = NULL WHERE email = $2`,
      [username, email],
    );

    // Drive the real ORCID login round-trip with the same iD; handleLogin finds
    // the now-finalized account and mints a session, bouncing the user to /papers.
    const loginCallback = page.waitForResponse(
      (resp) => resp.url().endsWith('/api/orcid/callback') && resp.request().method() === 'POST',
    );
    await page.goto('/login');
    await page.locator('button[\\@click="handleOrcidLogin()"]').click();
    expect((await loginCallback).status()).toBe(200);
    await page.waitForURL('**/papers');
  });

  test('ORCID recovery with new_password: null preserves password_hash = NULL', async ({ page, baseURL }, testInfo) => {
    page.on('dialog', (dialog) => {
      throw new Error(`Unexpected dialog: ${dialog.type()} "${dialog.message()}"`);
    });

    const now = Date.now();
    const suffix = `${now.toString(36).slice(-6)}r${testInfo.retry}`;
    // Hive usernames cap at 16 chars (the recover username field is maxlength=16);
    // keep it short so the typed value is not truncated away from the seeded row.
    const username = `rec${suffix}`;
    const oldEmail = `e2e+orcidrecover-${suffix}@pevo.test`;
    const newEmail = `e2e+orcidrecover-new-${suffix}@pevo.test`;
    const orcid = makeOrcid(`${now}${testInfo.retry}`);

    // Seed a finalized, passwordless ORCID account. ORCID recovery requires
    // exactly this shape (recover.ts: WHERE username AND verify_token IS NULL,
    // orcid present, upgraded_at NULL). password_hash starts NULL so the
    // "new_password: null preserves NULL" assertion is meaningful.
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, orcid, full_name, institution, field, custody, verify_token)
       VALUES ($1, $2, NULL, $3, 'E2E ORCID Recover', 'Test Institution', 'Test Science', 'light', NULL)
       ON CONFLICT (email) DO UPDATE SET
         username = EXCLUDED.username,
         password_hash = NULL,
         orcid = EXCLUDED.orcid,
         custody = 'light',
         verify_token = NULL`,
      [oldEmail, username, orcid],
    );

    await page.context().clearCookies();
    await routeOrcidStubBridge(page, baseURL, orcid);

    // The ORCID method tab is x-show="orcidAvailable", which the page derives from
    // GET /api/accreditations/<username> (an ORCID-method accreditation). That
    // status is read from HAF/on-chain custom_json attestations — impractical to
    // seed per-test, and it is a read-only UI gate, not part of the recover
    // round-trip under test. Stub only that status lookup so the ORCID tab is
    // available; every recover hop below (/api/orcid/start, /api/orcid/callback,
    // /api/auth/recover) stays fully real. Same accreditation-status stub the
    // stubbed recover ORCID-branch test above uses.
    await page.route(`**/api/accreditations/${username}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          data: { username, is_accredited: true, accreditation: { method: 'orcid' } },
        }),
      });
    });

    await page.goto('/recover');
    await page.locator('input[x-model="username"]').fill(username);
    const orcidTab = page.getByTestId('recover-method-orcid');
    await expect(orcidTab).toBeVisible({ timeout: 3000 });
    await orcidTab.click();
    await page.locator('input[x-model="newEmail"]').fill(newEmail);

    // "Verify with ORCID" mints a verified-ORCID nonce bound to the seeded orcid,
    // then returns to /recover with the ORCID branch active and the draft
    // (username, newEmail) restored.
    const callbackResponse = page.waitForResponse(
      (resp) => resp.url().endsWith('/api/orcid/callback') && resp.request().method() === 'POST',
    );
    await page.locator('button[\\@click="handleOrcidVerify()"]').click();
    expect((await callbackResponse).status()).toBe(200);

    await page.waitForSelector('[x-data="recoverPage"]');
    // ORCID branch active on return: the new-password field is hidden.
    await expect(page.locator('input[x-model="newPassword"]')).toBeHidden();

    // Submit recovery: real POST /api/auth/recover with new_password: null. The
    // backend validates the nonce's orcid against accounts.orcid and rotates the
    // email, leaving password_hash NULL.
    const recoverResponse = page.waitForResponse(
      (resp) => resp.url().endsWith('/api/auth/recover') && resp.request().method() === 'POST',
    );
    await page.locator('[x-data="recoverPage"] form button[type="submit"]').click();
    expect((await recoverResponse).status()).toBe(200);

    // password_hash preserved as NULL; email rotated to the new address.
    const after = await pool.query(
      'SELECT password_hash, email FROM accounts WHERE username = $1',
      [username],
    );
    expect(after.rows.length).toBe(1);
    expect(after.rows[0].password_hash).toBeNull();
    expect(after.rows[0].email).toBe(newEmail);

    // Password login still refused with NO_PASSWORD_SET after recovery.
    const pwLogin = await page.request.post('/api/auth/login', {
      data: { email_or_username: newEmail, password: 'NotMyPassword1X' },
    });
    expect(pwLogin.status()).toBe(403);
    expect((await pwLogin.json())?.error?.code).toBe('NO_PASSWORD_SET');
  });
});

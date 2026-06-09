/**
 * SEC-004-UI — Password never persists across the ORCID round-trip.
 *
 * SEC-004 ships atomically with SEC-004-BE. This spec locks in the UI
 * contract that no password key is ever written to the draft keys in
 * localStorage (`pevo_signup_draft`, `pevo_recover_draft`) when the user
 * clicks "Verify with ORCID", and that the ORCID-branch submit calls
 * `/api/auth/signup` and `/api/auth/recover` with `password: null` /
 * `new_password: null` respectively.
 *
 * The ORCID round-trip itself is simulated in-test: we populate the
 * post-callback state (`pevo_signup_orcid_token`, `pevo_signup_orcid_id`)
 * directly in localStorage so the page enters the "ORCID verified" UI
 * state without a real ORCID OAuth handshake. This is the same approach
 * taken by `orcid-link.spec.js` (SEC-002-UI) and keeps the assertion
 * deterministic regardless of the backend's own auth state.
 *
 * The assertions that require the real backend (password: null actually
 * being accepted by /api/auth/signup, ORCID login on a null-password
 * account, password login returning 403 NO_PASSWORD_SET, and the
 * /api/settings/set-password endpoint) are marked with `test.fixme`
 * pending SEC-004-BE. Un-fixme them once the backend lands.
 */

import { test, expect } from './fixtures/keychain.js';

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
    // Critical: fill the password field too. Before SEC-004-UI, this text
    // would be persisted into localStorage across the round-trip. After
    // SEC-004-UI, the draft must not contain it.
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

    // SEC-004: non-sensitive fields present.
    expect(parsed).toMatchObject({
      email: 'sec004-ui@pevo.test',
      fullName: 'SEC-004 Tester',
      institution: 'Test Institution',
      field: 'Test Science',
    });
    // SEC-004: password MUST NOT be in the draft.
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
    // whether SEC-004-BE is deployed. The real-backend 200 path is
    // covered by the test.fixme at the bottom of this file.
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

    // SEC-004: the submit sent password: null alongside the ORCID token.
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
 * Real-backend ORCID round-trips.
 *
 * The set-password real round-trip on a null-hash State-C account (real ORCID
 * fresh-auth proof -> real /api/settings/set-password -> password_hash
 * populated -> password login succeeds -> "Set a password" stops rendering) is
 * implemented as the third test in settings-orcid-factor.spec.js
 * ("ORCID-factor set_password succeeds end-to-end with a real backend-minted
 * proof"), which drives it against the orcid-stub OAuth sidecar. It is not
 * duplicated here.
 *
 * The signup and recovery round-trips below stay `test.fixme`: both drive the
 * ORCID *signup* mode, whose backend handler additionally fetches a works count
 * from a hardcoded pub.orcid.org URL. The orcid-stub sidecar only serves
 * /oauth/token (it reflects the submitted code back as the orcid iD); it does
 * NOT serve the pub.orcid.org works endpoint, so the signup-mode works-count
 * gate cannot be satisfied in-network. Driving these needs a second stub for the
 * works API; out of scope for the token-only orcid-stub, filed as a follow-up.
 */
test.fixme(
  'ORCID signup with password: null creates an account with password_hash = NULL (needs a pub.orcid.org works stub)',
  async () => {
    // 1. Drive /signup through the ORCID branch end-to-end.
    // 2. Real /api/auth/signup accepts password: null and returns 200.
    // 3. Query pevo_app_test: accounts.password_hash IS NULL.
    // 4. Attempt /api/auth/login with any password → 403 NO_PASSWORD_SET.
    // 5. ORCID login succeeds.
  },
);

test.fixme(
  'ORCID recovery with new_password: null preserves password_hash = NULL (needs a pub.orcid.org works stub)',
  async () => {
    // 1. Seed an ORCID-linked account.
    // 2. Drive /recover through the ORCID branch with new_password: null.
    // 3. 200, accounts.password_hash unchanged (still NULL).
    // 4. Password login still 403 NO_PASSWORD_SET after recovery.
  },
);

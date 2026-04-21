/**
 * E2E-CRYPTO-1 — Seed phrase generation and re-derivation.
 *
 * Proves that client-side BIP39 mnemonic generation + HMAC-SHA512 key
 * derivation is deterministic across the two places the frontend performs
 * it: the signup/verify "create account" flow, and the /recover seed-phrase
 * flow. If a future refactor accidentally changes the derivation algorithm
 * on one side, this spec's final equality assertions fail loudly.
 *
 * Flow:
 *   1. Sign up via /signup, read the verification token from pevo_app_test
 *      (same pattern as email-signup.spec.js), land on /signup/verify.
 *   2. Click "Create new account", capture the mnemonic straight from
 *      Alpine's live component data — the same string the code uses to
 *      derive keys, so there's no chance of DOM/state drift.
 *   3. Walk the three confirm-words step via Alpine state, pick a username,
 *      force `usernameStatus = 'available'` to skip the live dhive check
 *      (the fake "e2eseed..." account wouldn't exist on chain anyway).
 *   4. Intercept POST /api/auth/confirm with page.route — capture the
 *      request body, then fail the response so the backend never tries to
 *      run `create_claimed_account` against Hive.
 *   5. Navigate to /recover, enter the same username + same mnemonic. The
 *      recover flow re-runs deriveAllKeys internally and posts `memo_key`.
 *      Intercept POST /api/auth/recover the same way.
 *   6. Re-derive all four keypairs in the page context from the captured
 *      mnemonic + username so we can assert the signup POST's public keys
 *      match the independent derivation, and that the recover POST's
 *      memo_key equals the signup POST's memo_private.
 *
 * No chain writes. All Hive-bound side effects are intercepted before the
 * backend can broadcast.
 */

import { test, expect } from './fixtures/keychain.js';
import { queryAppDb } from './fixtures/db.js';
import { deriveAllKeys } from '../../src/hive-keys.js';

// SEC-002: disable trace/video/screenshot for this spec. Playwright
// `retain-on-failure` traces serialize intercepted request bodies — here
// those bodies carry WIF private keys derived from the test mnemonic.
// Dropping traces entirely is safer than attempting per-step redaction.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

// Timestamp-suffix both the email and the username for rerun safety. Without
// the suffix, reruns against a non-truncated dev DB collide on the email
// unique constraint, or overwrite verify-token rows before the
// expect-length-1 assertion below.
const RUN_SUFFIX = Date.now().toString(36).slice(-6);
const TEST_EMAIL = `e2e+seed-${RUN_SUFFIX}@pevo.test`;
const TEST_PASSWORD = 'E2eTestPass1';
const TEST_NAME = 'E2E Seed Tester';
const TEST_INSTITUTION = 'Test Institution';
const TEST_FIELD = 'Test Science';
// Hive usernames are 3-16 chars, lowercase a-z/0-9, may contain dots/hyphens.
// Keys are derived from username, so the value only needs to be stable
// within a single test invocation.
const TEST_USERNAME = `e2eseed${RUN_SUFFIX}`.toLowerCase();

test('signup-generated mnemonic re-derives to the same keys on /recover', async ({ page }) => {
  // ─── Step 1: email signup (same shape as email-signup.spec.js) ─────────
  await page.goto('/signup');

  await page.locator('input[x-model="email"]').fill(TEST_EMAIL);
  await page.locator('input[x-model="fullName"]').fill(TEST_NAME);
  await page.locator('input[x-model="institution"]').fill(TEST_INSTITUTION);
  await page.locator('input[x-model="field"]').fill(TEST_FIELD);
  await page.locator('input[x-model="password"]').fill(TEST_PASSWORD);
  await page.locator('input[x-model="passwordConfirm"]').fill(TEST_PASSWORD);

  const signupResponsePromise = page.waitForResponse(
    (resp) => resp.url().endsWith('/api/auth/signup'),
  );
  await page.locator('form button[type="submit"]').click();
  const signupResp = await signupResponsePromise;
  expect(signupResp.status()).toBe(200);

  // Read the verify token straight from pevo_app_test. `queryAppDb` enforces
  // the `_test` suffix guard locally so spec-in-isolation runs (which skip
  // global-setup) can't accidentally hit the dev DB.
  const { rows } = await queryAppDb(
    'SELECT verify_token FROM accounts WHERE email = $1',
    [TEST_EMAIL],
  );
  expect(rows).toHaveLength(1);
  const verifyToken = rows[0].verify_token;
  expect(verifyToken).toBeTruthy();

  // ─── Step 2: land on /signup/verify, capture mnemonic ──────────────────
  await page.goto(`/signup/verify?token=${verifyToken}`);

  // Wait until the verify POST has run and the page has transitioned to the
  // 'choose' phase (create vs link existing). The heading and button labels
  // are i18n'd, so `phase === 'choose'` is the stable signal to wait on.
  await expect
    .poll(
      () => page.evaluate(() => {
        const el = document.querySelector('[x-data="signupVerifyPage"]');
        return el ? window.Alpine.$data(el).phase : null;
      }),
      { timeout: 15_000 },
    )
    .toBe('choose');

  // Trigger the create flow via Alpine so we don't depend on the button's
  // i18n label.
  await page.evaluate(() => {
    const el = document.querySelector('[x-data="signupVerifyPage"]');
    window.Alpine.$data(el).chooseCreate();
  });

  const mnemonic = await page.evaluate(() => {
    const el = document.querySelector('[x-data="signupVerifyPage"]');
    return window.Alpine.$data(el).mnemonic;
  });
  expect(typeof mnemonic).toBe('string');
  expect(mnemonic.split(' ')).toHaveLength(12);

  // ─── Step 3: walk confirm-words + username phases via Alpine state ────
  // proceedToConfirm populates `confirmIndices` with 3 random word slots.
  // We fill them from the captured mnemonic; the spec never types them.
  // Stub _checkUsername before assigning `username` so the Alpine $watch
  // (which debounces-then-calls _checkUsername with the live dhive client)
  // can't hit api.hive.blog. The stub just flips usernameStatus to
  // 'available' — exactly what an unused test username would eventually
  // resolve to, but synchronously and without external network.
  await page.evaluate((username) => {
    const el = document.querySelector('[x-data="signupVerifyPage"]');
    const data = window.Alpine.$data(el);
    data.proceedToConfirm();
    for (const i of data.confirmIndices) {
      data.confirmInputs[i] = data.seedWords[i];
    }
    data.proceedToUsername();
    data._checkUsername = function (val) {
      if (this.username.trim().toLowerCase() === val) this.usernameStatus = 'available';
    };
    data.username = username;
    data.usernameStatus = 'available';
  }, TEST_USERNAME);

  // ─── Step 4: intercept /api/auth/confirm ───────────────────────────────
  let capturedConfirmBody = null;
  await page.route('**/api/auth/confirm', async (route) => {
    const postData = route.request().postData();
    capturedConfirmBody = postData ? JSON.parse(postData) : null;
    // Fail the response so the backend side never runs create_claimed_account.
    // The signup-verify page will transition to the error branch after this,
    // which is fine — we already have what we need.
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'aborted by E2E spec' },
      }),
    });
  });

  // Trigger submitCreateAccount directly; the button would do the same but
  // via an Alpine DOM binding that's easier to mis-target across i18n.
  //
  // Wrap the trigger in Promise.all with a waitForRequest gate so the route
  // intercept is guaranteed active before Alpine's microtask-queued
  // `await fetch()` fires. Without this, page.evaluate can race the
  // interception layer in the renderer and the POST slips past the route.
  //
  // Re-assert usernameStatus='available' and cancel the pending debounce
  // timer inside the same evaluate that triggers submitCreateAccount. The
  // Alpine `$watch('username', ...)` handler runs as a microtask after the
  // previous evaluate returned and resets usernameStatus to 'checking' while
  // scheduling a 400ms debounced _checkUsername. Setting it back to
  // 'available' in the same evaluate as the trigger call guarantees the
  // guard in submitCreateAccount sees the right value.
  const confirmRequestPromise = page.waitForRequest(
    (req) => req.url().endsWith('/api/auth/confirm') && req.method() === 'POST',
  );
  await Promise.all([
    confirmRequestPromise,
    page.evaluate(() => {
      const el = document.querySelector('[x-data="signupVerifyPage"]');
      const data = window.Alpine.$data(el);
      clearTimeout(data._usernameTimer);
      data.usernameStatus = 'available';
      data.submitCreateAccount();
    }),
  ]);

  await expect.poll(() => capturedConfirmBody, { timeout: 15_000 }).not.toBeNull();
  expect(capturedConfirmBody).toMatchObject({
    username: TEST_USERNAME,
    keys: {
      owner_public: expect.stringMatching(/^STM/),
      active_public: expect.stringMatching(/^STM/),
      posting_public: expect.stringMatching(/^STM/),
      memo_public: expect.stringMatching(/^STM/),
      posting_private: expect.stringMatching(/^5[HJK]/),
      memo_private: expect.stringMatching(/^5[HJK]/),
    },
  });

  // Re-derive keys in the Node context using the exact same module the UI
  // imports. If derivation is deterministic (HMAC-SHA512 is), these must
  // match the values the UI just posted. Importing from ../../src/hive-keys.js
  // (bypassing the bundler) guarantees we're comparing against the same
  // source-of-truth the frontend build was produced from.
  const rederived = await deriveAllKeys(mnemonic, TEST_USERNAME);

  expect(capturedConfirmBody.keys.owner_public).toBe(rederived.owner.public);
  expect(capturedConfirmBody.keys.active_public).toBe(rederived.active.public);
  expect(capturedConfirmBody.keys.posting_public).toBe(rederived.posting.public);
  expect(capturedConfirmBody.keys.memo_public).toBe(rederived.memo.public);
  expect(capturedConfirmBody.keys.posting_private).toBe(rederived.posting.private);
  expect(capturedConfirmBody.keys.memo_private).toBe(rederived.memo.private);

  await page.unroute('**/api/auth/confirm');

  // ─── Step 5: drive /recover with the same mnemonic + username ─────────
  let capturedRecoverBody = null;
  await page.route('**/api/auth/recover', async (route) => {
    const postData = route.request().postData();
    capturedRecoverBody = postData ? JSON.parse(postData) : null;
    // Fail softly — we only need the request body to prove the re-derivation.
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'aborted by E2E spec' },
      }),
    });
  });

  await page.goto('/recover');
  await page.waitForSelector('[x-data="recoverPage"]');

  await page.locator('input[x-model="username"]').fill(TEST_USERNAME);
  await page.locator('textarea[x-model="seedPhrase"]').fill(mnemonic);
  await page.locator('input[x-model="newEmail"]').fill('e2e+seed-new@pevo.test');
  await page.locator('input[x-model="newPassword"]').fill('NewE2ePass1');
  await page.locator('input[x-model="newPasswordConfirm"]').fill('NewE2ePass1');

  await page.locator('form button[type="submit"]').click();

  await expect.poll(() => capturedRecoverBody, { timeout: 15_000 }).not.toBeNull();
  expect(capturedRecoverBody).toMatchObject({
    username: TEST_USERNAME,
    new_email: 'e2e+seed-new@pevo.test',
    new_password: 'NewE2ePass1',
  });
  expect(capturedRecoverBody.memo_key).toBeTruthy();

  // The load-bearing cross-flow assertion: the memo private key the recover
  // page derived from the entered mnemonic must match the memo private key
  // the signup-verify page derived and posted earlier. Both are a pure
  // function of (mnemonic, username); any drift means derivation is broken
  // on one side.
  expect(capturedRecoverBody.memo_key).toBe(capturedConfirmBody.keys.memo_private);
  expect(capturedRecoverBody.memo_key).toBe(rederived.memo.private);

  await page.unroute('**/api/auth/recover');
});

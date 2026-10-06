/**
 * Seed-phrase recovery through the two links its first step mails.
 *
 * The first step, submitted on /recover, changes nothing on the account. It
 * mails a confirmation link to the new address and a stop link to the
 * account's previous address. Only SHA-256 digests of the link tokens are
 * stored, so the specs read the links from the test stack's Mailpit sink and
 * open them on the SPA.
 *
 * The /recover form, /recover/verify and /recover/dispute share one per-IP
 * limiter of 10 requests an hour; these tests spend five.
 */

import { test, expect } from './fixtures/keychain.js';
import { withAppPool } from './fixtures/db.js';
import { postTo } from './fixtures/light-account.js';
import { linkPath, waitForMailText } from './fixtures/mailpit.js';
import { seedRecoverableAccount } from './fixtures/recoverable-account.js';
import { generateMnemonic } from '../../src/hive-keys.js';

// The flows type a recovery phrase and a new password and receive reissued
// sessions, so nothing is recorded.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const NEW_PASSWORD = 'NewE2ePass1';
const verifyPost = postTo('/api/auth/recover/verify');

// Per-attempt identities. The recover form caps usernames at 16 characters
// and the suffix takes 8, so prefixes stay at 8 or fewer.
function identities(prefix, testInfo) {
  const suffix = `${Date.now().toString(36).slice(-6)}r${testInfo.retry}`;
  return {
    username: `${prefix}${suffix}`,
    oldEmail: `e2e+${prefix}-old-${suffix}@pevo.test`,
    newEmail: `e2e+${prefix}-new-${suffix}@pevo.test`,
  };
}

async function startRecovery(page, { username, mnemonic, newEmail }) {
  await page.goto('/recover');
  await page.locator('input[x-model="username"]').fill(username);
  await page.locator('textarea[x-model="seedPhrase"]').fill(mnemonic);
  await page.locator('input[x-model="newEmail"]').fill(newEmail);
  await page.locator('input[x-model="newPassword"]').fill(NEW_PASSWORD);
  await page.locator('input[x-model="newPasswordConfirm"]').fill(NEW_PASSWORD);
  const staged = page.waitForResponse(postTo('/api/auth/recover').response);
  await page.getByRole('button', { name: 'Recover Account' }).click();
  const response = await staged;
  expect(response.status()).toBe(200);
  expect((await response.json()).data.recovery).toBe('pending_verification');
  await expect(page.getByRole('heading', { name: 'Check your new email' })).toBeVisible();
}

const accountRow = async (pool, username) =>
  (await pool.query('SELECT email, password_hash FROM accounts WHERE username = $1', [username])).rows[0];

test('the link to the new address applies the recovery and signs this browser in', async ({ page }, testInfo) => {
  const id = identities('e2esrv', testInfo);
  const mnemonic = generateMnemonic();

  await withAppPool(async (pool) => {
    await seedRecoverableAccount(pool, { username: id.username, email: id.oldEmail, mnemonic });
    const before = await accountRow(pool, id.username);

    await startRecovery(page, { ...id, mnemonic });
    expect(await accountRow(pool, id.username)).toEqual(before);

    const verifyPosts = [];
    page.on('request', (req) => {
      if (verifyPost.request(req)) verifyPosts.push(req);
    });
    await page.goto(linkPath(await waitForMailText({ to: id.newEmail }), '/recover/verify'));
    await expect(page.getByRole('heading', { name: 'Confirm your account recovery' })).toBeVisible();
    // Opening the link sends nothing; only the button does.
    expect(verifyPosts).toHaveLength(0);

    const confirmed = page.waitForResponse(verifyPost.response);
    await page.getByRole('button', { name: 'Confirm recovery' }).click();
    const response = await confirmed;
    expect(response.status()).toBe(200);
    const reissued = (await response.json()).data;

    await expect(page.getByText('Your account now uses the new email address and password, and you are signed in.')).toBeVisible();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pevo_session')));
    expect(stored).toMatchObject({ token: reissued.token, username: id.username });

    const after = await accountRow(pool, id.username);
    expect(after.email).toBe(id.newEmail);
    expect(after.password_hash).not.toBe(before.password_hash);
    const login = await page.request.post('/api/auth/login', {
      data: { email_or_username: id.newEmail, password: NEW_PASSWORD },
    });
    expect(login.status()).toBe(200);

    await page.getByRole('button', { name: 'Go to Settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
  });
});

test('the link to the previous address stops a staged recovery, so the other link no longer applies it', async ({ page }, testInfo) => {
  const id = identities('e2esrd', testInfo);
  const mnemonic = generateMnemonic();

  await withAppPool(async (pool) => {
    await seedRecoverableAccount(pool, { username: id.username, email: id.oldEmail, mnemonic });
    const before = await accountRow(pool, id.username);

    await startRecovery(page, { ...id, mnemonic });

    await page.goto(linkPath(await waitForMailText({ to: id.oldEmail }), '/recover/dispute'));
    await expect(page.getByRole('heading', { name: 'Stop this account recovery?' })).toBeVisible();
    const stopped = page.waitForResponse(postTo('/api/auth/recover/dispute').response);
    await page.getByRole('button', { name: 'Stop the recovery' }).click();
    expect((await stopped).status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Request received' })).toBeVisible();

    await page.goto(linkPath(await waitForMailText({ to: id.newEmail }), '/recover/verify'));
    const refused = page.waitForResponse(verifyPost.response);
    await page.getByRole('button', { name: 'Confirm recovery' }).click();
    expect((await refused).status()).toBe(400);
    await expect(page.getByRole('heading', { name: 'This link cannot be used' })).toBeVisible();

    expect(await accountRow(pool, id.username)).toEqual(before);
    expect(await page.evaluate(() => localStorage.getItem('pevo_session'))).toBeNull();
  });
});

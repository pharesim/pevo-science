/**
 * Shared helpers for E2E specs that drive a LIGHT account through a real
 * fresh-auth mint and consume against the test-mode backend.
 *
 * What a seeded light account is here: an `accounts` row with
 * custody='light', a verified email (verify_token NULL), and a real argon2id
 * hash of TEST_PASSWORD, so the password factor mints for real at
 * `POST /api/custody/session-auth` and `POST /api/custody/fresh-auth`, and
 * deliberately NO encrypted posting key. That absence is what lets a spec
 * reach the real `POST /api/custody/broadcast` without anything being
 * signed or reaching a Hive node: the handler consumes the proof, reads the
 * row (a missing row would 401, an upgrade stamp would 403, and the seed
 * clears both), then hits the posting-key decrypt and refuses with the
 * posting-key-unavailable envelope. `expectPostGateStop` pins that exact
 * envelope, which is how a spec proves a request PASSED the fresh-auth gate
 * (the gate itself answers FRESH_AUTH_REQUIRED, and a bundle the handler
 * refuses before the gate answers 400 or 403 with a different code).
 *
 * The upload pre-flight has no such stop: `POST /api/ipfs/upload-token`
 * consumes the window and mints a real upload token, and the transfer pins
 * the bytes for real (the keychain fixture records the CID for
 * global-teardown to unpin). The pre-flight does gate on HAF accreditation
 * AFTER the proof consume, so an upload leg needs a username HAF reports as
 * accredited. That check is resource gating (pinning costs the platform);
 * the broadcast handler performs no accreditation check by design, since
 * light-account signup gates on the same criteria accreditation uses, so
 * every product-created light account already qualifies (ARCHITECTURE.md
 * "Accredited-Only Data Policy").
 */

import argon2 from '../../../../backend/node_modules/argon2/argon2.cjs';
import { expect } from '@playwright/test';

// Password behind every seeded light account in these specs. Distinct from
// the shared `E2eTestPass1`; global-teardown's trace scan hunts for both
// literals. The specs that use it also turn traces off, since the reauth
// modal types it and the mint request carries it.
export const TEST_PASSWORD = 'E2eFreshAuthPass1';

export function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

// waitForRequest / waitForResponse matchers for a POST to `path`.
export const postTo = (path) => ({
  request: (req) => req.url().endsWith(path) && req.method() === 'POST',
  response: (resp) => resp.url().endsWith(path) && resp.request().method() === 'POST',
});

/**
 * Insert (or refresh) the seeded light-account row described in the module
 * docblock. Keyed on username so a Playwright retry within one run (the DB is
 * reset per run, not per test) refreshes the row instead of colliding on the
 * UNIQUE(username) constraint. The refresh also clears every column that
 * would change the broadcast's stop: an upgrade stamp, a posting key, a
 * revocation epoch.
 */
export async function seedLightAccount(pool, { username, email, fullName }) {
  const passwordHash = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id });
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, full_name, institution, field, custody, verify_token)
     VALUES ($1, $2, $3, $4, 'Test Institution', 'Test Science', 'light', NULL)
     ON CONFLICT (username) DO UPDATE SET
       email = EXCLUDED.email,
       password_hash = EXCLUDED.password_hash,
       custody = 'light',
       verify_token = NULL,
       upgraded_at = NULL,
       posting_key_enc = NULL,
       iv_posting = NULL,
       sessions_invalidated_at = NULL`,
    [email, username, passwordHash, fullName],
  );
}

export async function deleteLightAccount(pool, username) {
  await pool.query('DELETE FROM accounts WHERE username = $1', [username]);
}

/**
 * Answer the password factor's prompt: the global reauth modal collects the
 * account password and the SPA exchanges it at the real mint route. Waits
 * for the modal to open, so it can be called right after the action that
 * triggers the acquisition.
 */
export async function answerReauthPrompt(page, password = TEST_PASSWORD) {
  const passwordInput = page.locator('input[x-model="$store.reauthModal.password"]');
  await expect(passwordInput).toBeVisible();
  await passwordInput.fill(password);
  await page.locator('form').filter({ has: passwordInput }).locator('button[type="submit"]').click();
}

/**
 * Confirm the light-account broadcast dialog that fronts every comment,
 * vote, review, and publish (self-custody skips it). Selected by the
 * binding, not the label, since the label is per-action copy.
 */
export async function confirmBroadcastDialog(page) {
  const confirmButton = page.locator('button[x-text="$store.broadcastConfirm.confirmLabel"]');
  await expect(confirmButton).toBeVisible();
  await confirmButton.click();
}

/**
 * Assert a `POST /api/custody/broadcast` response is the seeded account's
 * post-gate stop (see the module docblock): the request passed the
 * fresh-auth gate and reached the posting-key decrypt. Both the status and
 * the message are pinned because the handler has two 500 envelopes, and only
 * the posting-key one sits at the first post-gate step; the outer catch's
 * generic one would mean the decrypt itself threw.
 */
export async function expectPostGateStop(response) {
  const body = await response.json();
  const envelope = JSON.stringify(body);
  expect(body.error?.code, envelope).not.toBe('FRESH_AUTH_REQUIRED');
  expect(response.status(), envelope).toBe(500);
  expect(body.error?.code, envelope).toBe('INTERNAL_ERROR');
  expect(body.error?.message, envelope).toMatch(/posting key/i);
}

/**
 * Assert a response is a FRESH_AUTH_REQUIRED refusal AT the fresh-auth gate
 * with the given status and one of the given `details.reason` values: the
 * 401 no-valid-proof branch (missing, expired, malformed) or the 403
 * binding-violation branch (kind_mismatch, target_mismatch,
 * username_mismatch) of the wire contract in
 * `agents/docs/api-contracts/custody.md`, which the upload pre-flight mirrors.
 */
export async function expectGateRefusal(response, { status, reasons }) {
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(status);
  expect(body.error?.code).toBe('FRESH_AUTH_REQUIRED');
  expect(reasons).toContain(body.error?.details?.reason);
}

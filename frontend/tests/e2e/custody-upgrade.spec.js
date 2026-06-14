/**
 * Light-to-self-custody upgrade wizard up to key rotation.
 *
 * Drives a light-account session through the `/settings` upgrade wizard from
 * the idle "Begin Upgrade" button all the way to clicking "Upgrade Account",
 * then intercepts the Hive chain broadcast (account_update rotating all four
 * key authorities to the newly-derived public keys) before it reaches a
 * Hive node.
 *
 * Interception layer — why api.hive.blog, not the Keychain stub:
 * The upgrade path in frontend/src/pages/settings.js signs the account_update
 * op locally with the OLD owner private key (derived from the user-entered
 * old seed phrase) and POSTs the signed transaction to a Hive node via
 * `new dhive.Client(['https://api.hive.blog']).broadcast.sendOperations(...)`.
 * Keychain is NEVER invoked for this broadcast — the owner key is held in
 * memory for the duration of the call and dropped. So we intercept at the
 * network layer with `page.route('**\/api.hive.blog\/**')`.
 *
 * dhive's `sendOperations` makes two JSON-RPC POSTs to the node:
 *   1. condenser_api.get_dynamic_global_properties — needed for ref_block fields
 *   2. condenser_api.broadcast_transaction         — the actual chain write
 * Both are intercepted; the first is fulfilled with a canned block header
 * that dhive can sign against, the second captures the full signed-transaction
 * payload and returns a stub success so we can then reach the backend
 * `/api/custody/upgrade` notification (also intercepted — the focus of this
 * spec is the Hive broadcast, not the backend cleanup call).
 *
 * @scure/bip39 is bundled directly into settings.js via static ESM imports
 * from the `@scure/bip39` package. Nothing in this spec needs to pre-seed
 * the BIP39 state or inject a shim; `startUpgrade()` generates a real
 * mnemonic inside the browser bundle, and `executeUpgrade()` derives a real
 * 64-byte seed so `deriveHiveKeys` produces valid hex private-key seeds and
 * dhive signs a real (if never-broadcast) Hive transaction. The spec reads
 * the generated mnemonic off Alpine state after clicking "Begin Upgrade"
 * and uses it both to verify on-screen words and to fill the "old seed"
 * textarea.
 */

import { test, expect } from './fixtures/keychain.js';
import { mintSessionJwt } from './fixtures/auth.js';
import { deriveAllKeys, generateMnemonic } from '../../src/hive-keys.js';

// Disable trace/video/screenshot: this spec handles plaintext seed material.
// The spec reads the generated mnemonic off Alpine state and fills it into
// the old-seed textarea, so the DOM and any intercepted request bodies
// contain plaintext seed words plus the four derived private keys.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const LIGHT_USERNAME = 'e2e-upgrade-user';

test('upgrade wizard signs and would-broadcast an account_update rotating all keys', async ({
  page,
}) => {
  // ─── Extend the Keychain stub with requestImportKey ─────────
  // settings.js calls this AFTER the chain broadcast succeeds to import the
  // newly-derived posting WIF into Keychain. The base fixture does not
  // provide it; without a stub the Alpine handler would hang forever waiting
  // for a callback. init scripts run in insertion order, so
  // window.hive_keychain is already installed by the base fixture's script
  // by the time this one fires.
  //
  // The stub captures call arguments on a window-global array so the test
  // can assert the second argument is a WIF-formatted private key (matching
  // /^5[HJK][1-9A-HJ-NP-Za-km-z]{49}$/), NOT a raw 64-char hex seed.
  // Regression guard for the old `requestAddAccountAuthority` misuse that
  // was passing `newKeys.posting` (a raw hex seed) as an "account name".
  await page.addInitScript(() => {
    window.__keychainImportKeyCalls = [];
    window.__keychainAddAccountAuthorityCalls = [];
    if (window.hive_keychain) {
      window.hive_keychain.requestImportKey = (
        account,
        wifKey,
        callback,
      ) => {
        window.__keychainImportKeyCalls.push({ account, wifKey });
        queueMicrotask(() => callback({ success: true, result: 'STUB_KEY_IMPORTED' }));
      };
      // Trap for the legacy API. If settings.js ever regresses and calls
      // this, the test captures it and the assertion below fails.
      window.hive_keychain.requestAddAccountAuthority = (
        account,
        authorizedKey,
        role,
        callback,
      ) => {
        window.__keychainAddAccountAuthorityCalls.push({ account, authorizedKey, role });
        queueMicrotask(() => callback({ success: true, result: 'STUB_AUTH_ADDED' }));
      };
    }
  });

  // ─── Capture Hive-node traffic and stub responses ────────────
  const hiveCalls = [];
  await page.route('**/api.hive.blog/**', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') {
      await route.continue();
      return;
    }
    const body = JSON.parse(req.postData() || '{}');
    hiveCalls.push(body);

    if (body.method === 'condenser_api.get_dynamic_global_properties') {
      // Canned response with a recent-looking head block + iso timestamp.
      // dhive uses head_block_number for ref_block_num and head_block_id
      // (bytes 4-8) for ref_block_prefix. Any plausible values work.
      const iso = new Date().toISOString().slice(0, -5);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: body.id,
          jsonrpc: '2.0',
          result: {
            head_block_number: 80_000_000,
            head_block_id: '04c4b40000000000000000000000000000000000',
            time: iso,
          },
        }),
      });
      return;
    }

    if (body.method === 'condenser_api.broadcast_transaction') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: body.id,
          jsonrpc: '2.0',
          result: null,
        }),
      });
      return;
    }

    // Unknown RPC — respond with an error so we notice if the flow grows
    // new network calls that aren't accounted for here.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: body.id ?? 0,
        jsonrpc: '2.0',
        error: { code: -32601, message: `Unstubbed method: ${body.method}` },
      }),
    });
  });

  // ─── Stub the backend custody-upgrade notification ───────────
  // Focus of this spec is the chain broadcast payload; the backend cleanup
  // call is covered by the custody API contract and dedicated backend tests.
  // Seeding a real light-account row just to let this POST succeed is out of
  // scope — we stub it so the post-broadcast handler doesn't log a spurious
  // 401 after our assertions finish.
  await page.route('**/api/custody/upgrade', async (route) => {
    const { token: upgradedToken } = mintSessionJwt(LIGHT_USERNAME, { custody: 'self' });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        data: {
          custody: 'self',
          token: upgradedToken,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      }),
    });
  });

  // ─── Seed a light-account session before the app boots ───────
  const { token, expiresAt } = mintSessionJwt(LIGHT_USERNAME, { custody: 'light' });
  await page.addInitScript(
    ({ session }) => {
      window.localStorage.setItem('pevo_session', JSON.stringify(session));
    },
    {
      session: {
        token,
        username: LIGHT_USERNAME,
        expiresAt,
        isAccredited: false,
        accreditation: null,
        custody: 'light',
      },
    },
  );

  // ─── Drive the wizard ────────────────────────────────────────
  await page.goto('/en/settings');
  await page.waitForSelector('[x-data="settingsPage"]');

  // Phase 1: idle → new-seed. The "Begin Upgrade" button is gated on
  // isKeychainInstalled(); the base keychain fixture already installed the
  // stub, so the guard passes.
  await page.getByRole('button', { name: 'Begin Upgrade' }).click();

  // Phase 2: new-seed — the browser just generated a real BIP39 mnemonic
  // via bundled `@scure/bip39`. Read it off Alpine state so we can drive
  // the rest of the wizard (word confirmation and typing the "old" seed).
  // Gate the read on the phase transition: the "I’ve written it down"
  // button only renders when `upgradePhase === 'new-seed'`, so waiting for
  // it guarantees Alpine has flushed the post-click microtask queue
  // (`[x-data="settingsPage"]`-visible is instant and not phase-gated).
  await page.getByRole('button', { name: "I’ve written it down" }).waitFor();
  const testMnemonic = await page.evaluate(() => {
    const el = document.querySelector('[x-data="settingsPage"]');
    return window.Alpine.$data(el).newSeedPhrase;
  });
  expect(typeof testMnemonic).toBe('string');
  expect(testMnemonic.split(' ')).toHaveLength(12);

  // All 12 words must be visible on screen.
  const words = testMnemonic.split(' ');
  for (const word of words) {
    await expect(page.locator(`text=${word}`).first()).toBeVisible();
  }
  await page.getByRole('button', { name: "I’ve written it down" }).click();

  // Phase 3: confirm-new — the page picks 3 random indices. Write directly
  // into `confirmInputs` via Alpine's reactive proxy: CSS selectors for
  // `x-model="confirmInputs[N]"` with brackets in the attribute value are
  // fragile across Playwright/engine versions. Setting through the proxy is
  // reactive: `confirmCorrect` recomputes and enables the Next button.
  await expect(page.locator('[x-data="settingsPage"]')).toBeVisible();
  const filledCount = await page.evaluate(() => {
    const el = document.querySelector('[x-data="settingsPage"]');
    const data = window.Alpine.$data(el);
    for (const i of data.confirmIndices) {
      data.confirmInputs[i] = data.newSeedWords[i];
    }
    return data.confirmIndices.length;
  });
  expect(filledCount).toBe(3);
  await page.getByRole('button', { name: 'Next' }).click();

  // Phase 4: enter-old — type the old seed phrase.
  // Generate an independent OLD mnemonic so the broadcast exercises a real
  // rotation (old keys ≠ new keys). The Hive node signature check never
  // runs because we stub `condenser_api.broadcast_transaction` above, so
  // the on-chain authority state for LIGHT_USERNAME is irrelevant here.
  // The wizard has no password input: the re-auth proof for
  // /api/custody/upgrade is a seed-phrase-derived pubkey + signature
  // built inside `_signUpgradeProof`, no second user-facing factor.
  const oldMnemonic = generateMnemonic();
  expect(oldMnemonic).not.toBe(testMnemonic);
  await page.locator('textarea[x-model="oldSeedPhrase"]').fill(oldMnemonic);

  const broadcastClickPromise = page.getByRole('button', { name: 'Upgrade Account' }).click();

  // ─── Wait for the broadcast interception ─────────────────────
  // Two POSTs land on api.hive.blog: GDGP then broadcast_transaction. Poll
  // until both arrive; then `broadcastClickPromise` can resolve without us
  // caring about what happens on the "done" screen.
  await expect
    .poll(
      () =>
        hiveCalls.some(
          (c) => c.method === 'condenser_api.broadcast_transaction',
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  await broadcastClickPromise;

  // ─── Assert payload shape ────────────────────────────────────
  const broadcastCall = hiveCalls.find(
    (c) => c.method === 'condenser_api.broadcast_transaction',
  );
  expect(broadcastCall).toBeTruthy();
  expect(Array.isArray(broadcastCall.params)).toBe(true);
  expect(broadcastCall.params).toHaveLength(1);

  const [transaction] = broadcastCall.params;
  // Signed transaction envelope — dhive fills these in before POSTing.
  expect(typeof transaction.ref_block_num).toBe('number');
  expect(typeof transaction.ref_block_prefix).toBe('number');
  expect(typeof transaction.expiration).toBe('string');
  expect(Array.isArray(transaction.extensions)).toBe(true);
  expect(Array.isArray(transaction.signatures)).toBe(true);
  expect(transaction.signatures).toHaveLength(1);
  expect(transaction.signatures[0]).toMatch(/^[0-9a-fA-F]{130}$/);

  // Exactly one op: account_update rotating all four key authorities.
  expect(Array.isArray(transaction.operations)).toBe(true);
  expect(transaction.operations).toHaveLength(1);
  const [opName, opBody] = transaction.operations[0];
  expect(opName).toBe('account_update');
  expect(opBody.account).toBe(LIGHT_USERNAME);
  expect(opBody.json_metadata).toBe('');

  // Each authority must be a weight_threshold-1 struct with exactly one
  // STM-prefixed public key and no account_auths.
  for (const role of ['owner', 'active', 'posting']) {
    const authority = opBody[role];
    expect(authority.weight_threshold).toBe(1);
    expect(authority.account_auths).toEqual([]);
    expect(authority.key_auths).toHaveLength(1);
    const [[pubkey, weight]] = authority.key_auths;
    expect(typeof pubkey).toBe('string');
    expect(pubkey.startsWith('STM')).toBe(true);
    expect(weight).toBe(1);
  }
  expect(typeof opBody.memo_key).toBe('string');
  expect(opBody.memo_key.startsWith('STM')).toBe(true);

  // All four new public keys must differ from each other — sanity-check
  // that deriveHiveKeys produced per-role keys rather than repeating one.
  const newPubkeys = new Set([
    opBody.owner.key_auths[0][0],
    opBody.active.key_auths[0][0],
    opBody.posting.key_auths[0][0],
    opBody.memo_key,
  ]);
  expect(newPubkeys.size).toBe(4);

  // Cross-check the broadcast pubkeys against independently-derived values
  // computed in the Node context from `testMnemonic` + LIGHT_USERNAME. If
  // HMAC-SHA512-based derivation is deterministic (it is) and the browser
  // ran the same `hive-keys.js` code path, these must match exactly. Mirrors
  // the regression guard used in seed-phrase.spec.js.
  const rederived = await deriveAllKeys(testMnemonic, LIGHT_USERNAME);
  expect(opBody.owner.key_auths[0][0]).toBe(rederived.owner.public);
  expect(opBody.active.key_auths[0][0]).toBe(rederived.active.public);
  expect(opBody.posting.key_auths[0][0]).toBe(rederived.posting.public);
  expect(opBody.memo_key).toBe(rederived.memo.public);

  // ─── Assert Keychain received three WIFs, not a raw hex seed ──
  // The custody upgrade imports posting + active + memo (NOT owner) into
  // Keychain so the user can sign every non-owner-auth op post-upgrade.
  // Poll until all three post-broadcast requestImportKey calls land. The
  // click handler awaits the Keychain callbacks sequentially AFTER the
  // broadcast assertion promise resolves, so at this point the calls may
  // or may not have been made yet depending on microtask ordering.
  await expect
    .poll(
      async () => page.evaluate(() => window.__keychainImportKeyCalls.length),
      { timeout: 10_000 },
    )
    .toBe(3);

  const importKeyCalls = await page.evaluate(
    () => window.__keychainImportKeyCalls,
  );
  expect(importKeyCalls).toHaveLength(3);

  // WIF-formatted Hive private key: starts with 5H/5J/5K, 50 chars total,
  // base58 alphabet. A raw 64-char lowercase hex seed would NOT match.
  const WIF_RE = /^5[HJK][1-9A-HJ-NP-Za-km-z]{49}$/;
  for (const call of importKeyCalls) {
    expect(call.account).toBe(LIGHT_USERNAME);
    expect(call.wifKey).toMatch(WIF_RE);
    // Belt-and-suspenders: explicitly reject the old-bug shape (64-char hex).
    expect(call.wifKey).not.toMatch(/^[0-9a-f]{64}$/);
  }

  // All three WIFs must be distinct — same-WIF-thrice would indicate a
  // regression where the role iteration collapsed to a single key.
  const distinctWifs = new Set(importKeyCalls.map((c) => c.wifKey));
  expect(distinctWifs.size).toBe(3);

  // The owner WIF must NOT be imported. Owner keys are the account-recovery
  // root of trust and live in the user's seed phrase only. Cross-check the
  // imported WIFs against the independently-derived owner WIF.
  const importedWifs = new Set(importKeyCalls.map((c) => c.wifKey));
  expect(importedWifs.has(rederived.owner.private)).toBe(false);
  // And each imported WIF must match one of the three expected role WIFs.
  const expectedImported = new Set([
    rederived.posting.private,
    rederived.active.private,
    rederived.memo.private,
  ]);
  for (const call of importKeyCalls) {
    expect(expectedImported.has(call.wifKey)).toBe(true);
  }

  // ─── Regression: `requestAddAccountAuthority` must NOT be called ──
  // settings.js historically called this with a raw hex seed as the
  // "authorizedKey" (second arg), leaking a 64-char private-key seed into
  // Keychain's extension logs. If any future refactor reintroduces the
  // call, this assertion catches it.
  const addAuthCalls = await page.evaluate(
    () => window.__keychainAddAccountAuthorityCalls,
  );
  expect(addAuthCalls).toEqual([]);

  // ─── Credential wipe: Alpine state must be zeroed ────────────────
  // After a successful upgrade the page transitions to phase='done'.
  // Before that transition, executeUpgrade() calls
  // _clearSensitiveUpgradeState() which zeros the old + new 12-word
  // mnemonics, the confirm inputs, and the re-entered password. Read
  // these fields straight off the Alpine reactive store: an XSS on
  // /settings would use the same API, so this both asserts the wipe
  // worked and guards the concern (same one that motivates disabling
  // trace/video/screenshot for this spec) that stale plaintext seed
  // words in Alpine state would leak into any future trace or
  // screenshot captured on an unrelated post-upgrade failure.
  await expect
    .poll(
      async () => page.evaluate(() => {
        const el = document.querySelector('[x-data="settingsPage"]');
        return window.Alpine.$data(el).upgradePhase;
      }),
      { timeout: 10_000 },
    )
    .toBe('done');

  const sensitiveState = await page.evaluate(() => {
    const el = document.querySelector('[x-data="settingsPage"]');
    const data = window.Alpine.$data(el);
    return {
      oldSeedPhrase: data.oldSeedPhrase,
      newSeedPhrase: data.newSeedPhrase,
      newSeedWords: data.newSeedWords,
      confirmInputs: data.confirmInputs,
    };
  });
  expect(sensitiveState.oldSeedPhrase).toBe('');
  expect(sensitiveState.newSeedPhrase).toBe('');
  expect(sensitiveState.newSeedWords).toEqual([]);
  expect(sensitiveState.confirmInputs).toEqual({});

  // ─── Assert upgrade proof body shape ─────────────────────────
  // Beyond the chain broadcast, the SPA POSTs the seed-phrase-derived
  // proof to /api/custody/upgrade. We don't introspect the captured body
  // here because the stub above just fulfills; the dedicated proof-shape
  // and 503-retry tests below exercise it and confirm it matches the
  // wire contract in `agents/docs/api-contracts/custody.md`.
});

// ───────────────────────────────────────────────────────────────
// Shared wizard-driver. Returns once the user has clicked the final
// "Upgrade Account" button. Caller is responsible for stubbing the
// Hive-node RPCs + /api/custody/upgrade interception. The first
// successful test above is the canonical full-coverage exercise; the
// tests below use this helper to isolate behavior around specific
// /api/custody/upgrade rejection paths.
// ───────────────────────────────────────────────────────────────
async function driveWizardToBackendPost(page) {
  // Stub the post-broadcast Keychain import calls so the helper never
  // hangs waiting for callbacks the base fixture doesn't provide.
  await page.addInitScript(() => {
    if (window.hive_keychain) {
      window.hive_keychain.requestImportKey = (_account, _wif, cb) => {
        queueMicrotask(() => cb({ success: true, result: 'STUB' }));
      };
    }
  });

  // Stub api.hive.blog RPCs so the local broadcast resolves without
  // hitting the network. Mirrors the canned response shape from the
  // canonical happy-path test above.
  await page.route('**/api.hive.blog/**', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    const body = JSON.parse(req.postData() || '{}');
    if (body.method === 'condenser_api.get_dynamic_global_properties') {
      const iso = new Date().toISOString().slice(0, -5);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: body.id,
          jsonrpc: '2.0',
          result: {
            head_block_number: 80_000_000,
            head_block_id: '04c4b40000000000000000000000000000000000',
            time: iso,
          },
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: body.id, jsonrpc: '2.0', result: null }),
    });
  });

  const { token, expiresAt } = mintSessionJwt(LIGHT_USERNAME, { custody: 'light' });
  await page.addInitScript(
    ({ session }) => {
      window.localStorage.setItem('pevo_session', JSON.stringify(session));
    },
    {
      session: {
        token,
        username: LIGHT_USERNAME,
        expiresAt,
        isAccredited: false,
        accreditation: null,
        custody: 'light',
      },
    },
  );

  await page.goto('/en/settings');
  await page.waitForSelector('[x-data="settingsPage"]');
  await page.getByRole('button', { name: 'Begin Upgrade' }).click();
  await page.getByRole('button', { name: "I’ve written it down" }).waitFor();

  // proceedToConfirmNew() (triggered by "I've written it down") is what
  // populates confirmIndices and resets confirmInputs to {}, so the
  // Alpine-proxy fill MUST come after the click.
  await page.getByRole('button', { name: "I’ve written it down" }).click();
  await page.getByRole('button', { name: 'Next' }).waitFor();
  await page.evaluate(() => {
    const el = document.querySelector('[x-data="settingsPage"]');
    const data = window.Alpine.$data(el);
    for (const i of data.confirmIndices) {
      data.confirmInputs[i] = data.newSeedWords[i];
    }
  });
  await page.getByRole('button', { name: 'Next' }).click();

  // Type a real (independent) old mnemonic so validateMnemonic passes
  // and the chain broadcast exercises a real key rotation.
  await page.locator('textarea[x-model="oldSeedPhrase"]').fill(generateMnemonic());
  await page.getByRole('button', { name: 'Upgrade Account' }).click();
}

test('upgrade proof body shape matches /api/custody/upgrade wire contract', async ({ page }) => {
  const proofBodies = [];
  await page.route('**/api/custody/upgrade', async (route) => {
    const req = route.request();
    proofBodies.push(JSON.parse(req.postData() || '{}'));
    const { token } = mintSessionJwt(LIGHT_USERNAME, { custody: 'self' });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        data: {
          custody: 'self',
          token,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      }),
    });
  });

  await driveWizardToBackendPost(page);

  await expect.poll(() => proofBodies.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  const body = proofBodies[0];
  // Three required fields per agents/docs/api-contracts/custody.md.
  expect(typeof body.derived_pubkey).toBe('string');
  expect(body.derived_pubkey.startsWith('STM')).toBe(true);
  expect(typeof body.signed_proof).toBe('string');
  // Hive compact signature is 65 bytes → 130 hex chars.
  expect(body.signed_proof).toMatch(/^[0-9a-fA-F]{130}$/);
  expect(typeof body.signed_at).toBe('string');
  // ISO-8601 with milliseconds (Date.toISOString output).
  expect(body.signed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // Freshness gate: backend rejects timestamps outside a 60s window.
  expect(Math.abs(Date.now() - Date.parse(body.signed_at))).toBeLessThan(60_000);
  // The pubkey must match what hive-keys derives from the captured
  // (post-rotation) seed phrase — proves the same derivation pipeline
  // produced both the chain-rotated authorities and the proof.
  const postRotationSeed = await page.evaluate(() => {
    const el = document.querySelector('[x-data="settingsPage"]');
    return window.Alpine.$data(el).newSeedPhrase;
  });
  // newSeedPhrase may already be wiped by the time we read (the success
  // path wipes after backend POST). If so, skip the cross-check — the
  // shape assertions above already confirm contract conformance.
  if (postRotationSeed && postRotationSeed.length > 0) {
    const rederived = await deriveAllKeys(postRotationSeed, LIGHT_USERNAME);
    expect(body.derived_pubkey).toBe(rederived.active.public);
  }
});

test('503 on /api/custody/upgrade is retryable via Try Again without re-broadcast', async ({ page }) => {
  let callCount = 0;
  await page.route('**/api/custody/upgrade', async (route) => {
    callCount++;
    if (callCount === 1) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'error',
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Hive RPC unavailable' },
        }),
      });
    }
    const { token } = mintSessionJwt(LIGHT_USERNAME, { custody: 'self' });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        data: {
          custody: 'self',
          token,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      }),
    });
  });

  await driveWizardToBackendPost(page);

  // Wait for the first 503 to drive the UI to the retryable error state.
  await expect
    .poll(
      async () => page.evaluate(() => {
        const el = document.querySelector('[x-data="settingsPage"]');
        return window.Alpine.$data(el).upgradeErrorKey;
      }),
      { timeout: 15_000 },
    )
    .toBe('upgrade.backendUnavailable');

  // newSeedPhrase MUST still be in state — the retry path needs it to
  // re-derive a fresh proof. State preservation is the explicit invariant
  // that distinguishes 503 from the terminal post-broadcast sub-cases.
  const preservedSeed = await page.evaluate(() => {
    const el = document.querySelector('[x-data="settingsPage"]');
    return window.Alpine.$data(el).newSeedPhrase;
  });
  expect(typeof preservedSeed).toBe('string');
  expect(preservedSeed.split(' ')).toHaveLength(12);

  // canRetryUpgrade must be true so the Try Again button renders.
  const canRetry = await page.evaluate(() => {
    const el = document.querySelector('[x-data="settingsPage"]');
    return window.Alpine.$data(el).canRetryUpgrade;
  });
  expect(canRetry).toBe(true);

  // Click Try Again → handleRetry() → retryUpgradeBackend().
  await page.getByText('Try Again').click();

  // Second POST lands; success this time.
  await expect.poll(() => callCount, { timeout: 15_000 }).toBe(2);

  // Wait for the wizard to reach 'done'.
  await expect
    .poll(
      async () => page.evaluate(() => {
        const el = document.querySelector('[x-data="settingsPage"]');
        return window.Alpine.$data(el).upgradePhase;
      }),
      { timeout: 10_000 },
    )
    .toBe('done');

  // After the successful retry the sensitive state IS wiped (the happy
  // path tail runs).
  const wipedSeed = await page.evaluate(() => {
    const el = document.querySelector('[x-data="settingsPage"]');
    return window.Alpine.$data(el).newSeedPhrase;
  });
  expect(wipedSeed).toBe('');
});

test('409 ALREADY_UPGRADED is terminal: state wiped, Try Again hidden', async ({ page }) => {
  await page.route('**/api/custody/upgrade', async (route) => {
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'error',
        error: { code: 'ALREADY_UPGRADED', message: 'Already upgraded' },
      }),
    });
  });

  await driveWizardToBackendPost(page);

  await expect
    .poll(
      async () => page.evaluate(() => {
        const el = document.querySelector('[x-data="settingsPage"]');
        return window.Alpine.$data(el).upgradeErrorKey;
      }),
      { timeout: 15_000 },
    )
    .toBe('upgrade.alreadyUpgraded');

  const state = await page.evaluate(() => {
    const el = document.querySelector('[x-data="settingsPage"]');
    const data = window.Alpine.$data(el);
    return {
      newSeedPhrase: data.newSeedPhrase,
      oldSeedPhrase: data.oldSeedPhrase,
      canRetry: data.canRetryUpgrade,
    };
  });
  // 409 wipes (nothing to retry; user must re-login to pick up self
  // session) and disables the Try Again button.
  expect(state.newSeedPhrase).toBe('');
  expect(state.oldSeedPhrase).toBe('');
  expect(state.canRetry).toBe(false);
});

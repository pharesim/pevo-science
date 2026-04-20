/**
 * Keychain fixture — injects a stubbed `window.hive_keychain` into every page
 * before any page script runs, so flows that probe for Keychain availability
 * or call `requestSignBuffer` can exercise the code path without a real wallet.
 *
 * IMPORTANT — driver-only constraint:
 * The returned signature is a deterministic stub prefixed with `STUB_SIG_`.
 * The backend's Hive-signature middleware will reject it (no valid Hive
 * pubkey will ever verify). Tests using this fixture therefore CANNOT assert
 * a 2xx from any endpoint guarded by `verifyHiveSignature`. They must stop
 * at the "UI reached expected state / fired expected request" layer.
 *
 * End-to-end signature verification is deliberately kept out of automation;
 * it is part of the manual pre-deploy check. See TEST-003 for the
 * deterministic, keyless equivalence test that replaces the in-browser
 * Keychain smoke test from SEC-001.
 */

import { test as base, expect } from '@playwright/test';
import { recordCid } from './captured-cids.js';

const INJECT_SCRIPT = `
  (function installStubKeychain() {
    async function sha256Hex(str) {
      const bytes = new TextEncoder().encode(str);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }

    window.hive_keychain = {
      requestSignBuffer(username, message, keyType, callback) {
        sha256Hex(String(message)).then((hex) => {
          callback({
            success: true,
            result: 'STUB_SIG_' + hex.slice(0, 16),
            publicKey: 'STM_STUB',
            data: { username, message, keyType },
          });
        });
      },
    };
  })();
`;

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    await page.addInitScript(INJECT_SCRIPT);

    // Record CIDs from any successful IPFS upload so global-teardown can
    // unpin them. Listener is attached once per page regardless of whether
    // the test actually uploads anything.
    page.on('response', async (response) => {
      const url = response.url();
      if (!url.endsWith('/api/ipfs/upload')) return;
      if (response.status() !== 200) return;
      try {
        const body = await response.json();
        const cid = body?.data?.cid ?? body?.cid;
        if (cid) recordCid(cid, { testTitle: testInfo.title });
      } catch {
        // non-JSON or stream already consumed — nothing to record
      }
    });

    await use(page);
  },
});

export { expect };

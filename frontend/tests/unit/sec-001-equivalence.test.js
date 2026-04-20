import { describe, it, expect, vi, beforeEach } from 'vitest';

// TEST-003: prove the frontend's signed message is byte-identical to the string
// the backend verifies, driven from the backend's own helper so drift in either
// direction breaks this test. The backend helper is the single source of truth;
// we do NOT re-implement the canonical format here.
//
// Only the Keychain and the app-tag getter are mocked. The real Web Crypto
// `sha256Hex` runs on the frontend side, and the real `cryptoUtils.sha256` runs
// inside `buildCanonicalAuthMessage` on the backend side — this is what
// exercises the end-to-end equivalence.

vi.mock('../../src/keychain.js', () => ({
  signMessage: vi.fn(async (_username, message) => ({
    signature: `STUB_SIG_${message.length}`,
  })),
}));

vi.mock('../../src/config.js', () => ({
  getAppTag: vi.fn(() => 'pevotest'),
}));

import { signRequest } from '../../src/sign-request.js';
import { signMessage } from '../../src/keychain.js';
import { buildCanonicalAuthMessage } from '../../../backend/src/lib/authMessage.ts';

const APP_TAG = 'pevotest';

async function captureFrontendMessage(method, path, body) {
  signMessage.mockClear();
  await signRequest('alice', method, path, body);
  expect(signMessage).toHaveBeenCalledTimes(1);
  const [, message] = signMessage.mock.calls[0];
  // Canonical format: {appTag}-auth|v1|{METHOD}|{path}|{bodyHash}|{timestamp}
  // The timestamp is generated inside signRequest, so we extract it and feed
  // it back into the backend helper to pin both sides to the same inputs.
  const timestamp = message.split('|')[5];
  return { message, timestamp };
}

describe('SEC-001 frontend/backend canonical-message equivalence', () => {
  beforeEach(() => {
    signMessage.mockClear();
  });

  it('POST /api/auth/session with body {} matches backend helper', async () => {
    const method = 'POST';
    const path = '/api/auth/session';
    const body = {};

    const { message: frontendMessage, timestamp } = await captureFrontendMessage(method, path, body);
    const backendMessage = buildCanonicalAuthMessage({
      appTag: APP_TAG,
      method,
      path,
      body,
      timestamp,
    });

    expect(frontendMessage).toBe(backendMessage);
  });

  it('POST /api/auth/link with body { auth_token: "abc123" } matches backend helper', async () => {
    const method = 'POST';
    const path = '/api/auth/link';
    const body = { auth_token: 'abc123' };

    const { message: frontendMessage, timestamp } = await captureFrontendMessage(method, path, body);
    const backendMessage = buildCanonicalAuthMessage({
      appTag: APP_TAG,
      method,
      path,
      body,
      timestamp,
    });

    expect(frontendMessage).toBe(backendMessage);
  });

  it('GET /api/anything with undefined body matches backend helper (hashes {})', async () => {
    // Per the SEC-001-FIXUP decision (archived 2026-04-20): bodyless requests
    // still hash JSON.stringify({}) on both sides, no GET-specific branch.
    const method = 'GET';
    const path = '/api/anything';

    const { message: frontendMessage, timestamp } = await captureFrontendMessage(method, path, undefined);
    const backendMessage = buildCanonicalAuthMessage({
      appTag: APP_TAG,
      method,
      path,
      body: undefined,
      timestamp,
    });

    expect(frontendMessage).toBe(backendMessage);
  });

  it('path with an author/permlink segment matches backend helper (no decodeURIComponent drift)', async () => {
    const method = 'GET';
    const path = '/api/papers/alice/some-permlink';

    const { message: frontendMessage, timestamp } = await captureFrontendMessage(method, path, undefined);
    const backendMessage = buildCanonicalAuthMessage({
      appTag: APP_TAG,
      method,
      path,
      body: undefined,
      timestamp,
    });

    expect(frontendMessage).toBe(backendMessage);
  });
});

import { describe, it, expect } from 'vitest';
import { cryptoUtils } from '@hiveio/dhive';
import { buildCanonicalAuthMessage } from '../../src/lib/authMessage.js';

// Locks the canonical auth-message format against drift. Both this test and the
// frontend equivalence test (TEST-003, frontend/tests/unit/sec-001-equivalence.test.js)
// must pass — together they guarantee the signed message is byte-identical on
// both sides of the wire.

describe('buildCanonicalAuthMessage', () => {
  it('matches the documented format for a typical POST with body', () => {
    const timestamp = '2026-04-20T12:00:00.000Z';
    const body = { auth_token: 'abc123' };
    const expectedBodyHash = cryptoUtils.sha256(JSON.stringify(body)).toString('hex');

    const msg = buildCanonicalAuthMessage({
      appTag: 'pevotest',
      method: 'POST',
      path: '/api/auth/link',
      body,
      timestamp,
    });

    expect(msg).toBe(`pevotest-auth|v1|POST|/api/auth/link|${expectedBodyHash}|${timestamp}`);
  });

  it('hashes an empty object for undefined/null body (GET path)', () => {
    const timestamp = '2026-04-20T12:00:00.000Z';
    const emptyHash = cryptoUtils.sha256(JSON.stringify({})).toString('hex');

    const msgUndef = buildCanonicalAuthMessage({
      appTag: 'pevotest',
      method: 'GET',
      path: '/api/papers/alice/some-permlink',
      body: undefined,
      timestamp,
    });
    const msgNull = buildCanonicalAuthMessage({
      appTag: 'pevotest',
      method: 'GET',
      path: '/api/papers/alice/some-permlink',
      body: null,
      timestamp,
    });
    const msgEmptyObj = buildCanonicalAuthMessage({
      appTag: 'pevotest',
      method: 'GET',
      path: '/api/papers/alice/some-permlink',
      body: {},
      timestamp,
    });

    const expected = `pevotest-auth|v1|GET|/api/papers/alice/some-permlink|${emptyHash}|${timestamp}`;
    expect(msgUndef).toBe(expected);
    expect(msgNull).toBe(expected);
    expect(msgEmptyObj).toBe(expected);
  });

  it('varies the output when any input changes', () => {
    const base = {
      appTag: 'pevotest',
      method: 'POST',
      path: '/api/auth/session',
      body: {},
      timestamp: '2026-04-20T12:00:00.000Z',
    };
    const baseline = buildCanonicalAuthMessage(base);

    expect(buildCanonicalAuthMessage({ ...base, appTag: 'pevo' })).not.toBe(baseline);
    expect(buildCanonicalAuthMessage({ ...base, method: 'GET' })).not.toBe(baseline);
    expect(buildCanonicalAuthMessage({ ...base, path: '/api/auth/sessionx' })).not.toBe(baseline);
    expect(buildCanonicalAuthMessage({ ...base, body: { x: 1 } })).not.toBe(baseline);
    expect(buildCanonicalAuthMessage({ ...base, timestamp: '2026-04-20T12:00:01.000Z' })).not.toBe(baseline);
  });

  it('embeds the timestamp verbatim for both string and number inputs', () => {
    const emptyHash = cryptoUtils.sha256(JSON.stringify({})).toString('hex');

    const strMsg = buildCanonicalAuthMessage({
      appTag: 'pevotest',
      method: 'POST',
      path: '/api/auth/session',
      body: {},
      timestamp: '2026-04-20T12:00:00.000Z',
    });
    expect(strMsg.endsWith(`|${emptyHash}|2026-04-20T12:00:00.000Z`)).toBe(true);

    const numMsg = buildCanonicalAuthMessage({
      appTag: 'pevotest',
      method: 'POST',
      path: '/api/auth/session',
      body: {},
      timestamp: 1745150400000,
    });
    expect(numMsg.endsWith(`|${emptyHash}|1745150400000`)).toBe(true);
  });
});

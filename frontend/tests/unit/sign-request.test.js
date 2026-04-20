import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sha256Hex } from '../../src/crypto.js';

// Mock only Keychain and config — the real sha256Hex must run so we exercise
// the actual Web Crypto code path. (This test file must not mock crypto.js.)
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

const TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('signRequest', () => {
  beforeEach(() => {
    signMessage.mockClear();
  });

  it('builds the canonical message "{appTag}-auth|v1|{METHOD}|{path}|{bodyHash}|{ts}" for a POST with a body', async () => {
    const body = { auth_token: 'abc123' };
    const envelope = await signRequest('alice', 'POST', '/api/auth/link', body);

    expect(signMessage).toHaveBeenCalledTimes(1);
    const [username, message] = signMessage.mock.calls[0];
    expect(username).toBe('alice');

    const parts = message.split('|');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('pevotest-auth');
    expect(parts[1]).toBe('v1');
    expect(parts[2]).toBe('POST');
    expect(parts[3]).toBe('/api/auth/link');
    expect(parts[4]).toBe(await sha256Hex(JSON.stringify(body)));
    expect(parts[5]).toMatch(TS_PATTERN);
    expect(envelope.headers['X-Hive-Timestamp']).toBe(parts[5]);
  });

  it('hashes JSON.stringify({}) for a GET with no body (matches backend body-hash rule)', async () => {
    // Per SEC-001-FIXUP (archived 2026-04-20): body is serialized as
    // JSON.stringify(body ?? {}) in ALL cases, including GET.
    await signRequest('alice', 'GET', '/api/notifications', undefined);

    const [, message] = signMessage.mock.calls[0];
    const bodyHash = message.split('|')[4];
    expect(bodyHash).toBe(await sha256Hex('{}'));
  });

  it('hashes JSON.stringify({}) when bodyObject is explicitly null', async () => {
    await signRequest('alice', 'POST', '/api/foo', null);
    const [, message] = signMessage.mock.calls[0];
    expect(message.split('|')[4]).toBe(await sha256Hex('{}'));
  });

  it('returns all three X-Hive-* headers', async () => {
    const envelope = await signRequest('alice', 'POST', '/api/x', { ok: true });

    expect(Object.keys(envelope.headers).sort()).toEqual([
      'X-Hive-Signature',
      'X-Hive-Timestamp',
      'X-Hive-Username',
    ]);
    expect(envelope.headers['X-Hive-Username']).toBe('alice');
    expect(envelope.headers['X-Hive-Signature']).toMatch(/^STUB_SIG_\d+$/);
    expect(envelope.headers['X-Hive-Timestamp']).toMatch(TS_PATTERN);
  });

  it('sets envelope.body to the serialized body string for POST/PUT/PATCH/DELETE', async () => {
    const body = { a: 1 };
    const expected = JSON.stringify(body);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const envelope = await signRequest('alice', method, '/api/x', body);
      expect(envelope.body).toBe(expected);
    }
  });

  it('sets envelope.body to undefined for GET and HEAD', async () => {
    for (const method of ['GET', 'HEAD']) {
      const envelope = await signRequest('alice', method, '/api/x', { a: 1 });
      expect(envelope.body).toBeUndefined();
    }
  });

  it('uses a freshly-generated ISO timestamp on each call', async () => {
    const a = await signRequest('alice', 'POST', '/api/x', {});
    await new Promise((r) => setTimeout(r, 2));
    const b = await signRequest('alice', 'POST', '/api/x', {});
    expect(a.headers['X-Hive-Timestamp']).toMatch(TS_PATTERN);
    expect(b.headers['X-Hive-Timestamp']).toMatch(TS_PATTERN);
    expect(a.headers['X-Hive-Timestamp']).not.toBe(b.headers['X-Hive-Timestamp']);
  });
});

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { PrivateKey, cryptoUtils } from '@hiveio/dhive';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';

// Generate a deterministic test keypair and mock the Hive client so the
// middleware's on-chain account lookup returns this public key for the
// test username. Tests that exercise the real verifyHiveSignature
// end-to-end use this to produce genuinely valid signatures.
const TEST_USERNAME = 'testauthuser';
const TEST_PRIVATE_KEY = PrivateKey.fromSeed('pevo-auth-test-seed-deterministic');
const TEST_PUBLIC_KEY = TEST_PRIVATE_KEY.createPublic().toString();

vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: {
      getAccounts: vi.fn().mockImplementation((names: string[]) => {
        if (names.includes(TEST_USERNAME)) {
          return Promise.resolve([
            { name: TEST_USERNAME, posting: { key_auths: [[TEST_PUBLIC_KEY, 1]] } },
          ]);
        }
        return Promise.resolve([]);
      }),
    },
  },
}));

const app = createApp();

function signRequestBound(method: string, fullPath: string, body: unknown, timestamp: string): string {
  const bodyHash = cryptoUtils.sha256(JSON.stringify(body || {})).toString('hex');
  const msg = `${config.appTag}-auth|v1|${method}|${fullPath}|${bodyHash}|${timestamp}`;
  const msgHash = cryptoUtils.sha256(msg);
  return TEST_PRIVATE_KEY.sign(msgHash).toString();
}

describe('POST /api/auth/session', () => {
  it('returns 401 without signature headers', async () => {
    const res = await request(app)
      .post('/api/auth/session')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('issues JWT when called with valid request-bound Hive signature', async () => {
    const timestamp = new Date().toISOString();
    const body = {};
    const signature = signRequestBound('POST', '/api/auth/session', body, timestamp);

    const res = await request(app)
      .post('/api/auth/session')
      .set('X-Hive-Username', TEST_USERNAME)
      .set('X-Hive-Signature', signature)
      .set('X-Hive-Timestamp', timestamp)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.token).toBeTruthy();
    const decoded = jwt.verify(res.body.data.token, config.sessionSecret) as { sub: string };
    expect(decoded.sub).toBe(TEST_USERNAME);
  });
});

describe('Bearer JWT authentication', () => {
  it('accepts valid Bearer JWT on authenticated endpoints', async () => {
    const token = jwt.sign({ sub: 'testuser123' }, config.sessionSecret, { expiresIn: '1h' });

    const res = await request(app)
      .get('/api/notifications?since_block=1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).not.toBe(401);
    expect(res.body.error?.code).not.toBe('UNAUTHORIZED');
  });

  it('rejects expired JWT and falls back to Hive sig check (returns 401)', async () => {
    const token = jwt.sign({ sub: 'testuser123' }, config.sessionSecret, { expiresIn: '-1s' });

    const res = await request(app)
      .get('/api/notifications?since_block=1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects JWT with wrong secret and falls back to Hive sig check (returns 401)', async () => {
    const token = jwt.sign({ sub: 'testuser123' }, 'wrong-secret', { expiresIn: '1h' });

    const res = await request(app)
      .get('/api/notifications?since_block=1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects malformed Bearer token and falls back to Hive sig check (returns 401)', async () => {
    const res = await request(app)
      .get('/api/notifications?since_block=1')
      .set('Authorization', 'Bearer not-a-real-jwt');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('Hive signature path — request-binding enforcement (FINDING-001 regressions)', () => {
  it('rejects when X-Hive-Timestamp is missing', async () => {
    const res = await request(app)
      .post('/api/auth/session')
      .set('X-Hive-Username', TEST_USERNAME)
      .set('X-Hive-Signature', 'SIG_K1_anything')
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('X-Hive-Timestamp is required');
  });

  it('rejects a valid signature made over a different (captured) message', async () => {
    // Simulates an attacker replaying a signature captured from another dApp
    // or another endpoint. The signature is cryptographically valid and from
    // the correct private key, but it was produced over a payload that is NOT
    // the request-bound message, so the server must reject it.
    const timestamp = new Date().toISOString();
    const capturedMsg = `pevo-auth-${Date.now()}-${Math.random()}`; // old pre-FINDING-001 challenge format
    const capturedMsgHash = cryptoUtils.sha256(capturedMsg);
    const capturedSignature = TEST_PRIVATE_KEY.sign(capturedMsgHash).toString();

    const res = await request(app)
      .post('/api/auth/session')
      .set('X-Hive-Username', TEST_USERNAME)
      .set('X-Hive-Signature', capturedSignature)
      .set('X-Hive-Timestamp', timestamp)
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a signature produced against a different path (cross-endpoint replay)', async () => {
    // Signature bound to /api/auth/session must not authenticate /api/notifications.
    const timestamp = new Date().toISOString();
    const signature = signRequestBound('POST', '/api/auth/session', {}, timestamp);

    const res = await request(app)
      .get('/api/notifications?since_block=1')
      .set('X-Hive-Username', TEST_USERNAME)
      .set('X-Hive-Signature', signature)
      .set('X-Hive-Timestamp', timestamp);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an expired timestamp (>60s old)', async () => {
    const timestamp = new Date(Date.now() - 120_000).toISOString();
    const signature = signRequestBound('POST', '/api/auth/session', {}, timestamp);

    const res = await request(app)
      .post('/api/auth/session')
      .set('X-Hive-Username', TEST_USERNAME)
      .set('X-Hive-Signature', signature)
      .set('X-Hive-Timestamp', timestamp)
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 with malformed Hive signature (real middleware runs)', async () => {
    const res = await request(app)
      .get('/api/notifications?since_block=1')
      .set('X-Hive-Username', 'someuser')
      .set('X-Hive-Signature', 'invalid-sig-value')
      .set('X-Hive-Timestamp', new Date().toISOString());

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

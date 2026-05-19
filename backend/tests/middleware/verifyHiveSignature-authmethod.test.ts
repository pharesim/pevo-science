/**
 * Real-path pin for the `req.hiveAuthMethod` field set by
 * `verifyHiveSignature`. JWT-success branch sets `'jwt'`; signature-success
 * branch sets `'signature'`; auth failures leave the field unset.
 *
 * Exercises both branches of the unified middleware against the real
 * `jsonwebtoken` library and against cryptographic recovery + posting-key
 * match on a deterministic test keypair (same pattern as
 * `routes/auth.test.ts`). No `MOCK_VERIFY_SIGNATURE` fixture: this is the
 * real-path companion to the fixture-driven route tests in
 * `tests/routes/settings-email-fresh-auth.test.ts`.
 *
 * Test-mock carve-out (per root CLAUDE.md "Running Tests"):
 *
 *   (a) Justification: this test mounts a stub Express app that exposes a
 *   tiny `/probe` endpoint guarded by the real `verifyHiveSignature`. The
 *   endpoint echoes `req.hiveAuthMethod` so the test can assert the field
 *   value end-to-end. `hiveClient.database.getAccounts` is stubbed via
 *   `vi.mock('../../src/hive.js', ...)` to publish the test public key for
 *   TEST_USERNAME — same approach as `routes/auth.test.ts`. Running real
 *   getAccounts against the live chain per-test would couple the test to
 *   network behavior unrelated to the field-setting predicate under test.
 *
 *   (b) verifyHiveSignature is NOT mocked. This is exactly the carve-out
 *   point that root CLAUDE.md flags: the focus of this test IS auth-path
 *   discrimination, so cryptographic verification must run real.
 *
 *   (c) Risk class — drift between the JWT-success and signature-success
 *   branches (or omission of the field on a future third path) — is also
 *   covered by `routes/settings-email-fresh-auth.test.ts` (route-level
 *   downstream consumption, via MOCK_VERIFY_SIGNATURE which mirrors the
 *   discriminator's wire-shape gate). This middleware test is the real-
 *   path companion that ensures the production middleware actually sets
 *   the field at the points the route tests rely on.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { PrivateKey } from '@hiveio/dhive';
import { config } from '../../src/config.js';
import { verifyHiveSignature } from '../../src/middleware/verifyHiveSignature.js';
import { signRequestBound as signRequestBoundShared } from '../support/sign-request.js';

const TEST_USERNAME = 'authmethoduser';
const TEST_PRIVATE_KEY = PrivateKey.fromSeed('pevo-authmethod-test-seed-deterministic');
const TEST_PUBLIC_KEY = TEST_PRIVATE_KEY.createPublic().toString();

// vi.mock is hoisted by Vitest above the imports, so the middleware's
// `../hive.js` import already resolves to this stub when it loads. Same
// pattern as `routes/auth.test.ts`.
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

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/probe', verifyHiveSignature, (req: Request, res: Response) => {
    res.status(200).json({
      hiveUsername: req.hiveUsername,
      hiveCustody: req.hiveCustody,
      hiveAuthMethod: req.hiveAuthMethod,
    });
  });
  return app;
}

function signRequestBound(method: string, fullPath: string, body: unknown, timestamp: string): string {
  return signRequestBoundShared(TEST_PRIVATE_KEY, method, fullPath, body, timestamp);
}

describe('verifyHiveSignature — req.hiveAuthMethod discriminator', () => {
  it('sets hiveAuthMethod = "jwt" on the Bearer-JWT success branch', async () => {
    const app = makeApp();
    const token = jwt.sign({ sub: TEST_USERNAME, custody: 'self' }, config.sessionSecret, {
      expiresIn: '5m',
    });

    const res = await request(app)
      .post('/probe')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.hiveUsername).toBe(TEST_USERNAME);
    expect(res.body.hiveAuthMethod).toBe('jwt');
  });

  it('sets hiveAuthMethod = "signature" on the Hive-signature success branch', async () => {
    const app = makeApp();
    const timestamp = new Date().toISOString();
    const body = { probe: true };
    const signature = signRequestBound('POST', '/probe', body, timestamp);

    const res = await request(app)
      .post('/probe')
      .set('X-Hive-Username', TEST_USERNAME)
      .set('X-Hive-Signature', signature)
      .set('X-Hive-Timestamp', timestamp)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.hiveUsername).toBe(TEST_USERNAME);
    expect(res.body.hiveAuthMethod).toBe('signature');
  });

  it('falls through from invalid Bearer to signature branch and sets "signature" when signature verifies', async () => {
    // An invalid JWT must NOT leave the field stamped as 'jwt'. The
    // middleware logs and falls through to the signature branch; if the
    // request also carries valid signature headers, the success branch
    // sets 'signature'. Pins the "set on the branch that successfully
    // authenticated" semantic — an earlier-branch failure cannot leak
    // its method label into the eventual success path.
    const app = makeApp();
    const expiredJwt = jwt.sign({ sub: TEST_USERNAME }, config.sessionSecret, { expiresIn: '-1s' });

    const timestamp = new Date().toISOString();
    const body = { probe: 'fallthrough' };
    const signature = signRequestBound('POST', '/probe', body, timestamp);

    const res = await request(app)
      .post('/probe')
      .set('Authorization', `Bearer ${expiredJwt}`)
      .set('X-Hive-Username', TEST_USERNAME)
      .set('X-Hive-Signature', signature)
      .set('X-Hive-Timestamp', timestamp)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.hiveAuthMethod).toBe('signature');
  });

  it('does not invoke the downstream handler on 401, so the field is never observed unset by a handler', async () => {
    // Failures (401 returns) leave `req.hiveAuthMethod` unset. The
    // middleware contract is "set on success only" — the request never
    // reaches a downstream handler on the 401 path, so this is implicit.
    // Pin it: a request with no JWT and no signature headers gets a 401
    // and never reaches the /probe handler that would echo the field.
    const app = makeApp();
    const res = await request(app).post('/probe').send({});
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('hiveAuthMethod');
  });

  it('rejects a Bearer JWT with no sub claim instead of setting hiveUsername=undefined', async () => {
    // Regression fence: the `as` cast on the decoded JWT payload does
    // not validate `sub` at runtime. A JWT signed without a `sub` claim
    // would otherwise pass the cast silently, write `undefined` to
    // `req.hiveUsername`, and call `next()` — leaving the request
    // "authenticated" with no username. The runtime guard immediately
    // after the cast skips the JWT-success branch on a missing or non-
    // string `sub`; the request then falls through to the Hive-
    // signature path, which 401s when no signature headers are
    // present (as here).
    const app = makeApp();
    const subLessToken = jwt.sign({ custody: 'self' }, config.sessionSecret, { expiresIn: '5m' });

    const res = await request(app)
      .post('/probe')
      .set('Authorization', `Bearer ${subLessToken}`)
      .send({});

    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('hiveAuthMethod');
    expect(res.body).not.toHaveProperty('hiveUsername');
  });
});

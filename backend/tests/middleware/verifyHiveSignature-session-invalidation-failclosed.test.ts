/**
 * Fail-closed pin for the JWT session-invalidation lookup in
 * verifyHiveSignature. The lookup of `accounts.sessions_invalidated_at` is the
 * revocation mechanism for stolen JWTs (password reset, key rotation). When the
 * query fails (DB outage, timeout), the middleware must return 503 rather than
 * honoring the JWT — allow-through silently re-grants every previously-revoked
 * token for the duration of the outage.
 *
 * Test-mock carve-out (per root CLAUDE.md "Running Tests"):
 *   (a) Justification: the real DB-failure path is impractical to exercise
 *       per-test — a live Postgres outage cannot be induced deterministically.
 *       `getAppPool` is stubbed via vi.mock so `.query` rejects (or returns a
 *       chosen row) on demand. The JWT itself is verified by the real
 *       jsonwebtoken library; only the shared pool helper is mocked (a
 *       permitted carve-out target).
 *   (b) verifyHiveSignature is NOT mocked: the focus here IS the middleware's
 *       own failure-mode branch, so the real middleware runs.
 *   (c) Real-path companion: happy-path JWT acceptance and the live
 *       SESSION_INVALIDATED 401 against real Postgres are covered by the
 *       settings password-reset suites.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../src/config.js';

const { queryMock, getAppPoolMock } = vi.hoisted(() => {
  const queryMock = vi.fn();
  // Return type is explicitly nullable so a test can simulate the
  // pool-not-ready startup state (getAppPool() === null).
  const getAppPoolMock = vi.fn((): { query: typeof queryMock } | null => ({ query: queryMock }));
  return { queryMock, getAppPoolMock };
});

vi.mock('../../src/app-db.js', () => ({
  getAppPool: getAppPoolMock,
}));

const { verifyHiveSignature } = await import('../../src/middleware/verifyHiveSignature.js');

const TEST_USERNAME = 'failcloseduser';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/probe', verifyHiveSignature, (req: Request, res: Response) => {
    res.status(200).json({ hiveUsername: req.hiveUsername });
  });
  return app;
}

function bearerJwt(): string {
  return jwt.sign({ sub: TEST_USERNAME, custody: 'light' }, config.sessionSecret, { expiresIn: '5m' });
}

function probe(token: string) {
  return request(makeApp()).post('/probe').set('Authorization', `Bearer ${token}`).send({});
}

describe('verifyHiveSignature — session-invalidation lookup fails closed', () => {
  beforeEach(() => {
    queryMock.mockReset();
    getAppPoolMock.mockReset();
    getAppPoolMock.mockReturnValue({ query: queryMock });
  });

  it('returns 503 SERVICE_UNAVAILABLE when the invalidation lookup throws', async () => {
    queryMock.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const res = await probe(bearerJwt());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    // The SPA's isRetriable503() gates on details.retriable === true; without
    // this flag the client treats the 503 as terminal instead of auto-retrying.
    expect(res.body.error.details.retriable).toBe(true);
  });

  it('honors the JWT when the lookup returns no invalidation row', async () => {
    queryMock.mockResolvedValue({ rows: [{ sessions_invalidated_at: null }] });
    const res = await probe(bearerJwt());
    expect(res.status).toBe(200);
    expect(res.body.hiveUsername).toBe(TEST_USERNAME);
  });

  it('rejects a JWT minted before sessions_invalidated_at with 401 SESSION_INVALIDATED', async () => {
    // invalidatedAt is in the future relative to the freshly-minted token's iat,
    // so payload.iat < invalidatedAt and the prior-session JWT is rejected.
    queryMock.mockResolvedValue({ rows: [{ sessions_invalidated_at: new Date(Date.now() + 60_000) }] });
    const res = await probe(bearerJwt());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_INVALIDATED');
  });

  it('does not 503 when getAppPool returns null (pool-not-ready startup state)', async () => {
    // A null pool is a configuration/startup state, not a runtime query failure;
    // the middleware skips the check and honors the JWT rather than failing closed.
    getAppPoolMock.mockReturnValue(null);
    const res = await probe(bearerJwt());
    expect(res.status).toBe(200);
    expect(res.body.hiveUsername).toBe(TEST_USERNAME);
  });
});

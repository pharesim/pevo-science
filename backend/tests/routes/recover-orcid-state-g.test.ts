/**
 * ORCID recovery (`POST /api/auth/recover` with `orcid_token`) refuses a state
 * G row.
 *
 * ARCHITECTURE.md § 6.4 limits ORCID recovery to the light states B and C. A
 * state G row (§ 6.1: a self-custody Keychain account whose row exists only
 * because it registered an email through settings, `custody` NULL) can carry a
 * verified email AND a linked ORCID, so the ORCID factor alone matched it
 * before the route gated on the derived custody claim. Recovery rebinds the
 * email and password of an account the server holds no keys for, so the
 * refusal is the same 401 and generic message the upgraded (state D) and
 * no-ORCID branches return, which keeps the route from becoming a custody
 * oracle.
 *
 * Real path, no mocking: real Postgres, real Redis, real route. The verified
 * ORCID nonce is seeded straight into Redis (and the in-memory fallback), the
 * same shape `POST /api/orcid/callback mode='signup'` writes, because the
 * OAuth round-trip that would mint it needs the remote ORCID provider. The
 * nonce matches the row's ORCID, so the custody gate is the only thing
 * standing between the request and a 200 recover.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { config } from '../../src/config.js';
import { getRedis, isRedisAvailable } from '../../src/redis.js';
import { orcidVerified } from '../../src/routes/orcid.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';

const app = createApp();

let dbReachable = false;
{
  const pool = getAppPool();
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
  }
}

const RUN = Date.now();
const G_USER = `recovg_${RUN}`;
const G_EMAIL = `recovg_${RUN}@example.com`;
// Valid ORCID shape, unique per run (migration 007 refuses a duplicate).
const ORCID_ID = `0009-0007-${String(RUN % 10000).padStart(4, '0')}-${String(Math.floor(RUN / 10000) % 1000).padStart(3, '0')}X`;
const nonces: string[] = [];

async function seedOrcidNonce(nonce: string, orcidId: string): Promise<void> {
  const payload = { orcid_id: orcidId, works_count: 5, name: 't' };
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(`${config.appTag}:orcid_verified:${nonce}`, JSON.stringify(payload), 'EX', 600);
  }
  // In-memory fallback too, so the test holds whether or not Redis is up.
  orcidVerified.set(nonce, { ...payload, expires: Date.now() + 600_000 });
  nonces.push(nonce);
}

async function cleanup(): Promise<void> {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [G_USER]).catch(() => {});
  await pool.query('DELETE FROM accounts WHERE username = $1', [G_USER]).catch(() => {});
}

describe.skipIf(!dbReachable)('ORCID recovery refuses a state G row', () => {
  beforeAll(async () => {
    await cleanup();
    const pool = getAppPool()!;
    // Verified state G with an ORCID linked: username set, custody NULL, no
    // epoch, no password, no encrypted keys, email verified (verify_token
    // NULL, expires_at cleared by the settings verify handler).
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, orcid, upgraded_at, verify_token, expires_at)
       VALUES ($1, $2, NULL, NULL, $3, NULL, NULL, NULL)`,
      [G_EMAIL, G_USER, ORCID_ID],
    );
  });

  afterAll(async () => {
    const redis = getRedis();
    for (const nonce of nonces) {
      orcidVerified.delete(nonce);
      if (redis && isRedisAvailable()) {
        await redis.del(`${config.appTag}:orcid_verified:${nonce}`).catch(() => {});
      }
    }
    await cleanup();
  });

  it('answers the generic 401 and leaves the row unchanged', async () => {
    await clearRateLimitKeys(['auth-recover']);
    const nonce = `recovg-nonce-${Date.now()}`;
    await seedOrcidNonce(nonce, ORCID_ID);

    const res = await request(app)
      .post('/api/auth/recover')
      .send({
        username: G_USER,
        new_email: `recovg_attacker_${Date.now()}@example.com`,
        new_password: 'TakenOver123',
        orcid_token: nonce,
      });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    // Same message the upgraded and no-ORCID branches return.
    expect(res.body.error.message).toBe('Account does not have a verified ORCID');
    expect(res.body.data?.token).toBeUndefined();

    const pool = getAppPool()!;
    const { rows } = await pool.query<{
      email: string;
      password_hash: string | null;
      sessions_invalidated_at: Date | null;
      custody: string | null;
    }>(
      'SELECT email, password_hash, sessions_invalidated_at, custody FROM accounts WHERE username = $1',
      [G_USER],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(G_EMAIL);
    expect(rows[0].password_hash).toBeNull();
    expect(rows[0].sessions_invalidated_at).toBeNull();
    expect(rows[0].custody).toBeNull();
  });
});

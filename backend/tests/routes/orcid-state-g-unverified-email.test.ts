/**
 * ORCID link and accredit refuse a caller whose state G row still carries an
 * unverified settings-registered email.
 *
 * ARCHITECTURE.md § 6.1 state G: a self-custody Keychain account whose
 * `accounts` row exists only because it registered an email through
 * `POST /api/settings/email`'s add flow; `verify_token` is random hex until
 * the mailed link is clicked. Decided 2026-10-05 (§ 6.2, § 6.3): while that
 * email is unverified the row is refused an ORCID, so `mode='link'` and
 * `mode='accredit'` (both write `accounts.orcid`) answer 409
 * `PENDING_UNVERIFIED`, and the row write itself skips such a row. The authoritative check runs in the callback
 * handlers before any broadcast, cache write or row write; `/start` refuses
 * the same caller early so the user is not sent through the OAuth round trip
 * for nothing. A caller with no row, or with a verified row, is unaffected.
 *
 * The callback cases reach the gate the way a real user can: `/start` while
 * the caller has no row (it passes), then the caller registers an email (the
 * unverified G row appears), then the callback arrives.
 *
 * Carve-out justification (root CLAUDE.md "Running Tests"):
 *   (a) Two third-party surfaces are stubbed because neither can be driven
 *       for real per-test: the ORCID provider (`fetch` to `/oauth/token` and
 *       the public works API; a remote identity provider with no test
 *       tenancy) and the Hive admin broadcast (`broadcastAdminCustomJson`; the
 *       suite must never sign a real on-chain accreditation). The broadcast
 *       stub rejects, so a request that wrongly gets past the gate stops at a
 *       502 instead of running the post-broadcast cascade. Postgres, Redis,
 *       the HAF accreditation reads, the OAuth state round trip through
 *       `/api/orcid/start`, and JWT verification all run real.
 *   (b) `verifyHiveSignature` is NOT mocked: every authenticated request goes
 *       through its real Bearer branch, including the
 *       `sessions_invalidated_at` read against the real row.
 *   (c) The broadcast surface's own behaviour (lock, cascade, error
 *       envelopes) is covered in `tests/routes/orcid.test.ts`; this suite's
 *       risk class (the gate reading the wrong row state) is asserted against
 *       real rows in the real database.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { PrivateKey } from '@hiveio/dhive';

const { broadcastAdminCustomJsonMock } = vi.hoisted(() => ({
  broadcastAdminCustomJsonMock: vi.fn(),
}));

vi.mock('../../src/hive.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/hive.js')>('../../src/hive.js');
  return {
    ...actual,
    broadcastAdminCustomJson: broadcastAdminCustomJsonMock,
  };
});

const { createApp } = await import('../../src/app.js');
const { getAppPool } = await import('../../src/app-db.js');
const { config } = await import('../../src/config.js');
const { getRedis, isRedisAvailable } = await import('../../src/redis.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');

// The dev .env leaves the ORCID client fields and the admin key empty, and
// config is built at import time. A deterministic WIF keeps the handlers'
// key parse happy; the broadcast itself is stubbed.
config.orcidClientId = config.orcidClientId || 'test-orcid-client-id';
config.orcidClientSecret = config.orcidClientSecret || 'test-orcid-client-secret';
config.pevoAdminPostingKey = config.pevoAdminPostingKey || PrivateKey.fromSeed('pevo-orcid-g-gate-test-admin').toString();

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

const REFUSAL_MESSAGE = 'Verify the email you registered in settings, or remove it, before linking an ORCID.';
const MARKER = crypto.randomBytes(4).toString('hex');
const usernames: string[] = [];
const orcids: string[] = [];

/** A fresh Hive-shaped username per case; vitest retries reuse nothing. */
function freshUser(tag: string): string {
  const u = `og${tag}${crypto.randomBytes(3).toString('hex')}`.slice(0, 16);
  usernames.push(u);
  return u;
}

function freshOrcid(): string {
  const n = crypto.randomBytes(6).readUIntBE(0, 6);
  const d = (k: number) => String(Math.floor(n / 10 ** k) % 10000).padStart(4, '0');
  const id = `0009-${d(0)}-${d(4)}-${String(n % 1000).padStart(3, '0')}X`;
  orcids.push(id);
  return id;
}

/** A G row's session: Keychain-derived JWTs carry the `'self'` claim. */
function bearerFor(username: string): string {
  return `Bearer ${jwt.sign({ sub: username, custody: 'self' }, config.sessionSecret, { expiresIn: '1h' })}`;
}

async function seedGRow(username: string, verified: boolean): Promise<void> {
  const pool = getAppPool()!;
  await pool.query(
    `INSERT INTO accounts (email, username, verify_token, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [
      `${username}_${MARKER}@example.test`,
      username,
      verified ? null : crypto.randomBytes(32).toString('hex'),
      verified ? null : new Date(Date.now() + 24 * 60 * 60 * 1000),
    ],
  );
}

async function rowOrcid(username: string): Promise<string | null | undefined> {
  const pool = getAppPool()!;
  const { rows } = await pool.query<{ orcid: string | null }>(
    'SELECT orcid FROM accounts WHERE username = $1',
    [username],
  );
  return rows[0]?.orcid;
}

function installOrcidStub(orcid: string, works: number): void {
  // Works with an external source (a source-orcid that differs from the
  // profile owner's) so `countExternalWorks` counts each one.
  const group = Array.from({ length: works }, (_, i) => ({
    'work-summary': [{ source: { 'source-orcid': { path: `9999-9999-9999-${String(i).padStart(4, '0')}` } } }],
  }));
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/oauth/token')) {
      return new Response(
        JSON.stringify({ orcid, name: 'G Row', access_token: 'tk' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.endsWith('/works')) {
      return new Response(JSON.stringify({ group }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch URL in the state G ORCID gate test: ${u}`);
  }));
}

async function start(mode: 'link' | 'accredit', username: string) {
  return request(app)
    .post('/api/orcid/start')
    .set('Authorization', bearerFor(username))
    .send({ mode });
}

async function startState(mode: 'link' | 'accredit', username: string): Promise<string> {
  const res = await start(mode, username);
  expect(res.status).toBe(200);
  return new URL(res.body.data.redirect_url).searchParams.get('state')!;
}

async function callback(username: string, state: string) {
  return request(app)
    .post('/api/orcid/callback')
    .set('Authorization', bearerFor(username))
    .send({ code: 'fake', state });
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    throw new Error(`Unexpected fetch before installOrcidStub: ${url}`);
  }));
  broadcastAdminCustomJsonMock.mockReset().mockRejectedValue(new Error('broadcast stubbed: must not be reached'));
  await clearRateLimitKeys(['orcid-start', 'orcid-callback']);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (dbReachable && usernames.length) {
    await getAppPool()!.query('DELETE FROM accounts WHERE username = ANY($1::text[])', [usernames]);
  }
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    for (const id of orcids) {
      await redis.del(
        `${config.appTag}:orcid_binding:${id}`,
        `${config.appTag}:orcid_binding_lock:${id}`,
      ).catch(() => {});
    }
  }
});

describe.skipIf(!dbReachable)('POST /api/orcid/start refuses an unverified state G row', () => {
  it.each(['link', 'accredit'] as const)('mode=%s answers 409 PENDING_UNVERIFIED with no redirect', async (mode) => {
    const user = freshUser(mode === 'link' ? 'sl' : 'sa');
    await seedGRow(user, false);

    const res = await start(mode, user);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PENDING_UNVERIFIED');
    expect(res.body.error.message).toBe(REFUSAL_MESSAGE);
    expect(res.body.data?.redirect_url).toBeUndefined();
  });

  it.each(['link', 'accredit'] as const)('mode=%s still starts for a verified G row and for a caller with no row', async (mode) => {
    const verified = freshUser('sv');
    await seedGRow(verified, true);
    const rowless = freshUser('sn');

    for (const user of [verified, rowless]) {
      const res = await start(mode, user);
      expect(res.status).toBe(200);
      expect(typeof res.body.data.redirect_url).toBe('string');
    }
  });
});

describe.skipIf(!dbReachable)('POST /api/orcid/callback refuses an unverified state G row', () => {
  it.each(['link', 'accredit'] as const)(
    'mode=%s: email registered between /start and the callback → 409, no broadcast, no ORCID written',
    async (mode) => {
      const user = freshUser(mode === 'link' ? 'cl' : 'ca');
      const orcid = freshOrcid();
      // Enough works that accredit would otherwise reach the broadcast.
      installOrcidStub(orcid, config.orcidMinWorks);

      const state = await startState(mode, user); // no row yet: passes
      await seedGRow(user, false); // the settings add flow lands

      const res = await callback(user, state);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PENDING_UNVERIFIED');
      expect(res.body.error.message).toBe(REFUSAL_MESSAGE);
      expect(broadcastAdminCustomJsonMock).not.toHaveBeenCalled();
      expect(await rowOrcid(user)).toBeNull();
    },
  );

  it('mode=link: a caller with no row proceeds past the gate', async () => {
    const user = freshUser('nl');
    installOrcidStub(freshOrcid(), config.orcidMinWorks);
    const state = await startState('link', user);

    const res = await callback(user, state);

    // Past the gate, link requires an existing accreditation; a fresh
    // username holds none on chain, so link stops at that check.
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Account is not accredited');
  });

  it('mode=accredit: a verified G row proceeds past the gate', async () => {
    const user = freshUser('va');
    await seedGRow(user, true);
    // Zero external works: accredit stops at the works-count check, which runs
    // after the gate and before any broadcast.
    installOrcidStub(freshOrcid(), 0);
    const state = await startState('accredit', user);

    const res = await callback(user, state);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/externally-sourced work/);
    expect(broadcastAdminCustomJsonMock).not.toHaveBeenCalled();
  });
});

// The callback gate runs before the broadcast, but the row UPDATE runs after
// it, and the caller's email can be registered in between. The UPDATE itself
// therefore refuses a row whose email is unverified, so an ORCID cannot reach
// such a row by that interleaving either.
describe.skipIf(!dbReachable)('the accounts.orcid write skips a row whose email is unverified', () => {
  it('leaves an unverified G row without an ORCID', async () => {
    const { __test_seams } = await import('../../src/routes/orcid.js');
    const user = freshUser('wu');
    await seedGRow(user, false);

    await __test_seams.updateAccountOrcid(user, freshOrcid());

    expect(await rowOrcid(user)).toBeNull();
  });

  it('still writes the ORCID onto a verified G row', async () => {
    const { __test_seams } = await import('../../src/routes/orcid.js');
    const user = freshUser('wv');
    const orcid = freshOrcid();
    await seedGRow(user, true);

    await __test_seams.updateAccountOrcid(user, orcid);

    expect(await rowOrcid(user)).toBe(orcid);
  });
});

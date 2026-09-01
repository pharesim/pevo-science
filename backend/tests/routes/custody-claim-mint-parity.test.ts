/**
 * Real-path parity of the `custody` claim across every session mint that reads
 * an `accounts` row, before and after `POST /api/custody/upgrade`.
 *
 * The defect this suite exists for: the upgrade route stamped `upgraded_at`
 * without flipping the `custody` column, and the ORCID login mint copied the
 * column into the claim while the password login derived it from the epoch. An
 * upgraded account signing in via ORCID therefore got a `custody: 'light'` JWT
 * for an account the server could no longer sign for. Both halves are fixed at
 * the source (the route writes both columns; every mint derives through the
 * shared `custodyClaimFor`), and this suite pins the observable result: for one
 * row, the password login, the ORCID login, and the settings read report the
 * same custody, and after a REAL upgrade that value is `'self'` on all three.
 *
 * Why the upgrade runs for real rather than seeding a state-D row: the seeded
 * shape would pass against the old route too. Driving the actual UPDATE is what
 * makes "the row the route leaves behind mints self everywhere" a claim about
 * the shipped code path, not about the fixture.
 *
 * Carve-out justification (root CLAUDE.md "Running Tests"):
 *   (a) Two third-party surfaces are stubbed because neither can be driven for
 *       real per-test: the ORCID OAuth token exchange (`fetch` to
 *       `/oauth/token`, a remote identity provider with no test tenancy) and
 *       `hiveClient.database.getAccounts` (a mainnet read that cannot reflect a
 *       per-test rotated key set). Postgres, Redis, argon2, the OAuth state
 *       round-trip through `/api/orcid/start`, the seed-derived signature
 *       verification inside the upgrade handler, and JWT minting all run real.
 *   (b) `verifyHiveSignature` is NOT mocked. The upgrade request and the
 *       settings read drive its real Bearer branch; the two logins are
 *       unauthenticated by design (the password and the OAuth code ARE the
 *       authentication).
 *   (c) The risk class here (two mints disagreeing about one row) is asserted
 *       against the real routes and the real row the real upgrade wrote.
 *       `tests/routes/orcid.test.ts` holds the mocked-pool companion that feeds
 *       the ORCID mint a column/epoch-divergent row, which the schema CHECK
 *       makes impossible to seed here.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { PrivateKey, cryptoUtils } from '@hiveio/dhive';

const { getAccountsMock } = vi.hoisted(() => ({
  getAccountsMock: vi.fn(),
}));

vi.mock('../../src/hive.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/hive.js')>('../../src/hive.js');
  return {
    ...actual,
    hiveClient: {
      database: { getAccounts: getAccountsMock },
      broadcast: actual.hiveClient.broadcast,
    },
  };
});

const { createApp } = await import('../../src/app.js');
const { getAppPool } = await import('../../src/app-db.js');
const { config } = await import('../../src/config.js');
const { buildCustodyUpgradeChallenge } = await import('../../src/routes/custody.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');

// The dev .env leaves the ORCID client fields empty and config is built at
// import time; `/api/orcid/start` refuses without them.
config.orcidClientId = config.orcidClientId || 'test-orcid-client-id';
config.orcidClientSecret = config.orcidClientSecret || 'test-orcid-client-secret';

const app = createApp();
const RUN_ID = Date.now();

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

// Hive usernames: /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/. Base36 suffix keeps
// concurrent runs apart.
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const USER = `cpar${SUFFIX}user`;
const EMAIL = `claim_parity_${RUN_ID}@example.com`;
const PASSWORD = 'ClaimParityPass1';
// Valid ORCID shape, unique per run (migration 007 refuses a duplicate).
const ORCID = `0009-0009-${String(RUN_ID % 10000).padStart(4, '0')}-${String(Math.floor(RUN_ID / 10000) % 1000).padStart(3, '0')}X`;

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function claimsOf(token: string): { sub?: unknown; custody?: unknown } {
  return jwt.verify(token, config.sessionSecret) as { sub?: unknown; custody?: unknown };
}

/** Stub only the ORCID token exchange. Anything else reaching `fetch` is a
 *  test bug and throws. Login mode never calls the public works API. */
function installOrcidTokenExchangeStub(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/oauth/token')) {
      return new Response(
        JSON.stringify({ orcid: ORCID, name: 'Parity User', access_token: 'tk' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected fetch URL in claim-parity test: ${u}`);
  }));
}

async function passwordLoginClaim(): Promise<{ claim: unknown; body: unknown }> {
  await clearRateLimitKeys(['auth-login']);
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email_or_username: EMAIL, password: PASSWORD });
  expect(res.status).toBe(200);
  expect(res.body.data.username).toBe(USER);
  return { claim: claimsOf(res.body.data.token).custody, body: res.body.data.custody };
}

async function orcidLoginClaim(): Promise<{ claim: unknown; body: unknown; token: string }> {
  await clearRateLimitKeys(['orcid-start', 'orcid-callback']);
  installOrcidTokenExchangeStub();
  const start = await request(app).post('/api/orcid/start').send({ mode: 'login' });
  expect(start.status).toBe(200);
  const state = new URL(start.body.data.redirect_url).searchParams.get('state')!;
  const res = await request(app).post('/api/orcid/callback').send({ code: 'fake', state });
  expect(res.status).toBe(200);
  expect(res.body.data.mode).toBe('login');
  expect(res.body.data.username).toBe(USER);
  return {
    claim: claimsOf(res.body.data.token).custody,
    body: res.body.data.custody,
    token: res.body.data.token,
  };
}

async function settingsCustody(token: string): Promise<unknown> {
  await clearRateLimitKeys(['settings-read']);
  const res = await request(app).get('/api/settings/email').set('Authorization', bearer(token));
  expect(res.status).toBe(200);
  return res.body.data.custody;
}

/** A proof body for the real upgrade handler, signed with a seed-derived key
 *  the mocked chain account is told to carry. Same shape the SPA sends after
 *  its on-chain `account_update`. */
function buildProofBody(wif: string): { derived_pubkey: string; signed_proof: string; signed_at: string } {
  const priv = PrivateKey.fromString(wif);
  const signedAt = new Date().toISOString();
  const challenge = buildCustodyUpgradeChallenge({ appTag: config.appTag, username: USER, signedAt });
  return {
    derived_pubkey: priv.createPublic().toString(),
    signed_proof: priv.sign(cryptoUtils.sha256(challenge)).toString(),
    signed_at: signedAt,
  };
}

function fakeChainAccount(pubkey: string) {
  const other = (label: string) => `STM7other${label}`.padEnd(53, '0');
  return {
    posting: { weight_threshold: 1, account_auths: [], key_auths: [[pubkey, 1]] },
    active: { weight_threshold: 1, account_auths: [], key_auths: [[other('Active'), 1]] },
    owner: { weight_threshold: 1, account_auths: [], key_auths: [[other('Owner'), 1]] },
  };
}

async function cleanup(): Promise<void> {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [USER]).catch(() => {});
  await pool.query('DELETE FROM accounts WHERE email = $1 OR username = $2', [EMAIL, USER]).catch(() => {});
}

let passwordHash: string;

/** Seed (or re-seed) the row in § 6.1 state B: light, password set, ORCID
 *  linked. Both login factors work, so both mints can be driven against the
 *  same row before and after upgrade. Called at the top of each test rather
 *  than once: vitest retries a failed test in place, and the upgrade test
 *  must start from a light row on every attempt. */
async function seedStateB(): Promise<void> {
  await cleanup();
  const pool = getAppPool()!;
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, custody, orcid, verify_token,
                           posting_key_enc, iv_posting, expires_at)
     VALUES ($1, $2, $3, 'light', $4, NULL, $5, $6, $7)`,
    [
      EMAIL,
      USER,
      passwordHash,
      ORCID,
      Buffer.from('placeholder-ciphertext'),
      Buffer.from('placeholder-iv'),
      new Date(Date.now() + 24 * 60 * 60 * 1000),
    ],
  );
}

beforeAll(async () => {
  await cleanup();
  if (!dbReachable) return;
  passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
});

beforeEach(() => {
  vi.unstubAllGlobals();
  getAccountsMock.mockReset();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await cleanup();
});

describe.skipIf(!dbReachable)('custody claim parity across the session mints', () => {
  it('before upgrade, every mint and the settings read agree on light', async () => {
    await seedStateB();
    const pw = await passwordLoginClaim();
    const oc = await orcidLoginClaim();
    expect(pw.claim).toBe('light');
    expect(oc.claim).toBe('light');
    expect(pw.body).toBe('light');
    expect(oc.body).toBe('light');
    expect(await settingsCustody(oc.token)).toBe('light');
  });

  it('a real upgrade leaves a state-D row, and every mint then agrees on self', async () => {
    await seedStateB();
    const pool = getAppPool()!;
    await clearRateLimitKeys(['custody-upgrade']);
    const wif = PrivateKey.fromSeed(`claim-parity-${RUN_ID}`).toString();
    const proof = buildProofBody(wif);
    getAccountsMock.mockResolvedValue([fakeChainAccount(proof.derived_pubkey)]);
    const light = jwt.sign({ sub: USER, custody: 'light' }, config.sessionSecret, { expiresIn: '5m' });

    const up = await request(app)
      .post('/api/custody/upgrade')
      .set('Authorization', bearer(light))
      .send(proof);
    expect(up.status).toBe(200);
    expect(up.body.data.custody).toBe('self');

    // The row the route left behind is § 6.1 state D on both columns; the
    // column is what a raw reader would copy, the epoch is what the gates
    // read, and they must not disagree.
    const { rows } = await pool.query<{ custody: string | null; upgraded_at: Date | null }>(
      'SELECT custody, upgraded_at FROM accounts WHERE username = $1',
      [USER],
    );
    expect(rows[0].custody).toBe('self');
    expect(rows[0].upgraded_at).not.toBeNull();

    // The upgrade stamped the session-revocation epoch, and the middleware
    // compares a token's second-grained `iat` against it: a token minted in
    // the SAME second as the revocation is rejected unless it carries the
    // upgrade's own `reissuedAt`. The post-upgrade logins below mint fresh
    // tokens, so step past the second boundary first; otherwise the settings
    // read on that token is a 401 that has nothing to do with custody.
    await new Promise((resolve) => setTimeout(resolve, 1000 - (Date.now() % 1000) + 5));

    // Both factors are preserved through upgrade (§ 6.2), so both logins are
    // still reachable for the upgraded account. Each must now mint self, and
    // the settings read on the ORCID-minted session must report the same.
    const pw = await passwordLoginClaim();
    const oc = await orcidLoginClaim();
    expect(pw.claim).toBe('self');
    expect(oc.claim).toBe('self');
    expect(pw.body).toBe('self');
    expect(oc.body).toBe('self');
    expect(await settingsCustody(oc.token)).toBe('self');
    // Parity stated directly, so a future divergence reads as "the mints
    // disagree" rather than as two unrelated expected-value failures.
    expect(oc.claim).toBe(pw.claim);
  });
});

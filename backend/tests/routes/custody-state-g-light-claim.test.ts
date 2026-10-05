/**
 * A state G row presented with a `'light'`-claim JWT on the four custody routes
 * that act on a light claim: `POST /api/custody/broadcast`, `/fresh-auth`,
 * `/session-auth` and `/upgrade`.
 *
 * A state G row (ARCHITECTURE.md section 6.1) belongs to a self-custody
 * Keychain account that registered an email through the settings add flow:
 * `username` set, `custody` NULL, `upgraded_at` NULL. `custodyClaimFor` derives
 * `'self'` for it. A `'light'` JWT can still name such a row: one minted for an
 * earlier light row of the same username survives that row's deletion (the
 * deleted row takes its revocation epoch with it, and the G row's INSERT stamps
 * none). Each spec presents that token for a G row and pins that the route
 * answers exactly what it answers the same row under a `'self'` JWT, and that
 * the row is unchanged afterwards. The G rows here carry a password, the
 * realistic shape on which `/fresh-auth` and `/session-auth` would otherwise
 * mint, and the `/broadcast` request carries a live session window so that it
 * reaches the row read.
 *
 * Nothing is mocked. A G row holds no posting key, so `/broadcast` has nothing
 * to sign with for it, and `/upgrade` answers before its on-chain key lookup.
 *
 * Every spec draws a fresh username and email from `fresh()`, because vitest
 * re-runs a failed `it` body in place and an earlier attempt's row would
 * otherwise still hold them.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { PrivateKey, cryptoUtils } from '@hiveio/dhive';
import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { config } from '../../src/config.js';
import { buildCustodyUpgradeChallenge } from '../../src/routes/custody.js';
import { issueSessionFreshAuthToken } from '../../src/lib/fresh-auth.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';
import { expectNoSessionProof } from '../support/session-proof-shape.js';

const app = createApp();
const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const PASSWORD = 'StateGPassword1';

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

const ORCID_BAND = `0000-0006-${(RUN_ID % 10000).toString().padStart(4, '0')}`;

const created: string[] = [];
let seq = 0;
function fresh(): { username: string; email: string; orcid: string } {
  seq += 1;
  const username = `sgl${SUFFIX}${seq.toString(36)}`;
  created.push(username);
  return {
    username,
    email: `sgl_${RUN_ID}_${seq}@example.com`,
    orcid: `${ORCID_BAND}-${seq.toString().padStart(4, '0')}`,
  };
}

function bearer(username: string, custody: 'light' | 'self'): string {
  return `Bearer ${jwt.sign({ sub: username, custody }, config.sessionSecret, { expiresIn: '5m' })}`;
}

let passwordHash: string | null = null;
async function getPasswordHash(): Promise<string> {
  passwordHash ??= await argon2.hash(PASSWORD, { type: argon2.argon2id });
  return passwordHash;
}

/** A verified state G row that has acquired a password and an ORCID. */
async function insertStateGRow(id: { username: string; email: string; orcid: string }): Promise<void> {
  await getAppPool()!.query(
    `INSERT INTO accounts (email, username, password_hash, orcid, custody, verify_token)
     VALUES ($1, $2, $3, $4, NULL, NULL)`,
    [id.email, id.username, await getPasswordHash(), id.orcid],
  );
}

interface RowSnapshot {
  custody: string | null;
  upgraded_at: Date | null;
  password_hash: string | null;
  orcid: string | null;
  verify_token: string | null;
  sessions_invalidated_at: Date | null;
  updated_at: Date | null;
  posting_key_enc: Buffer | null;
  memo_key_enc: Buffer | null;
}

async function snapshot(username: string): Promise<RowSnapshot> {
  const { rows } = await getAppPool()!.query<RowSnapshot>(
    `SELECT custody, upgraded_at, password_hash, orcid, verify_token,
            sessions_invalidated_at, updated_at, posting_key_enc, memo_key_enc
       FROM accounts WHERE username = $1`,
    [username],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** Send the same request twice, once under a `'self'` JWT and once under a
 *  `'light'` JWT, and return both responses. */
async function underBothClaims(
  path: string,
  username: string,
  body: () => Record<string, unknown>,
) {
  const asSelf = await request(app).post(path).set('Authorization', bearer(username, 'self')).send(body());
  const asLight = await request(app).post(path).set('Authorization', bearer(username, 'light')).send(body());
  return { asSelf, asLight };
}

function expectSameNonLightRefusal(
  asSelf: request.Response,
  asLight: request.Response,
  message: string,
): void {
  expect(asSelf.status).toBe(403);
  expect(asSelf.body).toEqual({ status: 'error', error: { code: 'FORBIDDEN', message } });
  expect(asLight.status).toBe(asSelf.status);
  expect(asLight.body).toEqual(asSelf.body);
}

describe.skipIf(!dbReachable)('custody routes refuse a state G row presented with a light claim', () => {
  beforeEach(async () => {
    await clearRateLimitKeys([
      'custody-broadcast',
      'custody-fresh-auth',
      'custody-session-auth',
      'custody-upgrade',
    ]);
  });

  afterAll(async () => {
    if (!dbReachable || created.length === 0) return;
    const pool = getAppPool()!;
    await pool.query('DELETE FROM custody_audit_log WHERE username = ANY($1)', [created]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username = ANY($1)', [created]).catch(() => {});
  });

  it('POST /api/custody/broadcast: refused at the row read, the row unchanged', async () => {
    const id = fresh();
    const { username } = id;
    await insertStateGRow(id);
    const before = await snapshot(username);

    // A live session window, so the request reaches the row read rather than
    // stopping at the proof check.
    const { token: proof } = await issueSessionFreshAuthToken(username, 'password');
    const { asSelf, asLight } = await underBothClaims('/api/custody/broadcast', username, () => ({
      operations: [['vote', { voter: username, author: 'someauthor', permlink: 'somepermlink', weight: 10000 }]],
      fresh_auth_proof: proof,
    }));

    expectSameNonLightRefusal(
      asSelf,
      asLight,
      'This endpoint is only for custodial accounts. Use Hive Keychain to sign transactions.',
    );
    expect(await snapshot(username)).toEqual(before);
  });

  it('POST /api/custody/fresh-auth: no proof for the right password, the row unchanged', async () => {
    const id = fresh();
    const { username } = id;
    await insertStateGRow(id);
    const before = await snapshot(username);

    const { asSelf, asLight } = await underBothClaims('/api/custody/fresh-auth', username, () => ({
      password: PASSWORD,
      action: 'change_email',
    }));

    expectSameNonLightRefusal(
      asSelf,
      asLight,
      'This endpoint is only for custodial accounts. Self-custody users sign consent ops via Hive Keychain.',
    );
    expectNoSessionProof(asLight, 'fresh-auth refusal for a state G row under a light claim');
    expect(await snapshot(username)).toEqual(before);
  });

  it('POST /api/custody/session-auth: no session window for the right password, the row unchanged', async () => {
    const id = fresh();
    const { username } = id;
    await insertStateGRow(id);
    const before = await snapshot(username);

    const { asSelf, asLight } = await underBothClaims('/api/custody/session-auth', username, () => ({
      password: PASSWORD,
    }));

    expectSameNonLightRefusal(
      asSelf,
      asLight,
      'This endpoint is only for custodial accounts. Self-custody users sign consent ops via Hive Keychain.',
    );
    expectNoSessionProof(asLight, 'session-auth refusal for a state G row under a light claim');
    expect(await snapshot(username)).toEqual(before);
  });

  it('POST /api/custody/upgrade: no move to self-custody for a signed proof, the row unchanged', async () => {
    const id = fresh();
    const { username } = id;
    await insertStateGRow(id);
    const before = await snapshot(username);

    const priv = PrivateKey.fromSeed(`state-g-upgrade-${RUN_ID}-${username}`);
    const pub = priv.createPublic().toString();
    const proofBody = () => {
      const signedAt = new Date().toISOString();
      const challenge = buildCustodyUpgradeChallenge({ appTag: config.appTag, username, signedAt });
      return {
        derived_pubkey: pub,
        signed_proof: priv.sign(cryptoUtils.sha256(challenge)).toString(),
        signed_at: signedAt,
      };
    };

    const { asSelf, asLight } = await underBothClaims('/api/custody/upgrade', username, proofBody);

    expectSameNonLightRefusal(asSelf, asLight, 'Only custodial accounts can upgrade');
    const after = await snapshot(username);
    expect(after.custody).toBeNull();
    expect(after.upgraded_at).toBeNull();
    expect(after).toEqual(before);
  });
});

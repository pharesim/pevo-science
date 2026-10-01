/**
 * `vouch` and `retract_vouch` custom_json ops on `POST /api/custody/broadcast`.
 *
 * A light account vouches through the custody broadcast like it votes: the
 * ops are admitted under the session-kind fresh-auth proof (no per-op target,
 * not in the consent or credit gated sets). The route binds each op to its
 * signer before the gate:
 *   - `voucher` must be the JWT subject (403 FORBIDDEN), as the `vote` arm
 *     binds `voter`. The read side already ignores a vouch whose signer is not
 *     its `voucher`, so this keeps the server from signing an inert op that
 *     claims someone else.
 *   - `vouchee` must be a non-empty string other than the voucher
 *     (400 VALIDATION_ERROR): a researcher cannot vouch for themselves.
 * Every refusal test sends NO fresh-auth proof, so a refusal that ran after
 * the gate would surface as 401 FRESH_AUTH_REQUIRED and fail the assertion.
 *
 * Justification per root CLAUDE.md "Carve-out for deterministic edge-case
 * coverage" clause (a):
 *  - `../../src/hive.js` broadcast helpers mocked. The dhive client is in the
 *    carve-out's "third-party libraries non-trivial to run for real per-test"
 *    list; a real broadcast would sign and submit to a live witness. The
 *    broadcast surface's error and timeout handling is covered in
 *    `tests/lib/broadcast-error.test.ts`.
 *  - `../../src/custody-crypto.js` decryptKey mocked, same rationale as
 *    `tests/routes/custody-non-consent-fresh-auth.test.ts`. The AES-GCM
 *    encrypt/decrypt round-trip is exercised by
 *    `tests/lib/custody-crypto.test.ts`.
 *  - `verifyHiveSignature` runs REAL: the admit path must cross the real
 *    session-proof gate, so the middleware is not mocked (clause b).
 *
 * Real: Postgres (`accounts` row), Redis or its in-memory fallback for the
 * fresh-auth store, the JWT middleware, and `src/lib/fresh-auth.ts`.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { sendOperationsMock } = vi.hoisted(() => ({
  sendOperationsMock: vi.fn().mockResolvedValue({ id: 'vouch-tx-id', block_num: 9876 }),
}));

vi.mock('../../src/hive.js', async () => {
  const { MockBroadcastTimeoutError } = await import('../support/broadcast-mocks.js');
  return {
    hiveClient: {
      database: { getAccounts: vi.fn().mockResolvedValue([]) },
      broadcast: { sendOperations: (...args: unknown[]) => sendOperationsMock(...args) },
    },
    broadcastSendOperationsWithTimeout: (...args: unknown[]) => sendOperationsMock(...args),
    BroadcastTimeoutError: MockBroadcastTimeoutError,
    DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
  };
});

import { PrivateKey } from '@hiveio/dhive';
const TEST_POSTING_WIF = PrivateKey.fromSeed('pevo-vouch-ops-seed').toString();

vi.mock('../../src/custody-crypto.js', () => ({
  decryptKey: () => TEST_POSTING_WIF,
}));

const { createApp } = await import('../../src/app.js');
const { getAppPool } = await import('../../src/app-db.js');
const { config } = await import('../../src/config.js');
const {
  _resetFreshAuthMemStoreForTests,
  issueSessionFreshAuthToken,
} = await import('../../src/lib/fresh-auth.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');

const app = createApp();

const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const USER = `vop${SUFFIX}a`;
const OTHER = `vop${SUFFIX}b`;
const USER_EMAIL = `vop_user_${RUN_ID}@example.com`;

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

function bearerFor(username: string): string {
  const token = jwt.sign({ sub: username, custody: 'light' }, config.sessionSecret, { expiresIn: '5m' });
  return `Bearer ${token}`;
}

type VouchAction = 'vouch' | 'retract_vouch';

/** The custom_json op exactly as the SPA's vouch section builds it, with
 *  per-test payload overrides layered on top. */
function vouchOp(action: VouchAction, overrides: Record<string, unknown> = {}): [string, Record<string, unknown>] {
  const payload = action === 'vouch'
    ? { action, voucher: USER, vouchee: OTHER, relationship: 'colleague', timestamp: '2026-10-01T00:00:00.000Z' }
    : { action, voucher: USER, vouchee: OTHER, reason: 'No longer affiliated', timestamp: '2026-10-01T00:00:00.000Z' };
  return ['custom_json', {
    required_auths: [],
    required_posting_auths: [USER],
    id: config.appTag,
    json: JSON.stringify({ ...payload, ...overrides }),
  }];
}

async function broadcast(operations: unknown[], proof?: string) {
  return request(app)
    .post('/api/custody/broadcast')
    .set('Authorization', bearerFor(USER))
    .send(proof === undefined ? { operations } : { operations, fresh_auth_proof: proof });
}

describe.skipIf(!dbReachable)('POST /api/custody/broadcast admits vouch and retract_vouch bound to the signer', () => {
  beforeEach(async () => {
    sendOperationsMock.mockReset();
    sendOperationsMock.mockResolvedValue({ id: 'vouch-tx-id', block_num: 9876 });
    _resetFreshAuthMemStoreForTests();
    await clearRateLimitKeys(['custody-broadcast']);

    const pool = getAppPool()!;
    await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [USER]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username = $1', [USER]).catch(() => {});
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, posting_key_enc, iv_posting, verify_token, expires_at)
       VALUES ($1, $2, 'placeholder-hash', 'light', $3, $4, NULL, $5)`,
      [
        USER_EMAIL,
        USER,
        Buffer.from('placeholder-ciphertext'),
        Buffer.from('placeholder-iv'),
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      ],
    );
  });

  afterAll(async () => {
    const pool = getAppPool()!;
    await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [USER]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username = $1', [USER]).catch(() => {});
  });

  for (const action of ['vouch', 'retract_vouch'] as const) {
    describe(action, () => {
      it('with a session-kind proof broadcasts the op unchanged', async () => {
        const proof = await issueSessionFreshAuthToken(USER, 'password');
        const operations = [vouchOp(action)];
        const res = await broadcast(operations, proof.token);

        expect(res.status).toBe(200);
        expect(res.body.data.tx_id).toBe('vouch-tx-id');
        expect(sendOperationsMock).toHaveBeenCalledTimes(1);
        expect(sendOperationsMock.mock.calls[0][0]).toEqual(operations);
      });

      it('the session-kind proof is not spent, so a second op in its window also broadcasts', async () => {
        const proof = await issueSessionFreshAuthToken(USER, 'password');
        expect((await broadcast([vouchOp(action)], proof.token)).status).toBe(200);
        expect((await broadcast([vouchOp(action)], proof.token)).status).toBe(200);
        expect(sendOperationsMock).toHaveBeenCalledTimes(2);
      });

      it('without a proof passes the allowlist and stops at the fresh-auth gate', async () => {
        const res = await broadcast([vouchOp(action)]);

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
        expect(res.body.error.details?.reason).toBe('missing');
        expect(sendOperationsMock).not.toHaveBeenCalled();
      });

      describe('refused before the fresh-auth gate', () => {
        async function expectRefused(
          overrides: Record<string, unknown>,
          status: number,
          code: string,
          message: RegExp,
        ) {
          const res = await broadcast([vouchOp(action, overrides)]);
          expect(res.status).toBe(status);
          expect(res.body.error.code).toBe(code);
          expect(res.body.error.message).toMatch(message);
          expect(res.body.error.message).not.toContain('—');
          expect(sendOperationsMock).not.toHaveBeenCalled();
        }

        it('a voucher other than the signer is 403', async () => {
          await expectRefused({ voucher: OTHER, vouchee: 'someoneelse' }, 403, 'FORBIDDEN',
            new RegExp(`${action} voucher must be '${USER}'`));
        });

        it('a missing voucher is 403', async () => {
          await expectRefused({ voucher: undefined }, 403, 'FORBIDDEN',
            new RegExp(`${action} voucher must be '${USER}'`));
        });

        it('a missing vouchee is 400', async () => {
          await expectRefused({ vouchee: undefined }, 400, 'VALIDATION_ERROR',
            new RegExp(`${action} vouchee must be a Hive username other than the voucher`));
        });

        it('an empty vouchee is 400', async () => {
          await expectRefused({ vouchee: '' }, 400, 'VALIDATION_ERROR',
            new RegExp(`${action} vouchee must be a Hive username other than the voucher`));
        });

        it('a non-string vouchee is 400', async () => {
          await expectRefused({ vouchee: [OTHER] }, 400, 'VALIDATION_ERROR',
            new RegExp(`${action} vouchee must be a Hive username other than the voucher`));
        });

        it('a self vouchee is 400', async () => {
          await expectRefused({ vouchee: USER }, 400, 'VALIDATION_ERROR',
            new RegExp(`${action} vouchee must be a Hive username other than the voucher`));
        });
      });
    });
  }

  it('an unknown custom_json action is still 403 and the refusal lists vouch and retract_vouch', async () => {
    const res = await broadcast([['custom_json', {
      required_auths: [],
      required_posting_auths: [USER],
      id: config.appTag,
      json: JSON.stringify({ action: 'accredit', account: OTHER }),
    }]]);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toMatch(/\bvouch\b/);
    expect(res.body.error.message).toMatch(/\bretract_vouch\b/);
    expect(sendOperationsMock).not.toHaveBeenCalled();
  });
});

/**
 * Route-level integration tests for the idempotency wiring + PostBroadcastWriteError
 * discipline at POST /api/accreditation/verify. Sibling to
 * `accreditation.test.ts` (which covers the timeout/failure envelopes); this
 * file isolates the new behavior so the existing file's mock surface is
 * unchanged.
 *
 * Mock posture (per root CLAUDE.md "Carve-out for deterministic edge-case
 * coverage"): the dhive broadcast is mocked because real chain ops in a
 * unit-test loop are operationally infeasible; the HAF pool is mocked because
 * HAF replay of a live `accredit` op for the test fixture is impractical;
 * `seedAccreditationBonus` is mocked because we need to drive both the
 * happy path and the throw path on demand to exercise the
 * PostBroadcastWriteError discrimination. `verifyHiveSignature` is NOT
 * mocked here — /verify is rate-limited but not auth-gated. Real Redis
 * stores the pending-accreditation row.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { PrivateKey } from '@hiveio/dhive';

const { broadcastJsonMock, MockBroadcastTimeoutError } = vi.hoisted(() => ({
  broadcastJsonMock: vi.fn().mockResolvedValue({ id: 'fresh-accred-tx-id' }),
  MockBroadcastTimeoutError: class BroadcastTimeoutError extends Error {
    public readonly timeoutMs: number;
    constructor(timeoutMs: number) {
      super(`Hive broadcast timed out after ${timeoutMs}ms`);
      this.name = 'BroadcastTimeoutError';
      this.timeoutMs = timeoutMs;
    }
  },
}));

vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: { getAccounts: vi.fn().mockResolvedValue([]) },
    broadcast: { json: broadcastJsonMock },
  },
  broadcastJsonWithTimeout: (...args: unknown[]) =>
    (broadcastJsonMock as (...a: unknown[]) => unknown)(...args),
  BroadcastTimeoutError: MockBroadcastTimeoutError,
  DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
}));

const { hafQueryMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  getPool: () => ({ query: hafQueryMock }),
  isHafAvailable: () => true,
  closeHafPool: async () => {},
}));

const { seedBonusMock } = vi.hoisted(() => ({
  seedBonusMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/reputation.js', () => ({
  seedAccreditationBonus: (...args: unknown[]) => seedBonusMock(...args),
}));

import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { getRedis } from '../../src/redis.js';

config.pevoAdminPostingKey = PrivateKey.fromSeed('pevo-accred-idem-test-admin').toString();

const app = createApp();

async function seedPendingAccreditation(token: string, username: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Redis required for accreditation idempotency specs');
  const pending = {
    hive_username: username,
    full_name: 'Accred Idem User',
    institution: 'Test University',
    field: 'physics',
    email: `${username}@university.edu`,
    orcid: '',
    token,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  };
  await redis.set(
    `${config.appTag}:pending_accred:${token}`,
    JSON.stringify(pending),
    'EX',
    24 * 60 * 60,
  );
}

async function tokenExists(token: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  const raw = await redis.get(`${config.appTag}:pending_accred:${token}`);
  return raw !== null;
}

describe('accreditation /verify — idempotency hit (Option A.4)', () => {
  beforeEach(() => {
    broadcastJsonMock.mockReset();
    broadcastJsonMock.mockResolvedValue({ id: 'fresh-accred-tx-id' });
    hafQueryMock.mockReset();
    seedBonusMock.mockReset();
    seedBonusMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const redis = getRedis();
    if (redis) {
      const keys = await redis.keys(`${config.appTag}:pending_accred:accred-idem-*`);
      if (keys.length > 0) await redis.del(...keys);
    }
  });

  it('HAF hit returns existing tx_id with outcome:already_landed and skips broadcast', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-idem-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'idemverifyuser';
    await seedPendingAccreditation(token, username);

    hafQueryMock.mockResolvedValueOnce({
      rows: [{ trx_id: 'tx-prior-accredit', block_num: 12345 }],
    });

    const res = await request(app).post('/api/accreditation/verify').send({ token });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      message: 'Accreditation confirmed',
      username,
      tx_id: 'tx-prior-accredit',
      outcome: 'already_landed',
    });
    expect(broadcastJsonMock).not.toHaveBeenCalled();
    expect(seedBonusMock).not.toHaveBeenCalled();
    // Token cleanup runs even on the idempotency-hit path so a retry-with-
    // same-token shapes to 400 BAD_REQUEST instead of looping back through
    // the HAF check on every retry.
    expect(await tokenExists(token)).toBe(false);
  });

  it('HAF miss broadcasts and embeds idempotency_key into accredit custom_json payload', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-idem-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'idemverify2';
    await seedPendingAccreditation(token, username);

    hafQueryMock.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post('/api/accreditation/verify').send({ token });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ tx_id: 'fresh-accred-tx-id' });
    expect(res.body.data.outcome).toBeUndefined();
    expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
    const broadcastedJson = (broadcastJsonMock.mock.calls[0][0] as { json: string }).json;
    const payload = JSON.parse(broadcastedJson) as { idempotency_key: string; action: string };
    expect(payload.action).toBe('accredit');
    expect(typeof payload.idempotency_key).toBe('string');
    expect(payload.idempotency_key.length).toBeGreaterThan(0);
    expect(seedBonusMock).toHaveBeenCalledWith(username);
  });
});

describe('accreditation /verify — PostBroadcastWriteError on seedAccreditationBonus failure', () => {
  beforeEach(() => {
    broadcastJsonMock.mockReset();
    broadcastJsonMock.mockResolvedValue({ id: 'fresh-accred-tx-id' });
    hafQueryMock.mockReset();
    seedBonusMock.mockReset();
  });

  afterEach(async () => {
    const redis = getRedis();
    if (redis) {
      const keys = await redis.keys(`${config.appTag}:pending_accred:accred-idem-*`);
      if (keys.length > 0) await redis.del(...keys);
    }
  });

  it('seedAccreditationBonus throws → 502 POST_BROADCAST_FAILED with tx_id + failed_step:reputation_seed', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-idem-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'postbroadcastuser';
    await seedPendingAccreditation(token, username);

    hafQueryMock.mockResolvedValueOnce({ rows: [] });
    broadcastJsonMock.mockResolvedValueOnce({ id: 'confirmed-on-chain-tx' });
    seedBonusMock.mockRejectedValueOnce(new Error('reputation table connection drop'));

    const res = await request(app).post('/api/accreditation/verify').send({ token });

    // Discrimination contract: chain op confirmed, downstream cascade failed.
    // 502 with POST_BROADCAST_FAILED code (different from BROADCAST_FAILED so
    // operator alerts route to DB on-call instead of broadcast on-call).
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('POST_BROADCAST_FAILED');
    expect(res.body.error.details).toMatchObject({
      retriable: false,
      outcome: 'confirmed',
      tx_id: 'confirmed-on-chain-tx',
      failed_step: 'reputation_seed',
    });
    // Token already cleaned up before the seed-bonus throw — the chain op
    // landed, so the token has done its job. The post_broadcast catch branch
    // does NOT delete it again.
    expect(await tokenExists(token)).toBe(false);
    // Internal error message MUST NOT leak into the user-facing payload.
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('reputation table connection drop');
  });
});

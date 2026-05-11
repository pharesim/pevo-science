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
 *
 * Round-2 F6 (carve-out clause c) follow-up: real-path HAF integration
 * coverage for `findAccreditationBroadcastByIdempotencyKey` is filed as
 * `backend-idempotency-haf-integration-test.md`. This file's HAF mocks
 * pin the route-side glue; the integration test will exercise the SQL
 * shape against a live HAF pool.
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

const { hafQueryMock, hafConfiguredFlag } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(),
  // Mutable container lets individual tests flip configuration presence
  // (F19's HAF-unconfigured spec) without re-mocking the module.
  hafConfiguredFlag: { value: true },
}));

vi.mock('../../src/db.js', () => ({
  getPool: () => ({ query: hafQueryMock }),
  isHafConfigured: () => hafConfiguredFlag.value,
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
import { logger } from '../../src/logger.js';

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

async function readBroadcastAttemptsCounter(token: string): Promise<number | null> {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get(`${config.appTag}:pending_accred_broadcast_attempts:${token}`);
  return raw === null ? null : Number(raw);
}

describe('accreditation /verify — idempotency hit (Option A.4)', () => {
  beforeEach(() => {
    broadcastJsonMock.mockReset();
    broadcastJsonMock.mockResolvedValue({ id: 'fresh-accred-tx-id' });
    hafQueryMock.mockReset();
    seedBonusMock.mockReset();
    seedBonusMock.mockResolvedValue(undefined);
    hafConfiguredFlag.value = true;
  });

  afterEach(async () => {
    const redis = getRedis();
    if (redis) {
      const keys = await redis.keys(`${config.appTag}:pending_accred:accred-idem-*`);
      if (keys.length > 0) await redis.del(...keys);
      const counters = await redis.keys(`${config.appTag}:pending_accred_broadcast_attempts:accred-idem-*`);
      if (counters.length > 0) await redis.del(...counters);
      // Clear the per-IP /verify rate-limit window — supertest pins
      // remoteAddress to 127.0.0.1, so each test in this file shares the
      // byIp bucket (limit: 5/min). Without this reset the 6th+ spec
      // returns 429 before reaching the route handler.
      const limitKeys = await redis.keys(`${config.appTag}:rl:accred-verify:*`);
      if (limitKeys.length > 0) await redis.del(...limitKeys);
      // Clear the idempotency cache — F5 caches HAF lookup results;
      // afterEach reset prevents one spec's cached result from poisoning
      // a subsequent spec keyed on the same idempotency_key.
      const idemKeys = await redis.keys(`${config.appTag}:idem:accred:*`);
      if (idemKeys.length > 0) await redis.del(...idemKeys);
    }
  });

  it('HAF hit returns existing tx_id with outcome:already_landed, skips broadcast, seeds bonus, no cap slot consumed (F1 + round-3 hold #7)', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-idem-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'idemverifyuser';
    await seedPendingAccreditation(token, username);

    hafQueryMock.mockResolvedValueOnce({
      rows: [{ trx_id: 'tx-prior-accredit', block_num: 12345 }],
    });

    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    try {
      const res = await request(app).post('/api/accreditation/verify').send({ token });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        message: 'Accreditation confirmed',
        username,
        tx_id: 'tx-prior-accredit',
        outcome: 'already_landed',
      });
      expect(broadcastJsonMock).not.toHaveBeenCalled();
      // F1 part 2: bonus seed fires on the hit branch too.
      expect(seedBonusMock).toHaveBeenCalledWith(username);
      // Token cleanup runs on the hit path so the next retry-with-same-token
      // returns 400 BAD_REQUEST instead of looping back through HAF.
      expect(await tokenExists(token)).toBe(false);
      // Round-3 hold #7: the idempotency probe now runs BEFORE the cap
      // pre-INCR, so a hit branch consumes ZERO cap slots. The counter
      // key never exists (no INCR happened).
      const counter = await readBroadcastAttemptsCounter(token);
      expect(counter === null || counter === 0).toBe(true);
      // F19/F20 hit-path event pin: logger.info called with the
      // discriminator + structured fields. Operators dashboard on this.
      const matchingCall = infoSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'accreditation.verify.idempotency_hit';
      });
      expect(matchingCall, 'expected accreditation.verify.idempotency_hit info event').toBeDefined();
      expect(matchingCall![0]).toMatchObject({
        event: 'accreditation.verify.idempotency_hit',
        route: 'accreditation.verify',
        username,
        email_hash: expect.any(String),
        tx_id: 'tx-prior-accredit',
      });
    } finally {
      infoSpy.mockRestore();
    }
  });

  // Round-3 hold #7 — adversarial A3 cap+idempotency mixed-envelope class.
  // The pre-fix ordering (cap-INCR first, then idempotency probe) could send
  // concurrent retries through both branches: retry N returns 502
  // BROADCAST_ATTEMPT_LIMIT_EXCEEDED on cap exhaustion while retry N+1
  // returns 200 outcome:'already_landed' for the same logical op once the
  // chain row indexed. Hoisting the probe above the INCR closes this: an
  // idempotency hit always returns 200 (no cap consumed), regardless of
  // the counter's current value.
  it('idempotency hit returns 200 even when broadcast-attempts counter is at cap (round-3 hold #7 ordering)', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-idem-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'idemverifyatcap';
    await seedPendingAccreditation(token, username);

    // Pre-seed the counter at cap so a cap check that ran first would
    // return 502 BROADCAST_ATTEMPT_LIMIT_EXCEEDED.
    const cap = config.verifyBroadcastAttemptsCap;
    await redis.set(`${config.appTag}:pending_accred_broadcast_attempts:${token}`, cap.toString(), 'EX', 86400);

    hafQueryMock.mockResolvedValueOnce({
      rows: [{ trx_id: 'tx-prior-at-cap', block_num: 67890 }],
    });

    const res = await request(app).post('/api/accreditation/verify').send({ token });

    // Hit branch wins: 200 outcome:'already_landed'. If the cap check had
    // run first, this would be 502 BROADCAST_ATTEMPT_LIMIT_EXCEEDED.
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      tx_id: 'tx-prior-at-cap',
      outcome: 'already_landed',
    });
    expect(broadcastJsonMock).not.toHaveBeenCalled();
    // The cap-exceeded envelope (BROADCAST_ATTEMPT_LIMIT_EXCEEDED, code
    // 502) is the regression class this test guards against. Asserting on
    // the response body's absence of that code pins ordering: with the
    // pre-fix shape, the cap pre-INCR (going from `cap` to `cap+1`)
    // would have tripped the cap-check and returned 502 before the
    // probe ran. Hit-branch token cleanup deletes the counter key as a
    // side effect (deleteToken cascades into deleteBroadcastAttempts),
    // so a post-call counter read isn't a usable signal — the body
    // check is the one that matters.
    expect(res.body.error).toBeUndefined();
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

  it('HAF lookup throw degrades gracefully — broadcast still fires + lookup_failed warn emitted (F9)', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-idem-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'idemverifylookupfail';
    await seedPendingAccreditation(token, username);

    hafQueryMock.mockRejectedValueOnce(new Error('haf connection drop'));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      const res = await request(app).post('/api/accreditation/verify').send({ token });

      // Fresh-broadcast envelope (no outcome:already_landed) — the layer
      // gracefully degrades when the HAF lookup throws.
      expect(res.status).toBe(200);
      expect(res.body.data.tx_id).toBe('fresh-accred-tx-id');
      expect(res.body.data.outcome).toBeUndefined();
      expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
      const matchingCall = warnSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'accreditation.verify.idempotency_lookup_failed';
      });
      expect(matchingCall, 'expected idempotency_lookup_failed warn').toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('HAF unconfigured — broadcast still fires + idempotency_haf_unconfigured warn (F19, F10 rename)', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-idem-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'idemverifyhafmissing';
    await seedPendingAccreditation(token, username);

    hafConfiguredFlag.value = false;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      const res = await request(app).post('/api/accreditation/verify').send({ token });

      expect(res.status).toBe(200);
      expect(res.body.data.tx_id).toBe('fresh-accred-tx-id');
      // No HAF call because isHafConfigured() returned false.
      expect(hafQueryMock).not.toHaveBeenCalled();
      expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
      // F10 rename: event is `_haf_unconfigured`, not `_haf_unavailable`.
      const matchingCall = warnSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'accreditation.verify.idempotency_haf_unconfigured';
      });
      expect(matchingCall, 'expected idempotency_haf_unconfigured warn').toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('token cleanup failure on hit — 200 envelope unaffected + token_cleanup_failed warn (F20)', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-idem-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'idemverifyclean';
    await seedPendingAccreditation(token, username);

    hafQueryMock.mockResolvedValueOnce({
      rows: [{ trx_id: 'tx-prior-cleanup', block_num: 50001 }],
    });

    // Stub `redis.del` to throw exactly once so the hit-path deleteToken
    // throws inside the best-effort wrapper. Subsequent del calls work
    // normally so afterEach cleanup can still run.
    const redisAny = redis as unknown as {
      del: (...args: unknown[]) => Promise<number>;
    };
    const originalDel = redisAny.del.bind(redis);
    const delMock = vi.fn().mockImplementationOnce(async () => {
      throw new Error('redis del flap');
    }).mockImplementation(originalDel);
    redisAny.del = delMock as unknown as typeof redisAny.del;

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      const res = await request(app).post('/api/accreditation/verify').send({ token });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        tx_id: 'tx-prior-cleanup',
        outcome: 'already_landed',
      });
      const matchingCall = warnSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'accreditation.verify.idempotency_hit_token_cleanup_failed';
      });
      expect(matchingCall, 'expected idempotency_hit_token_cleanup_failed warn').toBeDefined();
    } finally {
      warnSpy.mockRestore();
      // Restore real del so afterEach cleanup works.
      redisAny.del = originalDel as unknown as typeof redisAny.del;
    }
  });
});

describe('accreditation /verify — PostBroadcastWriteError on seedAccreditationBonus failure', () => {
  beforeEach(() => {
    broadcastJsonMock.mockReset();
    broadcastJsonMock.mockResolvedValue({ id: 'fresh-accred-tx-id' });
    hafQueryMock.mockReset();
    seedBonusMock.mockReset();
    hafConfiguredFlag.value = true;
  });

  afterEach(async () => {
    const redis = getRedis();
    if (redis) {
      const keys = await redis.keys(`${config.appTag}:pending_accred:accred-idem-*`);
      if (keys.length > 0) await redis.del(...keys);
      const counters = await redis.keys(`${config.appTag}:pending_accred_broadcast_attempts:accred-idem-*`);
      if (counters.length > 0) await redis.del(...counters);
      // Clear the per-IP /verify rate-limit window — supertest pins
      // remoteAddress to 127.0.0.1, so each test in this file shares the
      // byIp bucket (limit: 5/min). Without this reset the 6th+ spec
      // returns 429 before reaching the route handler.
      const limitKeys = await redis.keys(`${config.appTag}:rl:accred-verify:*`);
      if (limitKeys.length > 0) await redis.del(...limitKeys);
      // Clear the idempotency cache — F5 caches HAF lookup results;
      // afterEach reset prevents one spec's cached result from poisoning
      // a subsequent spec keyed on the same idempotency_key.
      const idemKeys = await redis.keys(`${config.appTag}:idem:accred:*`);
      if (idemKeys.length > 0) await redis.del(...idemKeys);
    }
  });

  it('seedAccreditationBonus throws → 502 POST_BROADCAST_OPERATOR_REQUIRED with tx_id + failed_step:reputation_seed (F3 permanent discrimination)', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-idem-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'postbroadcastuser';
    await seedPendingAccreditation(token, username);

    hafQueryMock.mockResolvedValueOnce({ rows: [] });
    broadcastJsonMock.mockResolvedValueOnce({ id: 'confirmed-on-chain-tx' });
    // seedAccreditationBonus rethrows ONLY permanent classes (TypeError/
    // SyntaxError/RangeError per BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS).
    // Pin the permanent class explicitly so the test exercises the branch
    // F3 added (severity:'permanent' → POST_BROADCAST_OPERATOR_REQUIRED).
    seedBonusMock.mockRejectedValueOnce(new TypeError('reputation weights shape regression'));

    const res = await request(app).post('/api/accreditation/verify').send({ token });

    // F3: permanent severity surfaces as POST_BROADCAST_OPERATOR_REQUIRED
    // (distinct from POST_BROADCAST_FAILED — operator alerts route to DB
    // on-call, user message says "support has been notified" instead of
    // "will reconcile automatically").
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('POST_BROADCAST_OPERATOR_REQUIRED');
    expect(res.body.error.details).toMatchObject({
      retriable: false,
      outcome: 'confirmed',
      tx_id: 'confirmed-on-chain-tx',
      failed_step: 'reputation_seed',
    });
    // User-facing message reflects the permanent severity — "contact
    // support" instead of the transient "reconcile" copy. Round-3 hold #3
    // changed the prior "support has been notified" wording (which falsely
    // implied an alerting backend exists) to honest "please contact
    // support" copy.
    expect(res.body.error.message).toMatch(/contact support/i);
    // Token already cleaned up before the seed-bonus throw — the chain op
    // landed, so the token has done its job. The post_broadcast catch branch
    // does NOT delete it again.
    expect(await tokenExists(token)).toBe(false);
    // Internal error message MUST NOT leak into the user-facing payload.
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('reputation weights shape regression');
  });
});

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
 * coverage for `findAccreditationBroadcastByIdempotencyKey`,
 * `findCustodyBroadcastByIdempotencyKey`, and `findExistingAccreditation`
 * is filed as `backend-idempotency-haf-integration-test.md`. This file's
 * HAF mocks pin the route-side glue; the integration test will exercise
 * the SQL shape against a live HAF pool.
 *
 * Two-layer HAF call ordering: starting with the existing-accreditation
 * gate (BACKEND-ACCREDITATION-EXISTING-ACCREDITATION-GATE), /verify
 * performs TWO sequential HAF queries when both layers fire (gate miss
 * flows into per-token idempotency check). Tests below chain
 * `hafQueryMock.mockResolvedValueOnce({rows: []})` for the gate
 * preamble where needed.
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

    // Gate miss (no prior accredit op for this user), then per-token idempotency hit.
    hafQueryMock.mockResolvedValueOnce({ rows: [] });
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

    // Gate miss, then per-token idempotency hit. Both layers run before the
    // pre-INCR, so either layer's hit consumes zero cap slots.
    hafQueryMock.mockResolvedValueOnce({ rows: [] });
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

    // Gate miss + per-token idempotency miss → fall through to broadcast.
    hafQueryMock.mockResolvedValueOnce({ rows: [] });
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

    // Gate miss; per-token idempotency lookup throws — exercises the existing
    // `idempotency_lookup_failed` warn discrimination (not the gate's
    // `existing_accreditation_lookup_failed` warn, which is covered in a
    // separate spec below).
    hafQueryMock.mockResolvedValueOnce({ rows: [] });
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

  it('token cleanup failure on hit — 200 envelope unaffected + completion_record_failed_post_success warn', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-idem-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'idemverifyclean';
    await seedPendingAccreditation(token, username);

    // Gate miss, then per-token idempotency hit. The per-token hit branch
    // writes the grace-period completion record via
    // `recordAccreditationCompletionBestEffort`; a Redis flap inside the
    // helper surfaces the unified `completion_record_failed_post_success`
    // warn instead of the prior branch-specific cleanup warn.
    hafQueryMock.mockResolvedValueOnce({ rows: [] });
    hafQueryMock.mockResolvedValueOnce({
      rows: [{ trx_id: 'tx-prior-cleanup', block_num: 50001 }],
    });

    // Stub `redis.del` to throw exactly once. The helper's MULTI pipeline
    // does not touch `redis.del` directly, but the subsequent
    // `deleteBroadcastAttempts` call does — that throw propagates out and
    // is caught by the best-effort wrapper. Subsequent del calls work
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
        return ctx?.event === 'accreditation.verify.completion_record_failed_post_success';
      });
      expect(matchingCall, 'expected completion_record_failed_post_success warn').toBeDefined();
    } finally {
      warnSpy.mockRestore();
      // Restore real del so afterEach cleanup works.
      redisAny.del = originalDel as unknown as typeof redisAny.del;
    }
  });
});

// BACKEND-ACCREDITATION-EXISTING-ACCREDITATION-GATE — user-level "is this
// account already accredited?" HAF gate. Runs BEFORE the per-token
// idempotency check to close the multi-token coexistence class (two pending
// tokens for the same user produce different per-token keys, so the
// per-token check can't catch each other).
describe('accreditation /verify — existing-accreditation gate (user-level)', () => {
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
      const limitKeys = await redis.keys(`${config.appTag}:rl:accred-verify:*`);
      if (limitKeys.length > 0) await redis.del(...limitKeys);
      const idemKeys = await redis.keys(`${config.appTag}:idem:accred:*`);
      if (idemKeys.length > 0) await redis.del(...idemKeys);
    }
  });

  it('gate hit returns outcome:already_accredited, skips per-token check + broadcast, consumes zero cap slots', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-idem-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'gatehitsuser';
    await seedPendingAccreditation(token, username);

    // First (and only) HAF query is the gate. A second `mockResolvedValueOnce`
    // is NOT set: if the route reaches the per-token check on a gate hit,
    // the query would reject `mockResolvedValueOnce`'s no-more-mocks fallback
    // and the test would fail in an observable way.
    hafQueryMock.mockResolvedValueOnce({
      rows: [{ trx_id: 'tx-from-earlier-token', block_num: 42000, action: 'accredit' }],
    });

    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    try {
      const res = await request(app).post('/api/accreditation/verify').send({ token });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        message: 'Accreditation confirmed',
        username,
        tx_id: 'tx-from-earlier-token',
        outcome: 'already_accredited',
      });
      // No broadcast — chain op already exists for this account.
      expect(broadcastJsonMock).not.toHaveBeenCalled();
      // Bonus seed is NOT re-invoked on gate-hit (the prior /verify call
      // that produced the on-chain accredit op already seeded it; the
      // periodic reputation batch + boot-time backfillAccreditationSeeds
      // reconcile if it didn't).
      expect(seedBonusMock).not.toHaveBeenCalled();
      // Per-token idempotency check did NOT run — only one HAF call.
      expect(hafQueryMock).toHaveBeenCalledTimes(1);
      // Token cleanup runs on gate-hit so a subsequent retry with the same
      // token returns 400 BAD_REQUEST instead of looping.
      expect(await tokenExists(token)).toBe(false);
      // Cap counter never incremented — the gate runs before pre-INCR.
      const counter = await readBroadcastAttemptsCounter(token);
      expect(counter === null || counter === 0).toBe(true);
      // Structured event pin for operator dashboards.
      const matchingCall = infoSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'accreditation.verify.existing_accreditation_hit';
      });
      expect(matchingCall, 'expected accreditation.verify.existing_accreditation_hit info event').toBeDefined();
      expect(matchingCall![0]).toMatchObject({
        event: 'accreditation.verify.existing_accreditation_hit',
        route: 'accreditation.verify',
        username,
        email_hash: expect.any(String),
        tx_id: 'tx-from-earlier-token',
      });
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('gate hit returns 200 even when broadcast-attempts counter is at cap (gate runs before pre-INCR)', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-idem-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'gateatcapuser';
    await seedPendingAccreditation(token, username);

    // Pre-seed counter at cap. The gate must short-circuit BEFORE the cap
    // check; otherwise this would return 502 BROADCAST_ATTEMPT_LIMIT_EXCEEDED.
    const cap = config.verifyBroadcastAttemptsCap;
    await redis.set(`${config.appTag}:pending_accred_broadcast_attempts:${token}`, cap.toString(), 'EX', 86400);

    hafQueryMock.mockResolvedValueOnce({
      rows: [{ trx_id: 'tx-prior-gate-at-cap', block_num: 88888, action: 'accredit' }],
    });

    const res = await request(app).post('/api/accreditation/verify').send({ token });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      tx_id: 'tx-prior-gate-at-cap',
      outcome: 'already_accredited',
    });
    expect(res.body.error).toBeUndefined();
    expect(broadcastJsonMock).not.toHaveBeenCalled();
  });

  // Round-3 (architect α-disposition, 2026-05-16): gate-query failure no
  // longer degrades to broadcast. Under PEvO's operator-only-reversible
  // revoke semantic, fallthrough during HAF outage would let a fresh
  // accredit override a chain-recorded revoke — a structural gap, not a
  // bounded duplicate class. The route now returns 503 SERVICE_UNAVAILABLE
  // with a stable error code, preserves the token (no deleteToken), does
  // NOT increment the pre-INCR rate-limit counter, and does NOT broadcast.
  it('gate HAF throw returns 503 ACCREDITATION_GATE_UNAVAILABLE — token preserved, no broadcast, no cap INCR (round-3 α)', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-idem-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'gatethrowuser';
    await seedPendingAccreditation(token, username);

    // Only the gate query is exercised; if the route reached the per-token
    // check or broadcast, the next HAF call would be `mockResolvedValueOnce`'s
    // no-more-mocks fallback and the test would fail in an observable way.
    hafQueryMock.mockRejectedValueOnce(new Error('haf gate query exploded'));

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      const res = await request(app).post('/api/accreditation/verify').send({ token });

      // 503 envelope with stable error code + retriable hint.
      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({
        code: 'ACCREDITATION_GATE_UNAVAILABLE',
        details: { retriable: true },
      });
      // Server-driven backoff cadence: the 503 ACCREDITATION_GATE_UNAVAILABLE
      // emit sets `Retry-After: 30` so the SPA's `ApiRequestError` parses
      // a coherent retry floor via its `retryAfterSeconds` accessor.
      // 30s is the operator-tunable HAF-outage recovery default.
      // supertest lowercases header names per the Node http convention.
      expect(res.headers['retry-after']).toBe('30');
      // Broadcast must NOT fire under HAF outage — the override class is
      // closed by short-circuiting before the broadcast path.
      expect(broadcastJsonMock).not.toHaveBeenCalled();
      // Only the gate query was attempted — per-token check did not run.
      expect(hafQueryMock).toHaveBeenCalledTimes(1);
      // Token MUST remain valid so the user can retry once HAF recovers.
      // This is a deliberate divergence from the gate-hit and idempotency-
      // hit cleanup branches.
      expect(await tokenExists(token)).toBe(true);
      // Pre-INCR rate-limit counter must NOT have been touched — consistent
      // with the gate-hit / idempotency-hit short-circuits.
      const counter = await readBroadcastAttemptsCounter(token);
      expect(counter === null || counter === 0).toBe(true);
      // Structured-log event pin for operator dashboards. `warn` (not
      // `error`) per the project log-volume-minimal stance — this is an
      // external-dependency degraded-state, not a server-internal bug.
      const matchingCall = warnSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'accreditation.verify.existing_accreditation_gate_unavailable';
      });
      expect(matchingCall, 'expected existing_accreditation_gate_unavailable warn').toBeDefined();
      expect(matchingCall![0]).toMatchObject({
        event: 'accreditation.verify.existing_accreditation_gate_unavailable',
        route: 'accreditation.verify',
        username,
        email_hash: expect.any(String),
        err: expect.any(Error),
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Pin the per-IP slot-refund behaviour: the `accreditationVerifyLimiter`
  // declares `skipFailedRequests: true` so a 503 ACCREDITATION_GATE_UNAVAILABLE
  // response refunds the per-IP slot. Without it, a HAF outage burns the
  // IP's 5 slots/60s in 5 retries and the legitimate user trips 429
  // RATE_LIMITED for the next ~60s — locked out even after HAF recovers.
  // Mirrors the sibling `Hive getAccounts throws then recovers: 503
  // refunds limiter slot so the retry succeeds` canary against the
  // `upgradeLimiter` in `backend/tests/routes/custody-upgrade.test.ts`.
  // The limiter is keyed `byIp`; supertest pins remoteAddress to
  // 127.0.0.1 so every request in this file shares the same bucket. The
  // afterEach hook clears `rl:accred-verify:*` keys so this spec starts
  // at an empty bucket.
  it('503 ACCREDITATION_GATE_UNAVAILABLE refunds the per-IP limiter slot (skipFailedRequests canary)', async () => {
    const redis = getRedis();
    if (!redis) return;
    // Drive the limiter's max (5/60s) consecutive 503s. With
    // `skipFailedRequests: true`, every 503 refunds; without it, the
    // 6th request 429s before the handler runs.
    for (let i = 0; i < 5; i++) {
      const token = `accred-idem-refund-${i}-${crypto.randomBytes(8).toString('hex')}`;
      const username = `slotrefund${i}user`;
      await seedPendingAccreditation(token, username);
      hafQueryMock.mockRejectedValueOnce(new Error('haf outage'));
      const res = await request(app).post('/api/accreditation/verify').send({ token });
      expect(res.status).toBe(503);
      expect(res.body.error?.code).toBe('ACCREDITATION_GATE_UNAVAILABLE');
    }
    // 6th request from the same IP: if the slot-refund worked, this
    // reaches the route handler and returns 503 again. If it had NOT
    // refunded, the limiter would short-circuit with 429 RATE_LIMITED.
    // The discriminating assertion is `not.toBe(429)` — the exact
    // status of the 6th call depends on the next hafQueryMock setup
    // (here another 503) but the load-bearing claim is "the limiter
    // did not lock the user out."
    const finalToken = `accred-idem-refund-final-${crypto.randomBytes(8).toString('hex')}`;
    const finalUsername = 'slotrefundfinaluser';
    await seedPendingAccreditation(finalToken, finalUsername);
    hafQueryMock.mockRejectedValueOnce(new Error('haf still down'));
    const finalRes = await request(app)
      .post('/api/accreditation/verify')
      .send({ token: finalToken });
    expect(finalRes.status).not.toBe(429);
    // Confirm we reached the route handler (gate-throw path → 503).
    expect(finalRes.status).toBe(503);
    expect(finalRes.body.error?.code).toBe('ACCREDITATION_GATE_UNAVAILABLE');
  });

  it('gate-hit token cleanup failure — 200 envelope unaffected + completion_record_failed_post_success warn', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-idem-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'gatecleanuser';
    await seedPendingAccreditation(token, username);

    hafQueryMock.mockResolvedValueOnce({
      rows: [{ trx_id: 'tx-gate-cleanup-prior', block_num: 60000, action: 'accredit' }],
    });

    // The gate-hit branch writes the grace-period completion record via
    // `recordAccreditationCompletionBestEffort`. Stub `redis.del` to throw
    // exactly once so the post-pipeline `deleteBroadcastAttempts` call
    // throws inside the best-effort wrapper; the unified
    // `completion_record_failed_post_success` warn fires. Subsequent del
    // calls work normally so afterEach cleanup still runs.
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
        tx_id: 'tx-gate-cleanup-prior',
        outcome: 'already_accredited',
      });
      const matchingCall = warnSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'accreditation.verify.completion_record_failed_post_success';
      });
      expect(matchingCall, 'expected completion_record_failed_post_success warn').toBeDefined();
    } finally {
      warnSpy.mockRestore();
      redisAny.del = originalDel as unknown as typeof redisAny.del;
    }
  });

  // Round-1 hold #1 — revoke→re-accredit flow. A user previously accredited
  // and subsequently revoked (e.g., wot.ts:347 WoT-cleanup revoke producer)
  // must NOT hit the gate on their stale accredit op when retrying /verify.
  // Pre-fix the gate filtered on `action = 'accredit'` only and would have
  // returned 200 outcome:'already_accredited' with the stale tx_id, eaten
  // the fresh token in cleanup, and silently locked the user out of
  // re-accreditation. Post-fix the gate selects from action IN
  // ('accredit','revoke') ORDER BY (block_num, id) DESC LIMIT 1 and returns
  // null when the LIMIT-1 row is 'revoke', falling through to the per-token
  // idempotency check and ultimately broadcasting the fresh accredit op.
  it('revoke→re-accredit flow: latest action is revoke → gate falls through, fresh broadcast fires', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-idem-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'gaterevokeuser';
    await seedPendingAccreditation(token, username);

    // Gate query returns a row whose latest action is 'revoke' (prior
    // accredit was revoked later via wot.ts cleanup or admin action).
    // The helper inspects the action field and returns null, so the
    // route should fall through to the per-token check (miss → broadcast).
    hafQueryMock.mockResolvedValueOnce({
      rows: [{ trx_id: 'tx-revoke-after-accredit', block_num: 99999, action: 'revoke' }],
    });
    // Per-token idempotency miss → broadcast proceeds.
    hafQueryMock.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post('/api/accreditation/verify').send({ token });

    // Fresh broadcast envelope — the gate did NOT short-circuit on the
    // stale accredit tx_id. This is the regression guard for the round-1
    // P1 hold.
    expect(res.status).toBe(200);
    expect(res.body.data.tx_id).toBe('fresh-accred-tx-id');
    expect(res.body.data.outcome).toBeUndefined();
    expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
    // Both layers ran: gate (returned null from revoke-tail) and per-token
    // check (returned empty rows).
    expect(hafQueryMock).toHaveBeenCalledTimes(2);
    // Bonus seed fires on the broadcast path.
    expect(seedBonusMock).toHaveBeenCalledWith(username);
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

    // Gate miss + per-token idempotency miss → reaches broadcast.
    hafQueryMock.mockResolvedValueOnce({ rows: [] });
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
    // on-call, user message asks the user to contact support directly
    // instead of "will reconcile automatically"; round-3 hold #3 corrected
    // the prior "support has been notified" copy to an honest "please
    // contact support" until alerting actually fires).
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
    // Token cleaned up by the post_broadcast catch branch — the seed-
    // bonus throw fires BEFORE the completion-record write, so the
    // catch branch deletes the pending row best-effort. A retry on
    // the same token surfaces 400 BAD_REQUEST rather than masking the
    // 502's operator-actionable signal under a cached grace-period 200.
    expect(await tokenExists(token)).toBe(false);
    // Internal error message MUST NOT leak into the user-facing payload.
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('reputation weights shape regression');
  });
});

describe('accreditation /verify — grace-period idempotency (AbortError-after-success)', () => {
  // The SPA's 30s AbortSignal.timeout can fire AFTER the backend has
  // committed the on-chain broadcast and deleted the pending token but
  // BEFORE the 200 envelope lands at the client. The SPA's retriable-error
  // UX sends the same token again; without a grace-period record the route
  // falls through to 400 BAD_REQUEST and the user enters the "Request
  // New" cascade despite the broadcast having actually succeeded. These
  // specs pin the route-side fix: the success path writes an
  // `accreditation-completed:<sha256(token)>` record atomically with the
  // token delete; a subsequent /verify on the same token reads that
  // record and returns the SAME 200 envelope as the original flight.
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
      const keys = await redis.keys(`${config.appTag}:pending_accred:accred-grace-*`);
      if (keys.length > 0) await redis.del(...keys);
      const counters = await redis.keys(`${config.appTag}:pending_accred_broadcast_attempts:accred-grace-*`);
      if (counters.length > 0) await redis.del(...counters);
      const completionKeys = await redis.keys(`${config.appTag}:accreditation-completed:*`);
      if (completionKeys.length > 0) await redis.del(...completionKeys);
      const limitKeys = await redis.keys(`${config.appTag}:rl:accred-verify:*`);
      if (limitKeys.length > 0) await redis.del(...limitKeys);
      const idemKeys = await redis.keys(`${config.appTag}:idem:accred:*`);
      if (idemKeys.length > 0) await redis.del(...idemKeys);
    }
  });

  it('retried /verify on the same token returns the identical 200 envelope after broadcast success', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-grace-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'graceperioduser';
    await seedPendingAccreditation(token, username);

    // First flight: gate miss + idempotency miss → broadcast → success.
    hafQueryMock.mockResolvedValueOnce({ rows: [] }); // gate
    hafQueryMock.mockResolvedValueOnce({ rows: [] }); // idempotency
    broadcastJsonMock.mockResolvedValueOnce({ id: 'tx-grace-canary-1' });

    const firstRes = await request(app).post('/api/accreditation/verify').send({ token });
    expect(firstRes.status).toBe(200);
    expect(firstRes.body.data).toMatchObject({
      message: 'Accreditation confirmed',
      username,
      tx_id: 'tx-grace-canary-1',
    });

    // Side-effect: token was deleted on success; grace-period record
    // was written atomically with the delete.
    expect(await tokenExists(token)).toBe(false);
    const digest = crypto.createHash('sha256').update(token).digest('hex');
    const stored = await redis.get(`${config.appTag}:accreditation-completed:${digest}`);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string)).toEqual({
      username,
      tx_id: 'tx-grace-canary-1',
    });

    // Second flight on the same token: the SPA's retry after an
    // AbortError. The broadcast must NOT fire again — the grace-period
    // record satisfies the request.
    const broadcastCallsBefore = broadcastJsonMock.mock.calls.length;
    const retryRes = await request(app).post('/api/accreditation/verify').send({ token });

    expect(retryRes.status).toBe(200);
    expect(broadcastJsonMock.mock.calls.length).toBe(broadcastCallsBefore);
    // Envelope shape MUST be identical to the original flight — the SPA's
    // existing success-state handler renders without branching. Compare
    // `body.data` directly: a future field added to the fresh-success
    // shape that isn't mirrored in the grace-period path would fail this.
    expect(retryRes.body.data).toEqual(firstRes.body.data);
  });

  it('grace-period miss with no pending token returns 400 BAD_REQUEST (pre-task baseline preserved)', async () => {
    // No seedPendingAccreditation, no grace-period record. The unknown
    // token must continue to surface 400 — anything else turns
    // `/verify` into an existence oracle.
    const token = `accred-grace-${crypto.randomBytes(8).toString('hex')}`;

    const res = await request(app).post('/api/accreditation/verify').send({ token });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('BAD_REQUEST');
    expect(res.body.error?.message).toMatch(/invalid or expired token/i);
  });

  it('grace-period record carries the broadcast tx_id, not the gate-hit tx_id', async () => {
    // Sanity pin: the record stores the FRESH broadcast id. A regression
    // that wrote the gate-existing tx_id (e.g., from a prior cached HAF
    // lookup) would surface as a tx_id mismatch on retry. This guards
    // against a future refactor that confuses the two id sources.
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-grace-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'gracetxiduser';
    await seedPendingAccreditation(token, username);

    hafQueryMock.mockResolvedValueOnce({ rows: [] });
    hafQueryMock.mockResolvedValueOnce({ rows: [] });
    broadcastJsonMock.mockResolvedValueOnce({ id: 'tx-fresh-id-only' });

    const firstRes = await request(app).post('/api/accreditation/verify').send({ token });
    expect(firstRes.body.data?.tx_id).toBe('tx-fresh-id-only');

    const digest = crypto.createHash('sha256').update(token).digest('hex');
    const stored = await redis.get(`${config.appTag}:accreditation-completed:${digest}`);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string).tx_id).toBe('tx-fresh-id-only');
  });

  it('retried /verify after existing-accreditation gate-hit returns cached 200 envelope, broadcast not invoked', async () => {
    // The gate-hit branch returns 200 outcome:'already_accredited' with the
    // prior on-chain tx_id. An AbortError-after-success retry on the same
    // token must surface the same 200 envelope rather than cascading to
    // 400 BAD_REQUEST. The gate-hit branch writes the grace-period
    // completion record with the gate's tx_id; the read site on retry
    // returns the canonical 3-field success envelope.
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-grace-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'gracegatehitretry';
    await seedPendingAccreditation(token, username);

    // First flight: gate hit.
    hafQueryMock.mockResolvedValueOnce({
      rows: [{ trx_id: 'tx-gate-grace-prior', block_num: 70000, action: 'accredit' }],
    });

    const firstRes = await request(app).post('/api/accreditation/verify').send({ token });
    expect(firstRes.status).toBe(200);
    expect(firstRes.body.data).toMatchObject({
      message: 'Accreditation confirmed',
      username,
      tx_id: 'tx-gate-grace-prior',
      outcome: 'already_accredited',
    });
    // Broadcast never fires on the gate-hit branch.
    expect(broadcastJsonMock).not.toHaveBeenCalled();

    // Grace-period record landed with the gate's tx_id; pending row gone.
    expect(await tokenExists(token)).toBe(false);
    const digest = crypto.createHash('sha256').update(token).digest('hex');
    const stored = await redis.get(`${config.appTag}:accreditation-completed:${digest}`);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string)).toEqual({
      username,
      tx_id: 'tx-gate-grace-prior',
    });

    // Second flight: retry. Reads the grace-period record and returns the
    // canonical 200 envelope. The HAF gate query must NOT fire — the
    // record short-circuits before any HAF/broadcast work. (No additional
    // `mockResolvedValueOnce` set here: if the route reached the gate on
    // retry, supertest would surface a no-more-mocks rejection.)
    const broadcastCallsBefore = broadcastJsonMock.mock.calls.length;
    const hafCallsBefore = hafQueryMock.mock.calls.length;
    const retryRes = await request(app).post('/api/accreditation/verify').send({ token });

    expect(retryRes.status).toBe(200);
    expect(retryRes.body.data).toMatchObject({
      message: 'Accreditation confirmed',
      username,
      tx_id: 'tx-gate-grace-prior',
    });
    // The retry's envelope omits the `outcome` field by design — the
    // cached read returns the canonical 3-field success shape, which is
    // what the SPA's success-state handler renders without branching.
    expect(retryRes.body.data.outcome).toBeUndefined();
    expect(broadcastJsonMock.mock.calls.length).toBe(broadcastCallsBefore);
    expect(hafQueryMock.mock.calls.length).toBe(hafCallsBefore);
  });

  it('retried /verify after per-token idempotency-hit returns cached 200 envelope, broadcast not invoked', async () => {
    // The per-token idempotency-hit branch returns 200 outcome:'already_landed'
    // with the prior broadcast's tx_id (recovered from HAF via
    // `lookupAccreditationBroadcastIdempotency`). An AbortError-after-success
    // retry on the same token must surface the same 200 envelope rather
    // than cascading to 400 BAD_REQUEST. The idem-hit branch writes the
    // grace-period completion record with the recovered tx_id.
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-grace-${crypto.randomBytes(8).toString('hex')}`;
    const username = 'graceidemhitretry';
    await seedPendingAccreditation(token, username);

    // First flight: gate miss + per-token idempotency hit.
    hafQueryMock.mockResolvedValueOnce({ rows: [] });
    hafQueryMock.mockResolvedValueOnce({
      rows: [{ trx_id: 'tx-idem-grace-prior', block_num: 80000 }],
    });

    const firstRes = await request(app).post('/api/accreditation/verify').send({ token });
    expect(firstRes.status).toBe(200);
    expect(firstRes.body.data).toMatchObject({
      message: 'Accreditation confirmed',
      username,
      tx_id: 'tx-idem-grace-prior',
      outcome: 'already_landed',
    });
    // Broadcast never fires on the idempotency-hit branch.
    expect(broadcastJsonMock).not.toHaveBeenCalled();

    // Grace-period record landed with the idempotency-recovered tx_id;
    // pending row gone.
    expect(await tokenExists(token)).toBe(false);
    const digest = crypto.createHash('sha256').update(token).digest('hex');
    const stored = await redis.get(`${config.appTag}:accreditation-completed:${digest}`);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string)).toEqual({
      username,
      tx_id: 'tx-idem-grace-prior',
    });

    // Second flight: retry. Reads the grace-period record and returns the
    // canonical 200 envelope. Neither HAF nor the broadcast fires.
    const broadcastCallsBefore = broadcastJsonMock.mock.calls.length;
    const hafCallsBefore = hafQueryMock.mock.calls.length;
    const retryRes = await request(app).post('/api/accreditation/verify').send({ token });

    expect(retryRes.status).toBe(200);
    expect(retryRes.body.data).toMatchObject({
      message: 'Accreditation confirmed',
      username,
      tx_id: 'tx-idem-grace-prior',
    });
    expect(retryRes.body.data.outcome).toBeUndefined();
    expect(broadcastJsonMock.mock.calls.length).toBe(broadcastCallsBefore);
    expect(hafQueryMock.mock.calls.length).toBe(hafCallsBefore);
  });
});

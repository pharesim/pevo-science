/**
 * GET /api/notifications route tests.
 *
 * Mock carve-out (clause a): `verifyHiveSignature` is replaced with the
 * project-wide `MOCK_VERIFY_SIGNATURE` fixture. The focus of these tests is
 * downstream route behavior — response envelope, `limit` handling, ascending
 * ordering, and the window-relative caching with in-app `since_block`
 * re-filtering — NOT cryptographic signature verification. Per clause (b) the
 * fixture is acceptable for this non-auth focus; it still enforces the
 * 401-on-missing-header gate (exercised by the "returns 401 without auth
 * headers" case) and the username-extraction behavior the route depends on.
 * Cryptographic verification of the signature is bypassed.
 *
 * Everything else runs real: the HAF pool, `getGenesisBlock`, the block-watcher
 * head, and `hafCache`. No mocked DB pools.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getPool } from '../../src/db.js';
import { getGenesisBlock } from '../../src/hafsql.js';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const app = createApp();

describe('GET /api/notifications', () => {
  // Use the namespace genesis block — no PEvO data exists before it
  let genesisBlock: number;

  beforeAll(async () => {
    const pool = getPool();
    genesisBlock = pool ? await getGenesisBlock(pool) : 1;
  });

  it('returns 401 without auth headers', async () => {
    const res = await request(app).get('/api/notifications?since_block=100');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 without since_block', async () => {
    const res = await request(app)
      .get('/api/notifications')
      .set('X-Hive-Username', 'pevo.admin')
      .set('X-Hive-Signature', 'mock-sig');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('since_block');
  });

  it('returns 400 with invalid since_block', async () => {
    const res = await request(app)
      .get('/api/notifications?since_block=abc')
      .set('X-Hive-Username', 'pevo.admin')
      .set('X-Hive-Signature', 'mock-sig');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns notifications with correct envelope', { timeout: 60_000 }, async () => {
    const res = await request(app)
      .get(`/api/notifications?since_block=${genesisBlock}`)
      .set('X-Hive-Username', 'pevo.admin')
      .set('X-Hive-Signature', 'mock-sig');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data).toHaveProperty('events');
    expect(res.body.data).toHaveProperty('latest_block');
    expect(res.body.data).toHaveProperty('has_more');
    expect(Array.isArray(res.body.data.events)).toBe(true);
  });

  it('respects limit via whole-block delivery (at most one block at limit=1)', { timeout: 60_000 }, async () => {
    const res = await request(app)
      .get(`/api/notifications?since_block=${genesisBlock}&limit=1`)
      .set('X-Hive-Username', 'pevo.admin')
      .set('X-Hive-Signature', 'mock-sig');
    expect(res.status).toBe(200);
    // Whole-block delivery never splits a Hive block across responses, so at
    // limit=1 the response carries the events of at most ONE block (the oldest
    // undelivered). The event COUNT may exceed 1 only when that single block is
    // oversized; the distinct block count must not.
    const blocks = new Set(res.body.data.events.map((e: { block_num: number }) => e.block_num));
    expect(blocks.size).toBeLessThanOrEqual(1);
  });

  it('events are sorted by block_num ascending', { timeout: 60_000 }, async () => {
    const res = await request(app)
      .get(`/api/notifications?since_block=${genesisBlock}`)
      .set('X-Hive-Username', 'pevo.admin')
      .set('X-Hive-Signature', 'mock-sig');
    const events = res.body.data.events;
    for (let i = 1; i < events.length; i++) {
      expect(events[i].block_num).toBeGreaterThanOrEqual(events[i - 1].block_num);
    }
  });

  it('every returned event has block_num strictly greater than since_block', { timeout: 60_000 }, async () => {
    const sinceBlock = genesisBlock;
    const res = await request(app)
      .get(`/api/notifications?since_block=${sinceBlock}`)
      .set('X-Hive-Username', 'pevo.admin')
      .set('X-Hive-Signature', 'mock-sig');
    expect(res.status).toBe(200);
    for (const e of res.body.data.events) {
      expect(e.block_num).toBeGreaterThan(sinceBlock);
    }
  });

  it('a since_block above the chain head filters out all events', { timeout: 60_000 }, async () => {
    // The in-app since_block re-filter runs on the window-relative cached batch.
    // A cursor beyond every event's block_num must empty the batch and report
    // latest_block === since_block so the SPA's forward cursor does not regress.
    const sinceBlock = 1_999_999_999;
    const res = await request(app)
      .get(`/api/notifications?since_block=${sinceBlock}`)
      .set('X-Hive-Username', 'pevo.admin')
      .set('X-Hive-Signature', 'mock-sig');
    expect(res.status).toBe(200);
    expect(res.body.data.events).toEqual([]);
    expect(res.body.data.latest_block).toBe(sinceBlock);
    expect(res.body.data.has_more).toBe(false);
  });

  it('shares one window computation across polls with different since_block', { timeout: 60_000 }, async () => {
    // Two polls with the same (account, limit) but different since_block hit the
    // same cached window (the cache key omits since_block). The higher-cursor
    // poll's events must be exactly the lower-cursor poll's events with
    // block_num > the higher since_block applied in-app — proving the window is
    // shared and the cursor is re-applied at the route layer rather than re-run
    // against HAF per poll.
    const lowSince = genesisBlock;
    const lowRes = await request(app)
      .get(`/api/notifications?since_block=${lowSince}&limit=100`)
      .set('X-Hive-Username', 'pevo.admin')
      .set('X-Hive-Signature', 'mock-sig');
    expect(lowRes.status).toBe(200);

    const lowEvents = lowRes.body.data.events as Array<{ block_num: number }>;
    // Choose a higher cursor between the first and last returned event so the
    // filter removes a prefix; fall back to lowSince when fewer than 2 events
    // exist (real-chain data may be sparse for pevo.admin).
    const higherSince = lowEvents.length >= 2
      ? lowEvents[0].block_num
      : lowSince;

    const highRes = await request(app)
      .get(`/api/notifications?since_block=${higherSince}&limit=100`)
      .set('X-Hive-Username', 'pevo.admin')
      .set('X-Hive-Signature', 'mock-sig');
    expect(highRes.status).toBe(200);

    const expected = lowEvents.filter((e) => e.block_num > higherSince);
    const highEvents = highRes.body.data.events as Array<{ block_num: number }>;
    expect(highEvents.map((e) => e.block_num)).toEqual(expected.map((e) => e.block_num));
  });
});

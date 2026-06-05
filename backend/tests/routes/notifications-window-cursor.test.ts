/**
 * GET /api/notifications — window-batch cursor + has_more canaries.
 *
 * Per CLAUDE.md "Running Tests" carve-out clauses (a)/(b)/(c):
 *   (a) Real-corpus seeding is impractical: these canaries need a DETERMINISTIC
 *       window batch of known size with controlled block numbers, plus a
 *       per-request notification-query CALL COUNT, to pin (1) the internal fetch
 *       cap is decoupled from the response `limit`, (2) `has_more` is recomputed
 *       over the capped batch rather than forced false on any cursor removal,
 *       and (3) the stable per-(account,limit) cache is shared across polls and
 *       survives clearVolatile. The public HAF corpus cannot be seeded with an
 *       exact >limit in-window event set at test time, and a real query gives no
 *       call-count seam. Three shared pool/cache helpers — all explicitly inside
 *       the carve-out's mock-target scope — are mocked:
 *         - `getPool` feeds a controlled row set and counts notification-query
 *           invocations (the LIMIT is param $3 = index 2 of the captured params).
 *         - `getRedis` → null forces the cache's deterministic in-memory path
 *           (no Redis connection state, no cross-test key bleed).
 *         - `getGenesisBlock` → 0 neutralizes the global tests/setup.ts genesis
 *           warm-up (which caches the real namespace genesis in the hafsql module
 *           and would otherwise clamp every since_block forward, stripping the
 *           low-numbered deterministic fixtures). The genesis/clamp path is NOT
 *           the behavior under test here; notifications.test.ts exercises the
 *           real genesis clamp against real HAF.
 *   (b) `verifyHiveSignature` is mocked via the project-wide MOCK_VERIFY_SIGNATURE
 *       fixture (see test-mock-carve-out-clause-c-2026-05-04.md). This file's
 *       focus is the route's cursor/has_more/cache-sharing behavior, NOT
 *       cryptographic verification; the fixture preserves the 401-on-missing-header
 *       gate and username extraction, bypassing only the signature check. The
 *       clause-(c) real-path companion for the cryptographic-verification risk
 *       class on /api/notifications is auth.test.ts (real verifyHiveSignature
 *       against signed requests).
 *   (c) Real-path companion: notifications.test.ts exercises the envelope shape,
 *       ascending order, limit handling, the in-app since_block filter, and the
 *       real genesis clamp against real HAF; this file covers the cap-decoupling
 *       + has_more recomputation + cache-sharing that real-chain nondeterminism
 *       cannot pin.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

// Force the in-memory cache path: deterministic, no Redis connection state.
vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => { /* no-op */ },
  redisRetryStrategy: () => null,
}));

// Neutralize the tests/setup.ts genesis warm-up so the route does not clamp the
// deterministic low-block fixtures forward. Everything else in hafsql stays real
// (T, the CTE builders fetchNotificationsFromHaf composes its SQL from, etc.).
vi.mock('../../src/hafsql.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/hafsql.js')>('../../src/hafsql.js');
  return { ...actual, getGenesisBlock: async () => 0 };
});

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async (..._args: any[]) => ({ rows: [] as any[] })),
  getPoolMock: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  getPool: getPoolMock,
  isHafConfigured: () => getPoolMock() !== null,
  closeHafPool: async () => { /* no-op */ },
}));

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');
const app = createApp();

// Controlled window batch the mocked notification query returns. Each row is a
// minimal new_review projection; only block_num drives the cursor/slice logic.
let windowRows: Array<Record<string, unknown>> = [];
// Count of notification-query (not genesis) invocations, for the cache-sharing pins.
let notificationQueryCalls = 0;
// Params captured from the most recent notification query (LIMIT is $3 = index 2).
let lastNotificationParams: unknown[] = [];

function reviewRow(block: number): Record<string, unknown> {
  return {
    event_type: 'new_review',
    block_num: block,
    event_timestamp: new Date(block * 1000).toISOString(),
    actor: 'reviewer.acct',
    paper_author: 'pevo.admin',
    paper_permlink: `paper-${block}`,
    paper_title: `Paper ${block}`,
    event_permlink: `review-${block}`,
    target_type: null,
    vote_weight: null,
    accredit_action: null,
    accredit_method: null,
    vouch_relationship: null,
    parent_author: null,
    parent_permlink_ref: null,
  };
}

beforeEach(async () => {
  windowRows = [];
  notificationQueryCalls = 0;
  lastNotificationParams = [];
  hafQueryMock.mockReset().mockImplementation(async (sql: string, params?: unknown[]) => {
    // The notification CTE-chain, distinguishable by the new_review arm tag.
    if (sql.includes("'new_review'::text")) {
      notificationQueryCalls += 1;
      lastNotificationParams = params ?? [];
      return { rows: windowRows };
    }
    return { rows: [] };
  });
  getPoolMock.mockReset().mockReturnValue({ query: hafQueryMock });
  await hafCache.clear();
});

function poll(sinceBlock: number, limit?: number) {
  const q = limit === undefined
    ? `/api/notifications?since_block=${sinceBlock}`
    : `/api/notifications?since_block=${sinceBlock}&limit=${limit}`;
  return request(app)
    .get(q)
    .set('X-Hive-Username', 'pevo.admin')
    .set('X-Hive-Signature', 'mock-sig');
}

describe('GET /api/notifications — window-batch cursor + has_more', () => {
  it('fetches the window batch with the internal cap as LIMIT, not the response limit', async () => {
    windowRows = [reviewRow(100), reviewRow(200)];
    const res = await poll(0, 2);
    expect(res.status).toBe(200);
    // $3 (index 2) is the SQL LIMIT. It must be the internal window cap,
    // decoupled from the response limit (2). If a refactor re-couples the fetch
    // LIMIT to the response limit, the cached batch shrinks to the oldest
    // `limit` events and the starvation bug returns. Asserting a value far above
    // any plausible response limit pins the decoupling without hardcoding the
    // exact constant brittle-ly.
    expect(typeof lastNotificationParams[2]).toBe('number');
    expect(lastNotificationParams[2] as number).toBeGreaterThanOrEqual(500);
  });

  it('surfaces newer in-window events past a caught-up cursor (starvation fix)', async () => {
    // The bug: with the fetch LIMIT coupled to the response limit (2), the cached
    // batch would be only the OLDEST two events [100,200]; a cursor at 250 would
    // strip the whole batch and freeze the feed while 300/400/500 sit beyond the
    // cut. With the cap decoupled, the batch holds all five and the cursor
    // surfaces the newer ones.
    windowRows = [100, 200, 300, 400, 500].map(reviewRow);
    const res = await poll(250, 2);
    expect(res.status).toBe(200);
    expect(res.body.data.events.map((e: { block_num: number }) => e.block_num)).toEqual([300, 400]);
    expect(res.body.data.has_more).toBe(true);
  });

  it('has_more is true when the cursor filter leaves more than limit (partial filter, mid-window cursor)', async () => {
    windowRows = [100, 200, 300, 400, 500].map(reviewRow);
    const res = await poll(150, 2);
    expect(res.status).toBe(200);
    // filtered = [200,300,400,500] (4) > limit (2) → undelivered in-window events remain.
    expect(res.body.data.events.map((e: { block_num: number }) => e.block_num)).toEqual([200, 300]);
    expect(res.body.data.has_more).toBe(true);
    // latest_block is the highest delivered block so the SPA's next poll resumes forward.
    expect(res.body.data.latest_block).toBe(300);
  });

  it('has_more is false when the remaining filtered events all fit in limit', async () => {
    windowRows = [100, 200, 300, 400, 500].map(reviewRow);
    const res = await poll(300, 10);
    expect(res.status).toBe(200);
    // filtered = [400,500] (2) <= limit (10), and the batch did not hit its cap.
    expect(res.body.data.events.map((e: { block_num: number }) => e.block_num)).toEqual([400, 500]);
    expect(res.body.data.has_more).toBe(false);
    expect(res.body.data.latest_block).toBe(500);
  });

  it('all-filtered cursor → empty events, latest_block parks at since_block, has_more false', async () => {
    windowRows = [100, 200, 300, 400, 500].map(reviewRow);
    const res = await poll(999, 2);
    expect(res.status).toBe(200);
    expect(res.body.data.events).toEqual([]);
    expect(res.body.data.latest_block).toBe(999);
    expect(res.body.data.has_more).toBe(false);
  });

  it('has_more stays true via batch.has_more when the cap is hit even if the slice fits limit', async () => {
    // A full-cap batch (>= the internal fetch cap) reports has_more at the SQL
    // layer. When the cursor strips all but one delivered event, the cursor-side
    // overflow is zero, but newer events beyond the cap still exist — has_more
    // must remain true via the `|| batch.has_more` clause.
    windowRows = Array.from({ length: 1000 }, (_, i) => reviewRow(i + 1));
    const res = await poll(999, 10);
    expect(res.status).toBe(200);
    // filtered = [1000] (1), fits in limit (10) → cursor overflow is zero, but the
    // 1000-row batch hit the cap (batch.has_more true).
    expect(res.body.data.events.map((e: { block_num: number }) => e.block_num)).toEqual([1000]);
    expect(res.body.data.has_more).toBe(true);
  });

  it('a second poll with a different cursor reuses the cached window (zero extra notification queries)', async () => {
    windowRows = [100, 200, 300, 400, 500].map(reviewRow);
    await poll(0, 50);
    expect(notificationQueryCalls).toBe(1);
    // Different cursor, same (account, limit) → served from the stable cache.
    const res2 = await poll(300, 50);
    expect(res2.status).toBe(200);
    expect(res2.body.data.events.map((e: { block_num: number }) => e.block_num)).toEqual([400, 500]);
    // Still one HAF computation — the cache key omits since_block, so the second
    // poll must not re-run the 9-arm UNION. A regression that re-includes
    // since_block in the key (or drops the cache) makes this 2.
    expect(notificationQueryCalls).toBe(1);
  });

  it('the stable notification cache survives a clearVolatile block tick', async () => {
    windowRows = [100, 200, 300, 400, 500].map(reviewRow);
    await poll(0, 50);
    expect(notificationQueryCalls).toBe(1);
    // The block-watcher fires clearVolatile() on every ~3s tick. The notification
    // key is written stable:true, so it must survive — otherwise every tick
    // re-runs the expensive UNION for every polling client.
    await hafCache.clearVolatile();
    const res2 = await poll(120, 50);
    expect(res2.status).toBe(200);
    expect(notificationQueryCalls).toBe(1);
  });
});

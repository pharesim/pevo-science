/**
 * GET /api/notifications — window-batch cursor + has_more canaries.
 *
 * Per CLAUDE.md "Running Tests" carve-out clauses (a)/(b)/(c):
 *   (a) Real-corpus seeding is impractical: these canaries need a DETERMINISTIC
 *       window batch of known size with controlled block numbers (including
 *       multiple events sharing one Hive block, and a cap-many batch), plus a
 *       per-request notification-query CALL COUNT, to pin (1) the internal fetch
 *       cap is decoupled from the response `limit` and fetched newest-first with
 *       the op_id same-block tie-breaker, (2) whole-block delivery — a single
 *       oversized block is delivered atomically (no stall) and the cap-truncation
 *       boundary block is dropped whole (the batch never ends mid-block), (3)
 *       `has_more` is `filtered > delivered` and does NOT OR-in the below-floor
 *       `batch.has_more` (no permanent park for a caught-up cursor), and (4) the
 *       stable per-(account,limit) cache is shared across polls and survives
 *       clearVolatile. The public HAF corpus cannot be seeded with an exact
 *       >limit / >cap in-window event set at test time, and a real query gives no
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
 *       The MOCK_VERIFY_SIGNATURE fixture additionally bypasses CRYPTOGRAPHIC
 *       signature verification (see test-mock-carve-out-clause-c-2026-05-04.md):
 *       this file's focus is the route's cursor / has_more / whole-block / cache
 *       behavior, NOT cryptographic verification, so the bypass is permitted. The
 *       fixture still preserves the 401-on-missing-header gate and the
 *       username-extraction the route depends on; only the signature check is
 *       skipped.
 *   (b) Auth/permission middleware runs REAL in tests whose focus IS
 *       authentication; this file's focus is downstream route behavior, so the
 *       MOCK_VERIFY_SIGNATURE fixture is acceptable under the carve-out's
 *       clause-(b) refinement. The clause-(c) real-path companion for the
 *       cryptographic-verification risk class on /api/notifications is
 *       auth.test.ts (real verifyHiveSignature against signed requests).
 *   (c) Real-path companion: notifications.test.ts exercises the envelope shape,
 *       ascending order, whole-block limit handling, the in-app since_block
 *       filter, and the real genesis clamp against real HAF; this file covers the
 *       newest-first cap + whole-block delivery + cap-boundary drop + has_more
 *       semantics + cache-sharing that real-chain nondeterminism cannot pin.
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
const { NOTIFICATION_WINDOW_FETCH_CAP } = await import('../../src/notification-queries.js');
const app = createApp();

// Controlled window batch the mocked notification query returns. Each row is a
// minimal new_review projection; only block_num drives the cursor/slice logic.
let windowRows: Array<Record<string, unknown>> = [];
// Count of notification-query (not genesis) invocations, for the cache-sharing pins.
let notificationQueryCalls = 0;
// Params captured from the most recent notification query (LIMIT is $3 = index 2).
let lastNotificationParams: unknown[] = [];
// SQL of the most recent notification query, for the order/tie-breaker pins.
let lastNotificationSql = '';

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

// Multiple distinct events sharing one Hive block — for whole-block delivery and
// cap-boundary-drop tests. `seq` keeps the permlinks distinct within the block.
function reviewRowAt(block: number, seq: number): Record<string, unknown> {
  return {
    ...reviewRow(block),
    paper_permlink: `paper-${block}-${seq}`,
    event_permlink: `review-${block}-${seq}`,
  };
}

// cap+1 rows in DESC (newest-first) order — simulates the route's 'desc' fetch
// returning ONE probe row beyond the cap (the genuine-truncation signal). Blocks
// run `hi` down to `hi - cap` (cap + 1 distinct blocks). The mock returns these
// verbatim; the shared fetch slices the probe at the truncated (oldest) end.
function descCapPlusOne(hi: number): Array<Record<string, unknown>> {
  return Array.from({ length: NOTIFICATION_WINDOW_FETCH_CAP + 1 }, (_, i) => reviewRow(hi - i));
}

beforeEach(async () => {
  windowRows = [];
  notificationQueryCalls = 0;
  lastNotificationParams = [];
  lastNotificationSql = '';
  hafQueryMock.mockReset().mockImplementation(async (sql: string, params?: unknown[]) => {
    // The notification CTE-chain, distinguishable by the new_review arm tag.
    if (sql.includes("'new_review'::text")) {
      notificationQueryCalls += 1;
      lastNotificationParams = params ?? [];
      lastNotificationSql = sql;
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
    // $3 (index 2) is the SQL LIMIT. It must be the internal window cap PLUS the
    // +1 truncation probe (cap + 1), decoupled from the response limit (2). If a
    // refactor re-couples the fetch LIMIT to the response limit, the cached batch
    // shrinks to a `limit`-sized slice and the starvation bug returns; if the +1
    // probe is dropped, the exactly-cap false-drop bug (item 1) returns. Pin the
    // exact value so either regression fails red.
    expect(lastNotificationParams[2]).toBe(NOTIFICATION_WINDOW_FETCH_CAP + 1);
  });

  it('the bell-feed fetch is newest-first with the op_id same-block tie-breaker', async () => {
    windowRows = [reviewRow(100)];
    const res = await poll(0, 2);
    expect(res.status).toBe(200);
    // The route fetches 'desc' (newest-first) so the cap keeps the NEWEST events.
    // The same-block tie-breaker is the monotonic HAF op id; without it the cap
    // cut through a block would be nondeterministic. A flip to ASC re-introduces
    // the >CAP starvation, and dropping op_id re-introduces the nondeterministic
    // boundary.
    expect(lastNotificationSql).toContain('ORDER BY block_num DESC, op_id DESC');
    // Each UNION arm projects its op id as op_id (one example per op-view type).
    expect(lastNotificationSql).toMatch(/co\.id AS op_id/);
    expect(lastNotificationSql).toMatch(/v\.id AS op_id/);
    expect(lastNotificationSql).toMatch(/cj\.id AS op_id/);
    expect(lastNotificationSql).toMatch(/citing\.id AS op_id/);
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

  it('an EXACTLY-cap window drops nothing — the complete boundary block is delivered (item-1 fix)', async () => {
    // Exactly `cap` events, all complete blocks: the +1 probe row does NOT
    // materialize (only `cap` rows exist), so capHit is false and the boundary
    // (oldest) block is NOT dropped. The pre-fix `>= cap` over a plain `LIMIT cap`
    // false-fired here and dropped block 1 — which a forward newest-first cursor
    // never recovers. Mutation-kill: under the bug `Math.min` would be 2, not 1.
    windowRows = Array.from({ length: NOTIFICATION_WINDOW_FETCH_CAP }, (_, i) => reviewRow(NOTIFICATION_WINDOW_FETCH_CAP - i));
    const res = await poll(0, 100);
    expect(res.status).toBe(200);
    const blocks = res.body.data.events.map((e: { block_num: number }) => e.block_num);
    expect(Math.min(...blocks)).toBe(1);  // oldest COMPLETE block present, not dropped
  });

  it('a cap-hit batch does NOT force has_more for a caught-up cursor (no permanent park)', async () => {
    // A genuine >cap window (cap+1 rows, newest-first): block 1 is the probe
    // (sliced at the truncated end), block 2 is the dropped boundary, so the batch
    // is blocks 3..(cap+1). batch.has_more is true (older events exist below the
    // floor), but under newest-first those are unreachable by a forward cursor —
    // the digest covers them — so the route must NOT OR-in batch.has_more: a
    // cursor caught up to the newest delivered block reports has_more=false
    // instead of parking at true forever (the old `|| batch.has_more` form did).
    windowRows = descCapPlusOne(NOTIFICATION_WINDOW_FETCH_CAP + 1);
    const res = await poll(999, 10);
    expect(res.status).toBe(200);
    expect(res.body.data.events.map((e: { block_num: number }) => e.block_num)).toEqual([1000, 1001]);
    expect(res.body.data.latest_block).toBe(1001);
    // filtered (2) === delivered (2): nothing undelivered ABOVE the cursor.
    expect(res.body.data.has_more).toBe(false);
  });

  it('delivers a single oversized block atomically and advances past it (no stall)', async () => {
    // 60 events in block 100 (more than the response limit of 50), then later
    // single-event blocks. Whole-block delivery must hand back the entire block
    // 100 in one response (length > limit) rather than splitting it, and a
    // follow-up poll at the advanced cursor must return the later blocks.
    windowRows = [
      ...Array.from({ length: 60 }, (_, i) => reviewRowAt(100, i)),
      reviewRow(200),
      reviewRow(300),
    ];
    const res = await poll(50, 50);
    expect(res.status).toBe(200);
    const blocks = res.body.data.events.map((e: { block_num: number }) => e.block_num);
    expect(blocks).toHaveLength(60);                  // whole block, exceeds limit (50)
    expect(new Set(blocks)).toEqual(new Set([100]));  // all of block 100, nothing else
    expect(res.body.data.latest_block).toBe(100);     // a complete block
    expect(res.body.data.has_more).toBe(true);        // blocks 200/300 still undelivered

    // Follow-up poll at the advanced cursor drains the next blocks — no stall.
    const res2 = await poll(100, 50);
    expect(res2.body.data.events.map((e: { block_num: number }) => e.block_num)).toEqual([200, 300]);
    expect(res2.body.data.has_more).toBe(false);
  });

  it('surfaces the newest events to a caught-up cursor even when the cap was hit (no starvation)', async () => {
    // A genuine >cap window (cap+1 rows, newest-first): the shared fetch keeps the
    // NEWEST cap and drops the truncated boundary. A cursor caught up near the top
    // still receives the newest events — the old oldest-first fetch starved them.
    windowRows = descCapPlusOne(NOTIFICATION_WINDOW_FETCH_CAP + 1);
    const res = await poll(990, 50);
    expect(res.status).toBe(200);
    const blocks = res.body.data.events.map((e: { block_num: number }) => e.block_num);
    expect(blocks.length).toBeGreaterThan(0);  // NOT an empty batch
    expect(blocks).toEqual([991, 992, 993, 994, 995, 996, 997, 998, 999, 1000, 1001]);
    expect(res.body.data.latest_block).toBe(1001);  // newest delivered; cursor advances
  });

  it('drops the whole cap-truncation boundary block (never ends mid-block)', async () => {
    // Genuine >cap window (cap+1 rows, newest-first, distinct blocks 1..(cap+1)).
    // Block 1 is the probe (sliced at the truncated/oldest end); block 2 is the
    // boundary block the cap cut through, dropped WHOLE so the batch never ends
    // mid-block. No event of block 1 or 2 reaches the response; the lowest
    // delivered block is a complete one.
    windowRows = descCapPlusOne(NOTIFICATION_WINDOW_FETCH_CAP + 1);
    const res = await poll(0, 50);
    expect(res.status).toBe(200);
    const blocks = res.body.data.events.map((e: { block_num: number }) => e.block_num);
    expect(blocks).not.toContain(1);        // probe, sliced before the boundary-drop
    expect(blocks).not.toContain(2);        // truncation boundary, dropped whole
    expect(Math.min(...blocks)).toBe(3);    // lowest delivered block is complete
  });

  it('single block exceeding the cap empties the batch (documented residual deferral)', async () => {
    // The pathological case: more than `cap` events all share ONE Hive block. The
    // +1 probe fires capHit; truncate-to-cap then boundary-drop removes the whole
    // (only) block, emptying the shared batch. The route surfaces empty events,
    // latest_block echoing the cursor (no regression), has_more=false — the block
    // is deferred until the window floor slides to contain it (or the digest).
    windowRows = Array.from({ length: NOTIFICATION_WINDOW_FETCH_CAP + 1 }, (_, i) => reviewRowAt(500, i));
    const res = await poll(100, 50);
    expect(res.status).toBe(200);
    expect(res.body.data.events).toEqual([]);
    expect(res.body.data.latest_block).toBe(100);  // echoes since_block, cursor holds
    expect(res.body.data.has_more).toBe(false);
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

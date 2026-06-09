/**
 * fetchNotificationsFromHaf — direction='asc' capHit whole-block-drop canary.
 *
 * The digest consumes fetchNotificationsFromHaf with direction='asc' and advances
 * its cursor to the highest delivered block on EVERY non-empty run, with no
 * has_more gate. That correctness rests entirely on the contract that the asc/capHit
 * path drops the cap-truncation boundary block — the NEWEST block on the asc path —
 * WHOLE, so every delivered block is complete and advancing past it never skips an
 * undelivered overflow event. That asc-direction contract is exercised NOWHERE else:
 * the digest test (digest-window-cursor.test.ts) MOCKS fetchNotificationsFromHaf and
 * assumes the contract, and every real-path notification test drives the 'desc'
 * route path (routes/notifications-window-cursor.test.ts pins desc; routes/
 * notifications.test.ts hits real HAF via the desc route). This file pins the asc
 * branch directly so an asc/desc-asymmetry regression in the boundary-drop logic
 * (e.g. dropping events[0] for asc instead of the newest block) fails red.
 *
 * Per CLAUDE.md "Running Tests" carve-out clauses (a)/(b)/(c):
 *   (a) Real-corpus seeding is impractical: this canary needs a DETERMINISTIC
 *       >cap window (cap+1 rows spanning known blocks, with the boundary block
 *       sharing its block number across multiple events) so the cap cut falls
 *       inside one Hive block and the whole-block drop is observable. The public
 *       HAF corpus cannot be seeded with an exact >cap single-recipient event set
 *       at controlled block numbers at test time. The mocked surfaces are inside
 *       the carve-out's mock-target scope:
 *         - `getPool` (db.js) returns the controlled cap+1 row set so the asc cap
 *           cut + boundary drop are deterministic; the global tests/setup.ts genesis
 *           warm-up also routes through this stub (it returns no genesis rows).
 *         - `getRedis` → null forces the in-memory cache path so setup.ts does not
 *           open a real Redis connection (no cross-test key bleed); the function
 *           under test does not use Redis itself.
 *         - `getGenesisBlock` (hafsql.js) → 0 neutralizes the setup.ts genesis
 *           cache warm-up; genesis clamping is the caller's (runDigest's) concern,
 *           not this function's, so it is irrelevant to the boundary-drop contract.
 *   (b) fetchNotificationsFromHaf is not an HTTP surface and runs no auth
 *       middleware, so the clause-(b) cryptographic-verification refinement does
 *       not apply.
 *   (c) Real-path companion: routes/notifications.test.ts and routes/
 *       notifications-window-cursor.test.ts exercise the same fetchNotificationsFromHaf
 *       on the 'desc' path (the latter with the mocked pool, the former against real
 *       HAF), covering the SQL-shape + envelope risk class on the integrated route.
 *       This file adds the asc-direction whole-block-drop assertion they cannot,
 *       because the route never fetches asc.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Force the in-memory cache path so the global setup.ts Redis warm-up does not
// open a real connection. fetchNotificationsFromHaf does not use Redis itself.
vi.mock('../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => { /* no-op */ },
  redisRetryStrategy: () => null,
}));

// Neutralize the setup.ts genesis warm-up. The CTE builders fetchNotificationsFromHaf
// composes its SQL from stay real; only the genesis cache is stubbed.
vi.mock('../src/hafsql.js', async () => {
  const actual = await vi.importActual<typeof import('../src/hafsql.js')>('../src/hafsql.js');
  return { ...actual, getGenesisBlock: async () => 0 };
});

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async (..._args: any[]) => ({ rows: [] as any[] })),
  getPoolMock: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getPool: getPoolMock,
  isHafConfigured: () => getPoolMock() !== null,
  closeHafPool: async () => { /* no-op */ },
}));

const { fetchNotificationsFromHaf } = await import('../src/notification-queries.js');

// Rows the mocked notification query returns, in the same (block_num, op_id) order
// the SQL would produce for the requested direction.
let queryRows: Array<Record<string, unknown>> = [];

function reviewRow(block: number, opId: number): Record<string, unknown> {
  return {
    event_type: 'new_review',
    block_num: block,
    op_id: opId,
    event_timestamp: new Date(block * 1000).toISOString(),
    actor: 'reviewer.acct',
    paper_author: 'pevo.admin',
    paper_permlink: `paper-${block}-${opId}`,
    paper_title: `Paper ${block}-${opId}`,
    event_permlink: `review-${block}-${opId}`,
    target_type: null,
    vote_weight: null,
    accredit_action: null,
    accredit_method: null,
    vouch_relationship: null,
    parent_author: null,
    parent_permlink_ref: null,
  };
}

beforeEach(() => {
  queryRows = [];
  hafQueryMock.mockReset().mockImplementation(async (sql: string) => {
    // The notification CTE-chain, distinguishable by the new_review arm tag.
    if (sql.includes("'new_review'::text")) return { rows: queryRows };
    return { rows: [] };
  });
  getPoolMock.mockReset().mockReturnValue({ query: hafQueryMock });
});

describe("fetchNotificationsFromHaf — direction='asc' whole-block drop", () => {
  it('drops the NEWEST block whole on a genuine >cap (capHit) asc batch', async () => {
    const cap = 3;
    // ASC fetch order: oldest-first, op_id ascending within a block. The query
    // returns cap+1 rows (the +1 truncation probe materializes → genuine >cap
    // window). Blocks: 100 (one event), 200 (one event), then the NEWEST block 300
    // shares TWO events — the cap cut (after 3 rows) falls INSIDE block 300, so 300
    // is the partial boundary block and must be dropped WHOLE.
    queryRows = [
      reviewRow(100, 1),
      reviewRow(200, 2),
      reviewRow(300, 3),
      reviewRow(300, 4), // the cap+1 probe row, same block as the boundary
    ];

    const batch = await fetchNotificationsFromHaf('pevo.admin', 0, cap, 'asc');
    expect(batch).not.toBeNull();
    const blocks = batch!.events.map((e) => e.block_num);
    // Block 300 (the newest, partial boundary) is dropped whole: NO event of it
    // survives. The delivered blocks are the complete older ones.
    expect(blocks).not.toContain(300);
    expect(blocks).toEqual([100, 200]);
    // latest_block is the highest WHOLE delivered block, so the digest advances to a
    // complete block and never past an undelivered overflow event.
    expect(batch!.latest_block).toBe(200);
    expect(batch!.has_more).toBe(true);
  });

  it('a lone over-cap single block empties the asc batch (permanent-drop residual)', async () => {
    const cap = 3;
    // All cap+1 events share ONE block (500). capHit fires; dropping the whole
    // boundary block removes the only block, emptying the batch. This is the
    // permanent-drop residual the digest documents — never delivered, because the
    // event count is fixed above the cap. latest_block echoes the floor (cursor
    // holds), has_more stays true (the truncation probe fired).
    queryRows = [
      reviewRow(500, 1),
      reviewRow(500, 2),
      reviewRow(500, 3),
      reviewRow(500, 4),
    ];

    const batch = await fetchNotificationsFromHaf('pevo.admin', 400, cap, 'asc');
    expect(batch).not.toBeNull();
    expect(batch!.events).toEqual([]);
    expect(batch!.latest_block).toBe(400); // echoes the floor; the cursor holds
    expect(batch!.has_more).toBe(true);
  });

  it('an exactly-cap asc window drops nothing (probe absent → no false boundary drop)', async () => {
    const cap = 3;
    // Exactly cap rows, all distinct complete blocks: the +1 probe does NOT
    // materialize, so capHit is false and the newest block is NOT dropped. A
    // regression that drops the boundary on a `>= cap` test (instead of the `> cap`
    // probe) would lose block 300 here.
    queryRows = [reviewRow(100, 1), reviewRow(200, 2), reviewRow(300, 3)];

    const batch = await fetchNotificationsFromHaf('pevo.admin', 0, cap, 'asc');
    expect(batch).not.toBeNull();
    expect(batch!.events.map((e) => e.block_num)).toEqual([100, 200, 300]);
    expect(batch!.latest_block).toBe(300);
    expect(batch!.has_more).toBe(false);
  });
});

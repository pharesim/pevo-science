/**
 * Mocked-pool route tests for the `consented` author badge on
 * `GET /api/papers/:author/:permlink` (incl. `?version=N`).
 *
 * Carve-out justification (root CLAUDE.md "Running Tests"):
 *
 *   (a) Real-HAF seeding of the per-test consent states (consented vs
 *       claimed-only co-authors, a consent op flipping a badge between two
 *       requests, HAF dropping out between a warmed detail cache and the
 *       consent fetch) is impractical: each case needs precise multi-account
 *       chain ops plus deterministic timing against the cache tiers. A
 *       SQL-dispatching pool mock shapes the ROWS; the consented-set SQL
 *       semantics themselves are pinned against a real planner by
 *       `tests/consented-authors-cte-real-postgres.test.ts`.
 *   (b) `verifyHiveSignature` is NOT mocked — the detail endpoint is a
 *       public GET with no authentication; no cryptographic verification is
 *       in play.
 *   (c) Real-path companions: `papers.test.ts` exercises the detail route
 *       against live HAF (integration shape), and the consent CTE stack runs
 *       verbatim on a real planner in
 *       `consented-authors-cte-real-postgres.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async (..._args: any[]) => ({ rows: [] as unknown[] })),
  getPoolMock: vi.fn(),
}));

// Keep HafQueryError / isRetriableHafError real (the fail-closed 503
// translation under test depends on them); only the pool accessor is mocked.
vi.mock('../../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/db.js')>('../../src/db.js');
  return {
    ...actual,
    getPool: getPoolMock,
    isHafConfigured: () => getPoolMock() !== null,
    closeHafPool: async () => { /* no-op */ },
  };
});

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');
const { config } = await import('../../src/config.js');

const app = createApp();

interface StageOptions {
  author: string;
  permlink: string;
  authorsProjection: Array<Record<string, unknown>>;
  consentedAccounts: string[];
  pevoType?: string;
  metaAuthors?: Array<Record<string, unknown>>;
}

/** Stage the SQL dispatcher for one single-post paper: the detail row (the
 *  `authors_with_supersession` projection is what the route surfaces as
 *  `detail.authors` on the single-post path) plus the consented-set rows.
 *  Everything else resolves empty (no continuation chain, no claims). */
function stageDetail(opts: StageOptions) {
  hafQueryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM consented_authors')) {
      return { rows: opts.consentedAccounts.map((account) => ({ account })) };
    }
    if (sql.includes('authors_with_supersession')) {
      return {
        rows: [{
          author: opts.author,
          permlink: opts.permlink,
          title: 'Badge Test',
          body: 'Abstract\n\n---\n\nBody',
          json_metadata: {
            app: `${config.appTag}/test`,
            [config.appTag]: {
              type: opts.pevoType ?? 'paper',
              authors: opts.metaAuthors ?? opts.authorsProjection,
            },
          },
          created: '2026-06-01T00:00:00Z',
          last_edited: '2026-06-01T00:00:00Z',
          authors_with_supersession: opts.authorsProjection,
        }],
      };
    }
    return { rows: [] };
  });
}

function consentSqlCalls(): number {
  return hafQueryMock.mock.calls.filter((c) => String(c[0]).includes('FROM consented_authors')).length;
}

const MULTI_AUTHORS = [
  { name: 'Alice', hive: 'alice', orcid_verified: null, orcid_discrepancy: false },
  { name: 'Bob', hive: 'bob', orcid_verified: null, orcid_discrepancy: false },
  { name: 'Display Only', orcid_verified: null, orcid_discrepancy: false },
];

describe('GET /api/papers/:author/:permlink — consented author badge', () => {
  beforeEach(async () => {
    hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
    getPoolMock.mockReset().mockReturnValue({
      query: hafQueryMock,
      connect: async () => ({ query: hafQueryMock, release: () => { /* no-op */ } }),
    });
    await hafCache.clear();
  });

  it('flags consented co-authors true, claimed-only false, hive-less false', async () => {
    stageDetail({ author: 'alice', permlink: 'multi-1', authorsProjection: MULTI_AUTHORS, consentedAccounts: ['alice'] });
    const res = await request(app).get('/api/papers/alice/multi-1');
    expect(res.status).toBe(200);
    expect(res.body.data.authors.map((a: Record<string, unknown>) => [a.hive ?? null, a.consented])).toEqual([
      ['alice', true],
      ['bob', false],
      [null, false],
    ]);
  });

  it('single-author root paper short-circuits: consented true, no consent query fired', async () => {
    stageDetail({
      author: 'alice',
      permlink: 'solo-1',
      authorsProjection: [{ name: 'Alice', hive: 'alice', orcid_verified: null, orcid_discrepancy: false }],
      consentedAccounts: [],
    });
    const res = await request(app).get('/api/papers/alice/solo-1');
    expect(res.status).toBe(200);
    expect(res.body.data.authors).toEqual([
      expect.objectContaining({ hive: 'alice', consented: true }),
    ]);
    expect(consentSqlCalls()).toBe(0);
  });

  it('bridge paper short-circuits: hive-less imported credits false, no consent query fired', async () => {
    const bridge = config.hiveBridgeAccount;
    stageDetail({
      author: bridge,
      permlink: 'bridge-1',
      pevoType: 'bridge_paper',
      authorsProjection: [
        { name: 'Orig Author', orcid_verified: null, orcid_discrepancy: false },
        { name: 'Bridge Self', hive: bridge, orcid_verified: null, orcid_discrepancy: false },
      ],
      consentedAccounts: [],
    });
    const res = await request(app).get(`/api/papers/${bridge}/bridge-1`);
    expect(res.status).toBe(200);
    expect(res.body.data.authors.map((a: Record<string, unknown>) => [a.name, a.consented])).toEqual([
      ['Orig Author', false],
      ['Bridge Self', true],
    ]);
    expect(consentSqlCalls()).toBe(0);
  });

  it('HAF down on a multi-author paper fails closed 503 even when the detail cache is warm', async () => {
    stageDetail({ author: 'alice', permlink: 'multi-2', authorsProjection: MULTI_AUTHORS, consentedAccounts: ['alice'] });
    expect((await request(app).get('/api/papers/alice/multi-2')).status).toBe(200);

    // New block drops the volatile consented set; HAF goes away. The stable
    // detail entry is still warm, but the badge must not degrade to a
    // root-only (or stale) annotation.
    await hafCache.clearVolatile();
    getPoolMock.mockReturnValue(null);
    const res = await request(app).get('/api/papers/alice/multi-2');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.details).toEqual({ retriable: true });
  });

  it('a consent op is reflected on the next block tick (volatile drop), not after the stable detail TTL', async () => {
    stageDetail({ author: 'alice', permlink: 'multi-3', authorsProjection: MULTI_AUTHORS, consentedAccounts: ['alice'] });
    let res = await request(app).get('/api/papers/alice/multi-3');
    expect(res.body.data.authors[1]).toMatchObject({ hive: 'bob', consented: false });

    // bob's accept lands on-chain: the underlying set changes, but within
    // the same block the volatile cache still serves the old set.
    stageDetail({ author: 'alice', permlink: 'multi-3', authorsProjection: MULTI_AUTHORS, consentedAccounts: ['alice', 'bob'] });
    res = await request(app).get('/api/papers/alice/multi-3');
    expect(res.body.data.authors[1]).toMatchObject({ hive: 'bob', consented: false });

    // Block N+1: the watcher's clearVolatile drops the consented set while
    // the stable detail entry survives; the badge updates immediately.
    await hafCache.clearVolatile();
    res = await request(app).get('/api/papers/alice/multi-3');
    expect(res.body.data.authors[1]).toMatchObject({ hive: 'bob', consented: true });
  });

  it('?version=N branch carries the same annotation', async () => {
    const meta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [
          { name: 'Alice', hive: 'alice' },
          { name: 'Bob', hive: 'bob' },
        ],
      },
    };
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM consented_authors')) {
        return { rows: [{ account: 'alice' }] };
      }
      if (sql.includes('ROW_NUMBER() OVER (ORDER BY co.block_num)')) {
        return {
          rows: [{
            version_number: 1,
            block_num: 100,
            author: 'alice',
            permlink: 'versioned-1',
            title: 'V1',
            body: 'Abstract\n\n---\n\nBody',
            created: '2026-06-01T00:00:00Z',
            json_metadata: meta,
          }],
        };
      }
      return { rows: [] };
    });
    const res = await request(app).get('/api/papers/alice/versioned-1?version=1');
    expect(res.status).toBe(200);
    expect(res.body.data.authors.map((a: Record<string, unknown>) => [a.hive, a.consented])).toEqual([
      ['alice', true],
      ['bob', false],
    ]);
  });

  it('?version=N branch fails closed 503 on HAF down even when the version cache is warm', async () => {
    // The version branch has its own annotated-null guard, separate from the
    // base branch's (tested above). Without this pin, deleting that guard
    // serves 200 with a null payload on a warm version entry (sendOk
    // serializes null without complaint) instead of the retriable 503.
    const meta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [
          { name: 'Alice', hive: 'alice' },
          { name: 'Bob', hive: 'bob' },
        ],
      },
    };
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM consented_authors')) {
        return { rows: [{ account: 'alice' }] };
      }
      if (sql.includes('ROW_NUMBER() OVER (ORDER BY co.block_num)')) {
        return {
          rows: [{
            version_number: 1,
            block_num: 100,
            author: 'alice',
            permlink: 'versioned-2',
            title: 'V1',
            body: 'Abstract\n\n---\n\nBody',
            created: '2026-06-01T00:00:00Z',
            json_metadata: meta,
          }],
        };
      }
      return { rows: [] };
    });
    expect((await request(app).get('/api/papers/alice/versioned-2?version=1')).status).toBe(200);

    // New block drops the volatile consented set; HAF goes away. The stable
    // version entry is still warm, but the badge must not degrade.
    await hafCache.clearVolatile();
    getPoolMock.mockReturnValue(null);
    const res = await request(app).get('/api/papers/alice/versioned-2?version=1');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.details).toEqual({ retriable: true });
  });
});

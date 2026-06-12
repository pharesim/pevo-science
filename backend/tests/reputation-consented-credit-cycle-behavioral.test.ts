/**
 * Behavioral cycle-credit canary for the two ratified consent invariants,
 * driven through the REAL composed cycle SQL (not a reconstruction):
 *
 *   1. RETROACTIVITY — consent gates set-MEMBERSHIP, never the vote window.
 *      The corpus's only vote lands at block 100; eve's `author_accept` lands
 *      at block 200. Once consented, eve earns the paper's FULL vote history:
 *      her `papers` component equals the root broadcaster's. A reintroduced
 *      `vote.block_num > accept.block_num` window (under ANY alias — this is
 *      the behavioral complement of the name-denylist structural pin in
 *      `reputation-consented-credit-cycle-sql-shape.test.ts`) zeroes eve's
 *      score here and fails red.
 *
 *   2. DEMOTION / RE-CREDIT through the scoring output — a latest-op
 *      `author_resign` scores the demoted co-author 0 on the next run; a
 *      later re-accept restores the full paper score. Previously this was
 *      pinned only at `consented_authors` set membership, never through
 *      `computeReputationBatch`'s composed scoring SQL.
 *
 * Technique: a capturing pool (the cycle-sql-shape harness) records the SQL
 * and params `computeReputationBatch` actually emits; every `hafsql.*` view
 * literal is then FROM-redirected at synthetic temp tables (the
 * consented-authors real-postgres technique) and the statement runs verbatim
 * on a real planner. The accredited-set param is patched (the capturing pool
 * returns no accreditations); everything else runs as captured.
 *
 * **Carve-out (root CLAUDE.md "Running Tests"):**
 *   (a) Real-HAF seeding is impractical: the scenario needs a multi-author
 *       paper, a third-party vote BEFORE the co-author's accept, then a
 *       resign and a re-accept, all indexed with controlled block ordering —
 *       not reproducible on demand against the public corpus. `getPool` is
 *       mocked ONLY to capture the production SQL text; the scoring itself
 *       runs that SQL on real Postgres.
 *   (b) No auth/permission middleware in scope — this drives the batch
 *       helper's SQL directly; `verifyHiveSignature` does not run and is not
 *       the focus.
 *   (c) Real-path companions: the assembled cycle runs against real HAF in
 *       the reputation lifecycle/batch suites; the consent CTE semantics are
 *       pinned per-CTE by `consented-authors-cte-real-postgres.test.ts`.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { config } from '../src/config.js';
import { redirectHafViews } from './support/haf-query.js';

const { getPoolMock } = vi.hoisted(() => ({ getPoolMock: vi.fn() }));

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
  return { ...actual, getPool: getPoolMock, isHafConfigured: () => getPoolMock() !== null };
});

const { computeReputationBatch } = await import('../src/reputation.js');

const DB_URL = process.env.APP_DATABASE_URL;
const pool = DB_URL ? new pg.Pool({ connectionString: DB_URL, max: 1 }) : null;
let client: pg.PoolClient | null = null;

const TAG = config.appTag;
const END_BLOCK = 10_000;

// rootuser broadcasts the multi-author paper; eve holds a hive-anchored slot.
const PAPER_META = {
  app: `${TAG}/1`,
  [TAG]: {
    type: 'paper',
    authors: [{ hive: 'rootuser', name: 'Root' }, { hive: 'eve', name: 'Eve' }],
  },
};

function consentOp(action: string, signer: string, block: number, id: number) {
  return {
    required_posting_auths: JSON.stringify([signer]),
    json: JSON.stringify({ action, root_author: 'rootuser', root_permlink: 'paper-x' }),
    block_num: block,
    id,
  };
}

let cycleSql = '';
let cycleParams: unknown[] = [];

/** Capture the cycle statement computeReputationBatch emits, then redirect
 *  every HAF view literal at the temp tables. The drift guard (`hafsql.`
 *  must be fully consumed) keeps a renamed view from silently pointing the
 *  redirected statement at live HAF. */
async function captureCycleSql() {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const canned = { rows: [] as Array<Record<string, unknown>>, rowCount: 0 };
  const record = (sql: string, params?: unknown[]) => {
    captured.push({ sql, params: params ?? [] });
    return Promise.resolve(canned);
  };
  getPoolMock.mockReturnValue({
    query: record,
    connect: async () => ({ query: record, release: () => undefined }),
  });
  // prevScores {} → every voter resolves the rep-NULL weight arm (1.0);
  // cycleEndBlock provided → no head-block query.
  await computeReputationBatch(['eve', 'rootuser'], {}, END_BLOCK);
  getPoolMock.mockReset();

  const cycle = captured.find((c) => c.sql.includes('accepted_claims'));
  if (!cycle) throw new Error('cycle statement not captured');

  // Per-literal drift guard inside the helper (this file deliberately avoids
  // a bare `hafsql.` scan, which would trip on SQL comments that mention file
  // names). A view the mapping misses still fails loudly at execution: the
  // app database has no hafsql schema.
  const { sql } = redirectHafViews(cycle, {
    comments: 'syn_comments',
    commentOps: 'syn_comment_ops',
    voteOps: 'syn_vote_ops',
    customJson: 'syn_cj',
    blocks: 'syn_blocks',
  });

  cycleSql = sql;
  // $2 (accreditedArr) came from getAllAccreditedAccounts via the capturing
  // pool (empty). Patch in the corpus voter; every other captured param —
  // target users, appTag, weights, authority list, builder allocations —
  // runs exactly as production composed it.
  cycleParams = [...cycle.params];
  cycleParams[1] = ['honest'];
}

async function runCycle(): Promise<Map<string, number>> {
  const result = await client!.query(cycleSql, cycleParams);
  return new Map(
    (result.rows as Array<{ username: string; papers: string | number }>).map((r) => [r.username, Number(r.papers)]),
  );
}

beforeAll(async () => {
  if (!pool) return;
  client = await pool.connect();
  await client.query(`CREATE TEMP TABLE syn_comments (author text, permlink text, parent_author text DEFAULT '', parent_permlink text, json_metadata jsonb, created timestamptz)`);
  await client.query(`CREATE TEMP TABLE syn_comment_ops (author text, permlink text, block_num int, id bigint, json_metadata jsonb)`);
  await client.query(`CREATE TEMP TABLE syn_vote_ops (voter text, author text, permlink text, weight int, block_num int, id bigint)`);
  await client.query(`CREATE TEMP TABLE syn_cj (custom_id text, required_posting_auths jsonb, json text, block_num int, id bigint)`);
  await client.query(`CREATE TEMP TABLE syn_blocks (block_num int, timestamp timestamptz)`);

  // Paper created recently (decay grace window → multiplier 1.0); the cycle
  // reference block resolves to a now-ish timestamp.
  await client.query(
    `INSERT INTO syn_comments (author, permlink, parent_permlink, json_metadata, created)
     VALUES ('rootuser', 'paper-x', $1, $2, now() - interval '1 day')`,
    [TAG, PAPER_META],
  );
  // Creation op at block 50: eve's slot first appears here, so her accept at
  // block 200 satisfies the Rule-6 temporal lower bound.
  await client.query(`INSERT INTO syn_comment_ops VALUES ('rootuser', 'paper-x', 50, 1000, $1)`, [PAPER_META]);
  // The ONLY vote in the corpus — block 100, BEFORE eve's accept at 200.
  await client.query(`INSERT INTO syn_vote_ops VALUES ('honest', 'rootuser', 'paper-x', 10000, 100, 500)`);
  await client.query(`INSERT INTO syn_blocks VALUES ($1, now())`, [END_BLOCK - 1]);

  await captureCycleSql();
});

afterAll(async () => {
  client?.release();
  if (pool) await pool.end();
});

describe.skipIf(!pool)('reputation cycle — consented credit through the real composed SQL', () => {
  it('credits the pre-accept vote history on accept; resign zeroes; re-accept re-credits', { timeout: 60_000 }, async () => {
    // ── Accept (block 200, after the block-100 vote) ──
    const accept = consentOp('author_accept', 'eve', 200, 600);
    await client!.query(`INSERT INTO syn_cj VALUES ($1, $2, $3, $4, $5)`, [TAG, accept.required_posting_auths, accept.json, accept.block_num, accept.id]);
    const afterAccept = await runCycle();

    // Retroactivity: the vote predates the accept, yet eve's papers component
    // is nonzero AND equals the root broadcaster's full paper score — consent
    // changed membership, not the vote window.
    const rootScore = afterAccept.get('rootuser') ?? 0;
    expect(rootScore, 'root broadcaster must score from the honest vote').toBeGreaterThan(0);
    expect(afterAccept.get('eve'), 'consented co-author earns the FULL pre-accept vote history').toBeCloseTo(rootScore, 5);

    // ── Resign (block 300, latest op wins) ──
    const resign = consentOp('author_resign', 'eve', 300, 601);
    await client!.query(`INSERT INTO syn_cj VALUES ($1, $2, $3, $4, $5)`, [TAG, resign.required_posting_auths, resign.json, resign.block_num, resign.id]);
    const afterResign = await runCycle();

    expect(afterResign.get('eve'), 'a latest-op resign zeroes the co-author paper credit').toBeCloseTo(0, 5);
    expect(afterResign.get('rootuser'), 'the root broadcaster is unaffected by a co-author resign').toBeCloseTo(rootScore, 5);

    // ── Re-accept (block 400) ──
    const reaccept = consentOp('author_accept', 'eve', 400, 602);
    await client!.query(`INSERT INTO syn_cj VALUES ($1, $2, $3, $4, $5)`, [TAG, reaccept.required_posting_auths, reaccept.json, reaccept.block_num, reaccept.id]);
    const afterReaccept = await runCycle();

    expect(afterReaccept.get('eve'), 're-accept restores the full paper score').toBeCloseTo(rootScore, 5);
  });
});

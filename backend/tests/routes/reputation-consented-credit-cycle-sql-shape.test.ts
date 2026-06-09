/**
 * SQL-shape pins for the Route-2 consented-credit wiring in the reputation
 * cycle (`computeReputationBatch` in `reputation.ts`).
 *
 * The cycle credits the union Route 1 ∪ 2 ∪ 3 minus demotions:
 *   - native arm (Route 1) with a route2_latest demotion guard (the root
 *     broadcaster's own resign / a revoke naming them demotes their credit),
 *   - accepted_claims arm (Route 3, the shared claims builder),
 *   - consented_authors arm (Route 2, the shared chain + consent stack),
 *     deduped against both the native arm and the claims arm.
 * Both self-dealing exclusion gates (votes + reviews) check the consented
 * set in addition to accepted_claims.
 *
 * Retroactivity invariant (structural pin): consent gates MEMBERSHIP, never
 * the vote window. Once consented, the next full-recompute cycle credits the
 * paper's FULL vote/review history, including votes cast before the accept —
 * scores are recomputed from scratch each cycle and `prevScores` only
 * weights voters. The pin asserts the vote/review aggregation CTEs reference
 * NO consent-resolution block columns: reintroducing a
 * `vote.block_num > accept.block_num` window would have to thread
 * route2/consent state into those CTEs and turns the absence assertions red.
 *
 * **Carve-out (per root CLAUDE.md "Running Tests"):** mocks `getPool()` with a
 * capturing pool that records the SQL `computeReputationBatch` emits and returns
 * empty rowsets, so the cycle's query string is asserted without HAF.
 *   (a) Real path impractical: running the full daily reputation cycle against
 *       real HAF to assert a SQL-shape invariant is heavy and HAF-config-
 *       dependent.
 *   (b) No auth/permission middleware in scope — this drives the batch helper
 *       directly; `verifyHiveSignature` does not run and is not the focus.
 *   (c) Real-path companion: the consented resolution runs against real
 *       Postgres in `consented-authors-cte-real-postgres.test.ts` (the full
 *       production chain + consent stack over a synthetic corpus), and the
 *       assembled cycle runs against real HAF in the reputation
 *       lifecycle/batch suites.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const { getPoolMock } = vi.hoisted(() => ({ getPoolMock: vi.fn() }));

vi.mock('../../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/db.js')>('../../src/db.js');
  return { ...actual, getPool: getPoolMock, isHafConfigured: () => getPoolMock() !== null };
});

const { computeReputationBatch } = await import('../../src/reputation.js');

const capturedSqls: string[] = [];

const cannedResult = { rows: [] as Array<Record<string, unknown>>, rowCount: 0 };
function capture(sql: string): Promise<typeof cannedResult> {
  capturedSqls.push(sql);
  return Promise.resolve(cannedResult);
}
const capturingPool = {
  query: (sql: string) => capture(sql),
  connect: () =>
    Promise.resolve({
      query: (sql: string) => capture(sql),
      release: () => undefined,
    }),
};

afterEach(() => {
  getPoolMock.mockReset();
  capturedSqls.length = 0;
});

async function emitCycleSql(): Promise<string> {
  getPoolMock.mockReturnValue(capturingPool as unknown as ReturnType<typeof getPoolMock>);
  await computeReputationBatch(['some-target-user'], {}, 12_345);
  const cycleSql = capturedSqls.find((s) => s.includes('accepted_claims'));
  expect(cycleSql, 'computeReputationBatch must emit the cycle query').toBeDefined();
  return cycleSql!;
}

describe('reputation cycle — Route-2 consented credit wiring (SQL shape)', () => {
  it('composes the consent stack: seed, unprefixed chain backbone, consented_authors, recursive WITH', async () => {
    const sql = await emitCycleSql();
    // The whole query must be recursive (the chain backbones embed
    // self-referential CTEs).
    expect(sql).toMatch(/^WITH RECURSIVE/);
    // Op-derived walk seed (accept/resign signed by targets, revokes naming
    // them) — bounds the recursive walk by batch consent activity.
    expect(sql).toContain('consent_seed AS (');
    // The unprefixed Route-2 backbone AND the claims builder's internal
    // claims_-prefixed copy coexist without name collision.
    expect(sql).toContain('chain_tree AS (');
    expect(sql).toContain('claims_chain_tree AS (');
    expect(sql).toContain('consented_authors AS (');
  });

  it('user_papers carries all three credit arms with double-count guards', async () => {
    const sql = await emitCycleSql();
    // Route 3 (claims) arm.
    expect(sql).toContain('FROM accepted_claims ac');
    // Route 2 (consented) arm…
    expect(sql).toContain('FROM consented_authors ca');
    // …guarded against the native arm (root broadcaster credit flows there)…
    expect(sql).toContain('AND ca.account != c.author');
    // …and against the claims arm (one user_papers row per recipient per
    // paper; totals SUM per row, so a dual-route account must not double).
    expect(sql).toMatch(/SELECT 1 FROM accepted_claims ac2\s+WHERE ac2\.paper_author = ca\.root_author/);
  });

  it('the native arm carries the Route-1 demotion guard (own resign / revoke demotes)', async () => {
    const sql = await emitCycleSql();
    expect(sql).toMatch(
      /SELECT 1 FROM route2_latest rl\s+WHERE rl\.root_author = c\.author AND rl\.root_permlink = c\.permlink\s+AND rl\.account = c\.author AND rl\.rn = 1 AND rl\.action != 'author_accept'/,
    );
  });

  it('both self-dealing gates check the consented set alongside accepted_claims', async () => {
    const sql = await emitCycleSql();
    // Vote gate (paper_resolved_votes keys on plv.*).
    expect(sql).toMatch(
      /SELECT 1 FROM consented_authors ca\s+WHERE ca\.root_author = plv\.author\s+AND ca\.root_permlink = plv\.permlink\s+AND ca\.account = plv\.voter/,
    );
    // Review gate (paper_reviews keys on cp.* / c.author).
    expect(sql).toMatch(
      /SELECT 1 FROM consented_authors ca\s+WHERE ca\.root_author = cp\.author\s+AND ca\.root_permlink = cp\.permlink\s+AND ca\.account = c\.author/,
    );
  });

  it('retroactivity: the vote/review aggregation references no consent block columns (no accept-block window)', async () => {
    const sql = await emitCycleSql();
    // Slice out the vote + review aggregation region: from the votes CTE to
    // paper_scores. Consent state may appear ONLY as membership NOT EXISTS
    // (consented_authors / accepted_claims), never as a block comparison.
    const start = sql.indexOf('paper_vote_signals AS (');
    const end = sql.indexOf('paper_scores AS (');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const aggregation = sql.slice(start, end);
    // No route-2 resolution columns inside the aggregation region.
    expect(aggregation).not.toContain('route2_latest');
    expect(aggregation).not.toContain('first_block');
    expect(aggregation).not.toContain('consent_seed');
    // The membership gates are the ONLY consented reads there (comments may
    // mention the set; only FROM references read it).
    const consentedReads = aggregation.match(/FROM consented_authors/g) ?? [];
    expect(consentedReads).toHaveLength(2); // one per self-dealing gate
  });
});

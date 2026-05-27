/**
 * Real-Postgres behavioral pin for `getAccreditedNamesByAccount`'s loader
 * query (`accreditation.ts`). The loader filters attested names with
 * `WHERE NULLIF(researcher_name, '') IS NOT NULL` — a CHARSET-FREE exact-empty
 * test, no BTRIM. This is the active-only source of name-supersession, and it
 * MUST stay in lockstep with the SQL-side `authorsWithSupersessionSelect` name
 * arm (also `NULLIF(aa.researcher_name, '')`, no BTRIM): a whitespace-only
 * attested name has to be carried — and supersede — identically on both
 * surfaces. If a BTRIM wrapper were (re)introduced on the loader WHERE, a
 * whitespace-only attested name would be dropped on the JS surface while the
 * SQL surface still carries it, reopening cross-surface drift.
 *
 * **Why this test exists.** The JS whitespace-only canary in
 * `papers-cumulative-cross-surface-parity-mocked.test.ts` injects the
 * `accreditedNames` map directly, bypassing this loader; the SQL-side
 * `NULLIF(... , '')` string-shape pin lives on a different function
 * (`authorsWithSupersessionSelect`). So a BTRIM reintroduction in THIS loader
 * was previously invisible to the suite. This test closes that gap by running
 * the loader's real WHERE over a whitespace-only row.
 *
 * **Carve-out (per root CLAUDE.md "Running Tests"):** mocks `getPool()` to
 * return a thin wrapper that redirects the production `activeAccreditationsCteBody`
 * fragment's HAF custom_json view reference to a synthetic CTE seeded with
 * `accredit` ops, then forwards to the real test pool. The loader's own
 * inline WHERE is what executes — only the rowset is synthetic, evaluated by
 * real Postgres.
 *   (a) Real path impractical: seeding accreditation `custom_json` ops on Hive
 *       with controlled `name` payloads (whitespace-only, exactly-empty) and
 *       waiting for HAF indexing is not a tractable per-test shape, and the
 *       public corpus is unlikely to carry a whitespace-only attested name.
 *   (b) No auth/permission middleware in scope — this is a HAF-loader unit, not
 *       a route; `verifyHiveSignature` does not run here and is not the focus.
 *   (c) Real-path companion: the loader's happy path (normal attested names
 *       from real HAF) flows through `getAccreditedNamesByAccount` in the
 *       live-HAF paper-detail / profile supersession suites
 *       (`papers-canonical-orcid-resolution.test.ts`, `profile-papers-supersession.test.ts`).
 *       The risk class pinned HERE is the loader WHERE staying charset-free so a
 *       whitespace-only attested name is not surface-specifically dropped.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const { getPoolMock } = vi.hoisted(() => ({ getPoolMock: vi.fn() }));

vi.mock('../../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/db.js')>('../../src/db.js');
  return { ...actual, getPool: getPoolMock, isHafConfigured: () => getPoolMock() !== null };
});

const realDb = await vi.importActual<typeof import('../../src/db.js')>('../../src/db.js');
const { T } = await import('../../src/hafsql.js');
const { config } = await import('../../src/config.js');
const { hafCache } = await import('../../src/cache.js');
const { getAccreditedNamesByAccount } = await import('../../src/accreditation.js');

const NAMES_CACHE_KEY = 'accredited_account_names';

type RealPool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

/**
 * Wrap the real pool so the production loader query runs over synthetic
 * `accredit` ops. Redirects the HAF custom_json view to a `synthetic_cj` CTE
 * and forwards to real Postgres; the loader's own WHERE is preserved verbatim.
 */
function redirectingPool(realPool: RealPool): RealPool {
  // account → attested name. Each becomes an authority-signed `accredit` op.
  const seedRows: ReadonlyArray<readonly [string, string]> = [
    ['ws-name', '   '], //         whitespace-only → must be KEPT (charset-free NULLIF)
    ['empty-name', ''], //         exactly-empty   → must be DROPPED (proves WHERE is active)
    ['real-name', 'Rosalind Franklin'], // normal  → KEPT (control)
  ];
  const auth = JSON.stringify([config.accreditationAuthorities[0]]);
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const base = params.length; // production loader passes $1=appTag, $2=authorities
      const tuples: string[] = [];
      const extra: unknown[] = [];
      seedRows.forEach(([account, name], i) => {
        const op = JSON.stringify({ action: 'accredit', account, name });
        const idP = base + extra.length + 1;
        tuples.push(`($${idP}::bigint, $${idP + 1}::text, $${idP + 2}::jsonb, $${idP + 3}::jsonb, $${idP + 4}::bigint)`);
        extra.push(i + 1, config.appTag, op, auth, 100 + i);
      });
      const synthCte = `synthetic_cj(id, custom_id, json, required_posting_auths, block_num) AS (\n  VALUES ${tuples.join(',\n         ')}\n)`;
      const redirected = sql
        .replace('WITH ', `WITH ${synthCte},\n`)
        .split(T.customJson)
        .join('synthetic_cj');
      return realPool.query(redirected, [...params, ...extra]);
    },
  };
}

afterEach(async () => {
  getPoolMock.mockReset();
  // The real getOrSet caches the synthetic map under the shared key; clear it
  // so sibling suites re-query real HAF rather than reading our synthetic rows.
  await hafCache.invalidate(NAMES_CACHE_KEY);
});

describe('getAccreditedNamesByAccount — loader WHERE is charset-free (whitespace-only attested name survives)', () => {
  it('keeps a whitespace-only attested name and drops an exactly-empty one', { timeout: 30_000 }, async (ctx) => {
    const realPool = realDb.getPool() as RealPool | null;
    if (!realPool) return ctx.skip(true, 'no HAF pool available');
    if (config.accreditationAuthorities.length === 0) return ctx.skip(true, 'no accreditation authorities configured');

    // Fresh load: drop any cached map so the synthetic-pool loader runs.
    await hafCache.invalidate(NAMES_CACHE_KEY);
    getPoolMock.mockReturnValue(redirectingPool(realPool));

    const map = await getAccreditedNamesByAccount();

    // Whitespace-only attested name is carried (NULLIF, no BTRIM). A BTRIM
    // reintroduction in the loader WHERE would drop this and turn it red.
    expect(map.get('ws-name')).toBe('   ');
    // Exactly-empty attested name is dropped — proves the WHERE actually
    // filters (so the whitespace survivor above is not a vacuous pass).
    expect(map.has('empty-name')).toBe(false);
    // Normal attested name carried unchanged (control).
    expect(map.get('real-name')).toBe('Rosalind Franklin');
  });
});

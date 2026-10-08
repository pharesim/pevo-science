/**
 * Real-Postgres coverage for `readSanctionState` (`accreditation.ts`): its own
 * SQL decides `sanctioned` / `not_sanctioned` over a synthetic op set, and a
 * read it cannot make answers `haf_unavailable`, never a verdict.
 *
 * Carve-out (root CLAUDE.md "Running Tests"): `getPool()` is mocked.
 *   (a) The read-only public HAF carries no sanctioned `pevotest` account, and
 *       seeding one means broadcasting a sanction and waiting out HAF indexing.
 *       The mock returns a wrapper that redirects the function's HAF view
 *       reference to a synthetic VALUES CTE and forwards the query to a real
 *       Postgres on APP_DATABASE_URL, so the function's SQL runs verbatim and
 *       only the op rows are synthetic. The failure specs return no pool, or a
 *       pool whose query rejects.
 *   (b) No auth middleware is involved.
 *   (c) The `readSanctionState against live HAF` spec runs the same SQL on the
 *       real HAF pool, for an account with no ops.
 *
 * The synthetic specs skip when APP_DATABASE_URL is unset, the live one when
 * no HAF pool is configured.
 */
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

const { getPoolMock } = vi.hoisted(() => ({ getPoolMock: vi.fn() }));

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
  return { ...actual, getPool: getPoolMock };
});

const realDb = await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
const { readSanctionState } = await import('../src/accreditation.js');
const { T } = await import('../src/hafsql.js');
const { config } = await import('../src/config.js');

const DB_URL = process.env.APP_DATABASE_URL;
const realPool = DB_URL ? new pg.Pool({ connectionString: DB_URL, max: 1 }) : null;

afterAll(async () => {
  if (realPool) await realPool.end();
});

const ACCOUNT = 'sanction-read-subject';

interface Op {
  action: 'accredit' | 'revoke';
  method?: string;
  type?: 'sanction';
  block: number;
}

let redirectedSql: string | null = null;

/**
 * A pool whose `query` runs the caller's SQL on real Postgres with the HAF
 * custom_json view replaced by `ops` (each authority-signed, for ACCOUNT). An
 * accredit for another account rides along so the VALUES list is never empty.
 */
function syntheticPool(ops: Op[]) {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const rows: Array<[string, Record<string, unknown>, number]> = [
        ['someone-else', { action: 'accredit', account: 'someone-else', method: 'email' }, 1],
        ...ops.map((op): [string, Record<string, unknown>, number] => [
          ACCOUNT,
          {
            action: op.action,
            account: ACCOUNT,
            ...(op.method ? { method: op.method } : {}),
            ...(op.type ? { type: op.type } : {}),
          },
          op.block,
        ]),
      ];
      const tuples: string[] = [];
      const extra: unknown[] = [];
      for (const [, json, block] of rows) {
        const p = params.length + extra.length + 1;
        tuples.push(`($${p}::text, $${p + 1}::text, $${p + 2}::jsonb, $${p + 3}::integer)`);
        extra.push(config.appTag, JSON.stringify(json), JSON.stringify([config.hiveAdminAccount]), block);
      }
      const synthCte = `synthetic_cj(custom_id, json, required_posting_auths, block_num) AS (VALUES ${tuples.join(', ')})`;
      redirectedSql = sql
        .replace(/^\s*WITH /, `WITH ${synthCte},\n`)
        .split(T.customJson)
        .join('synthetic_cj');
      return realPool!.query(redirectedSql, [...params, ...extra]);
    },
  };
}

async function readOver(ops: Op[]) {
  getPoolMock.mockReturnValue(syntheticPool(ops));
  const outcome = await readSanctionState(ACCOUNT);
  // A redirect that missed would run the query against the live view name and
  // pass or fail for the wrong reason.
  expect(redirectedSql).not.toBeNull();
  expect(redirectedSql).toContain('synthetic_cj(');
  expect(redirectedSql).not.toContain(T.customJson);
  return outcome;
}

beforeEach(() => {
  getPoolMock.mockReset();
  redirectedSql = null;
});

describe.skipIf(!realPool)('readSanctionState over a synthetic op set (real Postgres)', () => {
  it('answers not_sanctioned for an account with no ops', async () => {
    expect(await readOver([])).toBe('not_sanctioned');
  });

  it('answers sanctioned for a sanction with no authority accredit', async () => {
    expect(await readOver([{ action: 'revoke', type: 'sanction', block: 100 }])).toBe('sanctioned');
  });

  it('answers sanctioned for an authority-accredited account sanctioned later', async () => {
    expect(await readOver([
      { action: 'accredit', method: 'email', block: 100 },
      { action: 'revoke', type: 'sanction', block: 200 },
    ])).toBe('sanctioned');
  });

  it('answers not_sanctioned once a later authority accredit lifts the sanction', async () => {
    expect(await readOver([
      { action: 'revoke', type: 'sanction', block: 100 },
      { action: 'accredit', method: 'email', block: 200 },
    ])).toBe('not_sanctioned');
  });

  it('answers sanctioned when only a later wot accredit follows the sanction', async () => {
    expect(await readOver([
      { action: 'revoke', type: 'sanction', block: 100 },
      { action: 'accredit', method: 'wot', block: 200 },
    ])).toBe('sanctioned');
  });
});

describe('readSanctionState against live HAF', () => {
  it('answers not_sanctioned for an account with no ops', async (ctx) => {
    const livePool = realDb.getPool();
    if (!livePool) return ctx.skip(true, 'no HAF pool configured');
    getPoolMock.mockReturnValue(livePool);
    expect(await readSanctionState('pevo-sanction-read-no-ops')).toBe('not_sanctioned');
  });
});

describe('readSanctionState when the read cannot be made', () => {
  it('answers haf_unavailable when there is no HAF pool', async () => {
    getPoolMock.mockReturnValue(null);
    expect(await readSanctionState(ACCOUNT)).toBe('haf_unavailable');
  });

  it('answers haf_unavailable when the query fails', async () => {
    getPoolMock.mockReturnValue({ query: async () => { throw new Error('connection terminated'); } });
    expect(await readSanctionState(ACCOUNT)).toBe('haf_unavailable');
  });
});

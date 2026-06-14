/**
 * Deterministic coverage for `loadWotThreshold`'s accreditation-authority
 * signer gate and positive-integer validation, exercised through the exported
 * `getWotThreshold()` wrapper.
 *
 * Per root CLAUDE.md "Carve-out for deterministic edge-case coverage":
 *   (a) Real path that's impractical: `loadWotThreshold` reads the latest
 *       on-chain `update_params` custom_json from HAF. The public HAF corpus
 *       cannot be deterministically seeded at test time with the matched pair
 *       of rows this file's risk classes require — a FORGED `update_params`
 *       broadcast by a stranger account (NOT in `accreditationAuthorities`)
 *       alongside a LEGITIMATE one signed by an authority, plus malformed
 *       `min_accreditations_for_wot` values (0, a non-integer string). The
 *       signer-gate part is therefore pinned as a SQL-shape canary (assert the
 *       captured SELECT carries `required_posting_auths ?|` bound to the
 *       `accreditationAuthorities` param, mirroring the authority-gate canary
 *       in `notifications-arm-sql-shape.test.ts`); the validation part is a
 *       pure-logic assertion on the number `getWotThreshold()` returns for a
 *       controlled row.
 *   (b) `loadWotThreshold` runs NO auth middleware — it is an internal HAF
 *       read invoked from the WoT-threshold cache, NOT an HTTP route. There is
 *       no `verifyHiveSignature` (or any other auth/permission middleware) in
 *       its call path, so the carve-out's clause-(b) requirement to run real
 *       cryptographic-verification middleware does not apply here. The signer
 *       gate under test is enforced in SQL against the on-chain
 *       `required_posting_auths` array, not by request-signature middleware.
 *   (c) Same risk class elsewhere: the `required_posting_auths ?|`
 *       authority-gate SQL discipline is exercised against real HAF by the
 *       accreditation read paths (`accreditation.ts`, `routes/accreditations.ts`)
 *       whose integration tests run against the live corpus; this file pins
 *       the WoT-threshold call site specifically, which the live corpus cannot
 *       seed with a forged-vs-legit pair.
 *
 * Mocked surface (carve-out scope): only `getPool()` from `db.js` (a shared
 * pool helper) and `redis.js` (so the cache stays in-process). No business
 * logic is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { connectMock, clientQueryMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  clientQueryMock: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getPool: () => ({ connect: connectMock, query: vi.fn() }),
  isHafConfigured: () => true,
  closeHafPool: async () => {},
}));

vi.mock('../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

const { getWotThreshold } = await import('../src/wot.js');
const { hafCache } = await import('../src/cache.js');
const { config } = await import('../src/config.js');

const DEFAULT_WOT_THRESHOLD = 3;

/**
 * Capture state for the single SELECT that `loadWotThreshold` issues against
 * the custom_json view. `BEGIN` / `SET LOCAL` / `COMMIT` are passed through;
 * the SELECT is identified by its distinctive `update_params` predicate.
 */
let capturedSql = '';
let capturedParams: unknown[] = [];

/**
 * Install a fake pooled client whose SELECT returns `rows`. The captured SQL
 * and params from the SELECT are exposed via the module-level capture vars.
 */
function stubSelect(rows: unknown[]): void {
  capturedSql = '';
  capturedParams = [];
  clientQueryMock.mockReset().mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("'update_params'")) {
      capturedSql = sql;
      capturedParams = params ?? [];
      return { rows };
    }
    // BEGIN / SET LOCAL statement_timeout / COMMIT / ROLLBACK.
    return { rows: [] };
  });
  connectMock.mockReset().mockResolvedValue({
    query: clientQueryMock,
    release: vi.fn(),
  });
}

beforeEach(async () => {
  await hafCache.clear();
  connectMock.mockReset();
  clientQueryMock.mockReset();
});

describe('loadWotThreshold — accreditation-authority signer gate (SQL-shape canary)', () => {
  it('binds a required_posting_auths gate to the accreditationAuthorities param', async () => {
    stubSelect([{ json: JSON.stringify({ action: 'update_params', params: { min_accreditations_for_wot: 5 } }) }]);
    await getWotThreshold();

    // The signer gate text must be present...
    expect(capturedSql).toMatch(/required_posting_auths \?\|/);
    // ...and the placeholder it binds to must carry accreditationAuthorities,
    // so a forged op signed by a non-authority is filtered out in SQL.
    const gate = capturedSql.match(/required_posting_auths \?\| \$(\d+)::text\[\]/);
    expect(gate, 'required_posting_auths gate not found in captured SQL').not.toBeNull();
    const placeholderIdx = Number(gate![1]);
    expect(capturedParams[placeholderIdx - 1]).toEqual(config.accreditationAuthorities);
  });
});

describe('loadWotThreshold — planner-fence canary (SQL-shape)', () => {
  it('wraps the row match in an AS MATERIALIZED CTE and orders by the (block_num, id) tiebreaker', async () => {
    // The candidate match must sit inside an `AS MATERIALIZED` CTE. Without that
    // optimization fence, `ORDER BY block_num DESC LIMIT 1` lets PostgreSQL walk
    // the 100M+-row blocks index backward in a nested loop (block_num is a
    // function over the operation id, not a stored column) probing the
    // near-empty update_params set — an ~18s scan that trips the 5s
    // statement_timeout and silently degrades the live WoT threshold to the
    // default. Real HAF cannot cheaply demonstrate that timing gap
    // deterministically, so this canary pins the fence so a future
    // "simplification" back to a bare `ORDER BY ... LIMIT 1` over the view
    // fails red here instead of regressing the live threshold in production.
    stubSelect([{ json: JSON.stringify({ action: 'update_params', params: { min_accreditations_for_wot: 5 } }) }]);
    await getWotThreshold();
    expect(capturedSql).toMatch(/\bAS\s+MATERIALIZED\b/i);
    // The outer sort must carry the `id` secondary key per Rule 2 (custom_json
    // latest-op-wins): operation_custom_json_view omits trx_in_block, so the
    // monotonic HAF op id breaks same-block ties. A future edit that drops the
    // tiebreaker back to bare `block_num DESC` fails red here.
    expect(capturedSql).toMatch(/ORDER\s+BY\s+block_num\s+DESC\s*,\s*id\s+DESC/i);
  });
});

describe('loadWotThreshold — threshold value derivation', () => {
  it('forged update_params (stranger signer) is filtered in SQL → falls back to default', async () => {
    // The signer gate lives in the WHERE clause, so a forged op signed by a
    // stranger never matches: the production query returns zero rows. Model
    // that by returning an empty result set; the threshold must fall back to
    // the default rather than honoring the forged value.
    stubSelect([]);
    expect(await getWotThreshold()).toBe(DEFAULT_WOT_THRESHOLD);
  });

  it('legitimate update_params (authority signer) updates the threshold', async () => {
    stubSelect([{ json: JSON.stringify({ action: 'update_params', params: { min_accreditations_for_wot: 7 } }) }]);
    expect(await getWotThreshold()).toBe(7);
  });

  it('legitimate broadcast with min_accreditations_for_wot: 0 falls back to default', async () => {
    stubSelect([{ json: JSON.stringify({ action: 'update_params', params: { min_accreditations_for_wot: 0 } }) }]);
    // A 0 threshold would auto-accredit every account on its first vouch; the
    // positive-integer guard must reject it.
    expect(await getWotThreshold()).toBe(DEFAULT_WOT_THRESHOLD);
  });

  it('non-integer threshold value falls back to default', async () => {
    stubSelect([{ json: JSON.stringify({ action: 'update_params', params: { min_accreditations_for_wot: 'abc' } }) }]);
    expect(await getWotThreshold()).toBe(DEFAULT_WOT_THRESHOLD);
  });

  it('non-integer numeric (fractional) threshold value falls back to default', async () => {
    stubSelect([{ json: JSON.stringify({ action: 'update_params', params: { min_accreditations_for_wot: 2.5 } }) }]);
    expect(await getWotThreshold()).toBe(DEFAULT_WOT_THRESHOLD);
  });
});

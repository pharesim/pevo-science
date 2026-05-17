/**
 * Mocked-pool SQL-contract coverage for the BE-ACCREDITATIONS-LIKEGUARD
 * defenses on GET /api/accreditations.
 *
 * Carve-out justification per root CLAUDE.md "Running Tests" → "Carve-out for
 * deterministic edge-case coverage":
 *
 *   (a) Real-path impracticality. The sibling real-HAF specs in
 *       `accreditations-likeguard.test.ts` exercise the route through real
 *       HAF and assert HTTP-level invariants (status 200 + array shape on the
 *       happy path, 400 + message on the length-cap violation). They CANNOT
 *       assert the SQL contract — specifically: that the bound parameter
 *       carries the LIKE-escaped form (`%` → `\%`, `_` → `\_`, `\` → `\\`)
 *       and that both ILIKE call sites in the single combined query carry an
 *       `ESCAPE '\\'` clause. The bound parameters and the emitted SQL string
 *       are internal to the `pool.query()` call; HAF returns rows without
 *       echoing them back, so a regression that drops `escapeLikePattern()`
 *       (search-filters.ts:53) or drops `ESCAPE '\\'` from accreditations.ts:41
 *       or :45 still produces HTTP 200 + array on real HAF and the real-path
 *       specs pass vacuously. This block pins the contract deterministically
 *       by mocking `getPool()` and capturing the SQL + params at the bind site.
 *
 *       Cryptographic verification is NOT bypassed here — the route is
 *       unauthenticated read, so there is no `verifyHiveSignature` middleware
 *       on the call path. The `MOCK_VERIFY_SIGNATURE` fixture is not used.
 *
 *   (b) Auth middleware. N/A — the route is unauthenticated.
 *
 *   (c) Real-path companion. The risk class here is "ILIKE bind drops
 *       escape contract" and "bound parameter is not LIKE-escaped". The
 *       real-path companions in `accreditations-likeguard.test.ts` cover the
 *       integrated-path risk class (route-handler validation runs, 400
 *       message wire format, 200 status on the happy path, repeated-param
 *       silent-unfilter via meta.total proxy). The mocked-pool block here
 *       covers only the SQL-string and params-array shape — a different
 *       mutation class. Both blocks together close the contract.
 *
 * Mirrors the shape of the BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP block at
 * `disciplines-canon-mocked.test.ts:817-903`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

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

beforeEach(async () => {
  hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
  getPoolMock.mockReset().mockReturnValue({ query: hafQueryMock });
  await hafCache.clear();
});

describe('GET /api/accreditations — ?field= / ?institution= LIKE-escape SQL contract (mocked pool)', () => {
  // The accreditations route uses a single combined query with a window-
  // function count (`count(*) OVER ()::int AS total`) — there is no separate
  // count branch. The two ILIKE call sites are the two conditions in the
  // conditions array (the `field` ILIKE at accreditations.ts:41 and the
  // `institution` ILIKE at accreditations.ts:45). Both fragments end up in
  // the same emitted SQL string. The architect's round-2 hold "count branch
  // + data branch" wording maps to these two ILIKE fragments.

  it('?field= bound parameter is LIKE-escaped (% → \\%, _ → \\_, \\ → \\\\) with `${escaped}%` prefix-match suffix', async () => {
    let capturedParams: unknown[] | undefined;
    let capturedSql: string | undefined;
    hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      // The accreditations data query is uniquely identified by the ranked
      // CTE's `ROW_NUMBER() OVER (PARTITION BY` clause.
      if (sql.includes('ROW_NUMBER() OVER (PARTITION BY') && capturedParams === undefined) {
        capturedSql = sql;
        capturedParams = params;
      }
      return { rows: [] };
    });

    // The crafted payload: `%`, `_`, `\` — all three LIKE metacharacters
    // plus the escape character itself. Post-fix bound parameter must
    // contain the escaped form (`\%`, `\_`, `\\`) with a trailing `%` as
    // the deliberate prefix-match wildcard appended by the route at
    // accreditations.ts:42.
    const res = await request(app).get('/api/accreditations?field=%25_%5C');
    expect(res.status).toBe(200);
    expect(capturedParams).toBeDefined();
    expect(capturedSql).toBeDefined();

    // The ILIKE-pattern bind is a string param ending in `%` (the prefix-
    // match suffix) whose body is the LIKE-escaped form of the input. Find
    // it by scanning the params array.
    const ilikePattern = capturedParams!.find(
      (p) => typeof p === 'string' && p.endsWith('%') && p.length > 1 && p !== '%',
    ) as string | undefined;
    expect(ilikePattern).toBeDefined();

    // Strip the trailing `%` suffix added by the route (NOT escaped).
    const escapedField = ilikePattern!.slice(0, -1);
    // The escaped form for input `%_\` is `\%\_\\`. A revert of
    // `escapeLikePattern()` would surface here as the raw `%_\`.
    expect(escapedField).toBe('\\%\\_\\\\');
  });

  it('?institution= bound parameter is LIKE-escaped (% → \\%, _ → \\_, \\ → \\\\) with `${escaped}%` prefix-match suffix', async () => {
    let capturedParams: unknown[] | undefined;
    hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('ROW_NUMBER() OVER (PARTITION BY') && capturedParams === undefined) {
        capturedParams = params;
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/accreditations?institution=%25_%5C');
    expect(res.status).toBe(200);
    expect(capturedParams).toBeDefined();

    const ilikePattern = capturedParams!.find(
      (p) => typeof p === 'string' && p.endsWith('%') && p.length > 1 && p !== '%',
    ) as string | undefined;
    expect(ilikePattern).toBeDefined();

    const escapedInstitution = ilikePattern!.slice(0, -1);
    expect(escapedInstitution).toBe('\\%\\_\\\\');
  });

  it('?field= site emits SQL containing `ESCAPE \'\\\\\'` on the ILIKE clause (single-ILIKE shape)', async () => {
    // JS template literal `\\` yields one `\` in the runtime string, so the
    // SQL string literally contains `ESCAPE '\'` (10 chars: E,S,C,A,P,E,
    // space, ',\, '). When ONLY `?field=` is supplied, the conditions array
    // contains exactly one ILIKE fragment (the `field` one) and the emitted
    // SQL carries exactly one `ESCAPE '\\'` clause.
    let capturedSql: string | undefined;
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('ROW_NUMBER() OVER (PARTITION BY') && capturedSql === undefined) {
        capturedSql = sql;
      }
      return { rows: [] };
    });

    await request(app).get('/api/accreditations?field=biology');
    expect(capturedSql).toBeDefined();
    const escapeClause = `ESCAPE '\\'`;
    expect(capturedSql).toContain(`latest.field ILIKE`);
    expect(capturedSql).toContain(escapeClause);
    // Field-only request → exactly 1 ILIKE site → exactly 1 ESCAPE clause.
    const occurrences = capturedSql!.split(escapeClause).length - 1;
    expect(occurrences).toBe(1);
  });

  it('?institution= site emits SQL containing `ESCAPE \'\\\\\'` on the ILIKE clause (single-ILIKE shape)', async () => {
    let capturedSql: string | undefined;
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('ROW_NUMBER() OVER (PARTITION BY') && capturedSql === undefined) {
        capturedSql = sql;
      }
      return { rows: [] };
    });

    await request(app).get('/api/accreditations?institution=mit');
    expect(capturedSql).toBeDefined();
    const escapeClause = `ESCAPE '\\'`;
    expect(capturedSql).toContain(`latest.institution ILIKE`);
    expect(capturedSql).toContain(escapeClause);
    const occurrences = capturedSql!.split(escapeClause).length - 1;
    expect(occurrences).toBe(1);
  });

  it('both ILIKE call sites carry `ESCAPE \'\\\\\'` when ?field= AND ?institution= are supplied (pin exact occurrence count to 2)', async () => {
    // When both filters are supplied, the conditions array gathers BOTH
    // ILIKE fragments and the emitted SQL carries TWO `ESCAPE '\\'` clauses
    // — one per ILIKE site. Pinning the exact count to 2 catches a
    // regression that drops the clause from one site while leaving the
    // other clean (the "count branch + data branch" framing in the
    // architect's round-2 hold).
    let capturedSql: string | undefined;
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('ROW_NUMBER() OVER (PARTITION BY') && capturedSql === undefined) {
        capturedSql = sql;
      }
      return { rows: [] };
    });

    await request(app).get('/api/accreditations?field=biology&institution=mit');
    expect(capturedSql).toBeDefined();
    const escapeClause = `ESCAPE '\\'`;
    // Both ILIKE conditions present.
    expect(capturedSql).toContain(`latest.field ILIKE`);
    expect(capturedSql).toContain(`latest.institution ILIKE`);
    // Exactly two `ESCAPE '\\'` clauses, one per ILIKE site. A regression
    // dropping the clause from either site would surface as `toBe(1)`.
    const occurrences = capturedSql!.split(escapeClause).length - 1;
    expect(occurrences).toBe(2);
  });
});

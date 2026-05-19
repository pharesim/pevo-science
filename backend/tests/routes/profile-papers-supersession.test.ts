/**
 * ORCID supersession parity canary for GET /api/profile/:username/papers.
 *
 * The SQL-projection in `authorsWithSupersessionSelect` runs on `/api/papers`
 * (list) and `/api/papers/:author/:permlink` (detail), but the profile-papers
 * endpoint assembles rows via `fetchUserPapersFromHaf` → `toPaperSummary` —
 * a JS-side code path that doesn't round-trip through the SQL projection.
 * This file pins the JS-side supersession wiring on /api/profile/:username/papers,
 * mirroring the SQL-projected matrix shape from the canonical 4-case rule in
 * `agents/docs/hive-schemas.md` § 1.1 (plus a case-4b match-companion).
 *
 * Negative-control canaries cover the affiliation-strip contract
 * (PaperSummary omits per `agents/docs/api-contracts/papers.md`), the JS
 * spread-leak gap (broadcaster-controlled extra fields must drop), and the
 * HAF-outage 503-retriable path.
 *
 * **Carve-out (per CLAUDE.md "Running Tests" carve-out clauses (a)/(b)/(c)):**
 *   (a) Real-corpus seeding of the four-case matrix is impractical: each
 *       case requires a specific `(authors[i].hive, authors[i].orcid,
 *       active_accreditations.orcid)` combination per row, and the live
 *       HAF testnet accreditation set churns. Mocked pool seeds the row
 *       shape per-test.
 *   (b) `verifyHiveSignature` is NOT mocked — `/api/profile/:username/papers`
 *       is a public GET. The MOCK_VERIFY_SIGNATURE fixture is not loaded.
 *   (c) Real-path companion: the same risk class (LEFT JOIN against
 *       `active_accreditations` + four-case supersession projection) is
 *       covered integratively at sibling sites:
 *       - `tests/routes/papers.test.ts` exercises the SQL-projected variant
 *         against real HAF on `/api/papers`.
 *       - `tests/routes/papers-canonical-orcid-resolution.test.ts` mocks
 *         the SQL projection and pins the four-case matrix shape on the
 *         papers endpoints; the helper unit tests inside that file
 *         exercise the JS helpers (`normalizeHiveAccount`, `computeSupersession`,
 *         `applyAuthorSupersession`) directly.
 *       The shared lib module these tests target is the same one
 *       `toPaperSummary` consumes; this file pins the route-level wiring
 *       on the profile-papers surface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async (..._args: any[]) => ({ rows: [] as unknown[] })),
  getPoolMock: vi.fn(),
}));

vi.mock('../../src/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db.js')>();
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

beforeEach(async () => {
  hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
  getPoolMock.mockReset().mockReturnValue({
    query: hafQueryMock,
    connect: async () => ({ query: hafQueryMock, release: () => {} }),
  });
  await hafCache.clear();
});

/**
 * Build a `user_papers` data row with a chain `authors[]` array of the
 * caller's choosing. The shape mirrors the columns selected by
 * `fetchUserPapersFromHaf`'s data query (`author`, `permlink`, `title`,
 * `body`, `json_metadata`, `created`) — `total_rshares` is in the inner
 * CTE but omitted from the outer SELECT.
 */
function userPapersRow(authors: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    author: 'alice',
    permlink: 'p1',
    title: 'Test paper',
    body: 'abstract\n\n---\n\nbody',
    json_metadata: {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors,
      },
    },
    created: '2026-04-01T00:00:00Z',
  };
}

/**
 * Stage the mocked pool so the profile-papers route receives one row with
 * `authors` and an accredited-orcid map populated per the test scenario.
 *
 * Discriminators:
 *   - count: `count(*)::int AS total FROM user_papers`
 *   - data:  `FROM user_papers` (and NOT a count)
 *   - accredited orcid map: `SELECT account, orcid FROM active_accreditations`
 *     (from `getAccreditedOrcidsByAccount`).
 */
function stage(authors: Array<Record<string, unknown>>, accredited: Array<{ account: string; orcid: string | null }>): void {
  hafQueryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('count(*)') && sql.includes('user_papers')) {
      return { rows: [{ total: 1 }] };
    }
    if (sql.includes('FROM user_papers')) {
      return { rows: [userPapersRow(authors)] };
    }
    if (sql.includes('FROM active_accreditations') && sql.includes('SELECT account, orcid')) {
      return { rows: accredited };
    }
    return { rows: [] };
  });
}

describe('GET /api/profile/:username/papers — ORCID supersession parity', () => {
  it('case 1: hive empty/absent → orcid_verified=null, orcid_discrepancy=false', async () => {
    stage(
      [{ name: 'Anonymous Co-author', hive: null, orcid: null }],
      [{ account: 'alice', orcid: '0000-0000-0000-9999' }],
    );
    const res = await request(app).get('/api/profile/alice/papers');
    expect(res.status).toBe(200);
    const author = res.body.data[0].authors[0];
    expect(author.orcid_verified).toBeNull();
    expect(author.orcid_discrepancy).toBe(false);
  });

  it('case 2: hive set, not accredited → orcid_verified=null, orcid_discrepancy=false', async () => {
    stage(
      [{ name: 'Bob', hive: 'bob', orcid: '0000-0000-0000-1234' }],
      // alice is accredited but bob is NOT.
      [{ account: 'alice', orcid: '0000-0000-0000-9999' }],
    );
    const res = await request(app).get('/api/profile/alice/papers');
    expect(res.status).toBe(200);
    const author = res.body.data[0].authors.find((a: Record<string, unknown>) => a.hive === 'bob');
    expect(author).toBeDefined();
    expect(author.orcid_verified).toBeNull();
    expect(author.orcid_discrepancy).toBe(false);
  });

  it('case 3: hive accredited, accreditation orcid null → orcid_verified=null, orcid_discrepancy=false', async () => {
    stage(
      [{ name: 'Carol', hive: 'carol', orcid: '0000-0000-0000-2222' }],
      // carol accredited but without an ORCID attestation.
      [{ account: 'carol', orcid: null }],
    );
    const res = await request(app).get('/api/profile/alice/papers');
    expect(res.status).toBe(200);
    const author = res.body.data[0].authors[0];
    expect(author.hive).toBe('carol');
    expect(author.orcid_verified).toBeNull();
    expect(author.orcid_discrepancy).toBe(false);
  });

  it('case 4: hive accredited, attestation differs from chain → orcid_verified=attestation, orcid_discrepancy=true', async () => {
    stage(
      [{ name: 'Dave', hive: 'dave', orcid: '0000-0000-0000-1234' }],
      [{ account: 'dave', orcid: '0000-0000-0000-5678' }],
    );
    const res = await request(app).get('/api/profile/alice/papers');
    expect(res.status).toBe(200);
    const author = res.body.data[0].authors[0];
    expect(author.hive).toBe('dave');
    expect(author.orcid).toBe('0000-0000-0000-1234');
    expect(author.orcid_verified).toBe('0000-0000-0000-5678');
    expect(author.orcid_discrepancy).toBe(true);
  });

  it('case 4b: chain orcid matches attestation → orcid_verified populated, orcid_discrepancy=false', async () => {
    stage(
      [{ name: 'Eve', hive: 'eve', orcid: '0000-0000-0000-3000' }],
      [{ account: 'eve', orcid: '0000-0000-0000-3000' }],
    );
    const res = await request(app).get('/api/profile/alice/papers');
    expect(res.status).toBe(200);
    const author = res.body.data[0].authors[0];
    expect(author.orcid).toBe('0000-0000-0000-3000');
    expect(author.orcid_verified).toBe('0000-0000-0000-3000');
    expect(author.orcid_discrepancy).toBe(false);
  });

  it('mixed-case hive matches the lowercase accreditation entry (cross-path parity)', async () => {
    // The `normalizeHiveAccount` helper normalizes mixed-case chain `hive`
    // to lowercase before the `orcidMap` lookup. Without normalization, a
    // vouched co-author posting `{hive: "Alice"}` could suppress the
    // `orcid_verified` surface. The papers-list and detail endpoints'
    // SQL projection uses the same canonicalization at the JOIN; the JS
    // helper used by this route must produce the same supersession output.
    stage(
      [{ name: 'Alice', hive: 'Alice', orcid: '0000-0000-0000-1234' }],
      [{ account: 'alice', orcid: '0000-0000-0000-9999' }],
    );
    const res = await request(app).get('/api/profile/alice/papers');
    expect(res.status).toBe(200);
    const author = res.body.data[0].authors[0];
    expect(author.orcid_verified).toBe('0000-0000-0000-9999');
    expect(author.orcid_discrepancy).toBe(true);
  });

  it('PaperSummary authors[i] does NOT carry the affiliation field', async () => {
    // Per the contract (`agents/docs/api-contracts/papers.md`), PaperSummary
    // omits `affiliation` while PaperDetail carries it. The JS-side
    // `applyAuthorSupersession` preserves all chain fields by design (so
    // PaperDetail callers reuse it); `toPaperSummary` strips affiliation
    // post-supersession to honor the per-surface contract. Mutation kill:
    // remove the affiliation-strip block in `helpers.ts:toPaperSummary`
    // and this canary surfaces the leaked field red.
    stage(
      [{ name: 'Frank', hive: 'frank', orcid: '0000-0000-0000-4000', affiliation: 'Sorbonne' }],
      [{ account: 'frank', orcid: '0000-0000-0000-4000' }],
    );
    const res = await request(app).get('/api/profile/alice/papers');
    expect(res.status).toBe(200);
    const author = res.body.data[0].authors[0];
    expect(author.hive).toBe('frank');
    // Supersession still applied
    expect(author.orcid_verified).toBe('0000-0000-0000-4000');
    expect(author.orcid_discrepancy).toBe(false);
    // Affiliation stripped — the parity-with-PaperSummary contract.
    expect(author).not.toHaveProperty('affiliation');
  });

  it('empty accreditation set: supersession fields collapse to case-1 defaults (null/false), 200 OK', async () => {
    // When the on-chain `active_accreditations` set is empty (no accredited
    // accounts), `getAccreditedOrcidsByAccount()` returns an empty Map —
    // distinct from the throw path (HAF unreachable) covered separately
    // below. Each author entry's `orcid_verified` resolves to `null` and
    // `orcid_discrepancy` resolves to `false` (the case-1/case-2 collapse).
    // Route is 200 OK with the per-author defaults; the empty accreditation
    // set is not a degraded state.
    stage(
      [{ name: 'Grace', hive: 'grace', orcid: '0000-0000-0000-7000' }],
      [], // empty active_accreditations (no accredited accounts on chain)
    );
    const res = await request(app).get('/api/profile/alice/papers');
    expect(res.status).toBe(200);
    const author = res.body.data[0].authors[0];
    expect(author.orcid_verified).toBeNull();
    expect(author.orcid_discrepancy).toBe(false);
  });

  it('HAF outage on getAccreditedOrcidsByAccount → 503 SERVICE_UNAVAILABLE with retriable:true', async () => {
    // When HAF is reachable but the `active_accreditations` CTE query throws
    // (e.g., partial-HAF outage, query timeout), the route MUST translate to
    // 503 with `retriable: true` matching the sibling-route pattern in
    // routes/papers.ts. Without the route-level try/catch wrapping
    // `getAccreditedOrcidsByAccount` in `HafQueryError`, the raw pg error
    // would propagate to the central 500 handler.
    //
    // Mutation kill: revert the route's try/catch around
    // getAccreditedOrcidsByAccount and the response goes 500 INTERNAL_ERROR
    // instead of 503 SERVICE_UNAVAILABLE retriable.
    hafQueryMock.mockImplementation(async (sql: string) => {
      // active_accreditations CTE query throws.
      if (sql.includes('FROM active_accreditations') && sql.includes('SELECT account, orcid')) {
        throw new Error('HAF query timed out (simulated outage)');
      }
      return { rows: [] };
    });
    const res = await request(app).get('/api/profile/alice/papers');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.details?.retriable).toBe(true);
  });

  it('broadcaster-controlled extra fields on authors[i] do NOT leak through the JS projection', async () => {
    // The SQL-side `authorsWithSupersessionSelect` enumerates the projected
    // keys inside `jsonb_build_object`, so any broadcaster-controlled extra
    // field is dropped at the SQL boundary. The JS-side helper used by this
    // route must produce the same enumerated shape. Mutation kill: revert
    // `applyAuthorSupersession` to `{ ...entry, ...supersession }` and the
    // assertion below surfaces the leaked field red.
    stage(
      [{
        name: 'Heidi',
        hive: 'heidi',
        orcid: '0000-0000-0000-8000',
        evil_field: 'broadcaster-controlled payload',
        // Also test a more plausibly-named injection vector.
        verified_at: '2026-05-19T00:00:00Z',
      }],
      [{ account: 'heidi', orcid: '0000-0000-0000-8000' }],
    );
    const res = await request(app).get('/api/profile/alice/papers');
    expect(res.status).toBe(200);
    const author = res.body.data[0].authors[0];
    // Supersession fields land — the enumerated projection still includes
    // them via the spread of `supersession`.
    expect(author.orcid_verified).toBe('0000-0000-0000-8000');
    // The enumerated keys land verbatim.
    expect(author.name).toBe('Heidi');
    expect(author.hive).toBe('heidi');
    expect(author.orcid).toBe('0000-0000-0000-8000');
    // Broadcaster-controlled extras are dropped (and affiliation is stripped
    // by toPaperSummary for PaperSummary).
    expect(author).not.toHaveProperty('evil_field');
    expect(author).not.toHaveProperty('verified_at');
    expect(author).not.toHaveProperty('affiliation');
  });
});

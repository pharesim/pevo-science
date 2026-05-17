/**
 * Mocked-pool coverage for BACKEND-FETCH-PAPER-DETAIL-HAF-ERROR-VS-NOT-FOUND.
 *
 * Pins the discrimination between HAF-class outage (503 SERVICE_UNAVAILABLE
 * with `details.retriable: true`) and data-not-found (404 NOT_FOUND) at the
 * four paper-detail-class route handlers:
 *
 *   - GET /api/papers/:author/:permlink           (primary detail)
 *   - GET /api/papers/:author/:permlink/enrichment
 *   - POST /api/papers/:author/:permlink/retract
 *   - GET /api/papers/:author/:permlink/cite
 *
 * Pre-fix, `fetchPaperDetailFromHaf`'s try/catch logged and returned `null`
 * for both failure modes; route handlers collapsed `null → 404`, so an HAF
 * outage was indistinguishable from "paper does not exist" to clients.
 * The fix re-throws HAF query failures as `HafQueryError`; the route layer
 * translates that tag to 503 with the retriable envelope, leaving the 404
 * path intact for the data-missing case.
 *
 * Per CLAUDE.md "Running Tests" mocked-pool carve-out:
 *
 *   (a) Driving a real HAF outage per-test is impractical: it would require
 *       tearing down the pool or seeding a query that deterministically
 *       fails on the public testnet, and the resulting failure shape varies
 *       (connection refused, statement_timeout, query rejection). Mocked
 *       pool seeds the throw deterministically. The 404 path likewise
 *       needs a guaranteed "no such paper" coordinate which the public
 *       testnet cannot pin without polluting it with throwaway permlinks.
 *
 *   (b) `verifyHiveSignature` is NOT mocked for the GET routes
 *       (/cite, /enrichment, primary detail) — those are public reads.
 *       /retract uses `MOCK_VERIFY_SIGNATURE` so the test can reach the
 *       fetcher call site without signing a real Hive operation per-test.
 *       The fixture preserves the 401-on-missing-header gate and the
 *       username-extraction behavior; only cryptographic signature
 *       verification is bypassed. Real-path /retract auth coverage is
 *       provided by the existing `retract.test.ts` suite (which exercises
 *       the same fixture in the BroadcastTimeoutError + 502 specs).
 *
 *   (c) Real-path companion for the same risk class (HAF integration
 *       paths surfacing as 503 rather than masked-404): the
 *       wall-clock-budget specs in `canonical-root-walker.test.ts` and
 *       `continuation-author-gate.test.ts` exercise the real walker code
 *       against a real-HAF pool with the slow-responder fixture, surfacing
 *       503 with the same retriable envelope on a different trigger
 *       (walker-budget exhaustion). The catch-block fix here closes the
 *       remaining HAF-query-error branch that those specs cannot reach
 *       (a literal pg pool throw is structurally distinct from a walker
 *       abort).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const { hafQueryMock, getPoolMock, broadcastJsonMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async (..._args: any[]) => ({ rows: [] as any[] })),
  getPoolMock: vi.fn(),
  broadcastJsonMock: vi.fn().mockResolvedValue({ id: 'mock-retract-tx' }),
}));

// The mock MUST expose `HafQueryError` because the route handler does
// `err instanceof HafQueryError` and reads the class identity from the
// (mocked) `../../src/db.js` module — if the mock returns a different
// class, `instanceof` fails to match and the route would 500 via the
// errorHandler instead of 503ing via the discriminator. Mirror the real
// shape (operation + cause) so the mocked-throw test exercises the same
// `instanceof` gate the real path uses.
class HafQueryError extends Error {
  public readonly operation: string;
  constructor(operation: string, options?: { cause?: unknown }) {
    super(`HAF query failed: ${operation}`, options as ErrorOptions);
    this.name = 'HafQueryError';
    this.operation = operation;
  }
}

vi.mock('../../src/db.js', () => ({
  getPool: getPoolMock,
  isHafConfigured: () => getPoolMock() !== null,
  closeHafPool: async () => { /* no-op */ },
  HafQueryError,
}));

vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: { getAccounts: vi.fn().mockResolvedValue([]) },
    broadcast: { json: broadcastJsonMock },
  },
  broadcastJsonWithTimeout: (...args: unknown[]) =>
    (broadcastJsonMock as (...a: unknown[]) => unknown)(...args),
  BroadcastTimeoutError: class BroadcastTimeoutError extends Error {},
  DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
}));

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');
const { config } = await import('../../src/config.js');

// `pevoAdminPostingKey` must be a real WIF so PrivateKey.fromString on the
// /retract broadcast path is happy; broadcast.json is mocked so no signing
// actually fires. Matches `retract.test.ts`'s setup.
config.pevoAdminPostingKey = PrivateKey.fromSeed(
  'pevo-haf-error-vs-not-found-test',
).toString();

const app = createApp();

beforeEach(async () => {
  hafQueryMock.mockReset();
  getPoolMock.mockReset().mockReturnValue({
    query: hafQueryMock,
    connect: async () => ({ query: hafQueryMock, release: () => {} }),
  });
  broadcastJsonMock.mockReset().mockResolvedValue({ id: 'mock-retract-tx' });
  await hafCache.clear();
});

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink — primary detail.
//
// Two specs, mirror-imaged:
//   - HAF throws → 503 SERVICE_UNAVAILABLE with `details.retriable: true`.
//   - HAF returns 0 rows → 404 NOT_FOUND (unchanged contract).
// ──────────────────────────────────────────────

describe('GET /api/papers/:author/:permlink — HAF-error vs not-found', () => {
  it('HAF query throw → 503 SERVICE_UNAVAILABLE with retriable=true', async () => {
    // First query fired by the route is the canonical-root walker probe;
    // make EVERY query throw so the failure surfaces inside
    // `fetchPaperDetailFromHaf`'s try/catch wrapper regardless of which
    // sub-query trips first. The catch re-throws `HafQueryError`, and the
    // route's outer catch translates to 503.
    hafQueryMock.mockRejectedValue(new Error('connection refused'));

    const res = await request(app).get('/api/papers/alice/paper-x');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.details).toEqual({ retriable: true });
    // Message is user-facing; the project convention bans em-dashes in
    // user-facing strings, so pin "Please retry" without one.
    expect(res.body.error.message).toMatch(/temporarily unavailable/i);
    expect(res.body.error.message).toMatch(/retry/i);
  });

  it('HAF returns 0 rows → 404 NOT_FOUND (data-missing path unchanged)', async () => {
    // Every query returns no rows. The canonical-root walker bails
    // (no continues), `fetchPaperDetailFromHaf`'s paperResult has 0 rows
    // → returns null, the metadata-restored fallback's versions[]
    // also empties out, the cache key fills with `null`, and the route
    // surfaces 404. No throw fires anywhere.
    hafQueryMock.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/papers/nobody/no-paper');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink/enrichment.
// ──────────────────────────────────────────────

describe('GET /api/papers/:author/:permlink/enrichment — HAF-error vs not-found', () => {
  it('HAF query throw → 503 SERVICE_UNAVAILABLE with retriable=true', async () => {
    hafQueryMock.mockRejectedValue(new Error('pool exhausted'));

    const res = await request(app).get('/api/papers/alice/paper-x/enrichment');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.details).toEqual({ retriable: true });
  });

  it('pool unavailable → 404 NOT_FOUND (pre-existing behavior: fetchEnrichmentFromHaf returns null on pool === null)', async () => {
    // `/enrichment`'s "no rows" path differs from the primary detail route:
    // the fetcher always returns an envelope (votes=0, reviews=[], etc.)
    // when HAF responds with empty result sets, so an empty-row response
    // never reaches the route's `!cached → 404` check. The only data-missing
    // surface that DOES reach 404 is `pool === null` (HAF not configured),
    // where the fetcher's early return produces `null` and `hafCache.getOrSet`
    // surfaces a `null` cached value.
    getPoolMock.mockReturnValue(null);

    const res = await request(app).get('/api/papers/nobody/no-paper/enrichment');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ──────────────────────────────────────────────
// POST /api/papers/:author/:permlink/retract.
//
// /retract calls `fetchPaperDetailFromHaf` for the paper-row + authorization
// check before broadcasting. The 503 path fires on the same fetcher throw;
// the 404 path is preserved for "paper does not exist."
// ──────────────────────────────────────────────

describe('POST /api/papers/:author/:permlink/retract — HAF-error vs not-found', () => {
  it('HAF query throw → 503 SERVICE_UNAVAILABLE with retriable=true', async () => {
    hafQueryMock.mockRejectedValue(new Error('statement_timeout'));

    const res = await request(app)
      .post('/api/papers/alice/paper-x/retract')
      .set('X-Hive-Username', 'alice')
      .send({ reason: 'Data fabrication' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.details).toEqual({ retriable: true });
    // Broadcast must NOT fire when the pre-broadcast HAF call fails.
    expect(broadcastJsonMock).not.toHaveBeenCalled();
  });

  it('HAF returns 0 rows → 404 NOT_FOUND (paper does not exist)', async () => {
    hafQueryMock.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post('/api/papers/nobody/no-paper/retract')
      .set('X-Hive-Username', 'nobody')
      .send({ reason: 'Error' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink/cite.
// ──────────────────────────────────────────────

describe('GET /api/papers/:author/:permlink/cite — HAF-error vs not-found', () => {
  it('HAF query throw → 503 SERVICE_UNAVAILABLE with retriable=true', async () => {
    hafQueryMock.mockRejectedValue(new Error('network unreachable'));

    const res = await request(app).get('/api/papers/alice/paper-x/cite?format=bibtex');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.details).toEqual({ retriable: true });
  });

  it('HAF returns 0 rows → 404 NOT_FOUND', async () => {
    hafQueryMock.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/papers/nobody/no-paper/cite?format=bibtex');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

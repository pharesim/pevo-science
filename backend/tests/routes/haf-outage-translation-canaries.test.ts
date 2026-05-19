/**
 * HAF-outage translation canaries across routes that translate transient HAF
 * query failures into `503 SERVICE_UNAVAILABLE` with `details.retriable: true`.
 *
 * Routes covered here:
 *
 *   - GET  /api/profile/:username/papers   (fetchUserPapersFromHaf throw)
 *   - GET  /api/profile/:username/reviews  (fetchUserReviewsFromHaf throw)
 *   - GET  /api/reviews/:author/:permlink  (fetchReviewFromHaf throw)
 *   - GET  /api/papers/:author/:permlink/comments (paperExistsInHaf throw)
 *
 * The sibling spec at `papers-haf-error-vs-not-found.test.ts` already pins
 * the four paper-detail-class handlers in `routes/papers.ts`. The 503
 * retriable canary on `/api/profile/:username/papers`'s
 * `getAccreditedOrcidsByAccount` arm is in
 * `profile-papers-supersession.test.ts`. This file extends the same envelope
 * shape to the remaining HAF-touching routes where the helper used to
 * swallow the failure and return `null`, collapsing the route response to a
 * 200-with-empty-rows / 404 NOT_FOUND that the SPA could not distinguish
 * from "no data" / "no such record."
 *
 * Per CLAUDE.md "Running Tests" mocked-pool carve-out:
 *
 *   (a) Driving a real HAF outage per-test is impractical: it would require
 *       tearing down the pool or seeding a query that deterministically
 *       fails on the public testnet, and the resulting failure shape varies
 *       (connection refused, statement_timeout, query rejection). Mocked
 *       pool seeds the throw deterministically.
 *
 *   (b) Every route under test is a public GET, so `verifyHiveSignature`
 *       is NOT mocked. No auth middleware runs on these handlers.
 *
 *   (c) Real-path companion for the same risk class (HAF integration paths
 *       surfacing as 503 retriable rather than masked-empty / masked-404):
 *       the wall-clock-budget specs in `canonical-root-walker.test.ts` and
 *       `continuation-author-gate.test.ts` exercise the real walker code
 *       against a real-HAF pool with the slow-responder fixture, surfacing
 *       503 with the same retriable envelope on a different trigger
 *       (walker-budget exhaustion). The catch-block fixes here close the
 *       remaining HAF-query-error branch that those specs cannot reach
 *       (a literal pg pool throw is structurally distinct from a walker
 *       abort).
 *
 *   Mutation kill: revert any of the touched `catch (err)` blocks to
 *   `return null` (or `logger.error + return`) and the corresponding spec
 *   below fails red — the route would respond 200 / 404 instead of 503
 *   retriable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async (..._args: any[]) => ({ rows: [] as any[] })),
  getPoolMock: vi.fn(),
}));

// The mock MUST expose `HafQueryError` because the route handlers do
// `err instanceof HafQueryError` and read the class identity from the
// (mocked) `../../src/db.js` module. Mirror the real shape (operation +
// cause) so the mocked-throw test exercises the same `instanceof` gate the
// real path uses.
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
    database: {
      getAccounts: vi.fn().mockResolvedValue([
        // Profile route checks account existence via dhive before any HAF
        // query fires. Return a present account so the route advances to the
        // HAF-touching code path under test.
        { name: 'alice' },
      ]),
    },
  },
}));

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');

const app = createApp();

beforeEach(async () => {
  hafQueryMock.mockReset();
  getPoolMock.mockReset().mockReturnValue({
    query: hafQueryMock,
    connect: async () => ({ query: hafQueryMock, release: () => {} }),
  });
  await hafCache.clear();
});

function expect503Retriable(res: { status: number; body: any }) {
  expect(res.status).toBe(503);
  expect(res.body.status).toBe('error');
  expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  expect(res.body.error.details).toEqual({ retriable: true });
  expect(res.body.error.message).toMatch(/temporarily unavailable/i);
  expect(res.body.error.message).toMatch(/retry/i);
}

// ──────────────────────────────────────────────
// GET /api/profile/:username/papers — fetchUserPapersFromHaf throw
// ──────────────────────────────────────────────

describe('GET /api/profile/:username/papers — HAF outage on fetchUserPapersFromHaf', () => {
  it('HAF query throw scoped to the user-papers SELECT → 503 SERVICE_UNAVAILABLE with retriable=true', async () => {
    // Discriminate the user-papers SELECT from the
    // `getAccreditedOrcidsByAccount` CTE call that runs earlier in the
    // route. The orcid query selects `account, orcid` from
    // `active_accreditations`; the user-papers data query selects from the
    // `user_papers` CTE built inside `fetchUserPapersFromHaf`. Throwing
    // only on the user-papers query exercises the catch in that helper
    // specifically; the sibling orcid throw is already covered by
    // `profile-papers-supersession.test.ts`.
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM user_papers')) {
        throw new Error('user-papers query timed out (simulated)');
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/profile/alice/papers');

    expect503Retriable(res);
  });
});

// ──────────────────────────────────────────────
// GET /api/profile/:username/reviews — fetchUserReviewsFromHaf throw
// ──────────────────────────────────────────────

describe('GET /api/profile/:username/reviews — HAF outage on fetchUserReviewsFromHaf', () => {
  it('HAF query throw → 503 SERVICE_UNAVAILABLE with retriable=true (was 200 empty pre-fix)', async () => {
    hafQueryMock.mockRejectedValue(new Error('statement_timeout'));

    const res = await request(app).get('/api/profile/alice/reviews');

    expect503Retriable(res);
  });
});

// ──────────────────────────────────────────────
// GET /api/reviews/:author/:permlink — fetchReviewFromHaf throw
// ──────────────────────────────────────────────

describe('GET /api/reviews/:author/:permlink — HAF outage on fetchReviewFromHaf', () => {
  it('HAF query throw → 503 SERVICE_UNAVAILABLE with retriable=true (was 404 NOT_FOUND pre-fix)', async () => {
    hafQueryMock.mockRejectedValue(new Error('pool exhausted'));

    const res = await request(app).get('/api/reviews/alice/review-x');

    expect503Retriable(res);
  });

  it('HAF returns 0 rows → 404 NOT_FOUND (data-missing path unchanged)', async () => {
    hafQueryMock.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/reviews/nobody/no-review');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink/comments — paperExistsInHaf throw
// ──────────────────────────────────────────────

describe('GET /api/papers/:author/:permlink/comments — HAF outage on paperExistsInHaf', () => {
  it('HAF query throw on paper-existence check → 503 SERVICE_UNAVAILABLE with retriable=true (was 404 NOT_FOUND pre-fix)', async () => {
    hafQueryMock.mockRejectedValue(new Error('network unreachable'));

    const res = await request(app).get('/api/papers/alice/paper-x/comments');

    expect503Retriable(res);
  });

  it('HAF returns 0 rows on paper-existence check → 404 NOT_FOUND (paper does not exist)', async () => {
    hafQueryMock.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/papers/nobody/no-paper/comments');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// `/api/notifications` intentionally keeps the helper's swallow-to-null
// contract (the route serves 200 empty-events on HAF outage). Rationale: the
// notification SQL is a broad multi-CTE scan keyed on a caller-supplied
// `sinceBlock` that can legitimately reach the 30s statement_timeout under
// wide ranges; translating to 503 retriable would mis-classify "expensive
// query" as "outage" and amplify load on retry storms. See the docstring
// on `fetchNotificationsFromHaf`'s catch block for the rationale.

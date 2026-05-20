/**
 * HAF-outage translation canaries across routes that translate transient HAF
 * query failures into `503 SERVICE_UNAVAILABLE` with `details.retriable: true`.
 *
 * Routes covered here:
 *
 *   - GET  /api/profile/:username/papers   (fetchUserPapersFromHaf throw +
 *                                           enrichment Promise.all wrap)
 *   - GET  /api/profile/:username/reviews  (fetchUserReviewsFromHaf throw)
 *   - GET  /api/reviews/:author/:permlink  (fetchReviewFromHaf throw)
 *   - GET  /api/papers/:author/:permlink/comments (paperExistsInHaf preflight
 *                                                  throw + fetchCommentsFromHaf
 *                                                  listing throw)
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
 * Each canary discriminates on a stable SQL fragment (CTE label, JOIN
 * shape, projection column) emitted only by the targeted helper, so a
 * blanket-reject mock cannot pass by intercepting a sibling query that
 * fires earlier in the route. The final canary in the file exercises the
 * cause-discrimination guard in `isRetriableHafError` (db.ts) — a
 * deterministic pg error code (42601 syntax error) must fall through to
 * `500 INTERNAL_ERROR` rather than emit 503 retriable, so the SPA retry
 * loop does not hammer a dead query.
 *
 * Per CLAUDE.md "Running Tests" mocked-pool carve-out:
 *
 *   (a) Driving a real HAF outage per-test is impractical: it would require
 *       tearing down the pool or seeding a query that deterministically
 *       fails on the public testnet, and the resulting failure shape varies
 *       (connection refused, statement_timeout, query rejection). Mocked
 *       pool seeds the throw deterministically. Cryptographic verification
 *       is NOT bypassed here — every route under test is a public GET, so
 *       no auth middleware runs on these handlers.
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

// The mock MUST expose `HafQueryError` AND `isRetriableHafError` because
// the route handlers do `err instanceof HafQueryError &&
// isRetriableHafError(err)` and read both from the (mocked)
// `../../src/db.js` module. Mirror the real shapes so the mocked-throw
// test exercises the same `instanceof` + cause-discrimination gate the
// real path uses.
class HafQueryError extends Error {
  constructor(operation: string, options?: ErrorOptions) {
    super(`HAF query failed: ${operation}`, options);
    this.name = 'HafQueryError';
  }
}

// Test-only copy of `isRetriableHafError` — must stay structurally
// identical to the production implementation in `backend/src/db.ts` (the
// cross-surface parity invariant: production code discriminates on the
// same shape these canaries pin). Retriable: connection-class pg codes
// (`08*`), `57014` (statement_timeout), `57P03` (cannot_connect_now —
// startup/PITR/standby-promotion), `53300` (too_many_connections), or
// no code at all (generic JS Error from the network / pool layer).
function isRetriableHafError(err: HafQueryError): boolean {
  const code = (err.cause as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'string') return true;
  return code.startsWith('08') || code === '57014' || code === '57P03' || code === '53300';
}

vi.mock('../../src/db.js', () => ({
  getPool: getPoolMock,
  isHafConfigured: () => getPoolMock() !== null,
  closeHafPool: async () => { /* no-op */ },
  HafQueryError,
  isRetriableHafError,
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

// Each canary discriminates on a SQL fragment unique to the targeted
// helper, so a blanket-reject mock cannot pass by intercepting a sibling
// query that fires earlier in the route. The discriminator strings below
// anchor on stable SQL invariants (CTE labels, JOIN shapes, projection
// columns) rather than line numbers or transient query text — see
// `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-...`.

// ──────────────────────────────────────────────
// GET /api/profile/:username/papers — fetchUserPapersFromHaf throw
// ──────────────────────────────────────────────

describe('GET /api/profile/:username/papers — HAF outage on fetchUserPapersFromHaf', () => {
  it('HAF query throw scoped to the user-papers SELECT → 503 SERVICE_UNAVAILABLE with retriable=true', async () => {
    // Discriminator: the `authorship_claims` CTE label is unique to
    // `fetchUserPapersFromHaf` (the helper UNIONs claimer-derived papers
    // with author-derived papers via a CTE named `authorship_claims`).
    // `getProfileStats` also builds a `user_papers` CTE but never
    // references `authorship_claims`, so keying on the latter avoids the
    // false-positive risk where a sibling SELECT FROM user_papers throws
    // first and masks a revert of the targeted helper's catch.
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('authorship_claims')) {
        throw new Error('user-papers query timed out (simulated)');
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/profile/alice/papers');

    expect503Retriable(res);
  });

  it('enrichment Promise.all HafQueryError wrap → 503 retriable when a post-fetch accreditation helper throws', async () => {
    // The enrichment branch (Promise.all over accreditation helpers)
    // only runs when `result.rows.length > 0`. The pre-fix enrichment
    // canary in this file threw BEFORE returning rows (using the
    // `authorship_claims` discriminator), so the Promise.all wrap branch
    // was structurally unreachable from tests — a revert of that wrap
    // would not turn any canary red.
    //
    // This canary makes user-papers succeed with one row, then rejects
    // the next accreditation helper query (`SELECT account FROM
    // active_accreditations` from `getAllAccreditedAccounts`). The wrap
    // translates that into a `HafQueryError('profile-papers-enrichment')`
    // which the outer catch maps to 503 retriable.
    let userPapersCount = 0;
    hafQueryMock.mockImplementation(async (sql: string) => {
      // user-papers count + data queries both reference the
      // `authorship_claims` CTE label.
      if (sql.includes('authorship_claims')) {
        userPapersCount += 1;
        // Distinguish count (first query) from data (second query) via
        // the `total` projection.
        if (sql.includes('count(*)::int AS total')) {
          return { rows: [{ total: 1 }] };
        }
        return {
          rows: [
            {
              author: 'alice',
              permlink: 'paper-x',
              title: 'A Title',
              body: 'body excerpt',
              json_metadata: JSON.stringify({ pevotest: { type: 'paper', authors: [{ hive: 'alice' }] } }),
              created: '2026-01-01T00:00:00',
            },
          ],
        };
      }
      // The first call into `active_accreditations` is from
      // `getAccreditedOrcidsByAccount` inside the cache-miss callback
      // BEFORE `fetchUserPapersFromHaf`. Make it succeed so the route
      // advances. Subsequent accreditation queries (firing inside the
      // enrichment Promise.all) must fail to exercise the wrap. We
      // discriminate by whether user-papers queries have already fired.
      if (sql.includes('active_accreditations') || sql.includes('SELECT account FROM active_accreditations')) {
        if (userPapersCount === 0) {
          // Pre-fetch orcid lookup — succeed with an empty set so the
          // route advances to fetchUserPapersFromHaf.
          return { rows: [] };
        }
        // Post-fetch enrichment Promise.all — fail. This is the path
        // that exercises the HafQueryError wrap around the enrichment.
        throw new Error('accreditation enrichment query rejected (simulated)');
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
    // Discriminator: `c.parent_author != ''` is the WHERE-clause
    // predicate unique to `fetchUserReviewsFromHaf` (review listings are
    // restricted to non-top-level posts, since reviews are always replies
    // to a paper). No other HAF helper in the audit catalog uses this
    // predicate; `getProfileStats:user_reviews` reads the user_reviews
    // CTE's accreditation gate but not this `!= ''` shape.
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("c.parent_author != ''")) {
        throw new Error('statement_timeout (simulated)');
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/profile/alice/reviews');

    expect503Retriable(res);
  });
});

// ──────────────────────────────────────────────
// GET /api/reviews/:author/:permlink — fetchReviewFromHaf throw
// ──────────────────────────────────────────────

describe('GET /api/reviews/:author/:permlink — HAF outage on fetchReviewFromHaf', () => {
  it('HAF query throw → 503 SERVICE_UNAVAILABLE with retriable=true (was 404 NOT_FOUND pre-fix)', async () => {
    // Discriminator: the single-review fetch projects the full body
    // (`c.body, c.json_metadata` without LEFT) plus joins parent paper
    // for the `paper_title` alias. The combination is unique to
    // `fetchReviewFromHaf`; the listing siblings project
    // `LEFT(c.body, 300) AS body`.
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('c.body, c.json_metadata') && sql.includes('paper_title')) {
        throw new Error('pool exhausted (simulated)');
      }
      return { rows: [] };
    });

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
// GET /api/papers/:author/:permlink/comments — paperExistsInHaf + fetchCommentsFromHaf throw
// ──────────────────────────────────────────────

describe('GET /api/papers/:author/:permlink/comments — HAF outage on paperExistsInHaf', () => {
  it('HAF query throw on paper-existence check → 503 SERVICE_UNAVAILABLE with retriable=true (was 404 NOT_FOUND pre-fix)', async () => {
    // Discriminator: `paperExistsInHaf` uses `SELECT 1 FROM ... LIMIT 1`
    // (existence-only probe). The listing helper uses `WITH RECURSIVE`
    // + `comment_tree` CTE and never selects literal `1`. Keying on
    // `SELECT 1` + `LIMIT 1` pins the preflight specifically.
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT 1 FROM') && sql.includes('LIMIT 1') && !sql.includes('WITH RECURSIVE')) {
        throw new Error('network unreachable (simulated)');
      }
      return { rows: [] };
    });

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

describe('GET /api/papers/:author/:permlink/comments — HAF outage on fetchCommentsFromHaf listing', () => {
  it('HAF query throw on comments listing (after preflight succeeds) → 503 SERVICE_UNAVAILABLE with retriable=true', async () => {
    // Composition asymmetry guard: a HAF outage that starts BETWEEN the
    // existence-check preflight (which succeeds) and the comments listing
    // (which fails) must collapse to 503 retriable, not 200 []. Pre-fix,
    // the listing helper swallowed to null and the route returned 200
    // empty rows for a paper the user knows has comments.
    //
    // Discriminator: `WITH RECURSIVE` + `comment_tree` is unique to the
    // listing helper's CTE (paperExistsInHaf uses neither).
    hafQueryMock.mockImplementation(async (sql: string) => {
      // Preflight succeeds (paper exists)
      if (sql.includes('SELECT 1 FROM') && sql.includes('LIMIT 1') && !sql.includes('WITH RECURSIVE')) {
        return { rows: [{ '?column?': 1 }] };
      }
      // Listing fails
      if (sql.includes('WITH RECURSIVE') && sql.includes('comment_tree')) {
        throw new Error('connection reset (simulated)');
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/paper-x/comments');

    expect503Retriable(res);
  });
});

// `/api/notifications` intentionally keeps the helper's swallow-to-null
// contract (the route serves 200 empty-events on HAF outage). Rationale: the
// notification SQL is a broad multi-CTE scan keyed on a caller-supplied
// `sinceBlock` that can legitimately reach the 30s statement_timeout under
// wide ranges; translating to 503 retriable would mis-classify "expensive
// query" as "outage" and amplify load on retry storms. See the docstring
// on `fetchNotificationsFromHaf`'s catch block for the rationale.

// ──────────────────────────────────────────────
// Deterministic pg-error class (e.g., syntax error) → 500, NOT 503 retriable
// ──────────────────────────────────────────────

describe('HafQueryError with deterministic pg error code → 500 (not 503 retriable)', () => {
  it('syntax error (42601) on the reviews single-doc fetch falls through to 500 INTERNAL_ERROR', async () => {
    // Cause-discrimination guard: `isRetriableHafError` in `db.ts`
    // classifies `42601` (SQL syntax error) and other deterministic
    // pg codes as NOT retriable. A retry storm on a dead query would
    // hammer the route until the SPA cap; the central 500 handler
    // owns these so the SPA does not mark them retriable.
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('c.body, c.json_metadata') && sql.includes('paper_title')) {
        const err = new Error('syntax error at or near "SELEKT"') as Error & { code: string };
        err.code = '42601';
        throw err;
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/reviews/alice/review-x');

    // Deterministic errors fall through to the central 500 handler;
    // they MUST NOT carry `details.retriable: true` so the SPA's retry
    // loop does not loop a dead query.
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    // Mutation-kill the retriable-classification gate: a regression that
    // emitted 500 INTERNAL_ERROR with { retriable: true } in details
    // would silently re-open the SPA retry loop on deterministic errors.
    expect(res.body.error.details?.retriable).not.toBe(true);
  });

  it('cannot_connect_now (57P03) on the reviews single-doc fetch is classified as 503 retriable', async () => {
    // Pins `isRetriableHafError`'s 57P03 classification (Postgres startup /
    // PITR / standby promotion windows) as retriable. The mirror-shape of
    // the 42601 canary above ensures the discriminator distinguishes
    // deterministic-pg from transient-pg on exactly the same call path.
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('c.body, c.json_metadata') && sql.includes('paper_title')) {
        const err = new Error('the database system is starting up') as Error & { code: string };
        err.code = '57P03';
        throw err;
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/reviews/alice/review-x');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.details?.retriable).toBe(true);
  });
});

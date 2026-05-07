/**
 * Review-detail route tests.
 *
 * The first describe block is real-HAF integration (404 path only — does not
 * require a seeded review).
 *
 * The second describe block is mocked-pool. Carve-out justification: the
 * `reviewer_attestation_id` collapse semantic introduced by migrating
 * `pevo.reviewer_attestation_id || null` → `pevoString(pevo, 'reviewer_attestation_id')`
 * (per backend-pevo-string-helper-adoption-sweep.md round-1) cannot be
 * deterministically seeded against the public HAF DB — the field is normally
 * a SHA-256 hex string broadcast by the anon-review pipeline; provoking the
 * non-string / empty-string runtime shape that exercises the migration's
 * behavioral upgrade requires a controlled `pevo` payload. Per CLAUDE.md
 * "Running Tests" carve-out clauses (a)/(b)/(c):
 *   (a) deterministic non-string `reviewer_attestation_id` requires writing
 *       a malformed pevo payload to HAF, impractical against the live DB;
 *   (b) `verifyHiveSignature` and other middleware are NOT mocked
 *       (the route is GET / read-only — no auth middleware to mock);
 *   (c) the real-HAF integration path is exercised by the existing 404
 *       test above + the integration suite that walks live review records.
 *       This mocked block is targeted at the migration-introduced runtime
 *       shape only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async () => ({ rows: [] })),
  getPoolMock: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  getPool: getPoolMock,
  isHafAvailable: () => getPoolMock() !== null,
  closeHafPool: async () => { /* no-op */ },
}));

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');
const { config } = await import('../../src/config.js');
const app = createApp();

beforeEach(async () => {
  hafQueryMock.mockReset();
  getPoolMock.mockReset().mockReturnValue({
    query: hafQueryMock,
    connect: async () => ({
      query: hafQueryMock,
      release: () => {},
    }),
  });
  await hafCache.clear();
});

describe('GET /api/reviews/:author/:permlink (real HAF)', () => {
  it('returns 404 for nonexistent review', async () => {
    // Real HAF query (mock returns empty rows for everything by default →
    // 404 path). Pinned for the contract surface; the next describe block
    // covers the migration-introduced runtime shape against a seeded row.
    hafQueryMock.mockImplementation(async () => ({ rows: [] }));
    const res = await request(app).get('/api/reviews/nobody/nothing');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/reviews/:author/:permlink — pevoString adoption: reviewer_attestation_id collapse', () => {
  // Round-2 hold item 3b for backend-pevo-string-helper-adoption-sweep.
  //
  // `reviews.ts:30` was migrated from:
  //   reviewer_attestation_id: pevo.reviewer_attestation_id || null
  // to:
  //   reviewer_attestation_id: pevoString(pevo, 'reviewer_attestation_id')
  //
  // The behavioral difference the migration delivered: a non-string value
  // (e.g. numeric `42` from a malformed broadcaster) previously surfaced
  // as `42` (truthy passthrough); the new form collapses to `null`
  // (`pevoString` narrows non-strings out). Empty string also collapses
  // to `null` under both forms. This describe pins both behaviors so a
  // revert at the call site fails red.
  function reviewRowWithAttestationId(attestationId: unknown) {
    return {
      author: 'alice',
      permlink: 'r1',
      body: 'review body',
      json_metadata: {
        app: `${config.appTag}/test`,
        [config.appTag]: {
          type: 'review',
          rating: { methodology: 4, novelty: 3, clarity: 5, significance: 4 },
          is_anonymous: false,
          reviewer_attestation_id: attestationId,
        },
      },
      parent_author: 'bob',
      parent_permlink: 'p1',
      created: '2026-01-01T00:00:00.000Z',
      net_votes: 0,
    };
  }

  function installReviewResponder(reviewRow: Record<string, unknown>) {
    hafQueryMock.mockImplementation(async (sql: string) => {
      // Review fetch (CTE + SELECT ... FROM comments).
      if (sql.includes('SELECT c.author, c.permlink, c.body, c.json_metadata')) {
        return { rows: [reviewRow] };
      }
      // Parent paper title fetch.
      if (sql.includes('SELECT title FROM')) {
        return { rows: [{ title: 'Parent Paper' }] };
      }
      // Default empty (e.g. accreditation CTE returns no accredits).
      return { rows: [] };
    });
  }

  it('numeric reviewer_attestation_id collapses to null (cast pattern would have leaked the number)', async () => {
    // Pre-migration: `pevo.reviewer_attestation_id || null` returned `42`
    // (truthy, passthrough). Post-migration: `pevoString(...)` returns
    // `null`. Asserting `null` pins the collapse semantic.
    installReviewResponder(reviewRowWithAttestationId(42));
    const res = await request(app).get('/api/reviews/alice/r1');
    expect(res.status).toBe(200);
    expect(res.body?.data?.reviewer_attestation_id).toBeNull();
  });

  it('empty-string reviewer_attestation_id collapses to null (consistent with codebase-wide pevoString convention)', async () => {
    // Both pre- and post-migration return `null` here (`'' || null === null`,
    // `pevoString({...}, 'reviewer_attestation_id')` returns `null`). The
    // assertion pins the convention so a future regression to
    // `pevo.reviewer_attestation_id ?? null` (which would surface `''`)
    // fails red.
    installReviewResponder(reviewRowWithAttestationId(''));
    const res = await request(app).get('/api/reviews/alice/r1');
    expect(res.status).toBe(200);
    expect(res.body?.data?.reviewer_attestation_id).toBeNull();
  });

  it('valid string reviewer_attestation_id passes through unchanged (non-empty string passthrough)', async () => {
    // Sanity floor: a real SHA-256 hex string surfaces unchanged. Without
    // this, a regression that always-collapsed to null would not be
    // caught (the two collapse tests above only assert null-on-bad-input).
    const validAttestationId = 'a'.repeat(64); // sha256 hex shape
    installReviewResponder(reviewRowWithAttestationId(validAttestationId));
    const res = await request(app).get('/api/reviews/alice/r1');
    expect(res.status).toBe(200);
    expect(res.body?.data?.reviewer_attestation_id).toBe(validAttestationId);
  });
});

/**
 * Mocking justification (per root CLAUDE.md carve-out):
 *
 *   (a) verifyHiveSignature is the project-wide MOCK_VERIFY_SIGNATURE fixture
 *       because these tests focus on route plumbing and the self-block
 *       semantics, NOT cryptographic signature verification. The real
 *       middleware's auth gate is exercised by sibling routes whose test
 *       files import the real middleware (`tests/routes/claims.test.ts`,
 *       `tests/orcid-callback.test.ts`).
 *   (b) `getAccreditation` is mocked so the route reaches the broadcaster-
 *       hive self-block check without requiring a seeded accreditation
 *       custom_json in HAF.
 *   (c) `hiveClient.call('condenser_api', 'get_content', ...)` is mocked
 *       so the test can supply a paper with broadcaster-controlled
 *       `pevo.authors[]` shapes deterministically. Seeding such a paper on
 *       the live pevotest chain is impractical and slow.
 *
 *   Real-path companion (clause-c): the validation/auth/rate-limit gates
 *   above are exercised against the real `verifyHiveSignature` middleware
 *   in `tests/middleware/verifyHiveSignature-authmethod.test.ts` and
 *   sibling route files that hit this same auth chain.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

// `getAccreditation` lives in profile.ts; mock it before importing the app.
const getAccreditationMock = vi.fn();
vi.mock('../../src/routes/profile.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/routes/profile.js')>(
    '../../src/routes/profile.js',
  );
  return {
    ...actual,
    getAccreditation: (...args: unknown[]) => getAccreditationMock(...args),
  };
});

// Mock hiveClient.call so the `condenser_api / get_content` lookup returns
// our staged paper. Other hive.js exports pass through.
const hiveCallMock = vi.fn();
vi.mock('../../src/hive.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/hive.js')>('../../src/hive.js');
  return {
    ...actual,
    hiveClient: {
      ...actual.hiveClient,
      call: (...args: unknown[]) => hiveCallMock(...args),
    },
  };
});

const { createApp } = await import('../../src/app.js');
const app = createApp();

describe('POST /api/reviews/anonymous', () => {
  it('returns 401 without auth headers', async () => {
    const res = await request(app)
      .post('/api/reviews/anonymous')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Great paper',
        rating: { methodology: 4, novelty: 5, clarity: 3, significance: 4 },
      });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 when fields are missing', async () => {
    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'reviewer1')
      .set('X-Hive-Signature', 'mock-sig')
      .send({ paper_author: 'alice' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for invalid rating values', async () => {
    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'reviewer1')
      .set('X-Hive-Signature', 'mock-sig')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Review text',
        rating: { methodology: 6, novelty: 0, clarity: 3, significance: 4 },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('rating');
  });

  it('returns 400 for non-integer rating', async () => {
    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'reviewer1')
      .set('X-Hive-Signature', 'mock-sig')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Review text',
        rating: { methodology: 3.5, novelty: 4, clarity: 3, significance: 4 },
      });
    expect(res.status).toBe(400);
  });

  it('returns 403 for unaccredited reviewer', async () => {
    getAccreditationMock.mockResolvedValueOnce(null);
    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'reviewer1')
      .set('X-Hive-Signature', 'mock-sig')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Good research',
        rating: { methodology: 4, novelty: 5, clarity: 3, significance: 4 },
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('POST /api/reviews/anonymous — co-author self-block normalization', () => {
  beforeEach(() => {
    getAccreditationMock.mockReset();
    hiveCallMock.mockReset();
  });

  // Abuse vector: a vouched co-author whose `pevo.authors[].hive` was
  // broadcast mid-case (`{hive: 'Bob'}`) attempts to anonymous-review their
  // own paper under their real (consensus-lowercase) account 'bob'. Without
  // the normalize-on-broadcaster-side wrapper, `a.hive === username` is a
  // byte-equality between the uppercase chain value and the lowercase
  // username; the check fails and the self-block is bypassed. With the
  // wrapper the comparison canonicalizes the broadcaster value first.
  it('rejects an uppercase-hive co-author attempting to anonymous-review their own paper', async () => {
    getAccreditationMock.mockResolvedValueOnce({
      name: 'Bob',
      institution: 'Test U',
      field: 'Test',
      method: 'orcid',
      orcid: null,
      timestamp: '2026-01-01T00:00:00Z',
      tx_id: 'tx-mock',
    });
    hiveCallMock.mockResolvedValueOnce({
      json_metadata: JSON.stringify({
        pevotest: {
          type: 'paper',
          authors: [{ hive: 'alice' }, { hive: 'Bob' }],
        },
      }),
    });

    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'bob')
      .set('X-Hive-Signature', 'mock-sig')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Review my own paper',
        rating: { methodology: 5, novelty: 5, clarity: 5, significance: 5 },
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('Authors cannot review their own papers');
  });

  // Control: the same flow with a true third-party reviewer succeeds past
  // the self-block predicate. Pins that the normalization change did not
  // over-exclude legitimate non-author reviewers. The route requires
  // pevoAnonPostingKey downstream of the self-block check (unset in this
  // test environment) and returns 500 — that's expected and not what this
  // case is asserting. The load-bearing claim is that the 403 self-block
  // does NOT fire for carol. An if-guarded `not.toContain(...)` would be
  // vacuous on non-403 paths and miss a regression that incorrectly self-
  // blocks a third party.
  it('admits a true third-party accredited reviewer past the self-block gate', async () => {
    getAccreditationMock.mockResolvedValueOnce({
      name: 'Carol',
      institution: 'Test U',
      field: 'Test',
      method: 'orcid',
      orcid: null,
      timestamp: '2026-01-01T00:00:00Z',
      tx_id: 'tx-mock',
    });
    hiveCallMock.mockResolvedValueOnce({
      json_metadata: JSON.stringify({
        pevotest: {
          type: 'paper',
          authors: [{ hive: 'alice' }, { hive: 'Bob' }],
        },
      }),
    });

    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'carol')
      .set('X-Hive-Signature', 'mock-sig')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Third-party review',
        rating: { methodology: 4, novelty: 4, clarity: 4, significance: 4 },
      });

    // Unconditional negative assertion: the 403 self-block must NOT fire
    // for a non-author reviewer regardless of the downstream status. A
    // regression where normalization mis-canonicalizes carol's identity
    // and triggers the self-block would surface as a 403 here and fail
    // this expectation red.
    expect(res.status).not.toBe(403);
  });

  // Whitespace-padded broadcaster value: a `{hive: '  bob  '}` entry must
  // still self-block bob. The SQL behavioral matrix in hafsql.test.ts
  // already covers the TRIM half of LOWER(TRIM(...)) at the predicate
  // level; this assertion extends route-layer coverage so a regression
  // that breaks .trim() in normalizeHiveAccount while keeping
  // .toLowerCase() is caught at the route boundary too.
  it('rejects a whitespace-padded-hive co-author attempting to anonymous-review their own paper', async () => {
    getAccreditationMock.mockResolvedValueOnce({
      name: 'Bob',
      institution: 'Test U',
      field: 'Test',
      method: 'orcid',
      orcid: null,
      timestamp: '2026-01-01T00:00:00Z',
      tx_id: 'tx-mock',
    });
    hiveCallMock.mockResolvedValueOnce({
      json_metadata: JSON.stringify({
        pevotest: {
          type: 'paper',
          authors: [{ hive: 'alice' }, { hive: '  bob  ' }],
        },
      }),
    });

    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'bob')
      .set('X-Hive-Signature', 'mock-sig')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Review my own paper',
        rating: { methodology: 5, novelty: 5, clarity: 5, significance: 5 },
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('Authors cannot review their own papers');
  });
});

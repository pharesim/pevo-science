/**
 * Route tests for `/api/ipfs/upload` durability semantics: the DB insert into
 * `pending_ipfs_uploads` is load-bearing for the 200 response. Two invariants
 * are pinned here:
 *
 *   1. If `getAppPool()` returns null (light dev config, app DB not
 *      configured), the route REFUSES to pin and returns 503 without ever
 *      calling the IPFS backend. Pinning without a row in
 *      `pending_ipfs_uploads` is undetectable orphan storage — the cleanup
 *      job's only enumeration source is that table — so the absence of
 *      durability is a hard refusal, not a degraded success.
 *
 *   2. If the DB insert throws between a successful pin and the response,
 *      the route compensates by calling unpin against the same backend that
 *      pinned, logs both errors, and returns 500. Otherwise the pin is live
 *      on Kubo / Pinata with no DB row — the cleanup job can never see it,
 *      and the disk leak is permanent.
 *
 * Justification for `vi.mock` (per root CLAUDE.md test carve-out, clauses
 * a/b/c):
 *
 *   (a) Real-path impracticality: driving a real Postgres insert failure
 *       mid-handler requires killing the connection between two SQL
 *       round-trips, which is racy with concurrent suite runs against the
 *       shared dev pool. The pin-then-DB-fail-then-unpin sequence is also
 *       the failure shape we most want pinned, and exercising it for real
 *       would burn a real Kubo pin per test run. Mocking `getAppPool()`'s
 *       `query` to reject deterministically is the only way to assert the
 *       compensation path's call shape (unpin URL, method, backend
 *       dispatch).
 *
 *   (b) `verifyHiveSignature` is bypassed via the shared
 *       `MOCK_VERIFY_SIGNATURE` fixture because the focus of these tests is
 *       the DB-durability state machine and the unpin-compensation call
 *       shape, NOT cryptographic verification. The fixture preserves the
 *       401-on-missing-header gate and the username-extraction behavior;
 *       only the signature check itself is bypassed. The real
 *       `verifyHiveSignature` middleware is exercised by the sibling
 *       `ipfs.test.ts` file's 401-without-auth-headers test against the
 *       same `/api/ipfs/upload` route.
 *
 *   (c) Real-path companion: `tests/routes/ipfs.test.ts` exercises the
 *       integrated /api/ipfs/upload route with real `verifyHiveSignature`,
 *       real `getAccreditation`, real `getAppPool`, and real config. The
 *       risk class this file covers (compensation call-shape under DB
 *       failure) is fundamentally a deterministic-fault-injection shape; a
 *       real-path companion that pins live blobs per test run is the
 *       wrong tool.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

// Treat the test user as accredited so the handler reaches the pin path.
vi.mock('../../src/routes/profile.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/routes/profile.js')>(
    '../../src/routes/profile.js',
  );
  return {
    ...actual,
    getAccreditation: vi.fn(async () => ({
      name: 'Test User',
      institution: 'Test University',
      field: 'physics',
      method: 'email',
      orcid: null,
      timestamp: 0,
      tx_id: null,
    })),
  };
});

// Per-test-controlled stub for the durable tracking pool. Tests reassign
// `appQueryMock` to inject success vs failure on the insert leg.
const appQueryMock = vi.fn();
let appPoolHandle: { query: typeof appQueryMock } | null = { query: appQueryMock };

vi.mock('../../src/app-db.js', () => ({
  getAppPool: () => appPoolHandle,
  initAppDb: vi.fn(async () => {}),
  closeAppPool: vi.fn(async () => {}),
}));

// Redis is best-effort below the DB write — return null so the redis branch
// is skipped without per-test churn.
vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn(async () => {}),
}));

const { createApp } = await import('../../src/app.js');

const app = createApp();

const PDF_BYTES = Buffer.from('%PDF-1.4 fake pin durability test content');
const FAKE_CID = 'QmTestCidDurabilityFixture000000000000000000000';
const FAKE_SIZE = PDF_BYTES.length;

interface FetchCall {
  url: string;
  method: string;
}

let fetchCalls: FetchCall[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  appQueryMock.mockReset();
  appPoolHandle = { query: appQueryMock };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubFetchForPinAndUnpin(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    fetchCalls.push({ url, method });

    // Kubo `add` returns ndjson-ish but a single object body is fine for the
    // route's `response.json()` call.
    if (url.includes('/api/v0/add')) {
      return new Response(JSON.stringify({ Hash: FAKE_CID, Size: String(FAKE_SIZE) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Kubo `pin/rm` returns 200 with an empty-ish body on success.
    if (url.includes('/api/v0/pin/rm')) {
      return new Response('{}', { status: 200 });
    }

    // Pinata pin / unpin (only hit if Pinata fallback path runs in another test).
    if (url.includes('pinata.cloud/pinning/pinFileToIPFS')) {
      return new Response(JSON.stringify({ IpfsHash: FAKE_CID, PinSize: FAKE_SIZE }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('pinata.cloud/pinning/unpin/')) {
      return new Response('OK', { status: 200 });
    }

    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  }) as typeof globalThis.fetch;
}

describe('POST /api/ipfs/upload — DB-durability refusal', () => {
  it('returns 503 without pinning when getAppPool() returns null', async () => {
    appPoolHandle = null;

    let pinCalled = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/v0/add') || url.includes('pinata.cloud/pinning/pinFileToIPFS')) {
        pinCalled = true;
      }
      throw new Error('fetch should not be reached when app DB is null');
    }) as typeof globalThis.fetch;

    const res = await request(app)
      .post('/api/ipfs/upload')
      .set('X-Hive-Username', 'testuser')
      .set('X-Hive-Signature', 'mock-sig')
      .attach('file', PDF_BYTES, {
        filename: 'durability.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(pinCalled).toBe(false);
    expect(appQueryMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/ipfs/upload — DB-insert compensation', () => {
  it('unpins from the same backend and returns 500 when DB insert fails after a successful pin', async () => {
    stubFetchForPinAndUnpin();

    // The insert is the load-bearing DB call — reject it to trip compensation.
    appQueryMock.mockRejectedValueOnce(new Error('connection terminated'));

    const res = await request(app)
      .post('/api/ipfs/upload')
      .set('X-Hive-Username', 'testuser')
      .set('X-Hive-Signature', 'mock-sig')
      .attach('file', PDF_BYTES, {
        filename: 'durability.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');

    // Pin happened, then unpin against the same backend (Kubo per default
    // dev config: IPFS_API_URL set, no Pinata keys).
    const pinFetches = fetchCalls.filter((c) => c.url.includes('/api/v0/add'));
    const unpinFetches = fetchCalls.filter((c) => c.url.includes('/api/v0/pin/rm'));
    expect(pinFetches).toHaveLength(1);
    expect(unpinFetches).toHaveLength(1);
    expect(unpinFetches[0].method).toBe('POST');
    expect(unpinFetches[0].url).toContain(`arg=${FAKE_CID}`);

    // The DB query was attempted exactly once (the failed insert); no retry,
    // no second write after compensation.
    expect(appQueryMock).toHaveBeenCalledTimes(1);
  });

  it('returns 200 and skips compensation on the happy path (DB insert succeeds)', async () => {
    stubFetchForPinAndUnpin();

    appQueryMock.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(app)
      .post('/api/ipfs/upload')
      .set('X-Hive-Username', 'testuser')
      .set('X-Hive-Signature', 'mock-sig')
      .attach('file', PDF_BYTES, {
        filename: 'durability.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.cid).toBe(FAKE_CID);

    // No unpin on the success path — the pin must remain live.
    const unpinFetches = fetchCalls.filter((c) => c.url.includes('/api/v0/pin/rm'));
    expect(unpinFetches).toHaveLength(0);
    expect(appQueryMock).toHaveBeenCalledTimes(1);
  });
});

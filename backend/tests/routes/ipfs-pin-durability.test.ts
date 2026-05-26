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
 *       only the signature check itself is bypassed. (The sibling
 *       `ipfs.test.ts` ALSO applies this fixture, so its 401-without-headers
 *       test fires from the missing-header gate, not real crypto — it is not
 *       the real-path companion.)
 *
 *   (c) Real-path companion: `tests/routes/ipfs-upload-real-path-
 *       verifyhivesignature.test.ts` exercises `/api/ipfs/upload` with the
 *       real `verifyHiveSignature` middleware — signature recovery, the
 *       posting-key compare, the timestamp-freshness window, the replay
 *       SETNX, and the missing/malformed-signature 401 gates all run against
 *       the production code path there. The risk class this file covers
 *       (compensation call-shape under a deterministic DB-insert fault) is a
 *       fault-injection shape; pinning live blobs per test run would be the
 *       wrong tool for it, which is why the durability state machine is
 *       exercised here with mocked infrastructure while the cryptographic
 *       verification is exercised in that real-path companion.
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
  verifyAppDbMigrations: vi.fn(async () => {}),
  closeAppPool: vi.fn(async () => {}),
}));

// Redis is best-effort below the DB write — return null so the redis branch
// is skipped without per-test churn.
vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn(async () => {}),
}));

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { logger } = await import('../../src/logger.js');

const app = createApp();

// Captured so the Pinata-dispatch spec can toggle config to the Pinata
// backend (empty ipfsApiUrl + populated Pinata keys) and afterEach restores
// the default Kubo config for the other specs.
const ORIG_IPFS_API_URL = config.ipfsApiUrl;
const ORIG_PINATA_API_KEY = config.pinataApiKey;
const ORIG_PINATA_SECRET_KEY = config.pinataSecretKey;

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
  config.ipfsApiUrl = ORIG_IPFS_API_URL;
  config.pinataApiKey = ORIG_PINATA_API_KEY;
  config.pinataSecretKey = ORIG_PINATA_SECRET_KEY;
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
  it('confirms row absence then unpins the same backend and returns 500 when DB insert fails after a successful pin', async () => {
    stubFetchForPinAndUnpin();

    // Insert (call 1) rejects to trip compensation; the row-absence re-check
    // (call 2) confirms no row landed, so releasing the pin is safe.
    appQueryMock.mockRejectedValueOnce(new Error('connection terminated'));
    appQueryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

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

    // Two queries: the failed insert, then the row-absence re-check. No third
    // write after compensation.
    expect(appQueryMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT unpin when the row-absence re-check finds a committed row (concurrent / unacked insert)', async () => {
    stubFetchForPinAndUnpin();

    // Insert (call 1) rejects, but the re-check (call 2) finds a row: a
    // concurrent upload of the same CID committed, or our own insert
    // committed server-side before the connection dropped on the ack. The
    // live pin backs that committed row's eventual reference — unpinning it
    // would be data loss, the inverse of the orphan this path guards.
    appQueryMock.mockRejectedValueOnce(new Error('connection terminated'));
    appQueryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: 1 }] });

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

    // The pin must survive — no unpin.
    const unpinFetches = fetchCalls.filter((c) => c.url.includes('/api/v0/pin/rm'));
    expect(unpinFetches).toHaveLength(0);
    expect(appQueryMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT unpin when the row-absence re-check itself fails (bias toward a tolerated orphan over data loss)', async () => {
    stubFetchForPinAndUnpin();

    // Both the insert (call 1) and the existence re-check (call 2) reject —
    // the DB is unreachable, so absence cannot be confirmed. A blind unpin
    // here risks destroying a pin a committed-but-unconfirmed row depends on,
    // so the handler skips compensation; the cleanup job remains the backstop
    // for a genuinely-unreferenced pin.
    appQueryMock.mockRejectedValueOnce(new Error('connection terminated'));
    appQueryMock.mockRejectedValueOnce(new Error('still unreachable'));

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

    const unpinFetches = fetchCalls.filter((c) => c.url.includes('/api/v0/pin/rm'));
    expect(unpinFetches).toHaveLength(0);
    expect(appQueryMock).toHaveBeenCalledTimes(2);
  });

  it('dispatches compensation unpin to Pinata when the pin originated on Pinata', async () => {
    // Drive the Pinata backend: empty Kubo URL routes pinToIpfs straight to
    // pinToPinata, so result.backend === 'pinata' and compensation must
    // dispatch to unpinFromPinata (DELETE pinata.cloud/pinning/unpin/<cid>),
    // never the Kubo pin/rm. This is the entire reason PinResult carries the
    // backend discriminator.
    config.ipfsApiUrl = '';
    config.pinataApiKey = 'test-pinata-key';
    config.pinataSecretKey = 'test-pinata-secret';
    stubFetchForPinAndUnpin();

    appQueryMock.mockRejectedValueOnce(new Error('connection terminated'));
    appQueryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

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

    const pinataPins = fetchCalls.filter((c) => c.url.includes('pinata.cloud/pinning/pinFileToIPFS'));
    const pinataUnpins = fetchCalls.filter((c) => c.url.includes('pinata.cloud/pinning/unpin/'));
    const kuboUnpins = fetchCalls.filter((c) => c.url.includes('/api/v0/pin/rm'));
    expect(pinataPins).toHaveLength(1);
    expect(pinataUnpins).toHaveLength(1);
    expect(pinataUnpins[0].method).toBe('DELETE');
    expect(pinataUnpins[0].url).toContain(FAKE_CID);
    expect(kuboUnpins).toHaveLength(0);
  });

  it('returns 500 and logs the orphan alarm when DB insert AND compensation unpin both fail', async () => {
    // Double failure: insert rejects, re-check confirms absence, unpin then
    // also fails. The handler must still return 500, fire BOTH error logs
    // (the insert-failure log and the orphan-alarm log), and surface no
    // unhandled rejection.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      fetchCalls.push({ url, method });
      if (url.includes('/api/v0/add')) {
        return new Response(JSON.stringify({ Hash: FAKE_CID, Size: String(FAKE_SIZE) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Compensation unpin fails with a non-benign error (not "not pinned").
      if (url.includes('/api/v0/pin/rm')) {
        return new Response('kubo daemon unreachable', { status: 500 });
      }
      throw new Error(`Unexpected fetch in test: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);

    appQueryMock.mockRejectedValueOnce(new Error('connection terminated'));
    appQueryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

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

    // Unpin was attempted (and failed).
    const unpinFetches = fetchCalls.filter((c) => c.url.includes('/api/v0/pin/rm'));
    expect(unpinFetches).toHaveLength(1);

    // Both error logs fired: the DB-insert-failure log and the orphan alarm.
    const messages = errorSpy.mock.calls.map((call) => String(call[call.length - 1]));
    expect(messages.some((m) => m.includes('checking row presence before compensating'))).toBe(true);
    expect(messages.some((m) => m.includes('orphan pin requires manual cleanup'))).toBe(true);
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

/**
 * BE-WOT-VOUCH-ROUTE-COVERAGE — route-level coverage for POST /api/wot/vouch
 * branching on the tagged-union `WotAccreditationResult` returned by
 * `broadcastWotAccreditation`. Sibling to `tests/wot-broadcast-timeout.test.ts`
 * (which covers the lib-level surface of `broadcastWotAccreditation` /
 * `cascadeRevocation`); this file covers the route-handler translation of
 * each tagged-union arm into the response shape, status code, and the
 * `logger.error` observability calls described by the architect's hold block
 * on BE-WOT-BROADCAST-TIMEOUT-HANDLING (P3b).
 *
 * Justification for mocking `broadcastWotAccreditation` and `getVouchStatus`
 * (per root CLAUDE.md "Running Tests" carve-out):
 *   - Real-HAF cannot induce broadcast `timeout` or `chain_error` per-test.
 *     The 30s `broadcastJsonWithTimeout` wrapper fires on a degraded Hive
 *     node, which is not reliably reproducible from an integration test.
 *     Lib-level tests in `tests/wot-broadcast-timeout.test.ts` exercise the
 *     timeout/chain_error/skipped/ok production at the function boundary;
 *     this file picks those tagged-union shapes up at the route layer and
 *     asserts the per-arm HTTP response + logger calls.
 *   - `getVouchStatus` is also mocked to keep the test deterministic — the
 *     real HAF query against pevotest scans the full custom_json table and
 *     can timeout. The shape we assert on is contract-stable and matches
 *     the live-HAF response covered by the auth-only happy-path tests in
 *     `tests/routes/wot.test.ts` (the "real HAF" sibling file).
 *   - `verifyHiveSignature` is NOT mocked. Auth uses the JWT Bearer token
 *     short-circuit in the real middleware (same pattern as
 *     `tests/routes/orcid.test.ts`). `getAppPool()` is mocked because the
 *     middleware's `sessions_invalidated_at` lookup hits the app DB on
 *     every JWT request; mocking the pool mirrors the existing convention
 *     in `orcid.test.ts` and `accreditations-revoke.test.ts`.
 *   - `getAccreditedSet` is mocked so the voucher-is-accredited gate at
 *     `wot.ts:57-60` lets the request through without seeding pevotest.
 *
 * Mutation-kill verification (performed 2026-04-28 against this file):
 *   - Deleted the entire `if (accreditResult.reason === 'timeout') { ... }`
 *     block at `backend/src/routes/wot.ts:79-95`. The "timeout arm" test
 *     fails red: response body falls through to the skipped-shape and the
 *     `accreditation_outcome === 'timeout'` assertion fires. Restored.
 *   - Deleted the entire `if (accreditResult.reason === 'chain_error') { ... }`
 *     block at `backend/src/routes/wot.ts:97-109`. The "chain_error arm"
 *     test fails red the same way. Restored.
 *   - Deleted just the `logger.error(...)` call inside each branch (without
 *     touching the response). The `expect(loggerErrorMock).toHaveBeenCalledWith(...)`
 *     assertion fires in both branch tests. Restored.
 * The four mutation-kill checks confirm both the response branching and
 * the observability calls are independently asserted.
 *
 * Sibling fixtures kept in mind:
 *   - `MOCK_VERIFY_SIGNATURE` in `tests/fixtures/mock-auth.ts` is the
 *     pre-SEC-002-BE pattern. We deliberately avoid it; SEC-002-BE
 *     established that `verifyHiveSignature` should be exercised for real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { appQueryMock, broadcastWotAccreditationMock, getVouchStatusMock, getAccreditedSetMock, loggerErrorMock, loggerInfoMock } =
  vi.hoisted(() => ({
    appQueryMock: vi.fn().mockResolvedValue({ rows: [] }),
    broadcastWotAccreditationMock: vi.fn(),
    getVouchStatusMock: vi.fn(),
    getAccreditedSetMock: vi.fn(),
    loggerErrorMock: vi.fn(),
    loggerInfoMock: vi.fn(),
  }));

// app-db pool: `verifyHiveSignature` queries `accounts.sessions_invalidated_at`
// on every JWT-authenticated request. Returning empty rows means the JWT is
// accepted as-is.
vi.mock('../../src/app-db.js', () => ({
  getAppPool: () => ({ query: appQueryMock }),
}));

// Voucher-accredited gate. Default to a Set containing the voucher so the
// request passes the gate; individual tests can override.
vi.mock('../../src/accreditation.js', () => ({
  getAccreditedSet: getAccreditedSetMock,
}));

// `wot.ts` exports a tagged-union producer (`broadcastWotAccreditation`),
// the vouch-status getter, and the cascade revocation primitives. We mock
// the two functions the vouch handler calls and re-export the rest from the
// real module so PartialCascadeError instanceof checks elsewhere still work.
vi.mock('../../src/wot.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/wot.js')>('../../src/wot.js');
  return {
    ...actual,
    broadcastWotAccreditation: broadcastWotAccreditationMock,
    getVouchStatus: getVouchStatusMock,
  };
});

// Logger mock — we assert on `.error` for the timeout + chain_error
// observability calls. Use importOriginal so other exports (httpLogger,
// genReqId) keep working; only override the `logger` object's `error` and
// `info` methods.
vi.mock('../../src/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/logger.js')>();
  return {
    ...actual,
    logger: {
      ...actual.logger,
      error: loggerErrorMock,
      info: loggerInfoMock,
    },
  };
});

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');

const app = createApp();

function jwtFor(username: string): string {
  return jwt.sign({ sub: username, custody: 'self' }, config.sessionSecret, { expiresIn: '1h' });
}

const VOUCHER = 'alice';
const VOUCHEE = 'bob';

const VOUCH_STATUS_FIXTURE = {
  username: VOUCHEE,
  vouch_count: 3,
  threshold: 3,
  is_accredited_via_wot: false,
  vouches: [],
};

beforeEach(() => {
  appQueryMock.mockReset().mockResolvedValue({ rows: [] });
  broadcastWotAccreditationMock.mockReset();
  getVouchStatusMock.mockReset().mockResolvedValue(VOUCH_STATUS_FIXTURE);
  getAccreditedSetMock.mockReset().mockResolvedValue(new Set([VOUCHER]));
  loggerErrorMock.mockReset();
  loggerInfoMock.mockReset();
});

describe('POST /api/wot/vouch — broadcastWotAccreditation tagged-union arms', () => {
  it('returns accredited:true + tx_id when the broadcast succeeds (ok arm)', async () => {
    broadcastWotAccreditationMock.mockResolvedValueOnce({ ok: true, txId: 'tx-happy-abc' });

    const res = await request(app)
      .post('/api/wot/vouch')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHEE });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data).toMatchObject({
      accredited: true,
      tx_id: 'tx-happy-abc',
    });
    expect(res.body.data.message).toContain('auto-accredited');
    // Happy path logs at info, not error.
    expect(loggerErrorMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalled();
  });

  it('returns accreditation_outcome:"timeout" + logger.error on the timeout arm', async () => {
    const timeoutErr = new Error('Hive broadcast timed out after 30000ms');
    timeoutErr.name = 'BroadcastTimeoutError';
    broadcastWotAccreditationMock.mockResolvedValueOnce({
      ok: false,
      reason: 'timeout',
      err: timeoutErr,
    });

    const res = await request(app)
      .post('/api/wot/vouch')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHEE });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data).toMatchObject({
      accredited: false,
      accreditation_outcome: 'timeout',
      tx_id: null,
    });
    expect(res.body.data.message).toContain('degraded state');

    // Mutation-kill: deleting the timeout-branch logger.error trips this.
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ err: timeoutErr, voucher: VOUCHER, vouchee: VOUCHEE }),
      expect.stringContaining('timed out'),
    );
  });

  it('returns accreditation_outcome:"chain_error" + logger.error on the chain_error arm', async () => {
    const chainErr = new Error('Invalid authority');
    broadcastWotAccreditationMock.mockResolvedValueOnce({
      ok: false,
      reason: 'chain_error',
      err: chainErr,
    });

    const res = await request(app)
      .post('/api/wot/vouch')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHEE });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data).toMatchObject({
      accredited: false,
      accreditation_outcome: 'chain_error',
      tx_id: null,
    });
    expect(res.body.data.message).toContain('failed');

    // Mutation-kill: deleting the chain_error-branch logger.error trips this.
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ err: chainErr, voucher: VOUCHER, vouchee: VOUCHEE }),
      expect.stringContaining('chain error'),
    );
  });

  it('returns the existing skipped-shape when broadcast is skipped (no logger.error)', async () => {
    broadcastWotAccreditationMock.mockResolvedValueOnce({ ok: false, reason: 'skipped' });
    // For the skipped path the response message uses the live vouch_count /
    // threshold; pin them to a non-eligible shape to exercise the "N/M" line.
    getVouchStatusMock.mockResolvedValueOnce({
      ...VOUCH_STATUS_FIXTURE,
      vouch_count: 1,
      threshold: 3,
    });

    const res = await request(app)
      .post('/api/wot/vouch')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHEE });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data).toMatchObject({
      accredited: false,
      tx_id: null,
    });
    // Skipped responses do NOT include `accreditation_outcome` — that field
    // only appears on the timeout / chain_error arms.
    expect(res.body.data).not.toHaveProperty('accreditation_outcome');
    expect(res.body.data.message).toContain('1/3 vouches');
    // Skipped is not an error condition — no logger.error.
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });
});

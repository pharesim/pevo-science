/**
 * BE-ACCRED-REVOKE-TEST — deterministic coverage for the revoke branch of
 * `fetchAccreditationStatusFromHaf` in `GET /api/accreditations/:username`.
 *
 * Justification for the mocked `getPool()` (per root CLAUDE.md carve-out):
 * the real-HAF variant of this test lives in `accreditations.test.ts` and
 * currently `skipIf`s chronically because no `pevotest` account has a
 * revoke as its latest authority-signed op. Seeding that against real HAF
 * would require broadcasting an `accredit` + a later `revoke` from an
 * authority account and waiting on HAF to index both; the seed-and-wait
 * loop is impractical per-test and leaves the revoke-branch mutation-kill
 * aspirational. Mocking the pool lets us inject the revoke row directly.
 * The real `verifyHiveSignature` path is not exercised here (endpoint is
 * unauthenticated); the real-HAF parity test in the sibling file covers
 * the happy path against actual chain data.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

const { hafQueryMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  getPool: () => ({ query: hafQueryMock }),
  isHafAvailable: () => true,
  closeHafPool: async () => {},
}));

vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

const { createApp } = await import('../../src/app.js');
const app = createApp();

describe('BE-ACCRED-REVOKE-TEST — GET /api/accreditations/:username revoke branch', () => {
  it('returns is_accredited:false + accreditation:null when latest op is revoke', async () => {
    // Use a unique username so the hafCache entry cannot collide with any
    // other test in the process.
    const revokedAccount = 'accreds-revoke-fixture-user';

    hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1")) {
        // The authority-filtered query returns a revoke as the latest row.
        // tx_id MUST be null per the route contract — callers distinguish
        // "never accredited" from "revoked" only via the full endpoint
        // response, not tx_id presence. Return null event_id to surface any
        // regression that leaks event_id on the revoke branch.
        expect(params[0]).toBe(revokedAccount);
        return {
          rows: [{
            json: {
              action: 'revoke',
              account: revokedAccount,
              timestamp: '2026-02-01T00:00:00.000Z',
            },
            event_id: null,
          }],
        };
      }
      return { rows: [] };
    });

    const res = await request(app).get(`/api/accreditations/${revokedAccount}`);
    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe(revokedAccount);
    expect(res.body.data.is_accredited).toBe(false);
    expect(res.body.data.accreditation).toBeNull();
    // tx_id is only projected on the accredit branch; assert the revoke
    // branch doesn't leak one.
    expect(res.body.data.accreditation).not.toMatchObject({ tx_id: expect.anything() });
  });
});

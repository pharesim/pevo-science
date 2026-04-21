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

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
const { hafCache } = await import('../../src/cache.js');
const app = createApp();

describe('BE-ACCRED-REVOKE-TEST — GET /api/accreditations/:username revoke branch', () => {
  beforeEach(async () => {
    // Defense-in-depth: the unique synthetic username below already avoids
    // cache collisions today, but clearing hafCache makes the test robust to
    // future refactors that change cache-key shape or introduce shared
    // fixtures across the file.
    await hafCache.clear();
  });

  it('returns is_accredited:false + accreditation:null when latest op is revoke', async () => {
    // Use a unique username so the hafCache entry cannot collide with any
    // other test in the process.
    const revokedAccount = 'accreds-revoke-fixture-user';

    hafQueryMock.mockImplementation(async (sql: string) => {
      // Multi-signal SQL detection (mirrors the SEC-003-BE round-2 pattern in
      // claims.test.ts:95). Requiring both the action-set predicate AND the
      // target relation prevents a silent bypass if a future refactor changes
      // quoting, extracts the action list into a constant, or relocates the
      // `'account' = $1` predicate into a subquery/JOIN. T.customJson resolves
      // to 'hafsql.operation_custom_json_view' (see backend/src/hafsql.ts:46);
      // if that mapping changes, this mock will fail loudly rather than
      // silently stop exercising the revoke branch.
      if (
        sql.includes("'action' IN ('accredit', 'revoke')") &&
        sql.includes('FROM hafsql.operation_custom_json_view')
      ) {
        // The authority-filtered query returns a revoke as the latest row.
        // tx_id MUST be null per the route contract — callers distinguish
        // "never accredited" from "revoked" only via the full endpoint
        // response, not tx_id presence. event_id is set to null here as
        // defensive signaling: the revoke branch (accreditations.ts:129-131)
        // has no projection path that reads event_id, so this does not
        // constitute active coverage. It documents the contract that the
        // revoke response intentionally discards event_id, and if a future
        // refactor starts projecting event_id onto the revoke response the
        // null here will propagate into the assertion below.
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
    // Call-shape assertion on the load-bearing HAF call: the authority-filtered
    // query fired against the correct relation AND with the username as $1.
    // If a future SQL refactor drops the FROM-signal (changes the relation) or
    // reshapes the `'account' = $1` predicate so the guard in the mock no
    // longer matches, the fallback path `{ rows: [] }` would otherwise leave
    // this test green on a regressed query because an empty result set is
    // indistinguishable from "never accredited". See
    // agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md.
    expect(hafQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('FROM hafsql.operation_custom_json_view'),
      expect.arrayContaining([revokedAccount]),
    );
  });
});

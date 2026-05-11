/**
 * SEC-AUTH-BYPASS — profile.ts parity regression.
 *
 * Asserts that `GET /api/profile/:username` filters accreditation rows by the
 * configured `accreditationAuthorities`, matching the behavior of
 * `GET /api/accreditations/:username` and `POST /api/orcid/callback`. Without
 * the filter, an attacker could broadcast a self-signed `accredit` custom_json
 * naming any victim and paint attacker-chosen name/institution/field/method
 * onto the victim's public profile page.
 *
 * Justification for the mocked `getPool()` (per root CLAUDE.md carve-out):
 * the attack shape requires HAF to index a specific custom_json signed by a
 * non-authority account. Seeding that against real HAF would require
 * broadcasting a pevotest custom_json from a fresh throw-away account and
 * waiting on indexing; the signing middleware + HAF latency make it
 * impractical per-test. Mocking the pool lets us deterministically assert:
 * (a) the query shape includes the authority filter,
 * (b) params[3] is `config.accreditationAuthorities`,
 * (c) when the filter yields zero rows, the response shows unaccredited.
 * The real `hiveClient.database.getAccounts` is mocked too (account-existence
 * check), but `verifyHiveSignature` is not touched (this endpoint is
 * unauthenticated).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock('../../src/db.js', () => ({
  getPool: () => ({ query: hafQueryMock }),
  isHafConfigured: () => true,
  closeHafPool: async () => { /* no-op */ },
}));

vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: {
      getAccounts: vi.fn().mockImplementation((names: string[]) =>
        Promise.resolve(names.map((name) => ({ name }))),
      ),
    },
  },
}));

vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

vi.mock('../../src/app-db.js', () => ({
  getAppPool: () => null,
}));

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');

const app = createApp();

beforeEach(() => {
  hafQueryMock.mockReset();
  hafQueryMock.mockResolvedValue({ rows: [] });
});

describe('SEC-AUTH-BYPASS — GET /api/profile/:username authority filter', () => {
  it('rejects a self-broadcast fake accredit (is_accredited:false, accreditation:null)', async () => {
    // Simulate the authority-filtered query returning zero rows. If the fix
    // is reverted, the query would return the attacker's self-broadcast row
    // and this test would fail because `is_accredited` would flip to true.
    //
    // Unique victim name per test so the hafCache doesn't carry state across
    // spec ordering.
    const victim = 'victim-auth-bypass-fake';
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1")) {
        // Filter yields zero rows because the self-broadcast op is signed by
        // the victim's own posting key, not an authority. Call-shape assertions
        // (authority filter present, params indexed correctly) live on the
        // caller below so they fire ONLY when a matching call actually
        // happened. See:
        // agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await request(app).get(`/api/profile/${victim}`);
    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe(victim);
    expect(res.body.data.is_accredited).toBe(false);
    expect(res.body.data.accreditation).toBeNull();
    // Assert the authority-filtered query actually fired with the load-bearing
    // SQL fragment + authority params. A SQL refactor that drops
    // `required_posting_auths ?| $4::text[]` or fails to pass
    // config.accreditationAuthorities as params[3] would no longer match this
    // call shape — the matcher fails even though the mock was called (the
    // fallback path returns { rows: [] } which would otherwise leave outer
    // assertions green on a regressed query).
    expect(hafQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('required_posting_auths ?| $4::text[]'),
      expect.arrayContaining([victim, config.accreditationAuthorities]),
    );
    // Positional pin on params[3]: arrayContaining is order-agnostic, so a
    // mutant that moves accreditationAuthorities from $4 to $2 would still
    // satisfy the matcher above. The `$4::text[]` bind MUST be the authorities
    // array; nothing else. Locate the authority-filtered call explicitly to
    // avoid coupling to call ordering (profile.ts may fire other queries
    // before it).
    const authorityCall = hafQueryMock.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        c[0].includes('required_posting_auths ?| $4::text[]'),
    );
    expect(authorityCall).toBeDefined();
    expect((authorityCall![1] as unknown[])[3]).toEqual(config.accreditationAuthorities);
  });

  it('accepts an authority-signed accredit (is_accredited:true, accreditation payload)', async () => {
    // Positive counterpart: when the authority-filtered query returns an
    // accredit row (as it would for a real authority-signed op), the profile
    // reports accredited + carries the payload fields.
    const accredited = 'victim-auth-bypass-real';
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1")) {
        return {
          rows: [{
            json: {
              action: 'accredit',
              name: 'Real Scientist',
              institution: 'MIT',
              field: 'Physics',
              method: 'email',
              orcid: '0000-0001-2222-3333',
              timestamp: '2026-01-01T00:00:00.000Z',
            },
            event_id: 42,
          }],
        };
      }
      // profile stats + reputation queries may also fire for accredited users.
      // Return empty rows for anything else — they're out of scope for this test.
      return { rows: [] };
    });

    const res = await request(app).get(`/api/profile/${accredited}`);
    expect(res.status).toBe(200);
    expect(res.body.data.is_accredited).toBe(true);
    expect(res.body.data.accreditation).toMatchObject({
      name: 'Real Scientist',
      institution: 'MIT',
      field: 'Physics',
      method: 'email',
      orcid: '0000-0001-2222-3333',
      tx_id: '42',
    });
    // Call-shape assertion: the authority-filtered query fired with the
    // load-bearing SQL fragment and authorities param. See
    // agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md.
    expect(hafQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('required_posting_auths ?| $4::text[]'),
      expect.arrayContaining([accredited, config.accreditationAuthorities]),
    );
    // Positional pin on params[3]. See the fake-accredit spec above for rationale.
    const authorityCall = hafQueryMock.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        c[0].includes('required_posting_auths ?| $4::text[]'),
    );
    expect(authorityCall).toBeDefined();
    expect((authorityCall![1] as unknown[])[3]).toEqual(config.accreditationAuthorities);
  });

  it('treats a revoke row as unaccredited (is_accredited:false, accreditation:null)', async () => {
    // Symmetric coverage for the revoke branch in getAccreditationFromHaf
    // (profile.ts:51). The authority-filtered query can legitimately return
    // `{action:'revoke', ...}` as the latest row when an authority later
    // revoked a prior accreditation. The handler must early-return null so
    // the profile reports unaccredited. Parallels the revoke-branch coverage
    // in accreditations-revoke.test.ts for the sibling endpoint.
    const revoked = 'victim-auth-bypass-revoked';
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1")) {
        return {
          rows: [{
            json: {
              action: 'revoke',
              account: revoked,
              reason: 'fraudulent',
              timestamp: '2026-02-01T00:00:00.000Z',
            },
            event_id: 99,
          }],
        };
      }
      return { rows: [] };
    });

    const res = await request(app).get(`/api/profile/${revoked}`);
    expect(res.status).toBe(200);
    expect(res.body.data.is_accredited).toBe(false);
    expect(res.body.data.accreditation).toBeNull();
    // Call-shape assertion: the authority-filtered query fired with the
    // load-bearing SQL fragment and authorities param. See
    // agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md.
    expect(hafQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('required_posting_auths ?| $4::text[]'),
      expect.arrayContaining([revoked, config.accreditationAuthorities]),
    );
    // Positional pin on params[3]. See the fake-accredit spec above for rationale.
    const authorityCall = hafQueryMock.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        c[0].includes('required_posting_auths ?| $4::text[]'),
    );
    expect(authorityCall).toBeDefined();
    expect((authorityCall![1] as unknown[])[3]).toEqual(config.accreditationAuthorities);
  });
});

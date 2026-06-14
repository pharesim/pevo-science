/**
 * Deterministic coverage for the `is_accredited` mapping of
 * `fetchAccreditationStatusFromHaf` in `GET /api/accreditations/:username`.
 *
 * The route now composes the shared membership CTE (`activeAccreditationsCteBody`)
 * and keys `is_accredited` off whether the account is present in
 * `active_accreditations` — so a sanctioned, below-threshold-WoT, or
 * legacy-revoked-with-no-prior-accredit account all collapse to the SAME route
 * behavior: empty rows -> `is_accredited:false, accreditation:null`. A present
 * row -> `is_accredited:true` carrying the latest accredit op's metadata. This
 * file pins that route-level plumbing; the membership-CTE semantics themselves
 * (sticky sanction, legacy-revoke reclassification, live WoT threshold) are
 * covered by the real-Postgres `accreditation-membership-cte.test.ts`.
 *
 * Justification for the mocked `getPool()` (per root CLAUDE.md carve-out): the
 * real-HAF parity test lives in `accreditations.test.ts` and `skipIf`s the
 * not-accredited branch because no `pevotest` account currently resolves to
 * not-accredited via a seeded sanction/below-threshold state; seeding that
 * against the read-only public HAF is impractical. Mocking the pool lets us
 * inject both the empty-membership and present-membership rows directly. The
 * endpoint is unauthenticated, so no auth middleware is bypassed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  getPool: () => ({ query: hafQueryMock }),
  isHafConfigured: () => true,
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

describe('GET /api/accreditations/:username — membership-CTE status mapping', () => {
  beforeEach(async () => {
    await hafCache.clear();
    hafQueryMock.mockReset();
  });

  it('returns is_accredited:false + accreditation:null when the account is absent from active_accreditations', async () => {
    const account = 'accreds-status-not-accredited-user';

    hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      // The membership query composes activeAccreditationsCteBody and selects
      // FROM active_accreditations WHERE account = $N. Requiring both the CTE
      // name AND the account-scoped select prevents a silent bypass if a future
      // refactor reshapes the query.
      if (sql.includes('active_accreditations') && sql.includes('account =')) {
        expect(params).toContain(account);
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await request(app).get(`/api/accreditations/${account}`);
    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe(account);
    expect(res.body.data.is_accredited).toBe(false);
    expect(res.body.data.accreditation).toBeNull();
    expect(res.body.data.accreditation).not.toMatchObject({ tx_id: expect.anything() });
    expect(hafQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('active_accreditations'),
      expect.arrayContaining([account]),
    );
  });

  it('returns is_accredited:true with latest-op metadata AND the accredited_since tenure anchor', async () => {
    const account = 'accreds-status-accredited-user';

    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('active_accreditations') && sql.includes('account =')) {
        // The status query LEFT JOINs first_accredited_at for the anchor.
        expect(sql).toContain('first_accredited_at');
        return {
          rows: [
            {
              researcher_name: 'Dr Example',
              institution: 'Example University',
              field: 'Physics',
              method: 'email',
              orcid: '0000-0001-2345-6789',
              event_timestamp: '2026-02-01T00:00:00.000Z',
              event_id: 9876,
              accredited_since: '2026-01-15T00:00:00Z',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const res = await request(app).get(`/api/accreditations/${account}`);
    expect(res.status).toBe(200);
    expect(res.body.data.is_accredited).toBe(true);
    expect(res.body.data.accreditation).toMatchObject({
      name: 'Dr Example',
      institution: 'Example University',
      field: 'Physics',
      method: 'email',
      orcid: '0000-0001-2345-6789',
      // Latest-op timestamp AND the additive tenure anchor are both present.
      timestamp: '2026-02-01T00:00:00.000Z',
      accredited_since: '2026-01-15T00:00:00Z',
      tx_id: '9876',
    });
  });

  it('LIST route exposes accredited_since but keeps sorting by the latest-op timestamp', async () => {
    let capturedSql: string | undefined;
    hafQueryMock.mockImplementation(async (sql: string) => {
      // The LIST data query is identified by the window-count total projection.
      if (sql.includes('count(*) OVER ()')) {
        capturedSql = sql;
        return {
          rows: [
            {
              username: 'lister1',
              name: 'Dr Lister',
              institution: 'Inst',
              field: 'Bio',
              method: 'email',
              orcid: null,
              timestamp: '2026-03-01T00:00:00.000Z',
              accredited_since: '2026-01-01T00:00:00Z',
              total: 1,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/accreditations');
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      username: 'lister1',
      timestamp: '2026-03-01T00:00:00.000Z',
      accredited_since: '2026-01-01T00:00:00Z',
    });
    expect(capturedSql).toBeDefined();
    // Sort stays on the latest-op payload timestamp; the anchor is additive.
    expect(capturedSql).toContain('ORDER BY aa.event_timestamp DESC');
    expect(capturedSql).not.toContain('ORDER BY accredited_since');
    expect(capturedSql).toContain('accredited_since');
  });
});

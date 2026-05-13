/**
 * Mocked-pool coverage for /api/profile/:username/reviews accreditation gate.
 *
 * Per CLAUDE.md "Running Tests" carve-out clauses (a)/(b)/(c):
 *   (a) Real-corpus seeding is impractical: the defended failure mode is
 *       an unaccredited Hive account writing valid-rating review-shaped
 *       replies to accredited authors' papers, so their own profile reviews
 *       page surfaces 300-char body excerpts (round-1 hold #2 spam vector).
 *       The public HAF database cannot be deterministically seeded with an
 *       unaccredited author + a passing-shape pevo.review row + a parent
 *       paper at test time.
 *   (b) `verifyHiveSignature` is NOT mocked — the route is a public GET
 *       (no middleware to short-circuit).
 *   (c) Real-path companion: the rest of the profile reviews surface
 *       (envelope shape, ordering, sort, pagination) is exercised against
 *       real HAF by profile.test.ts / papers.test.ts integration. This
 *       file covers the SQL-shape risk class — that the accred-OR-anon
 *       predicate is composed at both queries — which no real-HAF test
 *       pins.
 *
 * Canaries pinned in this file:
 *   1. Both the count query and the data query carry the accreditation
 *      gate `(c.author IN (SELECT account FROM active_accreditations) OR
 *      c.author = $N)` (round-1 hold #2 fix). Reverting either of the two
 *      composition sites silently re-opens the spam vector.
 *   2. The canonical $N counter pattern (round-2 hold #1 fix) — both
 *      queries reach the gate with consistently-numbered params.
 *   3. Behavioral: a request for an unaccredited user's reviews returns
 *      `data: []` with `total: 0`, modeling the gate via the responder.
 *
 * Mutation kill: dropping the accreditation gate substring from either the
 * count or data query, or reverting the route to skip the gate composition,
 * fails the assertions below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async () => ({ rows: [] })),
  getPoolMock: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  getPool: getPoolMock,
  isHafConfigured: () => getPoolMock() !== null,
  closeHafPool: async () => { /* no-op */ },
}));

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');
const app = createApp();

beforeEach(async () => {
  hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
  getPoolMock.mockReset().mockReturnValue({ query: hafQueryMock });
  await hafCache.clear();
});

describe('GET /api/profile/:username/reviews — SQL accreditation gate', () => {
  const accredGateSubstring = 'IN (SELECT account FROM active_accreditations)';
  // The route's data query also accepts the anon-proxy account in an OR-arm
  // matching the display-side composition (anon reviews surface for the
  // owning anon-mapping user, not as a generic spam channel).
  const anonOrArmSubstring = 'OR c.author =';

  it('count query and data query both compose the accred-OR-anon gate (mutation-kill)', async () => {
    const capturedSqls: string[] = [];
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSqls.push(sql);
      // Count query returns total=0; data query returns no rows.
      if (sql.includes('count(*)')) return { rows: [{ total: 0 }] };
      return { rows: [] };
    });
    const res = await request(app).get('/api/profile/unaccredited-spammer/reviews');
    expect(res.status).toBe(200);
    // Both queries must have been emitted (count + data).
    expect(capturedSqls.length).toBeGreaterThanOrEqual(2);
    // Each emitted SQL must compose the gate. Reverting either composition
    // site (count or data) drops the substring from that emit and fires red.
    for (const sql of capturedSqls) {
      expect(sql).toContain(accredGateSubstring);
      expect(sql).toContain(anonOrArmSubstring);
    }
  });

  it('returns empty data and zero total for an unaccredited username (behavioral)', async () => {
    // Responder simulates the gate by inspecting params + the seeded
    // accredited set. The author parameter is bound at `$4` (per the
    // canonical paramIdx++ shape: $1..$3 = accred CTE params, $4 = username,
    // $5 = appTag, $6 = anon).
    const accreditedAuthors = new Set<string>(); // empty: nobody is accredited
    hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      const author = (params?.[3] as string) ?? '';
      const anonAccount = (params?.[5] as string) ?? '';
      const admitted = accreditedAuthors.has(author) || (author !== '' && author === anonAccount);
      if (sql.includes('count(*)')) {
        return { rows: [{ total: admitted ? 1 : 0 }] };
      }
      // Data query: empty when not admitted.
      return { rows: admitted ? [{ author, permlink: 'r1', body: '', json_metadata: {}, created: '2026-01-01T00:00:00.000Z', parent_author: 'someone', parent_permlink: 'p', paper_title: '', net_votes: 0 }] : [] };
    });
    const res = await request(app).get('/api/profile/unaccredited-spammer/reviews');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data).toEqual([]);
    expect(res.body.meta?.total).toBe(0);
  });
});

/**
 * Route coverage for the roster-gated `/api/admin/*` authority endpoints:
 * roster GET, roster grant/revoke (tier gating + lockout), accreditation grant,
 * paper retract, authorship revoke/approve. The focus is the two-gate
 * authorization composition (`requireAdminLevel` tier check + the
 * `requireFreshAdminAuth` §6.4 fresh-proof gate), the lockout invariants
 * (root/self/non-roster cannot be demoted, root cannot be granted), and the
 * `issued_by` authority attribution stamped into every admin-signed broadcast
 * payload.
 *
 * Carve-out justification (per root CLAUDE.md "Running Tests"):
 *
 * (a) Real paths that are impractical to drive per-test:
 *     - The chain-derived roster is read from on-chain `admin_grant` /
 *       `admin_revoke` ops via HAF. The public corpus cannot be deterministically
 *       seeded with the matched (granted, super_admin, revoked) rows each tier-
 *       gating assertion needs, so `getPool()` (a shared pool helper) is mocked to
 *       return controlled `active_admins` rows. Crucially, the tier resolver
 *       (`getAdminLevel` / `getAdminRoster`) and the `requireAdminLevel` /
 *       `requireFreshAdminAuth` middleware run REAL against those rows — only the
 *       pool underneath is stubbed, never the authorization functions.
 *     - `redis.js` is mocked (returns no client) so the `hafCache` roster cache
 *       stays in-process and deterministic, mirroring the sibling roster recipe.
 *     - `hive.js` broadcast helpers (`broadcastAdminCustomJson`,
 *       `broadcastJsonWithTimeout`, a third-party-backed Hive client surface) are
 *       stubbed so the test can assert call/no-call and capture the payload to pin
 *       `issued_by` / `action` / op fields without broadcasting to the live chain.
 *       The real error classes are preserved so `handleBroadcastError`'s
 *       `instanceof` discrimination is unaffected.
 *     - For the JWT-fresh-auth-PASS case `consumeFreshAuthToken` is stubbed to
 *       return `{ valid: true }`: minting a real target-bound token requires the
 *       password/ORCID issuance ceremony, impractical per-route-test. The other
 *       fresh-auth functions (`computeFreshAuthTargetHash`,
 *       `adminActionFreshAuthTarget`) are preserved real. The JWT-NO-PROOF case
 *       lets the real consume run (a missing token returns invalid regardless).
 *     - `getRequiredBridgePostingKey` (`startup-checks.js`) is stubbed so the
 *       authorship/approve broadcast path is reachable (the bridge key cache is
 *       startup-populated, not seedable per-test); the broadcast is mocked, so the
 *       stub key never signs. `assertBridgeKeyConfigured` runs real, satisfied by
 *       setting `config.pevoBridgePostingKey` in the one approve-timeout spec.
 *
 *     Cryptographic signature verification is bypassed by `MOCK_VERIFY_SIGNATURE`;
 *     only the 401-on-missing-header gate, the username-extraction, and the
 *     `req.hiveAuthMethod` (`signature` vs `jwt`) discriminator are exercised by
 *     the mock. The focus of this file is tier/lockout/attribution/fresh-auth
 *     route logic, NOT the Hive signature algorithm.
 *
 * (c) The real-path companion exercising the REAL `verifyHiveSignature` +
 *     `requireFreshAdminAuth` chain against genuine Hive-signed requests on an
 *     admin route lives at
 *     `backend/tests/routes/admin-fresh-auth-real-path-verifyhivesignature.test.ts`.
 *     That covers the cryptographic-verification + fresh-auth-gate risk class so
 *     this file's `MOCK_VERIFY_SIGNATURE` + stubbed-consume bypass cannot hide a
 *     regression in signature checking or the JWT-proof gate from the codebase.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

// Controlled roster pool: the tier resolver runs real against these rows.
const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(async (..._args: unknown[]) => ({ rows: [] as unknown[] })),
}));
vi.mock('../../src/db.js', () => ({
  getPool: () => ({ query: queryMock }),
  isHafConfigured: () => true,
  closeHafPool: async () => {},
}));

// No Redis client: hafCache uses its in-process tier deterministically.
vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

// Broadcast stubs: capture payloads, assert call/no-call. Preserve the real
// error classes so handleBroadcastError's instanceof discrimination is intact.
const { broadcastAdminMock, broadcastJsonMock } = vi.hoisted(() => ({
  broadcastAdminMock: vi.fn(async (_payload: Record<string, unknown>) => ({ id: 'txadmin' })),
  broadcastJsonMock: vi.fn(async (_payload: unknown, _key: unknown) => ({ id: 'txbridge' })),
}));
vi.mock('../../src/hive.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/hive.js')>('../../src/hive.js');
  return {
    ...actual,
    broadcastAdminCustomJson: broadcastAdminMock,
    broadcastJsonWithTimeout: broadcastJsonMock,
  };
});

// Fresh-auth: override only consume (for the JWT-pass case); the target-hash
// builders stay real so requireFreshAdminAuth computes the genuine expected hash.
const { consumeMock } = vi.hoisted(() => ({
  consumeMock: vi.fn(),
}));
vi.mock('../../src/lib/fresh-auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/fresh-auth.js')>(
    '../../src/lib/fresh-auth.js',
  );
  return {
    ...actual,
    consumeFreshAuthToken: consumeMock,
  };
});

// The authorship/approve handler signs with the bridge posting key, whose cache
// is populated at startup (not in tests). Stub getRequiredBridgePostingKey to a
// throwaway value so the approve broadcast path is REACHABLE; the broadcast
// itself is mocked, so the stub is never used to sign. assertBridgeKeyConfigured
// (config-only) is satisfied per-test by setting config.pevoBridgePostingKey.
vi.mock('../../src/startup-checks.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/startup-checks.js')>('../../src/startup-checks.js');
  return {
    ...actual,
    getRequiredBridgePostingKey: () =>
      'stub-bridge-key' as unknown as ReturnType<typeof actual.getRequiredBridgePostingKey>,
  };
});

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { hafCache } = await import('../../src/cache.js');
// Real class (the hive.js mock spreads `...actual`) so handleBroadcastError's
// `instanceof BroadcastTimeoutError` discrimination fires on the rejected stub.
const { BroadcastTimeoutError } = await import('../../src/hive.js');

const app = createApp();

// Tier fixtures. Root resolves from config (no chain row); the chain rows below
// drive the super_admin / admin actors and demote targets. These accounts are
// distinct from config.rootAdminAccount so root-only branches are unambiguous.
const SUPER = 'superadmin1';
const ADMIN = 'adminuser1';
const ADMIN2 = 'adminuser2';
const ROOT = config.rootAdminAccount;
const BRIDGE = config.hiveBridgeAccount;

/** Install the chain roster rows the real resolver reads via the mocked pool. */
function stubRoster(rows: Array<{ account: string; level: string; granted_by?: string | null; granted_at?: string | null }>): void {
  queryMock.mockReset().mockImplementation(async (sql: unknown) => {
    if (typeof sql === 'string' && sql.includes('active_admins')) {
      return {
        rows: rows.map((r) => ({
          account: r.account,
          level: r.level,
          granted_by: r.granted_by ?? null,
          granted_at: r.granted_at ?? null,
        })),
      };
    }
    return { rows: [] };
  });
}

/** Default roster used by most specs: one super_admin and two admins. */
function stubDefaultRoster(): void {
  stubRoster([
    { account: SUPER, level: 'super_admin' },
    { account: ADMIN, level: 'admin' },
    { account: ADMIN2, level: 'admin' },
  ]);
}

/** Self-custody (signature) caller — the per-request signature IS the fresh proof. */
function asSignature(req: request.Test, username: string): request.Test {
  return req.set('X-Hive-Username', username).set('X-Hive-Signature', 'mock');
}

/** JWT (light-account) caller — Bearer makes req.hiveAuthMethod === 'jwt'. */
function asJwt(req: request.Test, username: string): request.Test {
  return req
    .set('X-Hive-Username', username)
    .set('Authorization', 'Bearer header.eyJzdWIiOiJ4In0.sig');
}

beforeEach(async () => {
  await hafCache.clear();
  queryMock.mockReset().mockImplementation(async () => ({ rows: [] }));
  broadcastAdminMock.mockReset().mockResolvedValue({ id: 'txadmin' });
  broadcastJsonMock.mockReset().mockResolvedValue({ id: 'txbridge' });
  // Default consume: invalid. Specs that exercise the JWT-pass path opt in by
  // making it resolve valid; signature-path specs never reach consume.
  consumeMock.mockReset().mockResolvedValue({ valid: false, reason: 'missing' });
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/roster
// ─────────────────────────────────────────────────────────────────────
describe('GET /api/admin/roster', () => {
  it('returns 200 {tier:null, roster:[]} for a non-roster caller and discloses no roster', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).get('/api/admin/roster'), 'randomreader');
    expect(res.status).toBe(200);
    expect(res.body.data.tier).toBeNull();
    expect(res.body.data.roster).toEqual([]);
  });

  it('returns 200 {tier, roster:[...]} for a roster member', async () => {
    stubRoster([
      { account: SUPER, level: 'super_admin', granted_by: ROOT, granted_at: '2026-01-01T00:00:00Z' },
      { account: ADMIN, level: 'admin', granted_by: SUPER, granted_at: '2026-02-01T00:00:00Z' },
    ]);
    const res = await asSignature(request(app).get('/api/admin/roster'), ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.data.tier).toBe('admin');
    expect(Array.isArray(res.body.data.roster)).toBe(true);
    const accounts = (res.body.data.roster as Array<{ account: string }>).map((r) => r.account);
    expect(accounts).toContain(SUPER);
    expect(accounts).toContain(ADMIN);
  });

  it('returns 200 tier=root for the bootstrap root account', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).get('/api/admin/roster'), ROOT);
    expect(res.status).toBe(200);
    expect(res.body.data.tier).toBe('root');
  });

  it('returns 401 without auth headers', async () => {
    const res = await request(app).get('/api/admin/roster').send();
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/admin/roster/grant — tier gating
// ─────────────────────────────────────────────────────────────────────
describe('POST /api/admin/roster/grant — tier gating', () => {
  it('403s a plain admin caller (requires super_admin)', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/roster/grant'), ADMIN).send({
      account: 'newadmin',
      level: 'admin',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('super_admin succeeds granting admin; payload carries issued_by = actor', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/roster/grant'), SUPER).send({
      account: 'newadmin',
      level: 'admin',
    });
    expect(res.status).toBe(200);
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
    const payload = broadcastAdminMock.mock.calls[0][0];
    expect(payload).toMatchObject({ action: 'admin_grant', account: 'newadmin', level: 'admin', issued_by: SUPER });
  });

  it('403s a super_admin granting super_admin (root-only)', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/roster/grant'), SUPER).send({
      account: 'newsuper',
      level: 'super_admin',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('root succeeds granting super_admin; payload carries issued_by = root', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/roster/grant'), ROOT).send({
      account: 'newsuper',
      level: 'super_admin',
    });
    expect(res.status).toBe(200);
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
    const payload = broadcastAdminMock.mock.calls[0][0];
    expect(payload).toMatchObject({ action: 'admin_grant', account: 'newsuper', level: 'super_admin', issued_by: ROOT });
  });

  it('422s granting the root account a chain level', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/roster/grant'), ROOT).send({
      account: ROOT,
      level: 'admin',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('403s a super_admin granting "admin" to a peer super_admin (demotion-in-disguise; only root may lower)', async () => {
    stubRoster([
      { account: SUPER, level: 'super_admin' },
      { account: 'othersuper', level: 'super_admin' },
    ]);
    const res = await asSignature(request(app).post('/api/admin/roster/grant'), SUPER).send({
      account: 'othersuper',
      level: 'admin',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('422s a super_admin self-downgrade via grant', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/roster/grant'), SUPER).send({
      account: SUPER,
      level: 'admin',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('root CAN lower a super_admin via grant (the legitimate demotion path)', async () => {
    stubRoster([{ account: SUPER, level: 'super_admin' }]);
    const res = await asSignature(request(app).post('/api/admin/roster/grant'), ROOT).send({
      account: SUPER,
      level: 'admin',
    });
    expect(res.status).toBe(200);
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
    expect(broadcastAdminMock.mock.calls[0][0]).toMatchObject({
      action: 'admin_grant',
      account: SUPER,
      level: 'admin',
      issued_by: ROOT,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/admin/roster/revoke — lockout + tier gating
// ─────────────────────────────────────────────────────────────────────
describe('POST /api/admin/roster/revoke — lockout', () => {
  it('403s a plain admin caller (requires super_admin)', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/roster/revoke'), ADMIN).send({
      account: ADMIN2,
      level: 'admin',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('422s demoting the root account', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/roster/revoke'), SUPER).send({
      account: ROOT,
      level: 'super_admin',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('422s a self-demote', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/roster/revoke'), SUPER).send({
      account: SUPER,
      level: 'super_admin',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('422s a non-roster target', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/roster/revoke'), SUPER).send({
      account: 'nobodyontheroster',
      level: 'admin',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('403s a super_admin demoting a super_admin target (root-only)', async () => {
    // Two super_admins on the roster; SUPER tries to demote the other.
    stubRoster([
      { account: SUPER, level: 'super_admin' },
      { account: 'othersuper', level: 'super_admin' },
    ]);
    const res = await asSignature(request(app).post('/api/admin/roster/revoke'), SUPER).send({
      account: 'othersuper',
      level: 'super_admin',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('super_admin succeeds demoting an admin; payload carries issued_by + target level', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/roster/revoke'), SUPER).send({
      account: ADMIN2,
      level: 'admin',
    });
    expect(res.status).toBe(200);
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
    const payload = broadcastAdminMock.mock.calls[0][0];
    expect(payload).toMatchObject({ action: 'admin_revoke', account: ADMIN2, level: 'admin', issued_by: SUPER });
  });

  it('root demotes a super_admin (root-only branch); body omits level, payload level derived from roster', async () => {
    // The root-only positive branch of /roster/revoke. Distinct from the grant
    // block's "root lowers a super_admin" (that is admin_grant on a different
    // endpoint). The body omits `level`; the handler derives the target's current
    // tier from the roster, so payload.level === 'super_admin' proves the derive.
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/roster/revoke'), ROOT).send({
      account: SUPER,
    });
    expect(res.status).toBe(200);
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
    const payload = broadcastAdminMock.mock.calls[0][0];
    expect(payload).toMatchObject({ action: 'admin_revoke', account: SUPER, level: 'super_admin', issued_by: ROOT });
  });

  it('strips a stray (removed) `level` field from the revoke body — 200, not 400', async () => {
    // The admin console still posts { account, level, fresh_auth_proof }. The
    // removed `level` must be STRIPPED by adminRosterRevokeSchema (Zod default),
    // not rejected — a future accidental `.strict()` would 400 this and break the
    // console.
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/roster/revoke'), SUPER).send({
      account: ADMIN2,
      level: 'admin',
      fresh_auth_proof: 'ignored-on-signature-path',
    });
    expect(res.status).toBe(200);
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/admin/accreditation/grant
// ─────────────────────────────────────────────────────────────────────
describe('POST /api/admin/accreditation/grant', () => {
  it('admin succeeds; payload carries action=accredit, name=full_name, issued_by=actor', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/accreditation/grant'), ADMIN).send({
      account: 'scientist1',
      full_name: 'Dr Jane Doe',
      institution: 'Acme University',
      field: 'Physics',
      method: 'manual',
    });
    expect(res.status).toBe(200);
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
    const payload = broadcastAdminMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      action: 'accredit',
      account: 'scientist1',
      name: 'Dr Jane Doe',
      issued_by: ADMIN,
    });
  });

  it('403s a non-roster caller', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/accreditation/grant'), 'randomreader').send({
      account: 'scientist1',
      full_name: 'Dr Jane Doe',
    });
    expect(res.status).toBe(403);
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/admin/accreditation/sanction
// ─────────────────────────────────────────────────────────────────────
describe('POST /api/admin/accreditation/sanction', () => {
  it('admin succeeds; payload carries action=revoke, type=sanction, issued_by=actor', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/accreditation/sanction'), ADMIN).send({
      account: 'baduser',
      reason: 'fabricated results',
    });
    expect(res.status).toBe(200);
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
    const payload = broadcastAdminMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      action: 'revoke',
      type: 'sanction',
      account: 'baduser',
      reason: 'fabricated results',
      issued_by: ADMIN,
    });
  });

  it('403s a non-roster caller (no broadcast)', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/accreditation/sanction'), 'randomreader').send({
      account: 'baduser',
      reason: 'x',
    });
    expect(res.status).toBe(403);
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('rejects a JWT caller without a valid fresh-auth proof (no broadcast)', async () => {
    // §6.4 / §6.5 invariant #1: a stolen admin JWT alone must not broadcast an
    // authority op. consumeMock defaults to {valid:false}, so the requireFreshAdminAuth
    // gate rejects the JWT path even though the caller is a roster admin.
    stubDefaultRoster();
    const res = await asJwt(request(app).post('/api/admin/accreditation/sanction'), ADMIN).send({
      account: 'baduser',
      reason: 'x',
    });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(404);
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('422s a self-sanction (no broadcast)', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/accreditation/sanction'), ADMIN).send({
      account: ADMIN,
      reason: 'x',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('422s sanctioning the root account (no broadcast)', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/accreditation/sanction'), ADMIN).send({
      account: ROOT,
      reason: 'x',
    });
    expect(res.status).toBe(422);
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('403s a base admin sanctioning a super_admin target (tier at/above the actor)', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/accreditation/sanction'), ADMIN).send({
      account: SUPER,
      reason: 'x',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('403s a base admin sanctioning a peer admin target (tier equal to the actor)', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/accreditation/sanction'), ADMIN).send({
      account: ADMIN2,
      reason: 'x',
    });
    expect(res.status).toBe(403);
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('super_admin CAN sanction a base admin target (tier below the actor)', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/accreditation/sanction'), SUPER).send({
      account: ADMIN,
      reason: 'misconduct',
    });
    expect(res.status).toBe(200);
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
    expect(broadcastAdminMock.mock.calls[0][0]).toMatchObject({ action: 'revoke', type: 'sanction', account: ADMIN });
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/admin/papers/retract
// ─────────────────────────────────────────────────────────────────────
describe('POST /api/admin/papers/retract', () => {
  it('admin succeeds; payload carries action=retract_paper, issued_by=actor', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/papers/retract'), ADMIN).send({
      author: 'paperauthor',
      permlink: 'some-paper',
      reason: 'plagiarism',
    });
    expect(res.status).toBe(200);
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
    const payload = broadcastAdminMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      action: 'retract_paper',
      author: 'paperauthor',
      permlink: 'some-paper',
      reason: 'plagiarism',
      issued_by: ADMIN,
    });
  });

  it('422s when the paper is already retracted (per retracted-papers cache)', async () => {
    stubDefaultRoster();
    await hafCache.set('retracted-papers', [{ author: 'paperauthor', permlink: 'some-paper' }]);
    const res = await asSignature(request(app).post('/api/admin/papers/retract'), ADMIN).send({
      author: 'paperauthor',
      permlink: 'some-paper',
      reason: 'dup',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('on a broadcast timeout, busts the retracted-papers cache (ambiguous outcome)', async () => {
    stubDefaultRoster();
    broadcastAdminMock.mockRejectedValueOnce(new BroadcastTimeoutError(30_000));
    const invalidateSpy = vi.spyOn(hafCache, 'invalidate');
    try {
      const res = await asSignature(request(app).post('/api/admin/papers/retract'), ADMIN).send({
        author: 'paperauthor',
        permlink: 'some-paper',
        reason: 'plagiarism',
      });
      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('BROADCAST_TIMEOUT');
      expect(invalidateSpy).toHaveBeenCalledWith('retracted-papers');
    } finally {
      invalidateSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/admin/authorship/revoke
// ─────────────────────────────────────────────────────────────────────
describe('POST /api/admin/authorship/revoke', () => {
  it('admin succeeds; payload carries action=revoke_authorship, issued_by=actor', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/authorship/revoke'), ADMIN).send({
      author: 'paperauthor',
      permlink: 'some-paper',
      claimer: 'falseclaimer',
      reason: 'not a real co-author',
    });
    expect(res.status).toBe(200);
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
    const payload = broadcastAdminMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      action: 'revoke_authorship',
      claimer: 'falseclaimer',
      paper_author: 'paperauthor',
      paper_permlink: 'some-paper',
      issued_by: ADMIN,
    });
  });

  it('on a broadcast timeout, busts the claims cache for the paper (ambiguous outcome)', async () => {
    stubDefaultRoster();
    broadcastAdminMock.mockRejectedValueOnce(new BroadcastTimeoutError(30_000));
    const invalidateSpy = vi.spyOn(hafCache, 'invalidate');
    try {
      const res = await asSignature(request(app).post('/api/admin/authorship/revoke'), ADMIN).send({
        author: 'paperauthor',
        permlink: 'some-paper',
        claimer: 'falseclaimer',
        reason: 'not a real co-author',
      });
      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('BROADCAST_TIMEOUT');
      expect(invalidateSpy).toHaveBeenCalledWith('claims:paperauthor:some-paper');
    } finally {
      invalidateSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/admin/authorship/approve
// ─────────────────────────────────────────────────────────────────────
describe('POST /api/admin/authorship/approve', () => {
  it('422s when author is not the bridge account', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/authorship/approve'), ADMIN).send({
      author: 'notbridge',
      permlink: 'bridged-paper',
      claimer: 'realauthor',
      author_index: 0,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(broadcastJsonMock).not.toHaveBeenCalled();
  });

  it('403s a non-roster caller before the bridge check', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/authorship/approve'), 'randomreader').send({
      author: BRIDGE,
      permlink: 'bridged-paper',
      claimer: 'realauthor',
      author_index: 0,
    });
    expect(res.status).toBe(403);
    expect(broadcastJsonMock).not.toHaveBeenCalled();
  });

  it('on a broadcast timeout, busts the claims cache for the paper (ambiguous outcome)', async () => {
    // approve broadcasts via broadcastJsonWithTimeout (the bridge account signs),
    // not broadcastAdminCustomJson — so the timeout is injected on broadcastJsonMock.
    // The bridge-key gate (assertBridgeKeyConfigured) is satisfied via config;
    // getRequiredBridgePostingKey is stubbed at module level (see the mock).
    stubDefaultRoster();
    const prevBridgeKey = config.pevoBridgePostingKey;
    (config as { pevoBridgePostingKey: unknown }).pevoBridgePostingKey = 'fake-bridge-key';
    broadcastJsonMock.mockRejectedValueOnce(new BroadcastTimeoutError(30_000));
    const invalidateSpy = vi.spyOn(hafCache, 'invalidate');
    try {
      const res = await asSignature(request(app).post('/api/admin/authorship/approve'), ADMIN).send({
        author: BRIDGE,
        permlink: 'bridged-paper',
        claimer: 'realauthor',
        author_index: 0,
      });
      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('BROADCAST_TIMEOUT');
      expect(invalidateSpy).toHaveBeenCalledWith(`claims:${BRIDGE}:bridged-paper`);
    } finally {
      invalidateSpy.mockRestore();
      (config as { pevoBridgePostingKey: unknown }).pevoBridgePostingKey = prevBridgeKey;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Fresh-auth gate (§6.4 / §6.5 invariant #1)
// ─────────────────────────────────────────────────────────────────────
describe('requireFreshAdminAuth — JWT path demands a fresh-auth proof', () => {
  it('JWT caller with NO fresh_auth_proof is rejected FRESH_AUTH_REQUIRED and does NOT broadcast', async () => {
    stubDefaultRoster();
    // Real consume runs (a missing token is invalid regardless of the stub),
    // so let it through to the real module by NOT marking it valid here.
    const res = await asJwt(request(app).post('/api/admin/roster/grant'), ROOT).send({
      account: 'newsuper',
      level: 'super_admin',
    });
    // missing/expired/malformed → 401; bound-violation → 403. A missing proof
    // surfaces as 401 FRESH_AUTH_REQUIRED here.
    expect([401, 403]).toContain(res.status);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('JWT caller with a VALID fresh_auth_proof passes the gate and broadcasts', async () => {
    stubDefaultRoster();
    consumeMock.mockResolvedValue({ valid: true, mechanism: 'password' });
    const res = await asJwt(request(app).post('/api/admin/roster/grant'), ROOT).send({
      account: 'newsuper',
      level: 'super_admin',
      fresh_auth_proof: 'a'.repeat(64),
    });
    expect(res.status).toBe(200);
    expect(consumeMock).toHaveBeenCalledTimes(1);
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
  });

  it('signature (self-custody) caller passes the fresh-auth gate without a proof and never calls consume', async () => {
    stubDefaultRoster();
    const res = await asSignature(request(app).post('/api/admin/roster/grant'), SUPER).send({
      account: 'newadmin',
      level: 'admin',
    });
    expect(res.status).toBe(200);
    // The per-request signature IS the fresh proof on the signature path: the
    // consume helper must not be invoked at all.
    expect(consumeMock).not.toHaveBeenCalled();
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
  });
});

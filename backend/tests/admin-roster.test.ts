/**
 * Deterministic coverage for the chain-derived admin roster: the
 * `activeAdminsCteBody` signer-gate SQL shape, the `getAdminLevel` resolver
 * (root-from-config, chain grant, fail-closed), the `levelMeets` tier
 * hierarchy, and the `requireAdminLevel` middleware.
 *
 * Per root CLAUDE.md "Carve-out for deterministic edge-case coverage":
 *   (a) Real path that's impractical: the roster is derived from on-chain
 *       `admin_grant` / `admin_revoke` ops, and the public HAF corpus cannot
 *       be deterministically seeded at test time with the matched rows this
 *       file's risk classes require — a FORGED grant signed by a stranger (NOT
 *       `config.hiveAdminAccount`), a grant-then-`admin_revoke` per account
 *       (latest-op-wins), and malformed `level` values. The signer-gate part
 *       is pinned as a SQL-shape canary (assert the captured SELECT carries the
 *       singular `required_posting_auths ?` bound to `config.hiveAdminAccount`,
 *       mirroring the WoT-threshold canary in `wot-threshold-signer-gate.test.ts`);
 *       the resolver/middleware parts are pure-logic assertions on controlled
 *       rows. The CTE itself was verified to execute against the live HAF
 *       (returns [] today — no admin_grant ops exist yet — in ~290ms).
 *   (b) The unit under test runs NO cryptographic-verification middleware:
 *       `getAdminLevel` / `getAdminRoster` are internal HAF reads (no
 *       `verifyHiveSignature` in their call path), and `requireAdminLevel`
 *       CONSUMES `req.hiveUsername` (set upstream by the real
 *       `verifyHiveSignature` in production) rather than performing signature
 *       verification itself. So the carve-out's clause-(b) "run real crypto
 *       middleware" requirement does not apply: the tier gate is enforced
 *       against the verified username + the chain roster, not by request-
 *       signature middleware. The middleware tests assert tier logic only.
 *   (c) Same risk class elsewhere: the singular `required_posting_auths ?`
 *       admin-signer-gate SQL discipline is exercised against real HAF by the
 *       retracted-papers read path (`retractedPapersCteBody`, same singular `?`
 *       gate) whose integration tests run against the live corpus; this file
 *       pins the admin-roster call site, which the live corpus cannot seed with
 *       admin_grant rows.
 *
 * Mocked surface (carve-out scope): only `getPool()` from `db.js` (a shared
 * pool helper) and `redis.js` (so the cache stays in-process). No business
 * logic is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(async (..._args: unknown[]) => ({ rows: [] as unknown[] })),
}));

vi.mock('../src/db.js', () => ({
  getPool: () => ({ query: queryMock }),
  isHafConfigured: () => true,
  closeHafPool: async () => {},
}));

vi.mock('../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

const { getAdminLevel, getAdminRoster, levelMeets, requireAdminLevel } = await import('../src/admin-roster.js');
const { hafCache } = await import('../src/cache.js');
const { config } = await import('../src/config.js');

let capturedSql = '';
let capturedParams: unknown[] = [];

/** Install a roster SELECT result; capture the SQL/params for shape canaries. */
function stubRoster(rows: Array<{ account: string; level: string }>): void {
  capturedSql = '';
  capturedParams = [];
  queryMock.mockReset().mockImplementation(async (sql: unknown, params?: unknown) => {
    if (typeof sql === 'string' && sql.includes('active_admins')) {
      capturedSql = sql;
      capturedParams = (params as unknown[]) ?? [];
      return { rows };
    }
    return { rows: [] };
  });
}

/** Minimal Express res double capturing status + json body. */
function makeRes(): {
  statusCode: number | undefined;
  body: unknown;
  status: (n: number) => { json: (b: unknown) => void };
  req: unknown;
  headersSent: boolean;
} {
  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    headersSent: false,
    req: { method: 'POST', url: '/api/admin/x' },
    status(n: number) {
      res.statusCode = n;
      return {
        json(b: unknown) {
          res.body = b;
        },
      };
    },
  };
  return res;
}

beforeEach(async () => {
  await hafCache.clear();
  queryMock.mockReset().mockImplementation(async () => ({ rows: [] }));
});

describe('activeAdminsCteBody / getAdminRoster — chain read', () => {
  it('binds a SINGULAR required_posting_auths gate to config.hiveAdminAccount', async () => {
    stubRoster([]);
    await getAdminRoster();

    // Singular `?` (the signer is singular by design), NOT plural `?|`.
    expect(capturedSql).toMatch(/required_posting_auths \? \$\d+/);
    expect(capturedSql).not.toMatch(/required_posting_auths \?\|/);
    // Restricted to the two roster ops.
    expect(capturedSql).toMatch(/'admin_grant', ?'admin_revoke'/);
    // $1 = appTag, $2 = singular admin signer.
    expect(capturedParams[0]).toBe(config.appTag);
    expect(capturedParams[1]).toBe(config.hiveAdminAccount);
  });

  it('returns an account->tier map for live grants', async () => {
    stubRoster([
      { account: 'alice', level: 'admin' },
      { account: 'bob', level: 'super_admin' },
    ]);
    expect(await getAdminRoster()).toEqual({ alice: 'admin', bob: 'super_admin' });
  });

  it('drops forged/malformed levels (root is not chain-grantable)', async () => {
    stubRoster([
      { account: 'mallory', level: 'root' },     // root is config-only, never a chain grant
      { account: 'eve', level: 'wizard' },        // not a valid tier
      { account: 'alice', level: 'admin' },
    ]);
    expect(await getAdminRoster()).toEqual({ alice: 'admin' });
  });
});

describe('getAdminLevel — resolver', () => {
  it('resolves the root account from config WITHOUT a HAF read', async () => {
    stubRoster([]);
    expect(await getAdminLevel(config.rootAdminAccount)).toBe('root');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('resolves a chain-granted admin', async () => {
    stubRoster([{ account: 'alice', level: 'admin' }]);
    expect(await getAdminLevel('alice')).toBe('admin');
  });

  it('resolves a chain-granted super_admin', async () => {
    stubRoster([{ account: 'bob', level: 'super_admin' }]);
    expect(await getAdminLevel('bob')).toBe('super_admin');
  });

  it('returns null for an account with no grant', async () => {
    stubRoster([{ account: 'alice', level: 'admin' }]);
    expect(await getAdminLevel('nobody')).toBeNull();
  });

  it('returns null for an empty username', async () => {
    expect(await getAdminLevel('')).toBeNull();
  });

  it('fails closed (null) when the chain read throws', async () => {
    queryMock.mockReset().mockRejectedValue(new Error('HAF down'));
    expect(await getAdminLevel('alice')).toBeNull();
  });
});

describe('levelMeets — tier hierarchy', () => {
  it('orders admin < super_admin < root', () => {
    expect(levelMeets('admin', 'admin')).toBe(true);
    expect(levelMeets('admin', 'super_admin')).toBe(false);
    expect(levelMeets('super_admin', 'admin')).toBe(true);
    expect(levelMeets('super_admin', 'super_admin')).toBe(true);
    expect(levelMeets('root', 'super_admin')).toBe(true);
    expect(levelMeets('root', 'root')).toBe(true);
    expect(levelMeets(null, 'admin')).toBe(false);
  });
});

describe('requireAdminLevel — middleware', () => {
  it('401s when there is no verified hive username', async () => {
    const res = makeRes();
    const next = vi.fn();
    await requireAdminLevel('admin')({ hiveUsername: undefined } as never, res as never, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('403s when the caller is below the required tier', async () => {
    stubRoster([]); // alice has no grant
    const res = makeRes();
    const next = vi.fn();
    await requireAdminLevel('admin')({ hiveUsername: 'alice' } as never, res as never, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next and stamps req.adminLevel when the tier is sufficient', async () => {
    stubRoster([{ account: 'alice', level: 'admin' }]);
    const res = makeRes();
    const next = vi.fn();
    const req = { hiveUsername: 'alice' } as { hiveUsername: string; adminLevel?: string };
    await requireAdminLevel('admin')(req as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.adminLevel).toBe('admin');
  });

  it('lets a super_admin satisfy an admin-min gate', async () => {
    stubRoster([{ account: 'bob', level: 'super_admin' }]);
    const res = makeRes();
    const next = vi.fn();
    await requireAdminLevel('admin')({ hiveUsername: 'bob' } as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('403s an admin against a super_admin-min gate', async () => {
    stubRoster([{ account: 'alice', level: 'admin' }]);
    const res = makeRes();
    const next = vi.fn();
    await requireAdminLevel('super_admin')({ hiveUsername: 'alice' } as never, res as never, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets root pass any tier gate', async () => {
    const res = makeRes();
    const next = vi.fn();
    const req = { hiveUsername: config.rootAdminAccount } as { hiveUsername: string; adminLevel?: string };
    await requireAdminLevel('super_admin')(req as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.adminLevel).toBe('root');
  });
});

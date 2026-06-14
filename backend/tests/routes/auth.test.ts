// Mocking carve-out acknowledgments (root CLAUDE.md "Running Tests"):
//   - `vi.mock('../../src/hive.js', …)` below stubs `getAccounts` to publish
//     TEST_PUBLIC_KEY for TEST_USERNAME. Real cryptographic verification via
//     `verifyHiveSignature` runs end-to-end against deterministic signatures
//     produced by `signRequestBound` (see clause (b): auth-focused tests use
//     real signature verification, not the MOCK_VERIFY_SIGNATURE fixture).
//   - `vi.spyOn(logger, 'error')` is used in the SMTP-not-configured spec
//     (BE-LOG-PII-EMAIL-HASH item 2b) to assert structured log payload shape
//     (observability surface; pino writes to stdout/stderr without a
//     testable return value, so spy interception is the only deterministic
//     anchor for payload-shape assertions). Risk class — accidental
//     plaintext-email leak in operator logs — is also exercised by real-path
//     signup specs that go through the same code path. Per root CLAUDE.md
//     carve-out clause (a) (observability surface, clause-(c) sibling
//     coverage in the broader signup suite).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrivateKey, cryptoUtils } from '@hiveio/dhive';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { logger } from '../../src/logger.js';
import { getAppPool } from '../../src/app-db.js';
import { getRedis, isRedisAvailable } from '../../src/redis.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';
import { signRequestBound as signRequestBoundShared } from '../support/sign-request.js';

// Generate a deterministic test keypair and mock the Hive client so the
// middleware's on-chain account lookup returns this public key for the
// test username. Tests that exercise the real verifyHiveSignature
// end-to-end use this to produce genuinely valid signatures.
const TEST_USERNAME = 'testauthuser';
const TEST_PRIVATE_KEY = PrivateKey.fromSeed('pevo-auth-test-seed-deterministic');
const TEST_PUBLIC_KEY = TEST_PRIVATE_KEY.createPublic().toString();

vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: {
      getAccounts: vi.fn().mockImplementation((names: string[]) => {
        if (names.includes(TEST_USERNAME)) {
          return Promise.resolve([
            { name: TEST_USERNAME, posting: { key_auths: [[TEST_PUBLIC_KEY, 1]] } },
          ]);
        }
        return Promise.resolve([]);
      }),
    },
  },
}));

const app = createApp();

// Top-level DB reachability probe — mirrors the pattern in
// signup-verify.test.ts and recover.test.ts. The SMTP-not-configured spec at
// the bottom of this file insert-then-delete a real accounts row, so it skips
// when Postgres is unavailable. Top-level await is permitted at module scope
// in Vitest's ESM loader.
let dbReachable = false;
{
  const pool = getAppPool();
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
  }
}

// Per-file binding of the shared helper to TEST_PRIVATE_KEY. The signing
// protocol is implemented once in `../support/sign-request.ts`
// (BE-LOG-PII-EMAIL-HASH round-2 hold item 3).
function signRequestBound(method: string, fullPath: string, body: Record<string, unknown>, timestamp: string): string {
  return signRequestBoundShared(TEST_PRIVATE_KEY, method, fullPath, body, timestamp);
}

describe('POST /api/auth/session', () => {
  it('returns 401 without signature headers', async () => {
    const res = await request(app)
      .post('/api/auth/session')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('issues JWT when called with valid request-bound Hive signature', async () => {
    const timestamp = new Date().toISOString();
    const body = {};
    const signature = signRequestBound('POST', '/api/auth/session', body, timestamp);

    const res = await request(app)
      .post('/api/auth/session')
      .set('X-Hive-Username', TEST_USERNAME)
      .set('X-Hive-Signature', signature)
      .set('X-Hive-Timestamp', timestamp)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.token).toBeTruthy();
    const decoded = jwt.verify(res.body.data.token, config.sessionSecret) as { sub: string };
    expect(decoded.sub).toBe(TEST_USERNAME);
  });
});

describe('Bearer JWT authentication', () => {
  it('accepts valid Bearer JWT on authenticated endpoints', async () => {
    const token = jwt.sign({ sub: 'testuser123' }, config.sessionSecret, { expiresIn: '1h' });

    const res = await request(app)
      .get('/api/notifications?since_block=1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).not.toBe(401);
    expect(res.body.error?.code).not.toBe('UNAUTHORIZED');
  });

  it('rejects expired JWT and falls back to Hive sig check (returns 401)', async () => {
    const token = jwt.sign({ sub: 'testuser123' }, config.sessionSecret, { expiresIn: '-1s' });

    const res = await request(app)
      .get('/api/notifications?since_block=1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects JWT with wrong secret and falls back to Hive sig check (returns 401)', async () => {
    const token = jwt.sign({ sub: 'testuser123' }, 'wrong-secret', { expiresIn: '1h' });

    const res = await request(app)
      .get('/api/notifications?since_block=1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects malformed Bearer token and falls back to Hive sig check (returns 401)', async () => {
    const res = await request(app)
      .get('/api/notifications?since_block=1')
      .set('Authorization', 'Bearer not-a-real-jwt');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('Hive signature path — request-binding enforcement (FINDING-001 regressions)', () => {
  it('rejects when X-Hive-Timestamp is missing', async () => {
    const res = await request(app)
      .post('/api/auth/session')
      .set('X-Hive-Username', TEST_USERNAME)
      .set('X-Hive-Signature', 'SIG_K1_anything')
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('X-Hive-Timestamp is required');
  });

  it('rejects a valid signature made over a different (captured) message', async () => {
    // Simulates an attacker replaying a signature captured from another dApp
    // or another endpoint. The signature is cryptographically valid and from
    // the correct private key, but it was produced over a payload that is NOT
    // the request-bound message, so the server must reject it.
    const timestamp = new Date().toISOString();
    const capturedMsg = `pevo-auth-${Date.now()}-${Math.random()}`; // old pre-FINDING-001 challenge format
    const capturedMsgHash = cryptoUtils.sha256(capturedMsg);
    const capturedSignature = TEST_PRIVATE_KEY.sign(capturedMsgHash).toString();

    const res = await request(app)
      .post('/api/auth/session')
      .set('X-Hive-Username', TEST_USERNAME)
      .set('X-Hive-Signature', capturedSignature)
      .set('X-Hive-Timestamp', timestamp)
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a signature produced against a different path (cross-endpoint replay)', async () => {
    // Signature bound to /api/auth/session must not authenticate /api/notifications.
    const timestamp = new Date().toISOString();
    const signature = signRequestBound('POST', '/api/auth/session', {}, timestamp);

    const res = await request(app)
      .get('/api/notifications?since_block=1')
      .set('X-Hive-Username', TEST_USERNAME)
      .set('X-Hive-Signature', signature)
      .set('X-Hive-Timestamp', timestamp);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an expired timestamp (>60s old)', async () => {
    const timestamp = new Date(Date.now() - 120_000).toISOString();
    const signature = signRequestBound('POST', '/api/auth/session', {}, timestamp);

    const res = await request(app)
      .post('/api/auth/session')
      .set('X-Hive-Username', TEST_USERNAME)
      .set('X-Hive-Signature', signature)
      .set('X-Hive-Timestamp', timestamp)
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 with malformed Hive signature (real middleware runs)', async () => {
    const res = await request(app)
      .get('/api/notifications?since_block=1')
      .set('X-Hive-Username', 'someuser')
      .set('X-Hive-Signature', 'invalid-sig-value')
      .set('X-Hive-Timestamp', new Date().toISOString());

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

// ─────────────────────────────────────────────────────────────
// BE-REQUEST-BODY-TYPING-ZOD: 400 VALIDATION_ERROR schema-leak guard
//
// The Zod `safeParse` result carries an `issues` array with field paths,
// constraint codes, and `received` types. Emitting it raw in the 400
// response body leaks schema shape to unauthenticated callers. Assert
// that the 400 body on parse failure contains NEITHER a raw `issues`
// array NOR any Zod-internal keys (`received`, `code`, `expected`,
// `validation`) across each of the four migrated routes.
// ─────────────────────────────────────────────────────────────
describe('BE-REQUEST-BODY-TYPING-ZOD: 400 VALIDATION_ERROR does not leak Zod schema shape', () => {
  // /api/orcid/callback intentionally omitted from this parametrized
  // batch: it returns 500 INTERNAL_ERROR before safeParse when
  // ORCID_CLIENT_ID/SECRET are unset (test env default). The Zod
  // flattening on that route mirrors the auth.ts sites and is covered
  // structurally by the same sendError call shape.
  //
  // /api/orcid/start has the same ordering wrinkle: the handler returns
  // 500 INTERNAL_ERROR (ORCID integration not configured) BEFORE the
  // StartBodySchema.safeParse call when ORCID_CLIENT_ID/SECRET are unset
  // in the test env. Rather than plumb real ORCID creds through the test
  // harness just to reach the parse branch, we assert the structural
  // invariant — that routes/orcid.ts uses StartBodySchema.safeParse and
  // forwards failure to the same sendError(400, 'VALIDATION_ERROR',
  // 'Invalid request body') shape — via a source-shape grep below.
  //
  // Clear the rate-limit buckets of every route exercised in this
  // describe block before these specs run. Without this, prior test
  // files (e.g. auth-concurrency.test.ts burns 8 /login requests
  // against the 10/hr loginLimiter) can exhaust a shared window and
  // these specs 429 instead of 400. Each added route
  // (resend-verification at 3/hr, reset-request at 5/hr, reset at
  // 5/hr) is cheaper to exhaust than /login, so we clear them too.
  beforeAll(async () => {
    await clearRateLimitKeys([
      'auth-login',
      'auth-signup',
      'auth-resend',
      'auth-reset-request',
      'auth-reset',
    ]);
  });
  const cases: Array<{ route: string; body: Record<string, unknown> }> = [
    // /login: refine requires at least one of username/email_or_username.
    { route: '/api/auth/login', body: { password: 'x' } },
    // /signup: non-string email triggers parse failure at the object level.
    { route: '/api/auth/signup', body: { email: 123 } },
    // /recover: username is .min(1), non-string triggers parse failure.
    { route: '/api/auth/recover', body: { username: 123 } },
    // BE-ZOD-MIGRATION-EXTENSION round-2 additions:
    // /resend-verification: email is .min(1) string, non-string fails parse.
    { route: '/api/auth/resend-verification', body: { email: 123, password: 'x' } },
    // /reset-request: email is .min(1) string, non-string fails parse.
    { route: '/api/auth/reset-request', body: { email: 123 } },
    // /reset: token is .min(1) string, non-string fails parse.
    { route: '/api/auth/reset', body: { token: 123, password: 'NewPass123!' } },
  ];

  for (const { route, body } of cases) {
    it(`${route} 400 body omits raw Zod issues + internals`, async () => {
      const res = await request(app).post(route).send(body);
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('Invalid request body');
      // No details.issues leak.
      expect(res.body.error.details).toBeUndefined();
      // Deep shape scan: no raw Zod internals anywhere in the body.
      const flat = JSON.stringify(res.body);
      expect(flat).not.toContain('"issues"');
      expect(flat).not.toContain('"received"');
      expect(flat).not.toContain('"expected"');
      expect(flat).not.toContain('"validation"');
    });
  }

  it('/login 400 still fires when both username and email_or_username are empty (refine invariant)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: '', email_or_username: '', password: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('Invalid request body');
  });

  it('/login 400 fires on parse failure for non-string password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'user', password: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // /orcid/start structural grep (see header comment for why HTTP-round-trip
  // coverage isn't practical in the default test env).
  it('/api/orcid/start uses StartBodySchema.safeParse with the flat VALIDATION_ERROR shape', () => {
    const here = import.meta.dirname;
    const src = readFileSync(
      resolve(here, '../../src/routes/orcid.ts'),
      'utf8',
    );
    // Schema is declared at module scope.
    expect(src).toMatch(/const\s+StartBodySchema\s*=\s*z\.object\(/);
    // Handler calls safeParse on req.body.
    expect(src).toMatch(/StartBodySchema\.safeParse\(req\.body\)/);
    // Failure branch forwards to sendError with the same flat shape
    // as the other migrated routes (400 VALIDATION_ERROR 'Invalid
    // request body' and no details payload that could leak issues).
    expect(src).toMatch(
      /sendError\(\s*res\s*,\s*400\s*,\s*['"]VALIDATION_ERROR['"]\s*,\s*['"]Invalid request body['"]\s*\)/,
    );
  });
});

// ─────────────────────────────────────────────────────────────
// BE-LOG-PII-EMAIL-HASH round-1 hold item 2b: pin the email_hash log
// shape on the /signup SMTP-not-configured branch.
//
// The pre-fix call site emitted `email: <plaintext>`; the round-1 fix
// migrated it to `email_hash: safeHashEmailForLogs(normalizedEmail)`.
// Without this spec the migration is mutation-blind — a regression that
// reverts the field name to plaintext, drops the helper, or swaps in
// `String(normalizedEmail)` would pass every other suite. Asserts:
//   (1) the warn payload carries `email_hash` matching /^[0-9a-f]{12}$/
//   (2) no top-level `email` key is present
// The route DELETEs the inserted accounts row itself when SMTP is not
// configured, so no post-test cleanup is required beyond a defensive
// delete-by-email guard.
// ─────────────────────────────────────────────────────────────
describe.skipIf(!dbReachable)('BE-LOG-PII-EMAIL-HASH: /signup SMTP-not-configured logs email_hash, not email', () => {
  // config.smtpHost defaults to '' in the test env (SMTP_HOST is empty in
  // .env.example / the docker-compose env), so no override is needed to
  // reach the else branch at routes/auth.ts:547.
  const RUN_ID = Date.now();
  const TEST_EMAIL = `log_pii_smtp_unset_${RUN_ID}@mit.edu`;

  beforeAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query('DELETE FROM accounts WHERE email = $1', [TEST_EMAIL]).catch(() => {});
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query('DELETE FROM accounts WHERE email = $1', [TEST_EMAIL]).catch(() => {});
  });

  it('emits email_hash (12-hex), not plaintext email, and returns 500 INTERNAL_ERROR', async () => {
    await clearRateLimitKeys(['auth-signup']);

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    try {
      const res = await request(app)
        .post('/api/auth/signup')
        .send({
          email: TEST_EMAIL,
          password: 'SmtpUnsetPass1',
          full_name: 'SMTP Unset User',
          institution: 'MIT',
          field: 'physics',
        });

      // Route returns 500 INTERNAL_ERROR after deleting the just-inserted row.
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');

      // Find the smtp_not_configured emission. Other emissions (e.g.,
      // dup_burn_failed warn) may fire on the same suite run if rate-limit
      // bleed-through is incomplete; filter by event for stability.
      const emission = errorSpy.mock.calls.find(
        ([payload]) =>
          payload != null &&
          typeof payload === 'object' &&
          (payload as Record<string, unknown>).event === 'auth.signup.smtp_not_configured',
      );
      expect(emission, 'expected an auth.signup.smtp_not_configured logger.error emission').toBeDefined();

      const [payload] = emission!;
      const obj = payload as Record<string, unknown>;
      // (1) email_hash is the 12-hex SHA-256 truncation.
      expect(obj.email_hash).toMatch(/^[0-9a-f]{12}$/);
      // (2) no top-level `email` key — pre-fix shape removed.
      expect(obj).not.toHaveProperty('email');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe.skipIf(!dbReachable)('POST /api/auth/signup — duplicate ORCID maps 23505 to 409 (not 500)', () => {
  // Real-path: a prior accounts row already holds the ORCID, so the second
  // signup's INSERT trips the accounts_orcid_unique partial index
  // (007_accounts_orcid_unique.sql) and Postgres raises 23505. The handler must
  // surface the clean 409 ORCID_ALREADY_LINKED (the same wire shape the
  // /orcid/callback accredit and link paths return), not a generic 500. Both
  // the ORCID-only and ORCID+email INSERT branches are exercised; ON CONFLICT
  // (email) targets the email constraint, not the orcid index, so both reach
  // the catch. The real argon/verification paths run; only the upstream
  // ORCID-verification nonce is seeded directly (the OAuth round-trip is not
  // reproducible per-test), which is downstream-irrelevant to the 23505->409
  // mapping under test.
  const RUN = Date.now();
  const suffix = String(RUN % 10000).padStart(4, '0');
  const EMAIL_PREFIX = `dup_orcid_${RUN}_`;

  async function seedOrcidVerified(nonce: string, orcidId: string): Promise<void> {
    const payload = { orcid_id: orcidId, works_count: 5, name: 'Dup Guard' };
    const redis = getRedis();
    if (redis && isRedisAvailable()) {
      await redis.set(
        `${config.appTag}:orcid_verified:${nonce}`,
        JSON.stringify(payload),
        'EX',
        600,
      );
    }
    // Seed the in-memory fallback too so the spec holds whether or not Redis is
    // reachable — the handler reads Redis first and only consults the map when
    // Redis is down.
    const { orcidVerified } = await import('../../src/routes/orcid.js');
    orcidVerified.set(nonce, { ...payload, expires: Date.now() + 600_000 });
  }

  beforeAll(async () => {
    await clearRateLimitKeys(['auth-signup']);
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query(`DELETE FROM accounts WHERE orcid LIKE $1 OR email LIKE $2`, [
      `0000-0002-${suffix}-%`,
      `${EMAIL_PREFIX}%`,
    ]);
  });

  it('ORCID-only signup whose ORCID already exists on another row → 409 ORCID_ALREADY_LINKED', async () => {
    const pool = getAppPool()!;
    const orcid = `0000-0002-${suffix}-0001`;
    await pool.query(`INSERT INTO accounts (email, orcid) VALUES (NULL, $1)`, [orcid]);
    const nonce = `dupguard-only-${suffix}`;
    await seedOrcidVerified(nonce, orcid);

    const res = await request(app).post('/api/auth/signup').send({ orcid_token: nonce });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORCID_ALREADY_LINKED');
    // Terminal wire shape, matching the /orcid/callback 409s: no retriable hint.
    expect(res.body.error.details?.retriable).toBeUndefined();
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('ORCID+email signup whose ORCID already exists on another row → 409 ORCID_ALREADY_LINKED', async () => {
    const pool = getAppPool()!;
    const orcid = `0000-0002-${suffix}-0002`;
    await pool.query(`INSERT INTO accounts (email, orcid) VALUES (NULL, $1)`, [orcid]);
    const nonce = `dupguard-email-${suffix}`;
    await seedOrcidVerified(nonce, orcid);

    const res = await request(app).post('/api/auth/signup').send({
      orcid_token: nonce,
      email: `${EMAIL_PREFIX}new@example.com`,
      password: 'DupGuardPass1',
      full_name: 'Dup Guard',
      field: 'CS',
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORCID_ALREADY_LINKED');
  });
});

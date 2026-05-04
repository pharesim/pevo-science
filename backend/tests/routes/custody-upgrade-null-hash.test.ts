/**
 * Mutation-fence test for the /api/custody/upgrade null-hash sub-branch.
 *
 * BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT round-2 hold item 1.
 *
 * The custody-upgrade handler at `custody.ts:223-227` short-circuits with a
 * 401 + audit-log + sentinel burn when an authenticated `custody='light'` row
 * has `password_hash=NULL`. The branch is reachable today via the ORCID flow
 * (orcid.ts mints a JWT with `custody: account.custody || 'light'`, which
 * defaults to `'light'` for null/falsy `custody` rows; that JWT then passes
 * `/upgrade`'s `custody !== 'light'` gate). Without the null-guard, execution
 * reaches `argon2.verify(null, password)` which throws synchronously and
 * returns 500 in ~0ms — a wall-time + status-code oracle for "this is an
 * ORCID-only-account-on-light-JWT shape" that is observably distinct from
 * the wrong-password 401 + ~50ms shape.
 *
 * The wall-time / status / audit-log convergence is asserted in the
 * implementation comment but NOT locked by any test prior to this file.
 * `custody-upgrade-argon-error-translation.test.ts` mocks `password_hash`
 * non-null and routes around the null-hash branch entirely. Per
 * `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md`,
 * every sub-branch on a timing-equalized endpoint needs a load-bearing test
 * fence; analogous to the `/login` `NO_PASSWORD_SET` timing test in
 * `recover.test.ts:438-463` and the `/resend-verification` null-hash burn
 * test in `recover.test.ts:602-633`.
 *
 * Real-DB testing path: this file follows the same shape as recover.test.ts
 * (real argon2, real pg pool, real verifyHiveSignature middleware). The
 * synthetic-mock carve-out documented in root CLAUDE.md does NOT apply
 * here — the route's HAF/middleware path must run for the mutation fence
 * to be load-bearing. `verifyHiveSignature` is satisfied by minting a real
 * Bearer JWT with `config.sessionSecret`, the same path the production
 * `/api/auth/login` and `/api/auth/session` routes issue.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { config } from '../../src/config.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';
import { TIMING_ORACLE_FLOOR_MS } from '../support/timing-constants.js';

const app = createApp();

const RUN_ID = Date.now();

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

// Hive usernames: /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/.
// Use a 4-char base36 suffix so two test usernames stay under 16 chars.
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const NULL_HASH_USER = `upnh${SUFFIX}user`;
const WRONG_PWD_USER = `upwp${SUFFIX}user`;
const NULL_HASH_EMAIL = `upgrade_nullhash_${RUN_ID}@example.com`;
const WRONG_PWD_EMAIL = `upgrade_wrongpwd_${RUN_ID}@example.com`;
const KNOWN_PASSWORD = 'KnownPassword1';

function bearerFor(username: string): string {
  // Match production JWT shape from /api/auth/login: { sub, custody: 'light' }.
  const token = jwt.sign({ sub: username, custody: 'light' }, config.sessionSecret, { expiresIn: '5m' });
  return `Bearer ${token}`;
}

describe.skipIf(!dbReachable)('BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT: /api/custody/upgrade null-hash sub-branch', () => {
  beforeAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    // Clean any stale rows from prior runs.
    await pool.query('DELETE FROM custody_audit_log WHERE username IN ($1, $2)', [NULL_HASH_USER, WRONG_PWD_USER]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username IN ($1, $2)', [NULL_HASH_USER, WRONG_PWD_USER]).catch(() => {});

    // Seed null-hash row: custody='light' + password_hash=NULL + no upgraded_at.
    // Mirrors the ORCID-only-account-with-light-JWT shape that reaches the new
    // null-guard branch in production (orcid.ts mints custody='light' default).
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, verify_token, expires_at)
       VALUES ($1, $2, NULL, 'light', NULL, $3)`,
      [NULL_HASH_EMAIL, NULL_HASH_USER, new Date(Date.now() + 24 * 60 * 60 * 1000)],
    );

    // Seed baseline wrong-password row: custody='light' + a real argon2 hash
    // for KNOWN_PASSWORD + no upgraded_at. The mutation fence checks that the
    // null-hash branch's response shape (status, code, message, audit-log,
    // wall-time floor) matches the wrong-password branch on every axis. If a
    // future PR drops the burn or rewrites the response code, the floor
    // assertion or the audit-log assertion below catches it.
    const realHash = await argon2.hash(KNOWN_PASSWORD, { type: argon2.argon2id });
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, verify_token, expires_at)
       VALUES ($1, $2, $3, 'light', NULL, $4)`,
      [WRONG_PWD_EMAIL, WRONG_PWD_USER, realHash, new Date(Date.now() + 24 * 60 * 60 * 1000)],
    );
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query('DELETE FROM custody_audit_log WHERE username IN ($1, $2)', [NULL_HASH_USER, WRONG_PWD_USER]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username IN ($1, $2)', [NULL_HASH_USER, WRONG_PWD_USER]).catch(() => {});
  });

  it('null-hash branch returns 401 UNAUTHORIZED + Invalid password + audit-log + ≥ floor wall-time', async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;

    // upgradeLimiter is keyed by account at max=1/hr, so we use a unique
    // username per row and clear the limiter once for headroom across retries.
    await clearRateLimitKeys(['custody-upgrade']);

    // Warm the sentinel-hash lazy promise + Node request stack so the measured
    // call reflects steady-state burnSentinel (argon2.verify) cost, not
    // first-call hash-compute overhead. The warmup uses an unauthenticated
    // request so it doesn't burn the per-account rate-limit budget.
    await request(app)
      .post('/api/custody/upgrade')
      .send({ password: 'Warmup1234' });

    const start = Date.now();
    const res = await request(app)
      .post('/api/custody/upgrade')
      .set('Authorization', bearerFor(NULL_HASH_USER))
      .send({ password: 'AnyPassword1' });
    const elapsed = Date.now() - start;

    // Status + envelope: matches the wrong-password branch byte-for-byte.
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Invalid password');

    // Audit-log: the null-hash branch must emit logCustodyBroadcast(username,
    // 'upgrade_failure'), the same row the wrong-password branch emits. A
    // future PR that drops this call lands green if this assertion is missing.
    const { rows: auditRows } = await pool.query(
      `SELECT operation_type FROM custody_audit_log
       WHERE username = $1 AND operation_type = 'upgrade_failure'`,
      [NULL_HASH_USER],
    );
    expect(auditRows.length).toBe(1);

    // Wall-time floor: ≥ TIMING_ORACLE_FLOOR_MS (35ms) kills the
    // burn-sentinel-removal mutation. Without the burn, the null-hash branch
    // returns in ~0ms (sync TypeError pre-fix) or ~1ms (early-return without
    // burn post-fix-bypass) versus the wrong-password branch's ~45-100ms
    // argon2.verify cost. 35ms is the lowest-plausible argon2-verify floor on
    // fast hardware (still 35x margin over the no-burn ~1ms path); see
    // `tests/support/timing-constants.ts` for the full rationale.
    expect(elapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
  });

  it('wrong-password branch returns the same shape (paired-request equivalence baseline)', async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await clearRateLimitKeys(['custody-upgrade']);

    // Warm again — separate test runs in isolation; warm the sentinel/argon2
    // path so steady-state verify cost dominates.
    await request(app)
      .post('/api/custody/upgrade')
      .send({ password: 'Warmup1234' });

    const start = Date.now();
    const res = await request(app)
      .post('/api/custody/upgrade')
      .set('Authorization', bearerFor(WRONG_PWD_USER))
      .send({ password: 'WrongPassword1' });
    const elapsed = Date.now() - start;

    // Same envelope: this is the branch the null-hash branch is engineered
    // to be observably indistinguishable from. If the response shape ever
    // diverges (different code, different message, different status), the
    // null-hash test above stops being a meaningful equivalence assertion.
    // Locking the wrong-password shape here makes that drift visible.
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Invalid password');

    const { rows: auditRows } = await pool.query(
      `SELECT operation_type FROM custody_audit_log
       WHERE username = $1 AND operation_type = 'upgrade_failure'`,
      [WRONG_PWD_USER],
    );
    expect(auditRows.length).toBe(1);

    expect(elapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
  });
});

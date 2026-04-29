/**
 * Route test for the BE-ARGON2-JSLEVEL-CONCURRENCY-CAP round-3 hold P1 fix:
 * the `/signup` duplicate-email burn `.catch()` MUST rethrow
 * `ArgonQueueFullError` (and `ShuttingDownError`) so the outer
 * `handleArgonQueueFull` translates them to 503 SERVICE_UNAVAILABLE. Before
 * the fix the catch swallowed both classes, which under saturation /
 * shutdown returned 409 in ~0ms for a duplicate email and 503 in ~0ms for a
 * non-duplicate — a status-code differential that directly leaks email
 * existence to an attacker who can saturate the singleton or catch a
 * SIGTERM drain window.
 *
 * This file was migrated to the shared `buildArgon2RouteMockKit` so the
 * mocked argon2-semaphore module re-exports the REAL production
 * `ArgonSemaphoreError` / `ArgonQueueFullError` / `ShuttingDownError` /
 * `ArgonAbortError` classes via `vi.importActual`. The previous in-file
 * `vi.hoisted` synthetic-class declarations let production drift the
 * abstract-base hierarchy without test breakage; the shared kit binds the
 * production hierarchy so the route's `instanceof ArgonSemaphoreError`
 * check at auth.ts:410/419 resolves against the same constructor the test
 * injects. See `tests/support/argon2-error-mocks.ts:30-46` for the
 * canonical hoist-pattern shape — `vi.hoisted` runs BEFORE every regular
 * `import`, and `await import(...)` of the support module from inside
 * hoisted scope is the only way `vi.mock(...)` can reach the shared kit.
 *
 * The `details.reason` literal assertions below import
 * `ARGON_REASON_QUEUE_FULL` / `ARGON_REASON_SHUTDOWN_DRAIN` from
 * `argon2-error-handler.js` so a future rename or whitespace drift in the
 * production constant surfaces as a test mismatch instead of silent
 * acceptance of a now-stale literal. Consumers (HTTP-only canaries) branch
 * on this discriminator to distinguish saturation from rolling-restart
 * drain.
 *
 * Justification for `vi.mock` (per root CLAUDE.md test carve-out):
 *   - `getAppPool()` mock seeds the duplicate-email row deterministically
 *     without writing to the real `accounts` table during a test, which
 *     the carve-out explicitly permits.
 *   - `runWithArgon2Slot` mock throws `ArgonQueueFullError` synchronously
 *     instead of filling the singleton's 50-slot queue with 50 concurrent
 *     parked argon2 hashes. The architect's hold block describes the
 *     scenario as "fills the singleton's queue to MAX_QUEUE_DEPTH" — the
 *     spirit is "exercise the queue-full path", which the mock does
 *     deterministically. Filling the real queue would require 50
 *     concurrent stuck requests, exceeds the per-IP signup rate limiter
 *     (10/hr), and risks flake on any timing variance during drain.
 *   - `verifyHiveSignature` is NOT mocked — `/signup` is unauthenticated
 *     so the middleware doesn't apply on this surface anyway.
 *   - `redis.js` is mocked to no-redis so the in-memory rate-limiter +
 *     replay-cache fallbacks engage and the test does not depend on a
 *     live Redis instance.
 *   - Clause (c): no real-HAF variant is filed because the queue-fill
 *     scenario is deterministically impractical at scale (filling
 *     MAX_QUEUE_DEPTH=50 with real concurrent stuck requests exceeds
 *     rate-limit caps and risks flake on drain timing). The architect's
 *     hold-block authorized the mock for this exact reason; this header
 *     note records that authorization for future readers.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import {
  assertArgon2AbortIsSilent,
  assert503QueueFull,
  assert503Shutdown,
} from '../support/argon2-error-mocks.js';
import {
  ARGON_REASON_QUEUE_FULL,
  ARGON_REASON_SHUTDOWN_DRAIN,
} from '../../src/lib/argon2-error-handler.js';

// `vi.hoisted` runs BEFORE every regular `import` (it shares the hoist
// phase with `vi.mock`), so dynamically importing the support module from
// inside hoisted scope is the only way `vi.mock(...)` can reach the
// shared kit. A bare `import { ... } from '../support/...'` would not be
// loaded yet when the hoisted mock factory runs. See
// `tests/support/argon2-error-mocks.ts:30-46` for the full rationale.
const { mockRunWithArgon2Slot, argon2SemaphoreMockFactory } = await vi.hoisted(
  async () =>
    (await import('../support/argon2-error-mocks.js')).buildArgon2RouteMockKit(),
);

const { dbStubFactory, redisStubFactory } = await import(
  '../support/argon2-error-mocks.js'
);

const appQueryMock = vi.fn();

vi.mock('../../src/app-db.js', () => ({
  getAppPool: () => ({ query: appQueryMock }),
}));

vi.mock('../../src/lib/argon2-semaphore.js', () => argon2SemaphoreMockFactory());
vi.mock('../../src/db.js', () => dbStubFactory());
vi.mock('../../src/redis.js', () => redisStubFactory());

const { createApp } = await import('../../src/app.js');
const {
  ArgonQueueFullError,
  ShuttingDownError,
  ArgonAbortError,
} = await import('../../src/lib/argon2-semaphore.js');

const app = createApp();

// Two dup-email seeds, one per `.catch()` site:
//   - `verify_token: null` → unverified-dup branch at auth.ts:401 (the
//     `if (existingRows[0].verify_token === null)` block).
//   - `verify_token: 'confirmed:<hex>'` → verified-dup branch at
//     auth.ts:416 (the `verify_token.startsWith('confirmed:')` block).
function seedUnverifiedDupRow(): void {
  appQueryMock.mockResolvedValueOnce({ rows: [{ verify_token: null }] });
}
function seedVerifiedDupRow(): void {
  appQueryMock.mockResolvedValueOnce({
    rows: [{ verify_token: `confirmed:${'a'.repeat(64)}` }],
  });
}

const SIGNUP_BODY = (emailLocal: string) => ({
  email: `${emailLocal}@mit.edu`,
  password: 'AnyPassword1',
  full_name: 'Test User',
  institution: 'MIT',
  field: 'CS',
});

describe('POST /api/signup — saturated dup-email returns 503, not 409 (round-3 P1 oracle fix)', () => {
  it('rethrows ArgonQueueFullError → 503 instead of swallowing → 409 (unverified-dup, auth.ts:401)', async () => {
    // Seed: existing unverified row. Handler reads `verify_token` and treats
    // null as "registered, unverified" → enters the burn `.catch()` path
    // with verify_token=null branch.
    appQueryMock.mockReset();
    seedUnverifiedDupRow();

    // Force the dup-email argon2.hash burn to throw queue-full.
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonQueueFullError());

    const res = await request(app)
      .post('/api/auth/signup')
      .send(SIGNUP_BODY('dup-saturated'));

    // Asserts 503 + SERVICE_UNAVAILABLE_MESSAGE + Retry-After: 5 +
    // details.reason: 'queue_full' (imported via the kit, which itself
    // imports the production constants — no hardcoded literals). The
    // `details.reason` machine-readable discriminator is what HTTP-only
    // canaries branch on to distinguish saturation from rolling-restart
    // drain (per BE-503-REASON-DISCRIMINATION).
    assert503QueueFull(res);
    expect(res.body.error?.details?.reason).toBe(ARGON_REASON_QUEUE_FULL);
    // Critical: NOT 409. Before the fix, the burn catch swallowed
    // ArgonQueueFullError and the handler fell through to the 409 path,
    // leaking email-existence under saturation.
    expect(res.status).not.toBe(409);
  });

  it('rethrows ShuttingDownError → 503 instead of swallowing → 409 (unverified-dup, auth.ts:401)', async () => {
    // Same dup-row seed; this time the burn fails with ShuttingDownError
    // (SIGTERM-drain scenario).
    appQueryMock.mockReset();
    seedUnverifiedDupRow();

    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ShuttingDownError());

    const res = await request(app)
      .post('/api/auth/signup')
      .send(SIGNUP_BODY('dup-shutdown'));

    // Asserts 503 + SERVICE_UNAVAILABLE_MESSAGE + Retry-After: 30 +
    // details.reason: 'shutdown_drain'. The shutdown-branch discriminator
    // lets a canary suppress alerts during deploy windows; queue-full
    // carries `queue_full` and pages.
    assert503Shutdown(res);
    expect(res.body.error?.details?.reason).toBe(ARGON_REASON_SHUTDOWN_DRAIN);
    expect(res.status).not.toBe(409);
  });

  it('still swallows non-semaphore burn failures (timing-oracle equalization preserved)', async () => {
    // A native argon2 failure (not a semaphore class) MUST stay swallowed:
    // the burn is best-effort wall-time equalization, and rethrowing an
    // unrelated error class would 500 the dup path while the happy path
    // 200s — a different oracle. The .catch() should log and fall through
    // to the 409.
    appQueryMock.mockReset();
    seedUnverifiedDupRow();

    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new Error('native argon2 boom'));

    const res = await request(app)
      .post('/api/auth/signup')
      .send(SIGNUP_BODY('dup-nativefail'));

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('DUPLICATE');
  });

  // ──────────────────────────────────────────────────────────────────────
  // ArgonAbortError silent-return coverage on each dup-burn site.
  //
  // Production at auth.ts:410 (unverified-dup) and auth.ts:419 (verified-
  // dup) re-throws via `if (err instanceof ArgonSemaphoreError) throw err;`.
  // ArgonAbortError extends ArgonSemaphoreError, so it propagates to the
  // outer catch → `handleArgonError` → silent return (no `res.status` /
  // `res.json` / `res.set` called). This guards a future mutation that
  // narrows the rethrow to `instanceof ArgonQueueFullError ||
  // instanceof ShuttingDownError` (which would swallow ArgonAbortError and
  // 409 the request — an oracle on the dup branch since the new-email
  // branch silent-returns).
  //
  // Two tests, one per dup-burn site, because the verified vs unverified
  // branches are independent code paths and a mutation to either alone
  // would be missed by a single-site assertion.
  // ──────────────────────────────────────────────────────────────────────

  it('ArgonAbortError → silent on unverified-dup burn site (auth.ts:401)', async () => {
    appQueryMock.mockReset();
    seedUnverifiedDupRow();
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonAbortError());

    const reqPromise = request(app)
      .post('/api/auth/signup')
      .send(SIGNUP_BODY('dup-unverified-abort'))
      .timeout({ deadline: 250 });

    await assertArgon2AbortIsSilent(reqPromise);
  });

  it('ArgonAbortError → silent on verified-dup burn site (auth.ts:416)', async () => {
    appQueryMock.mockReset();
    seedVerifiedDupRow();
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonAbortError());

    const reqPromise = request(app)
      .post('/api/auth/signup')
      .send(SIGNUP_BODY('dup-verified-abort'))
      .timeout({ deadline: 250 });

    await assertArgon2AbortIsSilent(reqPromise);
  });
});

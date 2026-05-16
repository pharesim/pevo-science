/**
 * Route-level integration tests for the fresh-auth gate on
 * `POST /api/settings/set-password`. Pins the BACKEND-SETTINGS-SET-PASSWORD-
 * FRESH-AUTH contract (per ARCHITECTURE.md § 6.4 + § 6.5 invariant #1): a
 * state-C account (passwordless ORCID-only) MUST present a valid fresh
 * ORCID re-auth proof to set its first password; the JWT alone is never
 * sufficient.
 *
 * Carve-out per root CLAUDE.md "Carve-out for deterministic edge-case
 * coverage":
 *
 * (a) No mocks. `verifyHiveSignature`, `getAppPool`, argon2, the
 *     fresh-auth primitive's storage tier (Redis + in-memory fallback) all
 *     run real. `issueFreshAuthToken` is invoked directly here in lieu of
 *     driving the full ORCID OAuth round-trip (mocking ORCID's provider
 *     endpoints per-test is impractical and the round-trip is exercised
 *     elsewhere in the ORCID suite); the function is the same primitive
 *     the real route would call, so the consume-side contract — which is
 *     what this suite is gating — runs end-to-end.
 *
 * (b) `verifyHiveSignature` is NOT mocked. Tests issue a real Bearer JWT
 *     signed with `config.sessionSecret` and the middleware verifies it.
 *
 * (c) Real-path companion: the existing
 *     `backend/tests/routes/custody-consent-ops.test.ts` exercises
 *     `issueFreshAuthToken` / `consumeFreshAuthToken` end-to-end on the
 *     broadcast route. Same risk class (fresh-auth proof storage,
 *     single-use, TTL, target binding) is covered there with the proof
 *     consumed via a different route surface.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { config } from '../../src/config.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';
import {
  issueFreshAuthToken,
  _resetFreshAuthMemStoreForTests,
  FRESH_AUTH_TTL_SECONDS,
  setPasswordFreshAuthTarget,
} from '../../src/lib/fresh-auth.js';

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

function bearer(username: string): string {
  return jwt.sign({ sub: username, custody: 'light' }, config.sessionSecret, { expiresIn: '1h' });
}

async function cleanup(username: string) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [username]).catch(() => {});
  await pool.query('DELETE FROM accounts WHERE username = $1', [username]).catch(() => {});
}

describe.skipIf(!dbReachable)('POST /api/settings/set-password — fresh-auth gate', () => {
  const STATE_C_USER = `setpw_fa_${RUN_ID}`;
  const STATE_C_EMAIL = `setpw_fa_${RUN_ID}@example.com`;
  const STATE_C_ORCID = `0000-0003-${RUN_ID.toString().slice(-4)}-0010`;
  const OTHER_USER = `setpw_fa_other_${RUN_ID}`;
  const OTHER_EMAIL = `setpw_fa_other_${RUN_ID}@example.com`;
  const OTHER_ORCID = `0000-0003-${RUN_ID.toString().slice(-4)}-0011`;

  beforeAll(async () => {
    await clearRateLimitKeys(['settings-write', 'settings-read', 'auth-login']);
    await cleanup(STATE_C_USER);
    await cleanup(OTHER_USER);
    const pool = getAppPool()!;
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, verify_token, orcid)
       VALUES ($1, $2, NULL, 'light', NULL, $3)`,
      [STATE_C_EMAIL, STATE_C_USER, STATE_C_ORCID],
    );
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, verify_token, orcid)
       VALUES ($1, $2, NULL, 'light', NULL, $3)`,
      [OTHER_EMAIL, OTHER_USER, OTHER_ORCID],
    );
  });

  beforeEach(() => {
    // Clear fresh-auth in-memory fallback between cases so a stray proof
    // from one test doesn't survive into the next. (Single-use semantics
    // already cover the canonical path; this just keeps the
    // mem-fallback tier clean.)
    _resetFreshAuthMemStoreForTests();
  });

  afterAll(async () => {
    await cleanup(STATE_C_USER);
    await cleanup(OTHER_USER);
  });

  it('rejects with 401 FRESH_AUTH_REQUIRED when fresh_auth_proof is missing', async () => {
    const res = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', `Bearer ${bearer(STATE_C_USER)}`)
      .send({ password: 'FreshPassword1' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(res.body.error.details?.reason).toBe('missing');

    // password_hash MUST remain NULL — no mutation on the rejection path.
    const pool = getAppPool()!;
    const { rows } = await pool.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM accounts WHERE username = $1',
      [STATE_C_USER],
    );
    expect(rows[0].password_hash).toBeNull();
  });

  it('rejects with 401 FRESH_AUTH_REQUIRED when proof was issued for a different user (cross-user replay)', async () => {
    // Mint a proof for OTHER_USER, attempt to use it on STATE_C_USER's
    // set-password request. The consume-side username binding rejects.
    const issued = await issueFreshAuthToken(
      OTHER_USER,
      'orcid',
      setPasswordFreshAuthTarget(OTHER_USER),
    );
    const res = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', `Bearer ${bearer(STATE_C_USER)}`)
      .send({ password: 'FreshPassword1', fresh_auth_proof: issued.token });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(res.body.error.details?.reason).toBe('username_mismatch');

    const pool = getAppPool()!;
    const { rows } = await pool.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM accounts WHERE username = $1',
      [STATE_C_USER],
    );
    expect(rows[0].password_hash).toBeNull();
  });

  it('rejects with 401 FRESH_AUTH_REQUIRED when proof mechanism is password (state C has no password to base it on)', async () => {
    // A password-mechanism proof on the null-hash branch is structurally
    // invalid: state C has no password registered, so a password
    // fresh-auth could only arise from a bug or misuse. Per ARCHITECTURE.md
    // § 6.4, ORCID is the only registered factor for state C. The proof
    // here passes the (token, username, target_hash) binding but is
    // rejected by the route's mechanism check.
    const issued = await issueFreshAuthToken(
      STATE_C_USER,
      'password',
      setPasswordFreshAuthTarget(STATE_C_USER),
    );
    const res = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', `Bearer ${bearer(STATE_C_USER)}`)
      .send({ password: 'FreshPassword1', fresh_auth_proof: issued.token });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(res.body.error.details?.reason).toBe('wrong_mechanism');

    const pool = getAppPool()!;
    const { rows } = await pool.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM accounts WHERE username = $1',
      [STATE_C_USER],
    );
    expect(rows[0].password_hash).toBeNull();
  });

  it('rejects with 401 FRESH_AUTH_REQUIRED when proof has expired / does not exist', async () => {
    // `consumeFreshAuthToken` collapses "never issued" and "TTL expired"
    // into a single rejection reason `expired` (the storage lookup is the
    // only signal — a missing entry could be either). Both arms exercise
    // the same route-side defense; this test drives the never-issued arm
    // since it is deterministic and does not require fake timers.
    //
    // The TTL boundary itself is locked at the library layer in
    // `tests/lib/fresh-auth.test.ts` (the round-4 hold #17 fake-timer
    // suite); pinning the TTL constant here ties the route to that
    // library guarantee so a route-layer change that mishandles the
    // expiry surface still fails this test.
    expect(FRESH_AUTH_TTL_SECONDS).toBe(300);

    const fakeProof = 'a'.repeat(64); // hex-shaped but unissued
    const res = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', `Bearer ${bearer(STATE_C_USER)}`)
      .send({ password: 'FreshPassword1', fresh_auth_proof: fakeProof });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(res.body.error.details?.reason).toBe('expired');

    const pool = getAppPool()!;
    const { rows } = await pool.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM accounts WHERE username = $1',
      [STATE_C_USER],
    );
    expect(rows[0].password_hash).toBeNull();
  });

  it('rejects with 401 FRESH_AUTH_REQUIRED when a proof is replayed after a successful consume (single-use)', async () => {
    // Single-use semantics: a proof consumed once cannot be re-used. The
    // canonical entry is deleted at consume; the second attempt sees the
    // empty storage and falls through to the `expired` reason (same as
    // never-issued). Pinning this on the route layer guards a refactor
    // that fails to delete on the success path (which would re-enable
    // replay against the broadcast surface too via the shared primitive).
    const pool = getAppPool()!;
    await pool.query('UPDATE accounts SET password_hash = NULL WHERE username = $1', [STATE_C_USER]);

    const issued = await issueFreshAuthToken(
      STATE_C_USER,
      'orcid',
      setPasswordFreshAuthTarget(STATE_C_USER),
    );
    const first = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', `Bearer ${bearer(STATE_C_USER)}`)
      .send({ password: 'FreshPassword1', fresh_auth_proof: issued.token });
    expect(first.status).toBe(200);

    // Reset the row to state C so the replay reaches the fresh-auth gate
    // (otherwise the 409 PASSWORD_ALREADY_SET branch short-circuits ahead
    // of the proof check).
    await pool.query('UPDATE accounts SET password_hash = NULL WHERE username = $1', [STATE_C_USER]);

    const replay = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', `Bearer ${bearer(STATE_C_USER)}`)
      .send({ password: 'FreshPassword1', fresh_auth_proof: issued.token });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(replay.body.error.details?.reason).toBe('expired');

    const after = await pool.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM accounts WHERE username = $1',
      [STATE_C_USER],
    );
    expect(after.rows[0].password_hash).toBeNull();
  });

  it('happy path — valid ORCID-mechanism proof transitions state C → state B', async () => {
    // Re-null password_hash in case a prior case landed it (the expired
    // case above intentionally drives the burn path).
    const pool = getAppPool()!;
    await pool.query('UPDATE accounts SET password_hash = NULL WHERE username = $1', [STATE_C_USER]);

    const issued = await issueFreshAuthToken(
      STATE_C_USER,
      'orcid',
      setPasswordFreshAuthTarget(STATE_C_USER),
    );
    const res = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', `Bearer ${bearer(STATE_C_USER)}`)
      .send({ password: 'FreshPassword1', fresh_auth_proof: issued.token });
    expect(res.status).toBe(200);

    const { rows } = await pool.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM accounts WHERE username = $1',
      [STATE_C_USER],
    );
    expect(rows[0].password_hash).not.toBeNull();
    // argon2id hash format pin — guards a refactor that drops argon2.
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);

    // The just-set password works for login (full E2E pin on the state
    // transition).
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: STATE_C_USER, password: 'FreshPassword1' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.data.token).toBeTruthy();
  });
});

/**
 * Password reset per account state (ARCHITECTURE.md section 6.1).
 *
 * `POST /api/auth/reset-request` mails a reset token to an email, and
 * `POST /api/auth/reset` trades the token for a new password. The rule both
 * routes enforce: reset rotates an existing password and never adds one. A row
 * whose `password_hash` is NULL is refused at both ends.
 *
 *   - `/reset-request` gives a passwordless row the unknown-email answer: the
 *     same status and body, the same sentinel argon2 burn, and no token.
 *   - `/reset` refuses an unexpired token on a passwordless row with the
 *     invalid-token answer an unknown token gets, and leaves the row
 *     unchanged. The token here is written directly, standing in for one
 *     issued before the gate existed or for a password dropped while the
 *     token was outstanding.
 *
 * Every state the table in section 6.1 enumerates is driven, in both of its
 * password shapes where it has two: A, B, C, D with and without a password, G
 * (email verified and unverified) with and without a password, E, F on the
 * email path, and F on the ORCID path. A row that carries a password has it
 * rotated, a passwordless row is refused, and nothing but the password, the
 * reset token and the revocation stamp changes on an accepted row.
 *
 * Rows are written directly in their section 6.1 shapes: these specs are about
 * what reset does to each shape, not about the routes that produce it. No
 * module is mocked. Postgres, Redis, argon2 and both routes run real; the
 * project `.env` leaves SMTP unconfigured, so an accepted request takes the
 * route's no-SMTP branch and the specs read the token back from the row.
 *
 * Every spec draws a fresh email, username and ORCID from `fresh()`, because
 * vitest re-runs a failed `it` body in place and an earlier attempt's row
 * would otherwise still hold them.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';
import { TIMING_ORACLE_FLOOR_MS } from '../support/timing-constants.js';

const app = createApp();

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

const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const ORCID_BAND = `0000-0005-${(RUN_ID % 10000).toString().padStart(4, '0')}`;
const OLD_PASSWORD = 'OldResetPass123';
const NEW_PASSWORD = 'NewResetPass456';
const RESET_OK_MESSAGE = 'Password has been reset. Please log in with your new password.';

const createdEmails = new Set<string>();
let seq = 0;

interface Identity {
  email: string;
  username: string;
  orcid: string;
}

function fresh(): Identity {
  seq += 1;
  const email = `reset_state_${RUN_ID}_${seq}@example.com`;
  createdEmails.add(email);
  return {
    email,
    username: `rst${SUFFIX}${seq.toString(36)}`,
    orcid: `${ORCID_BAND}-${seq.toString().padStart(4, '0')}`,
  };
}

function hexToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

interface StateShape {
  label: string;
  username: boolean;
  password: boolean;
  orcid: boolean;
  verifyToken: 'none' | 'hex' | 'confirmed';
  custody: 'light' | 'self' | null;
  upgraded: boolean;
}

// One row per section 6.1 state and password shape. `password` decides the
// outcome: true rotates, false is refused.
const STATES: StateShape[] = [
  { label: 'A', username: true, password: true, orcid: false, verifyToken: 'none', custody: 'light', upgraded: false },
  { label: 'B', username: true, password: true, orcid: true, verifyToken: 'none', custody: 'light', upgraded: false },
  { label: 'C', username: true, password: false, orcid: true, verifyToken: 'none', custody: 'light', upgraded: false },
  { label: 'D with a password', username: true, password: true, orcid: false, verifyToken: 'none', custody: 'self', upgraded: true },
  { label: 'D without a password', username: true, password: false, orcid: true, verifyToken: 'none', custody: 'self', upgraded: true },
  { label: 'G, email verified, with a password', username: true, password: true, orcid: true, verifyToken: 'none', custody: null, upgraded: false },
  { label: 'G, email verified, without a password', username: true, password: false, orcid: false, verifyToken: 'none', custody: null, upgraded: false },
  { label: 'G, email unverified, with a password', username: true, password: true, orcid: true, verifyToken: 'hex', custody: null, upgraded: false },
  { label: 'G, email unverified, without a password', username: true, password: false, orcid: false, verifyToken: 'hex', custody: null, upgraded: false },
  { label: 'E', username: false, password: true, orcid: false, verifyToken: 'hex', custody: null, upgraded: false },
  { label: 'F, email path', username: false, password: true, orcid: false, verifyToken: 'confirmed', custody: null, upgraded: false },
  { label: 'F, ORCID path', username: false, password: false, orcid: true, verifyToken: 'confirmed', custody: null, upgraded: false },
];

type AccountRow = Record<string, unknown> & {
  password_hash: string | null;
  reset_token: string | null;
  sessions_invalidated_at: Date | null;
};

// Columns reset must leave as it found them.
const STATE_COLUMNS = ['email', 'username', 'orcid', 'verify_token', 'custody', 'upgraded_at', 'expires_at'] as const;

let oldPasswordHash = '';

beforeAll(async () => {
  if (!dbReachable) return;
  oldPasswordHash = await argon2.hash(OLD_PASSWORD, { type: argon2.argon2id });
});

afterAll(async () => {
  if (!dbReachable || createdEmails.size === 0) return;
  await getAppPool()!.query('DELETE FROM accounts WHERE email = ANY($1)', [[...createdEmails]]);
});

async function seedRow(shape: StateShape, id: Identity): Promise<AccountRow> {
  const verifyToken = shape.verifyToken === 'none'
    ? null
    : shape.verifyToken === 'hex' ? hexToken() : `confirmed:${hexToken()}`;
  await getAppPool()!.query(
    `INSERT INTO accounts (email, username, password_hash, orcid, verify_token, custody, upgraded_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id.email,
      shape.username ? id.username : null,
      shape.password ? oldPasswordHash : null,
      shape.orcid ? id.orcid : null,
      verifyToken,
      shape.custody,
      shape.upgraded ? new Date() : null,
      verifyToken ? new Date(Date.now() + 3_600_000) : null,
    ],
  );
  return rowByEmail(id.email);
}

async function rowByEmail(email: string): Promise<AccountRow> {
  const { rows } = await getAppPool()!.query<AccountRow>('SELECT * FROM accounts WHERE email = $1', [email]);
  expect(rows, `row for ${email}`).toHaveLength(1);
  return rows[0];
}

function stateColumns(row: AccountRow): Record<string, unknown> {
  return Object.fromEntries(STATE_COLUMNS.map((c) => [c, row[c]]));
}

async function postResetRequest(email: string): Promise<{ res: request.Response; elapsed: number }> {
  await clearRateLimitKeys(['auth-reset-request']);
  const start = Date.now();
  const res = await request(app).post('/api/auth/reset-request').send({ email });
  return { res, elapsed: Date.now() - start };
}

async function postReset(token: string): Promise<request.Response> {
  await clearRateLimitKeys(['auth-reset']);
  return request(app).post('/api/auth/reset').send({ token, password: NEW_PASSWORD });
}

describe('password reset rotates an existing password and never adds one', () => {
  for (const shape of STATES.filter((s) => s.password)) {
    it.skipIf(!dbReachable)(`state ${shape.label}: reset-request issues a token and reset rotates the password`, async () => {
      const id = fresh();
      const before = await seedRow(shape, id);

      const unknown = await postResetRequest(fresh().email);
      const { res: requested } = await postResetRequest(id.email);
      expect(requested.status).toBe(200);
      expect(requested.body).toEqual(unknown.res.body);

      const issued = await rowByEmail(id.email);
      expect(issued.reset_token).toMatch(/^[0-9a-f]{64}$/);

      const reset = await postReset(issued.reset_token!);
      expect(reset.status, JSON.stringify(reset.body)).toBe(200);
      expect(reset.body.data.message).toBe(RESET_OK_MESSAGE);

      const after = await rowByEmail(id.email);
      expect(await argon2.verify(after.password_hash!, NEW_PASSWORD)).toBe(true);
      expect(after.reset_token).toBeNull();
      expect(after.sessions_invalidated_at).not.toBeNull();
      expect(stateColumns(after)).toEqual(stateColumns(before));
    });
  }

  for (const shape of STATES.filter((s) => !s.password)) {
    it.skipIf(!dbReachable)(`state ${shape.label}: reset-request answers as for an unknown email and issues no token`, async () => {
      const id = fresh();
      await seedRow(shape, id);

      const unknown = await postResetRequest(fresh().email);
      const { res, elapsed } = await postResetRequest(id.email);
      expect(res.status).toBe(unknown.res.status);
      expect(res.body).toEqual(unknown.res.body);
      // The unknown-email branch burns a sentinel argon2 verify. A refusal
      // that returned early would answer in a millisecond or two.
      expect(elapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);

      const after = await rowByEmail(id.email);
      expect(after.reset_token).toBeNull();
      expect(after.reset_token_expires_at).toBeNull();
    });

    it.skipIf(!dbReachable)(`state ${shape.label}: reset refuses an outstanding token with the invalid-token answer`, async () => {
      const id = fresh();
      await seedRow(shape, id);
      const token = hexToken();
      await getAppPool()!.query(
        'UPDATE accounts SET reset_token = $1, reset_token_expires_at = $2 WHERE email = $3',
        [token, new Date(Date.now() + 3_600_000), id.email],
      );
      const before = await rowByEmail(id.email);

      const unknown = await postReset(hexToken());
      const res = await postReset(token);
      expect(res.status).toBe(400);
      expect(res.body).toEqual(unknown.body);
      expect(res.body.error.code).toBe('INVALID_TOKEN');

      const after = await rowByEmail(id.email);
      expect(after.password_hash).toBeNull();
      expect(after.sessions_invalidated_at).toBeNull();
      expect(stateColumns(after)).toEqual(stateColumns(before));
    });
  }
});

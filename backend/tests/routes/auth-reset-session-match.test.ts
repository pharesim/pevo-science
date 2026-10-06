/**
 * What `POST /api/auth/reset` tells its caller about the session it carried,
 * and that a reset token rotates a password once.
 *
 * The success answer never names the account. A browser that is signed in
 * when its user completes a reset may send its session token as a bearer;
 * `data.session_ended` is true only when that token verifies and names the
 * account the reset just revoked. A bearer for another account, a forged or
 * malformed one, or none at all answers false, and none of them fails the
 * reset.
 *
 * The single-use spec makes two redemptions of one token both read it before
 * either writes: a separate connection holds the row lock until both UPDATEs
 * wait on it, then releases it. No module is mocked. Postgres, Redis, argon2
 * and the route run real.
 *
 * Rows are written directly in the state A shape (ARCHITECTURE.md section 6.1)
 * with an outstanding token. Every spec draws a fresh email and username,
 * because vitest re-runs a failed `it` body in place and an earlier attempt's
 * row would otherwise still hold them.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { config } from '../../src/config.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';

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
const OLD_PASSWORD = 'OldResetPass123';
const NEW_PASSWORD = 'NewResetPass456';
const OTHER_NEW_PASSWORD = 'OtherResetPass789';
const RESET_OK_MESSAGE = 'Password has been reset. Please log in with your new password.';

const createdEmails = new Set<string>();
let seq = 0;

interface Identity {
  email: string;
  username: string;
}

function fresh(): Identity {
  seq += 1;
  const email = `reset_match_${RUN_ID}_${seq}@example.com`;
  createdEmails.add(email);
  return { email, username: `rsm${SUFFIX}${seq.toString(36)}` };
}

function hexToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

let oldPasswordHash = '';

beforeAll(async () => {
  if (!dbReachable) return;
  oldPasswordHash = await argon2.hash(OLD_PASSWORD, { type: argon2.argon2id });
});

afterAll(async () => {
  if (!dbReachable || createdEmails.size === 0) return;
  await getAppPool()!.query('DELETE FROM accounts WHERE email = ANY($1)', [[...createdEmails]]);
});

/** Writes a state A row holding an unexpired reset token and returns the token. */
async function seedWithToken(id: Identity): Promise<string> {
  const token = hexToken();
  await getAppPool()!.query(
    `INSERT INTO accounts (email, username, password_hash, custody, reset_token, reset_token_expires_at)
     VALUES ($1, $2, $3, 'light', $4, $5)`,
    [id.email, id.username, oldPasswordHash, token, new Date(Date.now() + 3_600_000)],
  );
  return token;
}

async function passwordHashOf(email: string): Promise<string> {
  const { rows } = await getAppPool()!.query<{ password_hash: string }>(
    'SELECT password_hash FROM accounts WHERE email = $1',
    [email],
  );
  return rows[0].password_hash;
}

function sessionBearer(username: string, secret = config.sessionSecret): string {
  return jwt.sign({ sub: username, custody: 'light' }, secret, { expiresIn: '1h' });
}

async function postReset(token: string, authorization?: string): Promise<request.Response> {
  await clearRateLimitKeys(['auth-reset']);
  const req = request(app).post('/api/auth/reset');
  if (authorization) req.set('Authorization', authorization);
  return req.send({ token, password: NEW_PASSWORD });
}

describe('the reset answer says whether the carried session was for the reset account', () => {
  it.skipIf(!dbReachable)('a session token for the reset account answers true', async () => {
    const id = fresh();
    const token = await seedWithToken(id);

    const res = await postReset(token, `Bearer ${sessionBearer(id.username)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({ message: RESET_OK_MESSAGE, session_ended: true });
  });

  it.skipIf(!dbReachable)('a session token for another account answers false and the reset lands', async () => {
    const id = fresh();
    const token = await seedWithToken(id);

    const res = await postReset(token, `Bearer ${sessionBearer(fresh().username)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({ message: RESET_OK_MESSAGE, session_ended: false });
    expect(await argon2.verify(await passwordHashOf(id.email), NEW_PASSWORD)).toBe(true);
  });

  const unverifiable: Array<{ label: string; header: (username: string) => string }> = [
    { label: 'signed with another secret', header: (u) => `Bearer ${sessionBearer(u, crypto.randomBytes(32).toString('hex'))}` },
    { label: 'not a JWT', header: () => 'Bearer not-a-jwt' },
  ];
  for (const { label, header } of unverifiable) {
    it.skipIf(!dbReachable)(`a bearer naming the reset account but ${label} answers false and the reset lands`, async () => {
      const id = fresh();
      const token = await seedWithToken(id);

      const res = await postReset(token, header(id.username));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toEqual({ message: RESET_OK_MESSAGE, session_ended: false });
      expect(await argon2.verify(await passwordHashOf(id.email), NEW_PASSWORD)).toBe(true);
    });
  }
});

describe('a reset token rotates the password once', () => {
  it.skipIf(!dbReachable)('two redemptions that both read the token before either writes: one lands, one is refused', async () => {
    const id = fresh();
    const token = await seedWithToken(id);
    const pool = getAppPool()!;
    const unknown = await postReset(hexToken());

    const lock = await pool.connect();
    let open = false;
    try {
      await lock.query('BEGIN');
      open = true;
      await lock.query('SELECT id FROM accounts WHERE email = $1 FOR UPDATE', [id.email]);
      const { rows: [{ pid }] } = await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

      await clearRateLimitKeys(['auth-reset']);
      const both = Promise.all([
        request(app).post('/api/auth/reset').send({ token, password: NEW_PASSWORD }),
        request(app).post('/api/auth/reset').send({ token, password: OTHER_NEW_PASSWORD }),
      ]);

      // The route's token lookup takes no row lock, so both requests get past
      // it; each then waits in its UPDATE. Postgres queues the later waiter
      // behind the earlier one's tuple lock, so the count follows the chain of
      // blockers back to the held lock.
      const deadline = Date.now() + 15_000;
      for (;;) {
        const { rows: [{ waiting }] } = await pool.query<{ waiting: number }>(
          `WITH RECURSIVE blocked(pid) AS (
             SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
             UNION
             SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
           )
           SELECT count(*)::int AS waiting FROM blocked`,
          [pid],
        );
        if (waiting === 2) break;
        if (Date.now() > deadline) throw new Error(`expected 2 UPDATEs waiting on the row lock, saw ${waiting}`);
        await new Promise((r) => setTimeout(r, 25));
      }

      await lock.query('COMMIT');
      open = false;
      const [first, second] = await both;

      const statuses = [first.status, second.status].sort();
      expect(statuses, JSON.stringify([first.body, second.body])).toEqual([200, 400]);
      const [winner, loser] = first.status === 200 ? [first, second] : [second, first];
      expect(loser.body).toEqual(unknown.body);
      const winnerPassword = winner === first ? NEW_PASSWORD : OTHER_NEW_PASSWORD;
      expect(await argon2.verify(await passwordHashOf(id.email), winnerPassword)).toBe(true);
    } finally {
      if (open) await lock.query('ROLLBACK').catch(() => {});
      lock.release();
    }
  });
});

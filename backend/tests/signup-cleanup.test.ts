/**
 * Hourly signup cleanup (`cleanupExpiredSignups`): which `accounts` rows the
 * job deletes.
 *
 * Real-path test against the app Postgres: seeds one row per ARCHITECTURE.md
 * § 6.1 shape the job must decide about, runs the job's own predicate
 * (`ABANDONED_ACCOUNT_ROWS`) as a DELETE narrowed to the rows this file seeded,
 * and asserts which rows are gone. No mocking. The narrowing is what keeps the
 * run from reaping an expired row another test file has just seeded: vitest
 * runs two files at once here, and the job's own DELETE spans the table.
 *
 * The decision under test:
 *   - signup rows (state E/F, `username` NULL) keep the two expiry arms: an
 *     unverified row once its link has expired, any pending row after 30 days;
 *   - a state G row (username set, settings-registered email) is deleted only
 *     while its email is unverified, its link has expired, and it carries no
 *     password and no ORCID. A G row carrying a factor is never deleted, and a
 *     verified G row is never deleted.
 *
 * `describe.skipIf` skips when the app DB is unreachable (light dev configs).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { getAppPool } from '../src/app-db.js';
import { ABANDONED_ACCOUNT_ROWS } from '../src/signup-cleanup.js';

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

const MARKER = `sclean_${randomBytes(5).toString('hex')}`;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

interface SeedRow {
  label: string;
  username: string | null;
  verifyToken: string | null;
  passwordHash?: string | null;
  orcid?: string | null;
  expiresAt: Date | null;
  createdAt?: Date;
}

/** A unique, well-formed ORCID iD per seeded row (migration 007 refuses a
 *  duplicate non-null ORCID across the table). */
function uniqueOrcid(): string {
  const n = randomBytes(6).readUIntBE(0, 6);
  const d = (k: number) => String(Math.floor(n / 10 ** k) % 10000).padStart(4, '0');
  return `0009-${d(0)}-${d(4)}-${String(n % 1000).padStart(3, '0')}X`;
}

async function seed(row: SeedRow): Promise<number> {
  const pool = getAppPool()!;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, username, verify_token, password_hash, orcid, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()))
     RETURNING id`,
    [
      `${MARKER}_${row.label}@example.test`,
      row.username,
      row.verifyToken,
      row.passwordHash ?? null,
      row.orcid ?? null,
      row.expiresAt,
      row.createdAt ?? null,
    ],
  );
  return rows[0].id;
}

async function exists(id: number): Promise<boolean> {
  const pool = getAppPool()!;
  const { rowCount } = await pool.query('SELECT 1 FROM accounts WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

/** The job's DELETE, narrowed to this file's rows. */
async function runCleanup(): Promise<void> {
  const pool = getAppPool()!;
  await pool.query(
    `DELETE FROM accounts WHERE (${ABANDONED_ACCOUNT_ROWS}) AND email LIKE $1`,
    [`${MARKER}_%`],
  );
}

const hex = () => randomBytes(32).toString('hex');
const past = (ms: number) => new Date(Date.now() - ms);
const future = (ms: number) => new Date(Date.now() + ms);

describe.skipIf(!dbReachable)('signup cleanup predicate', () => {
  afterEach(async () => {
    const pool = getAppPool()!;
    await pool.query('DELETE FROM accounts WHERE email LIKE $1', [`${MARKER}_%`]);
  });

  it('deletes an expired unverified G row that carries no password and no ORCID', async () => {
    const id = await seed({
      label: 'g_bare',
      username: `${MARKER}_gbare`,
      verifyToken: hex(),
      expiresAt: past(HOUR_MS),
    });

    await runCleanup();

    expect(await exists(id)).toBe(false);
  });

  it('never deletes a G row that carries a password or an ORCID, on either expiry arm', async () => {
    // Both rows are past their link expiry AND older than 30 days, so a G arm
    // that forgot the factor terms, or a 30-day arm left unscoped to signup
    // rows, would reap them.
    const withOrcid = await seed({
      label: 'g_orcid',
      username: `${MARKER}_gorcid`,
      verifyToken: hex(),
      orcid: uniqueOrcid(),
      expiresAt: past(31 * DAY_MS),
      createdAt: past(32 * DAY_MS),
    });
    const withPassword = await seed({
      label: 'g_pw',
      username: `${MARKER}_gpw`,
      verifyToken: hex(),
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$placeholder$placeholder',
      expiresAt: past(31 * DAY_MS),
      createdAt: past(32 * DAY_MS),
    });

    await runCleanup();

    expect(await exists(withOrcid)).toBe(true);
    expect(await exists(withPassword)).toBe(true);
  });

  it('keeps a verified G row and an unverified G row whose link has not expired', async () => {
    const verified = await seed({
      label: 'g_verified',
      username: `${MARKER}_gver`,
      verifyToken: null,
      expiresAt: null,
      createdAt: past(32 * DAY_MS),
    });
    const fresh = await seed({
      label: 'g_fresh',
      username: `${MARKER}_gfresh`,
      verifyToken: hex(),
      expiresAt: future(HOUR_MS),
    });

    await runCleanup();

    expect(await exists(verified)).toBe(true);
    expect(await exists(fresh)).toBe(true);
  });

  it('still deletes an expired E row and a 30-day-old F row', async () => {
    const expiredE = await seed({
      label: 'e_expired',
      username: null,
      verifyToken: hex(),
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$placeholder$placeholder',
      expiresAt: past(HOUR_MS),
    });
    const oldF = await seed({
      label: 'f_old',
      username: null,
      verifyToken: `confirmed:${hex()}`,
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$placeholder$placeholder',
      expiresAt: past(30 * DAY_MS),
      createdAt: past(31 * DAY_MS),
    });
    const recentF = await seed({
      label: 'f_recent',
      username: null,
      verifyToken: `confirmed:${hex()}`,
      orcid: uniqueOrcid(),
      expiresAt: past(HOUR_MS),
    });

    await runCleanup();

    expect(await exists(expiredE)).toBe(false);
    expect(await exists(oldF)).toBe(false);
    // An F row inside its 30 days survives even past `expires_at`: the
    // link-expiry arm applies only to the unverified hex form.
    expect(await exists(recentF)).toBe(true);
  });
});

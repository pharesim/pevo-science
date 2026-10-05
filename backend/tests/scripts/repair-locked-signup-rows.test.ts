/**
 * The one-time operator repair under `backend/scripts` that deletes the
 * accounts rows carrying neither `verify_token` nor `username`, a combination
 * no state in ARCHITECTURE.md § 6.1 has.
 *
 * Coverage:
 *   (a) The delete step removes those rows, an email-path one and an
 *       ORCID-path one, and keeps a pending signup row in state E and in
 *       state F, a finalized state A row, and a state G row both verified
 *       and unverified.
 *   (b) The count step lists exactly the rows the delete step removes, and
 *       writes nothing: its transaction is never assigned a transaction id,
 *       which any write to any table would assign.
 *   (c) A second run of the delete step deletes nothing.
 *
 * Mock carve-out: none. Each step's file is read from disk and run verbatim
 * through `pg` against the real Postgres behind `getAppPool()`.
 *
 * Isolation: the steps name `accounts` unqualified, so each spec runs them on
 * a dedicated connection holding a temporary `accounts` table built LIKE the
 * real one. Postgres resolves an unqualified table name in the session's
 * temporary schema first, so a step reaches only the rows the spec seeded,
 * and its counts stay exact while other files write to the shared table.
 * `shadowAccounts` refuses to hand out a connection on which `accounts` does
 * not resolve to the temporary table, and the connection is destroyed rather
 * than returned to the pool, so the shadow never outlives its spec. Each spec
 * runs its steps in one transaction and rolls it back, so no step's write is
 * ever committed.
 *
 * Real-DB-required guard: `describe.skipIf(!dbReachable)`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { getAppPool } from '../../src/app-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COUNT_SQL = readFileSync(
  join(__dirname, '../../scripts/repair-locked-signup-rows-count.sql'),
  'utf8',
);
const DELETE_SQL = readFileSync(
  join(__dirname, '../../scripts/repair-locked-signup-rows-delete.sql'),
  'utf8',
);

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

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$placeholder$placeholder';
const HEX = 'a'.repeat(64);

/** One row per shape, inserted into the temporary table. */
const SEEDS = {
  lockedEmailPath: {
    sql: 'INSERT INTO accounts (email, password_hash) VALUES ($1, $2) RETURNING id',
    params: ['locked-email@example.org', HASH],
  },
  lockedOrcidPath: {
    sql: 'INSERT INTO accounts (email, orcid) VALUES (NULL, $1) RETURNING id',
    params: ['0000-0002-0000-0001'],
  },
  stateE: {
    sql: `INSERT INTO accounts (email, password_hash, verify_token, expires_at)
          VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours') RETURNING id`,
    params: ['pending-e@example.org', HASH, HEX],
  },
  stateF: {
    sql: `INSERT INTO accounts (email, password_hash, verify_token, expires_at)
          VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours') RETURNING id`,
    params: ['pending-f@example.org', HASH, `confirmed:${HEX}`],
  },
  stateA: {
    sql: `INSERT INTO accounts (email, username, password_hash, custody)
          VALUES ($1, $2, $3, 'light') RETURNING id`,
    params: ['finalized-a@example.org', 'repairseeda', HASH],
  },
  stateGVerified: {
    sql: 'INSERT INTO accounts (email, username) VALUES ($1, $2) RETURNING id',
    params: ['verified-g@example.org', 'repairseedg'],
  },
  stateGUnverified: {
    sql: `INSERT INTO accounts (email, username, verify_token, expires_at)
          VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours') RETURNING id`,
    params: ['unverified-g@example.org', 'repairseedgu', 'b'.repeat(64)],
  },
} as const;

type Seed = keyof typeof SEEDS;
const LOCKED: Seed[] = ['lockedEmailPath', 'lockedOrcidPath'];
const KEPT: Seed[] = ['stateE', 'stateF', 'stateA', 'stateGVerified', 'stateGUnverified'];

/** Opens a dedicated connection whose unqualified `accounts` is a temporary
 *  table seeded with one row per {@link SEEDS} entry, runs `body` inside a
 *  transaction it rolls back, then destroys the connection. */
async function shadowAccounts(
  body: (client: PoolClient, ids: Record<Seed, number>) => Promise<void>,
): Promise<void> {
  const client = await getAppPool()!.connect();
  try {
    await client.query('CREATE TEMPORARY TABLE accounts (LIKE public.accounts INCLUDING ALL)');
    const { rows } = await client.query<{ shadowed: boolean }>(
      `SELECT to_regclass('accounts') = to_regclass('pg_temp.accounts') AS shadowed`,
    );
    if (!rows[0].shadowed) throw new Error('accounts does not resolve to the temporary table');
    const ids = {} as Record<Seed, number>;
    for (const [name, seed] of Object.entries(SEEDS) as [Seed, (typeof SEEDS)[Seed]][]) {
      const res = await client.query<{ id: number }>(seed.sql, [...seed.params]);
      ids[name] = res.rows[0].id;
    }
    await client.query('BEGIN');
    try {
      await body(client, ids);
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    client.release(true);
  }
}

/** Runs one step's file inside the open transaction and reports whether that
 *  transaction has been assigned a transaction id. */
async function runStep(
  client: PoolClient,
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; wrote: boolean }> {
  const res = await client.query(sql);
  const xid = await client.query<{ xid: string | null }>(
    'SELECT txid_current_if_assigned()::text AS xid',
  );
  return { rows: res.rows, wrote: xid.rows[0].xid !== null };
}

const sortedIds = (rows: Record<string, unknown>[]): number[] =>
  rows.map((r) => Number(r.id)).sort((a, b) => a - b);
const idsOf = (ids: Record<Seed, number>, seeds: Seed[]): number[] =>
  seeds.map((s) => ids[s]).sort((a, b) => a - b);

describe.skipIf(!dbReachable)('repair of accounts rows with neither a token nor a username', () => {
  it('the delete step removes only the rows with neither column set', async () => {
    await shadowAccounts(async (client, ids) => {
      const step = await runStep(client, DELETE_SQL);
      expect(sortedIds(step.rows)).toEqual(idsOf(ids, LOCKED));
      expect(step.wrote).toBe(true);

      const { rows } = await client.query('SELECT id FROM accounts');
      expect(sortedIds(rows)).toEqual(idsOf(ids, KEPT));
    });
  });

  it('the count step lists the rows the delete step removes, and writes nothing', async () => {
    await shadowAccounts(async (client, ids) => {
      const step = await runStep(client, COUNT_SQL);
      expect(step.wrote).toBe(false);
      expect(step.rows).toEqual([
        expect.objectContaining({
          id: ids.lockedEmailPath,
          created_at: expect.any(Date),
          has_email: true,
          has_password: true,
          has_orcid: false,
        }),
        expect.objectContaining({
          id: ids.lockedOrcidPath,
          created_at: expect.any(Date),
          has_email: false,
          has_password: false,
          has_orcid: true,
        }),
      ]);

      const { rows } = await client.query('SELECT id FROM accounts');
      expect(sortedIds(rows)).toEqual(idsOf(ids, [...LOCKED, ...KEPT]));
    });
  });

  it('a second run of the delete step deletes nothing', async () => {
    await shadowAccounts(async (client, ids) => {
      await runStep(client, DELETE_SQL);
      const second = await runStep(client, DELETE_SQL);
      expect(second.rows).toEqual([]);

      const { rows } = await client.query('SELECT id FROM accounts');
      expect(sortedIds(rows)).toEqual(idsOf(ids, KEPT));
    });
  });
});

/**
 * Real-Postgres coverage for `findExistingAccreditation`
 * (`backend/src/lib/idempotency.ts`), the existing-accreditation gate of
 * POST /api/accreditation/verify: which latest `accredit` / `revoke` op makes
 * the gate hit, and which ORCID iD a miss carries.
 *
 * The production function runs its own SQL, unchanged, against a synthetic
 * `hafsql.operation_custom_json_view` and `hafsql.haf_operations` created
 * inside a transaction that is always rolled back. Seeding a `wot` accredit
 * on the public HAF needs a live broadcast and an indexing wait per test.
 *
 * Real-path companion for: `backend/tests/lib/idempotency.test.ts`
 *
 * Skips when APP_DATABASE_URL is unset (no local Postgres available).
 */

import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { findExistingAccreditation } from '../../src/lib/idempotency.js';
import { config } from '../../src/config.js';

const DB_URL = process.env.APP_DATABASE_URL;
const pool = DB_URL ? new pg.Pool({ connectionString: DB_URL, max: 1 }) : null;

afterAll(async () => {
  if (pool) await pool.end();
});

const ACCOUNT = 'gatesubject';

interface Op {
  action: 'accredit' | 'revoke';
  method?: string;
  orcid?: string;
  block: number;
  id: number;
}

/**
 * Build the synthetic views from `ops` (all for ACCOUNT, all signed by the
 * admin authority), run the REAL `findExistingAccreditation`, then ROLLBACK.
 */
async function gateFor(ops: Op[]) {
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA hafsql');
    // Column types mirror the real views: `json` is TEXT (queries cast it via
    // `::jsonb`) and `required_posting_auths` is JSONB (queried with `?|`).
    await client.query(
      `CREATE TABLE hafsql.operation_custom_json_view (
         custom_id text,
         json text,
         required_posting_auths jsonb,
         block_num integer,
         id bigint
       )`,
    );
    await client.query('CREATE TABLE hafsql.haf_operations (id bigint, included_trx_id text)');
    for (const op of ops) {
      const json: Record<string, unknown> = { action: op.action, account: ACCOUNT };
      if (op.method) json.method = op.method;
      if (op.orcid !== undefined) json.orcid = op.orcid;
      await client.query(
        `INSERT INTO hafsql.operation_custom_json_view (custom_id, json, required_posting_auths, block_num, id)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [config.appTag, JSON.stringify(json), JSON.stringify([config.hiveAdminAccount]), op.block, op.id],
      );
      await client.query('INSERT INTO hafsql.haf_operations (id, included_trx_id) VALUES ($1, $2)', [
        op.id,
        `trx-${op.id}`,
      ]);
    }
    return await findExistingAccreditation(client, ACCOUNT);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const ORCID = '0000-0002-1825-0097';
const MISS = { kind: 'miss', wot_orcid: null };

describe('findExistingAccreditation — gate predicate (real Postgres)', () => {
  it.skipIf(!pool)('misses when the latest op is a wot accredit', async () => {
    const gate = await gateFor([{ action: 'accredit', method: 'wot', block: 20, id: 1 }]);
    expect(gate).toEqual(MISS);
  });

  it.skipIf(!pool)('misses when a wot accredit follows an email accredit', async () => {
    const gate = await gateFor([
      { action: 'accredit', method: 'email', block: 10, id: 1 },
      { action: 'accredit', method: 'wot', block: 20, id: 2 },
    ]);
    expect(gate).toEqual(MISS);
  });

  it.skipIf(!pool).each(['email', 'orcid', 'manual'])(
    'hits with the op tx_id and block_num when the latest op is a %s accredit',
    async (method) => {
      const gate = await gateFor([{ action: 'accredit', method, orcid: ORCID, block: 30, id: 3 }]);
      expect(gate).toEqual({ kind: 'hit', tx_id: 'trx-3', block_num: 30 });
    },
  );

  it.skipIf(!pool)('hits when the latest accredit carries no method', async () => {
    const gate = await gateFor([{ action: 'accredit', block: 30, id: 3 }]);
    expect(gate).toEqual({ kind: 'hit', tx_id: 'trx-3', block_num: 30 });
  });

  it.skipIf(!pool)('hits on the email accredit that follows a wot accredit', async () => {
    const gate = await gateFor([
      { action: 'accredit', method: 'wot', orcid: ORCID, block: 20, id: 1 },
      { action: 'accredit', method: 'email', block: 40, id: 2 },
    ]);
    expect(gate).toEqual({ kind: 'hit', tx_id: 'trx-2', block_num: 40 });
  });

  it.skipIf(!pool)('misses when a revoke follows an email accredit', async () => {
    const gate = await gateFor([
      { action: 'accredit', method: 'email', block: 10, id: 1 },
      { action: 'revoke', block: 20, id: 2 },
    ]);
    expect(gate).toEqual(MISS);
  });

  it.skipIf(!pool)('carries the ORCID iD of a latest wot accredit on the miss', async () => {
    const gate = await gateFor([
      { action: 'accredit', method: 'email', block: 10, id: 1 },
      { action: 'accredit', method: 'wot', orcid: ORCID, block: 20, id: 2 },
    ]);
    expect(gate).toEqual({ kind: 'miss', wot_orcid: ORCID });
  });

  it.skipIf(!pool)('carries no ORCID when the latest wot accredit holds an empty orcid', async () => {
    const gate = await gateFor([{ action: 'accredit', method: 'wot', orcid: '', block: 20, id: 1 }]);
    expect(gate).toEqual(MISS);
  });

  it.skipIf(!pool)('carries no ORCID past a revoke that follows a wot accredit holding one', async () => {
    const gate = await gateFor([
      { action: 'accredit', method: 'wot', orcid: ORCID, block: 20, id: 1 },
      { action: 'revoke', block: 30, id: 2 },
    ]);
    expect(gate).toEqual(MISS);
  });
});

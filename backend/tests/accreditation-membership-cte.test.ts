/**
 * Real-Postgres coverage for the membership semantics encoded in
 * `activeAccreditationsCteBody` (hafsql.ts): sticky sanctions, legacy-revoke
 * reclassification, live WoT threshold (self-heal), and sanction-lift by a later
 * authority accredit.
 *
 * This runs the EXACT production builder SQL — no mocked pool, no hand-rewritten
 * query — against a synthetic `hafsql.operation_custom_json_view` created inside
 * a transaction that is ALWAYS rolled back, so no state leaks. The read-only
 * public HAF carries no sanctioned / below-threshold / legacy-revoked `pevotest`
 * accounts to exercise these branches, and broadcasting + waiting on HAF
 * indexing to seed them is impractical per-test; building the synthetic op set
 * locally is the only way to assert the CTE's membership rule against real SQL.
 *
 * Skips when APP_DATABASE_URL is unset (no local Postgres available). Per the
 * project test conventions this is a real-path test (real Postgres, real builder
 * SQL); only the INPUT rows are synthetic. No auth middleware is involved.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { buildWith, activeAccreditationsCteBody, firstAccreditedAnchorCteBody } from '../src/hafsql.js';
import { config } from '../src/config.js';

const DB_URL = process.env.APP_DATABASE_URL;
const pool = DB_URL ? new pg.Pool({ connectionString: DB_URL, max: 1 }) : null;

afterAll(async () => {
  if (pool) await pool.end();
});

interface Op {
  account?: string;
  action: 'accredit' | 'revoke' | 'vouch' | 'retract_vouch' | 'update_params';
  method?: string;
  type?: 'sanction';
  voucher?: string;
  vouchee?: string;
  params?: Record<string, unknown>;
  block: number;
  id: number;
}

function jsonFor(op: Op): Record<string, unknown> {
  const j: Record<string, unknown> = { action: op.action };
  if (op.account) j.account = op.account;
  if (op.method) j.method = op.method;
  if (op.type) j.type = op.type;
  if (op.voucher) j.voucher = op.voucher;
  if (op.vouchee) j.vouchee = op.vouchee;
  if (op.params) j.params = op.params;
  return j;
}

// vouch/retract_vouch are signed by the voucher; every other op is an authority
// op signed by the admin signer (in config.accreditationAuthorities).
function signerFor(op: Op): string[] {
  if (op.action === 'vouch' || op.action === 'retract_vouch') return [op.voucher!];
  return [config.hiveAdminAccount];
}

/**
 * Build a synthetic operation_custom_json_view, run the REAL membership builder,
 * return the accredited account set, then ROLLBACK.
 */
async function membershipFor(ops: Op[]): Promise<Set<string>> {
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA hafsql');
    // Column types mirror the real hafsql.operation_custom_json_view: `json` is
    // TEXT (queries cast it via `::jsonb`) and `required_posting_auths` is JSONB
    // (queried with the `?|` / `?` containment operators).
    await client.query(
      `CREATE TABLE hafsql.operation_custom_json_view (
         custom_id text,
         json text,
         required_posting_auths jsonb,
         block_num integer,
         id bigint
       )`,
    );
    for (const op of ops) {
      await client.query(
        `INSERT INTO hafsql.operation_custom_json_view (custom_id, json, required_posting_auths, block_num, id)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [config.appTag, JSON.stringify(jsonFor(op)), JSON.stringify(signerFor(op)), op.block, op.id],
      );
    }
    const cte = buildWith(1, activeAccreditationsCteBody);
    const res = await client.query<{ account: string }>(
      `${cte.sql} SELECT account FROM active_accreditations`,
      cte.params,
    );
    return new Set(res.rows.map((r) => r.account));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

// Three email-accredited anchors used as accredited vouchers throughout.
const anchors: Op[] = [
  { account: 'av1', action: 'accredit', method: 'email', block: 10, id: 1 },
  { account: 'av2', action: 'accredit', method: 'email', block: 11, id: 2 },
  { account: 'av3', action: 'accredit', method: 'email', block: 12, id: 3 },
];

function vouchesFor(vouchee: string, vouchers: string[], startBlock: number): Op[] {
  return vouchers.map((voucher, i) => ({
    action: 'vouch' as const,
    voucher,
    vouchee,
    block: startBlock + i,
    id: 100 + startBlock + i,
  }));
}

describe('activeAccreditationsCteBody — membership semantics (real Postgres)', () => {
  beforeAll(() => {
    if (!pool) {
      // eslint-disable-next-line no-console
      console.warn('APP_DATABASE_URL unset — skipping real-Postgres membership-CTE coverage');
    }
  });

  it.skipIf(!pool)('keeps authority-pinned accounts accredited', async () => {
    const accredited = await membershipFor(anchors);
    expect(accredited).toEqual(new Set(['av1', 'av2', 'av3']));
  });

  it.skipIf(!pool)('accredits a WoT account at or above threshold, drops one below (self-heal, no revoke)', async () => {
    const ops: Op[] = [
      ...anchors,
      { account: 'wally', action: 'accredit', method: 'wot', block: 20, id: 4 },
      ...vouchesFor('wally', ['av1', 'av2', 'av3'], 21), // 3 accredited vouchers >= 3
      { account: 'wendy', action: 'accredit', method: 'wot', block: 30, id: 5 },
      ...vouchesFor('wendy', ['av1', 'av2'], 31), // only 2 < 3
    ];
    const accredited = await membershipFor(ops);
    expect(accredited.has('wally')).toBe(true);
    expect(accredited.has('wendy')).toBe(false);
  });

  it.skipIf(!pool)('ignores a legacy (non-sanction) revoke — membership reverts to the latest accredit', async () => {
    const ops: Op[] = [
      { account: 'erin', action: 'accredit', method: 'email', block: 40, id: 6 },
      // Legacy WoT-threshold-drop revoke: no type:"sanction".
      { account: 'erin', action: 'revoke', block: 41, id: 7 },
    ];
    const accredited = await membershipFor(ops);
    expect(accredited.has('erin')).toBe(true);
  });

  it.skipIf(!pool)('suppresses a sanctioned account (sticky) regardless of vouch support', async () => {
    const ops: Op[] = [
      ...anchors,
      { account: 'dave', action: 'accredit', method: 'email', block: 50, id: 8 },
      { account: 'dave', action: 'revoke', type: 'sanction', block: 51, id: 9 },
      // A sanctioned WoT-style account with full vouch support stays suppressed.
      { account: 'grace', action: 'accredit', method: 'wot', block: 52, id: 10 },
      { account: 'grace', action: 'revoke', type: 'sanction', block: 53, id: 11 },
      ...vouchesFor('grace', ['av1', 'av2', 'av3'], 54),
    ];
    const accredited = await membershipFor(ops);
    expect(accredited.has('dave')).toBe(false);
    expect(accredited.has('grace')).toBe(false);
  });

  it.skipIf(!pool)('lifts a sanction with a later authority accredit', async () => {
    const ops: Op[] = [
      { account: 'frank', action: 'accredit', method: 'email', block: 60, id: 12 },
      { account: 'frank', action: 'revoke', type: 'sanction', block: 61, id: 13 },
      { account: 'frank', action: 'accredit', method: 'manual', block: 62, id: 14 },
    ];
    const accredited = await membershipFor(ops);
    expect(accredited.has('frank')).toBe(true);
  });

  it.skipIf(!pool)('does NOT lift a sanction with a later wot auto-accredit', async () => {
    const ops: Op[] = [
      ...anchors,
      { account: 'mona', action: 'accredit', method: 'email', block: 70, id: 15 },
      { account: 'mona', action: 'revoke', type: 'sanction', block: 71, id: 16 },
      // A wot accredit after the sanction must NOT lift it.
      { account: 'mona', action: 'accredit', method: 'wot', block: 72, id: 17 },
      ...vouchesFor('mona', ['av1', 'av2', 'av3'], 73),
    ];
    const accredited = await membershipFor(ops);
    expect(accredited.has('mona')).toBe(false);
  });

  it.skipIf(!pool)('reads the live WoT threshold from update_params (raises the bar)', async () => {
    const ops: Op[] = [
      ...anchors,
      // Raise threshold to 4; a wot account with only 3 vouchers now falls short.
      { action: 'update_params', params: { min_accreditations_for_wot: 4 }, block: 5, id: 50 },
      { account: 'tina', action: 'accredit', method: 'wot', block: 80, id: 18 },
      ...vouchesFor('tina', ['av1', 'av2', 'av3'], 81), // 3 < 4
    ];
    const accredited = await membershipFor(ops);
    expect(accredited.has('tina')).toBe(false);
  });

  it.skipIf(!pool)('does not count a sanctioned voucher toward a WoT threshold', async () => {
    const ops: Op[] = [
      ...anchors,
      // av3 gets sanctioned: only av1, av2 remain as accredited vouchers.
      { account: 'av3', action: 'revoke', type: 'sanction', block: 13, id: 60 },
      { account: 'nate', action: 'accredit', method: 'wot', block: 90, id: 19 },
      ...vouchesFor('nate', ['av1', 'av2', 'av3'], 91), // av3 sanctioned -> only 2 count
    ];
    const accredited = await membershipFor(ops);
    expect(accredited.has('av3')).toBe(false);
    expect(accredited.has('nate')).toBe(false);
  });
});

/**
 * Run the REAL firstAccreditedAnchorCteBody against synthetic ops + a synthetic
 * haf_blocks (block_num -> timestamp), return account -> accredited_since.
 * Block N is stamped at 2026-01-01T00:00:00Z + N seconds so ordering is visible.
 */
async function anchorFor(ops: Op[]): Promise<Map<string, string>> {
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA hafsql');
    await client.query(
      `CREATE TABLE hafsql.operation_custom_json_view (
         custom_id text, json text, required_posting_auths jsonb, block_num integer, id bigint)`,
    );
    await client.query('CREATE TABLE hafsql.haf_blocks (block_num integer PRIMARY KEY, timestamp timestamp without time zone)');
    const blocks = new Set<number>();
    for (const op of ops) {
      blocks.add(op.block);
      await client.query(
        `INSERT INTO hafsql.operation_custom_json_view (custom_id, json, required_posting_auths, block_num, id)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [config.appTag, JSON.stringify(jsonFor(op)), JSON.stringify(signerFor(op)), op.block, op.id],
      );
    }
    for (const b of blocks) {
      // Deterministic: block_num seconds past the epoch base, computed in JS so
      // $1 (block_num, integer) and $2 (timestamp text) keep distinct types.
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, b)).toISOString().slice(0, 19).replace('T', ' ');
      await client.query(
        `INSERT INTO hafsql.haf_blocks (block_num, timestamp) VALUES ($1, $2::timestamp)`,
        [b, ts],
      );
    }
    const cte = buildWith(1, firstAccreditedAnchorCteBody);
    const res = await client.query<{ account: string; accredited_since: string }>(
      `${cte.sql} SELECT account, accredited_since FROM first_accredited_at`,
      cte.params,
    );
    return new Map(res.rows.map((r) => [r.account, r.accredited_since]));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('firstAccreditedAnchorCteBody — tenure anchor (real Postgres)', () => {
  it.skipIf(!pool)('anchors on the EARLIEST accredit block time, formatted as ISO-8601 UTC', async () => {
    const anchor = await anchorFor([
      { account: 'alice', action: 'accredit', method: 'email', block: 10, id: 1 },
    ]);
    // block 10 -> 2026-01-01T00:00:10Z
    expect(anchor.get('alice')).toBe('2026-01-01T00:00:10Z');
  });

  it.skipIf(!pool)('does NOT move when a later accredit re-broadcast (metadata edit) lands', async () => {
    const anchor = await anchorFor([
      { account: 'alice', action: 'accredit', method: 'email', block: 10, id: 1 },
      // A metadata-edit re-broadcast at a much later block.
      { account: 'alice', action: 'accredit', method: 'email', block: 500, id: 2 },
    ]);
    expect(anchor.get('alice')).toBe('2026-01-01T00:00:10Z');
  });

  it.skipIf(!pool)('spans a sanction gap: counts the FIRST accredit even after sanction + re-accredit', async () => {
    const anchor = await anchorFor([
      { account: 'alice', action: 'accredit', method: 'email', block: 10, id: 1 },
      { account: 'alice', action: 'revoke', type: 'sanction', block: 20, id: 2 },
      { account: 'alice', action: 'accredit', method: 'manual', block: 30, id: 3 },
    ]);
    // Earliest accredit (block 10) is the anchor; the sanction and re-grant do
    // not reset it.
    expect(anchor.get('alice')).toBe('2026-01-01T00:00:10Z');
  });
});

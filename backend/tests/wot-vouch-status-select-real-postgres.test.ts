/**
 * Real-Postgres regression for the combined `vouchStatusSelect` shape — the
 * SELECT `getVouchStatus` runs to carry, in one read, BOTH an account's own
 * active-accreditation `method` (a scalar subquery) AND its accredited-only
 * voucher list (`COALESCE(json_agg(...) FILTER (...), '[]')` with NO `GROUP BY`).
 *
 * Why a real planner and not a result mock (per root CLAUDE.md "Running Tests"
 * carve-out + `test-haf-sql-selection-redirect-cte-from-synthetic-values`):
 *
 *   (a) The discriminating invariant is structural to the SQL: a vouchee with
 *       ZERO accredited vouchers must still return EXACTLY ONE row, with
 *       `self_method` populated and `vouches = []`. That is the
 *       all-vouches-retracted case the retract path must revoke on. A result
 *       mock supplies the row directly and so is blind to whether the scalar
 *       subquery + bare aggregate + missing-`GROUP BY` shape actually produces
 *       one group — exactly the property under test. The discriminating graph (a
 *       WoT-accredited account whose vouchers are absent or unaccredited) cannot
 *       be seeded into the live HAF chain mirror without broadcasting real
 *       custom_json and waiting out indexing lag, so this runs the production
 *       `vouchStatusSelect()` body verbatim against a live Postgres with the
 *       `active_accreditations` / `active_vouches` CTEs redirected at a synthetic
 *       `operation_custom_json_view` VALUES set (the same FROM-redirect technique
 *       as `active-vouches-signer-gate.test.ts` and `wot-broadcast-timeout.test.ts`).
 *   (b) No auth middleware: this SELECT sits below the route layer and is
 *       exercised through a raw `pg.Pool`, so there is no cryptographic
 *       verification to run real here.
 *   (c) Real-path companion: the assembled `getVouchStatus` response envelope and
 *       the single-read call accounting are covered by the mocked-pool specs in
 *       `tests/routes/wot-retract-cascaderevocation.test.ts`; this file is itself
 *       the real-path companion for the SELECT's SQL-shape risk class
 *       (aggregate-over-empty-set yields one row; the no-`GROUP BY` scalar +
 *       bare-aggregate shape does not raise), which no mocked-pool test can cover.
 *       Skips when no Postgres is configured, mirroring the sibling real-DB tests
 *       so CI without a DB stays green.
 */

import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { config } from '../src/config.js';
import { activeAccreditationsCteBody, activeVouchesCteBody, buildWith, T } from '../src/hafsql.js';
import { vouchStatusSelect } from '../src/wot.js';

const DB_URL = process.env.APP_DATABASE_URL || process.env.HAF_DATABASE_URL?.split(',')[0];
const pool = DB_URL ? new pg.Pool({ connectionString: DB_URL, max: 1 }) : null;

afterAll(async () => {
  if (pool) await pool.end();
});

interface VouchRow {
  self_method: string | null;
  vouches: Array<{ voucher: string; relationship: string; timestamp: string }>;
}

/**
 * Run the production `vouchStatusSelect()` against the synthetic graph and
 * return the single result row (or null if the SELECT returned none — which,
 * for this no-`GROUP BY` shape, would itself be a regression).
 *
 * `accreditations` is a list of [account, method] pairs (each becomes an
 * `accredit` custom_json signed by an accreditation authority); `vouches` is a
 * list of [voucher, vouchee] pairs (each a `vouch` custom_json signed by the
 * voucher). The CTE bodies are the real ones from `hafsql.ts`, only their FROM
 * redirected at the synthetic `synthetic_cj` relation.
 */
async function runVouchStatus(opts: {
  accreditations: Array<[string, string]>;
  vouches: Array<[string, string]>;
  vouchee: string;
}): Promise<VouchRow | null> {
  // Build the real CTE block, then redirect its FROM at the synthetic set. The
  // accred/vouch CTE bodies each reference `${T.customJson} cj`; both collapse
  // to the same synthetic relation. `buildWith()` prefixes `WITH `; strip it so
  // our own `synthetic_cj` CTE can lead the combined WITH block.
  const cte = buildWith(1, activeAccreditationsCteBody, activeVouchesCteBody);
  const cteBodies = cte.sql.replace(/^\s*WITH\s+/, '');
  const redirectedCte = cteBodies.split(`${T.customJson} cj`).join('synthetic_cj cj');
  // Guard: if the table-reference string drifts (a CTE-alias or whitespace
  // change in the real CTE bodies), the split no-ops and the SELECT would
  // silently run against the LIVE HAF view instead of the synthetic graph,
  // passing or failing for the wrong reason. Assert the redirect consumed the
  // real view literal. Mirrors active-vouches-signer-gate.test.ts.
  expect(redirectedCte).not.toContain(T.customJson);

  const valueLines: string[] = [];
  // cte.params already carries [appTag, authorities, appTag] for the two bodies;
  // $1 is the appTag bind reused as every synthetic row's custom_id.
  const params: unknown[] = [...cte.params];
  const appTagParam = '$1';
  // block_num orders rows for the per-account/per-pair ROW_NUMBER ranking; the
  // synthetic `id` column stands in for the real view's `cj.id`. Neither value
  // is asserted on — only their column presence matters so the real CTE bodies
  // compile.
  let block = 100;
  for (const [account, method] of opts.accreditations) {
    const jsonIdx = params.push(JSON.stringify({ action: 'accredit', account, method, name: account }));
    // Accreditation rows must be signed by an accreditation authority for the
    // `?| accreditationAuthorities` gate to admit them. config.hiveAdminAccount
    // is always in that set.
    const authsIdx = params.push(JSON.stringify([config.hiveAdminAccount]));
    valueLines.push(`('id-'||${block}, ${appTagParam}::text, $${jsonIdx}::text, $${authsIdx}::jsonb, ${block++}::bigint)`);
  }
  for (const [voucher, vouchee] of opts.vouches) {
    const jsonIdx = params.push(JSON.stringify({ action: 'vouch', voucher, vouchee, relationship: 'colleague' }));
    // Vouch rows must be signed by the voucher (`required_posting_auths ? voucher`).
    const authsIdx = params.push(JSON.stringify([voucher]));
    valueLines.push(`('id-'||${block}, ${appTagParam}::text, $${jsonIdx}::text, $${authsIdx}::jsonb, ${block++}::bigint)`);
  }

  const usernameParam = `$${params.push(opts.vouchee)}`;

  const sql = `
    WITH synthetic_cj(id, custom_id, json, required_posting_auths, block_num) AS (
      VALUES
        ${valueLines.join(',\n        ')}
    ),${redirectedCte}
    ${vouchStatusSelect(usernameParam)}`;

  const result = await pool!.query<VouchRow>(sql, params);
  return result.rows[0] ?? null;
}

describe('vouchStatusSelect — combined self_method + vouches read (real Postgres)', () => {
  it.skipIf(!pool)(
    'returns exactly one row with self_method populated and vouches=[] for a WoT account with zero accredited vouchers',
    { timeout: 30_000 },
    async () => {
      // `lonely` is WoT-accredited but has ZERO accredited vouchers: it is
      // vouched only by `nobody`, who is NOT in the accreditation set, so the
      // inner JOIN drops that edge and the aggregate runs over an empty set. The
      // retract path's revoke decision hinges on this exact case surviving as a
      // single row with the method intact (an all-vouches-retracted vouchee).
      const row = await runVouchStatus({
        accreditations: [
          ['lonely', 'wot'],
          // `nobody` is intentionally NOT accredited, so the (nobody -> lonely)
          // vouch contributes no accredited voucher.
        ],
        vouches: [['nobody', 'lonely']],
        vouchee: 'lonely',
      });

      // The aggregate-over-empty-set + scalar-subquery + no-GROUP-BY shape yields
      // EXACTLY ONE row, not zero. A regression to GROUP BY / an inner-join-only
      // shape that loses the row would null the method and never revoke.
      expect(row).not.toBeNull();
      // self_method survives even with no accredited vouchers.
      expect(row!.self_method).toBe('wot');
      // COALESCE(..., '[]') collapses the empty-set aggregate to an empty array.
      expect(row!.vouches).toEqual([]);
    },
  );

  it.skipIf(!pool)(
    'aggregates the accredited vouchers (and only the accredited ones) into vouches',
    { timeout: 30_000 },
    async () => {
      // `target` is WoT-accredited and vouched by three accounts, two of which
      // are accredited (`acc1`, `acc2`) and one of which is not (`unacc`). The
      // inner JOIN keeps only the accredited vouchers, so `vouches` carries
      // exactly acc1 + acc2 and the scalar subquery still reports the method.
      const row = await runVouchStatus({
        accreditations: [
          ['target', 'wot'],
          ['acc1', 'email'],
          ['acc2', 'orcid'],
          // `unacc` is intentionally absent from the accreditation set.
        ],
        vouches: [
          ['acc1', 'target'],
          ['acc2', 'target'],
          ['unacc', 'target'],
        ],
        vouchee: 'target',
      });

      expect(row).not.toBeNull();
      expect(row!.self_method).toBe('wot');
      const vouchers = row!.vouches.map((v) => v.voucher).sort();
      // Only the two accredited vouchers; the unaccredited edge is JOIN-dropped.
      expect(vouchers).toEqual(['acc1', 'acc2']);
    },
  );

  it.skipIf(!pool)(
    'returns a null self_method for an unaccredited vouchee while still yielding one row',
    { timeout: 30_000 },
    async () => {
      // `stranger` is NOT accredited (no `accredit` row) but IS vouched by one
      // accredited account. The scalar subquery finds no active accreditation, so
      // self_method is null; the vouches aggregate still carries the accredited
      // voucher. The bare-aggregate shape still produces a single row (it does
      // not raise on the null scalar subquery).
      const row = await runVouchStatus({
        accreditations: [['acc1', 'email']],
        vouches: [['acc1', 'stranger']],
        vouchee: 'stranger',
      });

      expect(row).not.toBeNull();
      expect(row!.self_method).toBeNull();
      expect(row!.vouches.map((v) => v.voucher)).toEqual(['acc1']);
    },
  );
});

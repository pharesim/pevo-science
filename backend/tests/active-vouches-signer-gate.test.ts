import { describe, it, expect } from 'vitest';
import { getPool, isHafConfigured } from '../src/db.js';
import { T, activeVouchesCteBody } from '../src/hafsql.js';
import { config } from '../src/config.js';

/**
 * Coverage for the `required_posting_auths ? voucher` signer gate on
 * `activeVouchesCteBody`'s `vouch_ranked` CTE. Without the gate, any account
 * could broadcast a `vouch` or `retract_vouch` naming a stranger as `voucher`:
 * a forged `vouch` mints an unauthorized web-of-trust edge (driving WoT
 * auto-accreditation), and a forged `retract_vouch` silently supersedes a
 * legitimate prior vouch via the latest-block-wins `ROW_NUMBER` ranking.
 *
 * Carve-out clause-(a): the CTE reads HAF's custom_json mirror, which cannot be
 * seeded at test time (it is an external chain-mirror; the forged-vs-legit row
 * pairs these cases require cannot be produced without broadcasting forged ops).
 * Each behavioral case runs the REAL `activeVouchesCteBody().sql` (only its
 * `FROM` redirected to a synthetic `WITH (VALUES ...)` set) through the real
 * `getPool()` Postgres connection, so the actual `?` predicate and ranking are
 * exercised, not a hand-rewritten mirror.
 *
 * Clause-(b): this CTE sits behind no auth middleware. The signer gate is
 * enforced in SQL against the on-chain `required_posting_auths` array, not by
 * request-signature verification, so there is no cryptographic middleware to
 * run real in this path.
 *
 * Clause-(c): `getVouchStatus` (the assembled WoT read path that consumes this
 * CTE) runs against the live HAF corpus in its own integration coverage via the
 * `GET /api/wot/:username` route in `tests/routes/wot.test.ts`;
 * `broadcastWotAccreditation` is exercised only in mocked form
 * (`wot-broadcast-timeout.test.ts`), not live. These synthetic cases pin the
 * gate's filter semantics the live corpus cannot seed.
 */

// One synthetic custom_json row. `requiredPostingAuths` is the on-chain signer
// set; `voucher` is the account the payload claims acted. The gate passes the
// row only when the signer set contains the claimed voucher.
function row(
  action: 'vouch' | 'retract_vouch',
  voucher: string,
  vouchee: string,
  requiredPostingAuths: string[],
): { json: string; auths: string } {
  return {
    json: JSON.stringify({ action, voucher, vouchee }),
    auths: JSON.stringify(requiredPostingAuths),
  };
}

// Scenario rows, lowest block first; block_num is assigned by position so a
// later row in a (voucher, vouchee) pair is the latest action.
const SCENARIO = [
  // Legit vouch: signer == voucher -> active.
  row('vouch', 'alice', 'bob', ['alice']),
  // Forged vouch: mallory signs but names alice -> filtered, never active.
  row('vouch', 'alice', 'mallory', ['mallory']),
  // Legit vouch for (carol, dave) ...
  row('vouch', 'carol', 'dave', ['carol']),
  // ... then a FORGED retract (mallory signs, names carol): must be filtered,
  // so it cannot supersede the legit vouch above.
  row('retract_vouch', 'carol', 'dave', ['mallory']),
  // Legit vouch for (erin, frank) ...
  row('vouch', 'erin', 'frank', ['erin']),
  // ... then a LEGIT retract (erin signs): passes the gate and, as the latest
  // action, supersedes the vouch -> (erin, frank) not active.
  row('retract_vouch', 'erin', 'frank', ['erin']),
  // Legit vouch whose signer set is a multi-auth posting authority that
  // INCLUDES the voucher -> `?` still matches -> active.
  row('vouch', 'grace', 'ivan', ['grace', 'cosigner']),
];

describe('activeVouchesCteBody — required_posting_auths signer gate', () => {
  it.skipIf(!isHafConfigured())(
    'filters forged vouches/retracts while preserving legitimately signed ones',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      const body = activeVouchesCteBody(1);
      // Redirect the CTE's FROM at the real HAF view to the synthetic row set;
      // everything else (the `?` gate, the per-pair ROW_NUMBER ranking, the
      // rn=1 AND action='vouch' active filter) is the production SQL verbatim.
      const redirected = body.sql.replace(T.customJson, 'synthetic_cj');
      // Guard: if the table-reference string drifts, the redirect silently
      // no-ops and the gate would run against nothing, failing the behavioral
      // assertions only indirectly. Fail fast here instead.
      expect(redirected).not.toContain(T.customJson);

      // $1 is the body's custom_id bind (also reused as every synthetic row's
      // custom_id so the WHERE custom_id = $1 matches). $2.. carry the per-row
      // json + required_posting_auths; block_num and id are positional
      // (100 + index). id is the same-block ROW_NUMBER tie-breaker the
      // production SQL orders on; every distinct block here keeps it inert.
      const valueLines: string[] = [];
      const params: unknown[] = [config.appTag];
      SCENARIO.forEach((r, i) => {
        const jsonIdx = params.push(r.json);
        const authsIdx = params.push(r.auths);
        valueLines.push(`($1::text, $${jsonIdx}::text, $${authsIdx}::jsonb, ${100 + i}::bigint, ${100 + i}::bigint)`);
      });

      const sql = `
        WITH synthetic_cj(custom_id, json, required_posting_auths, block_num, id) AS (
          VALUES
            ${valueLines.join(',\n            ')}
        ),${redirected}
        SELECT voucher, vouchee FROM active_vouches ORDER BY voucher, vouchee
      `;

      const result = await pool.query<{ voucher: string; vouchee: string }>(sql, params);
      const active = result.rows.map((r) => `${r.voucher}/${r.vouchee}`);

      // Legitimately signed vouches survive (including the multi-auth one).
      expect(active).toContain('alice/bob');
      expect(active).toContain('grace/ivan');
      // The legit (carol, dave) vouch survives the FORGED retract.
      expect(active).toContain('carol/dave');
      // Forged vouch (mallory signs, names alice) never becomes active.
      expect(active).not.toContain('alice/mallory');
      // Legit retract supersedes the legit vouch.
      expect(active).not.toContain('erin/frank');
      // Exactly the three legitimate, un-retracted vouches.
      expect(active).toEqual(['alice/bob', 'carol/dave', 'grace/ivan']);
    },
  );

  it('source carries the required_posting_auths ? voucher gate', () => {
    // SQL-shape canary: a future edit that drops the gate is caught even if the
    // behavioral row set above is changed.
    expect(activeVouchesCteBody().sql).toContain(
      "cj.required_posting_auths ? (cj.json::jsonb ->> 'voucher')",
    );
  });
});

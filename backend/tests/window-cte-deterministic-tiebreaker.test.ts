import { describe, it, expect } from 'vitest';
import { getPool, isHafConfigured } from '../src/db.js';
import { T, activeAccreditationsCteBody, activeVouchesCteBody, accreditedVoteCount } from '../src/hafsql.js';
import { config } from '../src/config.js';

/**
 * Same-block deterministic tie-breaker coverage for the "latest op wins"
 * computations that key on `block_num` alone.
 *
 * The HAF mirror views have no `trx_in_block` column (`operation_vote_view`
 * projects `id, timestamp, voter, author, weight, permlink, block_num`;
 * `operation_custom_json_view` projects `id, timestamp, required_auths,
 * required_posting_auths, custom_id, json, block_num`), so the monotonic HAF
 * op `id` is the same-block secondary key per
 * `agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md`
 * Rule 2. Without the secondary key, two ops affecting the same subject in the
 * same 3-second block resolve non-deterministically (the planner is free to
 * pick either row for `rn = 1` / `DISTINCT ON`).
 *
 * Carve-out clause-(a): these CTEs read HAF's chain mirror, which cannot be
 * seeded at test time (it is an external chain-mirror; the same-block op pairs
 * these cases require cannot be produced without broadcasting same-block ops on
 * a live chain). Each case runs the REAL production SQL
 * (`activeAccreditationsCteBody().sql`, `accreditedVoteCount(...)`) with only
 * its `FROM` redirected to a synthetic `WITH (VALUES ...)` set, exercised
 * through the real `getPool()` Postgres connection. The ROW_NUMBER / DISTINCT
 * ON ordering under test is the production clause verbatim.
 *
 * Clause-(b): these CTEs sit behind no auth middleware — they are SQL building
 * blocks for HAF reads. There is no cryptographic verification in this path to
 * preserve.
 *
 * Clause-(c): the assembled accreditation and vote-count read paths run against
 * the live HAF corpus in their own integration coverage; these synthetic cases
 * pin the same-block ordering determinism the live corpus cannot seed.
 *
 * Scope note — inline accreditation-state reads NOT covered by the SQL-shape
 * canary below: the "latest accredit/revoke wins" reads in `routes/orcid.ts`
 * (`findAccreditedAccountWithOrcid`'s first read + its binding-live re-check,
 * and `getExistingAccreditation`) and `routes/profile.ts`
 * (`getAccreditationFromHaf`) also carry the `block_num DESC, id DESC`
 * tie-breaker. They are inline `pool.query` strings, not exported SQL fragments,
 * so the canary's `toContain` assertion cannot reach them; their determinism is
 * exercised by their own route integration tests against the live HAF corpus.
 * The canary asserts only the exported-fragment sites; a future edit dropping
 * the tie-breaker from an inline read is caught at route-test level, not here.
 */

function runAccredCte(
  // Each row: action, account, block_num, op id. The synthetic rows always
  // carry an accreditation-authority signer so the `?|` gate passes.
  rows: Array<{ action: 'accredit' | 'revoke'; account: string; blockNum: number; id: number }>,
): Promise<Set<string>> {
  const pool = getPool();
  if (!pool) throw new Error('no pool');

  const body = activeAccreditationsCteBody(1);
  // Redirect the CTE's FROM at the real HAF view to the synthetic row set;
  // everything else (the `?|` gate, the per-account ROW_NUMBER ranking with the
  // `cj.id DESC` same-block tie-breaker, the rn=1 AND action='accredit' filter)
  // is the production SQL verbatim.
  const redirected = body.sql.replace(`${T.customJson} cj`, 'synthetic_cj cj');

  // $1 = custom_id bind (reused as every synthetic row's custom_id so the
  // WHERE custom_id = $1 matches). $2 = authority array for the `?|` gate.
  const params: unknown[] = [config.appTag, config.accreditationAuthorities];
  const authsLiteral = JSON.stringify(config.accreditationAuthorities);
  const valueLines: string[] = [];
  rows.forEach((r) => {
    const json = JSON.stringify({ action: r.action, account: r.account });
    const jsonIdx = params.push(json);
    const authsIdx = params.push(authsLiteral);
    valueLines.push(
      `($1::text, $${jsonIdx}::text, $${authsIdx}::jsonb, ${r.blockNum}::bigint, ${r.id}::bigint)`,
    );
  });

  const sql = `
    WITH synthetic_cj(custom_id, json, required_posting_auths, block_num, id) AS (
      VALUES
        ${valueLines.join(',\n        ')}
    ),${redirected}
    SELECT account FROM active_accreditations ORDER BY account
  `;

  return pool
    .query<{ account: string }>(sql, params)
    .then((res) => new Set(res.rows.map((x) => x.account)));
}

function runVoteCount(
  // Each row: voter, weight, block_num, op id. All votes target the same
  // (author, permlink) and the voter is pre-seeded as accredited.
  rows: Array<{ voter: string; weight: number; blockNum: number; id: number }>,
): Promise<number> {
  const pool = getPool();
  if (!pool) throw new Error('no pool');

  // The real vote-count fragment, with its FROM redirected to a synthetic vote
  // set. It requires `active_accreditations` in scope; we provide a synthetic
  // one. The `DISTINCT ON (v.voter) ... ORDER BY v.voter, v.block_num DESC,
  // v.id DESC` clause under test is the production clause verbatim.
  const countExpr = accreditedVoteCount("'paper-author'", "'paper-permlink'").replace(
    `${T.voteOps} v`,
    'synthetic_v v',
  );

  const params: unknown[] = [];
  const voteValueLines: string[] = [];
  const voters = new Set<string>();
  rows.forEach((r) => {
    voters.add(r.voter);
    const voterIdx = params.push(r.voter);
    const weightIdx = params.push(r.weight);
    voteValueLines.push(
      `('paper-author'::text, 'paper-permlink'::text, $${voterIdx}::text, $${weightIdx}::int, ${r.blockNum}::bigint, ${r.id}::bigint)`,
    );
  });
  const accredValueLines = [...voters].map((v) => {
    const idx = params.push(v);
    return `($${idx}::text)`;
  });

  const sql = `
    WITH synthetic_v(author, permlink, voter, weight, block_num, id) AS (
      VALUES
        ${voteValueLines.join(',\n        ')}
    ),
    active_accreditations(account) AS (
      VALUES
        ${accredValueLines.join(',\n        ')}
    )
    SELECT ${countExpr} AS net
  `;

  return pool.query<{ net: number }>(sql, params).then((res) => Number(res.rows[0]?.net ?? 0));
}

describe('window CTE / vote DISTINCT ON — same-block deterministic tie-breaker', () => {
  it.skipIf(!isHafConfigured())(
    'same-block accredit/revoke resolves deterministically to the higher op id',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Account `alice`: accredit and revoke land in the SAME block. The op with
      // the higher id is the later op and must win, regardless of VALUES order.

      // revoke has the higher id -> alice ends NOT active.
      const revokeWins = await runAccredCte([
        { action: 'accredit', account: 'alice', blockNum: 100, id: 10 },
        { action: 'revoke', account: 'alice', blockNum: 100, id: 11 },
      ]);
      expect(revokeWins.has('alice')).toBe(false);

      // Same rows, reversed VALUES order — result must be identical (deterministic).
      const revokeWinsReordered = await runAccredCte([
        { action: 'revoke', account: 'alice', blockNum: 100, id: 11 },
        { action: 'accredit', account: 'alice', blockNum: 100, id: 10 },
      ]);
      expect(revokeWinsReordered.has('alice')).toBe(false);

      // accredit has the higher id -> alice ends active.
      const accreditWins = await runAccredCte([
        { action: 'revoke', account: 'alice', blockNum: 100, id: 20 },
        { action: 'accredit', account: 'alice', blockNum: 100, id: 21 },
      ]);
      expect(accreditWins.has('alice')).toBe(true);

      // Reversed VALUES order — identical result.
      const accreditWinsReordered = await runAccredCte([
        { action: 'accredit', account: 'alice', blockNum: 100, id: 21 },
        { action: 'revoke', account: 'alice', blockNum: 100, id: 20 },
      ]);
      expect(accreditWinsReordered.has('alice')).toBe(true);
    },
  );

  it.skipIf(!isHafConfigured())(
    'same-block toggle votes resolve deterministically to the higher op id',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Voter `bob`: an upvote and a later downvote (weight 0) land in the SAME
      // block. The higher-id op is the latest and decides bob's net contribution.

      // Downvote-to-zero has the higher id -> bob's latest weight is 0 -> net 0.
      const unvoteWins = await runVoteCount([
        { voter: 'bob', weight: 10000, blockNum: 200, id: 30 },
        { voter: 'bob', weight: 0, blockNum: 200, id: 31 },
      ]);
      expect(unvoteWins).toBe(0);

      // Reversed VALUES order — identical (deterministic).
      const unvoteWinsReordered = await runVoteCount([
        { voter: 'bob', weight: 0, blockNum: 200, id: 31 },
        { voter: 'bob', weight: 10000, blockNum: 200, id: 30 },
      ]);
      expect(unvoteWinsReordered).toBe(0);

      // Upvote has the higher id -> bob's latest weight is positive -> net +1.
      const upvoteWins = await runVoteCount([
        { voter: 'bob', weight: 0, blockNum: 200, id: 40 },
        { voter: 'bob', weight: 10000, blockNum: 200, id: 41 },
      ]);
      expect(upvoteWins).toBe(1);

      // Reversed VALUES order — identical.
      const upvoteWinsReordered = await runVoteCount([
        { voter: 'bob', weight: 10000, blockNum: 200, id: 41 },
        { voter: 'bob', weight: 0, blockNum: 200, id: 40 },
      ]);
      expect(upvoteWinsReordered).toBe(1);
    },
  );

  it('production SQL carries the same-block id tie-breaker at every patched site', () => {
    // SQL-shape canary: a future edit that drops a tie-breaker is caught even if
    // the behavioral cases above are changed or skipped (HAF-unconfigured CI).
    expect(activeAccreditationsCteBody().sql).toContain(
      'ORDER BY cj.block_num DESC, cj.id DESC',
    );
    // vouch_ranked: the same per-(voucher,vouchee) latest-wins ROW_NUMBER, gated
    // through an exported fragment, so it is inspectable here.
    expect(activeVouchesCteBody().sql).toContain(
      'ORDER BY cj.block_num DESC, cj.id DESC',
    );
    expect(accreditedVoteCount('a', 'b')).toContain(
      'ORDER BY v.voter, v.block_num DESC, v.id DESC',
    );
    // Coverage limitation: the three reputation union CTEs (paper_latest_votes,
    // review_latest_votes, citing_latest_votes in reputation.ts) carry the same
    // `block_num DESC, op_id DESC` tie-breaker but are inlined, NOT exported as
    // fragments, so this shape canary cannot reach them. They are exercised
    // end-to-end by the real-HAF reputation-lifecycle suite, which executes the
    // assembled union SQL against live Postgres.
  });
});

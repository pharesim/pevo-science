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
 * so the canary's `toContain` assertion cannot reach them. They are instead
 * guarded structurally by the `pevo/no-accred-state-read-missing-id-tiebreaker`
 * ESLint rule (backend/eslint.config.mjs), which fails lint on any
 * accredit/revoke-filtered latest-wins read (`ORDER BY ... block_num DESC`
 * into `LIMIT 1`, or inside a ROW_NUMBER/OVER window) whose `block_num DESC`
 * lacks the immediate `id DESC` secondary key. The canary asserts only the
 * exported-fragment sites; a future edit dropping the tie-breaker from an
 * inline read turns lint red rather than passing silently.
 */

function runAccredCte(
  // Each row: action, account, block_num, op id, and (for accredits) the method;
  // a revoke may carry type:'sanction'. The synthetic rows always carry an
  // accreditation-authority signer so the `?|` gate passes. ALL FROM references
  // in the membership CTE (accred_ranked, the private vouch graph, the
  // update_params threshold scan) are redirected to the synthetic set.
  rows: Array<{
    action: 'accredit' | 'revoke';
    account: string;
    blockNum: number;
    id: number;
    method?: string;
    type?: string;
  }>,
): Promise<Set<string>> {
  const pool = getPool();
  if (!pool) throw new Error('no pool');

  const body = activeAccreditationsCteBody(1);
  // Redirect every CTE FROM at the real HAF view to the synthetic row set;
  // everything else (the `?|` gate, the per-account ROW_NUMBER ranking with the
  // `cj.id DESC` same-block tie-breaker, the sanction/legacy-revoke and live
  // WoT-threshold membership filter) is the production SQL verbatim.
  const redirected = body.sql.split(`${T.customJson} cj`).join('synthetic_cj cj');

  // $1 = custom_id bind (reused as every synthetic row's custom_id so the
  // WHERE custom_id = $1 matches). $2 = authority array for the `?|` gate.
  const params: unknown[] = [config.appTag, config.accreditationAuthorities];
  const authsLiteral = JSON.stringify(config.accreditationAuthorities);
  const valueLines: string[] = [];
  rows.forEach((r) => {
    const jsonObj: Record<string, unknown> = { action: r.action, account: r.account };
    if (r.method) jsonObj.method = r.method;
    if (r.type) jsonObj.type = r.type;
    const json = JSON.stringify(jsonObj);
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

function emptyOr(lines: string[], typedEmpty: string): string {
  return lines.length ? `VALUES\n        ${lines.join(',\n        ')}` : `${typedEmpty} WHERE false`;
}

function runVoteCountWithRevotes(
  // Native Hive votes and post-payout `revote` custom_json ops, both targeting
  // (paper-author, paper-permlink). Every voter is pre-seeded as accredited.
  // A revote weight is what the chain carries in json.weight (number or the
  // string/garbage forms the {1,9}-guard must tolerate).
  nativeRows: Array<{ voter: string; weight: number; blockNum: number; id: number }>,
  revoteRows: Array<{ voter: string; weight: number | string; blockNum: number; id: number }>,
): Promise<number> {
  const pool = getPool();
  if (!pool) throw new Error('no pool');

  // The real revote-aware fragment, FROMs redirected to synthetic sets. The
  // cross-arm `DISTINCT ON (s.voter) ... ORDER BY s.voter, s.block_num DESC,
  // s.op_id DESC` UNION ALL clause under test is the production clause verbatim.
  let countExpr = accreditedVoteCount("'paper-author'", "'paper-permlink'", '$1');
  countExpr = countExpr.split(`${T.voteOps} v`).join('synthetic_v v');
  countExpr = countExpr.split(`${T.customJson} cj`).join('synthetic_cj cj');
  // Redirect-integrity guard. If accreditedVoteCount's table-alias text ever
  // changes, the two splits above silently no-op, the synthetic VALUES fall
  // through to the helper's `WHERE false` fallback, and the cases that
  // legitimately expect 0 (retraction, self-vote, malformed weight) pass green
  // against empty tables: a false-green the output SQL-shape canary does not
  // reach (it asserts the raw helper output, not this redirected countExpr).
  // Assert both substituted aliases landed so an alias rename fails loudly.
  if (!countExpr.includes('synthetic_v v') || !countExpr.includes('synthetic_cj cj')) {
    throw new Error(
      'runVoteCountWithRevotes: table-ref redirect no-op (accreditedVoteCount alias text changed). ' +
        'Update the .split() targets so the synthetic sets are substituted, else cases fall through to WHERE false and pass as false-green.',
    );
  }

  // $1 = APP_TAG, matched by both the helper's `cj.custom_id = $1` and each
  // synthetic revote row's custom_id.
  const params: unknown[] = [config.appTag];
  const voters = new Set<string>();

  const nativeLines = nativeRows.map((r) => {
    voters.add(r.voter);
    const voterIdx = params.push(r.voter);
    const weightIdx = params.push(r.weight);
    return `('paper-author'::text, 'paper-permlink'::text, $${voterIdx}::text, $${weightIdx}::int, ${r.blockNum}::bigint, ${r.id}::bigint)`;
  });
  const revoteLines = revoteRows.map((r) => {
    voters.add(r.voter);
    const json = JSON.stringify({ action: 'revote', author: 'paper-author', permlink: 'paper-permlink', weight: r.weight });
    const jsonIdx = params.push(json);
    const authsIdx = params.push(JSON.stringify([r.voter]));
    return `($1::text, $${jsonIdx}::text, $${authsIdx}::jsonb, ${r.blockNum}::bigint, ${r.id}::bigint)`;
  });
  const accredLines = [...voters].map((v) => {
    const idx = params.push(v);
    return `($${idx}::text)`;
  });

  const sql = `
    WITH synthetic_v(author, permlink, voter, weight, block_num, id) AS (
      ${emptyOr(nativeLines, 'SELECT NULL::text, NULL::text, NULL::text, NULL::int, NULL::bigint, NULL::bigint')}
    ),
    synthetic_cj(custom_id, json, required_posting_auths, block_num, id) AS (
      ${emptyOr(revoteLines, 'SELECT NULL::text, NULL::text, NULL::jsonb, NULL::bigint, NULL::bigint')}
    ),
    active_accreditations(account) AS (
      ${emptyOr(accredLines, 'SELECT NULL::text')}
    )
    SELECT ${countExpr} AS net
  `;

  return pool.query<{ net: number }>(sql, params).then((res) => Number(res.rows[0]?.net ?? 0));
}

describe('window CTE / vote DISTINCT ON — same-block deterministic tie-breaker', () => {
  it.skipIf(!isHafConfigured())(
    'membership resolves deterministically: legacy revoke ignored, sanction sticky, latest-accredit method wins on id tie-break',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // A LEGACY revoke (no type:"sanction") no longer suppresses membership:
      // it is ignored and membership reverts to the latest accredit. Same-block
      // accredit + legacy-revoke -> alice ACTIVE, regardless of VALUES order.
      const legacyA = await runAccredCte([
        { action: 'accredit', account: 'alice', blockNum: 100, id: 10, method: 'email' },
        { action: 'revoke', account: 'alice', blockNum: 100, id: 11 },
      ]);
      expect(legacyA.has('alice')).toBe(true);
      const legacyB = await runAccredCte([
        { action: 'revoke', account: 'alice', blockNum: 100, id: 11 },
        { action: 'accredit', account: 'alice', blockNum: 100, id: 10, method: 'email' },
      ]);
      expect(legacyB.has('alice')).toBe(true);

      // A SANCTION (type:"sanction") IS sticky and suppresses regardless of op
      // order. Same-block accredit + sanction -> alice NOT active (a same-block
      // tie resolves to sanctioned; no later authority accredit lifts it).
      const sanctionA = await runAccredCte([
        { action: 'accredit', account: 'alice', blockNum: 100, id: 10, method: 'email' },
        { action: 'revoke', account: 'alice', blockNum: 100, id: 11, type: 'sanction' },
      ]);
      expect(sanctionA.has('alice')).toBe(false);
      const sanctionB = await runAccredCte([
        { action: 'revoke', account: 'alice', blockNum: 100, id: 11, type: 'sanction' },
        { action: 'accredit', account: 'alice', blockNum: 100, id: 10, method: 'email' },
      ]);
      expect(sanctionB.has('alice')).toBe(false);

      // The same-block `id DESC` tie-breaker decides which of two accredits is
      // the LATEST, and the winner's method drives membership: a wot winner with
      // zero vouchers is below threshold (NOT active), an email winner is active.
      // Higher id wins regardless of VALUES order.
      const emailWins = await runAccredCte([
        { action: 'accredit', account: 'alice', blockNum: 100, id: 20, method: 'wot' },
        { action: 'accredit', account: 'alice', blockNum: 100, id: 21, method: 'email' },
      ]);
      expect(emailWins.has('alice')).toBe(true);
      const wotWins = await runAccredCte([
        { action: 'accredit', account: 'alice', blockNum: 100, id: 20, method: 'email' },
        { action: 'accredit', account: 'alice', blockNum: 100, id: 21, method: 'wot' },
      ]);
      // wot winner, zero accredited vouchers -> below threshold -> NOT active.
      expect(wotWins.has('alice')).toBe(false);
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
    // Revote-aware form (appTagParam supplied): the UNION ALL revote arm and
    // the cross-arm latest-wins ordering. Dropping either silently re-opens the
    // native-only display/score parity gap.
    const revoteForm = accreditedVoteCount('a', 'b', '$1');
    expect(revoteForm).toContain("cj.json::jsonb ->> 'action' = 'revote'");
    expect(revoteForm).toContain('ORDER BY s.voter, s.block_num DESC, s.op_id DESC');
    // Coverage limitation: the three reputation union CTEs (paper_latest_votes,
    // review_latest_votes, citing_latest_votes in reputation.ts) carry the same
    // `block_num DESC, op_id DESC` tie-breaker but are inlined, NOT exported as
    // fragments, so this shape canary cannot reach them. They are exercised
    // end-to-end by the real-HAF reputation-lifecycle suite, which executes the
    // assembled union SQL against live Postgres.
  });
});

describe('accreditedVoteCount — native + revote display/score parity', () => {
  // The revote-aware form folds post-payout `revote` custom_json into the
  // latest-signal-per-voter stream the reputation cycle uses, so the
  // review/comment/profile display counts no longer diverge from the score
  // when an accredited voter flipped or retracted via revote. Same carve-out
  // clauses (a)/(b)/(c) as runVoteCount above: synthetic VALUES exercise the
  // production union SQL verbatim through the real getPool() connection because
  // the chain mirror cannot be seeded with the multi-state vote histories these
  // cases require.

  it.skipIf(!isHafConfigured())(
    'revote-only upvote counts (native-only would show 0)',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) { ctx.skip('no pool available'); return; }
      // A voter whose ONLY accredited signal is a post-payout revote upvote.
      const net = await runVoteCountWithRevotes([], [{ voter: 'carol', weight: 10000, blockNum: 300, id: 50 }]);
      expect(net).toBe(1);
    },
  );

  it.skipIf(!isHafConfigured())(
    'native upvote retracted by a later weight:0 revote counts 0',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) { ctx.skip('no pool available'); return; }
      const net = await runVoteCountWithRevotes(
        [{ voter: 'dave', weight: 10000, blockNum: 100, id: 10 }],
        [{ voter: 'dave', weight: 0, blockNum: 300, id: 50 }],
      );
      expect(net).toBe(0);
    },
  );

  it.skipIf(!isHafConfigured())(
    'native upvote flipped to a downvote by a later revote flips the sign',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) { ctx.skip('no pool available'); return; }
      const net = await runVoteCountWithRevotes(
        [{ voter: 'erin', weight: 10000, blockNum: 100, id: 10 }],
        [{ voter: 'erin', weight: -10000, blockNum: 300, id: 50 }],
      );
      expect(net).toBe(-1);
    },
  );

  it.skipIf(!isHafConfigured())(
    'an OLDER revote does not override a LATER native vote (cross-arm latest-wins by block then op id)',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) { ctx.skip('no pool available'); return; }
      // Revote retraction at block 100, then a (hypothetical same-window)
      // native upvote at block 300: the later native vote is the latest signal.
      const net = await runVoteCountWithRevotes(
        [{ voter: 'frank', weight: 10000, blockNum: 300, id: 60 }],
        [{ voter: 'frank', weight: 0, blockNum: 100, id: 10 }],
      );
      expect(net).toBe(1);
      // Same block, revote has the higher op id -> revote wins (retracts).
      const sameBlock = await runVoteCountWithRevotes(
        [{ voter: 'grace', weight: 10000, blockNum: 200, id: 30 }],
        [{ voter: 'grace', weight: 0, blockNum: 200, id: 31 }],
      );
      expect(sameBlock).toBe(0);
    },
  );

  it.skipIf(!isHafConfigured())(
    'a self-revote by the author is excluded',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) { ctx.skip('no pool available'); return; }
      const net = await runVoteCountWithRevotes(
        [],
        [{ voter: 'paper-author', weight: 10000, blockNum: 300, id: 50 }],
      );
      expect(net).toBe(0);
    },
  );

  it.skipIf(!isHafConfigured())(
    'a malformed-weight latest revote drops the voter (NULL weight, not a crash)',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) { ctx.skip('no pool available'); return; }
      // Non-numeric weight -> {1,9}-guard yields SQL NULL; as the latest signal
      // it drops the voter (NULL != 0 is NULL), matching reputation.ts. The
      // query must not abort on the bad cast.
      const net = await runVoteCountWithRevotes(
        [{ voter: 'heidi', weight: 10000, blockNum: 100, id: 10 }],
        [{ voter: 'heidi', weight: 'not-a-number', blockNum: 300, id: 50 }],
      );
      expect(net).toBe(0);
    },
  );
});

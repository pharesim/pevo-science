/**
 * Real-Postgres regression for the GET /api/me/authorships/pending query
 * composers (`composePendingClaimsQuery` / `composePendingConsentsQuery` from
 * `routes/me.ts`), run verbatim with their FROMs redirected at a synthetic
 * corpus (the same redirect technique as
 * `consented-authors-cte-real-postgres.test.ts`).
 *
 * Why a real planner and not a result mock (per root CLAUDE.md "Running
 * Tests" carve-out):
 *
 *   (a) The discriminating invariants are structural to the SQL — the
 *       naming-post seed, the upward `continues` walk to chain roots, the
 *       eligibility-minus-acted set difference (accepted, resigned, and
 *       revoked users all cleared; an invalid pre-claim accept NOT cleared),
 *       orphaned-fork exclusion, and the claimer-scoped pending-status
 *       filter. A result mock supplies rows directly and is blind to all of
 *       them. Seeding live HAF with these multi-user consent scenarios per
 *       test is not tractable (real broadcasts + indexing lag).
 *   (b) No auth middleware: the composers sit below the route layer and are
 *       exercised through a raw `pg.PoolClient`; there is no cryptographic
 *       verification to run real here. The route-level companion
 *       (`tests/routes/me-authorships-pending.test.ts`) runs the REAL
 *       `verifyHiveSignature` against signed requests.
 *   (c) Real-path companion: `consented-authors-cte-real-postgres.test.ts`
 *       covers the underlying chain/consent CTE stack; the route test covers
 *       envelope plumbing against the real middleware.
 *
 * Corpus map (papers Q1-Q4):
 *   Q1 root1/q1 — authors[]: root1(hive), newbie(hive), okuser(hive),
 *     resigner(hive), revokee(hive), squat(hive), orcuser-ORCID slot, and
 *     three name-only slots "Nameo" / "Other Name" / "Third N" (display
 *     indices 7/8/9). okuser accepts (valid); resigner accepts then resigns;
 *     revokee accepts then is revoked by root1; squat accepts in the slot's
 *     first-appearance block (Rule-6 invalid); newbie and orcuser never act.
 *   Q2 newbie/q2 — newbie's own single-author root (Route-1 implicit
 *     consent; must not show as pending to its own broadcaster).
 *   Q3 root3/q3 → root3/q3c — newbie is named only on the CONTINUATION, so
 *     the seed must walk q3c up to the root q3.
 *   Q4 root4/q4 with fork q4c1 (canonical, earliest) / q4c2 (orphaned) —
 *     newbie is named only on the orphaned branch.
 *   C1-C3 rootc1/c1, rootc2/c2, rootc3/c3 — three roots naming capuser, with
 *     DISTINCT `created` ages (3/2/1 days old). The seed-cap describe drives
 *     the composer at a tiny injected cap so the naming-posts LIMIT and its
 *     newest-first direction are observable on this corpus.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { config } from '../src/config.js';
import { T } from '../src/hafsql.js';
import { composePendingClaimsQuery, composePendingConsentsQuery } from '../src/routes/me.js';

const DB_URL = process.env.APP_DATABASE_URL;
const pool = DB_URL ? new pg.Pool({ connectionString: DB_URL, max: 1 }) : null;
let client: pg.PoolClient | null = null;

const TAG = config.appTag;
const ADMIN = config.hiveAdminAccount; // always in accreditationAuthorities
const ORCID_X = '0000-0002-3333-4444';

function post(author: string, permlink: string, pevo: Record<string, unknown>) {
  return { author, permlink, json_metadata: { app: 'pevo/1', [TAG]: pevo } };
}
function chainOp(author: string, permlink: string, block: number, id: number, pevo: Record<string, unknown>) {
  return { author, permlink, block_num: block, id, json_metadata: { app: 'pevo/1', [TAG]: pevo } };
}
function cjOp(action: string, signer: string, json: Record<string, unknown>, block: number, id: number) {
  return { required_posting_auths: [signer], json: JSON.stringify({ action, ...json }), block_num: block, id };
}

const Q1_AUTHORS = [
  { hive: 'root1', name: 'R One' },
  { hive: 'newbie', name: 'New B' },
  { hive: 'okuser', name: 'Ok U' },
  { hive: 'resigner', name: 'Re S' },
  { hive: 'revokee', name: 'Re V' },
  { hive: 'squat', name: 'Sq U' },
  { orcid: ORCID_X, name: 'Orc U' },
  { name: 'Nameo' },
  { name: 'Other Name' },
  { name: 'Third N' },
];

const COMMENTS = [
  post('root1', 'q1', { type: 'paper', authors: Q1_AUTHORS }),
  post('newbie', 'q2', { type: 'paper', authors: [{ hive: 'newbie', name: 'New B' }] }),
  post('root3', 'q3', { type: 'paper', authors: [{ hive: 'root3', name: 'R Three' }] }),
  post('root3', 'q3c', { type: 'paper', continues: { author: 'root3', permlink: 'q3' }, authors: [{ hive: 'root3' }, { hive: 'newbie', name: 'New B' }] }),
  post('root4', 'q4', { type: 'paper', authors: [{ hive: 'root4', name: 'R Four' }] }),
  post('root4', 'q4c1', { type: 'paper', continues: { author: 'root4', permlink: 'q4' }, authors: [{ hive: 'root4' }] }),
  post('root4', 'q4c2', { type: 'paper', continues: { author: 'root4', permlink: 'q4' }, authors: [{ hive: 'root4' }, { hive: 'newbie', name: 'New B' }] }),
];

const CHAIN_OPS = [
  chainOp('root1', 'q1', 100, 1000, { type: 'paper', authors: Q1_AUTHORS }),
  chainOp('newbie', 'q2', 110, 1100, { type: 'paper', authors: [{ hive: 'newbie', name: 'New B' }] }),
  chainOp('root3', 'q3', 120, 1200, { type: 'paper', authors: [{ hive: 'root3', name: 'R Three' }] }),
  chainOp('root3', 'q3c', 130, 1300, { type: 'paper', continues: { author: 'root3', permlink: 'q3' }, authors: [{ hive: 'root3' }, { hive: 'newbie', name: 'New B' }] }),
  chainOp('root4', 'q4', 140, 1400, { type: 'paper', authors: [{ hive: 'root4', name: 'R Four' }] }),
  chainOp('root4', 'q4c1', 150, 1500, { type: 'paper', continues: { author: 'root4', permlink: 'q4' }, authors: [{ hive: 'root4' }] }),
  chainOp('root4', 'q4c2', 160, 1600, { type: 'paper', continues: { author: 'root4', permlink: 'q4' }, authors: [{ hive: 'root4' }, { hive: 'newbie', name: 'New B' }] }),
];

/** Seed-cap corpus: three roots naming capuser, inserted with explicit
 *  distinct `created` values (unlike the DEFAULT-now() corpus above) because
 *  the cap truncates on newest-first `created` order. capuser never acts on
 *  any of them, so uncapped all three are pending. */
const CAP_PAPERS = [
  { author: 'rootc1', permlink: 'c1', age: '3 days' },
  { author: 'rootc2', permlink: 'c2', age: '2 days' },
  { author: 'rootc3', permlink: 'c3', age: '1 day' },
];
function capPaperMeta(author: string) {
  return { app: 'pevo/1', [TAG]: { type: 'paper', authors: [{ hive: author }, { hive: 'capuser', name: 'Cap U' }] } };
}

const CUSTOM_JSONS = [
  // Authority attestation: orcuser carries the orcid-anchor proof for Q1's slot.
  cjOp('accredit', ADMIN, { account: 'orcuser', orcid: ORCID_X }, 50, 100),
  // okuser: valid accept (after the slot's first block) → cleared from pending.
  cjOp('author_accept', 'okuser', { root_author: 'root1', root_permlink: 'q1' }, 150, 200),
  // resigner: accept then resign → cleared (latest action exists; user has acted).
  cjOp('author_accept', 'resigner', { root_author: 'root1', root_permlink: 'q1' }, 150, 201),
  cjOp('author_resign', 'resigner', { root_author: 'root1', root_permlink: 'q1' }, 160, 202),
  // revokee: accepted, then root1 revokes them → cleared (do not re-prompt a
  // co-author the root stripped).
  cjOp('author_accept', 'revokee', { root_author: 'root1', root_permlink: 'q1' }, 150, 203),
  cjOp('revoke_authorship', 'root1', { claimer: 'revokee', paper_author: 'root1', paper_permlink: 'q1' }, 200, 204),
  // squat: accept in the slot's first-appearance block (Rule-6 name-squat
  // window; not strictly greater) → invalid → the slot is STILL pending.
  cjOp('author_accept', 'squat', { root_author: 'root1', root_permlink: 'q1' }, 100, 205),
  // Route 3 claims on Q1's name-only slots. One claim per claimer: approval
  // and revocation resolve per (claimer, paper) in `authorship_claims` (the
  // revoke wire payload carries no author_index), so distinct status cases
  // need distinct claimers. claimerdude idx 7 unapproved → pending (listed);
  // approvedclaimer idx 8 approved → accepted (excluded); voidedclaimer
  // idx 9 claimed then revoked by root1 → revoked (excluded).
  cjOp('claim_authorship', 'claimerdude', { paper_author: 'root1', paper_permlink: 'q1', author_index: 7, timestamp: 't-300' }, 300, 220),
  cjOp('claim_authorship', 'approvedclaimer', { paper_author: 'root1', paper_permlink: 'q1', author_index: 8, timestamp: 't-301' }, 301, 221),
  cjOp('approve_authorship', 'root1', { claimer: 'approvedclaimer', paper_author: 'root1', paper_permlink: 'q1', author_index: 8 }, 310, 222),
  cjOp('claim_authorship', 'voidedclaimer', { paper_author: 'root1', paper_permlink: 'q1', author_index: 9, timestamp: 't-302' }, 302, 223),
  cjOp('revoke_authorship', 'root1', { claimer: 'voidedclaimer', paper_author: 'root1', paper_permlink: 'q1' }, 320, 224),
  // Another user's pending claim on the same slot — must not leak into
  // claimerdude's claimer-scoped list.
  cjOp('claim_authorship', 'otherclaimer', { paper_author: 'root1', paper_permlink: 'q1', author_index: 7, timestamp: 't-330' }, 330, 225),
];

/** Redirect every HAF view literal in a composed statement at the synthetic
 *  temp tables. Drift guard: assert every literal was consumed so a builder
 *  alias change cannot silently leave the query pointed at live HAF. */
function redirect(stmt: { sql: string; params: unknown[] }) {
  let sql = stmt.sql;
  sql = sql.split(T.comments).join('syn_comments');
  sql = sql.split(T.commentOps).join('syn_comment_ops');
  sql = sql.split(T.customJson).join('syn_cj');
  expect(sql).not.toContain(T.comments);
  expect(sql).not.toContain(T.commentOps);
  expect(sql).not.toContain(T.customJson);
  return { sql, params: stmt.params };
}

async function pendingConsentsFor(username: string) {
  const { sql, params } = redirect(composePendingConsentsQuery(username));
  const result = await client!.query(sql, params);
  return result.rows as Array<{ paper_author: string; paper_permlink: string }>;
}

async function pendingClaimsFor(claimer: string) {
  const { sql, params } = redirect(composePendingClaimsQuery(claimer));
  const result = await client!.query(sql, params);
  return result.rows as Array<{ paper_author: string; paper_permlink: string; author_index: number; claimed_at: string }>;
}

beforeAll(async () => {
  if (!pool) return;
  client = await pool.connect();
  // `created` mirrors the real comments view's column (the Route-2 seed's
  // newest-first spam-defense bound orders on it); equal timestamps are fine
  // for the Q1-Q4 corpus because it sits far below the cap and `pending_seed`
  // is a DISTINCT set. The CAP_PAPERS corpus is the exception: it carries
  // explicit distinct `created` values because the seed-cap describe asserts
  // exactly that ordering.
  await client.query(`CREATE TEMP TABLE syn_comments (author text, permlink text, parent_author text DEFAULT '', parent_permlink text, json_metadata jsonb, created timestamptz DEFAULT now())`);
  await client.query(`CREATE TEMP TABLE syn_comment_ops (author text, permlink text, block_num int, id bigint, json_metadata jsonb)`);
  await client.query(`CREATE TEMP TABLE syn_cj (custom_id text, required_posting_auths jsonb, json text, block_num int, id bigint)`);
  for (const c of COMMENTS) {
    await client.query(`INSERT INTO syn_comments (author, permlink, parent_permlink, json_metadata) VALUES ($1, $2, $3, $4)`, [c.author, c.permlink, TAG, c.json_metadata]);
  }
  for (const o of CHAIN_OPS) {
    await client.query(`INSERT INTO syn_comment_ops VALUES ($1, $2, $3, $4, $5)`, [o.author, o.permlink, o.block_num, o.id, o.json_metadata]);
  }
  for (const j of CUSTOM_JSONS) {
    await client.query(`INSERT INTO syn_cj VALUES ($1, $2, $3, $4, $5)`, [TAG, JSON.stringify(j.required_posting_auths), j.json, j.block_num, j.id]);
  }
  for (const [i, p] of CAP_PAPERS.entries()) {
    await client.query(
      `INSERT INTO syn_comments (author, permlink, parent_permlink, json_metadata, created) VALUES ($1, $2, $3, $4, now() - $5::interval)`,
      [p.author, p.permlink, TAG, capPaperMeta(p.author), p.age],
    );
    await client.query(`INSERT INTO syn_comment_ops VALUES ($1, $2, $3, $4, $5)`, [p.author, p.permlink, 170 + i * 10, 1700 + i * 100, capPaperMeta(p.author)]);
  }
});

afterAll(async () => {
  client?.release();
  if (pool) await pool.end();
});

describe.skipIf(!pool)('composePendingConsentsQuery — Route-2 pending discovery (real Postgres)', () => {
  it('lists anchored papers the user has not acted on, including a slot named only on a continuation', async () => {
    // newbie is anchored on Q1 (root metadata) and Q3 (named only on the
    // continuation q3c — the seed up-walk must resolve the root). Q2 is
    // newbie's own root (Route-1 implicit consent) and Q4 names newbie only
    // on the orphaned fork branch — both excluded.
    expect(await pendingConsentsFor('newbie')).toEqual([
      { paper_author: 'root1', paper_permlink: 'q1' },
      { paper_author: 'root3', paper_permlink: 'q3' },
    ]);
  });

  it('anchors through the authority-attested ORCID slot', async () => {
    expect(await pendingConsentsFor('orcuser')).toEqual([
      { paper_author: 'root1', paper_permlink: 'q1' },
    ]);
  });

  it('keeps a Rule-6-invalid accept (first-appearance block) pending', async () => {
    // squat's accept landed in the slot's first-appearance block, which the
    // consent stream rejects as name-squatting — so the slot still awaits a
    // valid accept and must surface.
    expect(await pendingConsentsFor('squat')).toEqual([
      { paper_author: 'root1', paper_permlink: 'q1' },
    ]);
  });

  it('clears users who accepted, resigned, or were revoked', async () => {
    expect(await pendingConsentsFor('okuser')).toEqual([]);
    expect(await pendingConsentsFor('resigner')).toEqual([]);
    expect(await pendingConsentsFor('revokee')).toEqual([]);
  });

  it('excludes the user\'s own root papers and unanchored accounts', async () => {
    expect(await pendingConsentsFor('root1')).toEqual([]);
    expect(await pendingConsentsFor('attacker')).toEqual([]);
  });
});

describe.skipIf(!pool)('composePendingConsentsQuery — naming-posts seed cap (real Postgres)', () => {
  it('serves every anchoring paper while the cap does not bind (baseline)', async () => {
    // Default cap: all three CAP_PAPERS anchor capuser and none are acted on.
    expect(await pendingConsentsFor('capuser')).toEqual([
      { paper_author: 'rootc1', paper_permlink: 'c1' },
      { paper_author: 'rootc2', paper_permlink: 'c2' },
      { paper_author: 'rootc3', paper_permlink: 'c3' },
    ]);
  });

  it('truncates the OLDEST naming post out of discovery at a binding cap (newest-first LIMIT)', async () => {
    // Injected cap 2 over three naming posts with distinct `created` values:
    // the two newest survive, the oldest (rootc1/c1) falls out — the
    // truncated-but-served semantics the cap docblock promises. Kills the
    // LIMIT-deletion mutant (all three would serve) AND the ORDER BY
    // direction flip (ASC would evict the NEWEST, keeping rootc1/c1).
    const { sql, params } = redirect(composePendingConsentsQuery('capuser', 2));
    const result = await client!.query(sql, params);
    expect(result.rows).toEqual([
      { paper_author: 'rootc2', paper_permlink: 'c2' },
      { paper_author: 'rootc3', paper_permlink: 'c3' },
    ]);
  });
});

describe('composePendingConsentsQuery — production seed cap (composition shape)', () => {
  it('composes the default cap into the naming-posts LIMIT', () => {
    // The truncation case above injects a tiny cap, so it cannot observe a
    // silent change to the production default; this pins the default value
    // as emitted into the seed SQL.
    expect(composePendingConsentsQuery('anyuser').sql).toContain('LIMIT 500');
  });
});

describe.skipIf(!pool)('composePendingClaimsQuery — Route-3 pending claims (real Postgres)', () => {
  it('lists only the claimer\'s own still-pending claims', async () => {
    // otherclaimer's claim on the same slot must not leak into
    // claimerdude's claimer-scoped list.
    expect(await pendingClaimsFor('claimerdude')).toEqual([
      { paper_author: 'root1', paper_permlink: 'q1', author_index: 7, claimed_at: 't-300' },
    ]);
  });

  it('excludes approved and revoked claims', async () => {
    expect(await pendingClaimsFor('approvedclaimer')).toEqual([]);
    expect(await pendingClaimsFor('voidedclaimer')).toEqual([]);
  });

  it('returns the other claimer\'s pending claim under their own scope', async () => {
    expect(await pendingClaimsFor('otherclaimer')).toEqual([
      { paper_author: 'root1', paper_permlink: 'q1', author_index: 7, claimed_at: 't-330' },
    ]);
  });

  it('returns nothing for a user with no claims', async () => {
    expect(await pendingClaimsFor('newbie')).toEqual([]);
  });
});

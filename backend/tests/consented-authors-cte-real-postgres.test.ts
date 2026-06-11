/**
 * Real-Postgres regression for the consented-authorship CTE stack —
 * `consentChainCteBody` (recursive chain walk + canonical path + slot
 * unions) and `consentedAuthorsCteBody` (Route 1/2 resolution + demotions)
 * from `hafsql.ts`, run verbatim with their FROMs redirected at a synthetic
 * corpus (the same redirect technique as
 * `wot-vouch-status-select-real-postgres.test.ts`).
 *
 * Why a real planner and not a result mock (per root CLAUDE.md "Running
 * Tests" carve-out):
 *
 *   (a) The discriminating invariants are structural to the SQL — recursive
 *       admission gating (the cumulative admit-set threaded down the walk),
 *       earliest-wins canonical-path selection at forks, visited-array cycle
 *       termination, ops-union vs display-union divergence, and
 *       latest-op-wins consent resolution. A result mock supplies rows
 *       directly and is blind to all of them. Seeding the live HAF mirror
 *       with multi-post chains, forks, cycles, attestations, and consent ops
 *       per test is not tractable (real broadcasts + indexing lag), so the
 *       production CTE bodies run against a temp-table corpus instead.
 *   (b) No auth middleware: these CTEs sit below the route layer and are
 *       exercised through a raw `pg.Pool`; there is no cryptographic
 *       verification to run real here.
 *   (c) Real-path companion: `consent-ops-real-haf.test.ts` covers the
 *       fetcher's row-shape risk class against live HAF; the reputation
 *       cycle's real-HAF lifecycle test covers the integrated credit path.
 *
 * Corpus map (papers P1-P4):
 *   P1 alice/p1 — root authors[]: alice(hive), bob(hive), carol-orcid slot,
 *     "Dave D" name-only; creation op ALSO names zara(hive), removed by a
 *     later edit op (ops-union eligibility probe). Continuations: bob/p1c
 *     (block 200, adds eve) and alice/p1d (block 300, adds mallory) BOTH
 *     continue the root → fork; earliest (p1c) is canonical, p1d orphaned.
 *     eve/p1e continues p1c (adds name-only "Late Lucy").
 *   P2 bridge/b1 — bridge paper, hive-less display credit only.
 *   P3 frank/p3 — root whose `continues` points at p3c while p3c continues
 *     p3: a reachable 2-cycle through the root (broadcaster-controlled
 *     pointers); the walk must terminate via the visited guard.
 *   P4 greta/p4 — single-author root; greta later `author_resign`s her own
 *     paper (Route-1 demotion).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { config } from '../src/config.js';
import {
  T,
  activeAccreditationsCteBody,
  authorshipClaimsCteBody,
  consentChainCteBody,
  consentedAuthorsCteBody,
  consentSeedCteBody,
  buildRecursiveWith,
  type ConsentChainScope,
} from '../src/hafsql.js';

const DB_URL = process.env.APP_DATABASE_URL;
const pool = DB_URL ? new pg.Pool({ connectionString: DB_URL, max: 1 }) : null;
let client: pg.PoolClient | null = null;

const TAG = config.appTag;
const BRIDGE = config.hiveBridgeAccount;
const ADMIN = config.hiveAdminAccount; // always in accreditationAuthorities
const CAROL_ORCID = '0000-0002-1111-2222';

function post(author: string, permlink: string, pevo: Record<string, unknown>) {
  return { author, permlink, json_metadata: { app: 'pevo/1', [TAG]: pevo } };
}
function chainOp(author: string, permlink: string, block: number, id: number, pevo: Record<string, unknown>) {
  return { author, permlink, block_num: block, id, json_metadata: { app: 'pevo/1', [TAG]: pevo } };
}
function cjOp(action: string, signer: string, json: Record<string, unknown>, block: number, id: number) {
  return { required_posting_auths: [signer], json: JSON.stringify({ action, ...json }), block_num: block, id };
}

const COMMENTS = [
  post('alice', 'p1', { type: 'paper', authors: [{ hive: 'alice', name: 'Alice' }, { hive: 'bob', name: 'Bob' }, { orcid: CAROL_ORCID, name: 'Carol' }, { name: 'Dave D' }] }),
  post('bob', 'p1c', { type: 'paper', continues: { author: 'alice', permlink: 'p1' }, authors: [{ hive: 'bob', name: 'Bob' }, { hive: 'eve', name: 'Eve' }] }),
  post('alice', 'p1d', { type: 'paper', continues: { author: 'alice', permlink: 'p1' }, authors: [{ hive: 'alice' }, { hive: 'mallory', name: 'Mallory' }] }),
  post('eve', 'p1e', { type: 'paper', continues: { author: 'bob', permlink: 'p1c' }, authors: [{ hive: 'eve' }, { name: 'Late Lucy' }] }),
  post(BRIDGE, 'b1', { type: 'bridge_paper', authors: [{ hive: null, name: 'Orig Author', orcid: '0000-0003-9999-8888' }] }),
  post('frank', 'p3', { type: 'paper', continues: { author: 'frank', permlink: 'p3c' }, authors: [{ hive: 'frank' }] }),
  post('frank', 'p3c', { type: 'paper', continues: { author: 'frank', permlink: 'p3' }, authors: [{ hive: 'frank' }] }),
  post('greta', 'p4', { type: 'paper', authors: [{ hive: 'greta' }] }),
];

const CHAIN_OPS = [
  // P1 root creation op names zara; the block-250 edit removes her.
  chainOp('alice', 'p1', 100, 1000, { type: 'paper', authors: [{ hive: 'alice', name: 'Alice' }, { hive: 'bob', name: 'Bob' }, { orcid: CAROL_ORCID, name: 'Carol' }, { name: 'Dave D' }, { hive: 'zara' }] }),
  chainOp('alice', 'p1', 250, 2500, { type: 'paper', authors: [{ hive: 'alice', name: 'Alice' }, { hive: 'bob', name: 'Bob' }, { orcid: CAROL_ORCID, name: 'Carol' }, { name: 'Dave D' }] }),
  chainOp('bob', 'p1c', 200, 2000, { type: 'paper', continues: { author: 'alice', permlink: 'p1' }, authors: [{ hive: 'bob' }, { hive: 'eve', name: 'Eve' }] }),
  chainOp('alice', 'p1d', 300, 3000, { type: 'paper', continues: { author: 'alice', permlink: 'p1' }, authors: [{ hive: 'alice' }, { hive: 'mallory', name: 'Mallory' }] }),
  chainOp('eve', 'p1e', 400, 4000, { type: 'paper', continues: { author: 'bob', permlink: 'p1c' }, authors: [{ hive: 'eve' }, { name: 'Late Lucy' }] }),
  chainOp(BRIDGE, 'b1', 100, 1100, { type: 'bridge_paper', authors: [{ hive: null, name: 'Orig Author' }] }),
  chainOp('frank', 'p3', 100, 1200, { type: 'paper', continues: { author: 'frank', permlink: 'p3c' }, authors: [{ hive: 'frank' }] }),
  chainOp('frank', 'p3c', 110, 1300, { type: 'paper', continues: { author: 'frank', permlink: 'p3' }, authors: [{ hive: 'frank' }] }),
  chainOp('greta', 'p4', 100, 1400, { type: 'paper', authors: [{ hive: 'greta' }] }),
];

const CUSTOM_JSONS = [
  // Authority-signed attestations: carol carries the orcid-anchor proof.
  cjOp('accredit', ADMIN, { account: 'carol', orcid: CAROL_ORCID }, 50, 100),
  cjOp('accredit', ADMIN, { account: 'bob' }, 50, 101),
  cjOp('accredit', ADMIN, { account: 'eve' }, 50, 102),
  cjOp('accredit', ADMIN, { account: 'mallory', orcid: '0000-0009-0000-0001' }, 50, 103),
  // bob: hive-anchored valid accept... later admin-revoked (backstop).
  cjOp('author_accept', 'bob', { root_author: 'alice', root_permlink: 'p1' }, 150, 200),
  // carol: orcid-anchored accept with matching attestation → consented.
  cjOp('author_accept', 'carol', { root_author: 'alice', root_permlink: 'p1' }, 160, 201),
  // eve: slot first appears at block 200; accept at 180 is pre-claim (name-squat) → invalid.
  cjOp('author_accept', 'eve', { root_author: 'alice', root_permlink: 'p1' }, 180, 202),
  // eve: valid accept → resign → re-accept; latest valid op wins → consented.
  cjOp('author_accept', 'eve', { root_author: 'alice', root_permlink: 'p1' }, 210, 203),
  cjOp('author_resign', 'eve', { root_author: 'alice', root_permlink: 'p1' }, 220, 204),
  cjOp('author_accept', 'eve', { root_author: 'alice', root_permlink: 'p1' }, 230, 205),
  // zara: removed from the root's CURRENT metadata at 250 but claimed by the
  // creation op (append-only union) → her accept at 260 is valid → consented.
  cjOp('author_accept', 'zara', { root_author: 'alice', root_permlink: 'p1' }, 260, 210),
  // mallory: her slot lives only in the orphaned fork branch → inert accept.
  cjOp('author_accept', 'mallory', { root_author: 'alice', root_permlink: 'p1' }, 350, 206),
  // Admin revoke backstop demotes bob (consented via Route 2).
  cjOp('revoke_authorship', ADMIN, { claimer: 'bob', paper_author: 'alice', paper_permlink: 'p1' }, 500, 207),
  // Forged revoke by a non-author non-admin signer → must NOT demote carol.
  cjOp('revoke_authorship', 'attacker', { claimer: 'carol', paper_author: 'alice', paper_permlink: 'p1' }, 510, 208),
  // Forged accept by an account no slot anchors → inert.
  cjOp('author_accept', 'attacker', { root_author: 'alice', root_permlink: 'p1' }, 520, 209),
  // Self-signed (non-authority) attestation attack: imposter self-attests
  // carol's slot ORCID and accepts. The authority gate drops the
  // attestation, so the accept anchors nothing → NOT consented.
  cjOp('accredit', 'imposter', { account: 'imposter', orcid: CAROL_ORCID }, 55, 104),
  cjOp('author_accept', 'imposter', { root_author: 'alice', root_permlink: 'p1' }, 530, 212),
  // greta resigns her own root paper → Route-1 demotion.
  cjOp('author_resign', 'greta', { root_author: 'greta', root_permlink: 'p4' }, 700, 211),
  // Route 3: davesacct claims the name-only "Dave D" slot (display index 3)
  // and alice approves → accepted.
  cjOp('claim_authorship', 'davesacct', { paper_author: 'alice', paper_permlink: 'p1', author_index: 3 }, 600, 220),
  cjOp('approve_authorship', 'alice', { claimer: 'davesacct', paper_author: 'alice', paper_permlink: 'p1', author_index: 3 }, 610, 221),
  // Route-3 rejection on an ANCHORED slot: sneaky claims display index 1
  // (bob's hive-anchored slot) and alice approves — the name-only gate
  // keeps it pending (anchored slots consent via Route 2 only).
  cjOp('claim_authorship', 'sneaky', { paper_author: 'alice', paper_permlink: 'p1', author_index: 1 }, 620, 222),
  cjOp('approve_authorship', 'alice', { claimer: 'sneaky', paper_author: 'alice', paper_permlink: 'p1', author_index: 1 }, 630, 223),
];

/**
 * Compose the production CTE stack for the given scope, redirect every HAF
 * view literal at the synthetic temp tables, and return `{ sql, params }`
 * ready to append a SELECT to. Drift guard: if a view literal stops
 * matching (alias or whitespace change in the real bodies), the redirect
 * would no-op and the query would silently run against live HAF — assert
 * every literal was consumed.
 */
function composeRedirected(scope: ConsentChainScope, signers?: string[]) {
  const cte = buildRecursiveWith(
    1,
    activeAccreditationsCteBody,
    (idx) => consentChainCteBody(idx, scope),
    (idx) => consentedAuthorsCteBody(idx, signers ? { signers } : undefined),
  );
  let sql = cte.sql;
  sql = sql.split(T.comments).join('syn_comments');
  sql = sql.split(T.commentOps).join('syn_comment_ops');
  sql = sql.split(T.customJson).join('syn_cj');
  expect(sql).not.toContain(T.comments);
  expect(sql).not.toContain(T.commentOps);
  expect(sql).not.toContain(T.customJson);
  return { sql, params: cte.params };
}

async function consentedFor(scope: ConsentChainScope, signers?: string[]) {
  const { sql, params } = composeRedirected(scope, signers);
  const result = await client!.query(
    `${sql}
     SELECT root_author, root_permlink, account FROM consented_authors
     ORDER BY root_author, root_permlink, account`,
    params,
  );
  return result.rows as Array<{ root_author: string; root_permlink: string; account: string }>;
}

beforeAll(async () => {
  if (!pool) return;
  client = await pool.connect();
  // Temp tables live for this session (max:1 pool, single client) and
  // vanish on disconnect; column subset mirrors what the CTEs read.
  await client.query(`CREATE TEMP TABLE syn_comments (author text, permlink text, parent_author text DEFAULT '', parent_permlink text, json_metadata jsonb)`);
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
});

afterAll(async () => {
  client?.release();
  if (pool) await pool.end();
});

describe.skipIf(!pool)('consentChainCteBody — canonical chain (real Postgres)', () => {
  it('resolves the earliest-wins canonical path and orphans the later fork branch', async () => {
    const { sql, params } = composeRedirected({ paperAuthor: 'alice', paperPermlink: 'p1' });
    const result = await client!.query(
      `${sql} SELECT author, permlink, depth FROM canonical_chain ORDER BY depth`,
      params,
    );
    expect(result.rows).toEqual([
      { author: 'alice', permlink: 'p1', depth: 0 },
      { author: 'bob', permlink: 'p1c', depth: 1 },   // block 200 beats p1d's 300
      { author: 'eve', permlink: 'p1e', depth: 2 },   // continues the canonical child
    ]);
  });

  it('terminates on a reachable continuation cycle (visited guard)', async () => {
    const { sql, params } = composeRedirected({ paperAuthor: 'frank', paperPermlink: 'p3' });
    const result = await client!.query(
      `${sql} SELECT author, permlink, depth FROM canonical_chain ORDER BY depth`,
      params,
    );
    // p3 → p3c, then the only candidate continuing p3c is p3 itself —
    // blocked by the visited array; the walk ends instead of looping to
    // the 50-hop cap.
    expect(result.rows).toEqual([
      { author: 'frank', permlink: 'p3', depth: 0 },
      { author: 'frank', permlink: 'p3c', depth: 1 },
    ]);
  });

  it('orders display slots by two-track first occurrence over CURRENT metadata (author_index domain)', async () => {
    const { sql, params } = composeRedirected({ paperAuthor: 'alice', paperPermlink: 'p1' });
    const result = await client!.query(
      `${sql} SELECT slot_key, author_index FROM display_slots
       WHERE root_author = 'alice' AND root_permlink = 'p1' ORDER BY author_index`,
      params,
    );
    // zara is absent (removed from the root's current metadata); the
    // orphaned branch's mallory is absent; entries interleave hive-keyed
    // and hive-less tracks in first-occurrence order across the canonical
    // chain.
    expect(result.rows).toEqual([
      { slot_key: 'hive:alice', author_index: 0 },
      { slot_key: 'hive:bob', author_index: 1 },
      { slot_key: `orcid:${CAROL_ORCID}`, author_index: 2 },
      { slot_key: 'name:dave d', author_index: 3 },
      { slot_key: 'hive:eve', author_index: 4 },
      { slot_key: 'name:late lucy', author_index: 5 },
    ]);
  });

  it('keeps an edit-removed author in the append-only claimed union with the creation-op first block', async () => {
    const { sql, params } = composeRedirected({ paperAuthor: 'alice', paperPermlink: 'p1' });
    const result = await client!.query(
      `${sql} SELECT hive, first_block FROM claimed_hive_slots
       WHERE root_author = 'alice' AND root_permlink = 'p1' ORDER BY hive`,
      params,
    );
    expect(result.rows).toEqual([
      { hive: 'alice', first_block: 100 },
      { hive: 'bob', first_block: 100 },
      { hive: 'eve', first_block: 200 },   // continuation-added slot: first op that named it
      { hive: 'zara', first_block: 100 },  // edit-removed but append-only
    ]);
  });
});

describe.skipIf(!pool)('consentedAuthorsCteBody — Route 1/2 resolution (real Postgres)', () => {
  it('resolves the full model over the corpus (all-roots scope)', async () => {
    const rows = await consentedFor({ roots: 'all' });
    expect(rows).toEqual([
      // P1: alice (route 1), carol (attested-orcid accept, forged revoke
      // inert), eve (pre-claim accept invalid; accept→resign→re-accept
      // latest-wins), zara (ops-union eligibility). bob demoted by the
      // admin revoke backstop; mallory's slot lives only in the orphaned
      // branch; the attacker accept is unanchored.
      { root_author: 'alice', root_permlink: 'p1', account: 'alice' },
      { root_author: 'alice', root_permlink: 'p1', account: 'carol' },
      { root_author: 'alice', root_permlink: 'p1', account: 'eve' },
      { root_author: 'alice', root_permlink: 'p1', account: 'zara' },
      // P2: the bridge account is the sole consented author of a bridge
      // paper (hive-less credits anchor no one).
      { root_author: BRIDGE, root_permlink: 'b1', account: BRIDGE },
      // P4 (greta) absent entirely: Route-1 root demoted by her own resign.
      // P3 absent: its root carries a `continues` pointer, so the all-roots
      // seed (continues IS NULL) does not select it.
    ]);
  });

  it('matches the all-roots resolution under per-paper scope (P1)', async () => {
    const rows = await consentedFor({ paperAuthor: 'alice', paperPermlink: 'p1' });
    expect(rows.map((r) => r.account)).toEqual(['alice', 'carol', 'eve', 'zara']);
  });

  it('consents the root broadcaster through a cycle-truncated chain (per-paper scope on P3)', async () => {
    const rows = await consentedFor({ paperAuthor: 'frank', paperPermlink: 'p3' });
    expect(rows).toEqual([
      { root_author: 'frank', root_permlink: 'p3', account: 'frank' },
    ]);
  });

  it('narrows the resolved accounts to the signers scope (reputation-cycle shape)', async () => {
    const rows = await consentedFor({ roots: 'all' }, ['carol', 'zara']);
    expect(rows).toEqual([
      { root_author: 'alice', root_permlink: 'p1', account: 'carol' },
      { root_author: 'alice', root_permlink: 'p1', account: 'zara' },
    ]);
  });

  it('the display consent_seed composition matches all-roots on consent-active papers; the remainder is Route-1-only', async () => {
    // The display exclusion surfaces (excludeConsentedSelfWhere consumers)
    // seed the walk from consent_seed (papers with at least one accept/resign
    // op) instead of every root. This pins the seed's exclusion-completeness
    // claim: on consent-active papers the resolution is IDENTICAL to
    // all-roots, and every all-roots row the seed misses is a Route-1
    // root-broadcaster row on a paper with no consent ops — exactly the rows
    // the display poster gates (excludeSelfReviewWhere, voter != author)
    // already exclude without the consent stack.
    const seeded = buildRecursiveWith(
      1,
      activeAccreditationsCteBody,
      (idx) => consentSeedCteBody(idx),
      (idx) => consentChainCteBody(idx, { rootsFromCte: 'consent_seed' }),
      (idx) => consentedAuthorsCteBody(idx),
    );
    let sql = seeded.sql;
    sql = sql.split(T.comments).join('syn_comments');
    sql = sql.split(T.commentOps).join('syn_comment_ops');
    sql = sql.split(T.customJson).join('syn_cj');
    expect(sql).not.toContain('hafsql.');
    const seededRows = (await client!.query(
      `${sql}
       SELECT root_author, root_permlink, account FROM consented_authors
       ORDER BY root_author, root_permlink, account`,
      seeded.params,
    )).rows as Array<{ root_author: string; root_permlink: string; account: string }>;

    // p1 (accept/resign-active) resolves identically to all-roots; p4 is
    // seeded via greta's resign and resolves empty (Route-1 demotion) — same
    // as all-roots, which omits it entirely.
    expect(seededRows).toEqual([
      { root_author: 'alice', root_permlink: 'p1', account: 'alice' },
      { root_author: 'alice', root_permlink: 'p1', account: 'carol' },
      { root_author: 'alice', root_permlink: 'p1', account: 'eve' },
      { root_author: 'alice', root_permlink: 'p1', account: 'zara' },
    ]);

    const allRows = await consentedFor({ roots: 'all' });
    const seededKeys = new Set(seededRows.map((r) => `${r.root_author}/${r.root_permlink}/${r.account}`));
    const missing = allRows.filter((r) => !seededKeys.has(`${r.root_author}/${r.root_permlink}/${r.account}`));
    // The only rows the seed misses are Route-1 roots of consent-op-less
    // papers (b1: the bridge paper, whose sole consented author IS its
    // poster).
    expect(missing).toEqual([{ root_author: BRIDGE, root_permlink: 'b1', account: BRIDGE }]);
    expect(missing.every((r) => r.account === r.root_author)).toBe(true);
  });
});

describe.skipIf(!pool)('authorshipClaimsCteBody — Route 3 over the chain union (real Postgres)', () => {
  async function claimStatuses() {
    const cte = buildRecursiveWith(1, (idx) =>
      authorshipClaimsCteBody(idx, { paperAuthor: 'alice', paperPermlink: 'p1' }));
    let sql = cte.sql;
    sql = sql.split(T.comments).join('syn_comments');
    sql = sql.split(T.commentOps).join('syn_comment_ops');
    sql = sql.split(T.customJson).join('syn_cj');
    expect(sql).not.toContain('hafsql.');
    const result = await client!.query(
      `${sql} SELECT claimer, status FROM authorship_claims ORDER BY claimer`,
      cte.params,
    );
    return result.rows as Array<{ claimer: string; status: string }>;
  }

  it('accepts a name-only claim + author approval; rejects a claim on an anchored slot', async () => {
    const rows = await claimStatuses();
    // The exact-set assertion is ALSO the `isApprovedCoAuthor` (claims.ts)
    // authority pin: the accepted set contains ONLY explicit name-only
    // claim+approve rows. Anchored co-authors (bob's hive slot, carol's
    // attested-ORCID accept) have NO authorship_claims row, so they carry no
    // bridge co-sign authority — a deliberate behavior change from the
    // removed auto-accept arms, under which an ORCID/hive match alone
    // granted it.
    expect(rows).toEqual([
      // davesacct claimed the name-only "Dave D" slot at display index 3 and
      // alice approved → accepted.
      { claimer: 'davesacct', status: 'accepted' },
      // sneaky claimed bob's hive-anchored slot at display index 1; even with
      // alice's approval the name-only gate keeps it pending (anchored slots
      // are Route-2-only; there is no metadata auto-accept either).
      { claimer: 'sneaky', status: 'pending' },
    ]);
  });
});

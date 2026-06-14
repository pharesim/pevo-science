/**
 * Real-Postgres regression for the bridge-paper exclusion on the Route-2
 * ORCID eligibility arm of `consentedAuthorsCteBody` (`hafsql.ts`), run
 * verbatim with its FROMs redirected at a synthetic corpus (the same redirect
 * technique as `consented-authors-cte-real-postgres.test.ts` and
 * `wot-vouch-status-select-real-postgres.test.ts`).
 *
 * What this pins. The sibling corpus in `consented-authors-cte-real-postgres`
 * pins only the no-match bridge case (a bridge ORCID slot whose ORCID matches
 * NO attested account). This file pins the inverse boundary: a bridge slot
 * ORCID that DOES match a live authority-attested accreditation, where that
 * account also broadcasts an `author_accept` for the bridge paper. The
 * account must NOT enter the consented set for the bridge paper — a bridge
 * slot ORCID is external preprint metadata, not a slot vouched-for by an
 * accountable accredited PEvO poster, so it never admits an attested account
 * into credit by ORCID-equality alone (bridge papers stay single-consented
 * via the Route-1 bridge-account arm until the verified bridge-claim flow
 * lands). The non-bridge ORCID-match case in the same corpus stays consented,
 * so the guard does not regress native Route-2 ORCID consent.
 *
 * Why a real planner and not a result mock (per root CLAUDE.md "Running
 * Tests" carve-out):
 *
 *   (a) The discriminating invariant is structural to the SQL — the
 *       `consent_signer_eligibility` ORCID anchor must drop bridge-paper
 *       rows via the bridge `NOT EXISTS` subquery while keeping native ones,
 *       and the resulting eligibility set must then flow correctly through
 *       `route2_stream` / `route2_latest` / `consented_authors`. A result
 *       mock supplies rows directly and is blind to the eligibility join.
 *       Seeding the live HAF mirror with a bridge paper, an ORCID slot, an
 *       attestation, and an accept op per test is not tractable (real
 *       broadcasts + indexing lag), so the production CTE body runs against a
 *       temp-table corpus instead.
 *   (b) No auth middleware: these CTEs sit below the route layer and are
 *       exercised through a raw `pg.Pool`; there is no cryptographic
 *       verification to run real here.
 *   (c) Real-path companion: `consent-ops-real-haf.test.ts` covers the
 *       fetcher's row-shape risk class against live HAF; the reputation
 *       cycle's real-HAF lifecycle test covers the integrated credit path.
 *
 * Corpus map:
 *   B1 bridge/b1 — bridge paper whose sole authors[] slot carries an ORCID
 *     that matches an attested account (claimer). claimer broadcasts a valid
 *     `author_accept` for b1. The bridge exclusion must keep claimer OUT of
 *     b1's consented set; only the bridge account (Route-1) is consented.
 *   N1 nat/n1 — NATIVE paper (hive-anchored root) whose authors[] slot carries
 *     the SAME ORCID. claimer broadcasts a valid `author_accept` for n1. With
 *     no bridge exclusion on native papers, claimer IS consented (Route-2
 *     ORCID anchor), proving the guard does not regress native consent.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { config } from '../src/config.js';
import {
  activeAccreditationsCteBody,
  consentChainCteBody,
  consentedAuthorsCteBody,
  buildRecursiveWith,
  type ConsentChainScope,
} from '../src/hafsql.js';
import { redirectHafViews } from './support/haf-query.js';

const DB_URL = process.env.APP_DATABASE_URL;
const pool = DB_URL ? new pg.Pool({ connectionString: DB_URL, max: 1 }) : null;
let client: pg.PoolClient | null = null;

const TAG = config.appTag;
const BRIDGE = config.hiveBridgeAccount;
const ADMIN = config.hiveAdminAccount; // always in accreditationAuthorities
// The ORCID shared by the bridge slot (B1) and the native slot (N1); the
// claimer account is attested with it, so it anchors a Route-2 ORCID accept
// on native papers but must be excluded on bridge papers.
const SHARED_ORCID = '0000-0002-7777-3333';

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
  // Bridge paper: bridge account is the poster; sole slot carries SHARED_ORCID.
  post(BRIDGE, 'b1', { type: 'bridge_paper', authors: [{ hive: null, name: 'Imported Author', orcid: SHARED_ORCID }] }),
  // Native paper: hive-anchored root (claimer is NOT the root broadcaster, so
  // a Route-1 self-consent does not mask the Route-2 ORCID anchor under test).
  post('nat', 'n1', { type: 'paper', authors: [{ hive: 'nat', name: 'Nat' }, { orcid: SHARED_ORCID, name: 'Imported Author' }] }),
];

const CHAIN_OPS = [
  chainOp(BRIDGE, 'b1', 100, 1100, { type: 'bridge_paper', authors: [{ hive: null, name: 'Imported Author', orcid: SHARED_ORCID }] }),
  chainOp('nat', 'n1', 100, 1200, { type: 'paper', authors: [{ hive: 'nat', name: 'Nat' }, { orcid: SHARED_ORCID, name: 'Imported Author' }] }),
];

const CUSTOM_JSONS = [
  // Authority-signed attestation: claimer carries the SHARED_ORCID anchor.
  cjOp('accredit', ADMIN, { account: 'claimer', orcid: SHARED_ORCID }, 50, 100),
  // claimer accepts on the bridge paper: orcid-equality + valid accept block,
  // but the bridge exclusion drops the eligibility row → NOT consented.
  cjOp('author_accept', 'claimer', { root_author: BRIDGE, root_permlink: 'b1' }, 160, 200),
  // claimer accepts on the native paper: orcid-anchored, valid → consented
  // (the no-regression control).
  cjOp('author_accept', 'claimer', { root_author: 'nat', root_permlink: 'n1' }, 160, 201),
];

/** The view subset this corpus synthesizes. */
const REDIRECTS = { comments: 'syn_comments', commentOps: 'syn_comment_ops', customJson: 'syn_cj' } as const;

function composeRedirected(scope: ConsentChainScope, signers?: string[]) {
  const cte = buildRecursiveWith(
    1,
    activeAccreditationsCteBody,
    (idx) => consentChainCteBody(idx, scope),
    (idx) => consentedAuthorsCteBody(idx, signers ? { signers } : undefined),
  );
  return redirectHafViews(cte, REDIRECTS);
}

async function consentedFor(scope: ConsentChainScope, signers?: string[]) {
  const { sql, params } = composeRedirected(scope, signers);
  // Stricter whole-schema guard on top of the helper's per-literal one.
  expect(sql).not.toContain('hafsql.');
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

describe.skipIf(!pool)('consentedAuthorsCteBody — bridge-paper Route-2 ORCID exclusion (real Postgres)', () => {
  it('keeps an attested ORCID-matching account OUT of a bridge paper consented set despite a valid accept', async () => {
    const rows = await consentedFor({ paperAuthor: BRIDGE, paperPermlink: 'b1' });
    // claimer's ORCID matches the bridge slot AND claimer has a valid
    // author_accept — but the bridge exclusion on the Route-2 ORCID anchor
    // drops the eligibility row, so only the bridge account (Route-1) is
    // consented. If the exclusion regressed, claimer would appear here.
    expect(rows).toEqual([
      { root_author: BRIDGE, root_permlink: 'b1', account: BRIDGE },
    ]);
  });

  it('consents the same attested ORCID account on a NATIVE paper (no regression to Route-2 ORCID consent)', async () => {
    const rows = await consentedFor({ paperAuthor: 'nat', paperPermlink: 'n1' });
    // Same account, same ORCID, same accept shape — but on a native paper the
    // ORCID anchor is unguarded, so claimer IS consented alongside the root
    // broadcaster. This is the inverse control that proves the bridge guard
    // is bridge-scoped, not a blanket ORCID-anchor disablement.
    expect(rows).toEqual([
      { root_author: 'nat', root_permlink: 'n1', account: 'claimer' },
      { root_author: 'nat', root_permlink: 'n1', account: 'nat' },
    ]);
  });

  it('preserves the exclusion under the reputation-cycle signers scope (cycle-vs-display parity)', async () => {
    // The same single builder backs both the reputation cycle (signers-scoped)
    // and the display surfaces (unscoped); scoping the resolution to claimer
    // must still drop the bridge row and keep the native one, so the credited
    // set the cycle reads matches what the display surfaces show.
    const rows = await consentedFor({ roots: 'all' }, ['claimer']);
    expect(rows).toEqual([
      { root_author: 'nat', root_permlink: 'n1', account: 'claimer' },
    ]);
  });
});

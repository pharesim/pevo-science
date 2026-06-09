/**
 * Byte-identical regression for the claim-resolution dedup: the reputation
 * cycle's accepted_claims used to be an inline copy of `authorshipClaimsCteBody`;
 * it now COMPOSES the shared builder and projects `accepted_claims` as
 * `status = 'accepted'`. This test proves the refactor preserved the accepted
 * set: a representative seed run through BOTH the frozen pre-refactor inline
 * resolution AND the new shared builder yields the SAME
 * (claimer, paper_author, paper_permlink) accepted set.
 *
 * The OLD block below is a FROZEN snapshot of the pre-refactor inline
 * `claim_events` + `accepted_claims` resolution (placeholders remapped to the
 * test's $1-$3 harness, logic verbatim). Do NOT "update" it to track the
 * production code — its sole job is to be the independent baseline the new
 * builder is compared against. If a future semantic change to claim resolution
 * makes this diverge intentionally, delete this test rather than syncing the
 * frozen copy.
 *
 * **Carve-out (per root CLAUDE.md "Running Tests"):** synthetic-VALUES against
 * real Postgres.
 *   (a) Real-corpus seeding is impractical: this needs a deterministic mix of
 *       approval / ORCID / hive / unlisted-reject / revoke-reject claim scenarios
 *       with controlled block ordering, which the public HAF corpus cannot be
 *       seeded with at test time. The HAF views are redirected to synthetic CTEs;
 *       the resolution SQL (both the new builder via `authorshipClaimsCteBody` and
 *       the frozen old copy) runs for real over those rows.
 *   (b) No auth/permission middleware in scope — this exercises SQL resolution
 *       directly; `verifyHiveSignature` does not run and is not the focus.
 *   (c) Real-path companion: the builder's per-arm behavior runs against real
 *       Postgres in `authorship-approve-signer-gate.test.ts` /
 *       `authorship-revoke-signer-gate.test.ts` / the ORCID arm tests, and the
 *       assembled cycle runs against real HAF in the reputation lifecycle suite.
 */
import { describe, it, expect } from 'vitest';
import { getPool, isHafConfigured } from '../../src/db.js';
import { T, authorshipClaimsCteBody, chainOrcidAutoAcceptMatchSql } from '../../src/hafsql.js';
import { config } from '../../src/config.js';

const AT = config.appTag;
const BRIDGE = config.hiveBridgeAccount;
const ADMIN = config.hiveAdminAccount;

// dollar-quote JSON so embedded double-quotes never collide with SQL quoting.
const j = (o: unknown) => `$json$${JSON.stringify(o)}$json$::jsonb`;

// ── Representative claim scenarios ──────────────────────────────
// Custom_json ops: claim_authorship omits `claimer` (signer IS the claimer);
// approve/revoke carry `claimer` explicitly (signer is the approver/revoker).
const cjRows = [
  // S1 approval-accept: alice claims a name-only slot 0 on bob/p-approve, bob approves.
  { id: 1, json: { action: 'claim_authorship', paper_author: 'bob', paper_permlink: 'p-approve', author_index: 0 }, auths: ['alice'], block: 100 },
  { id: 2, json: { action: 'approve_authorship', claimer: 'alice', paper_author: 'bob', paper_permlink: 'p-approve', author_index: 0 }, auths: ['bob'], block: 110 },
  // S2 unlisted-reject: carol claims out-of-range slot 5, bob approves → list-final rejects.
  { id: 3, json: { action: 'claim_authorship', paper_author: 'bob', paper_permlink: 'p-approve', author_index: 5 }, auths: ['carol'], block: 101 },
  { id: 4, json: { action: 'approve_authorship', claimer: 'carol', paper_author: 'bob', paper_permlink: 'p-approve', author_index: 5 }, auths: ['bob'], block: 111 },
  // S3 orcid-accept: dave claims slot 0 on bob/p-orcid; dave's attested ORCID matches.
  { id: 5, json: { action: 'claim_authorship', paper_author: 'bob', paper_permlink: 'p-orcid', author_index: 0 }, auths: ['dave'], block: 102 },
  // S4 hive-accept: erin claims slot 0 on bob/p-hive; authors[0].hive === 'erin'.
  { id: 6, json: { action: 'claim_authorship', paper_author: 'bob', paper_permlink: 'p-hive', author_index: 0 }, auths: ['erin'], block: 103 },
  // S5 revoke-reject: frank claims slot 0 (hive match) on bob/p-hive2, bob revokes later.
  { id: 7, json: { action: 'claim_authorship', paper_author: 'bob', paper_permlink: 'p-hive2', author_index: 0 }, auths: ['frank'], block: 104 },
  { id: 8, json: { action: 'revoke_authorship', claimer: 'frank', paper_author: 'bob', paper_permlink: 'p-hive2' }, auths: ['bob'], block: 204 },
  // S6 forged-revoke-reject: grace claims slot 0 (hive match) on bob/p-forge; a
  // stranger (mallory — not the post author, bridge, admin, or claimer) broadcasts
  // a revoke naming grace's claim. The revoke signer gate rejects the forged op,
  // so grace STAYS accepted. This is the one gate the equivalence proof exists to
  // protect: stripping the signer gate from either copy would let the forged
  // revoke void grace, dropping her from the accepted set and turning this red.
  { id: 9, json: { action: 'claim_authorship', paper_author: 'bob', paper_permlink: 'p-forge', author_index: 0 }, auths: ['grace'], block: 105 },
  { id: 10, json: { action: 'revoke_authorship', claimer: 'grace', paper_author: 'bob', paper_permlink: 'p-forge' }, auths: ['mallory'], block: 205 },
];

const paperRows = [
  { author: 'bob', permlink: 'p-approve', meta: { [AT]: { type: 'paper', authors: [{ name: 'Alice A' }] } } },
  { author: 'bob', permlink: 'p-orcid', meta: { [AT]: { type: 'paper', authors: [{ orcid: '0000-0002-1111-2222' }] } } },
  { author: 'bob', permlink: 'p-hive', meta: { [AT]: { type: 'paper', authors: [{ hive: 'erin' }] } } },
  { author: 'bob', permlink: 'p-hive2', meta: { [AT]: { type: 'paper', authors: [{ hive: 'frank' }] } } },
  { author: 'bob', permlink: 'p-forge', meta: { [AT]: { type: 'paper', authors: [{ hive: 'grace' }] } } },
];

const accredRows = [{ account: 'dave', orcid: '0000-0002-1111-2222' }];
const CLAIMERS = ['alice', 'carol', 'dave', 'erin', 'frank', 'grace'];

// Synthetic prelude (no params — values inlined/dollar-quoted). Shared by both
// the old and new resolution queries.
const prelude = `
  synthetic_cj(id, custom_id, json, required_posting_auths, block_num) AS (
    VALUES ${cjRows.map((r) => `(${r.id}::bigint, $json$${AT}$json$::text, ${j(r.json)}, ${j(r.auths)}, ${r.block}::bigint)`).join(',\n           ')}
  ),
  synthetic_comments(author, permlink, parent_author, json_metadata) AS (
    VALUES ${paperRows.map((r) => `($json$${r.author}$json$::text, $json$${r.permlink}$json$::text, ''::text, ${j(r.meta)})`).join(',\n           ')}
  ),
  active_accreditations(account, orcid) AS (
    VALUES ${accredRows.map((r) => `($json$${r.account}$json$::text, $json$${r.orcid}$json$::text)`).join(',\n           ')}
  ),
  target_users(username) AS (
    VALUES ${CLAIMERS.map((u) => `($json$${u}$json$::text)`).join(', ')}
  )`;

// FROZEN pre-refactor inline resolution (placeholders: $1 appTag, $2 bridge,
// $3 admin; scope via target_users). Logic verbatim from the deleted cycle copy.
const OLD_RESOLUTION = `,
  old_claim_events AS (
    SELECT
      cj.json::jsonb ->> 'action' AS action,
      COALESCE(cj.json::jsonb ->> 'claimer', cj.required_posting_auths ->> 0) AS claimer,
      cj.json::jsonb ->> 'paper_author' AS paper_author,
      cj.json::jsonb ->> 'paper_permlink' AS paper_permlink,
      CASE WHEN (cj.json::jsonb ->> 'author_index') ~ '^[0-9]{1,9}$' THEN (cj.json::jsonb ->> 'author_index')::int END AS author_index,
      cj.required_posting_auths ->> 0 AS approver,
      cj.block_num
    FROM synthetic_cj cj
    WHERE cj.custom_id = $1
      AND cj.json::jsonb ->> 'action' IN ('claim_authorship', 'approve_authorship', 'revoke_authorship')
  ),
  old_accepted AS (
    SELECT DISTINCT ce.claimer, ce.paper_author, ce.paper_permlink
    FROM old_claim_events ce
    WHERE ce.action = 'claim_authorship'
      AND ce.claimer IN (SELECT username FROM target_users)
      AND NOT EXISTS (
        SELECT 1 FROM old_claim_events rv
        WHERE rv.action = 'revoke_authorship'
          AND rv.claimer = ce.claimer
          AND rv.paper_author = ce.paper_author
          AND rv.paper_permlink = ce.paper_permlink
          AND rv.block_num > ce.block_num
          AND rv.approver IN (rv.paper_author, $2, $3, rv.claimer)
          AND rv.block_num > COALESCE((
            SELECT MAX(ap.block_num) FROM old_claim_events ap
            WHERE ap.action = 'approve_authorship'
              AND ap.claimer = ce.claimer
              AND ap.paper_author = ce.paper_author
              AND ap.paper_permlink = ce.paper_permlink
              AND ap.approver IN (ap.paper_author, $2)
          ), 0)
      )
      AND (
        (
          ce.author_index IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM old_claim_events ap
            WHERE ap.action = 'approve_authorship'
              AND ap.claimer = ce.claimer
              AND ap.paper_author = ce.paper_author
              AND ap.paper_permlink = ce.paper_permlink
              AND ap.block_num > ce.block_num
              AND ap.approver IN (ap.paper_author, $2)
          )
          AND EXISTS (
            SELECT 1 FROM synthetic_comments c
            WHERE c.author = ce.paper_author AND c.permlink = ce.paper_permlink
              AND c.parent_author = ''
              AND jsonb_typeof(c.json_metadata -> $1 -> 'authors' -> ce.author_index) = 'object'
          )
        )
        OR (ce.author_index IS NOT NULL AND EXISTS (
          SELECT 1 FROM synthetic_comments c
          JOIN active_accreditations aa ON aa.account = ce.claimer
          WHERE c.author = ce.paper_author AND c.permlink = ce.paper_permlink
            AND c.parent_author = ''
            AND aa.orcid IS NOT NULL AND aa.orcid != ''
            AND ${chainOrcidAutoAcceptMatchSql({ metadataExpr: 'c.json_metadata', appTagParam: '$1', authorIndexExpr: 'ce.author_index', attestedOrcidExpr: 'aa.orcid' })}
        ))
        OR (ce.author_index IS NOT NULL AND EXISTS (
          SELECT 1 FROM synthetic_comments c
          WHERE c.author = ce.paper_author AND c.permlink = ce.paper_permlink
            AND c.parent_author = ''
            AND LOWER(TRIM(c.json_metadata -> $1 -> 'authors' -> ce.author_index ->> 'hive')) ~ '^[a-z0-9.-]+$'
            AND LOWER(TRIM(c.json_metadata -> $1 -> 'authors' -> ce.author_index ->> 'hive')) = ce.claimer
        ))
      )
  )`;

type Triple = { claimer: string; paper_author: string; paper_permlink: string };
const key = (r: Triple) => `${r.claimer}|${r.paper_author}|${r.paper_permlink}`;
const sortKeys = (rows: Triple[]) => rows.map(key).sort();

describe('reputation claims dedup — old inline vs new shared builder (byte-identical accepted set)', () => {
  it.skipIf(!isHafConfigured())('the new shared builder yields the same accepted set as the frozen inline copy', { timeout: 30_000 }, async (ctx) => {
    const pool = getPool();
    if (!pool) return ctx.skip(true, 'no pool available');

    // NEW: compose authorshipClaimsCteBody (HAF views redirected to the synthetic
    // CTEs) and project accepted_claims via status = 'accepted', scoped {claimers}.
    const builder = authorshipClaimsCteBody(1, { claimers: CLAIMERS });
    const builderSql = builder.sql
      .split(T.customJson).join('synthetic_cj')
      .split(T.comments).join('synthetic_comments');
    const newQuery = `WITH ${prelude},${builderSql}
      SELECT DISTINCT claimer, paper_author, paper_permlink
      FROM authorship_claims WHERE status = 'accepted'`;
    const newRows = (await pool.query(newQuery, builder.params)).rows as Triple[];

    // OLD: frozen inline resolution over the same synthetic data.
    const oldQuery = `WITH ${prelude}${OLD_RESOLUTION}
      SELECT claimer, paper_author, paper_permlink FROM old_accepted`;
    const oldRows = (await pool.query(oldQuery, [AT, BRIDGE, ADMIN])).rows as Triple[];

    const expected = sortKeys([
      { claimer: 'alice', paper_author: 'bob', paper_permlink: 'p-approve' },
      { claimer: 'dave', paper_author: 'bob', paper_permlink: 'p-orcid' },
      { claimer: 'erin', paper_author: 'bob', paper_permlink: 'p-hive' },
      // grace stays accepted: the forged revoke (S6, signed by a stranger) is
      // rejected by the revoke signer gate, so the hive-match accept survives.
      { claimer: 'grace', paper_author: 'bob', paper_permlink: 'p-forge' },
    ]);

    // The new builder reproduces the frozen inline accepted set exactly...
    expect(sortKeys(newRows)).toEqual(sortKeys(oldRows));
    // ...and both equal the hand-computed representative expectation (so a bug
    // shared by both — e.g. a seed that exercises no arm — cannot pass silently).
    expect(sortKeys(newRows)).toEqual(expected);
    expect(sortKeys(oldRows)).toEqual(expected);
  });
});

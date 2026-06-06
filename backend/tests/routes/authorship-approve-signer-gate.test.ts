/**
 * Behavioral regression for the signer gate on the approve_authorship
 * arm of `authorshipClaimsCteBody` (the read-surface claim resolver in
 * `hafsql.ts`). The reputation cycle's inline `accepted_claims` CTE in
 * `reputation.ts` applies the identical predicate; the two surfaces are kept
 * in sync by mirrored comments so a claim resolves the same way in the cycle
 * and on the read surface.
 *
 * An approve_authorship op is only a valid trust grant when signed by the post
 * author or the bridge account (`config.hiveBridgeAccount`). Pre-gate, the
 * approvals arm matched only the broadcaster-controlled JSON fields (claimer /
 * paper_author / paper_permlink) with no `required_posting_auths` check.
 *
 * Exploit this closes: an already-accredited attacker self-broadcasts a
 * claim_authorship naming a victim's paper, then self-broadcasts an
 * approve_authorship for that claim signed with their OWN posting key. Both
 * ops are permissionless on Hive and bypass the route guard. Pre-gate the
 * self-signed approve resolved the claim to `accepted`, accruing co-author
 * reputation credit on a paper the attacker did not author. The gate admits an
 * approve only when its signer is the post author or the bridge account.
 *
 * **Carve-out clause-(c) justification:** synthetic-VALUES against real
 * Postgres (the `${T.customJson}` view reference in the production
 * `authorshipClaimsCteBody` fragment is redirected to a synthetic CTE,
 * mirroring the retraction-authority-gate test in `hafsql.test.ts` and the
 * reputation ORCID auto-accept gate test).
 *   (a) Real path that's impractical: seeding a self-signed approve op plus a
 *       claim and victim paper on Hive, waiting for HAF indexing, and running
 *       the resolver per test is not a tractable integration shape; the public
 *       corpus is unlikely to contain a forged self-signed approve at all.
 *   (b) `verifyHiveSignature` is NOT mocked — this is a SQL-level computation
 *       test, not a route test. Real Postgres evaluates the signer IN-list;
 *       only the rowset is synthetic.
 *   (c) Real-path companion: the same `authorshipClaimsCteBody` fragment runs
 *       against real HAF in the claims, papers, and profile suites; the risk
 *       class pinned here is the approve_authorship arm trusting only
 *       author-/bridge-signed approves. A targeted revert of the new
 *       `ap.approver IN (ap.paper_author, $bridge)` predicate flips the
 *       self-signed assertion red.
 */
import { describe, it, expect } from 'vitest';
import { getPool, isHafConfigured } from '../../src/db.js';
import { T, activeAccreditationsCteBody, authorshipClaimsCteBody } from '../../src/hafsql.js';
import { config } from '../../src/config.js';

type SyntheticOp = { id: number; json: Record<string, unknown>; signer: string; block: number };

/**
 * Resolve the status of the (claimant, victim, p1) claim against a synthetic
 * set of on-chain ops, running the production `authorshipClaimsCteBody`
 * fragment with its custom_json view redirected to a VALUES CTE and its
 * comments view redirected to a synthetic paper post (the approval arm's
 * list-final gate resolves author_index against an existing authors[] slot).
 * The CTE binds exactly the accreditation + claims fragment params; there is
 * no forced block_num floor, and the synthetic ops are ordered by their own
 * block numbers.
 */
async function resolveClaimStatus(
  pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  ops: SyntheticOp[],
): Promise<string | null> {
  const accredFrag = activeAccreditationsCteBody(1);
  const claimsFrag = authorshipClaimsCteBody(accredFrag.nextIdx);
  // Redirect both HAF view references: custom_json → synthetic ops, comments →
  // the synthetic paper post below. The post is needed because the approval arm
  // now resolves author_index to an existing authors[] slot (list-final gate);
  // T.comments appears multiple times in claimsBody, so split/join replaces all.
  const accredBody = accredFrag.sql.split(T.customJson).join('synthetic_cj');
  const claimsBody = claimsFrag.sql.split(T.customJson).join('synthetic_cj').split(T.comments).join('synthetic_comments');

  const base: unknown[] = [...accredFrag.params, ...claimsFrag.params];

  const valuesRows: string[] = [];
  const opParams: unknown[] = [];
  ops.forEach((op, i) => {
    // Each op binds 5 params: (id, custom_id, json, required_posting_auths, block_num).
    const b = base.length + i * 5;
    valuesRows.push(`($${b + 1}::bigint, $${b + 2}::text, $${b + 3}::jsonb, $${b + 4}::jsonb, $${b + 5}::bigint)`);
    opParams.push(op.id, config.appTag, JSON.stringify(op.json), JSON.stringify([op.signer]), op.block);
  });

  // The synthetic victim/p1 post names a single name-only authors[] slot at
  // index 0 (no hive, no orcid). The claim's author_index = 0 resolves to it, so
  // the approval arm's list-final slot gate is satisfied; the absence of hive/
  // orcid keeps the auto-accept arms silent so status is driven solely by the
  // approval and revocation arms under test.
  const metaParamIdx = base.length + ops.length * 5 + 1;
  const metaJson = JSON.stringify({ [config.appTag]: { authors: [{ name: 'X' }] } });

  const sql = `
    WITH synthetic_cj(id, custom_id, json, required_posting_auths, block_num) AS (
      VALUES ${valuesRows.join(', ')}
    ),
    synthetic_comments(author, permlink, parent_author, json_metadata) AS (
      VALUES ('victim'::text, 'p1'::text, ''::text, $${metaParamIdx}::jsonb)
    ),
    ${accredBody},
    ${claimsBody}
    SELECT status FROM authorship_claims
    WHERE claimer = 'claimant' AND paper_author = 'victim' AND paper_permlink = 'p1'
  `;
  const res = await pool.query(sql, [...base, ...opParams, metaJson]);
  return res.rows.length > 0 ? (res.rows[0].status as string) : null;
}

// author_index = 0 resolves to the name-only slot on the synthetic post, so the
// approval arm's list-final slot gate is satisfied. The slot carries no hive/
// orcid, so the ORCID/hive auto-accept arms (which additionally require a match
// against authors[0]) never fire — status is then driven solely by the approval
// and revocation arms under test.
const claim: SyntheticOp = {
  id: 1,
  json: { action: 'claim_authorship', paper_author: 'victim', paper_permlink: 'p1', author_index: 0 },
  signer: 'claimant',
  block: 100,
};
const approveBy = (signer: string, block = 102): SyntheticOp => ({
  id: 2,
  json: { action: 'approve_authorship', claimer: 'claimant', paper_author: 'victim', paper_permlink: 'p1' },
  signer,
  block,
});

describe('authorshipClaimsCteBody approve_authorship signer gate (synthetic-VALUES)', () => {
  it.skipIf(!isHafConfigured())(
    'a self-signed approve does NOT accept; author-signed and bridge-signed do',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) return ctx.skip(true, 'no pool available');

      // Self-signed: approver = claimer, neither post author nor bridge → the
      // approve_authorship signer gate rejects it → claim stays pending.
      // Reverting the predicate admits the self-signed approve and flips this
      // to 'accepted'.
      expect(
        await resolveClaimStatus(pool, [claim, approveBy('claimant')]),
        'a self-signed approve must NOT resolve the claim to accepted',
      ).toBe('pending');

      // Control: post author signed the approve → accepted.
      expect(
        await resolveClaimStatus(pool, [claim, approveBy('victim')]),
        'an approve signed by the post author must accept',
      ).toBe('accepted');

      // Control: bridge account signed the approve → accepted (the bridge
      // approved-co-author flow for approve_authorship).
      expect(
        await resolveClaimStatus(pool, [claim, approveBy(config.hiveBridgeAccount)]),
        'an approve signed by the bridge account must accept',
      ).toBe('accepted');
    },
  );

  it.skipIf(!isHafConfigured())(
    'a self-signed approve cannot out-rank a revoke; an author-signed approve can',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) return ctx.skip(true, 'no pool available');

      // Claimer self-revokes at block 110 (revoke_authorship is
      // signer-permissive — the claimer may self-revoke). The
      // revoke-override MAX(approve_block) subquery uses the same signer gate,
      // so a later self-signed approve (block 120) is NOT counted and cannot
      // make the revoke look stale → the claim resolves to 'revoked'.
      const revoke: SyntheticOp = {
        id: 3,
        json: { action: 'revoke_authorship', claimer: 'claimant', paper_author: 'victim', paper_permlink: 'p1' },
        signer: 'claimant',
        block: 110,
      };

      expect(
        await resolveClaimStatus(pool, [claim, revoke, approveBy('claimant', 120)]),
        'a self-signed approve must not re-accept a revoked claim',
      ).toBe('revoked');

      // Control: an author-signed approve at block 120 is a valid trust grant
      // that legitimately out-ranks the earlier revoke → 'accepted'.
      expect(
        await resolveClaimStatus(pool, [claim, revoke, approveBy('victim', 120)]),
        'an author-signed approve newer than the revoke must re-accept',
      ).toBe('accepted');
    },
  );
});

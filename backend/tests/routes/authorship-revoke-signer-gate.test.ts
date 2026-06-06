/**
 * Behavioral regression for the signer gate on the revoke_authorship arm of
 * `authorshipClaimsCteBody` (the read-surface claim resolver in `hafsql.ts`).
 * The reputation cycle's inline `accepted_claims` CTE in `reputation.ts`
 * applies the identical predicate; the two surfaces are kept in sync by
 * mirrored comments so a claim is voided the same way in the cycle and on the
 * read surface.
 *
 * A revoke_authorship op voids an accepted claim only when signed by the post
 * author, the bridge account (`config.hiveBridgeAccount`), the admin account
 * (`config.hiveAdminAccount`), or the claimer themselves (per
 * agents/docs/hive-schemas.md §2.11). Pre-gate, the revocations arm matched
 * only the broadcaster-controlled JSON fields (claimer / paper_author /
 * paper_permlink) with no `required_posting_auths` check.
 *
 * Exploit this closes: a stranger broadcasts a revoke_authorship naming a
 * victim's accepted claim, signed with their OWN posting key. The op is
 * permissionless on Hive and bypasses any route guard. Pre-gate the
 * stranger-signed revoke voided the claim, silently stripping the victim's
 * co-author reputation credit from the read surface and the cycle (a free
 * targeted reputation-denial vector). The gate admits a revoke only when its
 * signer is one of the four §2.11 authorities.
 *
 * **Carve-out clause-(c) justification:** synthetic-VALUES against real
 * Postgres (the `${T.customJson}` view reference in the production
 * `authorshipClaimsCteBody` fragment is redirected to a synthetic CTE,
 * mirroring `authorship-approve-signer-gate.test.ts` and the
 * retraction-authority-gate test in `hafsql.test.ts`).
 *   (a) Real path that's impractical: seeding a forged revoke op plus a claim,
 *       an approve, and a victim paper on Hive, waiting for HAF indexing, and
 *       running the resolver per test is not a tractable integration shape; the
 *       public corpus is unlikely to contain a forged stranger-signed revoke at
 *       all.
 *   (b) `verifyHiveSignature` is NOT mocked — this is a SQL-level computation
 *       test, not a route test. Real Postgres evaluates the signer IN-list;
 *       only the rowset is synthetic.
 *   (c) Real-path companion: the same `authorshipClaimsCteBody` fragment runs
 *       against real HAF in the claims, papers, and profile suites; the risk
 *       class pinned here is the revoke_authorship arm trusting only
 *       author-/bridge-/admin-/claimer-signed revokes. A targeted revert of the
 *       new `rv.approver IN (rv.paper_author, $bridge, $admin, rv.claimer)`
 *       predicate flips the stranger-signed assertion red.
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
// Author-signed approve at block 102 establishes an 'accepted' baseline; the
// revoke arm under test then decides whether a later revoke voids it.
const approveByAuthor: SyntheticOp = {
  id: 2,
  json: { action: 'approve_authorship', claimer: 'claimant', paper_author: 'victim', paper_permlink: 'p1' },
  signer: 'victim',
  block: 102,
};
const revokeBy = (signer: string, block = 110): SyntheticOp => ({
  id: 3,
  json: { action: 'revoke_authorship', claimer: 'claimant', paper_author: 'victim', paper_permlink: 'p1' },
  signer,
  block,
});

describe('authorshipClaimsCteBody revoke_authorship signer gate (synthetic-VALUES)', () => {
  it.skipIf(!isHafConfigured())(
    'a stranger-signed revoke does NOT void; author/bridge/admin/claimer revokes do',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) return ctx.skip(true, 'no pool available');

      // Baseline: the claim is accepted (author-signed approve, no revoke).
      expect(
        await resolveClaimStatus(pool, [claim, approveByAuthor]),
        'an author-approved claim with no revoke must be accepted',
      ).toBe('accepted');

      // Forged: a stranger signs the revoke. Their signer is none of the four
      // §2.11 authorities → the revoke signer gate rejects it → the claim
      // stays accepted. Reverting the predicate admits the forged revoke and
      // flips this to 'revoked'.
      expect(
        await resolveClaimStatus(pool, [claim, approveByAuthor, revokeBy('stranger')]),
        'a stranger-signed revoke must NOT void an accepted claim',
      ).toBe('accepted');

      // Control: the post author may revoke.
      expect(
        await resolveClaimStatus(pool, [claim, approveByAuthor, revokeBy('victim')]),
        'a revoke signed by the post author must void the claim',
      ).toBe('revoked');

      // Control: the bridge account may revoke.
      expect(
        await resolveClaimStatus(pool, [claim, approveByAuthor, revokeBy(config.hiveBridgeAccount)]),
        'a revoke signed by the bridge account must void the claim',
      ).toBe('revoked');

      // Control: the admin account may revoke.
      expect(
        await resolveClaimStatus(pool, [claim, approveByAuthor, revokeBy(config.hiveAdminAccount)]),
        'a revoke signed by the admin account must void the claim',
      ).toBe('revoked');

      // Control: the claimer may self-revoke their own claim.
      expect(
        await resolveClaimStatus(pool, [claim, approveByAuthor, revokeBy('claimant')]),
        'a revoke signed by the claimer themselves must void the claim',
      ).toBe('revoked');
    },
  );
});

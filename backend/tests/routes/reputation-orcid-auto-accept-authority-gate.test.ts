/**
 * Behavioral regression for the authority gate on the attested-ORCID anchor
 * of the Route-2 consented-set resolution (the `consent_signer_eligibility`
 * join in `consentedAuthorsCteBody`).
 *
 * An orcid-anchored slot makes an account ELIGIBLE to consent (via
 * `author_accept`) only when the slot's ORCID matches the account's
 * accreditation-attested ORCID. The attested ORCID is sourced from
 * `active_accreditations` (composed via `activeAccreditationsCteBody`), whose
 * `accred_ranked` CTE gates on
 * `required_posting_auths ?| accreditationAuthorities` — i.e. an
 * `accredit`/`revoke` op is only trusted when signed by an accreditation
 * authority, never by the broadcaster's own posting key. (There is no
 * metadata auto-accept anymore; the anchor gates ELIGIBILITY, and the
 * explicit accept op confers consent.)
 *
 * Exploit this closes: an already-accredited attacker reads a victim paper's
 * public on-chain ORCID V, self-broadcasts an `accredit` op (signed with
 * their OWN posting auth, not an authority) setting their attested ORCID to
 * V, then broadcasts `author_accept` for the paper. Without the gate, the
 * self-attested V would anchor the attacker to the slot and their accept
 * would accrue co-author credit on a paper they did not author, every cycle.
 * The gate drops the self-signed attestation so the accept stays inert.
 *
 * **Carve-out clause-(c) justification:** synthetic-VALUES against real
 * Postgres (the `${T.customJson}` view reference in the production
 * `activeAccreditationsCteBody` fragment is redirected to a synthetic CTE,
 * mirroring the retraction-authority-gate test in `hafsql.test.ts`).
 *   (a) Real path that's impractical: seeding a self-signed accredit op + a
 *       victim paper on Hive, waiting for HAF indexing, and running the full
 *       daily reputation cycle per test is not a tractable integration shape;
 *       the public corpus is unlikely to contain a forged self-signed
 *       accreditation at all.
 *   (b) `verifyHiveSignature` is NOT mocked — this is a SQL-level computation
 *       test, not a route test. Real Postgres evaluates the `?|` authority
 *       gate; only the rowset is synthetic.
 *   (c) Real-path companion: the full Route-2 resolution (production
 *       `consentChainCteBody` + `consentedAuthorsCteBody` stack) runs on a
 *       real planner in `consented-authors-cte-real-postgres.test.ts`,
 *       including the self-signed-attestation attacker scenario; the
 *       admin-authority `?` gate on `retractedPapersCteBody` is exercised
 *       the same way in `hafsql.test.ts`. The risk class pinned here is the
 *       eligibility join trusting only authority-signed attestations.
 *
 * The test runs the production `activeAccreditationsCteBody` fragment (only
 * its HAF-view reference is redirected to the synthetic CTE) under a mirror
 * of `consent_signer_eligibility`'s attested-ORCID join, so reverting
 * the `required_posting_auths ?|` gate turns the attacker assertion red.
 */
import { describe, it, expect } from 'vitest';
import { getPool, isHafConfigured } from '../../src/db.js';
import { T, CHAIN_ORCID_BTRIM_CHARSET, activeAccreditationsCteBody } from '../../src/hafsql.js';
import { config } from '../../src/config.js';

describe('Route-2 attested-ORCID anchor — accreditation authority gate (synthetic-VALUES)', () => {
  it.skipIf(!isHafConfigured())(
    'a self-signed (non-authority) accredit op does NOT anchor eligibility; an authority-signed one does',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) return ctx.skip(true, 'no pool available');

      // The ORCID the victim paper publicly lists on an authors[] slot. Both
      // the attacker and the legit co-author self-report this as their
      // attested ORCID; only the authority-signed attestation should anchor
      // Route-2 eligibility.
      const V = '0000-0001-1234-5678';
      // Deterministic test authority, independent of the deployment's
      // configured ACCREDITATION_AUTHORITIES. The production fragment's `?|`
      // gate predicate is what's under test, not the specific authority set.
      const TEST_AUTHORITY = 'accred.authority';

      // Production fragment: $1 = appTag, $2 = authority set. Redirect the HAF
      // view reference to the synthetic CTE so the gate runs over our rows.
      const frag = activeAccreditationsCteBody(1);
      const redirected = frag.sql.replace(T.customJson, 'synthetic_cj');
      const params: unknown[] = [...frag.params];
      params[1] = [TEST_AUTHORITY];

      const attackerOp = JSON.stringify({ action: 'accredit', account: 'attacker', orcid: V });
      const legitOp = JSON.stringify({ action: 'accredit', account: 'legit', orcid: V });
      const paperMeta = JSON.stringify({
        [config.appTag]: { type: 'paper', authors: [{ hive: 'victim', orcid: V }] },
      });
      params.push(
        // synthetic_cj rows: (id, custom_id, json, required_posting_auths, block_num)
        1, config.appTag, attackerOp, JSON.stringify(['attacker']), 100,        // $3-$7  self-signed
        2, config.appTag, legitOp, JSON.stringify([TEST_AUTHORITY]), 101,        // $8-$12 authority-signed
        // synthetic_paper row: (author, permlink, parent_author, json_metadata)
        'victim', 'p1', '', paperMeta,                                           // $13-$16
      );

      const sql = `
        WITH synthetic_cj(id, custom_id, json, required_posting_auths, block_num) AS (
          VALUES ($3::bigint, $4::text, $5::jsonb, $6::jsonb, $7::bigint),
                 ($8::bigint, $9::text, $10::jsonb, $11::jsonb, $12::bigint)
        ),
        synthetic_paper(author, permlink, parent_author, json_metadata) AS (
          VALUES ($13::text, $14::text, $15::text, $16::jsonb)
        ),
        ${redirected}
        SELECT EXISTS (
          -- Mirror of consent_signer_eligibility's attested-ORCID join: the
          -- slot's BTRIM-normalized orcid must equal the account's
          -- authority-attested orcid for the account to be Route-2 eligible.
          SELECT 1 FROM synthetic_paper c
          JOIN active_accreditations aa ON aa.account = $17
          WHERE c.author = 'victim' AND c.permlink = 'p1' AND c.parent_author = ''
            AND aa.orcid IS NOT NULL AND aa.orcid != ''
            AND BTRIM(c.json_metadata -> $1 -> 'authors' -> 0 ->> 'orcid', E'${CHAIN_ORCID_BTRIM_CHARSET}') = aa.orcid
        ) AS eligible
      `;

      // Attacker self-attested V with their own posting auth → dropped by the
      // `?|` authority gate → not in active_accreditations → NOT eligible to
      // anchor the slot. Reverting the gate would admit the self-signed op
      // and flip this to true.
      const attacker = await pool.query(sql, [...params, 'attacker']);
      expect(
        attacker.rows[0].eligible,
        'a self-signed (non-authority) accredit op must NOT anchor Route-2 eligibility',
      ).toBe(false);

      // Legit co-author attested V via an authority-signed op → admitted →
      // eligible to consent (control: the gate does not over-reject genuine
      // authority attestations).
      const legit = await pool.query(sql, [...params, 'legit']);
      expect(
        legit.rows[0].eligible,
        'an authority-signed accredit op must still anchor Route-2 eligibility',
      ).toBe(true);
    },
  );
});

/**
 * Behavioral canary for the ORCID auto-accept arm of the reputation
 * cycle's `accepted_claims` CTE in `reputation.ts`.
 *
 * The arm decides whether a co-author's authorship claim is auto-accepted
 * (and therefore accrues co-author reputation credit) by comparing the
 * broadcaster-controlled chain `authors[i].orcid` against the
 * authority-attested ORCID (sourced from the gated `active_accreditations`
 * CTE). The chain side is BTRIM-stripped with the shared
 * `CHAIN_ORCID_BTRIM_CHARSET` so a whitespace-padded claim (e.g. a
 * tab-prefixed ORCID copied from the ORCID page) resolves identically across
 * the read surfaces (`authorsWithSupersessionSelect`,
 * `authorshipClaimsCteBody`) and the reputation cycle. Without the BTRIM
 * wrapper, the read surfaces auto-accept the padded claim but the reputation
 * cycle byte-mismatches against the attested canonical ORCID, denying the
 * co-author reputation credit every cycle — the cross-surface split this
 * normalization task closes.
 *
 * **Pins the production predicate.** The match SQL is built from the same
 * `chainOrcidAutoAcceptMatchSql` helper that `reputation.ts` and
 * `authorshipClaimsCteBody` use, so a production-side change to the predicate
 * shape (e.g. dropping the BTRIM wrapper back to a raw `=`, or a charset
 * drift in `CHAIN_ORCID_BTRIM_CHARSET`) turns the tab-padded auto-accept
 * assertion red, because that assertion's predicate is built from the helper.
 * The raw-`=` negative control documents the BTRIM-vs-raw semantic contrast —
 * the pre-fix failure mode — by building a raw predicate inline; it does not
 * reference the production call site, so it is not itself a call-site-revert
 * detector. The helper-body BTRIM revert is the mutation it guards against,
 * and that is caught by the tab-padded assertion above.
 *
 * **Carve-out clause-(c) justification:** Synthetic-VALUES against real
 * Postgres (no `${T.customJson}` / `${T.comments}` substitution per-test).
 *   (a) Real path that's impractical: seeding a real paper on Hive with a
 *       tab-padded co-author ORCID claim + the matching accreditation
 *       attestation + waiting for HAF indexing + running the full daily
 *       reputation cycle per test is not a tractable integration-test
 *       shape; the public corpus is unlikely to contain a whitespace-padded
 *       ORCID claim at all.
 *   (b) `verifyHiveSignature` is NOT mocked (this is a SQL-level
 *       computation test, not a route test). Real Postgres runs the
 *       BTRIM normalization + equality; only the rowset is substituted.
 *   (c) Real-path companion: the SQL/JS trim-parity matrix in
 *       `papers-canonical-orcid-resolution.test.ts` exercises the
 *       supersession projection's chain-orcid normalization against the
 *       same `CHAIN_ORCID_BTRIM_CHARSET`, and the byte-level real-Postgres
 *       canary in `hafsql-btrim-charset-real-postgres.test.ts` pins the
 *       charset bytes. The risk class pinned here is the reputation-cycle
 *       auto-accept arm's chain-orcid normalization — orthogonal to the
 *       discrepancy-badge risk class those companions cover.
 */
import { describe, it, expect } from 'vitest';
import { getPool, isHafConfigured } from '../../src/db.js';
import { chainOrcidAutoAcceptMatchSql } from '../../src/hafsql.js';

describe('reputation ORCID auto-accept arm — chain-orcid trim parity (synthetic-VALUES)', () => {
  it.skipIf(!isHafConfigured())(
    'a tab-padded co-author orcid claim auto-accepts (matches the attested ORCID)',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) return ctx.skip(true, 'no pool available');

      const attestedOrcid = '0000-0001-1234-5678';

      // Production predicate, built from the shared helper that reputation.ts
      // and authorshipClaimsCteBody use:
      //   BTRIM(<chain orcid>, E'<charset>') = <attested orcid>.
      // Only the chain side is BTRIM-wrapped (the attested side is canonical,
      // not broadcaster-controlled). A production-side revert of the helper
      // (or a charset drift) changes this string and reds the assertion.
      // `attested` is the synthetic stand-in for active_accreditations.
      const matchPredicate = chainOrcidAutoAcceptMatchSql({
        metadataExpr: 'c.json_metadata',
        appTagParam: '$1',
        authorIndexExpr: '0',
        attestedOrcidExpr: 'attested.orcid',
      });
      const autoAcceptMatch = `
        SELECT EXISTS (
          SELECT 1 FROM paper c
          JOIN attested ON attested.orcid IS NOT NULL AND attested.orcid != ''
          WHERE ${matchPredicate}
        ) AS accepted
      `;

      // (1) Tab-prefixed chain claim. Post-fix BTRIM strips the leading
      // tab, so the claim matches the attested ORCID and auto-accepts.
      // Pre-fix (raw `=`), the tab-padded value byte-mismatches and the
      // co-author's claim is NOT accepted — denying reputation credit.
      const tabPaddedMeta = JSON.stringify({
        pevotest: { type: 'paper', authors: [{ hive: 'bob', orcid: `\t${attestedOrcid}` }] },
      });
      const matched = await pool.query(
        `WITH paper(json_metadata) AS (VALUES ($2::jsonb)),
              attested(orcid) AS (VALUES ($3::text))
         ${autoAcceptMatch}`,
        ['pevotest', tabPaddedMeta, attestedOrcid],
      );
      expect(matched.rows[0].accepted, 'tab-padded orcid claim must auto-accept post-BTRIM').toBe(true);

      // (2) Unpadded chain claim — control. Auto-accepts both pre- and
      // post-fix; pins that the BTRIM wrapper does not over-strip a clean
      // value.
      const cleanMeta = JSON.stringify({
        pevotest: { type: 'paper', authors: [{ hive: 'bob', orcid: attestedOrcid }] },
      });
      const cleanMatched = await pool.query(
        `WITH paper(json_metadata) AS (VALUES ($2::jsonb)),
              attested(orcid) AS (VALUES ($3::text))
         ${autoAcceptMatch}`,
        ['pevotest', cleanMeta, attestedOrcid],
      );
      expect(cleanMatched.rows[0].accepted, 'unpadded orcid claim must auto-accept').toBe(true);

      // (3) Genuinely different ORCID — control. Must NOT auto-accept
      // regardless of trimming, pinning that BTRIM normalizes whitespace
      // only, not the ORCID identity itself.
      const differentMeta = JSON.stringify({
        pevotest: { type: 'paper', authors: [{ hive: 'bob', orcid: '0000-0002-9999-9999' }] },
      });
      const differentMatched = await pool.query(
        `WITH paper(json_metadata) AS (VALUES ($2::jsonb)),
              attested(orcid) AS (VALUES ($3::text))
         ${autoAcceptMatch}`,
        ['pevotest', differentMeta, attestedOrcid],
      );
      expect(differentMatched.rows[0].accepted, 'a different orcid must NOT auto-accept').toBe(false);

      // (4) Negative control: the pre-fix raw-equality shape. The SAME
      // tab-padded claim that auto-accepts through the BTRIM helper above
      // must NOT match under a raw `=`. This documents the BTRIM-vs-raw
      // semantic contrast — the pre-fix failure mode — directly: it builds
      // the raw predicate inline and never references the production call
      // site, so it is not itself a call-site-revert detector. The
      // helper-body BTRIM revert is caught by sub-case (1), whose predicate
      // is built from the helper.
      const rawAutoAccept = `
        SELECT EXISTS (
          SELECT 1 FROM paper c
          JOIN attested ON attested.orcid IS NOT NULL AND attested.orcid != ''
          WHERE (c.json_metadata -> $1 -> 'authors' -> 0 ->> 'orcid') = attested.orcid
        ) AS accepted
      `;
      const rawMatched = await pool.query(
        `WITH paper(json_metadata) AS (VALUES ($2::jsonb)),
              attested(orcid) AS (VALUES ($3::text))
         ${rawAutoAccept}`,
        ['pevotest', tabPaddedMeta, attestedOrcid],
      );
      expect(
        rawMatched.rows[0].accepted,
        'raw-`=` (pre-fix shape) must NOT match the tab-padded claim',
      ).toBe(false);
    },
  );
});

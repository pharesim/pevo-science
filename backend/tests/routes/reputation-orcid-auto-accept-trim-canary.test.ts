/**
 * Behavioral canary for chain-orcid trim parity at the consented-authorship
 * chain CTEs (`consentChainCteBody` in `hafsql.ts`).
 *
 * The ORCID auto-accept arm this file used to pin is GONE — there is no
 * metadata auto-accept; an ORCID anchor only establishes Route-2 eligibility
 * (who may `author_accept`), resolved by `consentedAuthorsCteBody`. The trim
 * risk class survives the move: the orcid-anchored slot extraction
 * (`claimed_orcid_slots`, and the display slot keys) BTRIM-strips the
 * broadcaster-controlled chain `authors[i].orcid` with the shared
 * `CHAIN_ORCID_BTRIM_CHARSET` (ASCII C-whitespace) before equality against
 * the canonical attested ORCID. Without the BTRIM, a whitespace-padded claim
 * (e.g. a tab-prefixed ORCID copied from the ORCID page) would resolve
 * differently across the read surfaces (`authorsWithSupersessionSelect`) and
 * the consent resolution, denying a legitimate co-author Route-2 eligibility
 * every cycle — the same cross-surface split the original normalization
 * closed.
 *
 * Two layers:
 *   1. Emitted-SQL pins on the production `consentChainCteBody` fragment —
 *      a revert that drops the BTRIM wrapper (or drifts the charset) from
 *      the orcid slot extraction turns these red.
 *   2. A behavioral matrix on real Postgres over the extraction's textual
 *      core, documenting the BTRIM-vs-raw semantic contrast.
 *
 * **Carve-out clause-(c) justification:** synthetic-VALUES against real
 * Postgres.
 *   (a) Real path that's impractical: seeding a whitespace-padded ORCID
 *       claim + matching attestation on Hive and waiting for HAF indexing
 *       per test is not tractable; the public corpus is unlikely to contain
 *       a padded claim at all.
 *   (b) `verifyHiveSignature` is NOT mocked (SQL-level computation test).
 *   (c) Real-path companion: the full production chain + consent stack runs
 *       on a real planner in `consented-authors-cte-real-postgres.test.ts`
 *       (orcid-anchored consent included); the SQL/JS trim-parity matrix in
 *       `papers-canonical-orcid-resolution.test.ts` covers the supersession
 *       projection against the same `CHAIN_ORCID_BTRIM_CHARSET`.
 */
import { describe, it, expect } from 'vitest';
import { getPool, isHafConfigured } from '../../src/db.js';
import { CHAIN_ORCID_BTRIM_CHARSET, consentChainCteBody } from '../../src/hafsql.js';

describe('consent chain orcid slots — BTRIM normalization pins', () => {
  it('the production fragment BTRIMs the chain orcid with the shared charset at both slot sites', () => {
    const frag = consentChainCteBody(1, { roots: 'all' });
    // claimed_orcid_slots extraction (Route-2 eligibility anchor).
    const claimedPin = `BTRIM(entry ->> 'orcid', E'${CHAIN_ORCID_BTRIM_CHARSET}')`;
    expect(frag.sql).toContain(claimedPin);
    // display slot key (author_index resolution domain, orcid track).
    const displayPin = `BTRIM(e.value ->> 'orcid', E'${CHAIN_ORCID_BTRIM_CHARSET}')`;
    expect(frag.sql).toContain(displayPin);
    // No raw (un-BTRIMmed) orcid equality may remain in the fragment.
    expect(frag.sql).not.toMatch(/->> 'orcid'\s*=\s*/);
  });
});

describe('consent chain orcid slots — chain-orcid trim parity (synthetic-VALUES)', () => {
  it.skipIf(!isHafConfigured())(
    'a tab-padded orcid slot anchors the attested ORCID owner (matches post-BTRIM)',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) return ctx.skip(true, 'no pool available');

      const attestedOrcid = '0000-0001-1234-5678';

      // Textual core of the claimed_orcid_slots extraction joined to the
      // attested side, as consent_signer_eligibility does: only the chain
      // side is BTRIM-wrapped (the attested side is canonical, not
      // broadcaster-controlled). A charset drift in the production constant
      // changes the emitted-SQL pins above; this matrix documents the
      // behavioral semantics on a real planner.
      const eligibilityMatch = `
        SELECT EXISTS (
          SELECT 1 FROM jsonb_array_elements($2::jsonb -> $1 -> 'authors') AS entry(value)
          JOIN attested ON attested.orcid IS NOT NULL AND attested.orcid != ''
          WHERE BTRIM(entry.value ->> 'orcid', E'${CHAIN_ORCID_BTRIM_CHARSET}') != ''
            AND BTRIM(entry.value ->> 'orcid', E'${CHAIN_ORCID_BTRIM_CHARSET}') = attested.orcid
        ) AS eligible
      `;

      const run = async (orcidOnSlot: string) => {
        const meta = JSON.stringify({
          pevotest: { type: 'paper', authors: [{ orcid: orcidOnSlot, name: 'Pat' }] },
        });
        const res = await pool.query(
          `WITH attested(orcid) AS (VALUES ($3::text)) ${eligibilityMatch}`,
          ['pevotest', meta, attestedOrcid],
        );
        return res.rows[0].eligible as boolean;
      };

      // (1) Tab-prefixed chain claim: BTRIM strips the tab, the slot anchors
      // the attested owner. Under a raw `=` it would byte-mismatch and deny
      // a legitimate co-author Route-2 eligibility.
      expect(await run(`\t${attestedOrcid}`), 'tab-padded orcid slot must anchor post-BTRIM').toBe(true);

      // (2) Unpadded claim — control: BTRIM does not over-strip clean values.
      expect(await run(attestedOrcid), 'unpadded orcid slot must anchor').toBe(true);

      // (3) Genuinely different ORCID — control: BTRIM normalizes whitespace
      // only, never the ORCID identity itself.
      expect(await run('0000-0002-9999-9999'), 'a different orcid must NOT anchor').toBe(false);

      // (4) Negative control — the raw-equality shape: the SAME tab-padded
      // value must NOT match under a raw `=`, documenting the BTRIM-vs-raw
      // contrast (the failure mode the normalization exists to prevent).
      const rawMeta = JSON.stringify({
        pevotest: { type: 'paper', authors: [{ orcid: `\t${attestedOrcid}`, name: 'Pat' }] },
      });
      const raw = await pool.query(
        `WITH attested(orcid) AS (VALUES ($3::text))
         SELECT EXISTS (
           SELECT 1 FROM jsonb_array_elements($2::jsonb -> $1 -> 'authors') AS entry(value)
           JOIN attested ON attested.orcid IS NOT NULL AND attested.orcid != ''
           WHERE (entry.value ->> 'orcid') = attested.orcid
         ) AS eligible`,
        ['pevotest', rawMeta, attestedOrcid],
      );
      expect(raw.rows[0].eligible, 'raw-`=` must NOT match the tab-padded slot').toBe(false);
    },
  );
});

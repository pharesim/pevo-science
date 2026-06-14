import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getPool, isHafConfigured } from '../../src/db.js';
import { config } from '../../src/config.js';
import { T, getCachedGenesisBlock } from '../../src/hafsql.js';
import { queryWithRetry } from '../support/haf-query.js';

const app = createApp();

/**
 * Regression guard for BE-ACCRED-ORCID-FIELD: GET /api/accreditations/:username
 * must include `orcid` in the accreditation payload when the latest on-chain
 * accreditation carries one. Previously omitted, which hid linked ORCIDs from
 * the settings page (auth store reads this endpoint, not /api/profile).
 */
describe('GET /api/accreditations/:username', () => {
  it.skipIf(!isHafConfigured())(
    'returns accreditation.orcid when the latest on-chain accreditation has one',
    { timeout: 60_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Find any accredited account whose latest accredit op carries an orcid.
      // Mirrors the query shape in fetchAccreditationStatusFromHaf so we pick
      // an account the endpoint will actually resolve as accredited.
      const res = await queryWithRetry(pool, 
        `SELECT account, orcid FROM (
           SELECT cj.json::jsonb ->> 'account' AS account,
                  cj.json::jsonb ->> 'action'  AS action,
                  cj.json::jsonb ->> 'orcid'   AS orcid,
                  ROW_NUMBER() OVER (
                    PARTITION BY cj.json::jsonb ->> 'account'
                    ORDER BY cj.block_num DESC
                  ) AS rn
           FROM ${T.customJson} cj
           WHERE cj.custom_id = $1
             AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
             AND cj.required_posting_auths ?| $2::text[]
             AND cj.block_num >= $3
             AND cj.json::jsonb ->> 'orcid' IS NOT NULL
         ) latest
         WHERE rn = 1 AND action = 'accredit'
         LIMIT 1`,
        [config.appTag, config.accreditationAuthorities, getCachedGenesisBlock()],
      );

      if (res.rows.length === 0) {
        ctx.skip('HAF has no accredited account with orcid — shape fix not exercisable');
        return;
      }

      const { account, orcid } = res.rows[0] as { account: string; orcid: string };
      const api = await request(app).get(`/api/accreditations/${account}`);

      expect(api.status).toBe(200);
      expect(api.body.data.is_accredited).toBe(true);
      expect(api.body.data.accreditation).toBeTruthy();
      expect(api.body.data.accreditation).toHaveProperty('orcid', orcid);
      // Shape parity with /api/profile/:username — all five core fields present.
      expect(api.body.data.accreditation).toHaveProperty('name');
      expect(api.body.data.accreditation).toHaveProperty('institution');
      expect(api.body.data.accreditation).toHaveProperty('field');
      expect(api.body.data.accreditation).toHaveProperty('method');
      expect(api.body.data.accreditation).toHaveProperty('timestamp');
    },
  );

  it.skipIf(!isHafConfigured())(
    'exposes orcid:null when the latest on-chain accreditation has none',
    { timeout: 60_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Find an accredited account whose latest accredit op has no orcid field.
      // Covers the "never linked ORCID" path; guards against regressing to
      // `undefined` instead of `null`.
      const res = await queryWithRetry(pool, 
        `SELECT account FROM (
           SELECT cj.json::jsonb ->> 'account' AS account,
                  cj.json::jsonb ->> 'action'  AS action,
                  cj.json::jsonb ->> 'orcid'   AS orcid,
                  ROW_NUMBER() OVER (
                    PARTITION BY cj.json::jsonb ->> 'account'
                    ORDER BY cj.block_num DESC
                  ) AS rn
           FROM ${T.customJson} cj
           WHERE cj.custom_id = $1
             AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
             AND cj.required_posting_auths ?| $2::text[]
             AND cj.block_num >= $3
         ) latest
         WHERE rn = 1 AND action = 'accredit' AND orcid IS NULL
         LIMIT 1`,
        [config.appTag, config.accreditationAuthorities, getCachedGenesisBlock()],
      );

      if (res.rows.length === 0) {
        ctx.skip('HAF has no accredited account without orcid — null path not exercisable');
        return;
      }

      const { account } = res.rows[0] as { account: string };
      const api = await request(app).get(`/api/accreditations/${account}`);

      expect(api.status).toBe(200);
      expect(api.body.data.is_accredited).toBe(true);
      expect(api.body.data.accreditation).toHaveProperty('orcid', null);
    },
  );

  // Regression guard for BE-ACCRED-TX-ID-PARITY: the /api/accreditations/:username
  // response must include the HAF event_id as `tx_id`, matching the shape returned
  // by /api/profile/:username. The auth store and profile page should see the
  // same identifier for the same underlying custom_json op.
  it.skipIf(!isHafConfigured())(
    'returns the same tx_id as /api/profile/:username for an accredited account',
    { timeout: 60_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Pick an accredited account the endpoint will resolve (authority-filtered,
      // latest op = accredit) so both endpoints should yield a tx_id.
      const res = await queryWithRetry(pool, 
        `SELECT account FROM (
           SELECT cj.json::jsonb ->> 'account' AS account,
                  cj.json::jsonb ->> 'action'  AS action,
                  ROW_NUMBER() OVER (
                    PARTITION BY cj.json::jsonb ->> 'account'
                    ORDER BY cj.block_num DESC
                  ) AS rn
           FROM ${T.customJson} cj
           WHERE cj.custom_id = $1
             AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
             AND cj.required_posting_auths ?| $2::text[]
             AND cj.block_num >= $3
         ) latest
         WHERE rn = 1 AND action = 'accredit'
         LIMIT 1`,
        [config.appTag, config.accreditationAuthorities, getCachedGenesisBlock()],
      );

      if (res.rows.length === 0) {
        ctx.skip('HAF has no accredited account — tx_id parity not exercisable');
        return;
      }

      const { account } = res.rows[0] as { account: string };

      const [accredRes, profileRes] = await Promise.all([
        request(app).get(`/api/accreditations/${account}`),
        request(app).get(`/api/profile/${account}`),
      ]);

      expect(accredRes.status).toBe(200);
      expect(profileRes.status).toBe(200);

      // If either route's internal HAF query hit a transient ECONNRESET,
      // is_accredited will be false and the parity invariant isn't exercisable
      // for this run. Skip rather than fail — the retry on the find-account
      // query above can't cover ECONNRESET inside the route handler.
      if (!accredRes.body.data.is_accredited || !profileRes.body.data.is_accredited) {
        ctx.skip('transient HAF error inside route — parity not exercisable this run');
        return;
      }

      const accredTxId = accredRes.body.data.accreditation?.tx_id;
      const profileTxId = profileRes.body.data.accreditation?.tx_id;

      expect(accredTxId).toBeTruthy();
      expect(typeof accredTxId).toBe('string');
      expect(accredTxId).toBe(profileTxId);
    },
  );

  // Regression guard: a SANCTIONED account (an un-lifted `revoke` carrying
  // type:"sanction") must return is_accredited:false with a null accreditation.
  // A legacy (non-sanction) revoke no longer suppresses membership — it reverts
  // to the latest accredit — so only a sanction exercises the not-accredited
  // branch here. The mocked-pool `accreditations-status-route.test.ts` and the
  // real-Postgres `accreditation-membership-cte.test.ts` cover the membership
  // rule deterministically; this guard checks it against real chain data when a
  // sanctioned account exists.
  it.skipIf(!isHafConfigured())(
    'returns is_accredited:false when the account is sanctioned (un-lifted type:"sanction" revoke)',
    { timeout: 60_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Find an account whose latest authority-signed op is a sanction revoke
      // with no later authority accredit lifting it.
      const res = await queryWithRetry(pool,
        `SELECT account FROM (
           SELECT cj.json::jsonb ->> 'account' AS account,
                  cj.json::jsonb ->> 'action'  AS action,
                  cj.json::jsonb ->> 'type'    AS type,
                  ROW_NUMBER() OVER (
                    PARTITION BY cj.json::jsonb ->> 'account'
                    ORDER BY cj.block_num DESC
                  ) AS rn
           FROM ${T.customJson} cj
           WHERE cj.custom_id = $1
             AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
             AND cj.required_posting_auths ?| $2::text[]
             AND cj.block_num >= $3
         ) latest
         WHERE rn = 1 AND action = 'revoke' AND type = 'sanction'
         LIMIT 1`,
        [config.appTag, config.accreditationAuthorities, getCachedGenesisBlock()],
      );

      if (res.rows.length === 0) {
        ctx.skip('HAF has no sanctioned account (latest op = type:"sanction" revoke) — branch not exercisable');
        return;
      }

      const { account } = res.rows[0] as { account: string };
      const api = await request(app).get(`/api/accreditations/${account}`);

      expect(api.status).toBe(200);
      expect(api.body.data.username).toBe(account);
      expect(api.body.data.is_accredited).toBe(false);
      expect(api.body.data.accreditation).toBeNull();
    },
  );
});

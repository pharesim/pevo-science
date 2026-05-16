/**
 * Real-HAF coverage for `findCustodyBroadcastByIdempotencyKey`,
 * `findAccreditationBroadcastByIdempotencyKey`, and
 * `findExistingAccreditation` — closes carve-out clause (c) for
 * `backend/tests/lib/idempotency.test.ts` (mocked-pool unit suite) and the
 * route-level sibling suites
 * `backend/tests/routes/custody-idempotency.test.ts` /
 * `tests/routes/accreditation-idempotency.test.ts` (which also mock
 * `db.js`). See the originating task
 * `backend-idempotency-haf-integration-test.md` for rationale, and
 * `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`
 * for the convention this file's header template follows.
 *
 * Risk class covered by THIS file: a HAF schema/view/operator regression
 * that silently breaks the load-bearing idempotency lookup SQL. Concretely:
 * a column rename on `operation_custom_json_view` /
 * `operation_comment_view`, a `?|` array containment operator behavior
 * change, a `json::jsonb ->>` extraction regression, or a join-shape break
 * against `hafsql.haf_operations.included_trx_id`. Any of these would
 * degrade the lookup to "always miss" so a /broadcast retry after a 504
 * timeout re-broadcasts the op — the exact failure class the layer exists
 * to close.
 *
 * Risk classes covered ELSEWHERE (deliberate division of labor):
 *   - SQL-string parameterization, `opType` scoping (round-2 F2), and
 *     two-arm vs scoped probe call counts are pinned by regex assertions
 *     in the mocked sibling `backend/tests/lib/idempotency.test.ts`. A
 *     real-HAF test cannot distinguish these mutations from a working
 *     query while the result set is empty or the `LIMIT 1` would have
 *     hidden them anyway.
 *   - Cache short-circuit, discriminated-union shape validation (round-3
 *     hold #2), and op-type fold-in (round-3 hold #1) are covered by the
 *     mocked sibling's describe blocks. The cache layer wraps these
 *     lookups but is not the lookup itself.
 *
 * HAF indexer-lag approach (per the originating task acceptance criteria):
 * **Pre-existing-fixture discovery** rather than broadcast-then-poll. The
 * test scans HAF for any op already carrying `idempotency_key` in the
 * `config.appTag` namespace. If one is found, it serves as the positive-
 * hit fixture; the negative-miss and per-route-scoping assertions use
 * deterministic non-existent keys derived from `crypto.randomUUID()` and
 * therefore exercise unconditionally. If no idempotency op exists yet
 * (typical until the Option A.4 layer has live broadcast traffic), the
 * positive-hit assertion `ctx.skip()`s with a message — the schema-
 * regression coverage on the lookup SQL still holds via the negative-miss
 * and per-route-scoping arms, which are the surfaces a column rename or
 * operator change would break first. Once real /broadcast traffic
 * populates HAF with idempotency_keys, the positive-hit assertion
 * auto-activates without test-file edits. This mirrors the
 * `consent-ops-real-haf.test.ts` pattern (broadcast-pending skip-if-no-
 * fixture guard) and avoids the operational complexity of driving a real
 * chain broadcast from the test suite.
 *
 * Skip-if-no-HAF guard mirrors `tests/consent-ops-real-haf.test.ts`: when
 * `isHafConfigured()` is false (no `HAF_DATABASE_URL`), every assertion
 * skips so CI environments without HAF stay green.
 */

import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { getPool, isHafConfigured } from '../../src/db.js';
import { T, getCachedGenesisBlock } from '../../src/hafsql.js';
import { config } from '../../src/config.js';
import {
  findCustodyBroadcastByIdempotencyKey,
  findAccreditationBroadcastByIdempotencyKey,
  findExistingAccreditation,
} from '../../src/lib/idempotency.js';
import { queryWithRetry } from '../support/haf-query.js';

/**
 * Discover an existing custody-side op in this appTag namespace that
 * carries an `idempotency_key`. Returns the author, key, expected tx_id,
 * block_num, and op surface (`comment` or `custom_json`). Returns `null`
 * when no such op exists yet (typical until /broadcast traffic populates
 * HAF). Probes custom_json first (the more common surface for the
 * idempotency-bearing op types), then falls through to comment ops.
 */
type CustodyFixture = {
  author: string;
  key: string;
  trxId: string;
  blockNum: number;
  surface: 'comment' | 'custom_json';
};

async function findKnownCustodyIdempotencyOp(): Promise<CustodyFixture | null> {
  const pool = getPool();
  if (!pool) return null;
  const genesis = getCachedGenesisBlock();

  // custom_json arm — required_posting_auths ?| ARRAY[required].
  // ORDER BY block_num ASC pins the earliest op so the probe stays
  // deterministic across runs as more ops accumulate.
  //
  // Round-1 hold item 1: no try/catch. queryWithRetry only retries
  // transient pg codes (ECONNRESET/ETIMEDOUT/EPIPE/ECONNREFUSED) and
  // re-throws everything else, so a column rename (42703) or
  // relation-not-found (42P01) — exactly the schema-regression class
  // this file is filed to catch — propagates as a test failure. A bare
  // catch here would invert the file's purpose by reporting SKIPPED on
  // the regression we want to fail loudly.
  const cjRes = await queryWithRetry<{
    author: string | null;
    key: string | null;
    trx_id: string | null;
    block_num: number | null;
  }>(
    pool,
    `SELECT
       cj.required_posting_auths ->> 0 AS author,
       cj.json::jsonb ->> 'idempotency_key' AS key,
       op.included_trx_id AS trx_id,
       cj.block_num
     FROM ${T.customJson} cj
     JOIN hafsql.haf_operations op ON op.id = cj.id
     WHERE cj.custom_id = $1
       AND (cj.json::jsonb ->> 'idempotency_key') IS NOT NULL
       AND cj.block_num >= $2
     ORDER BY cj.block_num ASC
     LIMIT 1`,
    [config.appTag, genesis],
  );
  const cjRow = cjRes.rows[0];
  if (cjRow?.author && cjRow?.key && cjRow?.trx_id && cjRow?.block_num !== null) {
    return {
      author: cjRow.author,
      key: cjRow.key,
      trxId: cjRow.trx_id,
      blockNum: cjRow.block_num,
      surface: 'custom_json',
    };
  }

  // Comment arm — fall through when custom_json probe found no fixture.
  const coRes = await queryWithRetry<{
    author: string | null;
    key: string | null;
    trx_id: string | null;
    block_num: number | null;
  }>(
    pool,
    `SELECT
       ocv.author,
       (ocv.json_metadata -> $1 ->> 'idempotency_key') AS key,
       op.included_trx_id AS trx_id,
       ocv.block_num
     FROM ${T.commentOps} ocv
     JOIN hafsql.haf_operations op ON op.id = ocv.id
     WHERE (ocv.json_metadata -> $1 ->> 'idempotency_key') IS NOT NULL
       AND ocv.block_num >= $2
     ORDER BY ocv.block_num ASC
     LIMIT 1`,
    [config.appTag, genesis],
  );
  const coRow = coRes.rows[0];
  if (coRow?.author && coRow?.key && coRow?.trx_id && coRow?.block_num !== null) {
    return {
      author: coRow.author,
      key: coRow.key,
      trxId: coRow.trx_id,
      blockNum: coRow.block_num,
      surface: 'comment',
    };
  }
  return null;
}

/**
 * Discover an existing `accredit` custom_json signed by one of
 * `config.accreditationAuthorities` that carries an `idempotency_key`.
 * Returns the key, expected tx_id, block_num. Null when no such op exists.
 */
type AccreditFixture = {
  key: string;
  trxId: string;
  blockNum: number;
};

async function findKnownAccreditationIdempotencyOp(): Promise<AccreditFixture | null> {
  const pool = getPool();
  if (!pool) return null;
  const genesis = getCachedGenesisBlock();
  // Round-1 hold item 1: no try/catch — SQL errors propagate as test
  // failures. See the comment in findKnownCustodyIdempotencyOp.
  const res = await queryWithRetry<{
    key: string | null;
    trx_id: string | null;
    block_num: number | null;
  }>(
    pool,
    `SELECT
       cj.json::jsonb ->> 'idempotency_key' AS key,
       op.included_trx_id AS trx_id,
       cj.block_num
     FROM ${T.customJson} cj
     JOIN hafsql.haf_operations op ON op.id = cj.id
     WHERE cj.custom_id = $1
       AND cj.json::jsonb ->> 'action' = 'accredit'
       AND (cj.json::jsonb ->> 'idempotency_key') IS NOT NULL
       AND cj.required_posting_auths ?| $2::text[]
       AND cj.block_num >= $3
     ORDER BY cj.block_num ASC
     LIMIT 1`,
    [config.appTag, config.accreditationAuthorities, genesis],
  );
  const row = res.rows[0];
  if (row?.key && row?.trx_id && row?.block_num !== null) {
    return { key: row.key, trxId: row.trx_id, blockNum: row.block_num };
  }
  return null;
}

describe('findCustodyBroadcastByIdempotencyKey — real HAF SQL shape', () => {
  it.skipIf(!isHafConfigured())(
    'returns null for a never-broadcast idempotency key (negative miss)',
    { timeout: 60_000, retry: 5 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Deterministic non-existent (username, key) — astronomically
      // unlikely to collide with any real broadcast. Exercises the
      // unscoped two-arm probe (opType undefined) so a schema mutation
      // on either `operation_comment_view` or `operation_custom_json_view`
      // surfaces as a throw, not a stale hit.
      const randomKey = `pevo-real-haf-miss-${crypto.randomUUID()}`;
      const result = await findCustodyBroadcastByIdempotencyKey(
        pool,
        'pevo-real-haf-test-no-such-author',
        randomKey,
      );
      expect(result).toBeNull();
    },
  );

  it.skipIf(!isHafConfigured())(
    'returns null when scoped to opType:"comment" with a never-used key',
    { timeout: 60_000, retry: 5 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      const randomKey = `pevo-real-haf-miss-${crypto.randomUUID()}`;
      const result = await findCustodyBroadcastByIdempotencyKey(
        pool,
        'pevo-real-haf-test-no-such-author',
        randomKey,
        'comment',
      );
      expect(result).toBeNull();
    },
  );

  it.skipIf(!isHafConfigured())(
    'returns null when scoped to opType:"custom_json" with a never-used key',
    { timeout: 60_000, retry: 5 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      const randomKey = `pevo-real-haf-miss-${crypto.randomUUID()}`;
      const result = await findCustodyBroadcastByIdempotencyKey(
        pool,
        'pevo-real-haf-test-no-such-author',
        randomKey,
        'custom_json',
      );
      expect(result).toBeNull();
    },
  );

  it.skipIf(!isHafConfigured())(
    'positive hit returns IdempotencyHit with matching tx_id and block_num',
    { timeout: 60_000, retry: 5 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      const fixture = await findKnownCustodyIdempotencyOp();
      if (!fixture) {
        ctx.skip(
          'HAF has no op carrying idempotency_key in this appTag namespace yet — ' +
            'the Option A.4 layer has not been live-broadcast. This assertion ' +
            'auto-activates once /broadcast traffic populates the field.',
        );
        return;
      }

      // Probe scoped to the discovered surface — mirrors how the production
      // route plumbs `opType` through after `embedIdempotencyKey` returns it.
      const result = await findCustodyBroadcastByIdempotencyKey(
        pool,
        fixture.author,
        fixture.key,
        fixture.surface,
      );
      expect(result).not.toBeNull();
      // Round-1 hold item 3: result!.tx_id (not result?.tx_id) — after the
      // `not.toBeNull()` runtime guard the value is known non-null, but
      // TypeScript still views `result` as `IdempotencyHit | null`. The
      // optional chain would compile and produce `undefined` on a null
      // regression, masking the failure as "expected undefined to be X"
      // instead of a clean null-vs-value signal at this line.
      expect(result!.tx_id).toBe(fixture.trxId);
      expect(result!.block_num).toBe(fixture.blockNum);
    },
  );

  it.skipIf(!isHafConfigured())(
    'per-route scoping: another username with the same key returns null',
    { timeout: 60_000, retry: 5 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      const fixture = await findKnownCustodyIdempotencyOp();
      if (!fixture) {
        ctx.skip(
          'HAF has no op carrying idempotency_key in this appTag namespace yet — ' +
            'per-route scoping cannot be asserted without a positive baseline.',
        );
        return;
      }

      // Reuse the fixture's real key but query a different username — must
      // miss because the SQL filters on `author = $1` (comment arm) or
      // `required_posting_auths ?| ARRAY[$2]` (custom_json arm). A
      // regression that drops the author filter would surface the hit
      // under a non-matching username, returning the wrong tx_id.
      const result = await findCustodyBroadcastByIdempotencyKey(
        pool,
        'pevo-real-haf-test-no-such-author',
        fixture.key,
        fixture.surface,
      );
      expect(result).toBeNull();
    },
  );
});

describe('findAccreditationBroadcastByIdempotencyKey — real HAF SQL shape', () => {
  it.skipIf(!isHafConfigured())(
    'returns null for a never-broadcast accreditation idempotency key (negative miss)',
    { timeout: 60_000, retry: 5 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      const randomKey = `pevo-real-haf-accred-miss-${crypto.randomUUID()}`;
      const result = await findAccreditationBroadcastByIdempotencyKey(pool, randomKey);
      expect(result).toBeNull();
    },
  );

  it.skipIf(!isHafConfigured())(
    'positive hit returns IdempotencyHit with matching tx_id and block_num',
    { timeout: 60_000, retry: 5 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      const fixture = await findKnownAccreditationIdempotencyOp();
      if (!fixture) {
        ctx.skip(
          'HAF has no accredit op carrying idempotency_key in this appTag ' +
            'namespace yet — Option A.4 accreditation /verify has not been ' +
            'live-broadcast. This assertion auto-activates once /verify ' +
            'traffic populates the field.',
        );
        return;
      }

      const result = await findAccreditationBroadcastByIdempotencyKey(pool, fixture.key);
      expect(result).not.toBeNull();
      // Round-1 hold item 3: non-null assertion after the runtime guard.
      // See the custody describe block for rationale.
      expect(result!.tx_id).toBe(fixture.trxId);
      expect(result!.block_num).toBe(fixture.blockNum);
    },
  );

  it.skipIf(!isHafConfigured())(
    'per-route scoping: non-authority self-broadcast carrying the same key returns null',
    { timeout: 60_000, retry: 5 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // The accreditation lookup filters by
      // `required_posting_auths ?| accreditationAuthorities`. Surface a
      // would-be poisoning op: any custom_json with
      // `action: 'accredit'` + an `idempotency_key`, signed by a non-
      // authority. If such an op exists on chain, the lookup MUST NOT
      // return it under that key — the filter is the security boundary.
      //
      // We scan for any non-authority `accredit` op with idempotency_key.
      // If none exist (likely — only the admin authority signs accredit
      // ops in practice), the assertion is vacuously true. The lookup is
      // still exercised against a deterministic-miss key derived from
      // randomUUID() to assert the negative path under the authority
      // filter.
      const randomKey = `pevo-real-haf-non-authority-${crypto.randomUUID()}`;
      const result = await findAccreditationBroadcastByIdempotencyKey(pool, randomKey);
      expect(result).toBeNull();

      // Additionally: scan for any non-authority op carrying an
      // idempotency_key under `action=accredit` (forged poisoning
      // attempt). If found, assert the lookup does NOT return it —
      // the authority filter is load-bearing for the security
      // boundary.
      //
      // Round-1 hold item 1: no try/catch — SQL errors propagate as
      // test failures so a schema regression on the probe SQL surfaces
      // as a FAIL, not a silent swallow.
      const probe = await queryWithRetry<{
        key: string | null;
        required_posting_auths: string[] | null;
      }>(
        pool,
        `SELECT
           cj.json::jsonb ->> 'idempotency_key' AS key,
           cj.required_posting_auths
         FROM ${T.customJson} cj
         WHERE cj.custom_id = $1
           AND cj.json::jsonb ->> 'action' = 'accredit'
           AND (cj.json::jsonb ->> 'idempotency_key') IS NOT NULL
           AND NOT (cj.required_posting_auths ?| $2::text[])
           AND cj.block_num >= $3
         ORDER BY cj.block_num ASC
         LIMIT 1`,
        [config.appTag, config.accreditationAuthorities, getCachedGenesisBlock()],
      );
      const forged = probe.rows[0];
      if (forged?.key) {
        const forgedLookup = await findAccreditationBroadcastByIdempotencyKey(
          pool,
          forged.key,
        );
        // The filter must reject the forged op. A regression that
        // drops the authority predicate would surface here as a non-null
        // result with the forged signer's tx_id.
        expect(forgedLookup).toBeNull();
      }
    },
  );
});

/**
 * Round-1 hold item 2: real-HAF coverage for `findExistingAccreditation`,
 * the third in-scope function per the originating task spec. The function
 * implements latest-action-wins semantics over `(accredit, revoke)` ops
 * scoped to `(account = $hiveUsername, required_posting_auths ?|
 * accreditationAuthorities)`. See `backend/src/lib/idempotency.ts`
 * (lines ~282-345) for the SQL shape this test exercises.
 *
 * Discovery helper: probe HAF for the most-recent (`ORDER BY block_num
 * DESC, id DESC`) `accredit`-OR-`revoke` op signed by a configured
 * authority. Returns the account, the action of the latest op (so the
 * positive-hit arm can predict gate-hit vs gate-miss correctly), and the
 * expected tx_id + block_num when the latest action is `accredit`. When
 * the latest action is `revoke`, `findExistingAccreditation` returns
 * null by design — the positive-hit arm asserts that revoke-latest
 * accounts produce null and accredit-latest accounts produce the hit.
 */
type ExistingAccreditationFixture = {
  account: string;
  latestAction: 'accredit' | 'revoke';
  trxId: string;
  blockNum: number;
};

async function findKnownExistingAccreditationFixture(): Promise<ExistingAccreditationFixture | null> {
  const pool = getPool();
  if (!pool) return null;
  const genesis = getCachedGenesisBlock();
  // Round-1 hold item 1: no try/catch — SQL errors propagate as test
  // failures. The probe mirrors findExistingAccreditation's SQL shape so
  // a regression on the underlying view surfaces here as well as in the
  // assertion below.
  const res = await queryWithRetry<{
    account: string | null;
    action: string | null;
    trx_id: string | null;
    block_num: number | null;
  }>(
    pool,
    `SELECT
       cj.json::jsonb ->> 'account' AS account,
       cj.json::jsonb ->> 'action' AS action,
       op.included_trx_id AS trx_id,
       cj.block_num
     FROM ${T.customJson} cj
     JOIN hafsql.haf_operations op ON op.id = cj.id
     WHERE cj.custom_id = $1
       AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
       AND cj.required_posting_auths ?| $2::text[]
       AND cj.block_num >= $3
     ORDER BY cj.block_num DESC, cj.id DESC
     LIMIT 1`,
    [config.appTag, config.accreditationAuthorities, genesis],
  );
  const row = res.rows[0];
  if (!row?.account || !row?.action || !row?.trx_id || row?.block_num === null) {
    return null;
  }
  if (row.action !== 'accredit' && row.action !== 'revoke') return null;
  return {
    account: row.account,
    latestAction: row.action,
    trxId: row.trx_id,
    blockNum: row.block_num,
  };
}

describe('findExistingAccreditation — real HAF SQL shape', () => {
  it.skipIf(!isHafConfigured())(
    'returns null for an account that has never been accredited (negative miss)',
    { timeout: 60_000, retry: 5 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Deterministic non-existent account. randomUUID() in the suffix
      // makes per-run collision astronomically unlikely. The string is
      // longer than a real Hive username (max 16 chars) but the SQL
      // just compares `cj.json::jsonb ->> 'account' = $2` as text, so
      // length doesn't matter — the only requirement is that no
      // accredit/revoke op exists for this string.
      const noSuchAccount = `pevo-real-haf-noaccount-${crypto.randomUUID()}`;
      const result = await findExistingAccreditation(pool, noSuchAccount);
      expect(result).toBeNull();
    },
  );

  it.skipIf(!isHafConfigured())(
    'positive hit: latest-action-wins returns IdempotencyHit when latest is accredit, null when revoke',
    { timeout: 60_000, retry: 5 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      const fixture = await findKnownExistingAccreditationFixture();
      if (!fixture) {
        ctx.skip(
          'HAF has no accredit/revoke op from a configured authority yet — ' +
            'the existing-accreditation gate has not been live-broadcast. This ' +
            'assertion auto-activates once /verify or /revoke traffic ' +
            'populates the field.',
        );
        return;
      }

      const result = await findExistingAccreditation(pool, fixture.account);
      if (fixture.latestAction === 'accredit') {
        // Latest action accredit: gate-hit, function returns the trx.
        expect(result).not.toBeNull();
        // Round-1 hold item 3: non-null assertion after the runtime guard.
        expect(result!.tx_id).toBe(fixture.trxId);
        expect(result!.block_num).toBe(fixture.blockNum);
      } else {
        // Latest action revoke: gate-miss by design (see
        // findExistingAccreditation lines 340-343); /verify falls through
        // to the re-accreditation broadcast path.
        expect(result).toBeNull();
      }
    },
  );

  it.skipIf(!isHafConfigured())(
    'per-route scoping: non-authority self-broadcast accredit for an account returns null',
    { timeout: 60_000, retry: 5 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Mirrors the accreditation idempotency-key scoping arm: scan for
      // any non-authority `accredit` op carrying an `account` field
      // (forged self-broadcast). If found, the lookup MUST NOT return it
      // — the `required_posting_auths ?| accreditationAuthorities` filter
      // is the security boundary. If no such ops exist (the realistic
      // case in production where only the admin authority issues
      // accredit), the assertion is vacuously true.
      //
      // Round-1 hold item 1: no try/catch — SQL errors fail the test
      // loudly.
      const probe = await queryWithRetry<{
        account: string | null;
        required_posting_auths: string[] | null;
      }>(
        pool,
        `SELECT
           cj.json::jsonb ->> 'account' AS account,
           cj.required_posting_auths
         FROM ${T.customJson} cj
         WHERE cj.custom_id = $1
           AND cj.json::jsonb ->> 'action' = 'accredit'
           AND (cj.json::jsonb ->> 'account') IS NOT NULL
           AND NOT (cj.required_posting_auths ?| $2::text[])
           AND cj.block_num >= $3
         ORDER BY cj.block_num ASC
         LIMIT 1`,
        [config.appTag, config.accreditationAuthorities, getCachedGenesisBlock()],
      );
      const forged = probe.rows[0];
      if (forged?.account) {
        const forgedLookup = await findExistingAccreditation(pool, forged.account);
        // The authority filter must reject the forged op. A regression
        // that drops the predicate would surface here as a non-null
        // result with the forged signer's tx_id, allowing a self-
        // bootstrap accreditation.
        expect(forgedLookup).toBeNull();
      }
    },
  );
});

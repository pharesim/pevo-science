/**
 * Unit tests for the inline ESLint rule
 * `pevo/no-accred-state-read-missing-id-tiebreaker` defined in
 * `backend/eslint.config.mjs`. The rule fires on accreditation-state
 * "latest accredit/revoke wins" SQL reads whose `block_num DESC` latest-wins
 * ordering lacks the immediate same-block `id DESC` tie-breaker. The deployed
 * HAF mirror views omit `trx_in_block`, so the monotonic op id is the only
 * intra-block key; a dropped tie-breaker resolves a same-block accredit/revoke
 * pair non-deterministically AND passes the whole live-HAF integration suite
 * (the corpus is unlikely to hold a same-block pair for a test account), so a
 * RuleTester unit suite is the only replayable pin on every fire/skip path.
 * See the `(block_num, id)` deterministic-tiebreaker convention:
 *   agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md (Rule 2)
 *   agents/docs/solutions/conventions/accreditation-state-read-latest-action-wins-2026-05-15.md
 *
 * Coverage — VALID (rule stays silent):
 *   - LIMIT-1 single-row read WITH the tie-breaker (the getAccreditationFromHaf
 *     shape).
 *   - OVER/ROW_NUMBER ranking WITH the tie-breaker (the getAccreditedSet shape).
 *   - `op_id DESC` accepted as the secondary key (the union-CTE projection name).
 *   - bare unaliased `id DESC` accepted as the secondary key.
 *   - action filter present but NO ORDER BY / OVER region (the genesis
 *     `MIN(block_num)` aggregate shape): no latest-wins region, nothing to check.
 *   - `LIMIT $N` pagination (parameter limit, not `LIMIT 1`): not a latest-wins
 *     read, so a bare `block_num DESC` does not fire.
 *   - LIMIT-1 read with `block_num DESC` but NO accredit/revoke action filter:
 *     the gate requires the action filter, so out-of-family reads stay silent.
 *   - an SQL line comment containing the word 'accredit' next to a tie-breaker-
 *     less `block_num DESC ... LIMIT 1`: pins `stripSqlLineComments` (the
 *     comment text must not gate the rule).
 *   - bare-alias gate spelling (`WHERE rn = 1 AND action = 'accredit'`) WITH
 *     the tie-breaker in the OVER ranking: pins that the widened gate accepts
 *     the alias form yet stays silent when the read is compliant.
 *   - DISTINCT ON latest-wins read missing the tie-breaker: documented
 *     NOT-flagged gap (no LIMIT 1, no OVER), so the rule stays silent here.
 *
 * Coverage — INVALID (rule fires):
 *   - LIMIT-1 shape missing `id DESC` (the getAccreditationFromHaf form).
 *   - OVER/ROW_NUMBER shape missing `id DESC` (the getAccreditedSet form).
 *   - bare-alias gate spelling firing a real violation: pins that widening the
 *     gate to the `action = 'accredit'` alias form also widens enforcement.
 *   - extracted-fragment in an OVER body: the ranking ORDER BY lifted into a
 *     `${...}` constant taints the window region, reported as `extractedFragment`.
 *   - extracted-fragment in a LIMIT-1 ORDER BY clause: same, the clause-depth
 *     interpolation marker before `LIMIT 1` taints the region.
 *   - META-MUTATION: the REAL getAccreditationFromHaf and getAccreditedSet
 *     literals with `, cj.id DESC` stripped — converts the rule's manual,
 *     reverted probe evidence into a red test, and is the executable pin for
 *     the extracted-fragment silent-disarm class (the same literals WITH the
 *     tie-breaker appear in the valid block as the green baseline).
 *
 * The rule is exported from `eslint.config.mjs` so RuleTester can drive it
 * directly without spinning up the full ESLint engine, mirroring the sibling
 * `no-custom-id-block-num-floor` and `no-bridge-paper-literal` suites.
 */
import { RuleTester } from 'eslint';
// @ts-expect-error — eslint.config.mjs has no .d.ts; the named export is the rule object
import { noAccredStateReadMissingIdTiebreakerRule } from '../../eslint.config.mjs';
import path from 'node:path';

const backendRoot = path.resolve(__dirname, '..', '..');

function abs(rel: string): string {
  return path.join(backendRoot, rel);
}

// The REAL latest-wins literals, reproduced faithfully from their production
// sites, parameterized on the tie-breaker text so a single template yields both
// the compliant baseline (valid) and the META-MUTATION (invalid). The mutation
// is exactly the `, cj.id DESC` drop the prior twice-recurred drift class
// produced. Reproducing the literals rather than importing them keeps the test
// hermetic; the production sites carry the tie-breaker, and a future drop there
// is caught by this rule firing on the real `src/` file under `npx eslint src/`.

// routes/profile.ts getAccreditationFromHaf — LIMIT-1 single-row read.
function getAccreditationFromHafLiteral(tiebreaker: string): string {
  return [
    'const sql = `SELECT cj.json, cj.id AS event_id FROM op_view cj',
    "       WHERE cj.custom_id = $2",
    "         AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')",
    '         AND cj.required_posting_auths ?| $3::text[]',
    "         AND cj.json::jsonb ->> 'account' = $1",
    `       ORDER BY cj.block_num DESC${tiebreaker}`,
    '       LIMIT 1`;',
  ].join('\n');
}

// accreditation.ts getAccreditedSet — ROW_NUMBER/OVER ranking.
function getAccreditedSetLiteral(tiebreaker: string): string {
  return [
    'const sql = `WITH ranked AS (',
    '          SELECT',
    "            cj.json::jsonb ->> 'action' AS action,",
    "            cj.json::jsonb ->> 'account' AS account,",
    `            ROW_NUMBER() OVER (PARTITION BY cj.json::jsonb ->> 'account' ORDER BY cj.block_num DESC${tiebreaker}) AS rn`,
    '          FROM op_view cj',
    '          WHERE cj.custom_id = $1',
    "            AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')",
    '            AND cj.required_posting_auths ?| $2::text[]',
    '        )',
    "        SELECT account FROM ranked WHERE rn = 1 AND action = 'accredit'`;",
  ].join('\n');
}

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run(
  'pevo/no-accred-state-read-missing-id-tiebreaker',
  noAccredStateReadMissingIdTiebreakerRule,
  {
    valid: [
      // LIMIT-1 single-row read WITH the tie-breaker (the real
      // getAccreditationFromHaf shape, compliant baseline). This is also the
      // green companion to the meta-mutation invalid case below.
      {
        filename: abs('src/routes/profile.ts'),
        code: getAccreditationFromHafLiteral(', cj.id DESC'),
      },
      // OVER/ROW_NUMBER ranking WITH the tie-breaker (the real getAccreditedSet
      // shape, compliant baseline). Green companion to its meta-mutation below.
      {
        filename: abs('src/accreditation.ts'),
        code: getAccreditedSetLiteral(', cj.id DESC'),
      },
      // `op_id DESC` accepted as the secondary key — the projection name used
      // by union CTEs that alias the op id to `op_id`.
      {
        filename: abs('src/routes/accreditations.ts'),
        code: [
          "const sql = `SELECT json FROM op_view cj WHERE cj.json::jsonb ->> 'action' = 'accredit'",
          '  ORDER BY block_num DESC, op_id DESC',
          '  LIMIT 1`;',
        ].join('\n'),
      },
      // bare unaliased `id DESC` accepted (the alias-optional arm of the
      // tie-breaker regex `(?:\\w+\\.)?(?:op_)?id`).
      {
        filename: abs('src/routes/accreditations.ts'),
        code: [
          "const sql = `SELECT json FROM op_view cj WHERE cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')",
          '  ORDER BY block_num DESC, id DESC',
          '  LIMIT 1`;',
        ].join('\n'),
      },
      // Action filter present, NO ORDER BY / OVER — the genesis MIN(block_num)
      // aggregate shape. No latest-wins region exists, nothing to check.
      {
        filename: abs('src/hafsql.ts'),
        code: "const sql = `SELECT MIN(cj.block_num) FROM op_view cj WHERE cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')`;",
      },
      // `LIMIT $N` pagination, not `LIMIT 1`. A bare `block_num DESC` here is
      // not a latest-wins single-row read; the rule must not fire.
      {
        filename: abs('src/routes/accreditations.ts'),
        code: [
          "const sql = `SELECT json FROM op_view cj WHERE cj.json::jsonb ->> 'action' = 'accredit'",
          '  ORDER BY cj.block_num DESC',
          '  LIMIT $4 OFFSET $5`;',
        ].join('\n'),
      },
      // LIMIT-1 latest-wins read with `block_num DESC` and NO tie-breaker, but
      // NO accredit/revoke action filter — out of family. The gate requires the
      // action filter in the same literal, so this stays silent.
      {
        filename: abs('src/notification-queries.ts'),
        code: [
          "const sql = `SELECT json FROM op_view cj WHERE cj.json::jsonb ->> 'action' = 'vouch'",
          '  ORDER BY cj.block_num DESC',
          '  LIMIT 1`;',
        ].join('\n'),
      },
      // SQL line comment containing 'accredit' next to a tie-breaker-less
      // latest-wins read. `stripSqlLineComments` removes the comment before the
      // gate runs, so the comment text alone must NOT gate the rule. Mutation:
      // dropping stripSqlLineComments would let the comment's `action =
      // 'accredit'` gate the literal and fire on the tie-breaker-less ORDER BY.
      {
        filename: abs('src/notification-queries.ts'),
        code: [
          'const sql = `SELECT json FROM op_view cj',
          "  -- latest-wins note: action = 'accredit' is handled elsewhere",
          "  WHERE cj.json::jsonb ->> 'action' = 'vouch'",
          '  ORDER BY cj.block_num DESC',
          '  LIMIT 1`;',
        ].join('\n'),
      },
      // Bare-alias gate spelling (`WHERE rn = 1 AND action = 'accredit'`) on a
      // COMPLIANT read: the widened gate accepts the alias form, but the OVER
      // ranking carries the tie-breaker, so the rule stays silent.
      {
        filename: abs('src/accreditation.ts'),
        code: [
          'const sql = `WITH ranked AS (',
          "  SELECT cj.json::jsonb ->> 'account' AS account,",
          "         ROW_NUMBER() OVER (PARTITION BY cj.json::jsonb ->> 'account' ORDER BY cj.block_num DESC, cj.id DESC) AS rn",
          '  FROM op_view cj WHERE cj.custom_id = $1',
          ')',
          "SELECT account FROM ranked WHERE rn = 1 AND action = 'accredit'`;",
        ].join('\n'),
      },
      // DISTINCT ON latest-wins read missing the tie-breaker — the documented
      // NOT-flagged gap. No LIMIT 1, no OVER, so neither region classifier
      // reaches it and the rule stays silent. Pins the recorded decision so a
      // future third-region-classifier change that starts flagging DISTINCT ON
      // turns THIS case red and forces a docstring update.
      {
        filename: abs('src/accreditation.ts'),
        code: [
          "const sql = `SELECT DISTINCT ON (account) account, cj.json FROM op_view cj",
          "  WHERE cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')",
          '  ORDER BY account, cj.block_num DESC`;',
        ].join('\n'),
      },
    ],
    invalid: [
      // LIMIT-1 shape missing the tie-breaker (the getAccreditationFromHaf
      // form, minimal). The single-row latest-state read resolves a same-block
      // pair non-deterministically.
      {
        filename: abs('src/routes/profile.ts'),
        code: [
          "const sql = `SELECT cj.json FROM op_view cj WHERE cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')",
          '  ORDER BY cj.block_num DESC',
          '  LIMIT 1`;',
        ].join('\n'),
        errors: [{ messageId: 'missingTiebreaker' }],
      },
      // OVER/ROW_NUMBER shape missing the tie-breaker (the getAccreditedSet
      // form, minimal). The ranking resolves a same-block pair
      // non-deterministically.
      {
        filename: abs('src/accreditation.ts'),
        code: [
          'const sql = `WITH ranked AS (',
          "  SELECT cj.json::jsonb ->> 'account' AS account,",
          "         ROW_NUMBER() OVER (PARTITION BY cj.json::jsonb ->> 'account' ORDER BY cj.block_num DESC) AS rn",
          '  FROM op_view cj',
          "  WHERE cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')",
          ')',
          'SELECT account FROM ranked WHERE rn = 1`;',
        ].join('\n'),
        errors: [{ messageId: 'missingTiebreaker' }],
      },
      // Bare-alias gate spelling firing a REAL violation: the only action
      // filter naming accredit is the bare `action = 'accredit'` alias form
      // (no quoted-jsonb `'action'` key), and the OVER ranking drops the
      // tie-breaker. Pins that widening the gate to the alias form also widens
      // enforcement — with the pre-widening gate this case produced zero errors.
      {
        filename: abs('src/accreditation.ts'),
        code: [
          'const sql = `WITH ranked AS (',
          "  SELECT cj.json::jsonb ->> 'account' AS account,",
          '         ROW_NUMBER() OVER (PARTITION BY account ORDER BY cj.block_num DESC) AS rn',
          '  FROM op_view cj WHERE cj.custom_id = $1',
          ')',
          "SELECT account FROM ranked WHERE rn = 1 AND action = 'accredit'`;",
        ].join('\n'),
        errors: [{ messageId: 'missingTiebreaker' }],
      },
      // Extracted-fragment in an OVER body: the ranking ORDER BY lifted into a
      // `${rankOrder}` constant. The interpolation marker inside the window
      // body means the rule can no longer SEE the tie-breaker; reported as
      // `extractedFragment` rather than silently passing.
      {
        filename: abs('src/accreditation.ts'),
        code: [
          'const rankOrder = "cj.block_num DESC, cj.id DESC";',
          'const sql = `WITH ranked AS (',
          "  SELECT cj.json::jsonb ->> 'account' AS account,",
          "         ROW_NUMBER() OVER (PARTITION BY cj.json::jsonb ->> 'account' ORDER BY ${rankOrder}) AS rn",
          '  FROM op_view cj',
          "  WHERE cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')",
          ')',
          'SELECT account FROM ranked WHERE rn = 1`;',
        ].join('\n'),
        errors: [{ messageId: 'extractedFragment' }],
      },
      // Extracted-fragment in a LIMIT-1 ORDER BY clause: the ordering lifted
      // into a `${orderClause}` constant sits at clause depth before the
      // `LIMIT 1` terminator, tainting the classified latest-wins region.
      {
        filename: abs('src/routes/profile.ts'),
        code: [
          'const orderClause = "cj.block_num DESC, cj.id DESC";',
          "const sql = `SELECT cj.json FROM op_view cj WHERE cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')",
          '  ORDER BY ${orderClause}',
          '  LIMIT 1`;',
        ].join('\n'),
        errors: [{ messageId: 'extractedFragment' }],
      },
      // META-MUTATION (LIMIT-1 arm): the REAL getAccreditationFromHaf literal
      // with `, cj.id DESC` stripped. Converts the rule's manual, reverted
      // probe into a red test; the WITH-tie-breaker form is the green baseline
      // in the valid block.
      {
        filename: abs('src/routes/profile.ts'),
        code: getAccreditationFromHafLiteral(''),
        errors: [{ messageId: 'missingTiebreaker' }],
      },
      // META-MUTATION (window arm): the REAL getAccreditedSet literal with
      // `, cj.id DESC` stripped. Same construction for the ROW_NUMBER ranking.
      {
        filename: abs('src/accreditation.ts'),
        code: getAccreditedSetLiteral(''),
        errors: [{ messageId: 'missingTiebreaker' }],
      },
    ],
  },
);

// RuleTester reads global `describe` / `it` (vitest provides them when
// `globals: true` is set in vitest.config.ts), so each valid/invalid case
// registers as its own test automatically. No extra wrapper needed.

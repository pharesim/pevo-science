/**
 * Unit tests for the inline ESLint rule `pevo/no-custom-id-block-num-floor`
 * defined in `backend/eslint.config.mjs`. The rule fires on SQL fragments
 * that combine `<alias>.custom_id` with a `block_num >=` predicate in the
 * same template literal (or string-concat chain). That combination forces
 * PostgreSQL into a BitmapAnd plan against `hafsql.operation_custom_json_view`
 * on the live HAF that scans tens of millions of operation rows and blows
 * the per-request walker budget. The known-safe remediation is to drop the
 * `block_num >=` floor; the `custom_id = $appTag` filter alone is selective
 * enough on Mahdi's HAF. See the docstring on `activeAccreditationsCteBody`
 * (backend/src/hafsql.ts) for the planner reasoning.
 *
 * Coverage:
 *   - Violation: CTE-body shape — `WHERE cj.custom_id = $1 AND cj.block_num >= $2`
 *     in a single template literal.
 *   - Violation: inline pool.query — the same shape across multiple SQL lines
 *     inside one template literal (the actual production pattern).
 *   - Violation: alias other than `cj` — the matcher is `\b\w+\.custom_id\b`,
 *     so `c.custom_id` / `op.custom_id` co-occurring with `block_num >=` fires.
 *   - Violation: unaliased `block_num >=` — only the `custom_id` reference
 *     needs an alias prefix; bare `block_num >=` co-occurring with
 *     `<alias>.custom_id` still fires (pins the alias-optionality on the
 *     block_num side of the regex).
 *   - Violation: BinaryExpression '+' concat splitting the two predicates
 *     across two string literals — exercises the `flattenSqlString`
 *     recursion through `+`.
 *   - Violation: template literal with a JavaScript substitution between
 *     the two predicates (e.g. `${at}` in place of `$1`) — exercises the
 *     NUL-placeholder quasi join so the regex still sees both predicate
 *     tokens across the substitution gap.
 *   - Violation: UNALIASED `custom_id` (no `<alias>.` prefix) co-occurring
 *     with `block_num >=` — pins the bare-`custom_id` arm of the broadened
 *     `\b(?:\w+\.)?custom_id\b` matcher (the `loadWotThreshold` shape).
 *   - Violation: `.join()`-assembled fragment — an all-literal array of
 *     clause strings reassembled with `.join(' AND ')` folds to the toxic
 *     combined value and fires (CallExpression visitor + foldArrayJoin).
 *   - Allowed: custom_id only — no `block_num` predicate at all.
 *   - Allowed: block_num only — no `custom_id` reference (different pathology).
 *   - Allowed: strict `block_num >` — only the inclusive `>=` floor is the
 *     BitmapAnd-toxic predicate per the convention; strict `>` is the
 *     windowed-cursor pattern (notification-queries.ts) and is out of scope.
 *   - Allowed: substitution boundary mid-token — `cj.${col} >= $1` does NOT
 *     match `block_num >=` because the NUL placeholder breaks the token
 *     (no false positive across substitution boundaries when the substitution
 *     itself is the column identifier).
 *   - Allowed: substitution splits an IDENTIFIER mid-token —
 *     `cj.custom_${suffix}id` stays silent under the NUL join; this case
 *     mutation-kills the NUL separator (dropping it would concatenate the
 *     quasis into `cj.custom_id` and false-positive).
 *   - Allowed: unrelated SQL with neither predicate.
 *
 * The rule is exported from `eslint.config.mjs` so RuleTester can drive it
 * directly without spinning up the full ESLint engine.
 */
import { RuleTester } from 'eslint';
// @ts-expect-error — eslint.config.mjs has no .d.ts; the named export is the rule object
import { noCustomIdBlockNumFloorRule } from '../../eslint.config.mjs';
import path from 'node:path';

const backendRoot = path.resolve(__dirname, '..', '..');

function abs(rel: string): string {
  return path.join(backendRoot, rel);
}

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('pevo/no-custom-id-block-num-floor', noCustomIdBlockNumFloorRule, {
  valid: [
    // Allowed: custom_id only (the known-safe remediation shape). Mirrors
    // `activeAccreditationsCteBody` after the BitmapAnd fix dropped its
    // genesis floor.
    {
      filename: abs('src/routes/papers.ts'),
      code: 'const sql = `SELECT cj.json FROM op_view cj WHERE cj.custom_id = $1`;',
    },
    // Allowed: block_num floor only, no custom_id reference. Different
    // pathology, not this rule's concern.
    {
      filename: abs('src/routes/papers.ts'),
      code: 'const sql = `SELECT v.* FROM votes v WHERE v.block_num >= $1`;',
    },
    // Allowed: strict `block_num >` (not `>=`) — windowed-cursor delta
    // shape used in notification-queries.ts. The BitmapAnd plan is
    // specific to the inclusive `>=` floor against the small
    // custom_id-selective row set.
    {
      filename: abs('src/notification-queries.ts'),
      code: 'const sql = `SELECT * FROM op_view cj WHERE cj.custom_id = $1 AND cj.block_num > $2`;',
    },
    // Allowed: completely unrelated SQL.
    {
      filename: abs('src/routes/papers.ts'),
      code: 'const sql = `SELECT 1`;',
    },
    // Allowed: substitution boundary breaks the token. `cj.${col} >= $1`
    // does NOT match `block_num >=` because `flattenSqlString` joins
    // quasis with a NUL placeholder. Even if `${col}` happened to be
    // `block_num` at runtime, the rule only sees the AST shape, and the
    // template-literal text "cj." + "\0" + " >= $1" doesn't carry the
    // `block_num` token. Pins the no-false-positive-across-substitution
    // contract.
    {
      filename: abs('src/routes/papers.ts'),
      code: 'const col = "block_num"; const sql = `SELECT * FROM op_view cj WHERE cj.custom_id = $1 AND cj.${col} >= $2`;',
    },
    // Allowed: substitution between custom_id and equality marker. Same
    // contract from the other side: `cj.custom_id` is fully present in
    // one quasi, but the `block_num >=` token is NOT present anywhere in
    // the cooked text — the substitution `${otherCol}` sits where
    // `block_num` would have been.
    {
      filename: abs('src/routes/papers.ts'),
      code: 'const otherCol = "block_num"; const sql = `SELECT * FROM op_view cj WHERE cj.custom_id = $1 AND cj.${otherCol} >= $2`;',
    },
    // Allowed: identifier-only reference (not a SQL string). The rule
    // walks string-resolvable nodes only — a bare JS expression like
    // `obj.custom_id` outside any template literal is silent.
    {
      filename: abs('src/routes/papers.ts'),
      code: 'const x = obj.custom_id; const y = b.block_num >= 0;',
    },
    // Allowed: substitution splits an IDENTIFIER mid-token. The cooked quasis
    // are "...cj.custom_" and "id = $1 AND cj.block_num >= $2", with a
    // substitution sitting between them. `flattenSqlString` joins quasis with
    // a NUL placeholder, so the matcher sees "cj.custom_" + "\0" + "id = $1
    // ..." — the `custom_id` token never forms across the gap, no match,
    // even though a `block_num >=` floor IS present in the second quasi.
    // This is the case that KILLS the NUL-drop mutation: replace the `\0`
    // separator with `''` and the two quasis concatenate to `cj.custom_id =
    // $1 ... block_num >= $2`, the rule false-positives, and this valid case
    // fails red. The column-side substitution cases above do NOT catch that
    // mutation — there the substitution sits between whole tokens (`cj.` + `
    // >= $1`), so joining with `''` vs `\0` yields the same no-match either
    // way and the mutant survives green.
    {
      filename: abs('src/routes/papers.ts'),
      code: 'const suffix = "x"; const sql = `SELECT * FROM op_view cj WHERE cj.custom_${suffix}id = $1 AND cj.block_num >= $2`;',
    },
  ],
  invalid: [
    // Violation: CTE-body shape — `WHERE cj.custom_id = $1 AND cj.block_num >= $2`
    // in a single template literal. This is the canonical toxic form that
    // motivated the rule.
    {
      filename: abs('src/routes/papers.ts'),
      code: 'const sql = `SELECT * FROM op_view cj WHERE cj.custom_id = $1 AND cj.block_num >= $2`;',
      errors: [{ messageId: 'forbidden' }],
    },
    // Violation: inline pool.query — same shape but the two predicates sit
    // on different lines within ONE template literal (the actual
    // production pattern, e.g. the pre-fix `findExistingAccreditation`
    // helper in lib/idempotency.ts).
    {
      filename: abs('src/lib/idempotency.ts'),
      code: [
        'const sql = `SELECT cj.* FROM op_view cj',
        '  WHERE cj.custom_id = $1',
        '    AND cj.json::jsonb ->> \'account\' = $2',
        '    AND cj.block_num >= $3',
        '  ORDER BY cj.block_num DESC`;',
      ].join('\n'),
      errors: [{ messageId: 'forbidden' }],
    },
    // Violation: alias other than `cj` — exercises `\b\w+\.custom_id\b`'s
    // generality. `c.custom_id` is just as toxic on the planner level.
    {
      filename: abs('src/routes/papers.ts'),
      code: 'const sql = `SELECT * FROM op_view c WHERE c.custom_id = $1 AND c.block_num >= $2`;',
      errors: [{ messageId: 'forbidden' }],
    },
    // Violation: unaliased `block_num >=` — only the `custom_id` reference
    // needs an alias prefix; the block_num side accepts bare or aliased.
    // Pins the `\b(?:\w+\.)?block_num\s*>=` arm of the regex.
    {
      filename: abs('src/routes/papers.ts'),
      code: 'const sql = `SELECT * FROM op_view cj WHERE cj.custom_id = $1 AND block_num >= $2`;',
      errors: [{ messageId: 'forbidden' }],
    },
    // Violation: BinaryExpression '+' concat — predicate A in one literal,
    // predicate B in another, joined by `+`. Exercises `flattenSqlString`'s
    // recursion through BinaryExpression to combine the two strings before
    // the regex match.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const sql = 'SELECT * FROM op_view cj WHERE cj.custom_id = $1' + ' AND cj.block_num >= $2';",
      errors: [{ messageId: 'forbidden' }],
    },
    // Violation: template literal with a JavaScript substitution between
    // the two predicates. Production code uses `${T.customJson}` and `${at}`
    // in this shape (see notification-queries.ts revote variants for the
    // structural form, though those use strict `>`). Pins the quasi-join
    // contract: the NUL placeholder between cooked-text segments preserves
    // both predicate tokens for the regex to see.
    {
      filename: abs('src/routes/papers.ts'),
      code: 'const at = "$1"; const sql = `SELECT * FROM op_view cj WHERE cj.custom_id = ${at} AND cj.block_num >= $2`;',
      errors: [{ messageId: 'forbidden' }],
    },
    // Violation: `block_num>=` with no whitespace between column and
    // operator — pins the `\s*` arm in the BLOCK_NUM_FLOOR_RE regex
    // (handwritten SQL sometimes elides whitespace).
    {
      filename: abs('src/routes/papers.ts'),
      code: 'const sql = `SELECT * FROM op_view cj WHERE cj.custom_id = $1 AND cj.block_num>=$2`;',
      errors: [{ messageId: 'forbidden' }],
    },
    // Violation: UNALIASED `custom_id` co-occurring with `block_num >=`.
    // `loadWotThreshold` queries `FROM ${T.customJson}` without an alias and
    // writes `WHERE custom_id = $1 ... AND block_num >= $2` — the same
    // BitmapAnd plan profile. Pins the bare-`custom_id` arm of
    // `\b(?:\w+\.)?custom_id\b`; the `\b...\b` anchors keep this from
    // matching inside a longer identifier like `my_custom_id`.
    {
      filename: abs('src/wot.ts'),
      code: 'const sql = `SELECT json FROM op_view WHERE custom_id = $1 AND block_num >= $2`;',
      errors: [{ messageId: 'forbidden' }],
    },
    // Violation: `.join()`-assembled fragment. A toxic SQL fragment split
    // across an array of clause strings and reassembled with `.join(' AND ')`
    // must still fire. Exercises the CallExpression visitor arm plus the
    // `foldArrayJoin` handler in `flattenSqlString`: an all-literal array +
    // literal separator folds to its concatenated value, so the assembled
    // `... cj.custom_id = $1 AND ... cj.block_num >= $2` matches.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const sql = ['SELECT * FROM op_view cj WHERE cj.custom_id = $1', 'cj.block_num >= $2'].join(' AND ');",
      errors: [{ messageId: 'forbidden' }],
    },
  ],
});

// RuleTester reads global `describe` / `it` (vitest provides them when
// `globals: true` is set in vitest.config.ts), so each valid/invalid case
// registers as its own test automatically. No extra wrapper needed.

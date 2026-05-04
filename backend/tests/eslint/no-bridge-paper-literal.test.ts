/**
 * Unit tests for the inline ESLint rule `pevo/no-bridge-paper-literal` defined
 * in `backend/eslint.config.mjs`. Replaces the negative-coverage tests for the
 * decommissioned `scripts/check-bridge-paper-discipline.sh`.
 *
 * Coverage:
 *   - Direct literal `'bridge_paper'` in a non-allowlisted file → flagged.
 *   - Constant-folded forms (the three the architect's 2026-05-04 unblock
 *     decision narrowed scope to):
 *       (a) BinaryExpression '+': `'bridge_' + 'paper'`
 *       (b) TemplateLiteral (no interp): `` `bridge_paper` ``
 *       (c) Array.prototype.join with literal array + literal sep:
 *           `['bridge', 'paper'].join('_')`
 *   - Allowlisted by named file (src/hafsql.ts, src/helpers.ts, src/bridge.ts)
 *     → silent.
 *   - Allowlisted by structural-path glob (src/types/**) → silent.
 *   - Unrelated string literal in a non-allowlisted file → silent (no false
 *     positives on adjacent code).
 *   - Out-of-scope runtime constructions (`.toLowerCase()`, `.slice()`,
 *     `String.fromCharCode(...)`) → silent (documented evasion, not lint
 *     enforcement; this test pins the scope).
 *
 * The rule is exported from `eslint.config.mjs` so RuleTester can drive it
 * directly without spinning up the full ESLint engine. We pass synthetic
 * filenames (relative to backend/) via the test's `filename` option to
 * exercise the structural-path allowlist logic.
 */
import { RuleTester } from 'eslint';
// @ts-expect-error — eslint.config.mjs has no .d.ts; the named export is the rule object
import { noBridgePaperLiteralRule } from '../../eslint.config.mjs';
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

ruleTester.run('pevo/no-bridge-paper-literal', noBridgePaperLiteralRule, {
  valid: [
    // Allowlisted by named-file: hafsql.ts (the SQL helper).
    {
      filename: abs('src/hafsql.ts'),
      code: "const x = 'bridge_paper';",
    },
    // Allowlisted by named-file: helpers.ts (isPevoBridgePaper predicate).
    {
      filename: abs('src/helpers.ts'),
      code: "if (meta.type === 'bridge_paper') {}",
    },
    // Allowlisted by named-file: bridge.ts (write-side construction).
    {
      filename: abs('src/bridge.ts'),
      code: "const t = { type: 'bridge_paper' };",
    },
    // Allowlisted by glob: anything under src/types/ — types files never
    // perform gate/route/filter at runtime. The rule itself walks ESTree
    // nodes (Literal/TemplateLiteral/BinaryExpression/CallExpression) and
    // does not require TS-specific AST nodes, so plain JS-syntax fixtures
    // exercise the same code paths the real `src/types/hive.ts` triggers.
    {
      filename: abs('src/types/hive.ts'),
      code: 'const kind = "bridge_paper";',
    },
    {
      filename: abs('src/types/some-future-types-file.ts'),
      code: "export const TYPE_LITERAL = 'bridge_paper';",
    },
    // Non-allowlisted file with an unrelated literal — must be silent.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const greeting = 'hello world';",
    },
    // Out-of-scope runtime constructions — documented evasion, NOT lint
    // enforcement. These must NOT be flagged; flagging them would imply the
    // rule resolves runtime values, which it deliberately does not.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const x = 'BRIDGE_PAPER'.toLowerCase();",
    },
    {
      filename: abs('src/routes/papers.ts'),
      code: "const x = 'bridge_paperx'.slice(0, 12);",
    },
    {
      filename: abs('src/routes/papers.ts'),
      // String.fromCharCode(98,114,105,100,103,101,95,112,97,112,101,114) === 'bridge_paper'
      code: 'const x = String.fromCharCode(98,114,105,100,103,101,95,112,97,112,101,114);',
    },
    // Template literal WITH interpolation — also out of scope (we only fold
    // no-interp templates). Must NOT be flagged.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const prefix = 'bridge_'; const x = `${prefix}paper`;",
    },
    // Join with non-literal separator — bail out, do not flag.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const sep = '_'; const x = ['bridge', 'paper'].join(sep);",
    },
  ],
  invalid: [
    // Direct single-quoted literal in a non-allowlisted file.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const x = 'bridge_paper';",
      errors: [{ messageId: 'forbidden' }],
    },
    // Direct double-quoted literal.
    {
      filename: abs('src/routes/search.ts'),
      code: 'const x = "bridge_paper";',
      errors: [{ messageId: 'forbidden' }],
    },
    // Constant-folded form (a): BinaryExpression '+' with two string literals.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const x = 'bridge_' + 'paper';",
      errors: [{ messageId: 'forbidden' }],
    },
    // Constant-folded form (b): TemplateLiteral with no interpolation.
    {
      filename: abs('src/routes/papers.ts'),
      code: 'const x = `bridge_paper`;',
      errors: [{ messageId: 'forbidden' }],
    },
    // Constant-folded form (c): Array.prototype.join with literal array + literal sep.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const x = ['bridge', 'paper'].join('_');",
      errors: [{ messageId: 'forbidden' }],
    },
    // Nested concat: ('bri' + 'dge_') + 'paper' — recursion through BinaryExpression must catch it.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const x = ('bri' + 'dge_') + 'paper';",
      errors: [{ messageId: 'forbidden' }],
    },
  ],
});

// RuleTester reads global `describe` / `it` (vitest provides them when
// `globals: true` is set in vitest.config.ts), so each valid/invalid case
// registers as its own test automatically. No extra wrapper needed.

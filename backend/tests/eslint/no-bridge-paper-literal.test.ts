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
 *   - Default `.join()` (no separator argument) uses the JS-runtime ',' default;
 *     `['bridge_paper'].join()` therefore resolves to `'bridge_paper'` and IS
 *     flagged (pins the default-comma branch of the resolver).
 *   - Mixed-form constant folding (concat + template, concat + join) — exercises
 *     the recursion through heterogeneous resolvable nodes.
 *   - TS-only wrapper nodes (TSAsExpression / TSNonNullExpression /
 *     TSTypeAssertion) — `'bridge_paper' as const`, `'bridge_paper'!`,
 *     `<string>'bridge_paper'`. Accidental-bypass forms inside the rule's
 *     stated scope; the recursion unwraps them. Requires the TS parser, so a
 *     second RuleTester drives these cases.
 *   - Allowlisted by named file (src/hafsql.ts, src/helpers.ts, src/bridge.ts)
 *     → silent.
 *   - Allowlisted by structural-path glob (src/types/**) → silent.
 *   - Unrelated string literal in a non-allowlisted file → silent (no false
 *     positives on adjacent code).
 *   - Out-of-scope runtime constructions (`.toLowerCase()`, `.slice()`,
 *     `String.fromCharCode(...)`) → silent (documented evasion, not lint
 *     enforcement; this test pins the scope).
 *   - `.join()` with a non-resolvable array element bails out (returns null);
 *     a valid test pins the in-scope-by-design bail-out so the early-return
 *     can't be silently removed.
 *
 * The rule is exported from `eslint.config.mjs` so RuleTester can drive it
 * directly without spinning up the full ESLint engine. We pass synthetic
 * filenames (relative to backend/) via the test's `filename` option to
 * exercise the structural-path allowlist logic.
 */
import { RuleTester } from 'eslint';
// @ts-expect-error — eslint.config.mjs has no .d.ts; the named export is the rule object
import { noBridgePaperLiteralRule } from '../../eslint.config.mjs';
import tsParser from '@typescript-eslint/parser';
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

// Separate RuleTester wired to @typescript-eslint/parser so TS-only wrapper
// nodes (TSAsExpression / TSNonNullExpression / TSTypeAssertion) parse into
// the AST the rule unwraps.
const tsRuleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
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
    // Join with a non-resolvable array ELEMENT — pins the in-scope-by-design
    // bail-out at `if (part === null) return null` in `resolveStringValue`.
    // A `.join()` over a literal array containing a variable element must
    // NOT fire; this case locks the contract against accidental removal of
    // the early-return.
    //
    // Shape rationale: with empty separator `''` and array `['bridge_', sep,
    // 'paper']`, removing the early-return would cause the resolver to
    // coerce the non-resolvable middle element to an empty string, yielding
    // `'bridge_' + '' + 'paper'` = `'bridge_paper'` — the rule would then
    // fire and this valid case would fail red. With the early-return
    // intact, the resolver bails on the Identifier element, returns null,
    // and the rule does NOT fire (valid case stays green). The separator
    // value `'whatever'` doesn't matter for the green path (we never reach
    // join) and is named distinctly so a reader doesn't confuse it with the
    // join's empty separator.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const sep = 'whatever'; const x = ['bridge_', sep, 'paper'].join('');",
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
    // Default `.join()` (no separator argument) — JS-runtime default is ','.
    // A singleton array of `'bridge_paper'` joined with the default separator
    // resolves to `'bridge_paper'` and MUST fire. Pins the `sep = ','` default
    // branch of the resolver.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const x = ['bridge_paper'].join();",
      errors: [{ messageId: 'forbidden' }],
    },
    // Mixed-form (a): concat + template — `'bridge_' + \`paper\`` exercises
    // the BinaryExpression branch recursing into TemplateLiteral.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const x = 'bridge_' + `paper`;",
      errors: [{ messageId: 'forbidden' }],
    },
    // Mixed-form (b): concat + join — `'bridge_' + ['paper'].join('')`
    // exercises the BinaryExpression branch recursing into a CallExpression
    // (Array.join) whose array contains a string literal.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const x = 'bridge_' + ['paper'].join('');",
      errors: [{ messageId: 'forbidden' }],
    },
  ],
});

// TS-only wrapper-node coverage. These forms parse into TSAsExpression /
// TSNonNullExpression / TSTypeAssertion ESTree nodes which the rule
// transparently unwraps. They're accidental-bypass forms — idiomatic-TS
// authors reaching for `as const` / `!` / `<T>` without realizing the rule
// previously bailed silently on them — so they sit squarely inside the
// rule's "catch ACCIDENTAL bypasses" scope.
tsRuleTester.run('pevo/no-bridge-paper-literal (TS wrappers)', noBridgePaperLiteralRule, {
  valid: [
    // Sanity: a wrapper around an UNRELATED literal must NOT fire — confirms
    // the unwrap doesn't broaden the rule.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const x = 'hello' as const;",
    },
    // Wrappers inside allowlisted files stay silent.
    {
      filename: abs('src/hafsql.ts'),
      code: "const x = 'bridge_paper' as const;",
    },
  ],
  invalid: [
    // TSAsExpression: `'bridge_paper' as const`
    {
      filename: abs('src/routes/papers.ts'),
      code: "const x = 'bridge_paper' as const;",
      errors: [{ messageId: 'forbidden' }],
    },
    // TSAsExpression with explicit type: `'bridge_paper' as string`
    {
      filename: abs('src/routes/papers.ts'),
      code: "const x = 'bridge_paper' as string;",
      errors: [{ messageId: 'forbidden' }],
    },
    // TSNonNullExpression: `'bridge_paper'!`
    {
      filename: abs('src/routes/papers.ts'),
      code: "const x = 'bridge_paper'!;",
      errors: [{ messageId: 'forbidden' }],
    },
    // TSTypeAssertion: `<string>'bridge_paper'`
    {
      filename: abs('src/routes/papers.ts'),
      code: "const x = <string>'bridge_paper';",
      errors: [{ messageId: 'forbidden' }],
    },
    // Wrapper composing with constant-folding: `('bridge_' as const) + 'paper'`
    // — exercises BinaryExpression recursion into TSAsExpression.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const x = ('bridge_' as const) + 'paper';",
      errors: [{ messageId: 'forbidden' }],
    },
    // Compound-form mutation kill for TSNonNullExpression: `'bridge_'! + 'paper'`
    // — the bare-form `'bridge_paper'!` case above fires via the inner-Literal
    // visitor (ESLint's traversal descends INTO the wrapper), so the
    // TSNonNullExpression arm in resolveStringValue is never exercised by that
    // case. This compound case parses as BinaryExpression with the wrapper on
    // the left; the BinaryExpression visitor fires, resolveStringValue walks
    // into the wrapper, the unwrap arm executes, recursion reaches the inner
    // Literal, and the rule fires. Removing the TSNonNullExpression arm now
    // fails this case red — genuine mutation kill.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const x = 'bridge_'! + 'paper';",
      errors: [{ messageId: 'forbidden' }],
    },
    // Compound-form mutation kill for TSTypeAssertion: `(<string>'bridge_') + 'paper'`
    // — same rationale as the TSNonNullExpression case above. The bare-form
    // `<string>'bridge_paper'` case fires via inner-Literal traversal; this
    // compound form is what actually exercises the TSTypeAssertion arm in
    // resolveStringValue.
    {
      filename: abs('src/routes/papers.ts'),
      code: "const x = (<string>'bridge_') + 'paper';",
      errors: [{ messageId: 'forbidden' }],
    },
  ],
});

// RuleTester reads global `describe` / `it` (vitest provides them when
// `globals: true` is set in vitest.config.ts), so each valid/invalid case
// registers as its own test automatically. No extra wrapper needed.

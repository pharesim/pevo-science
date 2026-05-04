// Minimal ESLint config — safety-focused, not stylistic.
//
// Only the rules called out in BE-ENABLE-ESLINT-TS-RULES + the inline
// `pevo/no-bridge-paper-literal` discipline rule (BE-DISCIPLINE-GUARD-PIPELINE-INTEGRATION)
// are active. Broader rule sets (airbnb / strict / recommended) are
// deliberately NOT enabled: the codebase pragmatically leaks `any` at
// Express/dhive/pg boundaries, and a full opinionated config would drown the
// signal from the rules that actually matter here:
//
// - @typescript-eslint/no-floating-promises (error): burnSentinel and
//   withOrcidBindingLock return Promise<void>; a fire-and-forget caller
//   silently reopens the timing oracle / lock window those helpers exist to
//   close. Hand review cannot reliably catch this; the rule does.
//
// - @typescript-eslint/no-explicit-any (warn): keeps new `any` visible without
//   blocking existing boundary code.
//
// - pevo/no-bridge-paper-literal (error): AST-based discipline guard that
//   replaces the regex-based `scripts/check-bridge-paper-discipline.sh`. Flags
//   `'bridge_paper'` literals — including simple constant-folded forms — in
//   any file outside the structural-path allowlist. See the rule definition
//   below for allowlist + folding-coverage details and the convention:
//   agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md
//
// Frontend has its own tooling; this config is backend-scoped.
import path from 'node:path';
import tseslint from 'typescript-eslint';

const BRIDGE_PAPER = 'bridge_paper';

// Allowlisted files (POSIX paths relative to this config's directory). These
// are the canonical identity-bound files where `bridge_paper` literals are
// the intended source of truth: the SQL helper, the JS predicate, the
// write-side bridge construction. Anything in `src/types/**` is also allowed
// by glob — type-literal modules NEVER perform gate/route/filter at runtime.
const ALLOWLIST_FILES = new Set([
  'src/hafsql.ts',
  'src/helpers.ts',
  'src/bridge.ts',
]);
const ALLOWLIST_GLOB_PREFIXES = ['src/types/'];

function isAllowlistedFile(absoluteFilePath, configDir) {
  if (!absoluteFilePath || absoluteFilePath === '<input>') return false;
  const rel = path.relative(configDir, absoluteFilePath).split(path.sep).join('/');
  if (ALLOWLIST_FILES.has(rel)) return true;
  for (const prefix of ALLOWLIST_GLOB_PREFIXES) {
    if (rel.startsWith(prefix)) return true;
  }
  return false;
}

// Resolve a node to its constant-folded string value, if and only if it's one
// of the simple cases we promised to catch:
//   - StringLiteral:                  'bridge_paper'  /  "bridge_paper"
//   - TemplateLiteral (no interp):    `bridge_paper`
//   - BinaryExpression '+':           'bridge_' + 'paper'  (recursive on both sides)
//   - CallExpression .join():         ['bridge', 'paper'].join('_')
//                                     where the callee is an ArrayExpression of
//                                     resolvable string values and the
//                                     argument (if present) is a string
//                                     literal separator.
// Anything outside these forms returns null — runtime-only constructions
// (toLowerCase, slice, fromCharCode) are documented evasion that requires
// code-review attention, NOT lint enforcement.
function resolveStringValue(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = resolveStringValue(node.left);
    if (left === null) return null;
    const right = resolveStringValue(node.right);
    if (right === null) return null;
    return left + right;
  }
  if (
    node.type === 'CallExpression'
    && node.callee.type === 'MemberExpression'
    && !node.callee.computed
    && node.callee.property.type === 'Identifier'
    && node.callee.property.name === 'join'
    && node.callee.object.type === 'ArrayExpression'
  ) {
    const sepArg = node.arguments[0];
    let sep = ',';
    if (sepArg !== undefined) {
      if (sepArg.type !== 'Literal' || typeof sepArg.value !== 'string') return null;
      sep = sepArg.value;
    }
    const parts = [];
    for (const el of node.callee.object.elements) {
      if (el === null) return null; // sparse array — bail
      const part = resolveStringValue(el);
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join(sep);
  }
  return null;
}

function markDescendants(node, set) {
  if (!node || typeof node !== 'object') return;
  set.add(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        if (c && typeof c === 'object' && typeof c.type === 'string') {
          markDescendants(c, set);
        }
      }
    } else if (child && typeof child === 'object' && typeof child.type === 'string') {
      markDescendants(child, set);
    }
  }
}

const noBridgePaperLiteralRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Forbid 'bridge_paper' literals (and simple constant-folded forms) outside the structural-path allowlist. Replaces backend/scripts/check-bridge-paper-discipline.sh.",
    },
    schema: [],
    messages: {
      forbidden:
        "Direct 'bridge_paper' literal forbidden outside allowlist. Use validPevoPaperWhere() (SQL) or isPevoBridgePaper(meta, author) (JS) instead. See agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md",
    },
  },
  create(context) {
    const configDir = import.meta.dirname;
    const filename = context.filename ?? (typeof context.getFilename === 'function' ? context.getFilename() : undefined);
    if (isAllowlistedFile(filename, configDir)) {
      return {};
    }

    // Track nodes already reported as part of a folded ancestor, so we don't
    // double-report the inner string literal under the BinaryExpression that
    // contains it. We report at the OUTERMOST resolvable node and mark all
    // descendants as already-reported.
    const reported = new WeakSet();

    function check(node) {
      if (reported.has(node)) return;
      const value = resolveStringValue(node);
      if (value === BRIDGE_PAPER) {
        context.report({ node, messageId: 'forbidden' });
        markDescendants(node, reported);
      }
    }

    return {
      Literal: check,
      TemplateLiteral: check,
      BinaryExpression: check,
      CallExpression: check,
    };
  },
};

const pevoPlugin = {
  meta: { name: 'pevo', version: '0.0.0' },
  rules: {
    'no-bridge-paper-literal': noBridgePaperLiteralRule,
  },
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  tseslint.configs.base,
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      pevo: pevoPlugin,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-console': 'off',
      'pevo/no-bridge-paper-literal': 'error',
    },
  },
);

// Exported so unit tests under tests/eslint/ can drive the rule with
// ESLint's RuleTester directly without re-deriving its shape.
export { noBridgePaperLiteralRule };

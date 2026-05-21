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
// - pevo/no-custom-id-block-num-floor (error): regex-based discipline guard
//   that flags SQL fragments combining `<alias>.custom_id` with a
//   `block_num >=` predicate in a single template literal (or string-concat
//   chain). That combination forces PostgreSQL into a BitmapAnd plan against
//   `hafsql.operation_custom_json_view` on the live HAF that scans tens of
//   millions of operation rows and blows the per-request walker budget.
//   The known-safe remediation is to drop the `block_num >=` floor; the
//   `custom_id = $appTag` filter alone is selective enough on Mahdi's HAF.
//   See the docstring on `activeAccreditationsCteBody` (backend/src/hafsql.ts)
//   for the planner reasoning and the convention:
//   agents/docs/solutions/conventions/convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md
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
//   - TS-only wrapper nodes:          'bridge_paper' as const, 'bridge_paper' as string,
//                                     'bridge_paper'!, <string>'bridge_paper'
//                                     (TSAsExpression / TSNonNullExpression /
//                                     TSTypeAssertion — unwrap and recurse on
//                                     the underlying expression; these are
//                                     idiomatic-TS forms that would otherwise
//                                     silently bail the recursion).
// Anything outside these forms returns null — runtime-only constructions
// (toLowerCase, slice, fromCharCode) are documented evasion that requires
// code-review attention, NOT lint enforcement.
function resolveStringValue(node) {
  if (!node) return null;
  // Unwrap TS-only wrapper nodes — accidental-bypass forms inside the rule's
  // stated scope. The wrapped child sits on `.expression` for all three.
  if (
    node.type === 'TSAsExpression'
    || node.type === 'TSNonNullExpression'
    || node.type === 'TSTypeAssertion'
  ) {
    return resolveStringValue(node.expression);
  }
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

// Regexes for the BitmapAnd-toxic SQL combination. The matcher is regex-only
// over the flattened string value of a template literal (or string-concat
// chain). We do not parse SQL — the bridge-paper precedent and the existing
// canary tests under `backend/tests/canaries/` use the same shape-only
// approach.
//
// CUSTOM_ID_RE: `\b\w+\.custom_id\b` — any alias-qualified `custom_id`
//   reference (`cj.custom_id`, `c.custom_id`, etc.). Unaliased bare
//   `custom_id` is excluded by design: every PEvO callsite to date uses an
//   alias (`cj` for `${T.customJson}`), and the unaliased shape would create
//   false positives on jsonb path docstrings and unrelated identifier tokens.
//
// BLOCK_NUM_FLOOR_RE: `\b(?:\w+\.)?block_num\s*>=` — `block_num >=`
//   with or without an alias prefix, allowing optional whitespace between
//   the column and the operator. The toxic predicate is the inclusive
//   floor specifically; strict `block_num >` (used in
//   notification-queries.ts for windowed deltas where the floor is the
//   last-seen-block cursor, not a genesis floor) is excluded — the planner
//   pathology in `activeAccreditationsCteBody`'s docstring is specific to
//   the `>=` predicate against the small `custom_id`-selective row set.
const CUSTOM_ID_RE = /\b\w+\.custom_id\b/;
const BLOCK_NUM_FLOOR_RE = /\b(?:\w+\.)?block_num\s*>=/;

// Flatten a node's string value the way the rule's matcher sees it: all
// quasi text concatenated with a placeholder marker for substitutions, and
// nested string concats walked recursively. The placeholder marker is `\0`
// (NUL) — a character that cannot appear in source-code template-literal
// cooked text and so cannot accidentally cross a predicate boundary
// between two quasis. Anything outside the resolvable forms returns null.
//
// Recognised forms:
//   - StringLiteral:                 (the string value)
//   - TemplateLiteral (any/no interp): cooked quasis joined by \0
//   - BinaryExpression '+':          recursive on left + right, no separator
//                                     (mirrors JS-runtime string concat)
//   - TS-only wrapper nodes:         unwrap (TSAsExpression, TSNonNullExpression,
//                                     TSTypeAssertion) and recurse
// Anything outside these forms returns null.
function flattenSqlString(node) {
  if (!node) return null;
  if (
    node.type === 'TSAsExpression'
    || node.type === 'TSNonNullExpression'
    || node.type === 'TSTypeAssertion'
  ) {
    return flattenSqlString(node.expression);
  }
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node.type === 'TemplateLiteral') {
    // Join all cooked quasi text with a NUL placeholder where each
    // substitution sits. This preserves predicate boundaries: a quasi that
    // ends mid-token (`AND cj.${col} >= $1`) does not let a regex skip
    // across the substitution gap and produce a false positive.
    return node.quasis.map((q) => q.value.cooked).join('\0');
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = flattenSqlString(node.left);
    if (left === null) return null;
    const right = flattenSqlString(node.right);
    if (right === null) return null;
    return left + right;
  }
  return null;
}

const noCustomIdBlockNumFloorRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid combining `<alias>.custom_id` with a `block_num >=` predicate in the same SQL fragment. The combination forces a BitmapAnd plan against hafsql.operation_custom_json_view that scans tens of millions of operation rows. Drop the `block_num >=` floor; `custom_id = $appTag` is selective enough on Mahdi\'s HAF.',
    },
    schema: [],
    messages: {
      forbidden:
        'SQL fragment combines `<alias>.custom_id` with `block_num >=`. This forces a BitmapAnd plan against operation_custom_json_view on the live HAF and blows the walker budget. Drop the `block_num >=` floor; `custom_id = $appTag` is selective enough. See the docstring on `activeAccreditationsCteBody` and agents/docs/solutions/conventions/convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md.',
    },
  },
  create(context) {
    // No file-level allowlist — the BitmapAnd pathology is a property of the
    // SQL plan against `operation_custom_json_view`, and that view has the
    // same plan-shape risk no matter which `.ts` file the query lives in.
    // Existing sites that genuinely need the floor (per-account /
    // per-orcid / idempotency-key lookups whose additional JSONB predicates
    // make the planner pick a different path) suppress the rule with an
    // `eslint-disable-next-line` comment carrying a rationale anchored on
    // the route handler or helper symbol.
    const reported = new WeakSet();

    function check(node) {
      if (reported.has(node)) return;
      const flat = flattenSqlString(node);
      if (flat === null) return;
      if (!CUSTOM_ID_RE.test(flat)) return;
      if (!BLOCK_NUM_FLOOR_RE.test(flat)) return;
      context.report({ node, messageId: 'forbidden' });
      markDescendants(node, reported);
    }

    return {
      Literal: check,
      TemplateLiteral: check,
      BinaryExpression: check,
    };
  },
};

const pevoPlugin = {
  meta: { name: 'pevo', version: '0.0.0' },
  rules: {
    'no-bridge-paper-literal': noBridgePaperLiteralRule,
    'no-custom-id-block-num-floor': noCustomIdBlockNumFloorRule,
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
      'pevo/no-custom-id-block-num-floor': 'error',
    },
  },
);

// Exported so unit tests under tests/eslint/ can drive the rules with
// ESLint's RuleTester directly without re-deriving their shape.
export { noBridgePaperLiteralRule, noCustomIdBlockNumFloorRule };

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
//   that flags SQL fragments combining a `custom_id` column reference (aliased
//   `cj.custom_id` or bare unaliased `custom_id`) with a `block_num >=`
//   predicate in a single template literal, string-concat chain, or
//   `.join()`-assembled fragment. That combination forces PostgreSQL into a BitmapAnd plan against
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

// Shared string-flattening core for both inline SQL/literal rules. Walks the
// node arms common to BOTH rules — TS-only wrapper unwrap, StringLiteral, and
// BinaryExpression '+' recursion (the JS-runtime concat) — and delegates the
// two arms where the rules diverge (TemplateLiteral, CallExpression) to a
// per-rule `handlers` object. `recurse` is the rule's own top-level resolver
// so nested children route back through that rule's handlers, not this core.
//
// Common arms:
//   - StringLiteral:        'x' / "x"                 → the string value
//   - BinaryExpression '+': left + right              → recurse both, concat
//   - TS-only wrappers:     'x' as const, 'x'!, <T>'x'
//                           (TSAsExpression / TSNonNullExpression /
//                           TSTypeAssertion — unwrap `.expression` and recurse;
//                           idiomatic-TS forms that would otherwise silently
//                           bail the recursion).
//
// Delegated arms (optional per rule, called as `handler(node, recurse)`):
//   - handlers.template:    TemplateLiteral
//   - handlers.call:        CallExpression
//
// Anything outside the common arms and the supplied handlers returns null —
// runtime-only constructions (toLowerCase, slice, fromCharCode) are documented
// evasion that requires code-review attention, NOT lint enforcement.
function foldStringExpr(node, handlers, recurse) {
  if (!node) return null;
  // Unwrap TS-only wrapper nodes — accidental-bypass forms inside both rules'
  // stated scope. The wrapped child sits on `.expression` for all three.
  if (
    node.type === 'TSAsExpression'
    || node.type === 'TSNonNullExpression'
    || node.type === 'TSTypeAssertion'
  ) {
    return recurse(node.expression);
  }
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = recurse(node.left);
    if (left === null) return null;
    const right = recurse(node.right);
    if (right === null) return null;
    return left + right;
  }
  if (node.type === 'TemplateLiteral' && handlers.template) {
    return handlers.template(node, recurse);
  }
  if (node.type === 'CallExpression' && handlers.call) {
    return handlers.call(node, recurse);
  }
  return null;
}

// `.join()`-over-a-literal-array folding, shared by both rules. The callee
// must be a non-computed `.join` member access on an ArrayExpression of
// resolvable string values; the separator (if present) must be a string
// literal, defaulting to the JS-runtime ','. A non-resolvable element or a
// non-literal separator bails to null. `recurse` resolves each array element
// through the calling rule's handlers.
function foldArrayJoin(node, recurse) {
  if (
    node.callee.type !== 'MemberExpression'
    || node.callee.computed
    || node.callee.property.type !== 'Identifier'
    || node.callee.property.name !== 'join'
    || node.callee.object.type !== 'ArrayExpression'
  ) {
    return null;
  }
  const sepArg = node.arguments[0];
  let sep = ',';
  if (sepArg !== undefined) {
    if (sepArg.type !== 'Literal' || typeof sepArg.value !== 'string') return null;
    sep = sepArg.value;
  }
  const parts = [];
  for (const el of node.callee.object.elements) {
    if (el === null) return null; // sparse array — bail
    const part = recurse(el);
    if (part === null) return null;
    parts.push(part);
  }
  return parts.join(sep);
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
  return foldStringExpr(
    node,
    {
      // Bridge rule folds ONLY no-interpolation templates to their cooked
      // value; an interpolated template is a runtime construction and bails.
      template: (n) =>
        n.expressions.length === 0 && n.quasis.length === 1
          ? n.quasis[0].value.cooked
          : null,
      call: foldArrayJoin,
    },
    resolveStringValue,
  );
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
// CUSTOM_ID_RE: `\b(?:\w+\.)?custom_id\b` — a `custom_id` column reference
//   with or without an alias prefix (`cj.custom_id`, `c.custom_id`, or bare
//   `custom_id`). The bare form is included because callsites that query
//   `FROM ${T.customJson}` without aliasing (e.g. `loadWotThreshold`) write
//   `WHERE custom_id = $1 ... AND block_num >= $2` unaliased, and that shape
//   has the identical BitmapAnd plan profile. The `\b...\b` anchors exclude
//   substring matches inside longer identifiers (`my_custom_id`). False
//   positives are bounded because the rule fires ONLY when BOTH this and the
//   `block_num >=` floor co-occur in the same flattened fragment — jsonb-path
//   string keys and unrelated identifier tokens almost never sit alongside a
//   `block_num >=` predicate, and none do in the current tree.
//
// BLOCK_NUM_FLOOR_RE: `\b(?:\w+\.)?block_num\s*>=` — `block_num >=`
//   with or without an alias prefix, allowing optional whitespace between
//   the column and the operator. The toxic predicate is the inclusive
//   floor specifically; strict `block_num >` (used in
//   notification-queries.ts for windowed deltas where the floor is the
//   last-seen-block cursor, not a genesis floor) is excluded — the planner
//   pathology in `activeAccreditationsCteBody`'s docstring is specific to
//   the `>=` predicate against the small `custom_id`-selective row set.
const CUSTOM_ID_RE = /\b(?:\w+\.)?custom_id\b/;
const BLOCK_NUM_FLOOR_RE = /\b(?:\w+\.)?block_num\s*>=/;

// Flatten a node's string value the way the floor rule's matcher sees it:
// all quasi text concatenated with a placeholder marker for substitutions,
// nested string concats walked recursively, and `.join()`-over-a-literal-
// array assembled into its concatenated value. The placeholder marker is
// `\0` (NUL) — a character that cannot appear in source-code template-literal
// cooked text and so cannot accidentally cross a predicate boundary between
// two quasis. Anything outside the resolvable forms returns null.
//
// Recognised forms (the common arms — StringLiteral, BinaryExpression '+',
// TS-only wrappers — live in `foldStringExpr`; the two below are this rule's
// divergent handlers):
//   - TemplateLiteral (any/no interp): cooked quasis joined by \0. Joining
//     with NUL preserves predicate boundaries: a quasi that ends mid-token
//     (`AND cj.${col} >= $1`) does not let a regex skip across the
//     substitution gap and produce a false positive. Mid-IDENTIFIER splits
//     (`cj.custom_${suffix}`) likewise stay broken by the NUL, so a
//     substitution that would textually complete `custom_id` does not match.
//   - CallExpression .join(): `['... custom_id ...', '... block_num >= ...']
//     .join(' AND ')` — an all-literal join assembles to its real
//     concatenated value (no substitution boundary exists to preserve, since
//     every element and the separator are string literals), so a toxic
//     fragment assembled via `.join()` is caught rather than evading the rule.
function flattenSqlString(node) {
  return foldStringExpr(
    node,
    {
      template: (n) => n.quasis.map((q) => q.value.cooked).join('\0'),
      call: foldArrayJoin,
    },
    flattenSqlString,
  );
}

const noCustomIdBlockNumFloorRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid combining a `custom_id` column reference (aliased or bare) with a `block_num >=` predicate in the same SQL fragment. The combination forces a BitmapAnd plan against hafsql.operation_custom_json_view that scans tens of millions of operation rows. Drop the `block_num >=` floor; `custom_id = $appTag` is selective enough on Mahdi\'s HAF.',
    },
    schema: [],
    messages: {
      forbidden:
        'SQL fragment combines a `custom_id` column reference with `block_num >=`. This forces a BitmapAnd plan against operation_custom_json_view on the live HAF and blows the walker budget. Drop the `block_num >=` floor; `custom_id = $appTag` is selective enough. See the docstring on `activeAccreditationsCteBody` and agents/docs/solutions/conventions/convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md.',
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
      // CallExpression covers `.join()`-assembled fragments (e.g.
      // `[...].join(' AND ')`); `flattenSqlString` folds the literal-array
      // join into its concatenated value so a toxic fragment can't evade the
      // rule by being assembled at runtime from an array of clause strings.
      CallExpression: check,
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
  {
    // Production code (`src/`) must NOT import the anonymous-review test seam.
    // `__test_seams` on the anonymousReview module re-exports `storeAnonMapping`
    // / `encryptMapping`, which bypass the route-level accreditation, self-block,
    // and rate-limit gates. Only the test file legitimately imports them, and
    // `npm run lint` lints `src/` only — so this rule never trips on tests. A
    // production importer would silently undermine the anonymous-review trust
    // model; this rule turns that into a build error.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/routes/anonymousReview', '**/routes/anonymousReview.js'],
              importNames: ['__test_seams'],
              message:
                'Do not import __test_seams from routes/anonymousReview in production code. It re-exports storeAnonMapping/encryptMapping, which bypass the route-level accreditation, self-block, and rate-limit gates. The seam is for tests/ only.',
            },
          ],
        },
      ],
    },
  },
);

// Exported so unit tests under tests/eslint/ can drive the rules with
// ESLint's RuleTester directly without re-deriving their shape.
export { noBridgePaperLiteralRule, noCustomIdBlockNumFloorRule };

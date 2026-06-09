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
// - pevo/no-accred-state-read-missing-id-tiebreaker (error): regex-based
//   discipline guard for the `(block_num, id)` deterministic-tiebreaker
//   convention on accreditation-state reads. Any static SQL literal that
//   filters on the accredit/revoke action AND orders a latest-wins read by
//   `block_num DESC` (an `ORDER BY ... LIMIT 1` single-row read, or a
//   ROW_NUMBER/OVER ranking) must carry the immediate `id DESC` secondary
//   key. The deployed HAF mirror views omit `trx_in_block`, so the monotonic
//   op id is the only intra-block key; a dropped tie-breaker resolves
//   same-block accredit/revoke pairs non-deterministically AND passes the
//   whole test suite (the live corpus is unlikely to hold a same-block pair
//   for a test account). See the rule definition below and the conventions:
//   agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md
//   agents/docs/solutions/conventions/accreditation-state-read-latest-action-wins-2026-05-15.md
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

// ─── pevo/no-accred-state-read-missing-id-tiebreaker ────────────────────────
//
// Accreditation-state reads ("latest accredit/revoke wins") MUST order by
// `block_num DESC` with the monotonic HAF op id as the IMMEDIATE secondary
// key (`cj.id DESC` / `id DESC` / `op_id DESC`). The deployed HAF mirror
// views omit `trx_in_block`, so the op id is the only intra-block key;
// without it, an accredit/revoke pair landing in the same 3s block resolves
// non-deterministically, and the whole test suite still passes because the
// live HAF corpus is unlikely to contain a same-block pair for a test
// account. This is the `(block_num, id)` deterministic-tiebreaker convention:
//   agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md (Rule 2)
//   agents/docs/solutions/conventions/accreditation-state-read-latest-action-wins-2026-05-15.md
//
// Detection fingerprint (regex/scanner over the flattened literal, SQL line
// comments stripped first):
//   gate:  the literal filters on the accreditation action values — an
//          `'action' = '...'` / `'action' IN (...)` predicate naming
//          'accredit' or 'revoke' on one line.
//   shape: a latest-wins ordering on `block_num DESC`, i.e. either
//            (a) an `ORDER BY ...` clause that runs into `LIMIT 1` at the
//                same paren depth (the single-row latest-state read), or
//            (b) the ordering inside an `OVER (...)` window (the
//                ROW_NUMBER `rn = 1` ranking).
//   check: every `block_num DESC` inside such a region must be immediately
//          followed by `, <alias.>id DESC` (or `op_id DESC`).
//
// Deliberately NOT flagged (out of family):
//   - window-feed delta reads (`block_num > $N` floors): their vote-arm
//     `ORDER BY ... block_num DESC` clauses sit inside DISTINCT ON
//     subqueries, so the forward scan exits at the subquery's closing paren
//     before any LIMIT, and the trailing pagination LIMIT binds a parameter,
//     not 1;
//   - aggregates with no ORDER BY (the genesis `MIN(block_num)` read);
//   - latest-wins reads on other action namespaces (`update_params`,
//     `update_weights`, `revote`) or keyed on non-action predicates
//     (idempotency-key probes): the gate requires the accredit/revoke action
//     filter in the same literal.
// Runtime-assembled SQL outside `flattenSqlString`'s folded forms is
// documented evasion handled by code review, same as the floor rule above.

// An action predicate naming the accreditation state values, on one line of
// SQL: `->> 'action' = 'accredit'`, `->> 'action' IN ('accredit', 'revoke')`,
// or a ranked-CTE alias form like `action IN ('revoke', 'accredit')`. The
// `[^)\u0000\n]*` run keeps the match on a single line, inside the current
// paren group, and short of any interpolation marker, so an unrelated
// 'accredit' string elsewhere in the literal cannot complete the predicate.
const ACCRED_STATE_FILTER_RE = /'action'\s*(?:=|IN)\s*\(?[^)\u0000\n]*'(?:accredit|revoke)'/i;

// Strip `--` SQL line comments so comment text (which may contain parens or
// the word accredit) cannot confuse the gate or the paren-depth scan. Stops
// at interpolation markers too, so a placeholder inside a comment stays
// visible as a region boundary.
function stripSqlLineComments(s) {
  return s.replace(/--[^\n\u0000]*/g, '');
}

// True when some `block_num DESC` in the region is NOT immediately followed
// by the `, id DESC` secondary key (aliased, bare, or the `op_id` projection
// name used by union CTEs).
function regionMissingIdTiebreaker(region) {
  for (const m of region.matchAll(/\b(?:\w+\.)?block_num\s+DESC\b/gi)) {
    const after = region.slice(m.index + m[0].length);
    if (!/^\s*,\s*(?:\w+\.)?(?:op_)?id\s+DESC\b/i.test(after)) return true;
  }
  return false;
}

// The balanced-paren body starting just after `openIdx` (the index of the
// opening paren). Returns null when the parens never balance (literal ends
// mid-window) — nothing to check in that case.
function balancedParenBody(s, openIdx) {
  let depth = 1;
  for (let i = openIdx + 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return s.slice(openIdx + 1, i);
    }
  }
  return null;
}

// Scan the flattened (comment-stripped) SQL for a latest-wins ordering on
// `block_num DESC` that lacks the `id DESC` tie-breaker. Two region shapes:
//
//   (b) window orderings: every `OVER ( ... )` body (balanced-paren extract;
//       covers the ROW_NUMBER rn=1 ranking).
//   (a) LIMIT-1 orderings: from each `ORDER BY`, walk forward tracking paren
//       depth. The region ends at the first of: a paren closing below the
//       clause's depth (the ORDER BY belongs to a subquery, e.g. a DISTINCT
//       ON dedup arm — not a latest-wins state read), a `;`, an interpolation
//       marker, a `UNION`, or a `LIMIT` at clause depth. Only a `LIMIT 1`
//       terminator classifies the clause as a latest-wins read; a parameter
//       or larger LIMIT is pagination and is skipped.
function hasLatestWinsTiebreakerViolation(flat) {
  for (const m of flat.matchAll(/\bOVER\s*\(/gi)) {
    const body = balancedParenBody(flat, m.index + m[0].length - 1);
    if (body !== null && regionMissingIdTiebreaker(body)) return true;
  }

  for (const m of flat.matchAll(/\bORDER\s+BY\b/gi)) {
    const start = m.index + m[0].length;
    const scanner = /[();\u0000]|\b(?:LIMIT|UNION)\b/gi;
    scanner.lastIndex = start;
    let depth = 0;
    let s;
    while ((s = scanner.exec(flat)) !== null) {
      const tok = s[0];
      if (tok === '(') { depth++; continue; }
      if (tok === ')') {
        depth--;
        if (depth < 0) break;
        continue;
      }
      if (tok === ';' || tok === '\u0000') break;
      if (tok.toUpperCase() === 'UNION') break;
      // LIMIT token. One nested below the clause (inside a paren group) is a
      // subquery's own limit, not this clause's terminator.
      if (depth !== 0) continue;
      if (!/^\s+1\b/.test(flat.slice(s.index + tok.length))) break;
      if (regionMissingIdTiebreaker(flat.slice(start, s.index))) return true;
      break;
    }
  }
  return false;
}

const noAccredStateReadMissingIdTiebreakerRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require the same-block `id DESC` tie-breaker on latest-wins accreditation-state reads. A SQL literal filtering on the accredit/revoke action whose latest-wins ordering (`ORDER BY ... block_num DESC` into `LIMIT 1`, or inside an OVER window) lacks the immediate `, id DESC` secondary key resolves same-block accredit/revoke pairs non-deterministically.',
    },
    schema: [],
    messages: {
      missingTiebreaker:
        'Accreditation-state read orders by `block_num DESC` without the same-block `id DESC` tie-breaker. The HAF mirror views omit `trx_in_block`, so the monotonic op id is the only intra-block key; write `ORDER BY ... block_num DESC, <alias>.id DESC` per the `(block_num, id)` deterministic-tiebreaker convention. See agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md (Rule 2) and agents/docs/solutions/conventions/accreditation-state-read-latest-action-wins-2026-05-15.md.',
    },
  },
  create(context) {
    // No file-level allowlist and no expected suppressions: every current
    // accreditation-state read carries the tie-breaker, so the rule stands
    // purely as a guard for new code (like the floor rule above).
    const reported = new WeakSet();

    function check(node) {
      if (reported.has(node)) return;
      const flatRaw = flattenSqlString(node);
      if (flatRaw === null) return;
      const flat = stripSqlLineComments(flatRaw);
      if (!ACCRED_STATE_FILTER_RE.test(flat)) return;
      if (!hasLatestWinsTiebreakerViolation(flat)) return;
      context.report({ node, messageId: 'missingTiebreaker' });
      markDescendants(node, reported);
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
    'no-custom-id-block-num-floor': noCustomIdBlockNumFloorRule,
    'no-accred-state-read-missing-id-tiebreaker': noAccredStateReadMissingIdTiebreakerRule,
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
      'pevo/no-accred-state-read-missing-id-tiebreaker': 'error',
    },
  },
  {
    // Production code (`src/`) must NOT import a route's test-only seam.
    // `__test_seams` exports exist purely so test files can drive otherwise
    // hard-to-reach states; importing one from `src/` would let production code
    // bypass a route's gates or arm a test-only failure injection. Only test
    // files legitimately import them, and `npm run lint` lints `src/` only — so
    // this rule never trips on tests. A production importer turns into a build
    // error here.
    //
    //   - routes/anonymousReview `__test_seams` re-exports storeAnonMapping /
    //     encryptMapping, which bypass the route-level accreditation,
    //     self-block, and rate-limit gates.
    //   - routes/signup-verify `__test_seams` arms a one-shot failure of the
    //     `/confirm` finalize UPDATE (createClaimedAccount-succeeds-then-fail
    //     crash-transition coverage). A production importer could inject signup
    //     activation failures.
    //   - reputation `__test_seams` repoints the batch-members index key so a
    //     deterministic empty-index backfill test can isolate it from the shared
    //     production members set. A production importer could silently divert the
    //     index off the real key.
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
            {
              group: ['**/routes/signup-verify', '**/routes/signup-verify.js'],
              importNames: ['__test_seams'],
              message:
                'Do not import __test_seams from routes/signup-verify in production code. It arms a one-shot failure of the /confirm finalize UPDATE for crash-transition coverage. The seam is for tests/ only.',
            },
            {
              group: ['**/reputation', '**/reputation.js'],
              importNames: ['__test_seams'],
              message:
                'Do not import __test_seams from reputation in production code. It repoints the batch-members index key for a deterministic backfill test. The seam is for tests/ only.',
            },
          ],
        },
      ],
    },
  },
);

// Exported so unit tests under tests/eslint/ can drive the rules with
// ESLint's RuleTester directly without re-deriving their shape.
export {
  noBridgePaperLiteralRule,
  noCustomIdBlockNumFloorRule,
  noAccredStateReadMissingIdTiebreakerRule,
};

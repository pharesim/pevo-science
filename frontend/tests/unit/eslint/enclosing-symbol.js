/**
 * Resolve the nearest enclosing named symbol for a line of frontend JS source.
 *
 * Support module for the source-discipline canaries in this directory. A
 * canary that scans for a forbidden (or required) shape and collects the set
 * of FILES that matched has a recurring blind spot: a file already on the
 * allowed list absorbs any number of additional occurrences silently. Naming
 * each occurrence by its enclosing symbol restores the granularity: the
 * assertion becomes a set of `file#symbol` pairs, so a new call site inside a
 * new handler is a new member even when its file was already there.
 *
 * The keys are necessary, not sufficient. A key inherits the file-level
 * absorption one level down whenever it covers more than the one licensed
 * occurrence: a symbol NAME that recurs as a declaration in its file (an
 * idiom local declared by more than one coalescer) collapses distinct
 * declarations onto one key, and a single wide declaration (a page template
 * literal) puts hundreds of lines under one key. {@link occurrencesOf}
 * therefore also reports each key's occurrence count, so a consumer can pin
 * licensed widths and catch an occurrence ADDED under a licensed key, not
 * just one minting a new key.
 *
 * Resolution is textual, not a parse. That is a deliberate trade, because a
 * canary that needs a compiler to run is a canary people delete, and it is
 * why {@link enclosingSymbol} is exercised by planted positives and negatives
 * in the canary that consumes it. The rule: scan upward for the nearest
 * declaration, and reject it if its block demonstrably closed before the
 * target line (a `}` at or left of the declaration's own indentation, or for
 * a template-literal declaration, a later line carrying a backtick).
 *
 * Beyond the backend's declaration shapes (function declarations and
 * function-valued const/let/var), this port recognizes two shapes the
 * frontend is written in and the backend is not:
 *
 *  - OBJECT-METHOD SHORTHAND (`async loadEmailStatus() {`). Alpine components
 *    are object literals of shorthand methods, so without this shape nearly
 *    every occurrence in a page module would land at module scope and the
 *    whole component would collapse into one absorbing key.
 *  - TEMPLATE-LITERAL DECLARATIONS (`const template = ` + backtick). Page
 *    markup lives in one large template literal per page module. Resolving
 *    its interior to the declaring const keeps the markup from landing at
 *    module scope, where a licensed rendering read would absorb every future
 *    module-scope occurrence in the same file. The literal's block ends at
 *    the next line carrying a backtick, so occurrences after it do not leak
 *    into the template's key.
 *
 * Known limitations, and where they are safe. A declaration whose block opens
 * and closes on its own line has no closing brace on a later line, so a match
 * below it can resolve to that declaration instead of the real enclosing
 * scope. A method shorthand whose parameter list wraps onto the next line is
 * not recognized and resolves further up. A shape the patterns do not
 * recognize at all resolves to {@link MODULE_SCOPE}. The consequence in every
 * case is a WRONG symbol, and how that fails depends on the assertion
 * consuming it:
 *
 *  - SET-EQUALITY assertions (occurrence keys, or keys with their per-key
 *    counts, compared to an exact allowed set or map) fail closed: a wrong
 *    symbol is a new member and therefore a red bar, never a silent pass.
 *    Every canary currently built on this module asserts that shape. The
 *    claim is scoped to it on purpose.
 *
 *  - PAIRING assertions (every occurrence of X needs a Y under the same key)
 *    do NOT inherit the property: two unrelated occurrences that both resolve
 *    to module scope satisfy each other, which is file-granularity blindness
 *    wearing a symbol-shaped key. A future pairing scan must exclude
 *    {@link MODULE_SCOPE} keys from its satisfying set (via
 *    {@link isModuleScopeKey}) and treat a module-scope demand-side key as an
 *    offender in its own right, re-deriving the fail-closed argument rather
 *    than inheriting it from this docblock.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Label used when a match sits at module scope with no enclosing declaration. */
export const MODULE_SCOPE = '<module>';

/** Whether a `file#symbol` occurrence key resolved to module scope. Pairing
 *  scans must drop such keys from their satisfying sets; see the file
 *  docblock. */
export function isModuleScopeKey(key) {
  return key.endsWith(`#${MODULE_SCOPE}`);
}

/** What a declaration line looks like, in the shapes this codebase writes.
 *
 *  The variable-assignment pattern carries a guard, because `= (` alone also
 *  matches a parenthesized EXPRESSION, and reading that as a function
 *  declaration hands every following line in the real enclosing function a
 *  wrong symbol. A `(`-initialized declaration counts as a function only when
 *  the line shows an arrow or a `function` keyword, or leaves more parens
 *  open than closed (a parameter list wrapping onto the next line).
 *
 *  The method-shorthand pattern requires a BALANCED empty-or-simple parameter
 *  list followed by an opening brace at end of line, so a call passing an
 *  object literal (`foo({`) and a callback registration (`it('x', () => {`)
 *  do not read as declarations, and control-flow keywords are excluded by
 *  name so `if (...) {` never becomes a symbol. */
const DECLARATION_PATTERNS = [
  // `export async function initSettingsPage(` / `function pickRandomIndices(`
  {
    re: /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)\s*\(/,
    label: (m) => m[1],
  },
  // `const handler = async (req) => {` / `const flight = (async () => {`
  {
    re: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\(|function\b)/,
    label: (m) => m[1],
    guard: (line) => {
      if (/\bfunction\b|=>/.test(line)) return true;
      const opens = (line.match(/\(/g) ?? []).length;
      const closes = (line.match(/\)/g) ?? []).length;
      return opens > closes;
    },
  },
  // `const template = ` opening a template literal that the line leaves open.
  {
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*`[^`]*$/,
    label: (m) => m[1],
    template: true,
  },
  // `async loadEmailStatus() {` / `_freshAuthCtx() {` inside a component object.
  {
    re: /^\s*(?:async\s+)?(?!(?:if|for|while|switch|catch|function|return)\b)([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{\s*$/,
    label: (m) => m[1],
  },
];

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function declarationOn(line) {
  for (const { re, label, guard, template } of DECLARATION_PATTERNS) {
    const m = line.match(re);
    if (m && (guard === undefined || guard(line))) {
      return { name: label(m), template: template === true };
    }
  }
  return null;
}

/**
 * The nearest declaration whose block still contains `lineIndex`, or
 * {@link MODULE_SCOPE}. `lines` is the file split on newlines; `lineIndex` is
 * 0-based.
 */
export function enclosingSymbol(lines, lineIndex) {
  for (let i = lineIndex; i >= 0; i--) {
    const decl = declarationOn(lines[i]);
    if (decl === null) continue;

    if (decl.template) {
      // A template literal's block ends at the next backtick, not at a brace:
      // its interior is markup, where braces are content. If any line between
      // the opener and the target carries a backtick, the literal closed
      // before the target line and this declaration is a preceding sibling.
      let closedBefore = false;
      for (let j = i + 1; j < lineIndex; j++) {
        if (lines[j].includes('`')) {
          closedBefore = true;
          break;
        }
      }
      if (closedBefore) continue;
      return decl.name;
    }

    const declIndent = indentOf(lines[i]);
    // A closing BRACE at or left of the declaration's own indentation means
    // the declaration's block ended before the target line, so this is a
    // preceding sibling rather than an enclosing scope. Keep walking up.
    //
    // Only `}` counts, never `)` or `]`: a multi-line signature closes its
    // parameter list with `) {` at the declaration's own indentation, and
    // reading that as a block end would make every function with wrapped
    // parameters resolve to module scope. Comment lines are skipped for the
    // same class of reason: a `}` inside a docblock is prose.
    let closedBefore = false;
    for (let j = i + 1; j <= lineIndex; j++) {
      const line = lines[j];
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
      if (trimmed.startsWith('}') && indentOf(line) <= declIndent) {
        closedBefore = true;
        break;
      }
    }
    if (closedBefore) continue;
    return decl.name;
  }
  return MODULE_SCOPE;
}

/**
 * Every `.js` file under `root`, recursively, labelled relative to `root`
 * with forward slashes so an assertion reads `pages/settings.js` on every
 * platform.
 *
 * Recursive on purpose: a scan over the top of one directory silently visits
 * none of its subdirectories, and everything it fails to visit passes
 * vacuously. Each consuming canary must also assert a floor on the number of
 * files returned, so a broken walk fails loudly instead.
 */
export function sourcesUnder(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push({
          rel: path.relative(root, full).split(path.sep).join('/'),
          lines: readFileSync(full, 'utf8').split('\n'),
        });
      }
    }
  };
  walk(root);
  return out;
}

/** A line that is entirely comment BY SHAPE: a `//` line, a block opener, or
 *  the `*` continuation inside a docblock.
 *
 *  On a scan for a FORBIDDEN shape the match IS the violation, so every line
 *  skipped is a violation not reported: filter as little as possible, and
 *  this shape-only test is that minimum. A line commented out by a block
 *  toggle that prefixed only the first line is NOT recognized and still
 *  counts, which for a forbidden scan is the loud direction (a red bar
 *  telling the author to delete dead code) rather than the silent one. A
 *  future REQUIRED-shape or pairing scan must not reuse this predicate as its
 *  satisfying-side filter, because there an over-match out of a comment
 *  silently satisfies a demand; such a scan needs a commented-out walk of its
 *  own, re-derived, not inherited. */
export function isCommentLine(line) {
  return /^\s*(?:\*|\/\/|\/\*)/.test(line);
}

/**
 * Every `file#symbol` occurrence of `pattern` across `files`: the sorted
 * distinct `keys`, a `counts` object mapping each key to its number of
 * matching lines, and a human-readable site list for assertion messages.
 *
 * The counts exist because a key alone can absorb (see the file docblock):
 * an occurrence added inside a colliding declaration name or a wide template
 * literal resolves to a key its consumer already licensed, so key
 * set-equality stays green while the addition lives. A consumer that pins
 * each licensed key's exact width instead turns that addition into a
 * mismatch. The residual a width pin cannot see is a constant-width
 * REPLACEMENT, an offending rewrite of the licensed lines themselves; that
 * edit touches licensed lines directly and is left to review of the diff.
 *
 * `skipLine` drops a matched line before it is counted, for a definition site
 * that necessarily matches the pattern it defines, say. It receives the
 * line's index and the whole file, so a predicate can also decide from
 * surrounding lines (an import specifier whose alias sits on the next line
 * needs that).
 */
export function occurrencesOf(files, pattern, skipLine) {
  const tally = new Map();
  const sites = [];
  for (const { rel, lines } of files) {
    lines.forEach((line, i) => {
      if (!pattern.test(line)) return;
      if (skipLine?.(line, i, lines)) return;
      const symbol = enclosingSymbol(lines, i);
      const key = `${rel}#${symbol}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
      sites.push(`${rel}:${i + 1} (${symbol}) ${line.trim()}`);
    });
  }
  const keys = [...tally.keys()].sort();
  return { keys, counts: Object.fromEntries(keys.map((k) => [k, tally.get(k)])), sites };
}

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

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
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
    re: /^\s*(?:async\s+)?(?!(?:if|for|while|switch|catch|function|return)\b)([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{\s*$/,
    label: (m) => m[1],
  },
];

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/** Whether a block comment opened at `openIndex` closes on or before
 *  `lineIndex`. The brace walk enters a comment region only when this holds,
 *  so an opener it cannot see close falls through to the ordinary brace test
 *  instead of swallowing the rest of the declaration. */
function blockCommentClosesBy(lines, openIndex, lineIndex) {
  for (let k = openIndex + 1; k <= lineIndex; k++) {
    if (lines[k].includes('*/')) return true;
  }
  return false;
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
    // parameters resolve to module scope. A brace inside a comment is prose
    // and does not count either: a commented-out block left at the
    // declaration's own indentation would otherwise close it early. A `//`
    // line or a `*` continuation begins with its own marker and can never
    // begin with `}`, so the only comment shape that needs handling is the
    // interior of a block comment opened at line start, tracked as a
    // running open/closed state.
    //
    // The state is entered only for a region the walk can SEE close. An
    // unterminated opener at line start is markup more often than it is a
    // comment, because this tree writes a page of markup per module inside a
    // template literal, and a phantom region opened there never closes and
    // swallows the brace that ends the declaration. Resolving wider that way
    // is not a safe direction: the wrong symbol can be one the consumer has
    // already licensed, where a pinned width absorbs the addition, rather
    // than a new member that fails closed.
    //
    // Leaving the region, the code after the first close on that line is
    // live and gets the same brace test as any other line, at the line's own
    // indentation. A line carrying more than one comment boundary is read to
    // its first close only, which resolves wider and is the fail-closed
    // direction.
    let closedBefore = false;
    let inBlockComment = false;
    for (let j = i + 1; j <= lineIndex; j++) {
      const line = lines[j];
      let code = line;
      if (inBlockComment) {
        const close = line.indexOf('*/');
        if (close === -1) continue;
        inBlockComment = false;
        code = line.slice(close + 2);
      }
      const trimmed = code.trim();
      if (
        trimmed.startsWith('/*') &&
        trimmed.indexOf('*/', 2) === -1 &&
        blockCommentClosesBy(lines, j, lineIndex)
      ) {
        inBlockComment = true;
        continue;
      }
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
 * Every `.js` file under `root`, recursively, as `sources` labelled relative
 * to `root` with forward slashes so an assertion reads `pages/settings.js`
 * on every platform, plus `foreign`: the relative path of every OTHER file
 * the walk passed over, sorted.
 *
 * Recursive on purpose: a scan over the top of one directory silently visits
 * none of its subdirectories, and everything it fails to visit passes
 * vacuously. Each consuming canary must also assert a floor on the number of
 * files returned, so a broken walk fails loudly instead.
 *
 * `foreign` exists because the walk reads `.js` only while the bundler
 * resolves several other script extensions with no configuration. A module
 * authored in one of them would join the bundle with no scan having seen it,
 * and its `.js` importer need not write any name the scans look for. A
 * consuming canary therefore pins what the walk may pass over (a stylesheet,
 * by extension) and fails on anything else.
 */
export function sourcesUnder(root) {
  const sources = [];
  const foreign = [];
  // Links are followed, because the bundler follows them: a linked module or
  // directory joins the bundle and is therefore part of the scan. A link's
  // own dirent reports neither file nor directory, so routing on it alone
  // drops the entry from BOTH returned lists and the walk neither reads it
  // nor admits it passed over it. `statSync` resolves the link and the entry
  // is routed by what it points AT instead. A link back to a directory still
  // being walked (an ancestor, by real path) is not entered, so a cycle
  // cannot recurse forever, while a link to a sibling directory is walked
  // under both names, as the bundler resolves it under both.
  //
  // A link pointing nowhere is censused rather than dropped. It is still
  // script-shaped by name, and a consumer's extension gate over `foreign` is
  // what turns an unreadable `.js` into a red bar. That is the one deliberate
  // divergence from the backend port, whose contract returns sources only and
  // so has nowhere to report it.
  const ancestors = new Set();
  const walk = (dir) => {
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (ancestors.has(real)) return;
    ancestors.add(real);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      let target = null;
      try {
        target = statSync(full);
      } catch {
        target = null;
      }
      if (target?.isDirectory()) {
        walk(full);
      } else if (target?.isFile() && entry.name.endsWith('.js')) {
        sources.push({ rel, lines: readFileSync(full, 'utf8').split('\n') });
      } else {
        foreign.push(rel);
      }
    }
    ancestors.delete(real);
  };
  walk(root);
  return { sources, foreign: foreign.sort() };
}

/** A line that is entirely comment BY SHAPE: a `//` line, the `*`
 *  continuation inside a docblock, or a block comment opened at line start
 *  that runs to the end of the line (or past it). A block comment that
 *  closes on its own line with code after it is live code behind a comment
 *  prefix, not prose, and is NOT skipped: a coverage pragma in front of a
 *  factor read must not hide the read. Only further comment may follow the
 *  close for the line to stay prose.
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
  const trimmed = line.trim();
  if (trimmed.startsWith('//')) return true;
  // Both block-comment arms close before they are believed. A comment CLOSE
  // begins with the same star a docblock continuation does, so an arm that
  // answers on that star alone claims a line whose comment has already ended
  // and skips the live code behind it. An opener is searched past its own
  // two characters, so an opener that begins with a star is not read as
  // self-closing; a continuation is searched from the start, which is where
  // its own close sits.
  const opensBlock = trimmed.startsWith('/*');
  if (!opensBlock && !trimmed.startsWith('*')) return false;
  const close = trimmed.indexOf('*/', opensBlock ? 2 : 0);
  if (close === -1) return true;
  const rest = trimmed.slice(close + 2).trim();
  return rest === '' || isCommentLine(rest);
}

/**
 * Every `file#symbol` occurrence of `pattern` across `files`: the sorted
 * distinct `keys`, a `counts` object mapping each key to its number of
 * matches, and a human-readable site list for assertion messages (a line
 * carrying more than one match is marked with its multiplicity).
 *
 * The counts exist because a key alone can absorb (see the file docblock):
 * an occurrence added inside a colliding declaration name or a wide template
 * literal resolves to a key its consumer already licensed, so key
 * set-equality stays green while the addition lives. A consumer that pins
 * each licensed key's exact width instead turns that addition into a
 * mismatch. Matches are counted per MATCH rather than per line for the same
 * reason one level further down: a second read placed beside a licensed one
 * on the same line adds no line, and a per-line tally would leave the pin
 * satisfied. The residual a width pin cannot see is a constant-width
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
  // A global copy of the pattern makes `String#match` return every hit on
  // the line at once; it resets its own cursor per call, so the copy holds
  // no state across lines.
  const everyMatch = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  const tally = new Map();
  const sites = [];
  for (const { rel, lines } of files) {
    lines.forEach((line, i) => {
      const matches = line.match(everyMatch)?.length ?? 0;
      if (matches === 0) return;
      if (skipLine?.(line, i, lines)) return;
      const symbol = enclosingSymbol(lines, i);
      const key = `${rel}#${symbol}`;
      tally.set(key, (tally.get(key) ?? 0) + matches);
      const multiplicity = matches > 1 ? ` x${matches}` : '';
      sites.push(`${rel}:${i + 1} (${symbol})${multiplicity} ${line.trim()}`);
    });
  }
  const keys = [...tally.keys()].sort();
  return { keys, counts: Object.fromEntries(keys.map((k) => [k, tally.get(k)])), sites };
}

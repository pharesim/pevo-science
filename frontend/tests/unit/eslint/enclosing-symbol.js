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
 * recognize at all resolves to {@link MODULE_SCOPE}.
 *
 * Two comment boundaries are deliberately left open, both because closing
 * them needs a mid-line opener test, and telling a real opener from the same
 * two characters inside a string literal, a regex, or a CSS rule in template
 * markup is a lexer's job. A lexer is the dependency this module exists to
 * avoid, so both are named here instead:
 *
 *  - A block comment OPENED mid-line is not tracked, so a brace inside it
 *    reads as live and can close the declaration early. This one resolves
 *    OUTWARD, toward an enclosing function or module scope. Module scope is
 *    never a licensed key in the canaries built on this module, so the wrong
 *    answer is a new member and the consuming set-equality assertion still
 *    fails closed.
 *  - A line carrying more than one comment boundary is read only to its
 *    first close, so a brace sitting after a LATER boundary on that same
 *    line is missed and the declaration reads as still open. This one
 *    resolves INWARD, which is the direction a licensed key can absorb, and
 *    is therefore the weaker of the two. What keeps it small is that the
 *    shape has to put a whole comment and a block-closing brace on one
 *    physical line, which is conspicuous enough on its own that no
 *    reviewer reads past it.
 *
 * The ordinary single-boundary form of that second shape, a close sharing
 * its line with the real closing brace, IS handled: the walk reads the code
 * after the close.
 *
 * The consequence in every case is a WRONG symbol, and how that fails depends
 * on the assertion consuming it:
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

/** How many times `re` matches in `line`. `re` must carry the global flag. */
function countOf(line, re) {
  return (line.match(re) ?? []).length;
}

/** Whether a TRIMMED line opens a block comment it does not close on itself.
 *  One definition, because both readers of it (the brace walk and the region
 *  pass) drew the same distinction and drifted apart when only one of them
 *  was hardened. */
function opensUnterminatedBlock(trimmed) {
  return trimmed.startsWith('/*') && trimmed.indexOf('*/', 2) === -1;
}

/** Whether ANY comment close appears between `openIndex` and `lineIndex`.
 *
 *  Deliberately NOT named "does this opener close". Comments do not nest, so
 *  the first close below a REAL opener is that opener's own, but a close
 *  belonging to some later comment satisfies this test too, and every real
 *  module carries a docblock somewhere below any given line. It is therefore
 *  a weak guard on its own: it rules out a file with no block comment at all
 *  after the opener, and nothing more. What refuses the shape that actually
 *  occurs, an opener that is markup inside a template literal, is the
 *  template test beside it in the walk. */
function aCommentCloseFollows(lines, openIndex, lineIndex) {
  for (let k = openIndex + 1; k <= lineIndex; k++) {
    if (lines[k].includes('*/')) return true;
  }
  return false;
}

/** For each line, whether a block comment opened on an EARLIER line is still
 *  open when this line begins.
 *
 *  A leading `*` is a docblock continuation and a wrapped multiplication, and
 *  the two are textually identical. {@link isCommentLine} cannot tell them
 *  apart from one line, and treating every such line as prose skips live
 *  code: a forbidden-shape scan then misses the violation it exists to
 *  report. The context is what decides, so it is computed once per file here
 *  and handed to the skip predicate. Openers are recognized at line start
 *  only, which is the same boundary the rest of this module draws.
 *
 *  This asks the question {@link enclosingSymbol}'s brace walk asks, so it
 *  carries the walk's two guards for the same reasons: an opener inside a
 *  template literal is markup, and an opener nothing ever closes is not a
 *  region. Without them a stray opener in a page module's markup puts the
 *  lines below it inside a phantom region, and the skip predicate then reads
 *  each star-leading line there as a docblock continuation, so a scan
 *  consuming this stops seeing that shape of live code (a wrapped
 *  multiplication carrying the read). The window runs to the next line
 *  carrying a close, which in a real module is the next docblock rather
 *  than the end of the file. On a forbidden-shape scan that is a silent
 *  miss, which is the direction that must never be wrong. A star-leading
 *  line is the whole silent surface: every other line consults its own
 *  shape, so a phantom region cannot hide them. Leaving a region, the code after the close is read
 *  the same way the walk reads it: a line that closes one region and opens
 *  another (a close, a space, then a second opener) re-enters, so a
 *  continuation below it is still prose to the predicate.
 *
 *  TEMPLATE PARITY IS A WHOLE-FILE BACKTICK COUNT, and two things invert it.
 *  A backtick that is not a delimiter still counts: inside a regex literal,
 *  a string literal, comment text, or escaped in a template's own text. Each
 *  one flips the count for every line after it, and this tree writes several
 *  (a regex character class with a backtick in it; a two-line comment or
 *  string quoting an identifier). And a nested multi-line template
 *  (`${items.map((i) => ` + backtick on one line, its close on a later one)
 *  contributes one backtick per line, so the nested markup reads as OUTSIDE
 *  any template.
 *
 *  Each inversion has a direction. Where a real docblock opener falls in an
 *  inverted window it is refused and its star lines count as live, which is
 *  loud (a false red bar, not a miss); where a template with a line-start
 *  opener in its markup falls in one, the opener is accepted and the
 *  star-leading reads below it are skipped, which is silent. Only the loud
 *  direction is reachable in this tree today: the inverted windows the
 *  non-delimiter backticks open carry no line-start opener, so nothing is
 *  refused and no scan is affected, and no module nests a multi-line
 *  template, which is the inversion that flips parity INSIDE markup and so
 *  points the silent way wherever it occurs. Neither is closed here:
 *  counting only code-shaped backticks, or tracking `${` depth, is the lexer
 *  this module declines. Both are pinned as residuals in the resolver's own
 *  suite. */
export function blockCommentInterior(lines) {
  const interior = new Array(lines.length).fill(false);
  const last = lines.length - 1;
  let open = false;
  let ticks = 0;
  for (let i = 0; i < lines.length; i++) {
    interior[i] = open;
    let trimmed = lines[i].trim();
    const inTemplate = ticks % 2 === 1;
    ticks += countOf(lines[i], /`/g);
    if (open) {
      const close = trimmed.indexOf('*/');
      if (close === -1) continue;
      open = false;
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (opensUnterminatedBlock(trimmed) && !inTemplate && aCommentCloseFollows(lines, i, last)) {
      open = true;
    }
  }
  return interior;
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
    // indentation, and the same opener test: `*/ /* second` re-enters. Only
    // the FIRST close on a line is read; the file docblock's comment-boundary
    // paragraph names what that leaves open.
    //
    // "Can SEE close" is bounded by the target line, inclusive, not by the
    // end of the file (the region pass, which has no target, reads to the
    // end). A close below the target cannot vouch for an opener above it:
    // taking it would swallow a brace on evidence the walk has not reached
    // and resolve INWARD, and inward is the direction a licensed key can
    // absorb. Declining resolves outward, which fails closed.
    //
    // Template parity is seeded from the declaration line's own backticks,
    // because a one-line declaration can open a literal (`= (s) => { const m
    // = ` + backtick) that the next line is already inside. It is a plain
    // count of backticks per line from there, and the region pass counts
    // the same way over the whole file, so both invert on the same two
    // shapes: a non-delimiter backtick between the declaration and the
    // target (inside a regex literal, a string literal, comment text, or
    // escaped in template text) flips every later line's parity, and a
    // nested multi-line template contributes one backtick per line so its
    // markup reads as outside any literal. Inverted parity lets
    // a line-start opener in markup pass the template guard, which is this
    // walk's inward, silent direction. Inverted the other way it refuses a
    // real opener, so a commented-out brace at the declaration's own
    // indentation ends the block early and the target resolves outward,
    // which fails closed. Not closed here (counting only
    // code-shaped backticks is the lexer this module declines); both shapes
    // are pinned as residuals in the resolver's own suite.
    let closedBefore = false;
    let inBlockComment = false;
    let ticks = countOf(lines[i], /`/g);
    for (let j = i + 1; j <= lineIndex; j++) {
      const line = lines[j];
      const inTemplate = ticks % 2 === 1;
      ticks += countOf(line, /`/g);
      let code = line;
      if (inBlockComment) {
        const close = line.indexOf('*/');
        if (close === -1) continue;
        inBlockComment = false;
        code = line.slice(close + 2);
      }
      const trimmed = code.trim();
      if (
        opensUnterminatedBlock(trimmed) &&
        !inTemplate &&
        aCommentCloseFollows(lines, j, lineIndex)
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
 * by extension) and fails on anything else. Links are followed and routed by
 * what they point at, and one pointing nowhere is reported in `foreign`
 * rather than dropped, so between the two lists every FILE the walk saw is
 * accounted for. The one entry appearing in neither list is a directory link
 * back to an ancestor, which the cycle guard declines to re-enter; no module
 * hides there, because the real directory it names is walked under its own
 * non-cyclic path. Nothing else leaves both lists: an entry the walk cannot
 * stat is censused rather than dropped, and the three calls with no guard of
 * their own (the link resolution, the directory listing, the file read)
 * throw rather than skipping in silence.
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
    // Not guarded: every directory reaching here was just stat-ed by its
    // parent (or is the root the consumer named), so a failure to resolve
    // it is a directory vanishing mid-walk, and a throw there is loud.
    const real = realpathSync(dir);
    if (ancestors.has(real)) return;
    ancestors.add(real);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      let target;
      try {
        target = statSync(full);
      } catch {
        // Nothing to stat: a link pointing nowhere, an entry gone between the
        // listing and this call, or one under a directory the walk may list
        // but not search. Routed to `foreign`, where a consumer's extension
        // gate can see it. An entry the stat CAN see but the walk cannot
        // open is not caught here: the `readFileSync` call throws and the
        // consuming suite fails at load, which is the loud direction.
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

/** A line that is entirely comment: a `//` line, a block comment opened at
 *  line start that runs to the end of the line (or past it), or the `*`
 *  continuation inside a docblock. A block comment that closes on its own
 *  line with code after it is live code behind a comment prefix, not prose,
 *  and is NOT skipped: a coverage pragma in front of a factor read must not
 *  hide the read. Only further comment may follow the close for the line to
 *  stay prose. The rule is written for all three prefixes: inside an open
 *  region a `//` is comment text like any other, so a line that begins with
 *  one and then closes the region is live behind its close too. Where the
 *  region pass is right, two shapes defeat it, both named as residuals here;
 *  where it under-reports, each arm falls back to its shape reading, silently
 *  for a `//` line that carries a close, loudly for a star line that does
 *  not.
 *
 *  Shape alone decides every case but two, and a third it decides on shape
 *  and gets wrong, which is the TEMPLATE PARITY residual. A leading `*` (a
 *  close-leading line aside, which ends a comment whatever the region says
 *  and is answered by what follows its close) is a docblock continuation and
 *  a wrapped multiplication and a generator method, all three identical to
 *  this predicate, so that case takes `insideRegion` from
 *  {@link blockCommentInterior}, in two sub-cases. At a region KNOWN closed
 *  the line is live whatever follows it, a trailing comment included:
 *  nothing is open for it to continue, so the close search is not consulted
 *  at all. Where the region pass under-reports, an opener it refused or one
 *  it never saw (the pass reads an opener at the start of a line, or of what
 *  survives a close on it, and nowhere else), that reads the comment's star
 *  lines as live, which is the loud direction those already fail in. With
 *  a region open, or none known, a close on the line is what answers (code
 *  behind it is live; nothing, or further comment, is prose), and a line
 *  with no close is prose. And a leading `//` is prose on
 *  its shape outside a region, but inside one it is inspected for a close
 *  like the other two prefixes, because the region is what decides what the
 *  two slashes are. Passing nothing leaves the shape-only reading of both,
 *  which suits a caller with no file in hand; a SCAN must pass the region,
 *  because reading live code as prose there is the violation going
 *  unreported.
 *
 *  Neither residual is closed here, and not for the same reason, so each
 *  carries its own:
 *
 *   - TEMPLATE PARITY never reaches this predicate. Both opener readers guard
 *     their opener test with a template check, {@link blockCommentInterior}
 *     and the brace walk in {@link enclosingSymbol} each refusing an opener
 *     they believe sits inside a literal, and there is no such signal here.
 *     `insideRegion` cannot stand in for one: inside a template literal no
 *     block region is open, so false is the honest answer to the question
 *     that argument asks, and the reading it licenses is the wrong one. Two
 *     of the three prefixes are markup inside a literal rather than comment,
 *     the two slashes of a `//` line and the opener of a CSS rule's comment,
 *     so each is answered without one and an interpolation the markup appears
 *     to comment out is dropped although it evaluates. This one fails
 *     SILENT, and further than either boundary the file docblock leaves
 *     open: those resolve to a WRONG symbol, which is at least a member the
 *     consuming set-equality can see, while here the whole line is dropped
 *     before {@link enclosingSymbol} runs, so no key is minted and there is
 *     no member to weigh. That is the dangerous direction. Closing
 *     it needs a new axis rather than a better region pass, and threading
 *     template parity through this predicate widens the surface every
 *     consumer shares and asks for the lexer the file docblock declines, so
 *     it is a separate decision.
 *   - THE CLOSE SEARCH for a block-comment prefix begins past the opener's
 *     own two characters. A line whose first three are that opener and a
 *     slash carries a close beginning at its second character, one position
 *     short of where the search starts, so inside an open region the line
 *     reads as an opener rather than as the close it carries, and the live
 *     code behind it is dropped the same silent way. The offset is right
 *     outside a region, where such a line really is an opener, and the shape
 *     stays dismissed as contrived.
 *
 *  What licenses the TEMPLATE PARITY residual's silence is pinned, not
 *  incidental: the two `legacy note` line-comment pins in the resolver's own
 *  suite fix the shape answer for a `//` line carrying a close and a live
 *  password-state read, at a region known closed and at a region unknown,
 *  with no literal in the question. A closing edit that adds a template
 *  signal leaves both passing: they become the outside-a-literal controls it
 *  keeps beside its in-literal sibling.
 *
 *  On a scan for a FORBIDDEN shape the match IS the violation, so every line
 *  skipped is a violation not reported: filter as little as possible. A line
 *  commented out by a block
 *  toggle that prefixed only the first line is NOT recognized and still
 *  counts, which for a forbidden scan is the loud direction (a red bar
 *  telling the author to delete dead code) rather than the silent one. A
 *  future REQUIRED-shape or pairing scan must not reuse this predicate as its
 *  satisfying-side filter, because there an over-match out of a comment
 *  silently satisfies a demand; such a scan needs a commented-out walk of its
 *  own, re-derived, not inherited. */
export function isCommentLine(line, insideRegion) {
  const trimmed = line.trim();
  // An arm that can sit inside a region closes before it is believed. A
  // comment CLOSE begins with the same star a docblock continuation does,
  // and inside an open region a `//` is comment text that can end the
  // region on that same line, so an arm answering on its prefix alone would
  // claim a line whose comment has already ended and skip the live code
  // behind it. Two readings ARE on the prefix alone, in opposite directions:
  // a `//` line outside a region, or with none known, is prose; and a `*`
  // line that is not itself a close, at a region KNOWN closed, is live,
  // because nothing is open for it to continue and whatever follows it, a
  // trailing comment included, cannot make it one. The close search is
  // consulted for the rest, the close-leading line included, which is why
  // the reading above excludes it. An opener is searched past its own two
  // characters, so an opener that begins with a star is not read as
  // self-closing; a `//` inside a region, a `*` with a region open or none
  // known, and a close-leading line whatever the region, are searched from
  // the start, which is where a continuation's own close sits.
  const opensBlock = trimmed.startsWith('/*');
  const lineComment = trimmed.startsWith('//');
  if (lineComment && insideRegion !== true) return true;
  if (!opensBlock && !lineComment && !trimmed.startsWith('*')) return false;
  // A close-leading line is the one star shape the known-closed reading
  // leaves to the search: it ends a comment whatever the region pass
  // believes (the pass under-reports where an opener was refused, or sat
  // mid-line and was never seen), so it is answered by what follows its
  // close like every other close.
  if (insideRegion === false && trimmed.startsWith('*') && !trimmed.startsWith('*/')) return false;
  const close = trimmed.indexOf('*/', opensBlock ? 2 : 0);
  if (close === -1) {
    // Nothing closes on this line, and every prefix reaching here is prose
    // on that evidence: an opener with nothing after it, a `//` inside a
    // region, and a leading star with a region open or none known. The star
    // is the one that needed the region. `* Number(cached?.hasPassword ===
    // false)` is a wrapped multiplication and `*factorHints() {` is a
    // generator method, both shape-identical to a docblock continuation, and
    // only a region KNOWN closed says live, which is answered before the
    // search. `undefined` keeps the older shape-only reading for callers
    // with no file context.
    return true;
  }
  const rest = trimmed.slice(close + 2).trim();
  // Anything after a close is outside the region by construction.
  return rest === '' || isCommentLine(rest, false);
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
 * satisfied. That per-match tally covers same-line addition only on lines
 * `skipLine` does not drop: the skip runs first and removes the whole line,
 * so a match riding on a skipped line is invisible to the count. Making the
 * skip per-match would widen shared machinery for a shape no consumer needs
 * and that is conspicuous on its own line, so the case is named here
 * instead. The other
 * residual a width pin cannot see is a constant-width REPLACEMENT, an
 * offending rewrite of the licensed lines themselves; that edit touches
 * licensed lines directly and is left to review of the diff.
 *
 * `skipLine` drops a matched line before it is counted, for a definition site
 * that necessarily matches the pattern it defines, say. It receives the
 * line's index and the whole file, so a predicate can also decide from
 * surrounding lines (an import specifier whose alias sits on the next line
 * needs that), and a fourth argument saying whether the line sits inside an
 * open block comment, computed once per file by {@link blockCommentInterior}
 * because a leading star cannot be read from one line alone.
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
    const interior = blockCommentInterior(lines);
    lines.forEach((line, i) => {
      const matches = line.match(everyMatch)?.length ?? 0;
      if (matches === 0) return;
      if (skipLine?.(line, i, lines, interior[i])) return;
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

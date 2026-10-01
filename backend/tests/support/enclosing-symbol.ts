/**
 * Resolve the nearest enclosing named symbol for a line of TypeScript source.
 *
 * Source-discipline canaries that scan for a forbidden (or required) call shape
 * have a recurring blind spot: they collect the set of FILES that matched and
 * compare it to an expected file list. A file that is already on the allowed
 * list absorbs any number of additional occurrences silently, so the canary
 * stays green for exactly the violation it was written to catch — a second mint
 * added to a file that legitimately mints once, a second column writer added to
 * a route file that already sweeps.
 *
 * Naming each occurrence by its enclosing symbol restores the granularity: the
 * assertion becomes a set of `file#symbol` pairs, so a new call site inside a
 * new handler is a new member of the set even when its file was already there.
 *
 * Resolution is textual, not a parse. That is a deliberate trade — a canary
 * that needs the TypeScript compiler to run is a canary people delete — and it
 * is why {@link enclosingSymbol} is exercised by planted positives and
 * negatives in the canaries that consume it. The rule is: scan upward for the
 * nearest declaration, and reject it if its block demonstrably closed before
 * the target line (a `}` at or left of the declaration's own indentation, or
 * one leading the code after a comment close; WHICH BRACE THE WALK SEES states
 * the whole rule).
 *
 * Known limitations, and where they are safe. A declaration whose block opens
 * and closes on its own line (`const noop = () => {};`) has no closing brace
 * on a LATER line, so a match below it can resolve to that declaration instead
 * of the real enclosing scope (one of the INWARD shapes listed under WHICH
 * BRACE THE WALK SEES); a declaration shape the patterns do not recognize at
 * all (an object-method shorthand, a class member) resolves to
 * {@link MODULE_SCOPE}.
 *
 * WHICH BRACE THE WALK SEES. Every wrong answer this docblock names follows
 * from one rule, so it is stated once. Walking down from a declaration to the target line,
 * the walk takes a `}` as the end of that declaration's block when the `}`
 * leads its trimmed line at or left of the declaration's indentation, or
 * leads the code after a comment close the walk reads, at any indentation. It
 * reads a close in two places: the close of a block comment it is tracking
 * (one opened at line start, outside a template literal, whose close it can
 * see by the target line), and a close that begins its trimmed line. A brace
 * on a line inside a tracked region is prose.
 *
 * Comment boundaries are read no further than that, because telling a real
 * mid-line opener from the same two characters inside a string literal, a
 * regex, or a SQL fragment in a template literal is a lexer's job, and a
 * lexer is the dependency this module exists to avoid. A brace the rule
 * reads too EARLY resolves OUTWARD; a brace it misses resolves INWARD.
 *
 *  - OUTWARD: a block comment OPENED mid-line is not tracked, so a brace
 *    leading one of its lines reads as live and can close the declaration
 *    early. So can a `}` leading a line of template content. And a `}` after
 *    a read close ends the declaration even where it really closes an inner
 *    block. The answer is the enclosing function, or module scope.
 *  - INWARD: the brace that really ends the block is missed, so the
 *    declaration reads as still open and a match after it resolves to it.
 *    The shapes that do this include a block that opens and closes on its
 *    declaration's own line (`const noop = () => {};`), a `}` that follows
 *    other code or a self-contained comment on its line (`foo(); }`,
 *    `/* note *\/ }`), a `}` after a SECOND comment boundary on a line the
 *    walk reads only to its first close, the close of a comment opened
 *    mid-line when that close does not begin its line (` * note *\/ }`), a
 *    `}` indented right of its own declaration, and a brace swallowed by a
 *    phantom region: an opener in template content that an inverted
 *    template-parity count (named at {@link blockCommentInterior}) lets
 *    through, which this walk's region tracking introduced and the frontend
 *    copy's walk shares. The inversions are pinned as residuals in the
 *    machinery's own suite beside this file.
 *
 * The consequence in every case is a WRONG symbol — and how that fails
 * depends on the assertion consuming it:
 *
 *  - SET-EQUALITY assertions (the occurrence keys compared to an exact allowed
 *    set) fail closed only when the wrong symbol is a key the allowed set does
 *    not hold. An INWARD answer names a declaration that really sits above
 *    the match, and if that declaration is an allowed key the violation is
 *    absorbed: that is the silent pass, and every INWARD shape above can
 *    produce it. An OUTWARD answer names an enclosing scope, which fails
 *    closed exactly when that scope is not licensed itself. Two cases are:
 *    an allowed function enclosing a nested declaration, and module scope
 *    where an assertion licenses it. The keyspace-literal assertion in
 *    `no-session-proof-mint-outside-reauth-routes.test.ts` licenses
 *    `lib/fresh-auth.ts` at {@link MODULE_SCOPE}, so an outward answer that
 *    lands at that file's module scope is absorbed there.
 *
 *  - PAIRING assertions (every occurrence of X must have a Y in the same
 *    symbol) do NOT inherit that property. When both sides of a pair resolve to
 *    the same wrong key — module scope, for a declaration shape the resolver
 *    does not parse — they satisfy each other and the omission passes green.
 *    The rule every pairing scan must follow: exclude {@link MODULE_SCOPE}
 *    keys from the satisfying set (via {@link isModuleScopeKey}), and assert
 *    that no primary-side occurrence resolved to module scope, so an
 *    unresolvable declaration is a red bar naming the line rather than a pair
 *    that vouches for itself.
 *
 * Hand-ported sibling. `frontend/tests/unit/eslint/enclosing-symbol.js` carries
 * a dialect-adjusted copy of this module. The two share one algorithm:
 * {@link enclosingSymbol}'s upward declaration scan and its closing-brace test
 * (a declaration whose block closed at or left of its own indentation is
 * rejected), the region pass in {@link blockCommentInterior}, and the comment
 * predicate {@link isCommentLine}. They stay separate deliberately, because
 * each is written for the declaration shapes and the scan contract of its own
 * tree, and neither is a subset of the other: {@link isCommentedOut} here has
 * no equivalent in that copy, and that copy carries machinery of its own that
 * has none here. Read the sibling for what differs; a list of the differences
 * kept in this docblock would go stale with nothing failing.
 *
 * Nothing mechanical carries a fix to the shared machinery across, in either
 * direction, and the two have drifted before: a hardening of the comment
 * handling landed in that copy first and reached this one only later, ported
 * by hand. So the obligation runs both ways. A change to the walk, the region
 * pass, or the comment predicate in EITHER file is a prompt to read the other,
 * and reading the other is also how to learn which copy is ahead.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** What a declaration line looks like, in the shapes this codebase writes.
 *  Ordered by specificity: an Express registration is recognized before the
 *  arrow function that is its final argument.
 *
 *  The variable-assignment pattern carries a guard, because `= (` alone also
 *  matches a parenthesized EXPRESSION (`const raw = (parsed as X).field;`),
 *  and reading that as a function declaration hands every following line in
 *  the real enclosing function a wrong symbol. A `(`-initialized declaration
 *  counts as a function only when the line shows an arrow or a `function`
 *  keyword, or leaves more parens open than closed (a parameter list wrapping
 *  onto the next line). The paren count is naive about parens inside string
 *  literals — a miscount yields a wrong symbol, which under a set-equality
 *  assertion is a red bar, and under a pairing assertion is excluded from
 *  satisfying by the module-scope rule below only when it lands at module
 *  scope; the guard exists to make the common expression shape resolve past
 *  the local instead of stopping at it. */
const DECLARATION_PATTERNS: Array<{
  re: RegExp;
  label: (m: RegExpMatchArray) => string;
  guard?: (line: string) => boolean;
}> = [
  // `router.post('/session-auth', verifyHiveSignature, async (req, res) => {`
  {
    re: /\brouter\.(get|post|put|patch|delete|all)\(\s*'([^']*)'/,
    label: (m) => `${m[1].toUpperCase()} ${m[2]}`,
  },
  // `export async function handleSessionAuth(` / `function foo(`
  {
    re: /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)\s*[(<]/,
    label: (m) => m[1],
  },
  // `const handler = async (req, res) => {` / `export const foo = function (`
  {
    re: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:\(|function\b|<)/,
    label: (m) => m[1],
    guard: (line) => {
      if (/\bfunction\b|=>/.test(line)) return true;
      const opens = (line.match(/\(/g) ?? []).length;
      const closes = (line.match(/\)/g) ?? []).length;
      return opens > closes;
    },
  },
];

/** Label used when a match sits at module scope with no enclosing declaration. */
export const MODULE_SCOPE = '<module>';

/** Whether a `file#symbol` occurrence key resolved to module scope. Pairing
 *  scans use this to drop such keys from their satisfying sets — module scope
 *  is where every unresolvable declaration lands, so letting it satisfy a pair
 *  lets an unparsed shape vouch for itself (see the file docblock). */
export function isModuleScopeKey(key: string): boolean {
  return key.endsWith(`#${MODULE_SCOPE}`);
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function declarationOn(line: string): string | null {
  for (const { re, label, guard } of DECLARATION_PATTERNS) {
    const m = line.match(re);
    if (m && (guard === undefined || guard(line))) return label(m);
  }
  return null;
}

/** How many times `re` matches in `line`. `re` must carry the global flag. */
function countOf(line: string, re: RegExp): number {
  return (line.match(re) ?? []).length;
}

/** Whether a TRIMMED line opens a block comment it does not close on itself.
 *  One definition, because both readers of it (the brace walk and the region
 *  pass) draw the same distinction, and the sibling copy's history shows they
 *  drift apart when only one of them is hardened. */
function opensUnterminatedBlock(trimmed: string): boolean {
  return trimmed.startsWith('/*') && trimmed.indexOf('*/', 2) === -1;
}

/** Whether ANY comment close appears between `openIndex` and `lineIndex`.
 *
 *  Deliberately NOT named "does this opener close". Comments do not nest, so
 *  the first close below a REAL opener is that opener's own, but a close
 *  belonging to some later comment satisfies this test too, and every real
 *  module carries a docblock somewhere below any given line. It is therefore a
 *  weak guard on its own: it rules out a file with no block comment at all
 *  after the opener, and nothing more. What refuses the shape that actually
 *  occurs, an opener that is content inside a template literal (a SQL block
 *  comment in a query fragment, say), is the template test beside it in each
 *  caller. */
function aCommentCloseFollows(lines: string[], openIndex: number, lineIndex: number): boolean {
  for (let k = openIndex + 1; k <= lineIndex; k++) {
    if (lines[k].includes('*/')) return true;
  }
  return false;
}

/** For each line, whether a block comment opened on an EARLIER line is still
 *  open when this line begins.
 *
 *  A leading `*` is a docblock continuation, a wrapped multiplication (the
 *  `* CASE WHEN ...` factor lines in reputation SQL literals), and a markdown
 *  bold run (`**Authors:** ...` in a bridge post-body literal), and the shapes
 *  are textually identical. {@link isCommentLine} cannot tell them apart from
 *  one line, and treating every such line as prose skips live code: a
 *  forbidden-shape scan then misses the violation it exists to report. The
 *  context is what decides, so it is computed once per file here and handed to
 *  the skip predicate. Openers are recognized at line start only, which is the
 *  same boundary the rest of this module draws.
 *
 *  This asks the question {@link enclosingSymbol}'s brace walk asks, so it
 *  carries the walk's two guards for the same reasons: an opener inside a
 *  template literal is content, and an opener nothing ever closes is not a
 *  region. Without them a line-start opener sitting in a SQL literal puts the
 *  lines below it inside a phantom region, and the skip predicate then reads
 *  each star-leading line there as a docblock continuation, so a scan
 *  consuming this stops seeing that shape of live code. The window runs to the
 *  next line carrying a close, which in a real module is the next docblock
 *  rather than the end of the file. On a forbidden-shape scan that is a silent
 *  miss, which is the direction that must never be wrong. A star-leading line
 *  is the whole silent surface: every other line consults its own shape, so a
 *  phantom region cannot hide them. Leaving a region, the code after the close
 *  is read the same way the walk reads it: a line that closes one region and
 *  opens another (a close, then a second unterminated opener) re-enters, so a
 *  continuation below it is still prose to the predicate.
 *
 *  TEMPLATE PARITY IS A WHOLE-FILE BACKTICK COUNT, and two things invert it.
 *  A backtick that is not a delimiter still counts: inside a regex literal, a
 *  string literal, comment text, or escaped in a template's own text. Each one
 *  flips the count for every line after it. And a nested multi-line template
 *  (an interpolation opening its own literal on one line and closing it on a
 *  later one) contributes one backtick per line, so the nested content reads
 *  as OUTSIDE any template.
 *
 *  Each inversion has a direction. Where a real docblock opener falls in an
 *  inverted window it is refused and its star lines count as live, which on a
 *  forbidden-shape or demand-side scan is loud (a false red bar, not a miss).
 *  On a scan whose match SATISFIES a demand the same live reading is a
 *  satisfied pair read out of prose, which is silent, and is why those scans
 *  take {@link isCommentedOut} rather than this region. Where a template with
 *  a line-start opener in its content falls in an inverted window, the opener
 *  is accepted and the star-leading reads below it are skipped, which is
 *  silent on a forbidden-shape scan. Neither is closed
 *  here: counting only code-shaped backticks, or tracking interpolation depth,
 *  is the lexer this module declines. Both are pinned as residuals in the
 *  machinery's own suite beside this file. */
export function blockCommentInterior(lines: string[]): boolean[] {
  const interior = new Array<boolean>(lines.length).fill(false);
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

/**
 * The nearest declaration whose block still contains `lineIndex`, or
 * {@link MODULE_SCOPE}.
 *
 * `lines` is the file split on newlines; `lineIndex` is 0-based.
 */
export function enclosingSymbol(lines: string[], lineIndex: number): string {
  for (let i = lineIndex; i >= 0; i--) {
    const name = declarationOn(lines[i]);
    if (name === null) continue;
    const declIndent = indentOf(lines[i]);
    // A closing BRACE at or left of the declaration's own indentation means the
    // declaration's block ended before the target line, so this is a preceding
    // sibling rather than an enclosing scope. Keep walking up.
    //
    // Only `}` counts, never `)` or `]`. A multi-line signature closes its
    // parameter list with `): Promise<void> {` at the declaration's own
    // indentation, and reading that as a block end would make every function
    // with wrapped parameters resolve to module scope. A brace inside a
    // comment is prose and does not count either: a `//` line or a `*`
    // continuation begins with its own marker and can never begin with `}`,
    // so the one comment shape that needs handling is the interior of a block
    // comment opened at line start, tracked as a running open/closed state.
    //
    // The state is entered only for a region the walk can SEE close, and only
    // for an opener outside a template literal. An unterminated line-start
    // opener inside a template literal is content, not comment (a SQL block
    // comment in a query fragment writes exactly that shape), and a phantom
    // region opened there never closes and swallows the brace that ends the
    // declaration. Resolving wider that way is not a safe direction: the
    // wrong symbol can be one the consumer has already licensed, which
    // absorbs the addition, rather than a new member that fails closed.
    //
    // Leaving the region, the code after the first close on that line is live
    // and gets the same opener test as any other line: a close followed by a
    // second unterminated opener re-enters. A line whose trimmed text BEGINS
    // with a close is read the same way when no region is tracked, because
    // the walk does not see a comment opened mid-line, and its close line is
    // the one place that comment becomes visible. Only the FIRST close on a
    // line is read; the file docblock's comment-boundary paragraphs name what
    // that leaves open.
    //
    // A `}` leading the code after a close ends the declaration WHATEVER the
    // line's indentation. The natural docblock close is indented (` */`), so
    // an indentation test there would miss ` */ }` closing the declaration
    // and resolve inward. Where that brace really closes an inner block, the
    // answer is outward instead, which a set-equality consumer reads as a new
    // member.
    //
    // "Can SEE close" is bounded by the target line, inclusive, not by the
    // end of the file (the region pass, which has no target, reads to the
    // end). A close below the target cannot vouch for an opener above it:
    // taking it would swallow a brace on evidence the walk has not reached
    // and resolve INWARD, and inward is the direction a licensed key can
    // absorb. Declining resolves outward, which fails closed.
    //
    // Template parity is seeded from the declaration line's own backticks,
    // because a one-line declaration can open a literal the next line is
    // already inside. It is a plain count of backticks per line from there,
    // inverted by the same two shapes the region pass names; both are pinned
    // as residuals in the machinery's own suite.
    //
    // Tracking a region at all opens an INWARD path of its own. An inverted
    // count lets a line-start opener in template content through the guard,
    // and the phantom region it opens swallows the brace that ends the
    // declaration. A walk that never entered a region could not swallow a
    // brace, so this path arrived with the region tracking rather than being
    // carried over from the shape test it replaced. It is kept, and the
    // frontend copy's walk has the same path, because it needs two rare
    // shapes at once: a stray backtick and a line-start opener inside a
    // template.
    let closedBefore = false;
    let inBlockComment = false;
    let ticks = countOf(lines[i], /`/g);
    for (let j = i + 1; j <= lineIndex; j++) {
      const line = lines[j];
      const inTemplate = ticks % 2 === 1;
      ticks += countOf(line, /`/g);
      let code = line;
      let afterClose = false;
      if (inBlockComment) {
        const close = line.indexOf('*/');
        if (close === -1) continue;
        inBlockComment = false;
        code = line.slice(close + 2);
        afterClose = true;
      } else if (line.trim().startsWith('*/')) {
        code = line.slice(line.indexOf('*/') + 2);
        afterClose = true;
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
      if (trimmed.startsWith('}') && (afterClose || indentOf(line) <= declIndent)) {
        closedBefore = true;
        break;
      }
    }
    if (closedBefore) continue;
    return name;
  }
  return MODULE_SCOPE;
}

/** One scanned source file: its label in assertion output, and its lines. */
export interface ScannedSource {
  rel: string;
  lines: string[];
}

/**
 * Every `.ts` file under `root`, recursively, labelled relative to `root` with
 * forward slashes so an assertion reads `routes/custody.ts` on every platform.
 *
 * Recursive by default because the non-recursive alternative is the exact bug
 * these canaries were written to stop having: a scan over the top of one
 * directory silently visits none of its subdirectories, and everything it fails
 * to visit passes vacuously.
 */
export function sourcesUnder(root: string): ScannedSource[] {
  const out: ScannedSource[] = [];
  // Symlinks are followed, because vitest's file glob follows them: a linked
  // test file or directory runs as part of the suite and so is part of the
  // scan. `statSync` resolves the link; a dangling one is skipped; a link back
  // to a directory still being walked (an ancestor, by real path) is not
  // entered, so a cycle cannot recurse forever, while a link to a sibling
  // directory is walked under both names, as vitest runs it under both.
  const ancestors = new Set<string>();
  const walk = (dir: string): void => {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (ancestors.has(real)) return;
    ancestors.add(real);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      let target;
      try {
        target = statSync(full);
      } catch {
        continue;
      }
      if (target.isDirectory()) walk(full);
      else if (target.isFile() && entry.name.endsWith('.ts')) {
        out.push({
          rel: path.relative(root, full).split(path.sep).join('/'),
          lines: readFileSync(full, 'utf8').split('\n'),
        });
      }
    }
    ancestors.delete(real);
  };
  walk(root);
  return out;
}

/** A line that is entirely comment: a `//` line, a block comment opened at
 *  line start that runs to the end of the line (or past it), or the `*`
 *  continuation inside a docblock — with an optional `insideRegion` argument
 *  saying whether the line begins inside an open block-comment region, as
 *  computed once per file by {@link blockCommentInterior}.
 *
 *  A block comment that closes on its own line with code after it is live
 *  code behind a comment prefix, not prose, and is NOT skipped: a coverage
 *  pragma in front of a forbidden call must not hide the call. Only further
 *  comment may follow the close for the line to stay prose. The rule is
 *  written for all three prefixes: inside an open region a `//` is comment
 *  text like any other, so a line that begins with one and then closes the
 *  region is live behind its close too.
 *
 *  Shape alone decides every case but the leading star. A leading `*` is a
 *  docblock continuation, a wrapped multiplication (the `* CASE WHEN ...`
 *  factor lines in reputation SQL literals), and a markdown bold run
 *  (`**Authors:** ...` in a bridge post-body literal), all identical to a
 *  one-line test, so that case takes `insideRegion`:
 *
 *   - At a region KNOWN closed (`false`), a star line that is not itself a
 *     close is live whatever follows it, a trailing comment included:
 *     nothing is open for it to continue, so the close search is not
 *     consulted at all. A close-leading line is the one star shape left to
 *     the search — it ends a comment whatever the region pass believes (the
 *     pass under-reports where an opener was refused, or sat mid-line and
 *     was never seen), so it is answered by what follows its close.
 *   - With a region OPEN (`true`), or none known (`undefined`), a close on
 *     the line is what answers: code behind it is live; nothing, or further
 *     comment, is prose; and a line with no close is prose.
 *   - A leading `//` is prose on its shape outside a region, but inside one
 *     it is inspected for a close like the other two prefixes, because the
 *     region is what decides what the two slashes are.
 *
 *  Passing nothing is NOT the pure shape test (a line is comment when its
 *  trimmed text begins with `*`, `//` or `/*`). It presumes a star line
 *  continues a comment and then answers every prefixed line but a `//` line
 *  by its close search, as an open region does, so code behind a close is
 *  live: `/* call *\/ code` and ` * prose *\/ code` both read as live. That
 *  suits a caller with no file in hand (a single-line planted pin, an
 *  import-clause walk); a SCAN must pass the region, because reading live
 *  code as prose there is the violation going unreported. A caller that
 *  wants the pure shape test is a satisfying-side scan, and
 *  {@link isCommentedOut} keeps it.
 *
 *  Two residuals, neither closed here:
 *
 *   - TEMPLATE PARITY never reaches this predicate. Both opener readers (the
 *     region pass and the brace walk) guard their opener test with a template
 *     check, and there is no such signal here; `insideRegion` cannot stand in
 *     for one, because inside a template literal no block region is open, so
 *     `false` is the honest answer to the question the argument asks while
 *     the reading it licenses can still be wrong for content that only LOOKS
 *     commented out. A line dropped this way is dropped before
 *     {@link enclosingSymbol} runs, so no key is minted and there is no
 *     member for a consuming set-equality to weigh — the silent direction.
 *     Closing it needs the lexer this module declines.
 *   - THE CLOSE SEARCH for a block-comment prefix begins past the opener's
 *     own two characters, so a line whose first three characters are an
 *     opener plus a slash reads as an opener rather than as the close it
 *     carries. The offset is right outside a region, where such a line
 *     really is an opener, and the in-region shape stays dismissed as
 *     contrived.
 *
 *  Which predicate a scan wants follows from what a match MEANS, and the two
 *  answers are opposites. On a scan for a FORBIDDEN call the match IS the
 *  violation, so every line skipped is a violation not reported: filter as
 *  little as possible, and this region-aware test is that minimum. On a scan
 *  for a REQUIRED call the match SATISFIES the demand, so an over-match is the
 *  silent failure — a call read out of prose, or out of one somebody commented
 *  out while debugging and never restored, pairs with the live code that was
 *  supposed to need it and the canary goes quiet for exactly the omission it
 *  exists to catch. Those scans want {@link isCommentedOut}. */
export function isCommentLine(line: string, insideRegion?: boolean): boolean {
  const trimmed = line.trim();
  // An arm that can sit inside a region closes before it is believed: a
  // comment close begins with the same star a docblock continuation does,
  // and inside an open region a `//` is comment text that can end the region
  // on that same line, so an arm answering on its prefix alone would claim a
  // line whose comment has already ended and skip the live code behind it.
  // Two readings ARE on the prefix alone, in opposite directions: a `//`
  // line outside a region, or with none known, is prose; and a `*` line that
  // is not itself a close, at a region KNOWN closed, is live. The close
  // search answers the rest, the close-leading line included, which is why
  // the known-closed reading excludes it. An opener is searched past its own
  // two characters, so an opener that begins with a star is not read as
  // self-closing.
  const opensBlock = trimmed.startsWith('/*');
  const lineComment = trimmed.startsWith('//');
  if (lineComment && insideRegion !== true) return true;
  if (!opensBlock && !lineComment && !trimmed.startsWith('*')) return false;
  if (insideRegion === false && trimmed.startsWith('*') && !trimmed.startsWith('*/')) return false;
  const close = trimmed.indexOf('*/', opensBlock ? 2 : 0);
  if (close === -1) {
    // Nothing closes on this line, and every prefix reaching here is prose
    // on that evidence: an opener with nothing after it, a `//` inside a
    // region, and a leading star with a region open or none known — the star
    // is the one that needed the region. With none known (`undefined`), a
    // star line is presumed to continue a comment, which is why it reaches
    // the close search at all.
    return true;
  }
  const rest = trimmed.slice(close + 2).trim();
  // Anything after a close is outside the region by construction.
  return rest === '' || isCommentLine(rest, false);
}

/**
 * A line that is commented out: a comment by shape, or a line sitting inside a
 * block comment whose opener began an earlier line and has not closed yet.
 *
 * The second half is not hypothetical fussiness. An editor's block-comment
 * toggle over a multi-line selection prefixes only the FIRST line, so the
 * commented-out call itself keeps its original indentation and its `await`,
 * and {@link isCommentLine} reads it as live code. That is the same accident
 * as a line-comment toggle and it must not be the one that gets through.
 *
 * The first test is the pure SHAPE test, not {@link isCommentLine}: a line
 * whose trimmed text begins with `*`, `//` or `/*` is commented out, whatever
 * follows a close on it. This predicate serves scans whose match SATISFIES a
 * demand, where over-matching is the silent failure, so a call riding behind a
 * comment close (`/* note *\/ sweep()`) is not trusted to vouch for anything;
 * a real call written that way reads as missing, which is a red bar naming the
 * line. The same goes for a star line: one that is live code reads as missing,
 * loudly, and one that is prose behind a region the region pass under-reports
 * (a block comment opened mid-line, an opener refused by inverted template
 * parity) stays prose.
 *
 * The walk is upward from the match rather than a stateful pass over the file
 * because `occurrencesOf` calls this only on lines that already matched the
 * pattern, which is a handful per scan. It recognizes an opener only when it
 * starts a line, so a block-comment opener inside a string or a URL cannot open
 * a phantom block.
 */
export function isCommentedOut(line: string, lineIndex: number, lines: string[]): boolean {
  if (/^\s*(?:\*|\/\/|\/\*)/.test(line)) return true;
  for (let i = lineIndex - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    // A close before an open means the nearest block already ended.
    if (trimmed.includes('*' + '/')) return false;
    if (trimmed.startsWith('/*')) return true;
  }
  return false;
}

/** The skip predicate {@link occurrencesOf} hands each matched line: the line,
 *  its index, the whole file, and whether a block-comment region is open when
 *  the line begins. */
export type SkipLine = (
  line: string,
  lineIndex: number,
  lines: string[],
  insideRegion: boolean,
) => boolean;

/** The prose-only skip for a scan whose match is a violation or a demand:
 *  {@link isCommentLine} with the region {@link occurrencesOf} computes once
 *  per file, so a star-leading line of live code (a wrapped multiplication in
 *  a SQL literal) is scanned rather than read as a docblock continuation.
 *
 *  Not for a scan whose match SATISFIES a demand. Prose behind a region the
 *  region pass under-reports reads as live here, which on that side is a
 *  satisfied pair nobody wrote; those scans take {@link isCommentedOut}. */
export const skipCommentLine: SkipLine = (line, _lineIndex, _lines, insideRegion) =>
  isCommentLine(line, insideRegion);

/** {@link skipCommentLine}, plus any line `definition` matches: the shape a
 *  scan uses to skip the definition of the call it counts, so the defining
 *  module is still scanned for calls to it. */
export function skipCommentOr(definition: RegExp): SkipLine {
  return (line, lineIndex, lines, insideRegion) =>
    definition.test(line) || skipCommentLine(line, lineIndex, lines, insideRegion);
}

/**
 * Every `file#symbol` occurrence of `pattern` across `files`, plus a
 * human-readable site list for assertion messages.
 *
 * `skipLine` drops a matched line before it is counted — for a definition site
 * that necessarily matches the call pattern it defines, say. It receives the
 * line's index and the whole file, so a predicate can also decide from
 * surrounding lines ({@link isCommentedOut} is one that needs that), and a
 * fourth argument saying whether the line begins inside an open block-comment
 * region, computed once per file by {@link blockCommentInterior} because a
 * leading star cannot be read from one line alone.
 *
 * A forbidden-shape or demand-side scan passes {@link skipCommentLine}, or
 * {@link skipCommentOr} when it also skips a definition line, rather than a
 * closure of its own: a closure that drops the region argument still
 * compiles and quietly falls back to the no-region reading.
 */
export function occurrencesOf(
  files: ScannedSource[],
  pattern: RegExp,
  skipLine?: SkipLine,
): { keys: string[]; sites: string[] } {
  const keys = new Set<string>();
  const sites: string[] = [];
  for (const { rel, lines } of files) {
    const interior = blockCommentInterior(lines);
    lines.forEach((line, i) => {
      if (!pattern.test(line)) return;
      if (skipLine?.(line, i, lines, interior[i])) return;
      const symbol = enclosingSymbol(lines, i);
      keys.add(`${rel}#${symbol}`);
      sites.push(`${rel}:${i + 1} (${symbol}) — ${line.trim()}`);
    });
  }
  return { keys: [...keys].sort(), sites };
}

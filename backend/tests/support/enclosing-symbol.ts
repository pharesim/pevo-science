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
 * the target line (a `}` at or left of the declaration's own indentation).
 *
 * Known limitation, and where it is safe. A declaration whose block opens and
 * closes on its own line (`const noop = () => {};`) has no closing brace on a
 * LATER line, so a match below it can resolve to that declaration instead of
 * the real enclosing scope; a declaration shape the patterns do not recognize
 * at all (an object-method shorthand, a class member) resolves to
 * {@link MODULE_SCOPE}. The consequence is a WRONG symbol — and how that fails
 * depends on the assertion consuming it:
 *
 *  - SET-EQUALITY assertions (the occurrence keys compared to an exact allowed
 *    set) fail closed: a wrong symbol is a new member and therefore a red bar,
 *    never a silent pass. A silent pass would require a violating occurrence to
 *    resolve to one of the already-allowed keys, which means it is textually
 *    inside that allowed function's block, which is the case the allow entry
 *    covers.
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
 * a dialect-adjusted copy of this module, sharing the upward declaration scan
 * and the closing-brace test that rejects a declaration whose block closed at
 * or left of its own indentation. The two stay separate deliberately: that copy
 * adds Alpine method-shorthand and template-literal declaration shapes and a
 * per-key occurrence tally, and this one keeps {@link isCommentedOut}, which
 * that copy dropped. Nothing mechanical carries a fix to the shared walk
 * across, so a change to the walk here is a prompt to read the other copy.
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
    // with wrapped parameters resolve to module scope. Comment lines are
    // skipped for the same class of reason: a `}` inside a docblock is prose.
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

/** A line that is entirely comment BY SHAPE: a `//` line, a block opener, or
 *  the `*` continuation inside a docblock.
 *
 *  Which predicate a scan wants follows from what a match MEANS, and the two
 *  answers are opposites. On a scan for a FORBIDDEN call the match IS the
 *  violation, so every line skipped is a violation not reported: filter as
 *  little as possible, and this shape-only test is that minimum. On a scan for
 *  a REQUIRED call the match SATISFIES the demand, so an over-match is the
 *  silent failure — a call read out of prose, or out of one somebody commented
 *  out while debugging and never restored, pairs with the live code that was
 *  supposed to need it and the canary goes quiet for exactly the omission it
 *  exists to catch. Those scans want {@link isCommentedOut}. */
export function isCommentLine(line: string): boolean {
  return /^\s*(?:\*|\/\/|\/\*)/.test(line);
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
 * The walk is upward from the match rather than a stateful pass over the file
 * because `occurrencesOf` calls this only on lines that already matched the
 * pattern, which is a handful per scan. It recognizes an opener only when it
 * starts a line, so a block-comment opener inside a string or a URL cannot open
 * a phantom block.
 */
export function isCommentedOut(line: string, lineIndex: number, lines: string[]): boolean {
  if (isCommentLine(line)) return true;
  for (let i = lineIndex - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    // A close before an open means the nearest block already ended.
    if (trimmed.includes('*' + '/')) return false;
    if (trimmed.startsWith('/*')) return true;
  }
  return false;
}

/**
 * Every `file#symbol` occurrence of `pattern` across `files`, plus a
 * human-readable site list for assertion messages.
 *
 * `skipLine` drops a matched line before it is counted — for a definition site
 * that necessarily matches the call pattern it defines, say. It receives the
 * line's index and the whole file, so a predicate can also decide from
 * surrounding lines; {@link isCommentedOut} is the one that needs that.
 */
export function occurrencesOf(
  files: ScannedSource[],
  pattern: RegExp,
  skipLine?: (line: string, lineIndex: number, lines: string[]) => boolean,
): { keys: string[]; sites: string[] } {
  const keys = new Set<string>();
  const sites: string[] = [];
  for (const { rel, lines } of files) {
    lines.forEach((line, i) => {
      if (!pattern.test(line)) return;
      if (skipLine?.(line, i, lines)) return;
      const symbol = enclosingSymbol(lines, i);
      keys.add(`${rel}#${symbol}`);
      sites.push(`${rel}:${i + 1} (${symbol}) — ${line.trim()}`);
    });
  }
  return { keys: [...keys].sort(), sites };
}

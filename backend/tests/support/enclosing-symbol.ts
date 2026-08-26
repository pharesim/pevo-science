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
 * negatives in its own test file. The rule is: scan upward for the nearest
 * declaration, and reject it if its block demonstrably closed before the target
 * line (a `}` at or left of the declaration's own indentation).
 */

/** What a declaration line looks like, in the shapes this codebase writes.
 *  Ordered by specificity: an Express registration is recognized before the
 *  arrow function that is its final argument. */
const DECLARATION_PATTERNS: Array<{ re: RegExp; label: (m: RegExpMatchArray) => string }> = [
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
  },
];

/** Label used when a match sits at module scope with no enclosing declaration. */
export const MODULE_SCOPE = '<module>';

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function declarationOn(line: string): string | null {
  for (const { re, label } of DECLARATION_PATTERNS) {
    const m = line.match(re);
    if (m) return label(m);
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

/**
 * Every `file#symbol` occurrence of `pattern` across `files`, plus a
 * human-readable site list for assertion messages.
 *
 * `relOf` maps an absolute path to the repo-relative label the assertion reads
 * in, so a red bar names `src/routes/custody.ts#POST /session-auth` rather than
 * an absolute path from the runner's checkout.
 */
export function occurrencesOf(
  files: Array<{ rel: string; lines: string[] }>,
  pattern: RegExp,
  skipLine?: (line: string) => boolean,
): { keys: string[]; sites: string[] } {
  const keys = new Set<string>();
  const sites: string[] = [];
  for (const { rel, lines } of files) {
    lines.forEach((line, i) => {
      if (!pattern.test(line)) return;
      if (skipLine?.(line)) return;
      const key = `${rel}#${enclosingSymbol(lines, i)}`;
      keys.add(key);
      sites.push(`${rel}:${i + 1} (${enclosingSymbol(lines, i)}) — ${line.trim()}`);
    });
  }
  return { keys: [...keys].sort(), sites };
}

/**
 * Standing source-discipline canary: a session's `custody` claim is derived
 * from an `accounts` row in exactly one place, `custodyClaimFor` in
 * `lib/custody-claim.ts`, and every mint or reader that turns a row into a
 * custody value goes through it.
 *
 * Why a mechanical check: the split this closes was two copies of "what does
 * this row's custody mean" that disagreed. The password login derived the
 * claim from the `upgraded_at` epoch; the ORCID login copied the `custody`
 * column raw. While the upgrade route only wrote the epoch, the two mints
 * produced different claims for the same upgraded account, and the ORCID one
 * was `'light'`, the claim with server-side signing authority attached. The
 * column is aligned now and the schema refuses the divergent shape, so the
 * rows two mints would read differently can no longer be seeded and a
 * behavioural test built on a seeded row has nothing left to hold up. (The
 * mints can still be handed different snapshots of one row, when an upgrade
 * commits between a read and a derive; that residual is closed by the
 * per-route `upgraded_at` re-reads, not by anything this canary guards.)
 * What a drift back to an
 * inline derivation would look like is therefore invisible at the wire and has
 * to be caught in the source.
 *
 * Three scans, each closing a way the derivation could split again:
 *
 *   1. The helper's caller set is pinned as `file#symbol` pairs. A row-reading
 *      mint that stops calling the helper drops out of the set; a new
 *      row-reading mint that does not call it never enters. Either is a red
 *      bar naming the handler.
 *   2. The derivation SHAPES are refused everywhere except the helper's own
 *      module: a ternary on `upgraded_at` yielding a custody literal, and a
 *      read of some row's `custody` column into a binding or claim named
 *      `custody`, in every spelling that reaches the same property (plain,
 *      optional-chained, non-null-asserted, cast, bracketed, destructured).
 *      A handler that re-inlines either has reintroduced a second derivation
 *      whether or not it also still calls the helper. The shapes are matched
 *      against the STATEMENT a line opens rather than against the line, so a
 *      derivation a formatter wrapped is seen as the one expression it is.
 *      This scan carries the weight for a new row-reading site that mints no
 *      JWT: such a site adds no key to the caller set and no mint to classify,
 *      so nothing else can name it.
 *
 *      What it still does not see, deliberately. A derivation that reaches the
 *      epoch or the column through an INTERMEDIATE BINDING (an `upgraded_at`
 *      local, then a ternary on the local), one written as CONTROL FLOW rather
 *      than a conditional expression (`if (row.upgraded_at) return 'self'`),
 *      one whose destination carries a DIFFERENT NAME, an assignment
 *      destructure (`({ custody } = row)`, which is not a declaration), and a
 *      column named through a constant (`row[COLUMN]`). Reading through any of
 *      them needs taint analysis, not a textual scan. At a site that MINTS,
 *      the claim-source classification refuses them anyway: the claim binds
 *      from a variable at a symbol that is not a helper caller. The residual
 *      is a reader that mints nothing. The statement join has stated bounds of
 *      its own: it stops at a blank line, and it carries two caps, one on the
 *      lines it joins and one on the lines it walks, so prose inside a
 *      statement costs nothing while prose between two statements cannot
 *      bridge them.
 *
 *      The over-match to expect first is a multi-line call whose arguments
 *      mention `upgraded_at` and whose later lines contain a conditional
 *      yielding `'self'` or `'light'` — a structured log line beside a custody
 *      branch. That is a red bar on code that derives nothing; the fix is to
 *      look at the reported line, not to narrow the pattern.
 *   3. Every session-JWT mint is classified by how its `custody` claim is
 *      sourced. A mint that writes the column in the same handler may use a
 *      literal (the literal IS the value it just wrote); the token refresh
 *      may carry the already-verified claim forward; everything else must
 *      bind `custody` from the helper. An unclassifiable mint is a red bar,
 *      and so is a literal at a handler that did not just write the column.
 *
 * Detection is textual, per `tests/support/enclosing-symbol.ts`; the planted
 * self-tests at the bottom keep the patterns honest.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  blockCommentInterior,
  enclosingSymbol,
  isCommentLine,
  occurrencesOf,
  sourcesUnder,
  type ScannedSource,
} from '../support/enclosing-symbol.js';

/** The prose-only skip the scans below hand to `occurrencesOf`: comment by
 *  shape plus the block-comment region `occurrencesOf` computes once per
 *  file, so a star-leading line of live code (a wrapped multiplication in a
 *  SQL literal) is scanned rather than read as a docblock continuation. */
const skipCommentLine = (
  line: string,
  _lineIndex: number,
  _lines: string[],
  insideRegion: boolean,
): boolean => isCommentLine(line, insideRegion);

const HELPER_MODULE = 'lib/custody-claim.ts';

/** A call of the helper. The definition line is skipped by shape so the
 *  defining module stays scanned for anything else it might do. */
const HELPER_CALL_RE = /\bcustodyClaimFor\s*\(/;
const HELPER_DEFINITION_RE = /function\s+custodyClaimFor\s*\(/;

/** Every site that turns a row into a custody value. Four session mints that
 *  read a row, plus the two settings handlers that report or branch on the
 *  same pair of columns. */
const ALLOWED_HELPER_CALL_SITES = [
  'routes/auth.ts#POST /login',
  'routes/orcid.ts#handleLogin',
  'routes/recover.ts#POST /recover',
  'routes/recover.ts#POST /recover/verify',
  'routes/settings.ts#DELETE /email',
  'routes/settings.ts#GET /email',
];

/** A conditional on the epoch column that yields a custody literal:
 *  `x.upgraded_at ? 'self' : ...`, with or without a null comparison in
 *  between. The old inline shape at every mint. Bounded by the statement
 *  terminator rather than the line ending, because `statementOccurrences` runs
 *  it against a joined statement: a formatter that breaks after the condition
 *  writes the same derivation across three lines. */
const EPOCH_TERNARY_RE = /\bupgraded_at\b[^;]*\?\s*['"`](?:self|light)['"`]/;

/** A row's `custody` column copied into a binding or claim named `custody`:
 *  `custody: account.custody`, `const custody = row.custody`,
 *  `custody: rows[0].custody`. The old ORCID-login shape. Anchored on the
 *  destination NAME because a claim field is always spelled `custody`, and a
 *  binding that later feeds the claim is, in every site this codebase has
 *  written, spelled the same.
 *
 *  The column READ is matched through whatever a caller writes between the
 *  destination and the property: an optional chain, a non-null assertion, a
 *  cast (to a named type, or to an inline one whose members clear the
 *  character rule stated further down), an index, or a line break the accessor
 *  was wrapped on. Those are what a nullable row annotation
 *  and an indexed result produce with nobody intending an evasion, and a
 *  dotted same-line pattern sees none of them.
 *
 *  What bounds the run is a WHITELIST, not a list of property separators:
 *  between the destination and the property only word characters, whitespace
 *  and `$ ? ! . [ ] { } < > ( )` may appear. Every other character ends the
 *  run, and a comma is only the most familiar of them — a quote, a colon, a
 *  semicolon, a backtick, an `=` (so any arrow or comparison) and every
 *  arithmetic operator stop it just as completely, wherever in the span they
 *  sit rather than only inside an argument list.
 *
 *  That is what keeps the scan from pairing one object's `custody:` key with a
 *  neighbouring property's `.custody` access. Allow commas alone and
 *  `logger.info({ custody: claim }, row.custody)` reports itself; the
 *  `hasPassword: row.custody` control planted beside it needs a comma, a colon
 *  AND a quote admitted together before it fires, so it is not on its own what
 *  demonstrates the exclusion earns its keep.
 *
 *  What the whitelist costs is a column read whose expression carries an
 *  excluded character between the LAST `custody:` or `custody =` in the text
 *  and the read itself. It is not every read carrying such a character,
 *  because the run restarts at each destination: a later `custody:` closer to
 *  the read can still reach it. Shapes that miss:
 *  `const custody = helper(row, options).custody;`,
 *  `const custody = helper('x').custody;`,
 *  `const custody = pick<A, B>(rows).custody;`,
 *  `const custody = (row as Record<string, string>).custody;`,
 *  `const custody = rows[i + 1].custody;`,
 *  `const custody = rows.map((r) => r)[0].custody;`.
 *
 *  An inline cast is one instance of that class, and it is bounded by POSITION
 *  rather than by member count: the run can anchor on the cast's own `custody:`
 *  key, so a cast of any arity matches when `custody` is its LAST member and
 *  misses when any member follows it. `as { a: string; b: string; custody:
 *  string }` matches; `as { custody: string; email: string }` does not. Those
 *  spellings are illustrative; the character rule and the restart, not the
 *  list, are what bound the residual. */
const COLUMN_COPY_RE =
  /\bcustody\s*[:=]\s*[\w$?!.[\]{}<>()\s]*?(?:\??\.\s*custody\b|\[\s*['"`]custody['"`]\s*\])/;

/** The same copy written as a destructure: `const { custody } = rows[0]`,
 *  `const { custody, upgraded_at } = account`. Same destination name, same raw
 *  column, no property access anywhere on the line.
 *
 *  The refusal is absolute for a declaration destructure naming the column,
 *  including one inside a symbol that also calls the helper: pulling the
 *  column out of the row is the shape, and what the symbol does with it
 *  afterwards is not something a textual scan can vouch for. Pass the row to
 *  the helper instead of unpacking the column. Restricted to a `const`/`let`/
 *  `var` declaration so a type literal listing the column, and the helper's
 *  own parameter destructure, are not matches. */
const COLUMN_DESTRUCTURE_RE = /\b(?:const|let|var)\s+\{[^{}]*\bcustody\b[^{}]*\}\s*=/;

/** A session-JWT mint. Same anchor the session-issuing registry uses. */
const JWT_MINT_RE = /\bjwt\.sign\s*\(/;

/** A literal custody claim inside a mint payload, and the sites that may
 *  write one: each writes the column in the same handler, so the literal is
 *  the value just written rather than a derivation. */
const LITERAL_CLAIM_RE = /\bcustody\s*:\s*['"`](?:self|light)['"`]/;
const ALLOWED_LITERAL_CLAIM_SITES = [
  'routes/custody.ts#POST /upgrade',
  'routes/signup-verify.ts#POST /confirm',
  'routes/signup-verify.ts#POST /link',
];

/** A custody claim bound from a variable (`custody,` / `custody }`), which
 *  must come from the helper, except at the token refresh, which carries the
 *  claim the middleware already verified rather than reading a row. */
const VARIABLE_CLAIM_RE = /(?<![.\w])custody\s*(?:,|\})/;
const ALLOWED_CLAIM_CARRY_SITES = ['routes/auth.ts#POST /session'];

/** How far the forward walks reach, in two independent budgets.
 *
 *  `SCAN` bounds a walk itself, in lines below the one it starts from, and is
 *  shared by the two walks in this file. `mintPayload` gathers a mint's
 *  argument list and keeps walking while a paren it counted, in code, a
 *  comment or a string, stays unclosed; `statementFrom` gathers the statement
 *  a line opens and steps over comment lines for free, so without a bound it
 *  reaches the code on the far side of a long comment run. Either way the walk
 *  reports unrelated code as part of the statement it started on, and one
 *  constant keeps the two bounds from drifting apart by hand.
 *
 *  `JOIN` belongs to `statementFrom` alone and counts the lines actually
 *  joined, so stepping over prose costs nothing there. */
const STATEMENT_JOIN_CAP = 4;
const STATEMENT_SCAN_CAP = 12;

/** The payload of a mint: the mint line plus the following lines up to the
 *  first closing `)` at the call's own depth, capped by `STATEMENT_SCAN_CAP`
 *  so a runaway scan cannot swallow the next handler. */
function mintPayload(lines: string[], lineIndex: number): string {
  let depth = 0;
  let out = '';
  for (let j = lineIndex; j < lines.length && j <= lineIndex + STATEMENT_SCAN_CAP; j++) {
    const line = lines[j];
    out += line + '\n';
    for (const ch of line) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth <= 0 && j > lineIndex) break;
  }
  return out;
}

type ClaimSource = 'literal' | 'variable' | 'none';

function classifyMint(lines: string[], lineIndex: number): ClaimSource {
  const payload = mintPayload(lines, lineIndex);
  if (LITERAL_CLAIM_RE.test(payload)) return 'literal';
  if (VARIABLE_CLAIM_RE.test(payload)) return 'variable';
  return 'none';
}

/** A line that OPENS A BLOCK rather than continuing an expression: a condition,
 *  a loop header, a catch clause. `statementFrom` stops its join at one. A gate
 *  that reads the epoch to refuse (`if (account.upgraded_at) {`) and the first
 *  statement of its body are two statements, not one; joining them reports
 *  every such gate whose body happens to contain a `?` — a nullish default in
 *  a log payload is enough — as an inline derivation. Those gates are the
 *  shape the refusal-gate controls license, and they are the most common
 *  `upgraded_at` spelling in the tree. */
const BLOCK_OPENER_RE = /\)\s*\{\s*$/;

/** The STATEMENT a line opens: the line itself, joined with the lines below it
 *  until one carries a terminator or opens a block, a blank line ends the run,
 *  or one of the two caps is reached. Comment lines inside the run are stepped
 *  over, not joined, so prose between two halves of an expression neither
 *  breaks the join nor contributes text to it, and it spends no budget either:
 *  the cap that ends the run counts the lines JOINED, not the lines walked.
 *
 *  Counting the walk instead was the bug this replaced, and it was not confined
 *  to one call. Four lines of prose between a ternary's condition and its
 *  branches exhausted the cap before a single line of the expression was
 *  reached, so a derivation whose two halves straddled the prose went
 *  unreported by every scan rather than merely at the line it started on.
 *
 *  `STATEMENT_SCAN_CAP` is not free and is not what the join budget replaced.
 *  It buys back a bound the joined count gave up: without it a line sitting
 *  above a long comment run reaches the code beyond it, and this tree holds
 *  runs long enough for that to join two unrelated statements. What it costs
 *  is the far tail of the same shape the join budget fixed. A derivation split
 *  by twelve or more consecutive comment lines still escapes; the old cap
 *  escaped at four. Neither bound changes a single reported site across the
 *  current tree, so the choice is between two residuals rather than between a
 *  cost and none. The boundary is pinned in both directions by the
 *  split-derivation probes, so moving the cap means moving those counts and
 *  the twelve stated here with it.
 *
 *
 *  The shape scans run against this instead of the raw line because a
 *  derivation split over a line break is the same derivation: a ternary
 *  wrapped after its condition, a long row expression pushed under its key.
 *  Both are what a formatter or a long identifier produces, with no intent to
 *  evade, and a line-scoped pattern sees neither. Over-matching a statement is
 *  the safe direction for a scan that REFUSES a shape: a false positive is a
 *  red bar someone reads, a false negative is the second derivation this canary
 *  exists to prevent. The block-opener stop is the one place that direction is
 *  reversed, because there the over-match lands on a whole class of legitimate
 *  gates rather than on a single odd line. */
function statementFrom(lines: string[], lineIndex: number, interior?: boolean[]): string {
  let joined = lines[lineIndex];
  if (joined.includes(';') || BLOCK_OPENER_RE.test(joined)) return joined;
  let taken = 0;
  for (
    let j = lineIndex + 1;
    j < lines.length && j <= lineIndex + STATEMENT_SCAN_CAP && taken < STATEMENT_JOIN_CAP;
    j++
  ) {
    if (lines[j].trim() === '') break;
    if (isCommentLine(lines[j], interior?.[j])) continue;
    joined += '\n' + lines[j];
    taken++;
    if (lines[j].includes(';') || BLOCK_OPENER_RE.test(lines[j])) break;
  }
  return joined;
}

/** `occurrencesOf`, but the pattern is tested against the statement a line
 *  opens rather than the line. One wrapped violation can be reported at more
 *  than one of its own lines (each opens a statement that still contains the
 *  shape); they share a symbol key, and the site list names every line, which
 *  is the direction that helps whoever reads the bar. */
function statementOccurrences(
  files: ScannedSource[],
  pattern: RegExp,
): { keys: string[]; sites: string[] } {
  const keys = new Set<string>();
  const sites: string[] = [];
  for (const { rel, lines } of files) {
    const interior = blockCommentInterior(lines);
    lines.forEach((line, i) => {
      if (line.trim() === '' || isCommentLine(line, interior[i])) return;
      if (!pattern.test(statementFrom(lines, i, interior))) return;
      const symbol = enclosingSymbol(lines, i);
      keys.add(`${rel}#${symbol}`);
      sites.push(`${rel}:${i + 1} (${symbol}) — ${line.trim()}`);
    });
  }
  return { keys: [...keys].sort(), sites };
}

/** The shape refusal, factored so the wrapped-derivation probes run the same
 *  scan the whole tree does. The helper's own module is the one place the
 *  shapes are licensed. */
function inlineDerivations(files: ScannedSource[]): {
  ternaries: { keys: string[]; sites: string[] };
  copies: { keys: string[]; sites: string[] };
} {
  const outside = files.filter((file) => file.rel !== HELPER_MODULE);
  const properties = statementOccurrences(outside, COLUMN_COPY_RE);
  const destructures = statementOccurrences(outside, COLUMN_DESTRUCTURE_RE);
  return {
    ternaries: statementOccurrences(outside, EPOCH_TERNARY_RE),
    copies: {
      keys: [...new Set([...properties.keys, ...destructures.keys])].sort(),
      sites: [...properties.sites, ...destructures.sites],
    },
  };
}

const sources = sourcesUnder(path.resolve(__dirname, '..', '..', 'src'));

describe('one custody-claim derivation, and every row-reading mint uses it', () => {
  it('walks a plausible number of source files (guards against a broken walker)', () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.map((s) => s.rel)).toContain(HELPER_MODULE);
  });

  it('exactly the row-reading mints and the two settings handlers call the helper', () => {
    const { keys, sites } = occurrencesOf(
      sources,
      HELPER_CALL_RE,
      (line, _i, _lines, inside) => HELPER_DEFINITION_RE.test(line) || isCommentLine(line, inside),
    );
    expect(keys, `custodyClaimFor call sites:\n${sites.join('\n')}`).toEqual(
      [...ALLOWED_HELPER_CALL_SITES].sort(),
    );
  });

  it('no module outside the helper derives custody from the epoch or copies the column', () => {
    const { ternaries, copies } = inlineDerivations(sources);
    expect(
      ternaries.sites,
      'an inline `upgraded_at ? ... :` derivation is a second copy of the ' +
        `custody-claim rule; route it through custodyClaimFor:\n${ternaries.sites.join('\n')}`,
    ).toEqual([]);
    expect(
      copies.sites,
      'copying the custody column raw into a claim or binding is the ' +
        `shape that minted a stale light claim; use custodyClaimFor:\n${copies.sites.join('\n')}`,
    ).toEqual([]);
  });

  it('every session-JWT mint sources its custody claim from a licensed place', () => {
    const unclassified: string[] = [];
    const literalOutsideWriters: string[] = [];
    const variableOutsideHelperCallers: string[] = [];
    for (const { rel, lines } of sources) {
      const interior = blockCommentInterior(lines);
      lines.forEach((line, i) => {
        if (!JWT_MINT_RE.test(line) || isCommentLine(line, interior[i])) return;
        const key = `${rel}#${enclosingSymbol(lines, i)}`;
        const site = `${rel}:${i + 1} (${key})`;
        switch (classifyMint(lines, i)) {
          case 'literal':
            if (!ALLOWED_LITERAL_CLAIM_SITES.includes(key)) literalOutsideWriters.push(site);
            break;
          case 'variable':
            if (!ALLOWED_HELPER_CALL_SITES.includes(key) && !ALLOWED_CLAIM_CARRY_SITES.includes(key)) {
              variableOutsideHelperCallers.push(site);
            }
            break;
          case 'none':
            unclassified.push(site);
            break;
        }
      });
    }
    expect(
      unclassified,
      'a session JWT with no custody claim reads as self at the middleware, ' +
        `but the omission must be deliberate and this list must name it:\n${unclassified.join('\n')}`,
    ).toEqual([]);
    expect(
      literalOutsideWriters,
      'a literal custody claim is licensed only where the handler wrote the ' +
        `column in the same request; elsewhere derive it:\n${literalOutsideWriters.join('\n')}`,
    ).toEqual([]);
    expect(
      variableOutsideHelperCallers,
      'a mint that binds custody from a variable must be a helper caller (or ' +
        `the token refresh carrying a verified claim):\n${variableOutsideHelperCallers.join('\n')}`,
    ).toEqual([]);
  });

  it('the patterns fire on the old shapes and spare the current ones', () => {
    // Planted positives and negatives. Without them an edit that mangles a
    // pattern leaves every scan empty and the canary enforces nothing.
    expect(EPOCH_TERNARY_RE.test("const custody = account.upgraded_at ? 'self' : (account.custody || 'light');")).toBe(true);
    expect(EPOCH_TERNARY_RE.test("custody: row.upgraded_at ? 'self' : 'light',")).toBe(true);
    expect(EPOCH_TERNARY_RE.test("custody: row.upgraded_at !== null ? \"self\" : \"light\",")).toBe(true);
    expect(EPOCH_TERNARY_RE.test('if (account.upgraded_at) {')).toBe(false);
    expect(EPOCH_TERNARY_RE.test("if (row.upgraded_at != null) return 'self';")).toBe(false);
    expect(EPOCH_TERNARY_RE.test("const gate = row.upgraded_at ? 409 : 200;")).toBe(false);

    expect(COLUMN_COPY_RE.test('{ sub: account.username, custody: account.custody },')).toBe(true);
    expect(COLUMN_COPY_RE.test('const custody = row.custody;')).toBe(true);
    expect(COLUMN_COPY_RE.test('custody: rows[0].custody,')).toBe(true);
    expect(COLUMN_COPY_RE.test('const custody = custodyClaimFor(account);')).toBe(false);
    expect(COLUMN_COPY_RE.test("req.hiveCustody = payload.custody || 'self';")).toBe(false);
    expect(COLUMN_COPY_RE.test("{ name: 'Custody', value: short(row.custody), inline: true },")).toBe(false);
    expect(COLUMN_COPY_RE.test('const custody = req.hiveCustody;')).toBe(false);

    // The alternate spellings of the same column read. Each reaches
    // `row.custody` through something a dotted same-line pattern cannot see.
    expect(COLUMN_COPY_RE.test('const custody = account?.custody;')).toBe(true);
    expect(COLUMN_COPY_RE.test("const custody = account['custody'];")).toBe(true);
    expect(COLUMN_COPY_RE.test('const custody = account!.custody;')).toBe(true);
    expect(COLUMN_COPY_RE.test('const custody = (account as AccountRow).custody;')).toBe(true);
    expect(COLUMN_COPY_RE.test('const custody = (account as { custody: string }).custody;')).toBe(true);
    expect(COLUMN_COPY_RE.test('const custody = result.rows[0]!.custody;')).toBe(true);
    expect(COLUMN_COPY_RE.test('custody: rows[0]?.custody,')).toBe(true);
    expect(COLUMN_COPY_RE.test("custody: result.rows[0]?.['custody'],")).toBe(true);
    expect(COLUMN_COPY_RE.test('const custody = row.custody_source;')).toBe(false);
    // The accessor run must not cross a property boundary and pair one
    // object's key with the next one's column read. The
    // `logger.info({ custody: claim }, row.custody)` control is the shape that
    // shows the exclusion earning its keep: it is a single argument list, so
    // only the comma separates the key from the read. The `hasPassword`
    // control needs a quote and a colon admitted as well before it fires, and
    // the `custodyClaimFor(row)` and `custody = $1` controls carry no column
    // read for the pattern's tail to match, whatever the run admits.
    expect(COLUMN_COPY_RE.test("custody: 'self',\n  hasPassword: row.custody !== null,")).toBe(false);
    expect(COLUMN_COPY_RE.test('custody: custodyClaimFor(row),\n  pending: row.pending_email,')).toBe(false);
    expect(COLUMN_COPY_RE.test("custody = $1,\n  upgraded_at = $2,")).toBe(false);
    expect(COLUMN_COPY_RE.test('logger.info({ custody: claim }, row.custody);')).toBe(false);

    // The residual the whitelist buys that exclusion with: any character
    // outside the accessor alphabet ends the run, not commas alone, and
    // wherever it sits rather than only inside an argument list.
    expect(COLUMN_COPY_RE.test("const custody = helper('x').custody;")).toBe(false);
    expect(COLUMN_COPY_RE.test('const custody = rows[i + 1].custody;')).toBe(false);
    expect(COLUMN_COPY_RE.test('const custody = rows.map((r) => r)[0].custody;')).toBe(false);
    expect(COLUMN_COPY_RE.test('const custody = helper(row).custody;')).toBe(true);
    // An inline cast is bounded by POSITION, not member count: the run anchors
    // on the cast's own key, so any arity matches when `custody` is last.
    expect(COLUMN_COPY_RE.test('const custody = (row as { a: string; b: string; custody: string }).custody;')).toBe(true);
    expect(COLUMN_COPY_RE.test('const custody = (row as { a: string; custody: string; b: string }).custody;')).toBe(false);
    // The run restarts at each destination, so an excluded character earlier in
    // the line does not immunise a read that a nearer `custody:` can reach.
    expect(COLUMN_COPY_RE.test('foo(a, b); custody: row.custody')).toBe(true);

    expect(COLUMN_DESTRUCTURE_RE.test('const { custody } = rows[0];')).toBe(true);
    expect(COLUMN_DESTRUCTURE_RE.test('const { custody, upgraded_at } = account;')).toBe(true);
    expect(COLUMN_DESTRUCTURE_RE.test('const { rows } = await pool.query<{ custody: string | null }>(')).toBe(false);
    expect(COLUMN_DESTRUCTURE_RE.test('export function custodyClaimFor({ custody, upgraded_at }: CustodyRow) {')).toBe(false);

    // The statement join: a wrapped shape is one statement, a terminator ends
    // the run, a blank line does not let the join reach the next statement,
    // and a block opener keeps a refusal gate separate from its own body.
    expect(statementFrom(['const custody =', "  account.upgraded_at ? 'self' : 'light';"], 0)).toContain('upgraded_at');
    expect(statementFrom(['const custody = custodyClaimFor(account);', 'const other = row.custody;'], 0)).not.toContain('row.custody');
    expect(statementFrom(['sendOk(res, {', '', '  custody: row.custody,'], 0)).not.toContain('row.custody');
    expect(statementFrom(['if (account.upgraded_at) {', "  logger.warn({ custody: req.hiveCustody ?? 'self' });"], 0)).not.toContain('hiveCustody');

    expect(classifyMint(["const token = jwt.sign(", "  { sub: username, custody: 'self', reissuedAt: t },", "  secret,", ");"], 0)).toBe('literal');
    expect(classifyMint(['const token = jwt.sign(', '  { sub: account.username, custody },', '  secret,', ');'], 0)).toBe('variable');
    expect(classifyMint(['const token = jwt.sign(', '  { sub: account.username, custody, reissuedAt: t },', '  secret,', ');'], 0)).toBe('variable');
    expect(classifyMint(['const token = jwt.sign({ sub: username }, secret);'], 0)).toBe('none');
    // A property read is not a variable binding; the column-copy scan owns
    // that shape, and the classifier must not vouch for it as `variable`.
    expect(classifyMint(['const token = jwt.sign(', '  { sub: account.username, custody: account.custody },', '  secret,', ');'], 0)).toBe('none');
    // The payload walk stops at the call's own closing paren and never reads
    // into the next statement.
    expect(mintPayload(['jwt.sign(', '  { sub, custody },', '  secret,', ');', "const next = { custody: 'self' };"], 0)).not.toContain('next');
    // The payload walk is pinned to `STATEMENT_SCAN_CAP` itself rather than to
    // a count. The split-derivation probes pin the constant's VALUE; this pair
    // pins that `mintPayload` still reads the constant, so a literal re-inlined
    // in its loop bound goes red the moment the constant moves away from it. A
    // claim key exactly the cap's distance below the mint is still read, one
    // line further is not.
    const mintWithClaimAt = (linesBelow: number) => [
      'const token = jwt.sign(',
      ...Array.from({ length: linesBelow - 1 }, () => '  // a note inside the argument list'),
      '  { sub: account.username, custody },',
      '  secret,',
      ');',
    ];
    expect(classifyMint(mintWithClaimAt(STATEMENT_SCAN_CAP), 0)).toBe('variable');
    expect(classifyMint(mintWithClaimAt(STATEMENT_SCAN_CAP + 1), 0)).toBe('none');
  });

  it('a derivation wrapped, optional-chained, bracketed, or destructured is still refused', () => {
    // Planted probes for the respellings a line-scoped pattern does not see.
    // Each is a plausible new reader that mints no JWT and calls no helper, so
    // the shape refusal is the only scan that can name it; each ran green
    // against the tree before the statement join and the widened column read.
    // The probes go through `inlineDerivations`, the same call the whole-tree
    // scan makes, so a mangled pattern cannot leave them passing vacuously.
    const offenders = (lines: string[]) => {
      const synthetic: ScannedSource = { rel: 'routes/synthetic.ts', lines };
      const { ternaries, copies } = inlineDerivations([synthetic]);
      return [...ternaries.sites, ...copies.sites];
    };
    const reader = (...body: string[]) => [
      "router.get('/custody-status', async (req, res) => {",
      ...body,
      '  sendOk(res, { custody });',
      '});',
    ];

    expect(offenders(reader('  const custody =', '    account.upgraded_at', "      ? 'self'", "      : 'light';"))).not.toEqual([]);
    expect(offenders(reader('  const custody = account?.custody;'))).not.toEqual([]);
    expect(offenders(reader("  const custody = account['custody'];"))).not.toEqual([]);
    expect(offenders(reader('  const custody = account!.custody;'))).not.toEqual([]);
    expect(offenders(reader('  const custody = (account as { custody: string }).custody;'))).not.toEqual([]);
    expect(offenders(reader('  const { custody } = rows[0];'))).not.toEqual([]);
    // The accessor wrapped onto its own line, which is how a long row
    // expression under a short key is formatted.
    expect(
      offenders([
        "router.get('/custody-status', async (req, res) => {",
        '  sendOk(res, {',
        '    custody: accountRowFromTheLoginSelect',
        '      .custody,',
        '  });',
        '});',
      ]),
    ).not.toEqual([]);

    // The same wrapped derivation with prose between its halves. The join's cap
    // counts joined lines, so a note beside the branch it explains cannot spend
    // the budget the expression needs. Counting walked lines instead hid this
    // shape from every scan, not just from the line it starts on, because
    // neither half carries the whole pattern on its own.
    expect(
      offenders(
        reader(
          '  const custody = account.upgraded_at',
          '    // the epoch is the source of truth; a row seeded before the',
          '    // back-fill can still carry a stale column value, so branch on',
          '    // the epoch and never on the column, and keep the note beside',
          '    // the branch it explains rather than above the statement.',
          "      ? 'self'",
          "      : 'light';",
        ),
      ),
    ).not.toEqual([]);

    // A derivation split by prose has a far tail, and that is where the walk
    // cap cuts in. Counting joined lines leaves the walk itself unbounded, and
    // this tree carries comment runs long enough for an unbounded walk to
    // swallow the statement beyond one, so `STATEMENT_SCAN_CAP` stops it at the
    // price of a derivation split by that many comment lines. Both sides of the
    // boundary are pinned by count: the cap can be neither lowered, raised, nor
    // deleted without one of these going red, and a deliberate move takes the
    // docblock's stated cost with it.
    const splitBy = (commentLines: number) =>
      reader(
        '  const custody = account.upgraded_at',
        ...Array.from({ length: commentLines }, (_, i) => `    // note ${i + 1} beside the branch`),
        "      ? 'self'",
        "      : 'light';",
      );
    expect(offenders(splitBy(11))).not.toEqual([]);
    expect(offenders(splitBy(12))).toEqual([]);

    // Controls. The licensed shape, and a refusal gate that reads the epoch to
    // say no without deriving anything, must stay clean across the same join.
    // The gate's body carries a nullish default so the control pins the
    // block-opener stop rather than passing because no `?` was in reach.
    expect(offenders(reader('  const custody = custodyClaimFor(account);'))).toEqual([]);
    expect(
      offenders([
        "router.post('/broadcast', async (req, res) => {",
        '  if (account.upgraded_at) {',
        "    logger.warn({ custody: req.hiveCustody ?? 'self' });",
        "    return sendError(res, 409, 'ALREADY_UPGRADED', 'Account is self-custody');",
        '  }',
        '});',
      ]),
    ).toEqual([]);
  });

  it('the enclosing-symbol resolver names the handlers this canary pins', () => {
    const lines = [
      "router.post('/login', loginLimiter, async (req: Request, res: Response) => {",
      '  const custody = custodyClaimFor(account);',
      '});',
      '',
      'async function handleLogin(res: Response, orcidId: string): Promise<void> {',
      '  const custody = custodyClaimFor(account);',
      '}',
    ];
    expect(enclosingSymbol(lines, 1)).toBe('POST /login');
    expect(enclosingSymbol(lines, 5)).toBe('handleLogin');
    const synthetic: ScannedSource = { rel: 'routes/synthetic.ts', lines };
    expect(occurrencesOf([synthetic], HELPER_CALL_RE, skipCommentLine).keys).toEqual([
      'routes/synthetic.ts#POST /login',
      'routes/synthetic.ts#handleLogin',
    ]);

    // A star-leading live line: a wrapped operand naming the helper. The
    // shape-only reading dropped it as a docblock continuation before it was
    // counted; the block-comment region `occurrencesOf` computes per file is
    // what keeps it counted. The same text inside a docblock stays prose.
    const starLeadingLive: ScannedSource = {
      rel: 'routes/synthetic.ts',
      lines: [
        'function weightedClaim(account: AccountRow) {',
        '  return Number(account.active)',
        '    * custodyClaimFor(account).length;',
        '}',
      ],
    };
    expect(occurrencesOf([starLeadingLive], HELPER_CALL_RE, skipCommentLine).keys).toEqual([
      'routes/synthetic.ts#weightedClaim',
    ]);
    const proseContinuation: ScannedSource = {
      rel: 'routes/synthetic.ts',
      lines: ['/**', ' * custodyClaimFor(account) is the one licensed derivation.', ' */'],
    };
    expect(occurrencesOf([proseContinuation], HELPER_CALL_RE, skipCommentLine).keys).toEqual([]);
  });
});

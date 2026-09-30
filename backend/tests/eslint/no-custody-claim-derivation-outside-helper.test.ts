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
 *      them needs taint analysis, not a textual scan. At a site that MINTS
 *      and holds no licence of its own, the claim-source classification
 *      refuses them anyway: the claim binds from a variable at a symbol that
 *      is neither a row-reading mint nor the token refresh. Inside a symbol
 *      that IS one of those, the one variable claim it is licensed for is
 *      licensed whatever it was bound from, so the classification says nothing
 *      about where the binding came from there. The residual is therefore a
 *      reader that mints nothing, and a licensed symbol that derives through
 *      one of these shapes beside its helper call. The statement join has
 *      stated bounds of
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
 *      The mints are TALLIED per symbol rather than tested for membership: a
 *      list entry licenses one mint, so a second mint inside a symbol that
 *      already holds one is a red bar naming that symbol, and each of the
 *      three mint lists is held equal to what the scan observed, so an entry
 *      nothing mints under is as red as a mint nothing licenses.
 *
 *      What the classification reads is the TEXT of the lines the call spans,
 *      not the payload object. A `custody` key followed by a quoted `self` or
 *      `light` anywhere on those lines reads as a literal claim, and failing
 *      that a bare `custody` ahead of a comma or a closing brace reads as a
 *      variable one: in the options argument, a nested object or a trailing
 *      comment as readily as in the claim. It does not check WHICH literal a
 *      writer mints against the value that handler wrote.
 *
 *      A licence is keyed on `file#symbol` as the enclosing-symbol resolver
 *      names it, so two declarations that resolve to one name in one file
 *      share a key: a second registration of the same method and path, or a
 *      nested function named like a licensed one. A mint that leaves its
 *      handler for such a twin keeps the tally at one and is not seen to move.
 *
 * What every scan in this file covers is the `.ts` files under `backend/src`,
 * which is what `sourcesUnder` walks from the one root it is handed here.
 * Content under `backend/scripts/`, a module with any other extension, and
 * build output are outside all three scans: a derivation or a mint written
 * there is not seen.
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

/** The prose-only skip this file's forbidden-shape scans hand to
 *  `occurrencesOf`: comment by
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
 *  same pair of columns. `ROW_READING_MINT_SITES` names the four. */
const ALLOWED_HELPER_CALL_SITES = [
  'routes/auth.ts#POST /login',
  'routes/orcid.ts#handleLogin',
  'routes/recover.ts#POST /recover',
  'routes/recover.ts#POST /recover/verify',
  'routes/settings.ts#DELETE /email',
  'routes/settings.ts#GET /email',
];

/** The helper callers that also mint, each binding the helper's result as the
 *  claim. Listed apart from the caller set because calling the helper is not a
 *  licence to mint: the settings handlers call it and issue no session. An
 *  entry here that is not also a helper caller licenses nothing, since a
 *  variable mint outside the caller set is counted against the token refresh's
 *  list instead. */
const ROW_READING_MINT_SITES = [
  'routes/auth.ts#POST /login',
  'routes/orcid.ts#handleLogin',
  'routes/recover.ts#POST /recover',
  'routes/recover.ts#POST /recover/verify',
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

/** A session-JWT mint. Same anchor the session-issuing registry uses.
 *
 *  It names the call as this codebase spells it: a receiver named `jwt`, the
 *  member `sign`, an open paren. What `jwt` is bound to is not checked, so
 *  `this.jwt.sign(` matches too. A mint spelled any other way is not a match
 *  and is classified by nothing: a named or renamed import
 *  (`sign(...)`, `jsonwebtoken.sign(...)`), a bracketed member
 *  (`jwt['sign'](...)`), an optional chain (`jwt?.sign(...)`), a member
 *  wrapped onto its own line, and the function taken as a value and called
 *  later (`const mint = jwt.sign`). Those are examples, not the whole class. */
const JWT_MINT_RE = /\bjwt\.sign\s*\(/;

/** Where each mint on a line opens. The scan and the planted spelling probes
 *  both read the pattern through this, so what the probes pin is what the scan
 *  matches with, flags included. */
function mintColumns(line: string): number[] {
  return [...line.matchAll(new RegExp(JWT_MINT_RE.source, 'g'))].map((match) => match.index);
}

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
 *  joined, so stepping over prose costs nothing there. It is what stops a line
 *  with no terminator of its own from gathering a long multi-line literal or
 *  call into one statement, where an `upgraded_at` near the top and an
 *  unrelated conditional yielding `'self'` or `'light'` several members
 *  further down would read as one derivation.
 *  What it costs is a derivation whose epoch read and yielding branch sit more
 *  than four joined lines apart: that one escapes. The boundary is pinned in
 *  both directions by the joined-count probes, so moving the cap means moving
 *  those counts and the four stated here with it. */
const STATEMENT_JOIN_CAP = 4;
const STATEMENT_SCAN_CAP = 12;

/** The payload of a mint: the mint line plus the following lines up to the
 *  one carrying the closing `)` of the mint's own call, capped by
 *  `STATEMENT_SCAN_CAP` so a runaway scan cannot swallow the next handler.
 *
 *  Parens are counted from the mint itself, not from the start of its line,
 *  and the walk ends on the line where the count first returns to zero AFTER a
 *  paren was opened. Both halves matter. Ending on "zero, and not the mint
 *  line" instead walked one line past a mint that opens and closes on its own
 *  line, and read the next statement's custody key as the mint's claim.
 *  Counting from the line start lets a paren closed ahead of the mint
 *  (`) ? jwt.sign(`) cancel the mint's own opener. Whole lines are returned
 *  either way, so text sharing a line with the mint is part of the payload.
 *  `column` says which mint on the line to count from, for a line carrying
 *  more than one; left out, it is the first. */
function mintPayload(lines: string[], lineIndex: number, column?: number): string {
  let depth = 0;
  let opened = false;
  let out = '';
  walk: for (let j = lineIndex; j < lines.length && j <= lineIndex + STATEMENT_SCAN_CAP; j++) {
    const line = lines[j];
    out += line + '\n';
    const from = j === lineIndex ? (column ?? Math.max(line.search(JWT_MINT_RE), 0)) : 0;
    for (const ch of line.slice(from)) {
      if (ch === '(') {
        depth++;
        opened = true;
      } else if (ch === ')') depth--;
      if (opened && depth <= 0) break walk;
    }
  }
  return out;
}

type ClaimSource = 'literal' | 'variable' | 'none';

function classifyMint(lines: string[], lineIndex: number, column?: number): ClaimSource {
  const payload = mintPayload(lines, lineIndex, column);
  if (LITERAL_CLAIM_RE.test(payload)) return 'literal';
  if (VARIABLE_CLAIM_RE.test(payload)) return 'variable';
  return 'none';
}

/** One session-JWT mint: the symbol it sits in, where, and how its claim is
 *  sourced. */
interface Mint {
  key: string;
  site: string;
  source: ClaimSource;
}

/** Every mint in `files`, classified. Factored so the planted probes run the
 *  scan the whole tree does, and returned as a LIST rather than a key set so
 *  two mints inside one symbol stay two entries. One entry per MATCH, not per
 *  matching line, so two mints sharing a line are two entries as well. */
function sessionMints(files: ScannedSource[]): Mint[] {
  const mints: Mint[] = [];
  for (const { rel, lines } of files) {
    const interior = blockCommentInterior(lines);
    lines.forEach((line, i) => {
      if (isCommentLine(line, interior[i])) return;
      for (const column of mintColumns(line)) {
        const key = `${rel}#${enclosingSymbol(lines, i)}`;
        mints.push({ key, site: `${rel}:${i + 1} (${key})`, source: classifyMint(lines, i, column) });
      }
    });
  }
  return mints;
}

/** Occurrences per key. The mint test compares the tally of the mints observed
 *  against the tally of the list that licenses them, so each list ENTRY is a
 *  licence for one mint: a symbol missing from the observed side is a stale
 *  entry, a symbol the list does not name is an unlicensed mint, and a count
 *  of two against one entry is a second mint inside a symbol that already
 *  holds a licence, which a membership test cannot tell from one. Counting the
 *  list the same way keeps a duplicated entry from being folded away: it reads
 *  as a second licence, and is red until a second mint exists. */
function tally(keys: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}
const keysOf = (mints: Mint[]): string[] => mints.map((mint) => mint.key);

/** The mints split the way the licences are: no claim at all, a literal, a
 *  variable at a helper caller, and a variable anywhere else, which only the
 *  token refresh may be. */
function classifiedMints(files: ScannedSource[]): {
  all: Mint[];
  unclassified: Mint[];
  literal: Mint[];
  atHelperCallers: Mint[];
  carried: Mint[];
} {
  const all = sessionMints(files);
  const variable = all.filter((mint) => mint.source === 'variable');
  const isHelperCaller = (mint: Mint) => ALLOWED_HELPER_CALL_SITES.includes(mint.key);
  return {
    all,
    unclassified: all.filter((mint) => mint.source === 'none'),
    literal: all.filter((mint) => mint.source === 'literal'),
    atHelperCallers: variable.filter(isHelperCaller),
    carried: variable.filter((mint) => !isHelperCaller(mint)),
  };
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
    const { all, unclassified, literal, atHelperCallers, carried } = classifiedMints(sources);
    const sitesOf = (mints: Mint[]) => mints.map((mint) => mint.site).join('\n');
    // An empty mint list satisfies "no unclassified mint" as well as a clean
    // tree does, so the scan must be seen to find mints before its silence
    // about them means anything.
    expect(all.length, 'the mint scan found no session-JWT mint at all').toBeGreaterThan(0);
    expect(
      unclassified.map((mint) => mint.site),
      'a session JWT with no custody claim reads as self at the middleware; ' +
        'each of these mints either omits the claim or writes it in a shape ' +
        `the classifier does not read (a bare binding or a quoted literal):\n${sitesOf(unclassified)}`,
    ).toEqual([]);
    expect(
      tally(keysOf(literal)),
      'a literal custody claim is licensed only where the handler wrote the ' +
        'column in the same request, once per entry; elsewhere derive it, ' +
        `and drop an entry no mint uses:\n${sitesOf(literal)}`,
    ).toEqual(tally(ALLOWED_LITERAL_CLAIM_SITES));
    expect(
      tally(keysOf(carried)),
      'a mint that binds custody from a variable must be a helper caller; the ' +
        'one exception is the token refresh carrying a verified claim, once, ' +
        `and an entry no mint uses is dropped:\n${sitesOf(carried)}`,
    ).toEqual(tally(ALLOWED_CLAIM_CARRY_SITES));
    expect(
      tally(keysOf(atHelperCallers)),
      'a helper caller mints only where this list says a row-reading mint ' +
        'is, once per entry; a second mint in one symbol, or a first in a ' +
        'caller that issued no session, is not licensed, and an entry no ' +
        `mint uses is dropped:\n${sitesOf(atHelperCallers)}`,
    ).toEqual(tally(ROW_READING_MINT_SITES));
  });

  it('the mint scan finds mints, tallies them per symbol, and walks only the call', () => {
    // `JWT_MINT_RE` through `mintColumns`, the one reader the scan has, then
    // through the scan itself. Prose that
    // merely names the mint has no open paren and does not match; prose that
    // quotes the call shape does, and is spared by the comment skip instead.
    const seesMint = (line: string) => mintColumns(line).length > 0;
    expect(seesMint('    const token = jwt.sign(')).toBe(true);
    expect(mintColumns('  const a = jwt.sign(x, s), b = jwt.sign(y, s);')).toEqual([12, 32]);
    expect(seesMint('    const token = this.jwt.sign(payload, secret);')).toBe(true);
    expect(seesMint('    const token = jwt.signAsync(payload, secret);')).toBe(false);
    expect(seesMint('    const token = jwt .sign(payload, secret);')).toBe(false);
    expect(seesMint('    const token = jwt.sign (')).toBe(true);
    expect(seesMint('    const token = jwt.sign\t  (')).toBe(true);
    expect(seesMint('    const token = jwtXsign(payload, secret);')).toBe(false);
    expect(seesMint('    const token = JWT.sign(payload, secret);')).toBe(false);
    expect(seesMint('  // invariant: no jwt.sign call mints before the INSERT')).toBe(false);
    expect(seesMint('  // a second jwt.sign(...) here needs its own response assertion')).toBe(true);
    expect(seesMint('    const token = jwt.verify(raw, secret);')).toBe(false);
    expect(seesMint('    const token = myjwt.sign(payload, secret);')).toBe(false);
    // Each spelling the `JWT_MINT_RE` docblock names as unseen, pinned so
    // that sentence cannot outlive a change to the pattern. The wrapped member
    // is two lines, and neither is a match.
    expect(seesMint('    const token = sign(payload, secret);')).toBe(false);
    expect(seesMint('    const token = jsonwebtoken.sign(payload, secret);')).toBe(false);
    expect(seesMint("    const token = jwt['sign'](payload, secret);")).toBe(false);
    expect(seesMint('    const token = jwt?.sign(payload, secret);')).toBe(false);
    expect(seesMint('    const token = jwt')).toBe(false);
    expect(seesMint('      .sign(payload, secret);')).toBe(false);
    expect(seesMint('    const mint = jwt.sign;')).toBe(false);

    const handler = (route: string, ...body: string[]) => [
      `router.post('${route}', async (req, res) => {`,
      ...body,
      '});',
    ];
    const mintWith = (claim: string) => ['  const token = jwt.sign(', `    { sub: username, ${claim} },`, '    secret,', '  );'];
    const scan = (...lines: string[]) => classifiedMints([{ rel: 'routes/synthetic.ts', lines }]);
    const keyed = (route: string) => `routes/synthetic.ts#POST ${route}`;

    // One mint per claim source, each landing in its own bucket under the
    // symbol that holds it, and a quoted call in a comment counted nowhere.
    const mixed = scan(
      ...handler('/writes', ...mintWith("custody: 'self'")),
      ...handler('/carries', '  // a second jwt.sign(...) here needs its own licence', ...mintWith('custody')),
      ...handler('/omits', ...mintWith('iat: now')),
    );
    expect(mixed.all.map((mint) => [mint.key, mint.source])).toEqual([
      [keyed('/writes'), 'literal'],
      [keyed('/carries'), 'variable'],
      [keyed('/omits'), 'none'],
    ]);
    expect(mixed.all.map((mint) => mint.site)).toEqual([
      `routes/synthetic.ts:2 (${keyed('/writes')})`, // anchor-allow: a planted site label the scan emits
      `routes/synthetic.ts:9 (${keyed('/carries')})`, // anchor-allow: a planted site label the scan emits
      `routes/synthetic.ts:15 (${keyed('/omits')})`, // anchor-allow: a planted site label the scan emits
    ]);
    expect(tally(keysOf(mixed.literal))).toEqual({ [keyed('/writes')]: 1 });
    expect(tally(keysOf(mixed.carried))).toEqual({ [keyed('/carries')]: 1 });
    expect(mixed.unclassified.map((mint) => mint.key)).toEqual([keyed('/omits')]);
    expect(mixed.atHelperCallers).toEqual([]);

    // A star-leading line is prose inside a docblock and live code outside
    // one: a mint wrapped under a multiplication is counted, which the
    // block-comment region the scan computes per file is what decides.
    expect(scan('/**', ' * jwt.sign({ sub: username, custody }, secret) is the carried shape.', ' */').all).toEqual([]);
    expect(
      scan(...handler('/carries', '  const weight = Number(account.active)', '    * jwt.sign({ sub: username, custody }, secret).length;')).all.map(
        (mint) => [mint.key, mint.source],
      ),
    ).toEqual([[keyed('/carries'), 'variable']]);

    // A second mint inside one symbol is a count of two under that symbol's
    // name, not a second member a set would fold away, and one licence for
    // that symbol does not equal it. A list naming the symbol twice does: a
    // duplicated entry is a second licence, never a folded first.
    const twice = scan(...handler('/writes', ...mintWith("custody: 'self'"), ...mintWith("custody: 'light'")));
    expect(tally(keysOf(twice.literal))).toEqual({ [keyed('/writes')]: 2 });
    expect(tally(keysOf(twice.literal))).not.toEqual(tally([keyed('/writes')]));
    expect(tally(keysOf(twice.literal))).toEqual(tally([keyed('/writes'), keyed('/writes')]));
    // Two mints sharing a line are two entries. Both read the whole line, so
    // on one line they classify alike; where the second wraps, the first ends
    // at its own close and only the second reaches the wrapped claim.
    const sameLine = scan(
      ...handler('/writes', "  const a = jwt.sign({ sub: username }, secret), b = jwt.sign({ sub: username, custody: 'self' }, secret);"),
    );
    expect(sameLine.all.map((mint) => mint.source)).toEqual(['literal', 'literal']);
    expect(classifyMint(["  const a = jwt.sign({ sub: username, custody: 'self' }, secret), b = jwt.sign(", '    { sub: username, custody },', '  );'], 0)).toBe('literal');
    const secondOpens = ["  const a = jwt.sign({ sub: username }, secret), b = jwt.sign(", '    { sub: username, custody },', '  );'];
    expect(classifyMint(secondOpens, 0)).toBe('none');
    expect(classifyMint(secondOpens, 0, secondOpens[0].lastIndexOf('jwt.sign'))).toBe('variable');
    expect(scan(...handler('/carries', ...secondOpens)).all.map((mint) => mint.source)).toEqual(['none', 'variable']);

    // A variable mint is split on whether its symbol is a helper caller, and
    // two of them inside one helper caller are a tally of two that the tally
    // of the row-reading mint list, which names that symbol once, refuses.
    const loginKey = 'routes/auth.ts#POST /login';
    const atCaller = classifiedMints([
      { rel: 'routes/auth.ts', lines: handler('/login', ...mintWith('custody'), ...mintWith('custody')) },
    ]);
    expect(atCaller.carried).toEqual([]);
    expect(tally(keysOf(atCaller.atHelperCallers))).toEqual({ [loginKey]: 2 });
    expect(tally(ROW_READING_MINT_SITES)[loginKey]).toBe(1);
    // A helper caller that issues no session is still a helper caller: a first
    // mint there lands in the same bucket, under a key the mint list lacks.
    const settingsKey = 'routes/settings.ts#GET /email';
    const atSettings = classifiedMints([
      { rel: 'routes/settings.ts', lines: ["router.get('/email', async (req, res) => {", ...mintWith('custody'), '});'] },
    ]);
    expect(tally(keysOf(atSettings.atHelperCallers))).toEqual({ [settingsKey]: 1 });
    expect(tally(ROW_READING_MINT_SITES)[settingsKey]).toBeUndefined();

    // A literal or a claimless mint at a helper caller is still a literal or a
    // claimless mint: being a caller moves only the variable ones.
    const literalAtCaller = classifiedMints([{ rel: 'routes/auth.ts', lines: handler('/login', ...mintWith("custody: 'light'")) }]);
    expect(tally(keysOf(literalAtCaller.literal))).toEqual({ [loginKey]: 1 });
    const claimlessAtCaller = classifiedMints([{ rel: 'routes/auth.ts', lines: handler('/login', ...mintWith('iat: now')) }]);
    expect(keysOf(claimlessAtCaller.unclassified)).toEqual([loginKey]);
    // The caller test is on the whole key, not a prefix of it.
    const nearCaller = classifiedMints([{ rel: 'routes/auth.ts', lines: handler('/log', ...mintWith('custody')) }]);
    expect(tally(keysOf(nearCaller.carried))).toEqual({ 'routes/auth.ts#POST /log': 1 });
    // The scan is not confined to route modules, and a mint on the line that
    // opens its handler is keyed to that handler.
    expect(keysOf(classifiedMints([{ rel: 'lib/session.ts', lines: ['export function mintSession(sub: string) {', '  return jwt.sign({ sub }, secret);', '}'] }]).unclassified)).toEqual(['lib/session.ts#mintSession']);
    expect(
      keysOf(scan(...handler('/writes', '  sendOk(res, {});'), "router.post('/inline', async (req, res) => res.json(jwt.sign({ sub: username, custody }, secret)));").all),
    ).toEqual([keyed('/inline')]);
    expect(tally(['a', 'a', 'a', 'b'])).toEqual({ a: 3, b: 1 });

    // A literal claim outranks a variable one when the call's lines carry both.
    expect(classifyMint(['const token = jwt.sign(', "  { sub: username, custody: 'self', meta: { custody } },", '  secret,', ');'], 0)).toBe('literal');

    // The payload walk starts ON the mint line: a claim written there is read,
    // and a custody key on the line before the mint is not.
    expect(classifyMint(["const token = jwt.sign({ sub: username, custody: 'self' }, secret);"], 0)).toBe('literal');
    expect(classifyMint(["const prior = { custody: 'self' };", 'const token = jwt.sign({ sub: username }, secret);'], 1)).toBe('none');
    // It ends on the line that closes the call. A mint that opens and closes
    // on its own line is followed by another statement, whose custody key is
    // not the mint's claim in either spelling.
    expect(classifyMint(['const token = jwt.sign({ sub: username }, secret);', "const next = { custody: 'self' };"], 0)).toBe('none');
    expect(classifyMint(['const token = jwt.sign({ sub: username }, secret);', 'sendOk(res, { token, custody });'], 0)).toBe('none');
    expect(mintPayload(['const token = jwt.sign({ sub: username }, secret);', 'sendOk(res, { token, custody });'], 0)).toBe(
      'const token = jwt.sign({ sub: username }, secret);\n',
    );
    // The same end of walk on the path the tree scan takes, where the mint's
    // column is handed in: the offset applies to the mint line alone, so the
    // closing paren of a wrapped call is counted although it sits left of it.
    expect(
      scan(...handler('/omits', ...mintWith('iat: now'), '  sendOk(res, { token, custody });')).all.map((mint) => mint.source),
    ).toEqual(['none']);
    // Parens are counted from the mint, so one closed ahead of it on the same
    // line does not cancel the mint's own opener, and the call's closing paren
    // ends the walk even when the line goes on to open another.
    expect(classifyMint(['  const token = ready(account) ? jwt.sign(', '    { sub: username, custody },', '    secret,', '  ) : null;'], 0)).toBe('variable');
    expect(classifyMint(['  ) ? jwt.sign(', '    { sub: username, custody },', '    secret,', '  ) : null;'], 0)).toBe('variable');
    expect(classifyMint(['const token = jwt.sign({ sub: username }, secret); audit(', "  { custody: 'self' },", ');'], 0)).toBe('none');
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
    // The same pair through the scan, which hands the walk a column.
    const scanned = (linesBelow: number) =>
      sessionMints([{ rel: 'routes/synthetic.ts', lines: mintWithClaimAt(linesBelow) }]).map((mint) => mint.source);
    expect(scanned(STATEMENT_SCAN_CAP)).toEqual(['variable']);
    expect(scanned(STATEMENT_SCAN_CAP + 1)).toEqual(['none']);
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

    // The joined-count cap has a boundary of its own, reached with no prose at
    // all: the epoch read on the opening line and the yielding branch a number
    // of joined lines further down, wrapped operands in between. Only the
    // opening line carries `upgraded_at`, so whether the shape is reported
    // turns on how many lines `statementFrom` joins from there, which is
    // `STATEMENT_JOIN_CAP`. Pinned by count like the split-derivation pair: the
    // branch as the fourth joined line is caught, as the fifth it is missed.
    const branchAtJoinedLine = (joinedLine: number) =>
      reader(
        '  const custody = account.upgraded_at',
        ...Array.from({ length: joinedLine - 1 }, (_, i) => `    && account.condition${i + 1}`),
        "      ? 'self'",
        "      : 'light';",
      );
    expect(offenders(branchAtJoinedLine(4))).not.toEqual([]);
    expect(offenders(branchAtJoinedLine(5))).toEqual([]);

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

/**
 * Unit suite for `enclosing-symbol.ts`, the scan machinery every
 * source-discipline canary in `tests/eslint/` (and the revocation-column scan
 * in `tests/routes/session-proof-invalidation.test.ts`) stands on.
 *
 * PLACEMENT. The suite lives beside the machinery: the vitest include glob
 * collects any `tests/**` test file with no config change, and each canary
 * file keeps its own domain assertions and the planted evasion cases that run
 * through its scans. The comment predicate, the brace walk and the region
 * pass are exercised here on synthetic sources, one probe per decision point.
 * `sourcesUnder` is not: it reads a directory rather than a source string,
 * and the floor it gives a canary is a claim about that canary's own scanned
 * tree, so its probe stays beside the assertions that rest on it.
 *
 * WHY ONE PROBE PER DECISION POINT. Every whole-tree assertion a canary makes
 * is over keys this module resolves, so a branch that answers wrongly in a
 * direction a licensed key can absorb weakens every canary at once while each
 * of them stays green. The probes here are discriminators: each is chosen so
 * that mangling one branch of the machinery reddens that probe, and a
 * composite probe (one that goes red when a whole mechanism is deleted) is
 * never the only cover a branch has. The parity inversions the module
 * documents and declines to close are pinned as the residuals they are, so
 * the day one of them moves is a red bar rather than a silent change.
 *
 * The fixtures are the shapes `backend/src` actually writes: a wrapped SQL
 * multiplication (`* CASE WHEN ...` inside a reputation query literal) and a
 * markdown bold run (`**Authors:** ...` inside a bridge post-body literal)
 * are the star-leading LIVE lines the region-aware predicate exists to keep
 * scannable, and a docblock continuation is the star-leading PROSE line it
 * must keep skipping.
 */
import { describe, it, expect } from 'vitest';
import {
  MODULE_SCOPE,
  blockCommentInterior,
  enclosingSymbol,
  isCommentLine,
  isCommentedOut,
  occurrencesOf,
  skipCommentLine,
  skipCommentOr,
} from './enclosing-symbol.js';

/** A stand-in for a canary's forbidden-shape pattern: the discounted-citation
 *  factor read whose real spelling sits star-leading in the reputation SQL.
 *  Any token would do for the machinery; this one keeps the fixtures readable
 *  as the corpus shape the region argument was added for. */
const FACTOR_READ_RE = /\bself_citation_discount\b/;

describe('enclosing-symbol: the comment predicate, the brace walk and the region pass', () => {
  it('the comment predicate skips whole-line prose only, never live code behind an inline block comment', () => {
    // Whole-line prose in every shape it takes: skipped.
    expect(isCommentLine('// the sweep pairs with every writer of the column')).toBe(true);
    expect(isCommentLine('  * the epoch travels on req.hiveSessionsInvalidatedAt')).toBe(true);
    expect(isCommentLine('  */')).toBe(true);
    expect(isCommentLine('/* the licensed call sits in the handler */')).toBe(true);
    expect(isCommentLine('  /* an opener whose comment runs on')).toBe(true);
    expect(isCommentLine('/* one */ /* two */')).toBe(true);
    expect(isCommentLine('/* one */ // and trailing prose')).toBe(true);
    // Live code behind a leading block comment is NOT prose. Skipping it
    // would let a coverage pragma hide a forbidden call from the scan.
    expect(isCommentLine('/* v8 ignore next */ const token = jwt.sign(payload, secret);')).toBe(false);
    expect(isCommentLine('  /* istanbul ignore next */ await pool.query(sql);')).toBe(false);
    expect(isCommentLine('/* one */ /* two */ return custodyClaimFor(account);')).toBe(false);
    // The CLOSING side of the same rule. A close begins with the same star a
    // docblock continuation does, so an arm answering on the prefix alone
    // would claim the line and skip the live code riding behind the close.
    expect(isCommentLine('*/ return custodyClaimFor(account);')).toBe(false);
    expect(isCommentLine('  */ const token = jwt.sign(payload, secret);')).toBe(false);
    expect(isCommentLine(' * trailing prose */ await pool.query(sql);')).toBe(false);
    // A bare close, and a close followed by nothing but further comment, stay
    // prose in both arms.
    expect(isCommentLine('*/')).toBe(true);
    expect(isCommentLine('  */ // and trailing prose')).toBe(true);
    expect(isCommentLine('  */ /* two */')).toBe(true);
    expect(isCommentLine('const token = jwt.sign(payload, secret); // trailing prose')).toBe(false);
    expect(isCommentLine('')).toBe(false);

    // A leading star is a docblock continuation AND a wrapped multiplication
    // AND a markdown bold run, and one line cannot tell them apart. Outside
    // an open comment region the line is live code, so the predicate needs
    // the region to answer. Passed explicitly here; the scans compute it per
    // file. These first two are the live corpus shapes verbatim.
    expect(
      isCommentLine(
        '            * CASE WHEN cpq.is_self THEN w.self_citation_discount ELSE w.citation END',
        false,
      ),
    ).toBe(false);
    expect(isCommentLine('**Authors:** ${authorList}', false)).toBe(false);
    expect(isCommentLine('*This paper was originally published on ${meta.source_name}.*', false)).toBe(false);
    // A trailing comment on a live star line changes nothing at a region
    // known closed: nothing is open for the line to continue, so it is live
    // whatever follows it, and the close search is not consulted.
    expect(isCommentLine('  * CASE WHEN cpq.is_self THEN 0 ELSE 1 END /* short */', false)).toBe(false);
    expect(isCommentLine('  * CASE WHEN cpq.is_self THEN 0 ELSE 1 END // w', false)).toBe(false);
    // An opener at a region known closed is left to the search: the
    // known-closed reading is about a star that could have been a
    // continuation, and an opener never was one.
    expect(isCommentLine('/* the licensed call sits in the handler */', false)).toBe(true);
    expect(isCommentLine('/* v8 ignore next */ const token = jwt.sign(payload, secret);', false)).toBe(false);
    // An opener whose comment runs on past the line reaches the no-close
    // branch instead, which answers prose for every prefix that gets there.
    expect(isCommentLine('  /* an opener whose comment runs on', false)).toBe(true);
    // The close search starts past the opener's own two characters, so a
    // line whose first three characters are an opener plus a slash is an
    // opener, not a self-closing comment with live code behind it. This pins
    // the offset the predicate documents as its close-search residual.
    expect(isCommentLine('/*/ an opener followed by a slash, still prose')).toBe(true);
    expect(isCommentLine('/*/ an opener followed by a slash, still prose', false)).toBe(true);
    // A close-leading line is the one star shape the known-closed reading
    // leaves to the search: it ends a comment whatever the region pass
    // believes, and is answered by what follows its close.
    expect(isCommentLine('  */ // prose after a close', false)).toBe(true);
    expect(isCommentLine('  */ return custodyClaimFor(account);', false)).toBe(false);
    // Inside a region, the same star shape is the docblock continuation it
    // looks like.
    expect(isCommentLine('  * the epoch travels on req.hiveSessionsInvalidatedAt', true)).toBe(true);
    expect(
      isCommentLine(
        '            * CASE WHEN cpq.is_self THEN w.self_citation_discount ELSE w.citation END',
        true,
      ),
    ).toBe(true);
    // With no region known, the shape reading stands, which is what a caller
    // with no file in hand (a planted single-line pin, the import-clause
    // walk) relies on.
    expect(isCommentLine('  * the epoch travels on req.hiveSessionsInvalidatedAt')).toBe(true);
    expect(isCommentLine('  * CASE WHEN cpq.is_self THEN 0 ELSE 1 END /* short */')).toBe(true);
    expect(isCommentLine('  * CASE WHEN cpq.is_self THEN 0 ELSE 1 END /* short */', true)).toBe(true);
    // A close ends the region wherever it sits, so what follows is live even
    // when it is itself star-shaped.
    expect(isCommentLine('*/ * CASE WHEN cpq.is_self THEN 0 ELSE 1 END', true)).toBe(false);
    // The third prefix. Inside an open region two slashes are comment text
    // like any other, so a line that begins with them can end the region and
    // carry a live read behind the close, exactly as the star-prefixed form
    // can.
    expect(isCommentLine('  // legacy note */ return custodyClaimFor(account);', true)).toBe(false);
    expect(isCommentLine('// note */', true)).toBe(true);
    expect(isCommentLine('// note */ // more', true)).toBe(true);
    expect(isCommentLine('// note with no close', true)).toBe(true);
    // Outside a region, and with no region known, the same line is a line
    // comment on its shape: nothing was open for the close to end.
    expect(isCommentLine('  // legacy note */ return custodyClaimFor(account);', false)).toBe(true);
    expect(isCommentLine('  // legacy note */ return custodyClaimFor(account);')).toBe(true);

    // The no-region reading is not the pure shape test: code behind a close
    // is live to it. The satisfying-side predicate keeps the shape test, so a
    // call riding behind a close never vouches for a demand.
    expect(isCommentLine('/* call */ invalidateSessionFreshAuthTokens(u);')).toBe(false);
    expect(isCommentLine(' * prose call */ invalidateSessionFreshAuthTokens(u);')).toBe(false);
    expect(isCommentedOut('/* call */ invalidateSessionFreshAuthTokens(u);', 0, [])).toBe(true);
    expect(
      isCommentedOut(' * prose call */ invalidateSessionFreshAuthTokens(u);', 0, []),
    ).toBe(true);
    expect(isCommentedOut('// invalidateSessionFreshAuthTokens(u);', 0, [])).toBe(true);
    expect(isCommentedOut('  invalidateSessionFreshAuthTokens(u);', 0, [])).toBe(false);
  });

  it('the exported skips read the region, and the combinator adds a definition line', () => {
    // The one region-aware skip every forbidden-shape and demand-side scan
    // takes. A star-leading live line is counted; a docblock continuation
    // quoting the same token is spared.
    const starLeadingLive = [
      'function weightedClaim(account: AccountRow) {',
      '  return Number(account.active)',
      '    * custodyClaimFor(account).length;',
      '}',
    ];
    const proseContinuation = [
      '/**',
      ' * custodyClaimFor(account) is the one licensed derivation.',
      ' */',
    ];
    const CALL_RE = /\bcustodyClaimFor\s*\(/;
    expect(
      occurrencesOf([{ rel: 'lib/synthetic.ts', lines: starLeadingLive }], CALL_RE, skipCommentLine)
        .keys,
    ).toEqual(['lib/synthetic.ts#weightedClaim']);
    expect(
      occurrencesOf([{ rel: 'lib/synthetic.ts', lines: proseContinuation }], CALL_RE, skipCommentLine)
        .keys,
    ).toEqual([]);

    // The combinator: the same two readings, plus the definition line.
    const skipDefinition = skipCommentOr(/function\s+custodyClaimFor\s*\(/);
    expect(
      occurrencesOf([{ rel: 'lib/synthetic.ts', lines: starLeadingLive }], CALL_RE, skipDefinition)
        .keys,
    ).toEqual(['lib/synthetic.ts#weightedClaim']);
    expect(
      occurrencesOf([{ rel: 'lib/synthetic.ts', lines: proseContinuation }], CALL_RE, skipDefinition)
        .keys,
    ).toEqual([]);
    const definitionOnly = ['export function custodyClaimFor(account: AccountRow) {', '  return 1;', '}'];
    expect(
      occurrencesOf([{ rel: 'lib/synthetic.ts', lines: definitionOnly }], CALL_RE, skipDefinition)
        .keys,
    ).toEqual([]);
    expect(
      occurrencesOf([{ rel: 'lib/synthetic.ts', lines: definitionOnly }], CALL_RE, skipCommentLine)
        .keys,
    ).toEqual(['lib/synthetic.ts#custodyClaimFor']);

    // The region a skip receives is the region of the line it is asked
    // about. A docblock whose LAST line carries text and the close is prose
    // only because the region is open when that line begins; handed the
    // next line's region instead, it reads as a live star line.
    const textOnClosingLine = [
      '/**',
      ' * the licensed call custodyClaimFor(x)',
      ' * described here custodyClaimFor(y) */',
      'const a = 1;',
    ];
    expect(
      occurrencesOf([{ rel: 'lib/synthetic.ts', lines: textOnClosingLine }], CALL_RE, skipCommentLine)
        .keys,
    ).toEqual([]);
  });

  it('the brace walk enters a comment region only where one demonstrably exists, and reads the code after its close', () => {
    // One probe per decision, each labelled with the decision it
    // discriminates.

    // EXIT, code after the close: what follows a close on its line is live,
    // so a closing brace sitting there ends the block. The old walk skipped
    // every star-leading line outright, so a close sharing its line with the
    // block's real closing brace was never seen, and a match placed after
    // the function resolved INTO it from outside — if that function is an
    // allowed key, a violation is absorbed silently, which is the precise
    // failure the `file#symbol` scheme exists to remove.
    const closingBraceAfterCommentClose = [
      'export async function allowedMint(username: string) {',
      '  /*',
      '  the licensed call sits in here',
      '*/ }',
      '',
      'const stray = jwt.sign(payload, secret);',
    ];
    expect(enclosingSymbol(closingBraceAfterCommentClose, 5)).toBe(MODULE_SCOPE);
    // EXIT, at any indentation: a docblock's natural close is indented, so a
    // brace after a close ends the declaration whatever the line's own
    // indentation. An indentation test there misses ` */ }` and resolves
    // INWARD, into the function the brace closes.
    for (const closeLine of [' */ }', '   */ }']) {
      const indentedClose = closingBraceAfterCommentClose.map((line) =>
        line === '*/ }' ? closeLine : line,
      );
      expect(enclosingSymbol(indentedClose, 5), closeLine).toBe(MODULE_SCOPE);
    }
    const indentedCloseEndsRoute = [
      "router.post('/session-auth', async (req, res) => {",
      '  /*',
      '  the licensed call sits in here',
      '  */ });',
      '',
      'const stray = jwt.sign(payload, secret);',
    ];
    expect(enclosingSymbol(indentedCloseEndsRoute, 5)).toBe(MODULE_SCOPE);
    // The cost, pinned so it is a choice rather than an accident: where the
    // brace after a close ends an INNER block, every declaration the walk
    // tests reads it as its own end, so the answer moves OUTWARD past the
    // function that really encloses the match. A set-equality consumer reads
    // that as a new member unless the outer scope is itself licensed.
    const closeEndsInnerRoute = [
      'export function registerRoutes(router: Router) {',
      "  router.post('/session-auth', async (req, res) => {",
      '    /*',
      '    the licensed call sits in here',
      '    */ });',
      '',
      '  const stray = jwt.sign(payload, secret);',
      '}',
    ];
    expect(enclosingSymbol(closeEndsInnerRoute, 6)).toBe(MODULE_SCOPE);

    // EXIT, after a comment opened MID-LINE: the walk does not track that
    // comment, so its close line is the one place it becomes visible. A
    // close beginning its line is read like a tracked region's close, so the
    // brace behind it ends the declaration rather than being missed.
    const midLineOpenedCommentClosesWithBrace = [
      'export async function allowedMint(username: string) {',
      '  const token = jwt.sign(payload, secret); /* the licensed call,',
      '  described at length',
      '  */ }',
      '',
      'const stray = jwt.sign(payload, secret);',
    ];
    expect(enclosingSymbol(midLineOpenedCommentClosesWithBrace, 5)).toBe(MODULE_SCOPE);
    expect(enclosingSymbol(midLineOpenedCommentClosesWithBrace, 1)).toBe('allowedMint');

    // RE-ENTRY BOUND, exclusive of the opener's own line: whether a close
    // follows is asked of the lines AFTER the opener. A search starting on
    // the opener's line finds the close that precedes it there, re-enters a
    // region nothing closes, and swallows the declaration's brace.
    const reopenedNeverClosed = [
      'function f() {',
      '  /*',
      '  note',
      '*/ /* second, never closed',
      '}',
      '',
      'const stray = custodyClaimFor(account);',
    ];
    expect(enclosingSymbol(reopenedNeverClosed, 6)).toBe(MODULE_SCOPE);
    expect(blockCommentInterior(reopenedNeverClosed)).toEqual([
      false, false, true, true, false, false, false,
    ]);

    // EXIT, mid-line: a region ends at its close wherever that sits, not
    // only at end of line. A test anchored to the line's end keeps the
    // region open and swallows the declaration's own closing brace.
    const regionClosedMidLine = [
      'function pick(row: AccountRow) {',
      '  /*',
      '  the legacy branch lived here',
      '  */ const legacy = null;',
      '  return row.custody;',
      '}',
      '',
      'const stray = custodyClaimFor(account);',
    ];
    expect(enclosingSymbol(regionClosedMidLine, 7)).toBe(MODULE_SCOPE);

    // OPENER, unterminated inside a template literal: a SQL block comment in
    // a query fragment writes that shape, and a phantom region opened there
    // never closes, swallowing the declaration's real brace and widening
    // every following module-scope line into the declaration. A later
    // docblock supplies a close, so template state is the only thing left to
    // refuse the opener.
    const sqlCommentInLiteralWithLaterDocblock = [
      'function citationSql() {',
      '  return `',
      '    SELECT w.citation',
      '    /* self-citations are handled below',
      '    FROM weights w',
      '  `;',
      '}',
      '',
      '/**',
      ' * An ordinary docblock, further down the same module.',
      ' */',
      'const stray = custodyClaimFor(account);',
    ];
    expect(enclosingSymbol(sqlCommentInLiteralWithLaterDocblock, 11)).toBe(MODULE_SCOPE);

    // OPENER outside any template, with no close anywhere below it: an
    // opener nothing ever closes is not a region.
    const strayOpenerNoClose = [
      'function pick(row: AccountRow) {',
      '  /* the note that was never closed',
      '  return row.custody;',
      '}',
      '',
      'const stray = custodyClaimFor(account);',
    ];
    expect(enclosingSymbol(strayOpenerNoClose, 5)).toBe(MODULE_SCOPE);

    // OPENER, self-contained: a one-line block comment closes on itself and
    // opens no region, even with a later docblock a phantom region could
    // borrow a close from.
    const selfContainedBlockComment = [
      'function pick(row: AccountRow) {',
      '  /* the legacy branch lived here */',
      '  return row.custody;',
      '}',
      '',
      '/*',
      ' * A later docblock, so a phantom region could find a close.',
      ' */',
      'const stray = custodyClaimFor(account);',
    ];
    expect(enclosingSymbol(selfContainedBlockComment, 8)).toBe(MODULE_SCOPE);

    // Template state describes where a line BEGINS, not where it ends: a
    // docblock opener quoting an identifier in backticks an odd number of
    // times is still an opener, and the brace inside its comment is prose.
    const backtickInsideCommentOpener = [
      'function pick(row: AccountRow) {',
      '/* a note mentioning `custody` once, unbalanced `',
      '}',
      '*/',
      '  return row.custody;',
      '}',
    ];
    expect(enclosingSymbol(backtickInsideCommentOpener, 4)).toBe('pick');

    // SEED: template parity starts from the declaration line's own
    // backticks. A one-line declaration can open a literal the very next
    // line is inside, and a seed of zero would read that line as code,
    // accept the opener in its content, and swallow the brace that ends the
    // declaration.
    const declarationOpensTemplate = [
      'const render = (row: AccountRow) => { const sql = `',
      '  /* a SQL comment in the literal, never closed',
      '`;',
      '  return sql;',
      '};',
      '',
      '/* a later comment, so a close follows */',
      'const stray = custodyClaimFor(account);',
    ];
    expect(enclosingSymbol(declarationOpensTemplate, 7)).toBe(MODULE_SCOPE);

    // BOUND, per target: whether a close follows is asked of the lines up to
    // the target, not of the whole file. A close below the target cannot
    // vouch for an opener above it; taking it would resolve INWARD, the
    // direction a licensed key can absorb.
    const closeOnlyBelowTarget = [
      'function pick(row: AccountRow) {',
      '  /* an opener whose close sits past the target',
      '}',
      '',
      'const stray = custodyClaimFor(account);',
      '',
      '/* a later comment, so a close follows in the file */',
    ];
    expect(enclosingSymbol(closeOnlyBelowTarget, 4)).toBe(MODULE_SCOPE);
    // BOUND, inclusive: a close on the target line itself counts, so a brace
    // between the opener and that close is prose and the read behind the
    // close still resolves to the declaration.
    const closeOnTargetLine = [
      'function pick(row: AccountRow) {',
      '  /* a note that ends on the line of the read',
      '}',
      '  */ return custodyClaimFor(account);',
      '}',
    ];
    expect(enclosingSymbol(closeOnTargetLine, 3)).toBe('pick');

    // RE-ENTRY: the opener test runs on the code AFTER a close, so a line
    // that closes one region and opens another re-enters, and the brace
    // inside the second region is prose.
    const closeThenReopenOnOneLine = [
      'function pick(row: AccountRow) {',
      '  /*',
      '  first note',
      '  */ /* second note',
      '}',
      '  */',
      '  return row.custody;',
      '}',
    ];
    expect(enclosingSymbol(closeThenReopenOnOneLine, 6)).toBe('pick');

    // OPENER, line start only: an opener that is not at the start of its
    // line is a string, a regex or a glob far more often than a comment (a
    // MIME pattern writes the shape), so the mid-line case is a named
    // residual rather than a guess. Widening the test to any opener on the
    // line resolves INWARD, which is the direction a licensed key absorbs.
    const midLineOpenerInAString = [
      'function pick(row: AccountRow) {',
      "  const pattern = 'image/*';",
      '}',
      '/* a real note, so a close follows */',
      'const stray = custodyClaimFor(account);',
    ];
    expect(enclosingSymbol(midLineOpenerInAString, 4)).toBe(MODULE_SCOPE);

    // PARITY INVERSION, pinned as the residual it is. A backtick inside a
    // regex literal between the declaration and the target flips the
    // whole-file backtick count: the SQL literal in
    // regexBacktickThenLiteralOpener then reads as closed, the opener in its
    // content passes the template guard, and the declaration's brace is
    // swallowed. This resolves INWARD, the walk's silent direction;
    // the same file without the stray backtick resolves outward. Not closed,
    // because telling a regex backtick from a delimiter is the lexer this
    // module declines.
    const regexBacktickThenLiteralOpener = [
      'function citationSql() {',
      '  const TICK_RE = /`/;',
      '  const sql = `',
      '    /* a SQL comment in the literal, never closed',
      '  `;',
      '}',
      '',
      '/* a later comment, so a close follows */',
      'const stray = custodyClaimFor(account);',
    ];
    expect(enclosingSymbol(regexBacktickThenLiteralOpener, 8)).toBe('citationSql');
    const regexWithoutBacktick = regexBacktickThenLiteralOpener.map((line) =>
      line === '  const TICK_RE = /`/;' ? '  const TICK_RE = /x/;' : line,
    );
    expect(enclosingSymbol(regexWithoutBacktick, 8)).toBe(MODULE_SCOPE);
    // The second inversion: a nested multi-line template contributes one
    // backtick per line, so its content reads as OUTSIDE any literal and an
    // opener there passes the guard. Same inward direction. The nested
    // literal on ONE line balances and the guard holds.
    const nestedTemplateThenLiteralOpener = [
      'function renderRows(rows: string[]) {',
      '  return `',
      '    ${rows.map((r) => `',
      '      /* a comment shape in nested content, never closed',
      '    `).join("")}',
      '  `;',
      '}',
      '',
      '/* a later comment, so a close follows */',
      'const stray = custodyClaimFor(account);',
    ];
    expect(enclosingSymbol(nestedTemplateThenLiteralOpener, 9)).toBe('renderRows');
    const nestedTemplateOnOneLine = [
      'function renderRows(rows: string[]) {',
      '  return `',
      '    ${rows.map((r) => `<li>${r}</li>`).join("")}',
      '      /* a comment shape in the content, never closed',
      '  `;',
      '}',
      '',
      '/* a later comment, so a close follows */',
      'const stray = custodyClaimFor(account);',
    ];
    expect(enclosingSymbol(nestedTemplateOnOneLine, 8)).toBe(MODULE_SCOPE);
  });

  it('the region pass marks docblock interiors and nothing else', () => {
    // What lets the star arm tell a continuation from an operator. The flag
    // is about the line's CONTEXT, not its shape: two textually identical
    // star-leading lines, and only the one inside the docblock is prose.
    const lines = [
      'const base = 1;',
      '/**',
      ' * a docblock continuation',
      ' */',
      'const weight = base',
      '  * scale',
      '  * a docblock continuation',
      ';',
    ];
    expect(blockCommentInterior(lines)).toEqual([
      false, false, true, true, false, false, false, false,
    ]);
    // The opener's own line is not interior; the close's line is, because a
    // region is still open when that line begins.
    expect(blockCommentInterior(['/*', 'x', '*/', 'y'])).toEqual([false, true, true, false]);
    // A self-contained block comment opens no region.
    expect(blockCommentInterior(['/* one */', 'const x = 1;'])).toEqual([false, false]);

    // The region pass answers the same question the brace walk does and
    // needs the same two guards, or it reopens the hole it was added to
    // close: a SQL block comment inside a query literal would put every line
    // after it inside a phantom region, and the star-leading factor read in
    // sqlCommentThenLiveRead's scoreFactor would be invisible to the scans
    // that consume this.
    const sqlCommentThenLiveRead = [
      'function citationSql() {',
      '  return `',
      '    SELECT w.citation',
      '    /* self-citations are handled below',
      '    FROM weights w',
      '  `;',
      '}',
      '',
      'export function scoreFactor(w: Weights, cpq: CitationRow) {',
      '  const factor = Number(cpq.weighted_upvotes)',
      '    * CASE_WHEN(cpq.is_self, w.self_citation_discount, w.citation);',
      '  return factor;',
      '}',
    ];
    expect(blockCommentInterior(sqlCommentThenLiveRead)).toEqual(
      new Array(sqlCommentThenLiveRead.length).fill(false),
    );
    // An opener nothing ever closes is not a region either, template or not.
    expect(blockCommentInterior(['/* never closed', 'const x = row.custody;'])).toEqual([
      false,
      false,
    ]);
    // Each guard on its own: the SQL fixture fails both tests at once, so
    // here a docblock further down supplies a close, which every real module
    // does, and template state is the only thing left to refuse the opener.
    const sqlCommentWithLaterDocblock = [
      'function citationSql() {',
      '  return `',
      '    SELECT w.citation',
      '    /* self-citations are handled below',
      '    FROM weights w',
      '  `;',
      '}',
      '',
      '/**',
      ' * An ordinary docblock further down the module.',
      ' */',
      'export function scoreFactor(w: Weights, cpq: CitationRow) {',
      '  const factor = Number(cpq.weighted_upvotes)',
      '    * CASE_WHEN(cpq.is_self, w.self_citation_discount, w.citation);',
      '  return factor;',
      '}',
    ];
    expect(blockCommentInterior(sqlCommentWithLaterDocblock)).toEqual([
      false, false, false, false, false, false, false, false, false, true, true, false, false,
      false, false, false,
    ]);

    // Template state describes where a line BEGINS here too: an opener line
    // quoting identifiers in backticks an odd number of times is still an
    // opener.
    const openerWithOddBackticks = [
      'const x = 1;',
      '/* a note mentioning `custody` once, and one stray `',
      ' * still prose',
      ' */',
      'const y = 2;',
    ];
    expect(blockCommentInterior(openerWithOddBackticks)).toEqual([false, false, true, true, false]);

    // End to end through `occurrencesOf`: the star-leading live read the
    // phantom region would have hidden is counted, under its enclosing
    // symbol, while the docblock continuation quoting the same token is not.
    expect(
      occurrencesOf(
        [{ rel: 'lib/synthetic.ts', lines: sqlCommentThenLiveRead }],
        FACTOR_READ_RE,
        skipCommentLine,
      ).keys,
    ).toEqual(['lib/synthetic.ts#scoreFactor']);
    const proseMentionOnly = [
      '/**',
      ' * the discount travels on w.self_citation_discount',
      ' */',
      'export function scoreFactor(w: Weights) {',
      '  return w.citation;',
      '}',
    ];
    expect(
      occurrencesOf(
        [{ rel: 'lib/synthetic.ts', lines: proseMentionOnly }],
        FACTOR_READ_RE,
        skipCommentLine,
      ).keys,
    ).toEqual([]);

    // BOUND: whether a close follows is asked of the whole file, inclusive
    // of its last line. The pass has no target to stop at, and a docblock's
    // close can sit any distance below its opener.
    const longDocblock = [
      '/**',
      ...Array.from({ length: 12 }, (_, n) => ` * continuation ${n}`),
      ' */',
    ];
    expect(blockCommentInterior(longDocblock)).toEqual([false, ...new Array(13).fill(true)]);
    expect(blockCommentInterior(['/*', 'x', '*/'])).toEqual([false, true, true]);

    // RE-ENTRY: the code after a close is read the way the brace walk reads
    // it, so a line that closes one region and opens another re-enters, and
    // the continuation below it is still prose. Only an UNTERMINATED second
    // opener re-enters; a self-contained one after the close does not.
    const closeThenReopen = [
      '/*',
      ' first note',
      '*/ /* second note',
      ' still prose',
      '*/',
      'const x = 1;',
    ];
    expect(blockCommentInterior(closeThenReopen)).toEqual([false, true, true, true, true, false]);
    expect(blockCommentInterior(['/*', 'x', '*/ /* pragma */ const y = 1;', 'z'])).toEqual([
      false, true, true, false,
    ]);

    // OPENER, line start only: the same boundary the brace walk draws. A
    // string holding an opener would open a phantom region running to the
    // next docblock's close, and every star-leading line between reads as
    // prose, so the live read in midLineOpenerInAString would be skipped.
    const midLineOpenerInAString = [
      "const pattern = 'image/*';",
      'export function scoreFactor(w: Weights, cpq: CitationRow) {',
      '  const factor = Number(cpq.weighted_upvotes)',
      '    * CASE_WHEN(cpq.is_self, w.self_citation_discount, w.citation);',
      '  return factor;',
      '}',
      '/** a docblock, so a close follows */',
    ];
    expect(blockCommentInterior(midLineOpenerInAString)).toEqual(
      new Array(midLineOpenerInAString.length).fill(false),
    );
    expect(
      occurrencesOf(
        [{ rel: 'lib/synthetic.ts', lines: midLineOpenerInAString }],
        FACTOR_READ_RE,
        skipCommentLine,
      ).keys,
    ).toEqual(['lib/synthetic.ts#scoreFactor']);

    // PARITY INVERSION, pinned as the residuals they are. A backtick inside
    // a regex literal flips the whole-file count for every line after it:
    // the query literal in regexBacktickInvertsParity reads as closed, the
    // opener in its content passes the template guard, a docblock further
    // down supplies the close, and the star-leading read between is prose to
    // the predicate — the silent direction. The same file without the stray backtick counts it.
    const regexBacktickInvertsParity = [
      'const TICK_RE = /`/;',
      'const sql = `',
      '  SELECT w.citation',
      '  /* a SQL comment in the literal, never closed',
      '  FROM weights w',
      '`;',
      '',
      'export function scoreFactor(w: Weights, cpq: CitationRow) {',
      '  const factor = Number(cpq.weighted_upvotes)',
      '    * CASE_WHEN(cpq.is_self, w.self_citation_discount, w.citation);',
      '  return factor;',
      '}',
      '',
      '/** a docblock, so a close follows */',
    ];
    expect(
      occurrencesOf(
        [{ rel: 'lib/synthetic.ts', lines: regexBacktickInvertsParity }],
        FACTOR_READ_RE,
        skipCommentLine,
      ).keys,
    ).toEqual([]);
    const regexParityControl = regexBacktickInvertsParity.map((line) =>
      line === 'const TICK_RE = /`/;' ? 'const TICK_RE = /x/;' : line,
    );
    expect(
      occurrencesOf(
        [{ rel: 'lib/synthetic.ts', lines: regexParityControl }],
        FACTOR_READ_RE,
        skipCommentLine,
      ).keys,
    ).toEqual(['lib/synthetic.ts#scoreFactor']);
    // The second inversion: a nested multi-line template contributes one
    // backtick per line, so its content reads as OUTSIDE any literal and an
    // opener there passes the guard — silent wherever it occurs. The same
    // read with its operator at the END of the line before it does not lead
    // with a star and counts regardless of the region.
    const nestedTemplateInvertsParity = [
      'const markup = `',
      '  <ul>',
      '  ${rows.map((r) => `',
      '    <li>',
      '    /* a comment shape in nested content, never closed',
      '    </li>',
      '  `).join("")}',
      '  </ul>',
      '`;',
      '',
      'export function scoreFactor(w: Weights, cpq: CitationRow) {',
      '  const factor = Number(cpq.weighted_upvotes)',
      '    * CASE_WHEN(cpq.is_self, w.self_citation_discount, w.citation);',
      '  return factor;',
      '}',
      '',
      '/** a docblock, so a close follows */',
    ];
    expect(
      occurrencesOf(
        [{ rel: 'lib/synthetic.ts', lines: nestedTemplateInvertsParity }],
        FACTOR_READ_RE,
        skipCommentLine,
      ).keys,
    ).toEqual([]);
    const operatorAtLineEnd = nestedTemplateInvertsParity.map((line) => {
      if (line === '  const factor = Number(cpq.weighted_upvotes)') {
        return '  const factor = Number(cpq.weighted_upvotes) *';
      }
      if (line === '    * CASE_WHEN(cpq.is_self, w.self_citation_discount, w.citation);') {
        return '    CASE_WHEN(cpq.is_self, w.self_citation_discount, w.citation);';
      }
      return line;
    });
    expect(
      occurrencesOf(
        [{ rel: 'lib/synthetic.ts', lines: operatorAtLineEnd }],
        FACTOR_READ_RE,
        skipCommentLine,
      ).keys,
    ).toEqual(['lib/synthetic.ts#scoreFactor']);
  });
});

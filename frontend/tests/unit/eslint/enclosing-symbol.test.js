/**
 * Unit suite for `enclosing-symbol.js`, the scan machinery every
 * source-discipline canary in this directory stands on.
 *
 * PLACEMENT. The canaries live in `tests/unit/eslint/` because the vitest
 * include glob (`tests/unit/**` for `.test.js` files) collects them with no
 * config change and the directory segment mirrors the backend's canary
 * directory; the machinery's own suite lives beside the machinery under the
 * same rule. A canary file keeps its domain assertions and the planted
 * evasion cases that run through its scans. The resolver, the comment
 * predicate, the brace walk and the region pass are exercised here on
 * synthetic sources, one probe per decision point. `sourcesUnder` is not:
 * it reads a directory rather than a source string, and the floor it gives
 * a canary is a claim about that canary's own scanned tree, so its probe
 * stays beside the assertions that rest on it.
 *
 * WHY ONE PROBE PER DECISION POINT. Every whole-tree assertion a canary makes
 * is set-equality over keys this module resolves, so a branch that answers
 * wrongly in a direction a licensed key can absorb weakens every canary at
 * once while each of them stays green. The probes here are discriminators:
 * each is chosen so that mangling one branch of the machinery reddens that
 * probe and no other, and a composite probe (one that goes red when a whole
 * mechanism is deleted) is never the only cover a branch has. The two
 * parity inversions the module documents and declines to close are pinned
 * here as negatives, so the day one of them moves is a red bar rather than
 * a silent change. Its two comment-boundary residuals (an opener mid-line,
 * and a brace after a later boundary on a line carrying more than one) are
 * NOT pinned: both resolve outward to module scope, which no canary
 * licenses, so a consuming set-equality assertion already fails closed on
 * them and a pin would only restate the fail-closed argument.
 */
import { describe, it, expect } from 'vitest';
import {
  MODULE_SCOPE,
  blockCommentInterior,
  enclosingSymbol,
  isCommentLine,
  occurrencesOf,
} from './enclosing-symbol.js';

/** The discriminator the password-factor canary scans for, re-declared here
 *  so a probe can run a planted read through the same skip path that scan
 *  takes without importing the canary. Any token would do for the machinery;
 *  this one keeps the fixtures readable as the shapes that canary defends
 *  against. */
const HAS_PASSWORD_RE = /\bhasPassword\b/;

/** The skip the scans hand to `occurrencesOf`: prose by shape plus the
 *  block-comment region `occurrencesOf` computes once per file. */
const skipCommentLine = (line, lineIndex, lines, insideRegion) => isCommentLine(line, insideRegion);

describe('enclosing-symbol: the resolver, the comment predicate, the brace walk and the region pass', () => {
  it('the comment predicate skips whole-line prose only, never live code behind an inline block comment', () => {
    // Whole-line prose in every shape it takes: skipped.
    expect(isCommentLine('// hasPassword drives the factor choice')).toBe(true);
    expect(isCommentLine('  * hasPassword is read once, in the resolver')).toBe(true);
    expect(isCommentLine('  */')).toBe(true);
    expect(isCommentLine('/* hasPassword lives in the resolver */')).toBe(true);
    expect(isCommentLine('  /* an opener whose comment runs on')).toBe(true);
    expect(isCommentLine('/* one */ /* two */')).toBe(true);
    expect(isCommentLine('/* one */ // and trailing prose')).toBe(true);
    // Live code behind a leading block comment is NOT prose. Skipping it
    // would let a pragma hide a factor read from the scan.
    expect(isCommentLine('/* v8 ignore next */ const usesPassword = status.hasPassword;')).toBe(false);
    expect(isCommentLine('  /* istanbul ignore next */ hasPassword = data.hasPassword;')).toBe(false);
    expect(isCommentLine('/* one */ /* two */ return status.hasPassword;')).toBe(false);
    // The CLOSING side of the same rule. `*/` begins with `*`, so the
    // docblock-continuation arm claims the line before the block arm ever
    // sees it, and a read riding behind the close is skipped silently. Every
    // arm has to close then inspect what is left, the `//` one included
    // (its own case is the third-prefix group at the end of this test).
    expect(isCommentLine('*/ return status.hasPassword === true;')).toBe(false);
    expect(isCommentLine('  */ hasPassword = data.hasPassword;')).toBe(false);
    expect(isCommentLine(' * trailing prose */ const usesPassword = status.hasPassword;')).toBe(false);
    // A bare close, and a close followed by nothing but further comment, stay
    // prose in both arms.
    expect(isCommentLine('*/')).toBe(true);
    expect(isCommentLine('  */ // and trailing prose')).toBe(true);
    expect(isCommentLine('  */ /* two */')).toBe(true);
    expect(isCommentLine('const usesPassword = status.hasPassword; // trailing prose')).toBe(false);
    expect(isCommentLine('')).toBe(false);
    // A leading star is a docblock continuation AND a wrapped multiplication,
    // and one line cannot tell them apart. Outside an open comment region the
    // line is live code, so the predicate needs the region to answer. Passed
    // explicitly here; the scans compute it per file.
    expect(isCommentLine('  * (status.hasPassword === false ? 1 : 0)', false)).toBe(false);
    expect(isCommentLine('  * Number(cached?.hasPassword === false);', false)).toBe(false);
    expect(isCommentLine('*factorHints() { yield this.emailStatus.hasPassword; }', false)).toBe(false);
    // A trailing comment on that live line changes nothing at a region known
    // closed: nothing is open for a star-leading line to continue, so it is
    // live whatever follows it. Without that guard the close search ran
    // first and answered on what followed the close alone, so the block form
    // read as prose while its `//` sibling read as live, and the
    // password-state scan minted no key for the read.
    expect(isCommentLine('  * Number(cached?.hasPassword === false) /* short */', false)).toBe(false);
    expect(isCommentLine('  * Number(cached?.hasPassword === false) // w', false)).toBe(false);
    // An opener at a region known closed is left to the search too: the
    // reading is about a star that could have been a continuation, and an
    // opener never was. Without the star test in it, an opener's own prose
    // would read as live.
    expect(isCommentLine('/* hasPassword lives in the resolver */', false)).toBe(true);
    expect(isCommentLine('/* v8 ignore next */ const usesPassword = status.hasPassword;', false)).toBe(false);
    // A close-leading line is the one star shape the known-closed reading
    // leaves alone:
    // whatever the region pass believes, it ends a comment and is answered by
    // what follows its close, so trailing prose there stays prose and code
    // there stays live.
    expect(isCommentLine('  */ // hasPassword, prose after a close', false)).toBe(true);
    expect(isCommentLine('  */ return status.hasPassword;', false)).toBe(false);
    // Inside one, the same shape is the docblock continuation it looks like.
    expect(isCommentLine('  * hasPassword is read once, in the resolver', true)).toBe(true);
    expect(isCommentLine('  * (status.hasPassword === false ? 1 : 0)', true)).toBe(true);
    // With no region known, the shape reading stands, which is what the
    // import-clause walk relies on.
    expect(isCommentLine('  * hasPassword is read once, in the resolver')).toBe(true);
    // That holds for the trailing-comment line too: with no region known, or
    // one open, its close is what answers, and nothing follows the close.
    expect(isCommentLine('  * Number(cached?.hasPassword === false) /* short */')).toBe(true);
    expect(isCommentLine('  * Number(cached?.hasPassword === false) /* short */', true)).toBe(true);
    // A close ends the region wherever it sits, so what follows is live even
    // when it is itself star-shaped.
    expect(isCommentLine('*/ * Number(status.hasPassword === false);', true)).toBe(false);
    // The third prefix. Inside an open region two slashes are comment text
    // like any other, so a line that begins with them can end the region and
    // carry a live read behind the close, exactly as the star-prefixed form
    // can. Answering on the prefix alone skipped that read while counting
    // its star-prefixed sibling.
    expect(isCommentLine('  // legacy note */ return status.hasPassword === true;', true)).toBe(false);
    expect(isCommentLine('// note */', true)).toBe(true);
    expect(isCommentLine('// note */ // more', true)).toBe(true);
    expect(isCommentLine('// note with no close', true)).toBe(true);
    // Outside a region, and with no region known, the same line is a line
    // comment on its shape: nothing was open for the `*/` to end.
    expect(isCommentLine('  // legacy note */ return status.hasPassword === true;', false)).toBe(true);
    expect(isCommentLine('  // legacy note */ return status.hasPassword === true;')).toBe(true);
  });

  it('the enclosing-symbol resolver names component methods, template literals, and locals, not files', () => {
    // The granularity a canary's whole-tree set-equality assertions rest on.
    // A resolver that returned one label per file would collapse a canary to
    // file granularity while every planted probe stayed green.
    const componentLines = [
      "Alpine.data('settingsPage', () => ({",
      '    async loadEmailStatus() {',
      '      const res = await fetchEmailStatus();',
      '    },',
      '',
      '    async handleSetPassword() {',
      '      this.emailStatus = { hasPassword: true };',
      '    },',
      '}));',
    ];
    // Method shorthand resolves to the method, and a closed sibling does not
    // leak downward into the next one.
    expect(enclosingSymbol(componentLines, 2)).toBe('loadEmailStatus');
    expect(enclosingSymbol(componentLines, 6)).toBe('handleSetPassword');

    // The immediately-invoked in-flight wrapper inside the resolver: the
    // nearest enclosing declaration is the local it is assigned to.
    const flightLines = [
      'export async function resolvePasswordFactor() {',
      '  const flight = (async () => {',
      '    const status = await fetchEmailStatus();',
      '  })();',
      '}',
    ];
    expect(enclosingSymbol(flightLines, 2)).toBe('flight');

    // A page template literal: markup interior resolves to the declaring
    // const, and an occurrence after the closing backtick does not.
    const templateLines = [
      'const template = `',
      '  <template x-if="emailStatus.hasPassword === false">',
      '  </template>',
      '`;',
      'const other = status.hasPassword;',
    ];
    expect(enclosingSymbol(templateLines, 1)).toBe('template');
    expect(enclosingSymbol(templateLines, 4)).toBe(MODULE_SCOPE);

    // Control flow is not a declaration.
    expect(enclosingSymbol(['if (status) {', '  use(status.hasPassword);', '}'], 1)).toBe(
      MODULE_SCOPE,
    );

    // A declaration whose parameter list wraps: the opening line shows
    // neither `=>` nor `function`, so only its unbalanced open paren says it
    // is a function, and a target inside resolves to it.
    const wrappedParams = [
      'const handler = async (',
      '  status,',
      '  options,',
      ') => {',
      '  return status.hasPassword;',
      '};',
    ];
    expect(enclosingSymbol(wrappedParams, 4)).toBe('handler');
    // The same `= (` opening a parenthesized EXPRESSION is not a
    // declaration: its parens balance on the line, so the real enclosing
    // function wins.
    const parenExpression = [
      'function outer(status) {',
      '  const weight = (base + bonus) * scale;',
      '  return status.hasPassword;',
      '}',
    ];
    expect(enclosingSymbol(parenExpression, 2)).toBe('outer');
    // The guard's two fast-path arms, each reached only when the parens
    // balance on the opening line: every other probe here wraps its
    // parameter list, so the paren count answers first and neither arm runs.
    const balancedFunctionKeyword = [
      'const handler = function (status) {',
      '  return status.hasPassword;',
      '};',
    ];
    expect(enclosingSymbol(balancedFunctionKeyword, 1)).toBe('handler');
    const balancedArrow = [
      'const handler = async (status) => {',
      '  return status.hasPassword;',
      '};',
    ];
    expect(enclosingSymbol(balancedArrow, 1)).toBe('handler');
    // A closing brace inside a block comment between the declaration and
    // the target (a commented-out block left at the declaration's own
    // indentation) is prose, not the end of the block.
    const bracedComment = [
      '    async pick() {',
      '    /*',
      '    if (legacy) {',
      '    }',
      '    */',
      '      return this.emailStatus.hasPassword;',
      '    },',
    ];
    expect(enclosingSymbol(bracedComment, 5)).toBe('pick');
  });
  it('the brace walk enters a comment region only where one demonstrably exists, and reads the code after its close', () => {
    // One probe per decision, each labelled with the decision it discriminates.
    // Deleting the region tracking wholesale is already red at the
    // `bracedComment` fixture in the resolver case, but that composite says
    // only that the mechanism is load-bearing as a whole. Each branch here
    // flips a real resolution on its own.

    // OPENER, unterminated: a `/*` the walk cannot see close is not a
    // comment. Markup inside a template literal writes that shape, and a
    // phantom region opened there never closes, swallowing the declaration's
    // real brace and widening every following module-scope line into the
    // declaration. That is worse than an ordinary wrong answer, because the
    // wrong symbol can be a key the consumer already licensed, which its
    // width pin then absorbs.
    const strayCommentInMarkup = [
      'function renderPanel(status) {',
      '  return `',
      '    <div class="factor-panel">',
      '    /* spacing note, never closed',
      '    </div>',
      '  `;',
      '}',
      '',
      'const usesPassword = status.hasPassword;',
    ];
    expect(enclosingSymbol(strayCommentInMarkup, 8)).toBe(MODULE_SCOPE);

    // OPENER, self-contained: a `/* ... */` line closes on itself and opens
    // no region. The trailing docblock is what lets a phantom region find a
    // close, so the self-contained guard is the only branch deciding this.
    const selfContainedBlockComment = [
      'function pick(status) {',
      '  /* the legacy branch lived here */',
      '  return status.hasPassword;',
      '}',
      '',
      '/*',
      ' * A later docblock, so a phantom region could find a close.',
      ' */',
      'const usesPassword = status.hasPassword;',
    ];
    expect(enclosingSymbol(selfContainedBlockComment, 8)).toBe(MODULE_SCOPE);

    // EXIT, mid-line: a region ends at its close wherever that sits, not
    // only at end of line. A test anchored to the line's end keeps the
    // region open and swallows the declaration's own closing brace.
    const regionClosedMidLine = [
      'function pick(status) {',
      '  /*',
      '  the legacy branch lived here',
      '  */ const legacy = null;',
      '  return status.hasPassword;',
      '}',
      '',
      'const usesPassword = status.hasPassword;',
    ];
    expect(enclosingSymbol(regionClosedMidLine, 7)).toBe(MODULE_SCOPE);

    // EXIT, code after the close: what follows `*/` on that line is live, so
    // a closing brace sitting there ends the block. Skipping the whole exit
    // line instead resolves a following module-scope line into the
    // declaration.
    const closingBraceAfterCommentClose = [
      'function pick(status) {',
      '  /*',
      '  the legacy branch lived here',
      '*/ }',
      '',
      'const usesPassword = status.hasPassword;',
    ];
    expect(enclosingSymbol(closingBraceAfterCommentClose, 5)).toBe(MODULE_SCOPE);

    // OPENER inside a template literal, with a real comment close elsewhere
    // in the file. A later close cannot vouch for an opener that is markup:
    // every page module carries a docblock, so a test that only asks whether
    // SOME close follows is satisfied in every real file and the phantom
    // region opens anyway. Template state is what refuses it.
    const strayInMarkupWithLaterDocblock = [
      'function renderPanel(status) {',
      '  return `',
      '    <div class="factor-panel">',
      '    /* spacing note, never closed',
      '    </div>',
      '  `;',
      '}',
      '',
      '/**',
      ' * An ordinary docblock, further down the same module.',
      ' */',
      'const usesPassword = status.hasPassword;',
    ];
    expect(enclosingSymbol(strayInMarkupWithLaterDocblock, 11)).toBe(MODULE_SCOPE);

    // OPENER outside any template, with no close anywhere below it. Template
    // state has nothing to say here, so whether a close follows at all is the
    // branch that decides, and an opener nothing ever closes is not a region.
    const strayOpenerNoClose = [
      'function pick(status) {',
      '  const marker = legacyMarkers[0];',
      '  /* the note that was never closed',
      '  return status.hasPassword;',
      '}',
      '',
      'const usesPassword = status.hasPassword;',
    ];
    expect(enclosingSymbol(strayOpenerNoClose, 6)).toBe(MODULE_SCOPE);

    // Template state describes where a line BEGINS, not where it ends. The
    // only line the two readings disagree on is one that both opens a comment
    // and carries an odd number of backticks, which is an ordinary docblock
    // in this codebase: prose here quotes identifiers in backticks constantly.
    // Such a line begins outside the literal, so its opener is a real comment
    // and the brace it encloses is prose.
    const backtickInsideCommentOpener = [
      'function pick(status) {',
      '/* a note mentioning `hasPassword` once, unbalanced `',
      '}',
      '*/',
      '  return status.hasPassword;',
      '}',
    ];
    expect(enclosingSymbol(backtickInsideCommentOpener, 4)).toBe('pick');

    // SEED: template parity starts from the declaration line's own backticks,
    // not from zero. A one-line declaration can open a literal that the very
    // next line is inside, and a seed of zero would read that line as code,
    // accept the opener in its markup, and swallow the brace that ends the
    // declaration.
    const declarationOpensTemplate = [
      'const render = (status) => { const markup = `',
      '  /* spacing note in markup, never closed',
      '`;',
      '  return markup;',
      '};',
      '',
      '/* a later comment, so a close follows */',
      'const usesPassword = status.hasPassword;',
    ];
    expect(enclosingSymbol(declarationOpensTemplate, 7)).toBe(MODULE_SCOPE);

    // BOUND, per target: whether a close follows is asked of the lines up to
    // the target, not of the whole file. With the only close BELOW the
    // target the opener is not a region the walk has seen close, its brace
    // is live and ends the declaration, and the target resolves outward.
    // Reading to the end of the file instead would take that later close as
    // vouching for the opener and resolve inward, which is the direction a
    // licensed key can absorb.
    const closeOnlyBelowTarget = [
      'function pick(status) {',
      '  /* an opener whose close sits past the target',
      '}',
      '',
      'const usesPassword = status.hasPassword;',
      '',
      '/* a later comment, so a close follows in the file */',
    ];
    expect(enclosingSymbol(closeOnlyBelowTarget, 4)).toBe(MODULE_SCOPE);
    // BOUND, inclusive: a close on the target line itself counts, so a brace
    // between the opener and that close is prose and the read behind the
    // close still resolves to the declaration.
    const closeOnTargetLine = [
      'function pick(status) {',
      '  /* a note that ends on the line of the read',
      '}',
      '  */ return status.hasPassword;',
      '}',
    ];
    expect(enclosingSymbol(closeOnTargetLine, 3)).toBe('pick');

    // RE-ENTRY: the opener test runs on the code AFTER a close, so a line
    // that closes one region and opens another re-enters, and the brace
    // inside the second region is prose. Testing the raw line instead would
    // see a line beginning with a close, not an opener, and read that brace
    // as ending the declaration.
    const closeThenReopenOnOneLine = [
      'function pick(status) {',
      '  /*',
      '  first note',
      '  */ /* second note',
      '}',
      '  */',
      '  return status.hasPassword;',
      '}',
    ];
    expect(enclosingSymbol(closeThenReopenOnOneLine, 6)).toBe('pick');

    // OPENER, line start only: a `/*` that is not at the start of its line
    // is a string, a regex or a glob far more often than a comment, so the
    // opener test anchors at line start and the mid-line case is a named
    // residual rather than a guess. Widening the test to any `/*` on the
    // line is the tempting way to "close" that residual, and it turns an
    // ordinary `'image/*'` (this tree writes the shape) into an opener whose
    // phantom region swallows the declaration's brace. The residual resolves
    // outward; the widening resolves INWARD, which is the direction a
    // licensed key absorbs.
    const midLineOpenerInAString = [
      'function pick(status) {',
      "  const pattern = 'image/*';",
      '}',
      '/* a real note, so a close follows */',
      'const usesPassword = status.hasPassword;',
    ];
    expect(enclosingSymbol(midLineOpenerInAString, 4)).toBe(MODULE_SCOPE);

    // PARITY INVERSION, pinned as the residual it is. The template guard is
    // a count of backticks per line, and a backtick inside a regex literal
    // between the declaration and the target flips it: the literal below
    // then reads as closed, the opener in its markup passes the guard, and
    // the declaration's brace is swallowed. This resolves INWARD, the walk's
    // silent direction; the same file without the stray backtick resolves
    // outward. Not closed, because telling a regex backtick from a template
    // one is the lexer this module declines.
    const regexBacktickThenMarkupOpener = [
      'function renderPanel(status) {',
      '  const TICK_RE = /`/;',
      '  const markup = `',
      '    /* spacing note in markup, never closed',
      '  `;',
      '}',
      '',
      '/* a later comment, so a close follows */',
      'const usesPassword = status.hasPassword;',
    ];
    expect(enclosingSymbol(regexBacktickThenMarkupOpener, 8)).toBe('renderPanel');
    const regexWithoutBacktick = regexBacktickThenMarkupOpener.map((line) =>
      line === '  const TICK_RE = /`/;' ? '  const TICK_RE = /x/;' : line,
    );
    expect(enclosingSymbol(regexWithoutBacktick, 8)).toBe(MODULE_SCOPE);
    // The second inversion: a nested multi-line template contributes one
    // backtick per line, so its markup reads as outside any literal and an
    // opener there passes the guard. Same inward direction. The nested
    // literal on ONE line balances and the guard holds.
    const nestedTemplateThenMarkupOpener = [
      'function renderList(items) {',
      '  return `',
      '    ${items.map((item) => `',
      '      /* spacing note in nested markup, never closed',
      '    `).join("")}',
      '  `;',
      '}',
      '',
      '/* a later comment, so a close follows */',
      'const usesPassword = status.hasPassword;',
    ];
    expect(enclosingSymbol(nestedTemplateThenMarkupOpener, 9)).toBe('renderList');
    const nestedTemplateOnOneLine = [
      'function renderList(items) {',
      '  return `',
      '    ${items.map((item) => `<li>${item}</li>`).join("")}',
      '      /* spacing note in markup, never closed',
      '  `;',
      '}',
      '',
      '/* a later comment, so a close follows */',
      'const usesPassword = status.hasPassword;',
    ];
    expect(enclosingSymbol(nestedTemplateOnOneLine, 8)).toBe(MODULE_SCOPE);
  });
  it('the region pass marks docblock interiors and nothing else', () => {
    // What lets the star arm tell a continuation from an operator. The flag
    // is about the line's CONTEXT, not its shape: index 2 and index 6 are
    // textually identical and only one of them is prose.
    const lines = [
      'const base = 1;',            // 0
      '/**',                        // 1
      ' * a docblock continuation', // 2
      ' */',                        // 3
      'const weight = base',        // 4
      '  * scale',                  // 5
      '  * a docblock continuation',// 6  same text as index 2, live here
      ';',                          // 7
    ];
    expect(blockCommentInterior(lines)).toEqual([
      false, false, true, true, false, false, false, false,
    ]);
    // The opener's own line is not interior; the close's line is, because a
    // region is still open when that line begins.
    expect(blockCommentInterior(['/*', 'x', '*/', 'y'])).toEqual([false, true, true, false]);
    // A self-contained block comment opens no region.
    expect(blockCommentInterior(['/* one */', 'const x = 1;'])).toEqual([false, false]);

    // The region pass answers the same question the brace walk does and needs
    // the same two guards, or it reopens the hole it was added to close. A
    // page module writes markup in a template literal, a token shaped like an
    // opener sits in that markup, and every later line reads as prose: the
    // live derivation below is then invisible to the scans that consume this.
    const markupOpenerThenLiveRead = [
      'const template = `',
      '  <div>',
      '  /* spacing note, never closed',
      '  </div>',
      '`;',
      '',
      'export function pick(status, cached) {',
      '  const orcidOnly = Number(cached != null)',
      '    * Number(cached?.hasPassword === false);',
      '  return orcidOnly;',
      '}',
    ];
    expect(blockCommentInterior(markupOpenerThenLiveRead)).toEqual(
      new Array(markupOpenerThenLiveRead.length).fill(false),
    );
    // An opener nothing ever closes is not a region either, template or not.
    expect(blockCommentInterior(['/* never closed', 'const x = status.hasPassword;'])).toEqual([
      false,
      false,
    ]);

    // Each guard on its own. `markupOpenerThenLiveRead` fails both tests at
    // once (its opener is inside the literal AND nothing closes below it),
    // so it says only that the pair refuses the shape. The inline
    // `['/* never closed', ...]` fixture is outside any literal, so the
    // close test alone decides it. Here a docblock further down supplies a
    // close, which every real module does, so template state is the only
    // thing left to refuse the opener.
    const markupOpenerWithLaterDocblock = [
      'const template = `',
      '  <div>',
      '  /* spacing note, never closed',
      '  </div>',
      '`;',
      '',
      '/**',
      ' * An ordinary docblock further down the module.',
      ' */',
      'export function pick(status) {',
      '  const orcidOnly = Number(status != null)',
      '    * Number(status?.hasPassword === false);',
      '  return orcidOnly;',
      '}',
    ];
    expect(blockCommentInterior(markupOpenerWithLaterDocblock)).toEqual([
      false, false, false, false, false, false, false, true, true, false, false, false, false, false,
    ]);

    // And template state describes where a line BEGINS here too: an opener
    // line quoting identifiers in backticks an odd number of times is still
    // an opener, because it begins outside the literal.
    const openerWithOddBackticks = [
      'const x = 1;',
      '/* a note mentioning `hasPassword` once, and one stray `',
      ' * still prose',
      ' */',
      'const y = 2;',
    ];
    expect(blockCommentInterior(openerWithOddBackticks)).toEqual([false, false, true, true, false]);

    // End to end: the derivation the phantom region would have hidden.
    expect(
      occurrencesOf([{ rel: 'pages/thing.js', lines: markupOpenerThenLiveRead }], HAS_PASSWORD_RE, skipCommentLine)
        .keys,
    ).toEqual(['pages/thing.js#pick']);

    // BOUND: whether a close follows is asked of the whole file, inclusive
    // of its last line. The pass has no target to stop at, and a docblock's
    // close can sit any distance below its opener; a windowed bound would
    // refuse a long docblock and count its continuations as live, and an
    // exclusive end would refuse one whose close is the file's last line.
    const longDocblock = ['/**', ...Array.from({ length: 12 }, (_, n) => ` * continuation ${n}`), ' */'];
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

    // OPENER, line start only: the same boundary the brace walk draws, and
    // the same widening defeats it here. A string holding `/*` would open a
    // phantom region running to the next docblock's close, and every
    // star-leading line between it and that close reads as prose, so the
    // live read below is skipped. Both readers need this pinned, because
    // they share the opener test but not their callers.
    const midLineOpenerInAString = [
      "const pattern = 'image/*';",
      'export function pick(status, cached) {',
      '  const orcidOnly = Number(cached != null)',
      '    * Number(cached?.hasPassword === false);',
      '  return orcidOnly;',
      '}',
      '/** a docblock, so a close follows */',
    ];
    expect(blockCommentInterior(midLineOpenerInAString)).toEqual(
      new Array(midLineOpenerInAString.length).fill(false),
    );
    expect(
      occurrencesOf([{ rel: 'pages/thing.js', lines: midLineOpenerInAString }], HAS_PASSWORD_RE, skipCommentLine)
        .keys,
    ).toEqual(['pages/thing.js#pick']);

    // PARITY INVERSION, pinned as the residuals they are. Template parity is
    // a whole-file count of backticks per line, and two shapes flip it.
    //
    // A backtick inside a regex literal (a string literal, comment text, or
    // an escape in a template's own text does the same) flips parity for
    // every line after it. The literal below then reads as closed, the
    // opener in its markup passes the template guard, a docblock further
    // down supplies the close, and every star-leading line between is prose
    // to the predicate: the wrapped multiplication carrying the read is
    // skipped. The same file without the stray backtick counts it. In the
    // tree today this inversion has no consequence at all: the windows it
    // opens carry no line-start opener, so nothing is refused. Its
    // reachable direction, if a docblock opener ever landed in one, is the
    // loud one (the opener refused, its star lines counted as live, a false
    // red bar); the silent case needs markup with a line-start opener to
    // FOLLOW the stray backtick, which nothing in the tree writes.
    const regexBacktickInvertsParity = [
      'const TICK_RE = /`/;',
      'const template = `',
      '  <div>',
      '  /* spacing note in markup, never closed',
      '  </div>',
      '`;',
      '',
      'export function pick(status, cached) {',
      '  const orcidOnly = Number(cached != null)',
      '    * Number(cached?.hasPassword === false);',
      '  return orcidOnly;',
      '}',
      '',
      '/** a docblock, so a close follows */',
    ];
    expect(
      occurrencesOf([{ rel: 'pages/thing.js', lines: regexBacktickInvertsParity }], HAS_PASSWORD_RE, skipCommentLine)
        .keys,
    ).toEqual([]);
    const regexWithoutBacktick = regexBacktickInvertsParity.map((line) =>
      line === 'const TICK_RE = /`/;' ? 'const TICK_RE = /x/;' : line,
    );
    expect(
      occurrencesOf([{ rel: 'pages/thing.js', lines: regexWithoutBacktick }], HAS_PASSWORD_RE, skipCommentLine).keys,
    ).toEqual(['pages/thing.js#pick']);

    // A nested multi-line template contributes one backtick per line, so
    // its markup reads as OUTSIDE any literal and an opener there passes the
    // guard. This one inverts inside the markup itself, so it is silent
    // wherever it occurs; nothing in the tree nests a multi-line template.
    // The same read with its operator at the END of the line before it does
    // not lead with a star and counts regardless of the region.
    const nestedTemplateInvertsParity = [
      'const template = `',
      '  <ul>',
      '  ${items.map((item) => `',
      '    <li>',
      '    /* spacing note in nested markup, never closed',
      '    </li>',
      '  `).join("")}',
      '  </ul>',
      '`;',
      '',
      'export function pick(status, cached) {',
      '  const orcidOnly = Number(cached != null)',
      '    * Number(cached?.hasPassword === false);',
      '  return orcidOnly;',
      '}',
      '',
      '/** a docblock, so a close follows */',
    ];
    expect(
      occurrencesOf([{ rel: 'pages/thing.js', lines: nestedTemplateInvertsParity }], HAS_PASSWORD_RE, skipCommentLine)
        .keys,
    ).toEqual([]);
    const operatorAtLineEnd = nestedTemplateInvertsParity.map((line) => {
      if (line === '  const orcidOnly = Number(cached != null)') return '  const orcidOnly = Number(cached != null) *';
      if (line === '    * Number(cached?.hasPassword === false);') return '    Number(cached?.hasPassword === false);';
      return line;
    });
    expect(
      occurrencesOf([{ rel: 'pages/thing.js', lines: operatorAtLineEnd }], HAS_PASSWORD_RE, skipCommentLine).keys,
    ).toEqual(['pages/thing.js#pick']);
  });
});

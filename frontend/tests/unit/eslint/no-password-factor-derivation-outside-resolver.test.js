/**
 * Standing source-discipline canary: re-auth factor selection reads the
 * account's password state in exactly one place.
 *
 * Every surface that must choose between the inline password prompt and the
 * navigating ORCID round-trip calls `resolvePasswordFactor` in
 * `lib/fresh-auth.js`. That resolver is the only factor-selection consumer of
 * `fetchEmailStatus`, and it folds the failure direction in on purpose: only
 * an explicit `hasPassword === false` routes to ORCID, because the ORCID
 * factor is a full-page navigation that discards page state. Before the
 * resolver existed, several surfaces each derived their own answer from the
 * status response and disagreed about the unavailable-answer case, and the
 * wrong answer sent users into a navigation that threw away their work. The
 * divergence was collapsed onto the one resolver; what kept it collapsed was
 * a manual grep. This canary is that grep, standing.
 *
 * PLACEMENT. This is the first frontend source-discipline canary and sets the
 * shape for the class. It lives in `tests/unit/eslint/` because the vitest
 * include glob (`tests/unit/**` for `.test.js` files) collects it with no
 * config change, and the `eslint` directory segment mirrors the backend's
 * source-discipline canary directory so both trees carry the class under the
 * same name. Scan machinery lives beside it in `enclosing-symbol.js`, which
 * is not collected because only `.test.js` files are.
 *
 * WALK. `sourcesUnder` reads `.js` files only, and the first assertion pins
 * both a floor on how many it read and that nothing else script-shaped lives
 * under `src`: Vite resolves `.mjs`, `.ts`, `.jsx` and friends with no
 * configuration, so a module authored in one of them would join the bundle
 * unscanned while its `.js` importer writes neither the fetch's name nor the
 * discriminator. The non-script assets the walk may pass over (the
 * stylesheet) are licensed by extension, so the first foreign script file
 * is a red bar rather than a silent hole.
 *
 * GRANULARITY. Occurrence assertions are over `file#symbol` pairs resolved by
 * `enclosingSymbol`, never over files: a file already on an allowed list
 * would absorb a second, different occurrence silently. The licensed sites
 * are named individually, including the rendering-only read in
 * `pages/settings.js`, which is a legitimate member rather than a
 * pattern-excluded one so that a DIFFERENT offending shape in the same file
 * is still caught. Every assertion here is equality against a fixed allowed
 * map, the shape under which an unresolvable or wrongly resolved symbol
 * fails closed as an unexpected member.
 *
 * WIDTH. Each licensed key is additionally pinned to its exact occurrence
 * count, because a key-level set inherits the file-level absorption one
 * level down in two shapes this tree writes today. A licensed key whose
 * declaration NAME is a recurring idiom absorbs by collision: the resolver's
 * in-flight local shares its name with the session acquisition coalescer's
 * local in the same module, so a status read added inside THAT coalescer
 * resolves to the licensed key. And a licensed key naming a wide region
 * absorbs by extent: the settings template literal is hundreds of markup
 * lines under one key, so an inline factor expression anywhere in it lands
 * on the licensed member. Pinning the width turns both into a red bar: any
 * occurrence added under a licensed key moves its count, and a deliberate
 * change to a licensed site is a two-sided edit (the code and the pinned
 * width). Widths count MATCHES, not lines: the resolver's own status
 * assignment names the property on both sides of its `=`, and a second read
 * added beside a licensed one on the same line must move the count too.
 *
 * DETECTION. The occurrence scan matches the NAME `fetchEmailStatus`, not a
 * call shape: a call-shaped pattern is defeated by one line, since
 * `import { fetchEmailStatus as f }` renames every call site. Matching the
 * name catches the alias at the import, the last place the real name is
 * forced to appear. The cost is that the definition, prose, and plain import
 * specifiers match too; they are removed by explicit skip predicates rather
 * than by the pattern's shape. The specifier skip applies only when the
 * statement's opener is an `import` (a re-export block's specifier is a new
 * road to the function and counts), and it is vetoed by an `as` anywhere in
 * the JOINED statement, so an alias split across a line wrap is still seen.
 * A namespace import (`import * as api`) writes no specifier to skip and is
 * caught at its usage sites, which cannot avoid writing the name. A
 * commented-out occurrence is not an occurrence: whole-line comments are
 * skipped, so dead code can neither trip the scan nor keep a licensed
 * member's key alive.
 *
 * LAYERS. Four scans, because no single one closes every road:
 *  1. name occurrences of `fetchEmailStatus` (call sites, aliases,
 *     indirection, re-export specifiers);
 *  2. import-site tracking, file granular because an import sits at module
 *     scope (which modules may hold a reference at all);
 *  3. `hasPassword` property occurrences, the discriminator a factor decision
 *     cannot avoid writing even when the status object arrives second-hand
 *     rather than from a fetch of its own;
 *  4. a wholesale re-export ban (`export * from` the api module), the one
 *     rebinding shape that writes neither the function's name nor the
 *     property's.
 *
 * Residual, pinned in prose rather than silently absorbed: the width pin
 * catches every ADDED occurrence under a licensed key, but a constant-width
 * REPLACEMENT does not move a count. Rewriting a licensed line itself into a
 * factor decision (the settings section gate turned into a factor branch, or
 * the resolver's own status read reshaped without changing how many lines
 * write the name) stays green. That shape edits the licensed lines directly,
 * which is the edit a review diff cannot miss, and factor logic inline in
 * markup gives a reviewer a second reason to reject it.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODULE_SCOPE,
  enclosingSymbol,
  isCommentLine,
  occurrencesOf,
  sourcesUnder,
} from './enclosing-symbol.js';

/** ANY textual occurrence of the status fetch's name, not a call shape. See
 *  the file docblock for why the call shape is a defeated pattern. */
const STATUS_FETCH_IDENT_RE = /\bfetchEmailStatus\b/;

/** The definition line, skipped by shape so the api module stays scanned for
 *  other references to its own export. */
const STATUS_FETCH_DEFINITION_RE = /function\s+fetchEmailStatus\s*\(/;

/** An UNALIASED specifier for the status fetch: its own line inside a
 *  multi-line clause, the last specifier followed by a closing brace and
 *  `from`, or the single-line form. Holding a plain reference under the real
 *  name is visible to this whole file's scans; holding one under another name
 *  is what the alias veto below refuses to spare. */
const STATUS_FETCH_IMPORT_SPECIFIER_RE =
  /^\s*(?:import\s*\{[^}]*?)?fetchEmailStatus\s*(?:,|\}\s*from\b|$)/;

/** The identifier renamed at the specifier. Its presence anywhere in the
 *  joined statement VETOES the specifier skip: an alias is the one shape that
 *  makes every later call site invisible to a name scan, so the import line
 *  itself must be the occurrence that goes red. */
const STATUS_FETCH_ALIAS_RE = /\bfetchEmailStatus\s+as\b/;

/** The statement a specifier line belongs to, joined downward until its
 *  `from` clause or terminator (or a small cap). The alias veto runs against
 *  this joined text because `fetchEmailStatus` on its own line with `as f,`
 *  on the next is a legal specifier whose alias a per-line veto never sees. */
const joinedStatement = (lines, lineIndex) => {
  let joined = lines[lineIndex];
  if (/\bfrom\b|;/.test(joined)) return joined;
  for (let j = lineIndex + 1; j < lines.length && j <= lineIndex + 6; j++) {
    joined += '\n' + lines[j];
    if (/\bfrom\b|;/.test(lines[j])) break;
  }
  return joined;
};

/** Whether the statement a specifier line belongs to opens as an IMPORT.
 *  A bare specifier line is textually identical inside `import {` and
 *  `export {` blocks, and only the import form deserves the skip: a
 *  re-export mints a new module path to the function that the import-site
 *  assertion (anchored on the api module's path) would never see. Walks
 *  upward a bounded distance. On every line ABOVE the specifier the
 *  terminator test (`;`, `}`, or `from`) runs before the opener test: a
 *  complete single-line import sitting a few lines above an object-literal
 *  member or a call argument is a closed statement and must not lend that
 *  live reference its skip. A comment line inside the clause is neither. A
 *  specifier further than the bound from its opener counts as an
 *  occurrence, which is the loud direction. */
const importStatementOpens = (lines, lineIndex) => {
  for (let j = lineIndex; j >= 0 && j >= lineIndex - 8; j--) {
    if (j < lineIndex) {
      if (isCommentLine(lines[j])) continue;
      if (/[;}]|\bfrom\b/.test(lines[j])) return false;
    }
    const m = lines[j].match(/\b(import|export)\s*\{/);
    if (m) return m[1] === 'import';
  }
  return false;
};

/** The shapes that name the status fetch without holding a usable second
 *  answer: its definition, whole-line comments, and an unaliased specifier
 *  of a genuine import statement. Everything else that writes the name
 *  counts. */
const skipStatusFetchLine = (line, lineIndex, lines) =>
  STATUS_FETCH_DEFINITION_RE.test(line) ||
  isCommentLine(line) ||
  (STATUS_FETCH_IMPORT_SPECIFIER_RE.test(line) &&
    importStatementOpens(lines, lineIndex) &&
    !STATUS_FETCH_ALIAS_RE.test(joinedStatement(lines, lineIndex)));

/** A named import of the status fetch from the api module, matched against
 *  whole file text because the licensed imports include a multi-line clause.
 *  Matches the aliased form and either quote style. Anchored on the api
 *  module's `.js` specifier: a module reached by some other spelling would be
 *  absent rather than a member, which shrinks the set instead of failing it;
 *  that leg is covered by the occurrence scan, which sees usage lines
 *  regardless of how the module was named. A namespace import carries no
 *  specifier braces and is likewise left to the occurrence scan. */
const STATUS_FETCH_IMPORT_RE =
  /import\s*\{[^}]*\bfetchEmailStatus\b[^}]*\}\s*from\s*(['"])[^'"]*api(?:\.js)?\1/;

/** A wholesale re-export of the api module: rebinds every export, including
 *  the status fetch, under a new module path while writing neither the
 *  function's name nor the property's. No file may hold one. */
// The `.js` is optional: Vite resolves extensionless specifiers, so the
// spelling `from '../api'` binds the same module and must anchor the same.
const API_EXPORT_STAR_RE = /\bexport\s*\*\s*(?:as\s+[A-Za-z0-9_$]+\s+)?from\s*(['"])[^'"]*api(?:\.js)?\1/;

/** The password-state discriminator. A surface deriving its own factor
 *  decision can avoid calling the status fetch (the object may arrive
 *  second-hand), but it cannot avoid reading this property. */
const HAS_PASSWORD_RE = /\bhasPassword\b/;

/** The message every whole-tree assertion carries: what the invariant is and
 *  what to do instead of extending a list. */
const CONSUME_THE_RESOLVER =
  'Re-auth factor selection must read the account password state in exactly one place. ' +
  'Consume resolvePasswordFactor (lib/fresh-auth.js) instead of deriving another answer: ' +
  'a per-surface answer that disagrees about the unavailable-status case routes users ' +
  'into a full-page ORCID navigation that discards their work. Only a read that cannot ' +
  'influence which factor a user is offered (pure display of account status) may join ' +
  'the allowed map. Each licensed site is pinned at its exact occurrence count: a new ' +
  'read under an already-licensed key is a violation at that site, not a license, and a ' +
  'deliberate change to a licensed site updates its pinned count in the same change.';

/** The only sites that may name the status fetch, each pinned to its exact
 *  occurrence width. The fresh-auth member is the resolver's coalesced
 *  in-flight resolution: `resolvePasswordFactor` wraps its status read in an
 *  immediately-invoked function assigned to a `flight` local so concurrent
 *  callers share one request, and that local is the nearest enclosing
 *  declaration the resolver machinery names. The narrowness is a feature: a
 *  status read added to `resolvePasswordFactor` outside its in-flight wrapper
 *  is a NEW key and a red bar, and renaming the local is a deliberate
 *  two-sided edit (the code and this entry). The name `flight` is the
 *  module's in-flight idiom rather than unique to the resolver: the session
 *  acquisition coalescer declares the same local, so an occurrence inside it
 *  resolves to this SAME key, and the pinned width of one is what keeps that
 *  sibling region from absorbing a derivation of its own. The settings member
 *  is the rendering-only read: `loadEmailStatus` stores the whole status for
 *  display and its fresh-auth context deliberately passes no factor state. */
const ALLOWED_STATUS_FETCH_SITES = {
  'lib/fresh-auth.js#flight': 1,
  'pages/settings.js#loadEmailStatus': 1,
};

/** The only modules that may hold a reference to the status fetch at all.
 *  The api module defines it and imports nothing. */
const ALLOWED_STATUS_FETCH_IMPORTERS = ['lib/fresh-auth.js', 'pages/settings.js'];

/** The only sites that may read or write the password-state discriminator,
 *  each pinned to its exact occurrence width: the resolver's in-flight
 *  resolution (the factor decision itself, every read in it; its assignment
 *  from the status response and its `assumed` expression each name the
 *  property twice on one line, so the width exceeds the line count), the
 *  settings page template (the section gate on the set-password affordance plus the
 *  markup comment explaining it; an HTML comment inside the literal is
 *  template content to this scan on purpose, since prose there can become an
 *  attribute expression without minting a new key), and the set-password
 *  success handler (patches the stored status so the section collapses; a
 *  write of display state, not a factor decision). A width moved by an
 *  innocent edit, a reworded markup comment or reshaped resolver internals,
 *  is re-pinned here in the same change; that noise is the loud direction. */
const ALLOWED_PASSWORD_STATE_SITES = {
  'lib/fresh-auth.js#flight': 8,
  'pages/settings.js#handleSetPassword': 1,
  'pages/settings.js#template': 2,
};

/** The extensions the walk may pass over without scanning: assets that
 *  cannot carry a module. Anything else under `src` that is not `.js` is a
 *  script the bundler would resolve and no scan here would read. */
const NON_SCRIPT_EXTENSIONS = new Set(['.css']);

const UNSCANNED_EXTENSION =
  'This canary scans .js files only, and Vite resolves other script extensions ' +
  '(.mjs, .cjs, .ts, .jsx) with no configuration, so a module in one of them would ship ' +
  'unscanned and could carry a second factor derivation unseen. Author frontend modules as ' +
  '.js, or extend the walker (sourcesUnder) and its planted probe to the new extension in ' +
  'the same change. A non-script asset the walk may pass over is licensed by its extension ' +
  'in NON_SCRIPT_EXTENSIONS.';

const here = path.dirname(fileURLToPath(import.meta.url));
const { sources, foreign } = sourcesUnder(path.resolve(here, '..', '..', '..', 'src'));

describe('single password-factor resolver: no second fetchEmailStatus-derived decision', () => {
  it('walks a plausible number of source files and finds nothing script-shaped it cannot read', () => {
    // Without this, a walker that returned nothing would make every assertion
    // below vacuously true and the canary would enforce nothing.
    expect(sources.length).toBeGreaterThan(40);
    const rels = sources.map((s) => s.rel);
    expect(rels).toContain('api.js');
    expect(rels).toContain('lib/fresh-auth.js');
    expect(rels).toContain('pages/settings.js');
    // And a walker that read every `.js` file would still miss a module in
    // any other extension the bundler resolves; the walk reports what it
    // passed over, and only non-script assets may appear there.
    const unscanned = foreign.filter((rel) => !NON_SCRIPT_EXTENSIONS.has(path.extname(rel)));
    expect(unscanned, `${UNSCANNED_EXTENSION}\nunscanned files under src:\n${unscanned.join('\n')}`).toEqual([]);
  });

  it('the walker reads every .js file recursively and reports every other file it passed over', () => {
    // The walk is the floor every scan above stands on. A walker that
    // skipped a subdirectory, or silently dropped a module in an extension
    // it does not read, would pass every scan vacuously for that file. The
    // fixture is a throwaway tree so the probe owns exactly what it walks.
    const root = mkdtempSync(path.join(os.tmpdir(), 'pevo-factor-canary-walk-'));
    try {
      mkdirSync(path.join(root, 'lib', 'deep'), { recursive: true });
      writeFileSync(path.join(root, 'api.js'), 'export function fetchEmailStatus() {}\n');
      writeFileSync(path.join(root, 'lib', 'deep', 'factor.js'), 'const factor = status.hasPassword;\n');
      writeFileSync(path.join(root, 'lib', 'deep', 'sidecar.mjs'), 'export const usesPassword = status.hasPassword;\n');
      writeFileSync(path.join(root, 'lib', 'typed.ts'), '');
      writeFileSync(path.join(root, 'styles.css'), '');
      const { sources, foreign } = sourcesUnder(root);
      expect(sources.map((s) => s.rel).sort()).toEqual(['api.js', 'lib/deep/factor.js']);
      expect(sources.find((s) => s.rel === 'lib/deep/factor.js').lines[0]).toBe(
        'const factor = status.hasPassword;',
      );
      expect(foreign).toEqual(['lib/deep/sidecar.mjs', 'lib/typed.ts', 'styles.css']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('only the factor resolver and the settings rendering read name the status fetch, at pinned widths', () => {
    const { counts, sites } = occurrencesOf(sources, STATUS_FETCH_IDENT_RE, skipStatusFetchLine);
    expect(counts, `${CONSUME_THE_RESOLVER}\nstatus-fetch occurrence sites:\n${sites.join('\n')}`).toEqual(
      ALLOWED_STATUS_FETCH_SITES,
    );
  });

  it('only the fresh-auth and settings modules import the status fetch', () => {
    const importers = sources
      .filter((s) => STATUS_FETCH_IMPORT_RE.test(s.lines.join('\n')))
      .map((s) => s.rel)
      .sort();
    expect(
      importers,
      `${CONSUME_THE_RESOLVER}\nA module importing fetchEmailStatus can call it under any ` +
        'local name, so the import is a second boundary this invariant is defended at.',
    ).toEqual([...ALLOWED_STATUS_FETCH_IMPORTERS].sort());
  });

  it('only the resolver, the settings template, and the set-password patch touch hasPassword, at pinned widths', () => {
    const { counts, sites } = occurrencesOf(sources, HAS_PASSWORD_RE, isCommentLine);
    expect(
      counts,
      `${CONSUME_THE_RESOLVER}\nA factor decision can avoid calling the status fetch when ` +
        'the status object arrives second-hand, but it cannot avoid reading hasPassword.\n' +
        `password-state occurrence sites:\n${sites.join('\n')}`,
    ).toEqual(ALLOWED_PASSWORD_STATE_SITES);
  });

  it('no module re-exports the api module wholesale', () => {
    const { sites } = occurrencesOf(sources, API_EXPORT_STAR_RE, isCommentLine);
    expect(
      sites,
      `${CONSUME_THE_RESOLVER}\nA star re-export rebinds fetchEmailStatus under a new module ` +
        `path that the import-site assertion cannot see:\n${sites.join('\n')}`,
    ).toEqual([]);
  });

  it('the occurrence scan fires on aliases, indirection, and re-exports, and spares imports, prose, and the definition', () => {
    // Planted positives and negatives for the composed predicate. Without
    // them an edit that mangles a pattern leaves every scan empty and the
    // suite stays green while the canary enforces nothing. The canary file
    // itself lives outside the scanned tree, so the shapes are synthetic
    // source strings fed to the extracted matcher.
    const countsAt = (lines, i) =>
      STATUS_FETCH_IDENT_RE.test(lines[i]) && !skipStatusFetchLine(lines[i], i, lines);
    const counts = (line) => countsAt([line], 0);

    expect(counts('const status = await fetchEmailStatus();')).toBe(true);
    expect(counts('      hasPassword = (await fetchEmailStatus())?.data?.hasPassword;')).toBe(true);
    // The alias, in both quote styles. This is the shape a call-shaped
    // pattern is blind to, and the reason the scan matches the name.
    expect(counts("import { fetchEmailStatus as fetchStatus } from '../api.js';")).toBe(true);
    expect(counts('import { fetchEmailStatus as fetchStatus } from "../api.js";')).toBe(true);
    // Duplicate specifiers for one exported name are legal; the unaliased
    // half must not buy the aliased half a skip.
    expect(counts("import { fetchEmailStatus, fetchEmailStatus as f } from '../api.js';")).toBe(true);
    // Indirection, a namespace-qualified call, and an object literal holding
    // the reference. All hold a usable second answer.
    expect(counts('const f = fetchEmailStatus;')).toBe(true);
    expect(counts('const res = await api.fetchEmailStatus();')).toBe(true);
    expect(counts('  fetchEmailStatus };')).toBe(true);
    // A single-line re-export is a new road to the function.
    expect(counts("export { fetchEmailStatus } from './api.js';")).toBe(true);

    // Unaliased imports, in both quote styles, are spared.
    expect(counts("import { fetchEmailStatus } from '../api.js';")).toBe(false);
    expect(counts('import { fetchEmailStatus } from "../api.js";')).toBe(false);
    expect(counts("import { fetchEmailStatus, submitEmail } from '../api.js';")).toBe(false);
    // Prose and dead code are not occurrences: a commented-out call can
    // neither trip the scan nor keep a licensed member's key alive.
    expect(counts('// const status = await fetchEmailStatus();')).toBe(false);
    expect(counts(' * fetchEmailStatus is consulted by the resolver on this surface')).toBe(false);
    expect(counts('export function fetchEmailStatus() {')).toBe(false);
    // A different identifier that merely starts with the name does not match.
    expect(counts("const status = await fetchEmailStatusV2();")).toBe(false);

    // A multi-line import: the bare specifier is spared only while unaliased.
    const wrappedPlain = [
      'import {',
      '  startOrcid,',
      '  fetchEmailStatus,',
      "} from '../api.js';",
    ];
    expect(countsAt(wrappedPlain, 2)).toBe(false);
    const wrappedAliased = [
      'import {',
      '  fetchEmailStatus as fetchStatus,',
      "} from '../api.js';",
    ];
    expect(countsAt(wrappedAliased, 1)).toBe(true);
    // The alias split across the wrap: the specifier line alone satisfies the
    // bare-name skip and a per-line veto never sees the `as`, so the veto
    // runs against the joined statement.
    const splitAlias = [
      'import {',
      '  fetchEmailStatus',
      '    as fetchStatus,',
      "} from '../api.js';",
    ];
    expect(countsAt(splitAlias, 1)).toBe(true);
    // A multi-line RE-EXPORT block: same specifier shape, export opener, so
    // the skip does not apply and the specifier counts.
    const reExportBlock = [
      'export {',
      '  fetchEmailStatus,',
      "} from './api.js';",
    ];
    expect(countsAt(reExportBlock, 1)).toBe(true);
    // A complete single-line import is never joined with its neighbours, so
    // an adjacent prose line cannot veto it into a false positive.
    const completeThenNoise = [
      "import { fetchEmailStatus } from '../api.js';",
      '// prose: fetchEmailStatus as documented above',
    ];
    expect(countsAt(completeThenNoise, 0)).toBe(false);
    // A live reference a few lines BELOW a complete single-line import: the
    // walk up from the specifier-shaped line reaches that import's opener,
    // but the import closed on its own line and must not lend the member
    // its skip. A terminator on a line above the specifier is tested before
    // the opener for exactly this shape, in both the object-literal-member
    // and the call-argument form.
    const memberBelowCompleteImport = [
      "import { submitEmail } from '../api.js';",
      'const statusSources = {',
      '  fetchEmailStatus,',
      '};',
    ];
    expect(countsAt(memberBelowCompleteImport, 2)).toBe(true);
    const argumentBelowCompleteImport = [
      "import { startOrcid } from '../api.js';",
      '',
      'registerStatusSources([',
      '  fetchEmailStatus,',
      ']);',
    ];
    expect(countsAt(argumentBelowCompleteImport, 3)).toBe(true);
    // The genuine multi-line import is still spared, and a comment inside
    // the clause is neither a terminator nor an opener.
    const wrappedWithComment = [
      'import {',
      '  // status probes come from the api module',
      '  fetchEmailStatus,',
      "} from '../api.js';",
    ];
    expect(countsAt(wrappedWithComment, 2)).toBe(false);
  });

  it('the import matcher fires on every named import of the status fetch and on nothing else', () => {
    expect(
      STATUS_FETCH_IMPORT_RE.test(
        "import {\n  startOrcid,\n  fetchEmailStatus,\n  mintSessionAuthProof,\n} from '../api.js';",
      ),
    ).toBe(true);
    // An alias is still an import, and so is a double-quoted specifier.
    expect(STATUS_FETCH_IMPORT_RE.test("import { fetchEmailStatus as f } from '../api.js';")).toBe(true);
    expect(STATUS_FETCH_IMPORT_RE.test('import { fetchEmailStatus } from "./api.js";')).toBe(true);
    expect(STATUS_FETCH_IMPORT_RE.test("import { fetchEmailStatus } from '../api';")).toBe(true);
    expect(STATUS_FETCH_IMPORT_RE.test("import { submitEmail } from '../api.js';")).toBe(false);
    expect(STATUS_FETCH_IMPORT_RE.test("import { fetchEmailStatus } from './status.js';")).toBe(false);
    // No specifier braces to match; the occurrence scan catches usage sites.
    expect(STATUS_FETCH_IMPORT_RE.test("import * as api from '../api.js';")).toBe(false);
  });

  it('the star re-export matcher fires on wholesale rebinding of the api module only', () => {
    expect(API_EXPORT_STAR_RE.test("export * from './api.js';")).toBe(true);
    expect(API_EXPORT_STAR_RE.test("export * as api from '../api.js';")).toBe(true);
    expect(API_EXPORT_STAR_RE.test('export * from "./api.js";')).toBe(true);
    expect(API_EXPORT_STAR_RE.test("export * from '../api';")).toBe(true);
    expect(API_EXPORT_STAR_RE.test("export * from './api-helpers.js';")).toBe(false);
    expect(API_EXPORT_STAR_RE.test("export * from './auth.js';")).toBe(false);
    expect(API_EXPORT_STAR_RE.test("export { fetchEmailStatus } from './api.js';")).toBe(false);
  });

  it('a second derivation in an already-licensed file produces its own distinct site entry', () => {
    // End-to-end planted probe through the same occurrence walk the
    // whole-tree assertions run: two reads in two functions of ONE file must
    // yield two distinct keys, so a licensed file cannot absorb its own
    // second offender. This is the collapse a file-granular collector cannot
    // see.
    const twoSites = {
      rel: 'pages/settings.js',
      lines: [
        'async function loadEmailStatus() {',
        '  const res = await fetchEmailStatus();',
        '}',
        '',
        'async function decideFactorLocally() {',
        '  const res = await fetchEmailStatus();',
        '  return res?.data?.hasPassword === true;',
        '}',
      ],
    };
    expect(occurrencesOf([twoSites], STATUS_FETCH_IDENT_RE, skipStatusFetchLine).keys).toEqual([
      'pages/settings.js#decideFactorLocally',
      'pages/settings.js#loadEmailStatus',
    ]);

    // A commented-out call contributes nothing: it must not satisfy the
    // licensed set, and it must not read as a violation either.
    const commentedOut = {
      rel: 'pages/anything.js',
      lines: [
        'async function probe() {',
        '  // const res = await fetchEmailStatus();',
        '}',
      ],
    };
    expect(occurrencesOf([commentedOut], STATUS_FETCH_IDENT_RE, skipStatusFetchLine).keys).toEqual([]);

    // An aliased import surfaces at module scope, which is never a licensed
    // key, so the alias itself is the red bar.
    const aliased = {
      rel: 'pages/anything.js',
      lines: [
        "import { fetchEmailStatus as fetchStatus } from '../api.js';",
        '',
        'async function probe() {',
        '  return (await fetchStatus())?.data?.hasPassword;',
        '}',
      ],
    };
    expect(occurrencesOf([aliased], STATUS_FETCH_IDENT_RE, skipStatusFetchLine).keys).toEqual([
      `pages/anything.js#${MODULE_SCOPE}`,
    ]);
  });

  it('an occurrence added under a licensed key widens its pinned count instead of hiding', () => {
    // The two absorbing shapes the width pin exists for. A key-level set
    // alone is blind to both: the added occurrence resolves to a key that is
    // already licensed, so key set-equality stays green with the violation
    // live. The pinned per-key count is the discriminator.

    // COLLISION: the module's in-flight idiom names two coalescers' locals
    // identically, so a derivation planted inside the unlicensed coalescer
    // resolves to the licensed key. Its count is what refuses the absorb.
    const collidingCoalescers = {
      rel: 'lib/fresh-auth.js',
      lines: [
        'export async function resolvePasswordFactor() {',
        '  const flight = (async () => {',
        '    const status = await fetchEmailStatus();',
        '  })();',
        '}',
        '',
        'async function acquireSessionProof() {',
        '  const flight = (async () => {',
        '    const hasPassword = (await fetchEmailStatus())?.data?.hasPassword;',
        '  })();',
        '}',
      ],
    };
    const { counts: fetchCounts } = occurrencesOf(
      [collidingCoalescers],
      STATUS_FETCH_IDENT_RE,
      skipStatusFetchLine,
    );
    expect(fetchCounts).toEqual({ 'lib/fresh-auth.js#flight': 2 });
    expect(fetchCounts['lib/fresh-auth.js#flight']).not.toBe(
      ALLOWED_STATUS_FETCH_SITES['lib/fresh-auth.js#flight'],
    );

    // EXTENT: every read inside the one wide template literal resolves to
    // the template's key, so an inline factor expression in the markup adds
    // width rather than a member. The section gate alone is one unit; the
    // gate plus an inline decision is two.
    const gateOnly = {
      rel: 'pages/settings.js',
      lines: [
        'const template = `',
        '  <template x-if="emailStatus.hasPassword === false">',
        '  </template>',
        '`;',
      ],
    };
    const gatePlusInlineDecision = {
      rel: 'pages/settings.js',
      lines: [
        'const template = `',
        '  <template x-if="emailStatus.hasPassword === false">',
        '  </template>',
        '  <button @click="emailStatus.hasPassword ? openPasswordModal() : startOrcidRedirect()">',
        '`;',
      ],
    };
    expect(occurrencesOf([gateOnly], HAS_PASSWORD_RE, isCommentLine).counts).toEqual({
      'pages/settings.js#template': 1,
    });
    expect(occurrencesOf([gatePlusInlineDecision], HAS_PASSWORD_RE, isCommentLine).counts).toEqual({
      'pages/settings.js#template': 2,
    });

    // SAME LINE: a second read placed beside a licensed one on the same
    // line adds no line, so a per-line tally would keep the pin satisfied.
    // Occurrences are counted per match, so the width moves anyway. The
    // resolver's own status assignment is this shape (it names the property
    // on both sides of the `=`), which is why its pinned width exceeds its
    // line count.
    const gateWithSameLineSecondRead = {
      rel: 'pages/settings.js',
      lines: [
        'const template = `',
        '  <template x-if="emailStatus.hasPassword === false || emailStatus.hasPassword === undefined">',
        '  </template>',
        '`;',
      ],
    };
    expect(occurrencesOf([gateWithSameLineSecondRead], HAS_PASSWORD_RE, isCommentLine).counts).toEqual({
      'pages/settings.js#template': 2,
    });
    const twoFetchesOneLine = {
      rel: 'lib/fresh-auth.js',
      lines: [
        '  const flight = (async () => {',
        '    const [a, b] = await Promise.all([fetchEmailStatus(), fetchEmailStatus()]);',
        '  })();',
      ],
    };
    expect(occurrencesOf([twoFetchesOneLine], STATUS_FETCH_IDENT_RE, skipStatusFetchLine).counts).toEqual({
      'lib/fresh-auth.js#flight': 2,
    });
  });

  it('the password-state scan sees reads a factor decision cannot avoid writing', () => {
    const passwordStateKeys = (file) => occurrencesOf([file], HAS_PASSWORD_RE, isCommentLine).keys;
    // Property read, destructuring, and bracket access all write the name.
    expect(
      passwordStateKeys({
        rel: 'pages/anything.js',
        lines: ['function pick(status) {', '  return status.hasPassword === true;', '}'],
      }),
    ).toEqual(['pages/anything.js#pick']);
    expect(
      passwordStateKeys({
        rel: 'pages/anything.js',
        lines: ['function pick(res) {', '  const { hasPassword } = res.data;', '  return hasPassword;', '}'],
      }),
    ).toEqual(['pages/anything.js#pick']);
    expect(
      passwordStateKeys({
        rel: 'pages/anything.js',
        lines: ['function pick(data) {', "  return data['hasPassword'];", '}'],
      }),
    ).toEqual(['pages/anything.js#pick']);
    // A leading inline block comment (a coverage pragma, say) does not make
    // the rest of the line prose: the read behind it is live and counts.
    expect(
      passwordStateKeys({
        rel: 'pages/anything.js',
        lines: ['function pick(status) {', '  /* v8 ignore next */ return status.hasPassword === true;', '}'],
      }),
    ).toEqual(['pages/anything.js#pick']);
    // Prose is spared.
    expect(
      passwordStateKeys({
        rel: 'pages/anything.js',
        lines: ['// hasPassword drives the factor choice', 'function pick() {}'],
      }),
    ).toEqual([]);
  });

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
    expect(isCommentLine('const usesPassword = status.hasPassword; // trailing prose')).toBe(false);
    expect(isCommentLine('')).toBe(false);
  });

  it('the enclosing-symbol resolver names component methods, template literals, and locals, not files', () => {
    // The granularity every assertion above rests on. A resolver that
    // returned one label per file would collapse the canary to file
    // granularity while every planted probe stayed green.
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
});

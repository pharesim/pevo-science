/**
 * Standing source-discipline canary for `agents/docs/ARCHITECTURE.md` § 6.5
 * invariant #9: a session-proof window is never opened by session
 * establishment.
 *
 * A session-kind fresh-auth proof is target-less and multi-use for a bounded
 * window, so whoever holds one can broadcast and upload for the rest of that
 * window. § 6.4.1 licenses exactly two routes to open one, and both are an
 * explicit re-auth act on top of an already-authenticated session:
 *
 *   - `POST /api/custody/session-auth` — a password entry, argon2-verified.
 *   - `POST /api/orcid/callback mode='session_auth'` — a completed ORCID OAuth
 *     round-trip whose returned iD must equal the one linked to the account.
 *
 * Why a mechanical check rather than trusting review: the prohibited shape is
 * the one that looks most reasonable to a future author. "The user just proved
 * their password at `/login`, why send them through a second prompt before they
 * can vote?" is a sympathetic product ask, and the code that grants it is two
 * lines in a handler that already has the username in hand. `handleLogin` and
 * `handleSessionAuth` are sibling branches of ONE `/api/orcid/callback`
 * dispatch, both fed by a genuine OAuth round-trip, which makes minting on the
 * login branch look like a consistency fix rather than a security regression.
 * `POST /api/auth/signup-verify/confirm` is worse still: its documented
 * best-effort-JWT contract lets a fast retry mint a second JWT, so a proof
 * minted there would be minted twice per finalization.
 *
 * If any of those lands, invariant #1 ("critical actions require a fresh re-auth
 * proof") is satisfied in form and dead in substance: holding a session would
 * once again be enough to broadcast, which is the exact property the fresh-auth
 * layer exists to deny. The failure is silent — every test still passes, the
 * proof is still required on the wire, and the only thing that changed is that
 * possession of a JWT now produces one.
 *
 * GRANULARITY. The occurrence assertion is over `file#symbol` pairs, not over
 * files. The two licensed mints live in `routes/orcid.ts` and
 * `routes/custody.ts`, and `routes/orcid.ts` is where the most likely violation
 * lands: `handleLogin` sits beside `handleSessionAuth` in the same dispatch. A
 * file-set assertion cannot express "this file may mint, but only from that one
 * handler". The import assertion below is deliberately the other way round, file
 * granular, because an import statement always sits at module scope and the
 * symbol half of every key would be the constant module-scope label.
 *
 * SCOPE AND DETECTION. Every `.ts` file under `src/` is scanned,
 * `lib/fresh-auth.ts` included. Detection is a match on the mint's NAME, not on
 * a call shape: a call-shaped pattern is defeated by one line, since
 * `import { issueSessionFreshAuthToken as mint }` renames every call site to
 * `mint(...)`, and the aliasing caller writes no `kind: 'session'` literal for
 * the construction scan below to catch either. Matching the name catches the
 * alias at the import, which is the last place the real name is forced to
 * appear. The cost is that the definition, prose, and plain import specifiers
 * match too, so they are removed by an explicit skip predicate rather than by
 * the pattern's shape — and the specifier skip is VETOED by an `as` on the line,
 * which is the mechanism the alias catch turns on. A trailing prose mention of
 * the mint on a code line counts and goes red; stripping comment tails before
 * testing was considered and rejected, because a naive strip truncates at a
 * marker inside a string literal and would let a real reference hide behind a
 * URL. Reword the comment instead.
 *
 * The exact-set assertion is the load-bearing half: it catches a mint added in
 * a brand-new file or a brand-new handler, which a forbidden-file list never
 * would. The forbidden-file assertion exists on top of it to name the
 * sympathetic cases explicitly, so a red bar there reads as "this is invariant
 * #9" rather than "the allowlist needs updating".
 *
 * Two further scans cover what a name-based canary structurally cannot.
 *
 * A window minted inside `lib/fresh-auth.ts` by NEW code under a different name
 * writes the mint's name nowhere, but it cannot avoid writing the
 * `kind: 'session'` discriminator, so the enclosing symbols of that literal are
 * pinned too. That scan is quote-, comma- and key-quoting-agnostic on purpose:
 * nothing in this package enforces any of them (the ESLint config is
 * safety-only, with no `quotes` and no `comma-dangle` rule, and there is no
 * prettier config in the repo), so keying on them made a name-independent
 * backstop defeatable by a style choice. It remains line-oriented, so a session
 * entry assembled by spread or by shorthand property is outside its reach, a
 * residual worth knowing about since the shorthand shape is already idiomatic in
 * the module it guards.
 *
 * And a helper that spread-copies an already validated entry with a pushed-out
 * deadline extends a window while writing neither the mint's name nor the
 * discriminator. `persistSessionSlide` is the chokepoint every such helper must
 * reach, and the clamp to the cap plus the revocation-epoch check both live in
 * its one legitimate caller, so that caller set is pinned as well.
 *
 * Finally, a coverage registry. The scans above stop a mint that still LOOKS
 * like one; the registry stops the other half, a brand-new route that issues a
 * session and that nobody remembered to assert a proof-free response for.
 *
 * A checked non-issue, recorded so it is not "fixed" later: the sibling sweep
 * scan in `tests/routes/session-proof-invalidation.test.ts` is a REQUIRED-call
 * canary, so an alias there makes a writer look unswept and fails closed. It
 * needs no equivalent change.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  MODULE_SCOPE,
  enclosingSymbol,
  isCommentLine,
  occurrencesOf,
  sourcesUnder,
} from '../support/enclosing-symbol.js';

/** ANY textual occurrence of the mint's name, not a call-shaped one. See the
 *  file docblock for why the call shape was abandoned. */
const SESSION_MINT_IDENT_RE = /\bissueSessionFreshAuthToken\b/;

/** The definition line. Skipped by shape so the module that defines the mint is
 *  still scanned for references to it. */
const SESSION_MINT_DEFINITION_RE = /function\s+issueSessionFreshAuthToken\s*\(/;

/** An UNALIASED named-import specifier for the mint, in every shape written
 *  here: its own line inside a multi-line import, the last specifier followed by
 *  a closing brace and `from`, and the single-line form. Taking a plain
 *  reference to the mint is not minting, so these are spared; WHICH modules may
 *  take that reference is pinned separately by the import-site assertion.
 *
 *  The closing-brace branch requires a following `from` rather than accepting a
 *  bare brace, because an unanchored closing brace also spares an object literal
 *  (`  issueSessionFreshAuthToken };`), which is a way to hold the reference
 *  without producing a counted occurrence. Every real import ends with a brace
 *  and `from`; an object literal does not. */
const SESSION_MINT_IMPORT_SPECIFIER_RE =
  /^\s*(?:import\s*\{[^}]*?)?issueSessionFreshAuthToken\s*(?:,|\}\s*from\b|$)/;

/** The identifier renamed at the import. Its presence VETOES the specifier skip,
 *  and that veto is the mechanism the whole scan turns on.
 *
 *  Two reasons the veto cannot be folded into the specifier pattern by simply
 *  omitting an `as` branch. First, the specifier pattern is satisfied by the
 *  FIRST specifier on a line, and duplicate specifiers for one exported name
 *  with distinct local bindings are legal, so an import naming the mint twice
 *  would be skipped on the strength of its unaliased half while handing the file
 *  a working alias. Second, the veto is what makes an alias introduced INSIDE an
 *  already-licensed module visible: unskipped, the specifier is a module-scope
 *  occurrence, hence a new `file#symbol` member, hence a red bar, which is the
 *  one case a file-granular import assertion structurally cannot see. */
const SESSION_MINT_ALIAS_RE = /\bissueSessionFreshAuthToken\s+as\b/;

/** The three shapes that name the mint without holding a callable reference
 *  under a new name: its own definition, a whole-comment line, and an unaliased
 *  import specifier. Everything else that writes the name counts. */
const skipMintLine = (line: string): boolean =>
  SESSION_MINT_DEFINITION_RE.test(line) ||
  isCommentLine(line) ||
  (SESSION_MINT_IMPORT_SPECIFIER_RE.test(line) && !SESSION_MINT_ALIAS_RE.test(line));

/** A named import of the mint, matched against whole file text because both
 *  licensed imports are multi-line: no single line carries both the specifier
 *  and the module path that identifies it. Matches the aliased form too, so a
 *  module that pulls in the mint under any name is a member.
 *
 *  Anchored on the `.js` specifier this build requires. A module reached by some
 *  other spelling would be absent rather than a member, which shrinks the set
 *  instead of failing it; that leg is covered by the occurrence scan, which sees
 *  the reference line regardless of how the module was named. */
const SESSION_MINT_IMPORT_RE =
  /import\s*\{[^}]*\bissueSessionFreshAuthToken\b[^}]*\}\s*from\s*'[^']*fresh-auth\.js'/;

/** The session discriminator written as an object-literal field, in any quote
 *  style TypeScript accepts, with or without a trailing comma, and with the key
 *  itself quoted or not.
 *
 *  Accepted false positive, loud rather than silent: allowing whitespace before
 *  the colon also matches a ternary whose alternative is the literal. That is a
 *  red bar naming a symbol, which is the safe direction; refusing the whitespace
 *  would instead let `kind : 'session',` construct a window unseen. */
const SESSION_KIND_RE = /\bkind\b['"`\]\s]*:\s*(['"`])session\1/;

/** Occurrences that NAME the kind in TYPE position rather than construct an
 *  entry, removed from the line before the construction test runs. Two shapes
 *  exist and both must stay out of the scan: a union member inside a type
 *  literal, terminated by a semicolon, which object-literal syntax cannot carry;
 *  and a type-literal argument to a utility type, closed by a brace and an angle
 *  bracket.
 *
 *  Removal is per-OCCURRENCE, not a whole-line skip, because a whole-line skip
 *  keyed on a utility-type NAME hides a construction that merely shares the line
 *  with one, and a typed local declared from a narrowed type is the natural way
 *  to write exactly that. Stripping the type occurrence leaves the construction
 *  behind, where the scan still sees it.
 *
 *  Accepted false positive, again loud: a type narrowing wrapped so that the
 *  braced field sits alone on its line carries neither terminator and is read as
 *  construction. No such line exists under `src/` today. */
const SESSION_KIND_TYPE_OCCURRENCE_RE = /\bkind\b['"`\]\s]*:\s*(['"`])session\1\s*(?:;|\}\s*>)/g;

/** The construction-site predicate the scan applies, shared with the planted
 *  self-test below so the two cannot drift apart. `SESSION_KIND_RE` carries no
 *  global flag on purpose: only the stripping regex is global, and a global
 *  regex is stateful under `.test`. */
const constructsSessionEntry = (line: string): boolean =>
  !isCommentLine(line) && SESSION_KIND_RE.test(line.replace(SESSION_KIND_TYPE_OCCURRENCE_RE, ''));

/** A reference to the private slide persister, and its definition line. */
const SESSION_SLIDE_CALL_RE = /\bpersistSessionSlide\b/;
const SESSION_SLIDE_DEFINITION_RE = /function\s+persistSessionSlide\s*\(/;

/** A call that mints a session JWT. Every one is a surface where a proof could
 *  be attached to an established session. */
const JWT_MINT_RE = /\bjwt\.sign\s*\(/;

/** The only two handlers licensed to mint, one per factor (§ 6.4.1). */
const ALLOWED_MINT_SITES = [
  'routes/custody.ts#POST /session-auth',
  'routes/orcid.ts#handleSessionAuth',
];

/** The only modules allowed to hold a reference to the mint at all.
 *  `lib/fresh-auth.ts` defines it and therefore imports nothing. */
const ALLOWED_MINT_IMPORTERS = ['routes/custody.ts', 'routes/orcid.ts'];

/** The only two places a session-kind entry is constructed: the mint, and the
 *  slide that rewrites one entry into its successor. */
const ALLOWED_SESSION_ENTRY_SITES = [
  'lib/fresh-auth.ts#consumeSessionWindow',
  'lib/fresh-auth.ts#issueSessionFreshAuthToken',
];

/** The slide persister's only legitimate caller: the windowed consume, where
 *  the clamp to the cap and the revocation-epoch check live. */
const ALLOWED_SESSION_SLIDE_SITES = ['lib/fresh-auth.ts#consumeSessionWindow'];

/** Every handler that mints or reissues a session JWT. Each one is covered by a
 *  wire-level no-proof assertion against its real 200 response:
 *  `session-establishment-mints-no-window` (login, confirm, session),
 *  `session-proof-invalidation` (recover, recover/verify), `orcid` (login mode),
 *  `signup-verify` (link), `custody-upgrade` (upgrade). */
const SESSION_ISSUING_SITES = [
  'routes/auth.ts#POST /login',
  'routes/auth.ts#POST /session',
  'routes/custody.ts#POST /upgrade',
  'routes/orcid.ts#handleLogin',
  'routes/recover.ts#POST /recover',
  'routes/recover.ts#POST /recover/verify',
  'routes/signup-verify.ts#POST /confirm',
  'routes/signup-verify.ts#POST /link',
];

/** Session-establishment and account-recovery surfaces, named explicitly so a
 *  mint landing in one produces a message that says what rule it broke. */
const FORBIDDEN_MINT_FILES = [
  'routes/auth.ts',
  'routes/signup-verify.ts',
  'routes/recover.ts',
  'middleware/verifyHiveSignature.ts',
];

const sources = sourcesUnder(path.resolve(__dirname, '..', '..', 'src'));

describe('invariant #9 — no session-proof mint outside the two re-auth routes', () => {
  it('walks a plausible number of source files (guards against a broken walker)', () => {
    // Without this, a walker that returned nothing would make every assertion
    // below vacuously true and the canary would enforce nothing.
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.map((s) => s.rel)).toContain('lib/fresh-auth.ts');
  });

  it('only the password and ORCID re-auth handlers hold a callable reference to the session-proof mint', () => {
    const { keys, sites } = occurrencesOf(sources, SESSION_MINT_IDENT_RE, skipMintLine);
    expect(keys, `session-proof mint occurrence sites:\n${sites.join('\n')}`).toEqual(
      [...ALLOWED_MINT_SITES].sort(),
    );
  });

  it('only the two re-auth route modules import the session-proof mint', () => {
    const importers = sources
      .filter((s) => SESSION_MINT_IMPORT_RE.test(s.lines.join('\n')))
      .map((s) => s.rel)
      .sort();
    expect(
      importers,
      'a module that imports the mint can call it under any local name, so the ' +
        'import is a second boundary this invariant is defended at, not only the ' +
        'call site',
    ).toEqual([...ALLOWED_MINT_IMPORTERS].sort());
  });

  it('only the mint and the slide construct a session-kind entry', () => {
    // Name-independent backstop. A helper added inside lib/fresh-auth.ts that
    // opens a window under some other name calls nothing this canary greps for,
    // but it cannot avoid writing the discriminator.
    const { keys, sites } = occurrencesOf(
      sources,
      SESSION_KIND_RE,
      (line) => !constructsSessionEntry(line),
    );
    expect(keys, `session-kind entry construction sites:\n${sites.join('\n')}`).toEqual(
      [...ALLOWED_SESSION_ENTRY_SITES].sort(),
    );
  });

  it('only the windowed consume persists a slid window', () => {
    const { keys, sites } = occurrencesOf(
      sources,
      SESSION_SLIDE_CALL_RE,
      (line) => SESSION_SLIDE_DEFINITION_RE.test(line) || isCommentLine(line),
    );
    expect(
      keys,
      'a second caller of the slide persister can push a window past its idle ' +
        'deadline without writing the kind discriminator and without naming the ' +
        `mint, so neither scan above would see it:\n${sites.join('\n')}`,
    ).toEqual([...ALLOWED_SESSION_SLIDE_SITES].sort());
  });

  it('no session-establishment or recovery route opens a window as a side effect', () => {
    const scanned = sources.filter((s) => FORBIDDEN_MINT_FILES.includes(s.rel));
    expect(scanned.length, 'a forbidden file was renamed or removed').toBe(
      FORBIDDEN_MINT_FILES.length,
    );
    // On a session-establishment or recovery module even HOLDING a reference is
    // the violation, so the unaliased-specifier skip is deliberately not applied
    // here; only prose is spared.
    const { sites } = occurrencesOf(scanned, SESSION_MINT_IDENT_RE, isCommentLine);
    expect(
      sites,
      'a session-proof window must be opened only by an explicit re-auth act, ' +
        'never as a side effect of logging in, refreshing a token, finalizing a ' +
        `signup, or recovering an account:\n${sites.join('\n')}`,
    ).toEqual([]);
  });

  it('every session-issuing handler has a wire-level no-proof assertion', () => {
    // The scans above stop a mint that still looks like one. This stops the
    // other half: a brand-new route that issues a session and that nobody
    // remembered to assert against. A new entry here is a red bar that says "add
    // the response assertion, then pin the site" — the set IS the registry, and
    // it is deliberately unpleasant to extend without doing both.
    const { keys, sites } = occurrencesOf(sources, JWT_MINT_RE, isCommentLine);
    expect(keys, `session JWT mint sites:\n${sites.join('\n')}`).toEqual(
      [...SESSION_ISSUING_SITES].sort(),
    );
  });

  it('the occurrence scan fires on aliases and indirection and spares imports, prose, and the definition', () => {
    // Planted positives and negatives. Without them the scans above can silently
    // no-op: an edit that mangles the pattern leaves every result empty and the
    // suite stays green while the canary enforces nothing. They exercise the
    // COMPOSED predicate, because under a name match the regex alone no longer
    // encodes the semantics.
    const counts = (line: string): boolean =>
      SESSION_MINT_IDENT_RE.test(line) && !skipMintLine(line);

    expect(counts("const issued = await issueSessionFreshAuthToken(username, 'password');")).toBe(true);
    expect(counts('  issueSessionFreshAuthToken (username, mechanism)')).toBe(true);
    // The alias, in every shape it can take. This is the case a call-shaped
    // pattern was blind to, and the reason the scan matches the name.
    expect(counts('  issueSessionFreshAuthToken as mint,')).toBe(true);
    expect(counts('  issueSessionFreshAuthToken as mint')).toBe(true);
    expect(counts("import { issueSessionFreshAuthToken as mint } from '../lib/fresh-auth.js';")).toBe(true);
    expect(counts("import {issueSessionFreshAuthToken as mint} from '../lib/fresh-auth.js';")).toBe(true);
    expect(counts("  issueSessionFreshAuthToken as mint } from '../lib/fresh-auth.js';")).toBe(true);
    // Duplicate specifiers for one exported name are legal; the unaliased half
    // must not buy the aliased half a skip.
    expect(
      counts(
        "import { issueSessionFreshAuthToken, issueSessionFreshAuthToken as mint } from '../lib/fresh-auth.js';",
      ),
    ).toBe(true);
    // Indirection without an `as`, an object literal rather than an import, and
    // a namespace-qualified call. All three hold a callable reference.
    expect(counts('const mint = issueSessionFreshAuthToken;')).toBe(true);
    expect(counts('  issueSessionFreshAuthToken };')).toBe(true);
    expect(counts("  const issued = await freshAuth.issueSessionFreshAuthToken(username, 'password');")).toBe(true);

    expect(counts('  issueSessionFreshAuthToken,')).toBe(false);
    expect(counts('  issueSessionFreshAuthToken')).toBe(false);
    expect(counts("import { issueSessionFreshAuthToken } from '../lib/fresh-auth.js';")).toBe(false);
    expect(counts("import {issueSessionFreshAuthToken} from '../lib/fresh-auth.js';")).toBe(false);
    expect(counts("import { issueFreshAuthToken, issueSessionFreshAuthToken } from '../lib/fresh-auth.js';")).toBe(false);
    expect(counts("  issueSessionFreshAuthToken } from '../lib/fresh-auth.js';")).toBe(false);
    expect(counts(' * consumed by `issueSessionFreshAuthToken` on the session surface')).toBe(false);
    expect(counts('// session-kind (issueSessionFreshAuthToken) entries share this single')).toBe(false);
    expect(counts('export async function issueSessionFreshAuthToken(')).toBe(false);
    // The consent-op mint is a different function with a different contract and
    // is licensed on more routes; it must not be swept up by this canary.
    expect(counts("await issueFreshAuthToken(username, 'password', target);")).toBe(false);
    // The documented edge of a name-based scan: a mint under a NEW name is out
    // of reach here by construction, which is what the discriminator and slide
    // scans exist to cover.
    expect(counts("await issueSessionFreshAuthTokenV2(username, 'password');")).toBe(false);

    // The definition line matches the name and is skipped by shape, so the
    // module that defines the mint stays scanned for references to it.
    expect(SESSION_MINT_DEFINITION_RE.test('export async function issueSessionFreshAuthToken(')).toBe(true);
    expect(SESSION_MINT_DEFINITION_RE.test("  const issued = await issueSessionFreshAuthToken(username, 'password');")).toBe(false);
  });

  it('the import matcher fires on every import of the mint and on nothing else', () => {
    expect(
      SESSION_MINT_IMPORT_RE.test(
        "import {\n  issueFreshAuthToken,\n  issueSessionFreshAuthToken,\n  type FreshAuthTarget,\n} from '../lib/fresh-auth.js';",
      ),
    ).toBe(true);
    // An alias is still an import.
    expect(
      SESSION_MINT_IMPORT_RE.test(
        "import {\n  issueSessionFreshAuthToken as mint,\n} from '../lib/fresh-auth.js';",
      ),
    ).toBe(true);
    expect(SESSION_MINT_IMPORT_RE.test("import { issueSessionFreshAuthToken } from '../lib/fresh-auth.js';")).toBe(true);
    expect(SESSION_MINT_IMPORT_RE.test("import { invalidateSessionFreshAuthTokens } from '../lib/fresh-auth.js';")).toBe(false);
    expect(SESSION_MINT_IMPORT_RE.test("import { issueFreshAuthToken } from '../lib/fresh-auth.js';")).toBe(false);
    // No specifier to match; the occurrence scan catches its call site instead.
    expect(SESSION_MINT_IMPORT_RE.test("import * as freshAuth from '../lib/fresh-auth.js';")).toBe(false);
  });

  it('the construction matcher is not defeated by quote style or a trailing comma', () => {
    expect(constructsSessionEntry("    kind: 'session',")).toBe(true);
    // Quote style, the trailing comma, and whether the key itself is quoted are
    // enforced by nothing in this package. A construction written in any of
    // these styles must still be caught; every one was a silent pass before.
    expect(constructsSessionEntry('    kind: "session",')).toBe(true);
    expect(constructsSessionEntry('    kind: `session`,')).toBe(true);
    expect(constructsSessionEntry("    kind:'session'")).toBe(true);
    expect(constructsSessionEntry("    kind: 'session'")).toBe(true);
    expect(constructsSessionEntry("  const entry = { kind: 'session' };")).toBe(true);
    expect(constructsSessionEntry("  'kind': 'session',")).toBe(true);
    expect(constructsSessionEntry('  "kind": "session",')).toBe(true);
    expect(constructsSessionEntry("    kind: 'session' as const,")).toBe(true);
    // A construction sharing its line with a utility type. The type occurrence
    // is stripped, the construction survives the strip and is caught. A skip
    // keyed on the utility NAME hid all three of these.
    expect(
      constructsSessionEntry(
        "  const next: Extract<ValidatedEntry, { kind: 'session' }> = { kind: 'session', username };",
      ),
    ).toBe(true);
    expect(
      constructsSessionEntry("  const stored: Omit<StoredEntry, 'nonce'> = { kind: 'session', username };"),
    ).toBe(true);
    expect(constructsSessionEntry("  return { kind: 'session', username } as Pick<Entry, 'kind'>;")).toBe(true);

    expect(constructsSessionEntry("  if (entry.kind === 'session') {")).toBe(false);
    // Type positions, not construction. Both name the kind without building an
    // entry, and both live in lib/fresh-auth.ts today.
    expect(constructsSessionEntry("      kind: 'session';")).toBe(false);
    expect(constructsSessionEntry("  entry: Extract<ValidatedEntry, { kind: 'session' }>,")).toBe(false);
    expect(
      constructsSessionEntry("  entry: Extract<ValidatedEntry, { kind: 'session'; username: string }>,"),
    ).toBe(false);
    expect(constructsSessionEntry(" *   - a `kind: 'session'` entry (target-less, minted by")).toBe(false);
    // A different discriminator value, and a different identifier that merely
    // ends in the word. Neither may be swept into this scan.
    expect(constructsSessionEntry("    kind: 'consent_op',")).toBe(false);
    expect(constructsSessionEntry("  const operation_kind: 'session' = x;")).toBe(false);

    expect(isCommentLine(" *   - a `kind: 'session'` entry (target-less, minted by")).toBe(true);
    expect(isCommentLine("    kind: 'session',")).toBe(false);
  });

  it('the slide and session-JWT matchers fire on a call and spare the definition and prose', () => {
    expect(SESSION_SLIDE_CALL_RE.test('  void persistSessionSlide(token, slid, now, fromMemStore);')).toBe(true);
    expect(SESSION_SLIDE_DEFINITION_RE.test('async function persistSessionSlide(')).toBe(true);
    expect(SESSION_SLIDE_DEFINITION_RE.test('  void persistSessionSlide(token, slid, now, fromMemStore);')).toBe(false);
    expect(JWT_MINT_RE.test('    const token = jwt.sign(')).toBe(true);
    // Prose that merely names the mint has no open paren and does not match;
    // prose that quotes the call shape does, and is spared by the skip instead.
    expect(JWT_MINT_RE.test('  // invariant: no jwt.sign call mints before the INSERT')).toBe(false);
    expect(JWT_MINT_RE.test('  // a second jwt.sign(...) here needs its own response assertion')).toBe(true);
    expect(isCommentLine('  // a second jwt.sign(...) here needs its own response assertion')).toBe(true);
  });

  it('the enclosing-symbol resolver names handlers, not files', () => {
    // The granularity this canary rests on. A resolver that returned the same
    // label for every line would collapse the assertion back to file
    // granularity while every test above stayed green.
    const lines = [
      "router.post('/session-auth', verifyHiveSignature, async (req, res) => {",
      '  const issued = await issueSessionFreshAuthToken(username, "password");',
      '});',
      '',
      'async function handleLogin(',
      '  req: Request,',
      '): Promise<void> {',
      '  const issued = await issueSessionFreshAuthToken(username, "password");',
      '}',
    ];
    expect(enclosingSymbol(lines, 1)).toBe('POST /session-auth');
    // The wrapped parameter list must not read as the end of the block, and the
    // route handler above must not leak downward into the sibling function.
    expect(enclosingSymbol(lines, 7)).toBe('handleLogin');
    // An aliased specifier is caught because it resolves to module scope, which
    // is never an allowed key. If the resolver ever labelled import lines with
    // the nearest declaration instead, that alias would acquire a symbol name
    // and the catch would go quiet, so the property is pinned here rather than
    // assumed.
    expect(
      enclosingSymbol(
        ['import {', '  issueSessionFreshAuthToken as mint,', "} from '../lib/fresh-auth.js';"],
        1,
      ),
    ).toBe(MODULE_SCOPE);
  });
});

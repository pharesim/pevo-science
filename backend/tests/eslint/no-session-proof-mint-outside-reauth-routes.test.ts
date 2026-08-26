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
 * GRANULARITY. The assertion is over `file#symbol` pairs, not over files. The
 * two licensed mints live in `routes/orcid.ts` and `routes/custody.ts`, and
 * `routes/orcid.ts` is where the most likely violation lands — `handleLogin`
 * sits beside `handleSessionAuth` in the same dispatch. A file-set assertion
 * cannot express "this file may mint, but only from that one handler": adding
 * the mint to `handleLogin` leaves the file set unchanged and the canary green,
 * for precisely the scenario the paragraph above names as most likely. Naming
 * the enclosing handler is what makes the new call site a new member.
 *
 * SCOPE. Every `.ts` file under `src/` is scanned, `lib/fresh-auth.ts`
 * included. Only the definition line itself is skipped, and by SHAPE (`function
 * issueSessionFreshAuthToken(`) rather than by path — excluding the whole
 * module by path left a mint helper added inside it unscanned rather than
 * merely unmatched. Detection is a call-shaped match (identifier immediately
 * followed by an open paren), which is why import specifiers and docblock
 * mentions do not trip it; pinned by the planted-negative self-test below.
 *
 * The exact-set assertion is the load-bearing half: it catches a mint added in
 * a brand-new file or a brand-new handler, which a forbidden-file list never
 * would. The forbidden-file assertion exists on top of it to name the
 * sympathetic cases explicitly, so a red bar there reads as "this is invariant
 * #9" rather than "the allowlist needs updating".
 *
 * A second scan covers what a name-based canary structurally cannot: a window
 * minted inside `lib/fresh-auth.ts` by NEW code under a different name, which
 * matches no `issueSessionFreshAuthToken(` call anywhere. Session-kind entries
 * are constructible only by writing the `kind: 'session'` discriminator, so the
 * enclosing symbols of that literal are pinned too.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { enclosingSymbol, occurrencesOf, sourcesUnder } from '../support/enclosing-symbol.js';

/** A CALL to the session-proof mint: the identifier followed by an open paren,
 *  optionally across whitespace so a wrapped call still matches. An import
 *  specifier or a prose mention has no paren and does not match. */
const SESSION_MINT_CALL_RE = /issueSessionFreshAuthToken\s*\(/;

/** The definition line, which contains the identifier followed by `(` as part
 *  of `export async function issueSessionFreshAuthToken(`. Skipped by shape so
 *  the module that defines the mint is still scanned for calls to it. */
const SESSION_MINT_DEFINITION_RE = /function\s+issueSessionFreshAuthToken\s*\(/;

/** Construction of a session-kind stored entry: the discriminator written as an
 *  object-literal field, which in this codebase always carries a trailing comma
 *  because the entry has fields after it. The trailing comma is what separates
 *  construction from the three shapes that merely NAME the kind and must not
 *  trip the scan: the `entry.kind === 'session'` comparisons (no colon), the
 *  `kind: 'session';` member of the validated-entry union and the
 *  `Extract<ValidatedEntry, { kind: 'session' }>` narrowing (both type
 *  positions), and docblock prose. Comment lines are skipped outright as well,
 *  so a prose mention that happens to end in a comma is still spared. */
const SESSION_KIND_LITERAL_RE = /kind:\s*'session',/;

/** A line that is entirely comment, in either of the two shapes this codebase
 *  writes. Used to keep prose out of the construction-site scan. */
const COMMENT_LINE_RE = /^\s*(?:\*|\/\/|\/\*)/;

/** The only two handlers licensed to mint, one per factor (§ 6.4.1). */
const ALLOWED_MINT_SITES = [
  'routes/custody.ts#POST /session-auth',
  'routes/orcid.ts#handleSessionAuth',
];

/** The only two places a session-kind entry is constructed: the mint, and the
 *  slide that rewrites one entry into its successor. */
const ALLOWED_SESSION_ENTRY_SITES = [
  'lib/fresh-auth.ts#consumeSessionWindow',
  'lib/fresh-auth.ts#issueSessionFreshAuthToken',
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

  it('only the password and ORCID re-auth handlers call the session-proof mint', () => {
    const { keys, sites } = occurrencesOf(sources, SESSION_MINT_CALL_RE, (line) =>
      SESSION_MINT_DEFINITION_RE.test(line),
    );
    expect(
      keys,
      `session-proof mint call sites:\n${sites.join('\n')}`,
    ).toEqual([...ALLOWED_MINT_SITES].sort());
  });

  it('only the mint and the slide construct a session-kind entry', () => {
    // Name-independent backstop. A helper added inside lib/fresh-auth.ts that
    // opens a window under some other name calls nothing this canary greps for,
    // but it cannot avoid writing the discriminator.
    const { keys, sites } = occurrencesOf(sources, SESSION_KIND_LITERAL_RE, (line) =>
      COMMENT_LINE_RE.test(line),
    );
    expect(
      keys,
      `session-kind entry construction sites:\n${sites.join('\n')}`,
    ).toEqual([...ALLOWED_SESSION_ENTRY_SITES].sort());
  });

  it('no session-establishment or recovery route opens a window as a side effect', () => {
    const scanned = sources.filter((s) => FORBIDDEN_MINT_FILES.includes(s.rel));
    expect(scanned.length, 'a forbidden file was renamed or removed').toBe(
      FORBIDDEN_MINT_FILES.length,
    );
    const { sites } = occurrencesOf(scanned, SESSION_MINT_CALL_RE);
    expect(
      sites,
      'a session-proof window must be opened only by an explicit re-auth act, ' +
        'never as a side effect of logging in, refreshing a token, finalizing a ' +
        `signup, or recovering an account:\n${sites.join('\n')}`,
    ).toEqual([]);
  });

  it('the call matcher fires on a mint and spares imports, prose, and the definition', () => {
    // Planted positives and negatives. Without them the scans above can silently
    // no-op: an edit that mangles the pattern leaves every result empty and the
    // suite stays green while the canary enforces nothing.
    expect(SESSION_MINT_CALL_RE.test("const issued = await issueSessionFreshAuthToken(username, 'password');")).toBe(true);
    expect(SESSION_MINT_CALL_RE.test('  issueSessionFreshAuthToken (username, mechanism)')).toBe(true);

    expect(SESSION_MINT_CALL_RE.test('  issueSessionFreshAuthToken,')).toBe(false);
    expect(SESSION_MINT_CALL_RE.test(' * consumed by `issueSessionFreshAuthToken` on the session surface')).toBe(false);
    expect(SESSION_MINT_CALL_RE.test('import { issueSessionFreshAuthToken } from \'../lib/fresh-auth.js\';')).toBe(false);
    // The consent-op mint is a different function with a different contract and
    // is licensed on more routes; it must not be swept up by this canary.
    expect(SESSION_MINT_CALL_RE.test("await issueFreshAuthToken(username, 'password', target);")).toBe(false);

    // The definition line matches the call pattern and is skipped by shape, so
    // the module that defines the mint stays scanned for calls to it.
    expect(SESSION_MINT_DEFINITION_RE.test('export async function issueSessionFreshAuthToken(')).toBe(true);
    expect(SESSION_MINT_DEFINITION_RE.test("  const issued = await issueSessionFreshAuthToken(username, 'password');")).toBe(false);

    expect(SESSION_KIND_LITERAL_RE.test("    kind: 'session',")).toBe(true);
    expect(SESSION_KIND_LITERAL_RE.test("  if (entry.kind === 'session') {")).toBe(false);
    // Type positions, not construction. Both name the kind without building an
    // entry, and both live in lib/fresh-auth.ts today.
    expect(SESSION_KIND_LITERAL_RE.test("      kind: 'session';")).toBe(false);
    expect(SESSION_KIND_LITERAL_RE.test("  entry: Extract<ValidatedEntry, { kind: 'session' }>,")).toBe(false);
    expect(COMMENT_LINE_RE.test(" *   - a `kind: 'session'` entry (target-less, minted by")).toBe(true);
    expect(COMMENT_LINE_RE.test("    kind: 'session',")).toBe(false);
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
  });
});

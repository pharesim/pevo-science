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
 * SCOPE: call sites only. The definition site in `lib/fresh-auth.ts` and any
 * `import { issueSessionFreshAuthToken }` line are excluded, since neither is a
 * mint. Detection is a call-shaped match (identifier immediately followed by an
 * open paren), which is why the import list and docblock mentions do not trip
 * it — pinned by the planted-negative self-test below.
 *
 * The exact-set assertion is the load-bearing half: it catches a mint added in
 * a brand-new file, which a forbidden-file list never would. The forbidden-file
 * assertion exists on top of it to name the sympathetic cases explicitly, so a
 * red bar there reads as "this is invariant #9" rather than "the allowlist
 * needs updating".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const srcRoot = path.resolve(__dirname, '..', '..', 'src');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** A CALL to the session-proof mint: the identifier followed by an open paren,
 *  optionally across whitespace so a wrapped call still matches. An import
 *  specifier or a prose mention has no paren and does not match. */
const SESSION_MINT_CALL_RE = /issueSessionFreshAuthToken\s*\(/;

/** The definition site. It contains the identifier followed by `(` as part of
 *  `export async function issueSessionFreshAuthToken(`, so it is excluded by
 *  path rather than by pattern. */
const DEFINITION_FILE = 'lib/fresh-auth.ts';

/** The only two files licensed to mint, one per factor (§ 6.4.1). */
const ALLOWED_MINT_FILES = ['routes/custody.ts', 'routes/orcid.ts'];

/** Session-establishment and account-recovery surfaces, named explicitly so a
 *  mint landing in one produces a message that says what rule it broke. */
const FORBIDDEN_MINT_FILES = [
  'routes/auth.ts',
  'routes/signup-verify.ts',
  'routes/recover.ts',
  'middleware/verifyHiveSignature.ts',
];

describe('invariant #9 — no session-proof mint outside the two re-auth routes', () => {
  const files = tsFilesUnder(srcRoot);

  it('walks a plausible number of source files (guards against a broken walker)', () => {
    // Without this, a walker that returned nothing would make every assertion
    // below vacuously true and the canary would enforce nothing.
    expect(files.length).toBeGreaterThan(20);
  });

  it('only the password and ORCID re-auth routes call the session-proof mint', () => {
    const callers = new Set<string>();
    const sites: string[] = [];
    for (const file of files) {
      const rel = path.relative(srcRoot, file).split(path.sep).join('/');
      if (rel === DEFINITION_FILE) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!SESSION_MINT_CALL_RE.test(line)) return;
        callers.add(rel);
        sites.push(`src/${rel}:${i + 1} — ${line.trim()}`);
      });
    }
    expect(
      [...callers].sort(),
      `session-proof mint call sites:\n${sites.join('\n')}`,
    ).toEqual([...ALLOWED_MINT_FILES].sort());
  });

  it('no session-establishment or recovery route opens a window as a side effect', () => {
    const violations: string[] = [];
    for (const rel of FORBIDDEN_MINT_FILES) {
      const full = path.join(srcRoot, ...rel.split('/'));
      const lines = readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (SESSION_MINT_CALL_RE.test(line)) {
          violations.push(`src/${rel}:${i + 1} — ${line.trim()}`);
        }
      });
    }
    expect(
      violations,
      'a session-proof window must be opened only by an explicit re-auth act, ' +
        'never as a side effect of logging in, refreshing a token, finalizing a ' +
        `signup, or recovering an account:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('the call matcher fires on a mint and spares imports and prose', () => {
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
  });
});

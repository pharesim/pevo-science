/**
 * Standing source-discipline canary: every production consume of a session
 * fresh-auth window hands it the account's revocation epoch.
 *
 * The epoch check inside `consumeSessionWindow` is the AUTHORITATIVE half of
 * session invalidation. `invalidateSessionFreshAuthTokens` sweeps the storage
 * tiers, but the sweep is best-effort: it misses a window whose per-user index
 * entry never landed, one re-planted by a consume that was in flight while it
 * ran, and every window at all when Redis is unreachable. The epoch comes from
 * the same Postgres row the revoking mutation committed, so it cannot be lost
 * the same way.
 *
 * A consume handed no epoch takes the no-cut-off branch, and that failure is
 * silent by construction: the sweep still closes most windows, every test
 * passes, the proof is still required on the wire, and the only thing that
 * changed is that a window minted before a password reset keeps authorizing
 * broadcasts until its absolute cap.
 *
 * The type system carries half of the guarantee. `sessionsInvalidatedAtMs` is a
 * required parameter, so the branch cannot be reached by omission. What a type
 * cannot say is that the value must be the request's epoch and not a literal
 * `undefined` or `null`, both of which compile and both of which are what a
 * caller writes when the epoch is inconvenient to reach. That half is this scan.
 *
 * GRANULARITY. The assertion pairs each CONSUME with an epoch reference in the
 * SAME enclosing symbol, not in the same file. `routes/custody.ts` would
 * otherwise absorb a second, epoch-less consume added to a different handler
 * without changing the file set.
 *
 * KNOWN TRADE. The pairing is textual. A caller that reads the epoch in one
 * function and consumes inside a nested arrow declared in another resolves to
 * two different symbols and fails here even though it is correct; the fix is to
 * keep the two in one scope. The reverse, an epoch-less consume inside a
 * function that mentions the epoch for an unrelated reason, passes. This is a
 * wiring pin, not a taint analysis.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { isCommentLine, occurrencesOf, sourcesUnder } from '../support/enclosing-symbol.js';

/** A CALL to the session-surface consume: identifier followed by an open paren,
 *  optionally across whitespace so a wrapped call still matches. An import
 *  specifier or a link-tag mention has no paren and does not match. */
const CONSUME_CALL_RE = /consumeSessionFreshAuthToken\s*\(/;

/** The definition line, skipped by SHAPE rather than by path so the module that
 *  defines the consume is still scanned for calls to it. */
const CONSUME_DEFINITION_RE = /function\s+consumeSessionFreshAuthToken\s*\(/;

/** The request-scoped revocation epoch, matched without the `req.` prefix so a
 *  destructure or a parameter carrying the same name also satisfies the pair.
 *  `sessionsInvalidatedAtMs`, the callee-side parameter name, deliberately does
 *  not match: it is what the value is called after it arrives. */
const EPOCH_REF_RE = /\bhiveSessionsInvalidatedAt\b/;

const sources = sourcesUnder(path.resolve(__dirname, '..', '..', 'src'));

describe('every session-window consume carries the account revocation epoch', () => {
  it('walks a plausible number of source files (guards against a broken walker)', () => {
    // Without this, a walker that returned nothing makes the assertion below
    // vacuously true and the canary enforces nothing.
    expect(sources.length).toBeGreaterThan(20);
    const rels = sources.map((s) => s.rel);
    expect(rels).toContain('lib/fresh-auth.ts');
    expect(rels).toContain('routes/custody.ts');
  });

  it('no session-window consume runs without the request epoch', () => {
    const consumes = occurrencesOf(
      sources,
      CONSUME_CALL_RE,
      (line) => CONSUME_DEFINITION_RE.test(line) || isCommentLine(line),
    );
    const epochs = new Set(occurrencesOf(sources, EPOCH_REF_RE, isCommentLine).keys);
    // Anti-vacuity: a rename of the consume would otherwise empty the set and
    // pass everything.
    expect(
      consumes.keys.length,
      `session-window consume call sites:\n${consumes.sites.join('\n')}`,
    ).toBeGreaterThan(0);
    const offenders = consumes.keys.filter((key) => !epochs.has(key));
    expect(
      offenders,
      'these functions consume a session fresh-auth window without passing the ' +
        "account's revocation epoch, so the window survives the password reset " +
        'or recovery that was supposed to close it whenever the best-effort ' +
        `Redis sweep did not reach it:\n${offenders.join('\n')}\n\n` +
        `all consume sites:\n${consumes.sites.join('\n')}`,
    ).toEqual([]);
  });

  it('the matchers fire on a real call and spare imports, prose, and the definition', () => {
    // Planted positives and negatives. Without them an edit that mangles a
    // pattern leaves every result empty and the suite stays green while the
    // canary enforces nothing.
    expect(CONSUME_CALL_RE.test('const result = await consumeSessionFreshAuthToken(')).toBe(true);
    expect(CONSUME_CALL_RE.test('  consumeSessionFreshAuthToken (token, username, epoch)')).toBe(true);
    expect(CONSUME_CALL_RE.test('  consumeSessionFreshAuthToken,')).toBe(false);
    expect(CONSUME_DEFINITION_RE.test('export async function consumeSessionFreshAuthToken(')).toBe(true);
    expect(CONSUME_DEFINITION_RE.test('  const r = await consumeSessionFreshAuthToken(a, b, c);')).toBe(false);

    expect(EPOCH_REF_RE.test('      req.hiveSessionsInvalidatedAt,')).toBe(true);
    expect(EPOCH_REF_RE.test('const { hiveSessionsInvalidatedAt } = req;')).toBe(true);
    // The callee-side parameter name is not the request epoch.
    expect(EPOCH_REF_RE.test('  sessionsInvalidatedAtMs,')).toBe(false);

    expect(isCommentLine(' * the epoch travels on req.hiveSessionsInvalidatedAt')).toBe(true);
    expect(isCommentLine('      req.hiveSessionsInvalidatedAt,')).toBe(false);
  });
});

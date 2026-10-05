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
 * MODULE SCOPE IS NEVER SATISFYING. A pairing scan has a vacuity a set-equality
 * scan does not: `enclosingSymbol` resolves a declaration shape it cannot parse
 * (an object-method shorthand, a class member) to the module-scope label, and
 * when BOTH sides of a pair land on that one label they satisfy each other, so
 * an epoch-less consume inside such a declaration passes green. Both pairings
 * below therefore drop module-scope keys from their satisfying sets AND assert
 * outright that no primary-side occurrence resolved to module scope, which
 * turns "the resolver did not understand this declaration" into a red bar
 * naming the line instead of a silent pass. The rule is stated once, in
 * `tests/support/enclosing-symbol.ts`, and pinned here by a planted probe using
 * exactly such a declaration shape.
 *
 * THREE SEAMS, because the type system closes none of them on its own. The
 * exported consume takes the epoch as a required argument, so an external
 * caller cannot omit it; but the internal surface literal that argument feeds
 * into is module-private, and making its field required only means an in-module
 * literal must MENTION the field. Nothing stops a fourth surface from
 * mentioning it as a literal `undefined`, and nothing outside this file can
 * even name the type to pin it. So three seams are scanned: the exported
 * consume's call sites, the surface literals inside the module, and — because
 * "mentions the field" is satisfiable by `sessionsInvalidatedAtMs: undefined`
 * sitting beside `acceptSession: true` — the VALUE each session-accepting
 * surface gives the field, which must be an epoch reference and never a
 * literal.
 *
 * KNOWN TRADE. The pairing is textual. A caller that reads the epoch in one
 * function and consumes inside a nested arrow declared in another resolves to
 * two different symbols and fails here even though it is correct; the fix is to
 * keep the two in one scope. The reverse, an epoch-less consume inside a
 * function that mentions the epoch for an unrelated reason, passes. This is a
 * wiring pin, not a taint analysis. The same trade prices the value seam: a
 * shorthand `sessionsInvalidatedAtMs` write is accepted as a pass-through of
 * the same-named binding, so a local `const sessionsInvalidatedAtMs =
 * undefined` shadowing the parameter would pass — visible in review, and the
 * external-caller seam still forces every caller of the exported consume to
 * hand over the request's epoch.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  MODULE_SCOPE,
  blockCommentInterior,
  enclosingSymbol,
  isCommentLine,
  isCommentedOut,
  isModuleScopeKey,
  occurrencesOf,
  skipCommentOr,
  sourcesUnder,
  type ScannedSource,
} from '../support/enclosing-symbol.js';

/** The skip for the SATISFYING side of this file's pairings: the epoch
 *  reference and the surface-field mention. A match there vouches for a
 *  consume or a surface, so an over-match is the silent failure, and the
 *  region-aware skip the primary side uses reads prose as live wherever the
 *  region pass under-reports a comment (a block comment opened mid-line, a
 *  line-start opener refused by an inverted template-parity count). The
 *  shape test in `isCommentedOut` keeps out each line of that prose that
 *  begins with `*`, `//` or `/*`; a continuation written with no prefix,
 *  inside a comment opened after other text on its line (code, or another
 *  comment's close, as in `/* a *\/ /* the epoch note`), still reads as
 *  live, a residual the shared module names at `skipCommentLine`.
 *
 *  A second residual needs no under-reported region: a comment that shares
 *  a LIVE line. `isCommentedOut` answers about whole lines, so an epoch named
 *  in a trailing comment satisfies the pairing
 *  (`return consumeSessionFreshAuthToken(token, username, undefined); // TODO hiveSessionsInvalidatedAt`).
 *  The value seam tests the whole value text, comments included, in two
 *  forms. A trailing comment rides in with the value, on the key's line or
 *  on a wrapped value line (`undefined, // hiveSessionsInvalidatedAt`), and
 *  counts as an epoch reference when it names the epoch. A same-line value
 *  that BEGINS with a comment (`sessionsInvalidatedAtMs: /* note *\/
 *  undefined,`) counts as an epoch reference when the comment names the
 *  epoch, and otherwise as neither reference nor literal, so another write
 *  in the same function that names the epoch covers it. The trailing forms
 *  need a comment told apart from the same characters inside a string, the
 *  lexer the shared module declines. The leading form could be refused by
 *  shape, the way the wrapped lookup in `valueTextAfterKey` treats a line
 *  with code after a close; it is recorded here, not closed. */
const skipCommentedOut = (line: string, lineIndex: number, lines: string[]): boolean =>
  isCommentedOut(line, lineIndex, lines);

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

/** Construction of the module-private consume surface, and its definition line.
 *  Every literal must name the epoch field somewhere in the same function. */
const SURFACE_CALL_RE = /consumeFreshAuthTokenForSurface\s*\(/;
const SURFACE_DEFINITION_RE = /function\s+consumeFreshAuthTokenForSurface\s*\(/;

/** The surface field itself, matched by name. A literal that omits it no longer
 *  compiles, but one that writes `sessionsInvalidatedAtMs: undefined` does, and
 *  that is the shape this pairs against: the field has to be present, and the
 *  consume-side scan above is what makes the value it carries the request's. */
const SURFACE_FIELD_RE = /\bsessionsInvalidatedAtMs\b/;

/** A WRITE of the surface field: the name in key position (shorthand, or
 *  followed by a colon), not a property access (`surface.sessionsInvalidatedAtMs`)
 *  and not an optional type member (`sessionsInvalidatedAtMs?:`). The `$`
 *  alternative admits a wrapped key whose value starts on the next line, so the
 *  value seam cannot be stepped around by a line break — the same line-
 *  orientation hole the construction scan in the sibling mint canary closed. */
const SURFACE_FIELD_WRITE_RE = /(?<!\.)\bsessionsInvalidatedAtMs\b\s*(?:[,}]|:|$)/;

/** A WRITE of the session-acceptance flag, same key-position discipline. The
 *  optional type member (`acceptSession?: boolean`) does not match, so the
 *  option-bag parameter declarations stay out of the classification. */
const ACCEPT_SESSION_WRITE_RE = /(?<!\.)\bacceptSession\b\s*:/;

/** The value shapes that disable the cut-off while compiling: `undefined`,
 *  `null`, a number, or a string. Applied to the text AFTER the key's colon
 *  (joined with the next line when the key is wrapped). */
const LITERAL_VALUE_RE = /^\s*(?:undefined\b|null\b|[0-9]|['"`])/;

const sources = sourcesUnder(path.resolve(__dirname, '..', '..', 'src'));

/** The consume↔epoch pairing, factored so the planted probes below exercise the
 *  same call the whole-tree scan does. Module-scope keys are excluded from the
 *  satisfying set and reported separately for the primary side; see the file
 *  docblock for why a pairing scan must never let module scope satisfy. */
function epochlessConsumes(files: ScannedSource[]) {
  const consumes = occurrencesOf(files, CONSUME_CALL_RE, skipCommentOr(CONSUME_DEFINITION_RE));
  const epochs = new Set(
    occurrencesOf(files, EPOCH_REF_RE, skipCommentedOut).keys.filter((k) => !isModuleScopeKey(k)),
  );
  return {
    consumes,
    moduleScoped: consumes.keys.filter(isModuleScopeKey),
    offenders: consumes.keys.filter((key) => !epochs.has(key)),
  };
}

/** The surface↔field pairing, same shape and same module-scope discipline. */
function fieldlessSurfaces(files: ScannedSource[]) {
  const surfaces = occurrencesOf(files, SURFACE_CALL_RE, skipCommentOr(SURFACE_DEFINITION_RE));
  const fields = new Set(
    occurrencesOf(files, SURFACE_FIELD_RE, skipCommentedOut).keys.filter((k) => !isModuleScopeKey(k)),
  );
  return {
    surfaces,
    moduleScoped: surfaces.keys.filter(isModuleScopeKey),
    offenders: surfaces.keys.filter((key) => !fields.has(key)),
  };
}

/** The text a key's value occupies: the remainder of the line after the first
 *  colon following `name`, or, when the key is wrapped (colon at end of line),
 *  the first line below it that is neither blank nor comment and nothing
 *  else, read as `''` when `isCommentedOut` reads that line as commented out
 *  without its being comment and nothing else. Returns null when `name` is
 *  written in shorthand position (no colon), which for the epoch field means
 *  a pass-through of the same-named binding.
 *
 *  The wrapped lookup steps past a line only when it is comment and nothing
 *  else: `isCommentedOut` reads it as commented out AND `isCommentLine`,
 *  answering as if a region were open, reads it as prose (a docblock opener
 *  or star continuation, a `//` line with no close on it, a comment whose
 *  close has nothing live after it). Neither test is enough alone. By shape,
 *  `/* wired later *\/ undefined,` is commented out though the code after
 *  its close is the real value, and stepping past it makes the NEXT
 *  property's line the value, which vouches for the surface when that line
 *  names the epoch. To `isCommentLine` alone, ` * hiveSessionsInvalidatedAt
 *  belongs here *\/ undefined,` is live, and its prose becomes a value
 *  naming the epoch. The open region is what makes a `//` line answer by its
 *  close search: inside a block comment the two slashes are comment text, so
 *  `// wired later *\/ undefined,` closing a comment opened above carries
 *  the value too. A real line comment carrying a close with text after it
 *  reads the same way and returns `''`, which is loud.
 *
 *  A line the two tests disagree on is returned as `''`, never as its text:
 *  code after a close, or a line with no prefix inside a block comment that
 *  `isCommentedOut` sees, one opened at the start of a line. A no-prefix line
 *  inside a comment it does not see (opened after code, or after another
 *  comment's close, on its line: `/* a *\/ /* b`) reads as live to both
 *  tests and is returned as text, the residual `skipCommentedOut` names. A
 *  trailing comment on a returned line stays in the text, a residual named
 *  there too. `literalEpochSurfaces` counts a `''` epoch value as
 *  unresolved, an offender; for the `acceptSession` value `''` reads as
 *  accepting, which can only turn a demand on, a red bar. */
function valueTextAfterKey(lines: string[], lineIndex: number, name: string): string | null {
  const line = lines[lineIndex];
  const m = line.match(new RegExp(`(?<!\\.)\\b${name}\\b\\s*(:)?`));
  if (!m || !m[1]) return null;
  const after = line.slice((m.index ?? 0) + m[0].length);
  if (after.trim() !== '') return after;
  for (let j = lineIndex + 1; j < lines.length; j++) {
    if (lines[j].trim() === '') continue;
    if (!isCommentedOut(lines[j], j, lines)) return lines[j];
    if (!isCommentLine(lines[j], true)) return '';
  }
  return '';
}

/** The value seam: no symbol may construct a session-accepting surface whose
 *  epoch field is a literal, or one that never references the request's epoch
 *  at all. Classification is per enclosing symbol, matching the pairing
 *  granularity above:
 *
 *   - session-accepting: the symbol writes `acceptSession:` with anything but
 *     the literal `false`. A conditional (`opts.acceptSession === true`) counts
 *     as accepting, which is the conservative direction.
 *   - epoch-referencing: the symbol writes the epoch field in shorthand (a
 *     pass-through of the same-named required parameter) or with a value that
 *     names the request epoch (`hiveSessionsInvalidatedAt`).
 *   - literal-valued: the symbol writes the epoch field with a value opening as
 *     `undefined`, `null`, a number, or a string, or with a wrapped value
 *     `valueTextAfterKey` could not read (`''`). An unread value is counted
 *     here rather than left as a write that vouches for nothing, because
 *     the facts are per symbol: another write in the same function that
 *     names the epoch would otherwise cover it.
 *
 *  A session-accepting surface symbol that is literal-valued or not
 *  epoch-referencing is an offender. `acceptSession: false` beside
 *  `sessionsInvalidatedAtMs: undefined` stays legitimate — that is the
 *  consent-op surface stating its no-window posture explicitly. */
function literalEpochSurfaces(files: ScannedSource[]) {
  type SymbolFacts = {
    accepting: boolean;
    epochRef: boolean;
    literal: boolean;
    lines: string[];
  };
  const facts = new Map<string, SymbolFacts>();
  const factFor = (key: string): SymbolFacts => {
    let f = facts.get(key);
    if (!f) {
      f = { accepting: false, epochRef: false, literal: false, lines: [] };
      facts.set(key, f);
    }
    return f;
  };
  for (const { rel, lines } of files) {
    const interior = blockCommentInterior(lines);
    lines.forEach((line, i) => {
      if (isCommentLine(line, interior[i])) return;
      const key = () => `${rel}#${enclosingSymbol(lines, i)}`;
      if (ACCEPT_SESSION_WRITE_RE.test(line)) {
        const value = valueTextAfterKey(lines, i, 'acceptSession');
        if (value !== null && !/^\s*false\b/.test(value)) {
          const f = factFor(key());
          f.accepting = true;
          f.lines.push(`${rel}:${i + 1} — ${line.trim()}`);
        }
      }
      if (SURFACE_FIELD_WRITE_RE.test(line)) {
        const value = valueTextAfterKey(lines, i, 'sessionsInvalidatedAtMs');
        const f = factFor(key());
        if (value === null || EPOCH_REF_RE.test(value)) {
          // Satisfying-side, so read by shape like the epoch pairing: a
          // write behind a comment close, or on a star line the region pass
          // left live, does not vouch for the surface. valueTextAfterKey
          // reads a wrapped value line the same way: it steps past pure
          // comment and reads comment-then-code as unresolved. A trailing
          // comment on the value line still rides in with the value, the
          // residual named at skipCommentedOut.
          if (!isCommentedOut(line, i, lines)) f.epochRef = true;
        } else if (value === '' || LITERAL_VALUE_RE.test(value)) {
          f.literal = true;
          f.lines.push(`${rel}:${i + 1} — ${line.trim()}`);
        }
      }
    });
  }
  const surfaces = occurrencesOf(files, SURFACE_CALL_RE, skipCommentOr(SURFACE_DEFINITION_RE));
  const offenders: string[] = [];
  for (const key of surfaces.keys) {
    const f = facts.get(key);
    if (!f?.accepting) continue;
    if (f.literal || !f.epochRef) {
      offenders.push(`${key}\n  ${f.lines.join('\n  ')}`);
    }
  }
  return { surfaces, offenders };
}

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
    const { consumes, moduleScoped, offenders } = epochlessConsumes(sources);
    // Anti-vacuity: a rename of the consume would otherwise empty the set and
    // pass everything.
    expect(
      consumes.keys.length,
      `session-window consume call sites:\n${consumes.sites.join('\n')}`,
    ).toBeGreaterThan(0);
    expect(
      moduleScoped,
      'these consume call sites resolved to module scope, which means the ' +
        'enclosing-symbol resolver did not recognize the declaration shape ' +
        'they sit in (an object method, a class member, a new syntax). The ' +
        'pairing below cannot vouch for them — move the call into a ' +
        'declaration shape the resolver names, or teach the resolver the ' +
        `shape:\n${consumes.sites.join('\n')}`,
    ).toEqual([]);
    expect(
      offenders,
      'these functions consume a session fresh-auth window without passing the ' +
        "account's revocation epoch, so the window survives the credential " +
        'rotation that was supposed to close it whenever the best-effort ' +
        `Redis sweep did not reach it:\n${offenders.join('\n')}\n\n` +
        `all consume sites:\n${consumes.sites.join('\n')}`,
    ).toEqual([]);
  });

  it('no consume surface is built without naming the revocation epoch', () => {
    // The second seam. `FreshAuthConsumeSurface` is module-private, so no test
    // outside `lib/fresh-auth.ts` can construct one and no `@ts-expect-error`
    // can pin its shape; making the field required is enforced only by the
    // compiler at the literals inside that module, and a literal is exactly what
    // a future surface adds. Pairing each construction with a mention of the
    // field in the same function is the only check available from out here.
    const { surfaces, moduleScoped, offenders } = fieldlessSurfaces(sources);
    expect(
      surfaces.keys.length,
      `consume surface construction sites:\n${surfaces.sites.join('\n')}`,
    ).toBeGreaterThan(0);
    expect(
      moduleScoped,
      'these surface constructions resolved to module scope, where the pairing ' +
        `cannot vouch for them (see the consume-side assertion):\n${surfaces.sites.join('\n')}`,
    ).toEqual([]);
    expect(
      offenders,
      'these functions build a fresh-auth consume surface without naming ' +
        'sessionsInvalidatedAtMs, so a session proof reaching them is measured ' +
        `against no revocation epoch at all:\n${offenders.join('\n')}\n\n` +
        `all surface sites:\n${surfaces.sites.join('\n')}`,
    ).toEqual([]);
  });

  it('no session-accepting surface pins the epoch field to a literal', () => {
    // The third seam. The field-presence pairing above is satisfied by
    // `sessionsInvalidatedAtMs: undefined`, and the compiler is satisfied by it
    // too, so a surface written that way beside `acceptSession: true` silently
    // disables the authoritative half of revocation for every proof it serves.
    // A session-accepting surface must hand the field an epoch reference; only
    // a surface that refuses session proofs outright may state a no-window
    // posture with a literal.
    const { surfaces, offenders } = literalEpochSurfaces(sources);
    expect(
      surfaces.keys.length,
      `consume surface construction sites:\n${surfaces.sites.join('\n')}`,
    ).toBeGreaterThan(0);
    expect(
      offenders,
      'these functions build a session-accepting consume surface whose ' +
        'sessionsInvalidatedAtMs is a literal or never references the request ' +
        'epoch, which disables the revocation cut-off while every test stays ' +
        `green:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('a declaration shape the resolver cannot parse is a red bar, not a satisfied pair', () => {
    // Planted probe for the module-scope vacuity. An object-method shorthand is
    // a declaration `enclosingSymbol` does not recognize, so both the consume
    // and the epoch reference inside it resolve to module scope. Before the
    // module-scope exclusions, the two module-scope keys satisfied each other
    // and this exact shape passed green.
    const evasion: ScannedSource = {
      rel: 'routes/synthetic.ts',
      lines: [
        'export const api = {',
        '  async broadcast(req, res) {',
        '    const epoch = req.hiveSessionsInvalidatedAt;',
        '    return consumeSessionFreshAuthToken(token, user, undefined);',
        '  },',
        '};',
      ],
    };
    // Pin the premise: the resolver really does not parse this shape. If it
    // learns to, this probe stops modelling the vacuity and must move to a
    // shape the resolver still cannot parse.
    expect(enclosingSymbol(evasion.lines, 3)).toBe(MODULE_SCOPE);

    const { moduleScoped, offenders } = epochlessConsumes([evasion]);
    expect(moduleScoped).toEqual([`routes/synthetic.ts#${MODULE_SCOPE}`]);
    expect(offenders).toEqual([`routes/synthetic.ts#${MODULE_SCOPE}`]);

    // The same shape through the surface pairing.
    const surfaceEvasion: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'export const store = {',
        '  async consume(token) {',
        '    const sessionsInvalidatedAtMs = undefined;',
        '    return consumeFreshAuthTokenForSurface(token, surface);',
        '  },',
        '};',
      ],
    };
    const surfaceResult = fieldlessSurfaces([surfaceEvasion]);
    expect(surfaceResult.moduleScoped).toEqual([`lib/synthetic.ts#${MODULE_SCOPE}`]);
    expect(surfaceResult.offenders).toEqual([`lib/synthetic.ts#${MODULE_SCOPE}`]);
  });

  it('prose naming the epoch behind an under-reported comment region satisfies nothing', () => {
    // Planted probes for the satisfying side. The region pass misses a block
    // comment opened mid-line, so the star line inside it reads as live to
    // the region-aware skip, and an epoch named there paired with the
    // epoch-less consume below it in the same function. The shape test the
    // satisfying scans use reads it as prose, so the consume stays an
    // offender.
    const midLineOpenedProse: ScannedSource = {
      rel: 'routes/synthetic.ts',
      lines: [
        'async function consumeBesideProse(token: string, username: string) {',
        '  const started = Date.now(); /* the epoch note',
        '   * hiveSessionsInvalidatedAt is read by the caller',
        '   */',
        '  return consumeSessionFreshAuthToken(token, username, undefined);',
        '}',
      ],
    };
    expect(blockCommentInterior(midLineOpenedProse.lines)[2]).toBe(false);
    expect(epochlessConsumes([midLineOpenedProse]).offenders).toEqual([
      'routes/synthetic.ts#consumeBesideProse',
    ]);

    // The same through an inverted template-parity count: a stray backtick in
    // a regex makes the region pass refuse a real line-start docblock opener,
    // so its star line reads as live to the region-aware skip.
    const parityInvertedProse: ScannedSource = {
      rel: 'routes/synthetic.ts',
      lines: [
        'const TICK_RE = /`/;',
        'async function consumeBesideProse(token: string, username: string) {',
        '  /**',
        '   * hiveSessionsInvalidatedAt is read by the caller',
        '   */',
        '  return consumeSessionFreshAuthToken(token, username, undefined);',
        '}',
      ],
    };
    expect(blockCommentInterior(parityInvertedProse.lines)[3]).toBe(false);
    expect(epochlessConsumes([parityInvertedProse]).offenders).toEqual([
      'routes/synthetic.ts#consumeBesideProse',
    ]);

    // Control: the same function reading the epoch in live code is paired.
    const liveEpoch: ScannedSource = {
      rel: 'routes/synthetic.ts',
      lines: [
        'async function consumeWithEpoch(req: Request, token: string, username: string) {',
        '  const epoch = req.hiveSessionsInvalidatedAt;',
        '  return consumeSessionFreshAuthToken(token, username, epoch);',
        '}',
      ],
    };
    expect(epochlessConsumes([liveEpoch]).offenders).toEqual([]);

    // The surface pairing's field scan is satisfying-side too: a field named
    // only in prose behind a mid-line-opened comment does not stand in for
    // the field the surface literal must carry.
    const fieldInProse: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'async function consumeSurfaceBesideProse(token: string) {',
        '  const started = Date.now(); /* the field note',
        '   * sessionsInvalidatedAtMs is set by the caller',
        '   */',
        '  return consumeFreshAuthTokenForSurface(token, surface);',
        '}',
      ],
    };
    expect(fieldlessSurfaces([fieldInProse]).offenders).toEqual([
      'lib/synthetic.ts#consumeSurfaceBesideProse',
    ]);

    // The value seam's epoch fact is satisfying-side as well: a shorthand
    // write behind a comment close does not vouch for an accepting surface.
    const epochBehindClose: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'async function consumeBehindClose(token, user, sessionsInvalidatedAtMs) {',
        '  return consumeFreshAuthTokenForSurface(token, {',
        '    acceptSession: true,',
        '    /* forwarded */ sessionsInvalidatedAtMs,',
        '  });',
        '}',
      ],
    };
    expect(literalEpochSurfaces([epochBehindClose]).offenders).toHaveLength(1);

    // And the wrapped VALUE: prose naming the epoch, on a star line the
    // region pass leaves live because a stray backtick refused its opener,
    // must not become the field's value in front of the real literal.
    const wrappedValueBehindProse: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'const TICK_RE = /`/;',
        'async function consumeValueInProse(token: string) {',
        '  return consumeFreshAuthTokenForSurface(token, {',
        '    acceptSession: true,',
        '    sessionsInvalidatedAtMs:',
        '      /**',
        '       * hiveSessionsInvalidatedAt belongs here once wired',
        '       */',
        '      undefined,',
        '  });',
        '}',
      ],
    };
    expect(blockCommentInterior(wrappedValueBehindProse.lines)[6]).toBe(false);
    expect(literalEpochSurfaces([wrappedValueBehindProse]).offenders).toHaveLength(1);
  });

  it('a block comment ahead of live code satisfies nothing and hides no value', () => {
    // A line that opens with a comment and carries code after its close is
    // commented out by shape, so an epoch or a field named inside that comment
    // vouches for nothing. The no-region comment predicate would read the
    // line as live, comment text included, and pair the consume or the
    // surface in the same function.
    const epochAheadOfCode: ScannedSource = {
      rel: 'routes/synthetic.ts',
      lines: [
        'async function consumeBesideLeadingComment(token: string, username: string) {',
        '  return consumeSessionFreshAuthToken(',
        '    token,',
        '    username,',
        '    /* hiveSessionsInvalidatedAt */ undefined,',
        '  );',
        '}',
      ],
    };
    expect(epochlessConsumes([epochAheadOfCode]).offenders).toEqual([
      'routes/synthetic.ts#consumeBesideLeadingComment',
    ]);
    const fieldAheadOfCode: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'async function consumeSurfaceBesideLeadingComment(token: string) {',
        '  return consumeFreshAuthTokenForSurface(',
        '    token,',
        '    /* sessionsInvalidatedAtMs */ surface,',
        '  );',
        '}',
      ],
    };
    expect(fieldlessSurfaces([fieldAheadOfCode]).offenders).toEqual([
      'lib/synthetic.ts#consumeSurfaceBesideLeadingComment',
    ]);

    // The wrapped value. A value line that is commented out by shape but
    // carries code after its close is not stepped past, because that code is
    // the value. Stepping past it would make the next property's line the
    // field's value, and a line there naming the request epoch would vouch
    // for the literal behind the comment.
    const valueBehindComment: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'async function consumeValueBehindComment(req: Request, token: string) {',
        '  return consumeFreshAuthTokenForSurface(token, {',
        '    acceptSession: true,',
        '    sessionsInvalidatedAtMs:',
        '      /* wired later */ undefined,',
        '    note: req.hiveSessionsInvalidatedAt,',
        '  });',
        '}',
      ],
    };
    expect(literalEpochSurfaces([valueBehindComment]).offenders).toHaveLength(1);

    // Nor does the close line of a comment become the value: code after the
    // close does not make the prose before it live, and that prose names the
    // epoch.
    const valueBehindProseClose: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'async function consumeValueBehindProseClose(token: string) {',
        '  return consumeFreshAuthTokenForSurface(token, {',
        '    acceptSession: true,',
        '    sessionsInvalidatedAtMs:',
        '      /* the epoch note',
        '       * hiveSessionsInvalidatedAt belongs here */ undefined,',
        '  });',
        '}',
      ],
    };
    expect(literalEpochSurfaces([valueBehindProseClose]).offenders).toHaveLength(1);

    // A `//` leading the close line of a block comment is comment text, so
    // the code after the close is the value here too, and the next
    // property's line must not stand in for it.
    const slashLedClose: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'async function consumeValueBehindSlashLedClose(req: Request, token: string) {',
        '  return consumeFreshAuthTokenForSurface(token, {',
        '    acceptSession: true,',
        '    sessionsInvalidatedAtMs:',
        '      /* the epoch note',
        '      // wired later */ undefined,',
        '    note: req.hiveSessionsInvalidatedAt,',
        '  });',
        '}',
      ],
    };
    expect(literalEpochSurfaces([slashLedClose]).offenders).toHaveLength(1);
    // The same behind a stray backtick, which makes the region pass refuse
    // the opener. The lookup answers as if a region were open rather than
    // asking the pass, so a region the pass under-reports changes nothing.
    const slashLedCloseParityInverted: ScannedSource = {
      ...slashLedClose,
      lines: ['const TICK_RE = /`/;', ...slashLedClose.lines],
    };
    expect(blockCommentInterior(slashLedCloseParityInverted.lines)[6]).toBe(false);
    expect(literalEpochSurfaces([slashLedCloseParityInverted]).offenders).toHaveLength(1);

    // A wrapped value the lookup cannot read is an offender whatever else
    // the function writes. Classification is per function, so a value that only
    // failed to vouch would be covered by the other surface's epoch write,
    // and the literal behind the comment would pass.
    const unreadBesideEpochWrite: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'async function consumeTwoSurfaces(req: Request, token: string) {',
        '  if (req.fast) {',
        '    return consumeFreshAuthTokenForSurface(token, {',
        '      acceptSession: true,',
        '      sessionsInvalidatedAtMs: req.hiveSessionsInvalidatedAt,',
        '    });',
        '  }',
        '  return consumeFreshAuthTokenForSurface(token, {',
        '    acceptSession: true,',
        '    sessionsInvalidatedAtMs:',
        '      /*',
        '      not wired yet',
        '      */',
        '      undefined,',
        '  });',
        '}',
      ],
    };
    expect(literalEpochSurfaces([unreadBesideEpochWrite]).offenders).toHaveLength(1);

    // Control: a comment that is nothing but comment IS stepped past, so the
    // request epoch written after a docblock is still the field's value.
    const epochAfterDocblock: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'async function consumeEpochAfterDocblock(req: Request, token: string) {',
        '  return consumeFreshAuthTokenForSurface(token, {',
        '    acceptSession: true,',
        '    sessionsInvalidatedAtMs:',
        '      /**',
        '       * read once by the signature middleware',
        '       */',
        '      req.hiveSessionsInvalidatedAt,',
        '  });',
        '}',
      ],
    };
    expect(literalEpochSurfaces([epochAfterDocblock]).offenders).toEqual([]);
  });

  it('a session-accepting surface with a literal epoch value is an offender', () => {
    // Planted probes for the value seam, exercising the same classification the
    // whole-tree scan runs. The first is the exact evasion: field present (the
    // presence pairing passes), value a literal `undefined`, acceptance on.
    const literalUndefined: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'async function consumeBypassingRevocation(token, user) {',
        '  return consumeFreshAuthTokenForSurface(token, {',
        '    expectedUsername: user,',
        '    expectedTargetHash: null,',
        '    acceptSession: true,',
        '    sessionsInvalidatedAtMs: undefined,',
        '  });',
        '}',
      ],
    };
    expect(literalEpochSurfaces([literalUndefined]).offenders).toHaveLength(1);

    // A wrapped literal must not slip through the value classification the way
    // wrapped keys once slipped through the construction scan.
    const wrappedLiteral: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'async function consumeWrappingTheLiteral(token, user) {',
        '  return consumeFreshAuthTokenForSurface(token, {',
        '    expectedUsername: user,',
        '    expectedTargetHash: null,',
        '    acceptSession: true,',
        '    sessionsInvalidatedAtMs:',
        '      undefined,',
        '  });',
        '}',
      ],
    };
    expect(literalEpochSurfaces([wrappedLiteral]).offenders).toHaveLength(1);

    // A surface that mentions the field only as a literal zero — a "number is
    // not undefined" dodge — is equally dead.
    const numericLiteral: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'async function consumeWithZeroEpoch(token, user) {',
        '  return consumeFreshAuthTokenForSurface(token, {',
        '    acceptSession: true,',
        '    sessionsInvalidatedAtMs: 0,',
        '  });',
        '}',
      ],
    };
    expect(literalEpochSurfaces([numericLiteral]).offenders).toHaveLength(1);

    // Controls: the three legitimate postures.
    const passThrough: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'async function consumeSessionStyle(token, user, sessionsInvalidatedAtMs) {',
        '  return consumeFreshAuthTokenForSurface(token, {',
        '    acceptSession: true,',
        '    sessionsInvalidatedAtMs,',
        '  });',
        '}',
      ],
    };
    expect(literalEpochSurfaces([passThrough]).offenders).toEqual([]);

    const requestEpoch: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'async function consumeProofStyle(req, token, user) {',
        '  return consumeFreshAuthTokenForSurface(token, {',
        '    acceptSession: opts.acceptSession === true,',
        '    sessionsInvalidatedAtMs: req.hiveSessionsInvalidatedAt,',
        '  });',
        '}',
      ],
    };
    expect(literalEpochSurfaces([requestEpoch]).offenders).toEqual([]);

    const consentOpPosture: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'async function consumeConsentStyle(token, user, hash) {',
        '  return consumeFreshAuthTokenForSurface(token, {',
        '    acceptSession: false,',
        '    sessionsInvalidatedAtMs: undefined,',
        '  });',
        '}',
      ],
    };
    expect(literalEpochSurfaces([consentOpPosture]).offenders).toEqual([]);
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

    expect(SURFACE_CALL_RE.test('  return consumeFreshAuthTokenForSurface(token, {')).toBe(true);
    expect(SURFACE_DEFINITION_RE.test('async function consumeFreshAuthTokenForSurface(')).toBe(true);
    expect(SURFACE_DEFINITION_RE.test('  return consumeFreshAuthTokenForSurface(token, {')).toBe(false);
    expect(SURFACE_FIELD_RE.test('    sessionsInvalidatedAtMs: undefined,')).toBe(true);
    expect(SURFACE_FIELD_RE.test('    acceptSession: false,')).toBe(false);

    // The value-seam write matchers: key position only, wrapped keys included.
    expect(SURFACE_FIELD_WRITE_RE.test('    sessionsInvalidatedAtMs,')).toBe(true);
    expect(SURFACE_FIELD_WRITE_RE.test('    sessionsInvalidatedAtMs: undefined,')).toBe(true);
    expect(SURFACE_FIELD_WRITE_RE.test('    sessionsInvalidatedAtMs:')).toBe(true);
    expect(SURFACE_FIELD_WRITE_RE.test('  consumeSessionWindow(token, entry, read.fromMemStore, surface.sessionsInvalidatedAtMs);')).toBe(false);
    expect(ACCEPT_SESSION_WRITE_RE.test('    acceptSession: true,')).toBe(true);
    expect(ACCEPT_SESSION_WRITE_RE.test('    acceptSession: opts.acceptSession === true,')).toBe(true);
    expect(ACCEPT_SESSION_WRITE_RE.test('  opts: { acceptSession?: boolean } = {},')).toBe(false);
    expect(ACCEPT_SESSION_WRITE_RE.test('  if (!surface.acceptSession) return;')).toBe(false);

    // Value extraction: same-line, wrapped, and shorthand.
    expect(valueTextAfterKey(['  sessionsInvalidatedAtMs: req.hiveSessionsInvalidatedAt,'], 0, 'sessionsInvalidatedAtMs')).toMatch(/hiveSessionsInvalidatedAt/);
    expect(valueTextAfterKey(['  sessionsInvalidatedAtMs:', '    undefined,'], 0, 'sessionsInvalidatedAtMs')).toMatch(/undefined/);
    expect(valueTextAfterKey(['  sessionsInvalidatedAtMs,'], 0, 'sessionsInvalidatedAtMs')).toBeNull();

    expect(isCommentLine(' * the epoch travels on req.hiveSessionsInvalidatedAt')).toBe(true);
    expect(isCommentLine('      req.hiveSessionsInvalidatedAt,')).toBe(false);

    // A star-leading live consume: a wrapped operand naming the consume. The
    // shape-only reading dropped it as a docblock continuation before it was
    // counted, so an epoch-less consume written this way was never paired —
    // a silent pass in this guard. The block-comment region `occurrencesOf`
    // computes per file is what keeps it an offender, and the same text
    // inside a docblock pairs with nothing and demands nothing.
    const starLeadingConsume: ScannedSource = {
      rel: 'routes/synthetic.ts',
      lines: [
        'async function tallyConsume(token: string, username: string) {',
        '  return Number(flag)',
        '    * consumeSessionFreshAuthToken(token, username).length;',
        '}',
      ],
    };
    expect(epochlessConsumes([starLeadingConsume]).offenders).toEqual([
      'routes/synthetic.ts#tallyConsume',
    ]);
    const proseContinuation: ScannedSource = {
      rel: 'routes/synthetic.ts',
      lines: [
        '/**',
        ' * consumeSessionFreshAuthToken(token, username) demands the epoch.',
        ' */',
      ],
    };
    expect(epochlessConsumes([proseContinuation]).consumes.keys).toEqual([]);
  });
});

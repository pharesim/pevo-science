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
 * column is aligned now and the schema refuses the divergent shape, which is
 * exactly why a behavioural test can no longer show two mints disagreeing: the
 * rows they would disagree about cannot be seeded. What a drift back to an
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
 *      copy of some row's `.custody` into a binding or claim named `custody`.
 *      A handler that re-inlines either has reintroduced a second derivation
 *      whether or not it also still calls the helper.
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
  enclosingSymbol,
  isCommentLine,
  occurrencesOf,
  sourcesUnder,
  type ScannedSource,
} from '../support/enclosing-symbol.js';

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
 *  between. The old inline shape at every mint. */
const EPOCH_TERNARY_RE = /\bupgraded_at\b[^;\n]*\?\s*['"`](?:self|light)['"`]/;

/** A row's `custody` column copied into a binding or claim named `custody`:
 *  `custody: account.custody`, `const custody = row.custody`,
 *  `custody: rows[0].custody`. The old ORCID-login shape. Anchored on the
 *  destination NAME because a claim field is always spelled `custody`, and a
 *  binding that later feeds the claim is, in every site this codebase has
 *  written, spelled the same. */
const COLUMN_COPY_RE = /\bcustody\s*[:=]\s*[\w$.[\]]*\.custody\b/;

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

/** The payload of a mint: the mint line plus the following lines up to the
 *  first closing `)` at the call's own depth, capped so a runaway scan cannot
 *  swallow the next handler. */
function mintPayload(lines: string[], lineIndex: number): string {
  let depth = 0;
  let out = '';
  for (let j = lineIndex; j < lines.length && j <= lineIndex + 12; j++) {
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
      (line) => HELPER_DEFINITION_RE.test(line) || isCommentLine(line),
    );
    expect(keys, `custodyClaimFor call sites:\n${sites.join('\n')}`).toEqual(
      [...ALLOWED_HELPER_CALL_SITES].sort(),
    );
  });

  it('no module outside the helper derives custody from the epoch or copies the column', () => {
    const outside = sources.filter((s) => s.rel !== HELPER_MODULE);
    const ternaries = occurrencesOf(outside, EPOCH_TERNARY_RE, isCommentLine);
    expect(
      ternaries.sites,
      'an inline `upgraded_at ? ... :` derivation is a second copy of the ' +
        `custody-claim rule; route it through custodyClaimFor:\n${ternaries.sites.join('\n')}`,
    ).toEqual([]);
    const copies = occurrencesOf(outside, COLUMN_COPY_RE, isCommentLine);
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
      lines.forEach((line, i) => {
        if (!JWT_MINT_RE.test(line) || isCommentLine(line)) return;
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
    expect(occurrencesOf([synthetic], HELPER_CALL_RE, isCommentLine).keys).toEqual([
      'routes/synthetic.ts#POST /login',
      'routes/synthetic.ts#handleLogin',
    ]);
  });
});

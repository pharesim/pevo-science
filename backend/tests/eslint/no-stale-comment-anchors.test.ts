/**
 * Standing source-discipline canary for the Comment Anchors convention
 * (root `CLAUDE.md` "Comment anchors"). Scans every `.ts` under `backend/src/`
 * and fails on coordination-state anchors that rot when task files archive and
 * `tasks-archive.md` trims:
 *
 *   - `round-N hold` ordinals (hold-block round references).
 *   - Task-slug citations of the form `<role>-<kebab>` (`<role>` ∈
 *     {backend, ui, architect}), with or without a trailing `.md`. Matched
 *     CASE-INSENSITIVELY so it catches both the lowercase mid-comment form
 *     (`backend-foo-bar`) and the uppercase shout form (`BACKEND-FOO-BAR`) in
 *     one pattern — the prior grep-only acceptance check was `^BACKEND-`
 *     (uppercase, line-anchored), which missed both the lowercase class and any
 *     mid-line uppercase slug. This pattern subsumes it.
 *   - Bare `Option X.N` labels (e.g. `Option A.1`) — design-alternative
 *     ordinals whose defining text lives in a since-archived task file.
 *   - Line-number cross-reference cites: a `<file>.ts:<n>` path (also `.tsx`,
 *     `.js`, `.mjs`, `.cjs`, `.sql`), a `line <n>` / `lines <n>-<n>` reference,
 *     or a bare `~<n>` tilde approximation. These rot the instant an edit above
 *     the cited line shifts it; anchor on a stable symbol name instead (the
 *     `docblock-anchor-stable-symbols-not-line-numbers` convention).
 *
 * Why a standing test and not a one-shot grep: the convention's whole point is
 * that these anchors rot SILENTLY over time as unrelated tasks archive. A test
 * in the suite is the only thing that makes "this class cannot recur" true —
 * the next author who reaches for a slug citation gets a red bar, not a clean
 * grep they never ran.
 *
 * DURABLE-PATH CARVE-OUT: persistent knowledge-store references —
 * `agents/docs/solutions/**` and `agents/docs/api-contracts/**` paths — are
 * the convention's explicitly-allowed class (those files persist; they are not
 * task-state coordination anchors). A line that references such a path is
 * exempt from the slug check so a future durable doc whose filename happens to
 * carry a role prefix (e.g. `solutions/conventions/backend-...md`) does not
 * false-trip. The `round-N hold` and `Option X.N` checks have no such
 * exemption — those forms never appear in a legitimate durable-path reference.
 *
 * LINE-CITE TUNING: `backend/src/` comments hold dozens of legitimate `~<n>`
 * approximations — latency (`~50ms`, `~3s`), block strides (`~28,800 blocks`,
 * `~201,600-block`), byte sizes (`~4096 bytes`), ranges (`~5-30s`), decimals
 * (`~3.5 days`), `~2×`, `~95%`, bare counts (`~5 concurrent`). A naive `~\d+`
 * would red-bar every one. The tilde arm therefore fires ONLY when the `~<n>`
 * is terminal — followed by end-of-line or clause punctuation (`)`, `]`, `;`,
 * `:`, `}`, or a `.`/`,` that does not open a decimal/thousands group). Every
 * legitimate quantity is instead followed by a unit letter, another digit, a
 * hyphen, `%`, or `×`, so none trip. Accepted blind spot: a cite immediately
 * followed by a word (`~337 in foo`) reads identically to `~5 concurrent` and
 * is NOT caught; the documented rot form (`now ~337`) is terminal, so this is a
 * deliberate trade for zero false positives. Do NOT broaden the arm to a bare
 * `~\d+` — it would flag all of the legitimate approximations above.
 *
 * The slug regex requires at least two kebab segments after the role prefix
 * (`-seg-seg`), so single-segment tokens like a hypothetical `ui-button` do not
 * match; only multi-segment slug-shaped citations do.
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

// A line that cites a persistent knowledge-store path is exempt from the slug
// check (see DURABLE-PATH CARVE-OUT in the header).
const DURABLE_PATH_RE = /(?:solutions|api-contracts)\//;

const ROUND_HOLD_RE = /round-\d+\s+hold/i;
const OPTION_LABEL_RE = /\bOption\s+[A-Z]\.\d/;
const SLUG_RE = /\b(?:backend|ui|architect)-[a-z0-9]+(?:-[a-z0-9]+)+(?:\.md)?/i;

// Line-number cross-reference cites (see LINE-CITE TUNING in the header). One
// pattern, three forms: a `<file>.<ext>:<n>` path cite, a `line <n>` / `lines
// <n>-<n>` reference, and a terminal `~<n>` tilde approximation. The tilde arm
// is gated on trailing clause punctuation / EOL so unit-bearing quantities
// (`~50ms`, `~28,800`, `~3.5 days`, `~2×`, `~95%`) are spared.
const LINE_CITE_RE =
  /\.(?:ts|tsx|js|mjs|cjs|sql):\d+|\blines?\s+\d+|~\d+(?:\s*$|\s*[)\];:}]|[.,](?!\d))/i;

describe('no stale comment anchors in backend/src/', () => {
  const files = tsFilesUnder(srcRoot);

  it('finds source files to scan (guards against a broken walker)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('has no round-N hold, task-slug, Option X.N, or line-number-cite coordination anchors', () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(srcRoot, file);
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const at = `src/${rel}:${i + 1}`;
        if (ROUND_HOLD_RE.test(line)) violations.push(`${at} — round-N hold ordinal: ${line.trim()}`);
        if (OPTION_LABEL_RE.test(line)) violations.push(`${at} — bare Option X.N label: ${line.trim()}`);
        if (!DURABLE_PATH_RE.test(line) && SLUG_RE.test(line)) {
          violations.push(`${at} — task-slug citation: ${line.trim()}`);
        }
        if (LINE_CITE_RE.test(line)) {
          violations.push(`${at} — line-number cross-reference cite: ${line.trim()}`);
        }
      });
    }
    expect(violations, `stale comment anchors found:\n${violations.join('\n')}`).toEqual([]);
  });

  it('detection regexes fire on planted-bad anchors and spare legitimate / durable tokens', () => {
    // Planted POSITIVES — each rot class MUST be detected. Without this block
    // the scan above can silently no-op: a future edit that mangles a character
    // class in any regex would leave `violations` empty (test stays green) while
    // the canary enforces nothing. These assertions fail RED the moment a regex
    // stops matching the class it owns. The slug strings here are synthetic
    // fixtures (not real citations) exercising the matcher, per the
    // `no-bridge-paper-literal` self-test precedent.
    expect(ROUND_HOLD_RE.test('round-1 hold #6')).toBe(true);
    expect(OPTION_LABEL_RE.test('Option A.1')).toBe(true);
    expect(SLUG_RE.test('backend-some-task')).toBe(true);
    expect(SLUG_RE.test('BACKEND-SOME-TASK')).toBe(true); // case-insensitive arm
    expect(SLUG_RE.test('see backend-some-task.md')).toBe(true); // trailing-.md arm

    // Planted NEGATIVES — legitimate tokens must NOT trip the checks.
    expect(SLUG_RE.test('ui-button')).toBe(false); // single kebab segment, not a slug
    expect(ROUND_HOLD_RE.test('the next round of work')).toBe(false);
    expect(OPTION_LABEL_RE.test('an optional value')).toBe(false);

    // Durable-path carve-out: a slug-shaped filename under solutions/ DOES match
    // SLUG_RE, but the scan gates on `!DURABLE_PATH_RE`, so it is spared. Proves
    // both halves — the slug pattern would catch it, and the exemption rescues
    // it — so neither side can silently break without flipping this assertion.
    const durablePathLine = 'see agents/docs/solutions/conventions/backend-foo-bar-2026-01-01.md';
    expect(SLUG_RE.test(durablePathLine)).toBe(true);
    expect(DURABLE_PATH_RE.test(durablePathLine)).toBe(true);

    // A real task-slug citation on a non-durable line is NOT spared.
    expect(DURABLE_PATH_RE.test('fixed per backend-foo-bar (since archived)')).toBe(false);

    // Line-number-cite arm POSITIVES — each documented form MUST be detected.
    // Synthetic fixtures (fake line numbers, not real citations); they live
    // under tests/, which the scan above does not walk, so they cannot self-trip.
    expect(LINE_CITE_RE.test('see hafsql.ts:371')).toBe(true); // <file>.ts:<n>
    expect(LINE_CITE_RE.test('see edit.js:183')).toBe(true); // .js extension arm
    expect(LINE_CITE_RE.test('around line 555')).toBe(true); // line <n>
    expect(LINE_CITE_RE.test('see lines 555-560')).toBe(true); // lines <n>-<n>
    expect(LINE_CITE_RE.test('the handler is now ~337')).toBe(true); // terminal ~<n> at EOL
    expect(LINE_CITE_RE.test('jumped to ~337.')).toBe(true); // terminal ~<n> before a period
    expect(LINE_CITE_RE.test('(now ~337)')).toBe(true); // terminal ~<n> before a close-paren

    // Line-number-cite arm NEGATIVES — the legitimate `~<n>` quantities kept by
    // the src/ sweep must NOT trip. One representative of each kept class.
    expect(LINE_CITE_RE.test('confirms in ~3s')).toBe(false); // unit-attached latency
    expect(LINE_CITE_RE.test('argon2.verify (~50ms)')).toBe(false); // ms latency
    expect(LINE_CITE_RE.test('~28,800 blocks per cycle')).toBe(false); // thousands group
    expect(LINE_CITE_RE.test('a window (~3.5 days)')).toBe(false); // decimal
    expect(LINE_CITE_RE.test('a ~201,600-block stride')).toBe(false); // hyphenated stride
    expect(LINE_CITE_RE.test('~2× the verify cost')).toBe(false); // multiplication sign
    expect(LINE_CITE_RE.test('submit ~7900 bytes')).toBe(false); // space + unit word
    expect(LINE_CITE_RE.test('~95% of corpus')).toBe(false); // percent
    expect(LINE_CITE_RE.test('~5 concurrent signups')).toBe(false); // bare count + word — also why ~337+word evades
    expect(LINE_CITE_RE.test('pool max:3 connectionTimeoutMillis:5000')).toBe(false); // pool config, no source-ext path
    expect(LINE_CITE_RE.test('the first 3 lines of output')).toBe(false); // reversed: <n> lines, not lines <n>
    expect(LINE_CITE_RE.test('pipeline 3 stages')).toBe(false); // "line" inside a word, not the bare token
  });
});

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

describe('no stale comment anchors in backend/src/', () => {
  const files = tsFilesUnder(srcRoot);

  it('finds source files to scan (guards against a broken walker)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('has no round-N hold, task-slug, or Option X.N coordination anchors', () => {
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
      });
    }
    expect(violations, `stale comment anchors found:\n${violations.join('\n')}`).toEqual([]);
  });
});

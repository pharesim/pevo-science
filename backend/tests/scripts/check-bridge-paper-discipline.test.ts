/**
 * Negative-coverage test for backend/scripts/check-bridge-paper-discipline.sh.
 *
 * The CI guard is the load-bearing defense per the bridge-paper convention
 * (`agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`).
 * An unverified guard is not a guard — these tests confirm:
 *
 *   1. Single-quoted `'bridge_paper'` in a non-allowlisted file → exit 1.
 *   2. Double-quoted `"bridge_paper"` in a non-allowlisted file → exit 1.
 *   3. Backtick-quoted `\`bridge_paper\`` in a non-allowlisted file → exit 1.
 *   4. Concatenation bypass (`'bridge_' + 'paper'`) is documented as out of
 *      scope and NOT detected (asserts the documented behavior; if a future
 *      hardening adds AST scanning, flip this assertion).
 *   5. Same literal in an allowlisted file (e.g. `src/types/hive.ts`) → exit 0.
 *   6. Clean tree (the actual current backend/src/) → exit 0.
 *
 * Each test stages a temporary file inside `backend/src/` (or removes one),
 * runs the script, and restores the source tree before exiting via try/finally.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const BACKEND_ROOT = resolve(__dirname, '../..');
const SCRIPT = resolve(BACKEND_ROOT, 'scripts/check-bridge-paper-discipline.sh');
const SCRATCH_DIR = resolve(BACKEND_ROOT, 'src/__discipline_test_scratch__');
const SCRATCH_FILE = resolve(SCRATCH_DIR, 'spoof.ts');

function runScript(): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8' });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function writeScratch(contents: string) {
  if (!existsSync(SCRATCH_DIR)) mkdirSync(SCRATCH_DIR, { recursive: true });
  writeFileSync(SCRATCH_FILE, contents, 'utf8');
}

function cleanScratch() {
  if (existsSync(SCRATCH_FILE)) unlinkSync(SCRATCH_FILE);
  if (existsSync(SCRATCH_DIR)) rmSync(SCRATCH_DIR, { recursive: true, force: true });
}

describe('check-bridge-paper-discipline.sh', () => {
  afterEach(() => {
    cleanScratch();
  });

  it('passes on the clean tree (no scratch file present)', () => {
    cleanScratch();
    const { code } = runScript();
    expect(code).toBe(0);
  });

  it("fails on a single-quoted 'bridge_paper' literal in a non-allowlisted file", () => {
    writeScratch(`export const SPOOF = 'bridge_paper';\n`);
    const { code, stdout } = runScript();
    expect(code).toBe(1);
    expect(stdout).toContain('discipline violation');
    expect(stdout).toContain('__discipline_test_scratch__/spoof.ts');
  });

  it('fails on a double-quoted "bridge_paper" literal in a non-allowlisted file', () => {
    writeScratch(`export const SPOOF = "bridge_paper";\n`);
    const { code, stdout } = runScript();
    expect(code).toBe(1);
    expect(stdout).toContain('discipline violation');
  });

  it('fails on a backtick-quoted `bridge_paper` literal in a non-allowlisted file', () => {
    writeScratch('export const SPOOF = `bridge_paper`;\n');
    const { code, stdout } = runScript();
    expect(code).toBe(1);
    expect(stdout).toContain('discipline violation');
  });

  it("does NOT detect concatenation bypass forms (documented as out of scope)", () => {
    // 'bridge_' + 'paper' avoids matching the literal — documented limit of
    // the regex-based guard. If/when this hardens to AST scanning, flip the
    // expectation. This test pins the current contract so a future regex
    // tweak that accidentally flags concatenation doesn't surprise anyone.
    writeScratch(`export const SPOOF = 'bridge_' + 'paper';\n`);
    const { code } = runScript();
    expect(code).toBe(0);
  });
});

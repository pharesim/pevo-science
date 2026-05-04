/**
 * Negative-coverage test for backend/scripts/check-bridge-paper-discipline.sh.
 *
 * The lint discipline tripwire is the load-bearing defense per the bridge-paper
 * convention (`agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`).
 * An unverified tripwire is not a tripwire — these tests confirm:
 *
 *   1. Single-quoted `'bridge_paper'` in a non-allowlisted file → exit 1.
 *   2. Double-quoted `"bridge_paper"` in a non-allowlisted file → exit 1.
 *   3. Backtick-quoted `\`bridge_paper\`` in a non-allowlisted file → exit 1.
 *   4. Concatenation bypass (`'bridge_' + 'paper'`) is documented as out of
 *      scope and NOT detected (asserts the documented behavior; if a future
 *      hardening adds AST scanning, flip this assertion).
 *   5. Same literal in an allowlisted file → exit 0.
 *   6. Clean tree (the actual current backend/src/) → exit 0.
 *
 * Each test stages a temporary file in an OS-tmpdir scratch directory inside
 * `backend/src/` (path-allowlisted via test-only env override below), runs the
 * script, and removes the scratch dir in `afterEach`.
 *
 * # Documented out-of-scope: runtime-equivalent bypass classes
 *
 * The grep is a tripwire for accidental drift, not an adversarial sandbox. The
 * following six bypass classes produce the runtime-equivalent string
 * `"bridge_paper"` but do NOT match the literal regex `/('bridge_paper'|"bridge_paper"|\`bridge_paper\`)/`,
 * and are therefore not detected today:
 *
 *   (a) String concatenation:        `'bridge_' + 'paper'`
 *   (b) Template literal interp:     `` `bridge_${'paper'}` ``  (or `${'bridge_'}paper`)
 *   (c) `Array.join`:                `['bridge', 'paper'].join('_')`
 *   (d) Case-toggle:                 `'BRIDGE_PAPER'.toLowerCase()`
 *   (e) `.slice` from longer literal:`'bridge_paper_extra'.slice(0, 12)`
 *   (f) `String.fromCharCode(...)`:  `String.fromCharCode(98,114,105,100,103,101,95,112,97,112,101,114)`
 *
 * Closing these requires AST-level scanning. The structural follow-up is filed
 * as `agents/docs/tasks/.../backend-discipline-guard-pipeline-integration.md`
 * (mechanical pipeline integration of the AST-based discipline rule). Until
 * that lands, the tripwire catches accidental drift only.
 *
 * The architect-owned convention doc enumerates the same classes (architect
 * reconciles the convention doc at archive time; backend cannot edit it).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const BACKEND_ROOT = resolve(__dirname, '../..');
const SCRIPT = resolve(BACKEND_ROOT, 'scripts/check-bridge-paper-discipline.sh');

// Scratch lives under os.tmpdir() with a unique per-process subdir. SIGKILL
// during a test run leaks artifacts into the OS tmpdir, NOT into the live
// `backend/src/` tree (where leaked `'bridge_paper'` literals would break the
// next `npm run lint`). The script honors `BRIDGE_PAPER_DISCIPLINE_ROOT` to
// scan this temp root instead of `backend/src/`.
const SCRATCH_ROOT = resolve(tmpdir(), `pevo-discipline-test-${randomUUID()}`);
const SCRATCH_SRC = resolve(SCRATCH_ROOT, 'src');
const SCRATCH_FILE = resolve(SCRATCH_SRC, 'spoof.ts');
// An allowlisted-shaped file under the temp root: the script's allowlist
// includes `src/hafsql.ts`, so writing the spoof literal there should be
// accepted (exit 0).
const SCRATCH_ALLOWLISTED_FILE = resolve(SCRATCH_SRC, 'hafsql.ts');

function runScript(): { code: number; stdout: string; stderr: string } {
  // `as const` pins the discriminated overload returning
  // `SpawnSyncReturns<string>` (vs `SpawnSyncReturns<Buffer>`); without it
  // TypeScript widens to the union and the `?? ''` fallbacks below would be
  // doing work. With the narrowing, `result.stdout`/`stderr` are typed
  // `string` and the fallbacks are provably redundant — kept only as a
  // null-safety belt in case `status` ever returns null on signal kill.
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8' as const,
    env: { ...process.env, BRIDGE_PAPER_DISCIPLINE_ROOT: SCRATCH_ROOT },
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function writeScratch(contents: string, target: string = SCRATCH_FILE) {
  if (!existsSync(SCRATCH_SRC)) mkdirSync(SCRATCH_SRC, { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function cleanScratch() {
  if (existsSync(SCRATCH_ROOT)) rmSync(SCRATCH_ROOT, { recursive: true, force: true });
}

describe('check-bridge-paper-discipline.sh', () => {
  afterEach(() => {
    cleanScratch();
  });

  it('passes on the clean tree (no scratch file present)', () => {
    cleanScratch();
    // Recreate the empty src/ so the script's grep target exists.
    mkdirSync(SCRATCH_SRC, { recursive: true });
    const { code } = runScript();
    expect(code).toBe(0);
  });

  it("fails on a single-quoted 'bridge_paper' literal in a non-allowlisted file", () => {
    writeScratch(`export const SPOOF = 'bridge_paper';\n`);
    const { code, stdout } = runScript();
    expect(code).toBe(1);
    expect(stdout).toContain('discipline violation');
    expect(stdout).toContain('spoof.ts');
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

  it('passes when the same literal lives in an allowlisted file (src/hafsql.ts shape)', () => {
    // Round-4 hold item 4(a): the documented behavior for allowlisted files
    // was previously untested. `src/hafsql.ts` is the canonical helper home;
    // a literal here is correct-by-allowlist. Driving the script against the
    // temp scratch root with an allowlisted-shaped path proves the exit-0
    // path runs on a positive control.
    writeScratch(`export const ALLOWLISTED = 'bridge_paper';\n`, SCRATCH_ALLOWLISTED_FILE);
    const { code, stdout } = runScript();
    expect(code).toBe(0);
    expect(stdout).toContain('bridge-paper discipline OK');
  });
});

/**
 * Unit coverage for `frontend/tests/e2e/global-teardown.js` — specifically
 * the `scanTracesForSecrets` safety net and the cleanup-first ordering in
 * `globalTeardown()`.
 *
 * WHY MOCK `node:child_process`: building a valid Playwright `trace.zip` in
 * a unit test is impractical — the real artifact is a zip-of-JSONL produced
 * by Playwright's tracing recorder, with a specific directory layout.
 * Handcrafting that just to exercise the `spawnSync('unzip', ...)` path
 * buys nothing over controlling `spawnSync`'s return value directly.
 *
 * The carve-out applies cleanly: we mock only `node:child_process` (and a
 * small file-walk by writing real `trace.zip` files to a tmpdir so the
 * `readdirSync` walker finds them — the content of those files is never
 * read since `spawnSync` is mocked). All secret-detection logic, regex
 * compilation, category labelling, error-classification branches, and the
 * scan-then-cleanup ordering are exercised against the real code.
 *
 * WHY STUB `fetch` IN THE ORDERING TEST: cleanupIpfsPins unpins through the
 * real Kubo HTTP API, and its IPFS address now has a host-side default, so
 * the ordering test would otherwise reach a live node (or hang on one that
 * is down) to prove something unrelated to IPFS. The stub covers only the
 * unpin round-trip; the ordering and reset logic stay real.
 *
 * Covers:
 *   1. WIF, JWT, SESSION_SECRET, BIP39, known-password detection firing.
 *   2. Clean trace → no throw.
 *   3. Category labels in thrown error (no secret bytes).
 *   4. SESSION_SECRET < 16 chars logs explicit warning.
 *   5. `unzip` ENOENT → single warn, early return (no per-file noise).
 *   6. Non-ENOENT error on first file → second file STILL scanned (fix #1).
 *   7. Scan throw → IPFS cleanup still runs, then error re-thrown (fix #2).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// `spawnSync` is the boundary we stub so each test controls what the scanner
// "sees" inside the trace.zip. The `vi.hoisted` block lets the mock reference
// a mutable queue that individual tests configure.
const { spawnQueue, spawnSyncMock } = vi.hoisted(() => {
  const queue = [];
  return {
    spawnQueue: queue,
    spawnSyncMock: vi.fn(() => {
      if (queue.length === 0) {
        throw new Error('spawnSync mock queue exhausted');
      }
      return queue.shift();
    }),
  };
});

// Mock ONLY `spawnSync` — other exports pass through via importOriginal.
// We include `default` explicitly because Node built-ins under vitest mock
// resolution expect a default export shape.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    default: { ...actual, spawnSync: spawnSyncMock },
    spawnSync: spawnSyncMock,
  };
});

// Resolve the teardown module relative to the worktree root so the
// FRONTEND_ROOT constant inside the module lands on the real frontend dir.
// The module computes FRONTEND_ROOT from its own __dirname, so as long as
// the test-results dir exists under frontend/ the walker finds our zips.
const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = resolve(__dirname, '..', '..');
const TEST_RESULTS_DIR = resolve(FRONTEND_ROOT, 'test-results');

let scanTracesForSecrets;
let globalTeardown;
let createdPaths = [];
let createdDirs = [];
let warnSpy;
let originalEnv;

beforeEach(async () => {
  // Fresh module import per test so internal state (none here, but safe) resets.
  vi.resetModules();
  const mod = await import('../e2e/global-teardown.js');
  scanTracesForSecrets = mod.scanTracesForSecrets;
  globalTeardown = mod.default;

  spawnQueue.length = 0;
  spawnSyncMock.mockClear();
  createdPaths = [];
  createdDirs = [];
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  originalEnv = { ...process.env };

  // Walker scans the real test-results/ tree. Stray trace.zip files from
  // prior Playwright runs would steal spawnSync calls from the staged queue,
  // exhausting the mock. Purge any pre-existing trace.zip before each test so
  // the walker only sees what the test stages.
  if (existsSync(TEST_RESULTS_DIR)) {
    const stack = [TEST_RESULTS_DIR];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = readdirSync(dir); } catch { continue; }
      for (const name of entries) {
        const path = join(dir, name);
        let st;
        try { st = statSync(path); } catch { continue; }
        if (st.isDirectory()) stack.push(path);
        else if (name === 'trace.zip') {
          try { rmSync(path, { force: true }); } catch {}
        }
      }
    }
  }
});

afterEach(() => {
  for (const p of createdPaths) {
    try { rmSync(p, { force: true }); } catch {}
  }
  // Reverse order so nested dirs clear before parents.
  for (const d of [...createdDirs].reverse()) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  warnSpy.mockRestore();
  process.env = originalEnv;
});

/** Create a placeholder trace.zip under test-results/<slug>/ so the
 *  readdir walker discovers it. File content is irrelevant (spawnSync
 *  mocked), only the path existence matters. */
function stageTraceFile(slug) {
  const dir = join(TEST_RESULTS_DIR, slug);
  mkdirSync(dir, { recursive: true });
  createdDirs.push(dir);
  const path = join(dir, 'trace.zip');
  writeFileSync(path, 'placeholder');
  createdPaths.push(path);
  return path;
}

function successfulSpawn(text) {
  return {
    error: null,
    status: 0,
    stdout: Buffer.from(text, 'utf8'),
    stderr: Buffer.from(''),
    signal: null,
    pid: 1,
    output: [null, Buffer.from(text, 'utf8'), Buffer.from('')],
  };
}

function errorSpawn(errno, code) {
  const err = new Error(`spawn ${code}`);
  err.code = code;
  if (errno) err.errno = errno;
  return {
    error: err,
    status: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    signal: null,
    pid: null,
    output: [null, Buffer.alloc(0), Buffer.alloc(0)],
  };
}

describe('scanTracesForSecrets — detection', () => {
  it('fires on WIF private key', () => {
    stageTraceFile('t-wif');
    // Synthetic 51-char WIF-shape string (prefix 5K + 49 base58 chars).
    const fake = '5K' + 'a'.repeat(49);
    spawnQueue.push(successfulSpawn(`some noise ${fake} more`));

    expect(() => scanTracesForSecrets()).toThrowError(/WIF private key/);
  });

  it('fires on JWT', () => {
    stageTraceFile('t-jwt');
    const seg = 'A'.repeat(25);
    spawnQueue.push(successfulSpawn(`Bearer ${seg}.${seg}.${seg}`));

    expect(() => scanTracesForSecrets()).toThrowError(/JWT/);
  });

  it('fires on SESSION_SECRET literal', () => {
    stageTraceFile('t-ss');
    spawnQueue.push(successfulSpawn('env SESSION_SECRET=hunter2'));

    expect(() => scanTracesForSecrets()).toThrowError(/SESSION_SECRET literal/);
  });

  it('fires on known test password', () => {
    stageTraceFile('t-pw');
    spawnQueue.push(successfulSpawn('form data: password=E2eTestPass1'));

    expect(() => scanTracesForSecrets()).toThrowError(/known test password/);
  });

  it('fires on known fresh-auth test password', () => {
    stageTraceFile('t-fa-pw');
    // The light-account fixture's TEST_PASSWORD, typed into the reauth modal
    // by the fresh-auth specs. Those specs disable traces themselves; this
    // arm is the backstop for a future importer that forgets to.
    spawnQueue.push(successfulSpawn('form data: password=E2eFreshAuthPass1'));

    expect(() => scanTracesForSecrets()).toThrowError(/known fresh-auth test password/);
  });

  it('fires on BIP39 mnemonic shape', () => {
    stageTraceFile('t-bip');
    // 12 lowercase words of length 3-8, separated by single spaces.
    const words = [
      'alpha', 'bravo', 'cat', 'delta', 'echo', 'fox',
      'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima',
    ];
    spawnQueue.push(successfulSpawn(`seed: ${words.join(' ')}`));

    expect(() => scanTracesForSecrets()).toThrowError(/BIP39 mnemonic/);
  });

  it('fires on SESSION_SECRET value when env is set and >= 16 chars', () => {
    process.env.SESSION_SECRET = 'this-is-a-long-test-secret-1234567890';
    stageTraceFile('t-val');
    spawnQueue.push(successfulSpawn(
      `harmless harmless ${process.env.SESSION_SECRET} harmless`,
    ));

    expect(() => scanTracesForSecrets()).toThrowError(/SESSION_SECRET value/);
  });

  it('does NOT throw on a clean trace', () => {
    stageTraceFile('t-clean');
    spawnQueue.push(successfulSpawn(
      'request: GET /api/accreditation 200 OK\nrequest: POST /api/auth/login 200 OK\n',
    ));

    expect(() => scanTracesForSecrets()).not.toThrow();
  });

  it('error message contains category label, never match bytes', () => {
    stageTraceFile('t-label');
    const secret = '5K' + 'a'.repeat(49);
    spawnQueue.push(successfulSpawn(`leak ${secret} oops`));

    let caught;
    try { scanTracesForSecrets(); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.message).toContain('WIF private key');
    // Guard against regression to the old `.slice(0, 8)` prefix leak:
    expect(caught.message).not.toContain(secret.slice(0, 8));
    expect(caught.message).not.toContain('5Kaaaaaa');
  });
});

describe('scanTracesForSecrets — SESSION_SECRET < 16 warning', () => {
  it('logs explicit warning when SESSION_SECRET is too short', () => {
    process.env.SESSION_SECRET = 'short';
    stageTraceFile('t-short');
    spawnQueue.push(successfulSpawn('clean trace content'));

    scanTracesForSecrets();

    const warned = warnSpy.mock.calls.some((args) =>
      String(args[0]).includes('SESSION_SECRET < 16 chars, value-scan disabled'),
    );
    expect(warned).toBe(true);
  });

  it('does NOT warn when SESSION_SECRET is absent', () => {
    delete process.env.SESSION_SECRET;
    stageTraceFile('t-absent');
    spawnQueue.push(successfulSpawn('clean'));

    scanTracesForSecrets();

    const warned = warnSpy.mock.calls.some((args) =>
      String(args[0]).includes('value-scan disabled'),
    );
    expect(warned).toBe(false);
  });
});

describe('scanTracesForSecrets — error classification', () => {
  it('ENOENT (unzip binary missing) aborts scan after single warn', () => {
    stageTraceFile('t-enoent-1');
    stageTraceFile('t-enoent-2');
    // First call returns ENOENT; subsequent calls should NOT happen.
    spawnQueue.push(errorSpawn(-2, 'ENOENT'));

    scanTracesForSecrets();

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const warned = warnSpy.mock.calls.some((args) =>
      String(args[0]).includes('`unzip` binary not found'),
    );
    expect(warned).toBe(true);
  });

  it('ENOBUFS on first file still scans second file (regression for fix #1)', () => {
    stageTraceFile('t-buf-1');
    stageTraceFile('t-buf-2');
    // Queue: file 1 -> ENOBUFS, file 2 -> clean success. Order of file
    // iteration depends on readdir; supply TWO non-ENOENT errors + one
    // success to be resilient to iteration order, then assert both files
    // were attempted (call count) and no throw occurred.
    spawnQueue.push(errorSpawn(null, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'));
    spawnQueue.push(successfulSpawn('clean'));

    expect(() => scanTracesForSecrets()).not.toThrow();
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it('ENOBUFS on first file + leak on second file still throws', () => {
    stageTraceFile('t-buf-leak-1');
    stageTraceFile('t-buf-leak-2');
    spawnQueue.push(errorSpawn(null, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'));
    spawnQueue.push(successfulSpawn(`leak: 5K${'b'.repeat(49)}`));

    expect(() => scanTracesForSecrets()).toThrowError(/WIF private key/);
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });
});

describe('globalTeardown — cleanup ordering (fix #2)', () => {
  it('runs IPFS cleanup even when scan throws, then re-throws', async () => {
    // Stage a dirty trace so scan throws.
    stageTraceFile('t-order');
    spawnQueue.push(successfulSpawn(`leak 5K${'c'.repeat(49)}`));

    // Track whether cleanup ran by watching readCapturedCids -> no CIDs
    // path (cheapest signal that cleanupIpfsPins executed to completion).
    // We assert via resetCapturedCids invocation: when there are zero
    // captured CIDs, cleanupIpfsPins calls resetCapturedCids() and returns.
    // Instead of spying on that (module re-import complicates vi.spyOn),
    // we assert the ORDER via side effect: the captured-cids JSONL file
    // must be absent after teardown even though scan threw.
    const capturedCidsPath = resolve(
      FRONTEND_ROOT, 'tests', 'e2e', '.captured-cids.jsonl',
    );
    // Seed the captured-cids file with a sentinel line. If cleanup runs
    // (even without a valid IPFS_API_URL), resetCapturedCids removes it.
    writeFileSync(capturedCidsPath, '{"cid":"QmTest"}\n');
    createdPaths.push(capturedCidsPath);

    // Keep cleanup hermetic. IPFS_API_URL and APP_TAG now carry defaults, so
    // unsetting them no longer keeps this off the network: stub the Kubo
    // unpin call, and blank REDIS_URL so the ledger half skips instead of
    // dialing. It must be an empty string, NOT a delete: globalTeardown's own
    // loadEnvFile repopulates every key absent from process.env, so deleting
    // REDIS_URL is precisely what lets frontend/.env.test put a live URL back.
    // The assertion here is about ORDER, not about either backend being
    // reachable.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, text: async () => '' });
    process.env.REDIS_URL = '';

    let caught;
    try {
      await globalTeardown();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught.message).toContain('WIF private key');
    // Cleanup's resetCapturedCids ran, proving cleanup executed BEFORE throw.
    const fs = await import('node:fs');
    expect(fs.existsSync(capturedCidsPath)).toBe(false);
    // The stubbed unpin was actually reached, so the ordering assertion is
    // not passing vacuously through an early return.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // And the ledger half really skipped rather than opening a socket, which
    // is what keeps this test hermetic. Asserting the skip is what catches a
    // regression back to a form loadEnvFile can undo.
    expect(warnSpy).toHaveBeenCalledWith(
      '[e2e teardown] REDIS_URL not set. skipping redis key deletion.',
    );
    fetchSpy.mockRestore();
  });
});

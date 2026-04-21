/**
 * Playwright global-teardown — unpins IPFS CIDs that the suite created.
 *
 * Why this exists: E2E uploads go through the real backend pinning proxy but
 * the spec intercepts the final Hive broadcast, so CIDs never land in HAF.
 * The backend's 24h orphan cleanup would eventually unpin them, but in the
 * meantime test pins pile up on the shared dev Kubo node. We unpin per-CID
 * (captured via the keychain fixture's response listener) instead of flushing
 * `ipfs:pending:*`, which would also kill dev uploads on the shared Redis.
 *
 * The DB reset lives in global-setup, not here — leaving rows after a failed
 * run is intentional so they can be inspected.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Redis from 'ioredis';
import { readCapturedCids, resetCapturedCids } from './fixtures/captured-cids.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = resolve(__dirname, '..', '..');
const REPO_ROOT = resolve(FRONTEND_ROOT, '..');

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const contents = readFileSync(path, 'utf8');
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function unpinFromKubo(ipfsApiUrl, cid) {
  const response = await fetch(
    `${ipfsApiUrl}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`,
    { method: 'POST', signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) {
    const text = await response.text();
    // "not pinned" means someone already unpinned it — treat as success
    if (text.includes('not pinned')) return;
    throw new Error(`Kubo unpin ${response.status}: ${text}`);
  }
}

/**
 * Scan every retained `trace.zip` under `test-results/` for known secret
 * substrings and throw if any match. Safety net for specs that forget to
 * opt out of `trace: 'retain-on-failure'` before handling real keys.
 *
 * Secrets checked:
 *   - Uncompressed Base58 WIF private keys (Hive prefixes `5H`, `5J`, `5K`,
 *     51 chars) — the format owner/active/posting/memo keys ship in.
 *   - Compressed Base58 WIF private keys (prefix `K` or `L`, 52 chars).
 *     Bitcoin-style compressed WIFs are produced by some libraries when
 *     deriving keys from a BIP39 mnemonic; worth catching even though
 *     Hive itself prefers the uncompressed form.
 *   - Three-segment base64url tokens (JWT shape: header.payload.signature,
 *     each segment 20+ chars). Catches bearer JWTs minted via `mintSessionJwt`
 *     / `seedAccreditedSession` / `seedUnaccreditedSession` even when the
 *     SESSION_SECRET literal isn't in the trace.
 *   - `SESSION_SECRET=` assignment form and `"SESSION_SECRET"` JSON-key form.
 *     Either could leak the literal key name, which is enough signal to
 *     investigate even without the value adjacent.
 *   - 12-word lowercase BIP39 mnemonic shape (11 spaces between 12 words of
 *     3-8 lowercase letters). Catches seed phrases that drive the light-
 *     account signup path.
 *   - `SESSION_SECRET` value itself (checked separately via env lookup).
 *   - Known E2E-minted password `E2eTestPass1` used by seed-phrase,
 *     email-signup, login-email, password-recovery, settings.
 *
 * `trace.zip` is a ZIP archive of JSONL. We unzip via `unzip -p`; if that
 * binary is unavailable the scan is skipped (with a warning) rather than
 * failing the run — the opt-out pattern in actions #1 is the primary defense.
 */
export function scanTracesForSecrets() {
  const testResultsDir = resolve(FRONTEND_ROOT, 'test-results');
  if (!existsSync(testResultsDir)) return;

  const traceFiles = [];
  const stack = [testResultsDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(dir, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.isDirectory()) {
        stack.push(path);
      } else if (name === 'trace.zip') {
        traceFiles.push(path);
      }
    }
  }

  if (traceFiles.length === 0) return;

  // Regex alternation for each secret class, each wrapped in a capture group
  // so the matching group can be identified and reported as a CATEGORY LABEL.
  // The previous implementation spliced the first 8 bytes of the match into
  // the thrown error — a partial-prefix leak into CI logs. Labels are safe.
  const patterns = [
    { label: 'WIF private key', source: '5[HJK][1-9A-HJ-NP-Za-km-z]{49}' },
    { label: 'compressed WIF', source: '[KL][1-9A-HJ-NP-Za-km-z]{51}' },
    { label: 'JWT', source: '[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}' },
    { label: 'SESSION_SECRET literal', source: 'SESSION_SECRET[=:]' },
    { label: 'SESSION_SECRET JSON key', source: '"SESSION_SECRET"' },
    { label: 'BIP39 mnemonic', source: '([a-z]{3,8} ){11}[a-z]{3,8}' },
    { label: 'known test password', source: 'E2eTestPass1' },
  ];
  // Each pattern wrapped in its own outer group so we can identify which one
  // matched. Note the BIP39 source already contains one inner group; that is
  // fine — we only key on the outermost per-pattern group indices below.
  const combined = new RegExp(
    patterns.map((p) => `(${p.source})`).join('|'),
  );
  // Precompute the capture-group offset for each pattern: pattern i owns
  // group index `groupOffsets[i]` (1-indexed into match array). Inner groups
  // inside a pattern's source bump the next pattern's offset accordingly.
  const groupOffsets = [];
  {
    let offset = 1;
    for (const p of patterns) {
      groupOffsets.push(offset);
      // Count outer + inner groups in this pattern's source. We only have to
      // worry about unescaped `(` that are not non-capturing `(?:`.
      const innerGroups = (p.source.match(/\((?!\?:)/g) || []).length;
      offset += 1 + innerGroups;
    }
  }

  const sessionSecretValue = process.env.SESSION_SECRET;
  let secretValuePattern = null;
  if (sessionSecretValue && sessionSecretValue.length >= 16) {
    secretValuePattern = sessionSecretValue;
  } else if (sessionSecretValue) {
    // Silent skip risk before this fix: a short dev SESSION_SECRET disabled
    // the value-scan without signal. Explicit warn so operators notice.
    console.warn(
      '[e2e global-teardown] SESSION_SECRET < 16 chars, value-scan disabled',
    );
  }

  const leaks = [];
  for (const tracePath of traceFiles) {
    const unzipped = spawnSync('unzip', ['-p', tracePath], {
      maxBuffer: 200 * 1024 * 1024,
      encoding: 'buffer',
    });
    if (unzipped.error) {
      // ENOENT = `unzip` binary is missing. Every subsequent file would fail
      // the same way; short-circuit. Any other error (ERR_CHILD_PROCESS_STDIO_MAXBUFFER,
      // EACCES on a single trace, transient I/O, etc.) is per-file so we
      // `continue` and still scan the remaining traces.
      if (unzipped.error.code === 'ENOENT') {
        console.warn(
          `[e2e teardown] trace secret-scan aborted: \`unzip\` binary not found (${unzipped.error.message}). Install unzip to enable scan.`,
        );
        return;
      }
      console.warn(
        `[e2e teardown] trace secret-scan skipped for ${tracePath} (${unzipped.error.code || 'unknown'}): ${unzipped.error.message}`,
      );
      continue;
    }
    if (unzipped.status !== 0) {
      console.warn(
        `[e2e teardown] unzip failed for ${tracePath} (exit ${unzipped.status}); skipping.`,
      );
      continue;
    }
    const text = unzipped.stdout.toString('utf8');
    const patternMatch = combined.exec(text);
    const valueMatch = secretValuePattern && text.includes(secretValuePattern);
    if (patternMatch || valueMatch) {
      let kind;
      if (valueMatch) {
        kind = 'SESSION_SECRET value';
      } else {
        // Find which pattern's outer group captured. Report its label only —
        // never splice match bytes into the error, to keep CI logs clean.
        const patternIdx = groupOffsets.findIndex(
          (off) => patternMatch[off] !== undefined,
        );
        kind = patternIdx >= 0 ? patterns[patternIdx].label : 'unknown pattern';
      }
      leaks.push({ path: tracePath, kind });
    }
  }

  if (leaks.length > 0) {
    const lines = leaks
      .map((l) => `  - ${l.path} (${l.kind})`)
      .join('\n');
    throw new Error(
      `[e2e teardown] Secret material found in retained Playwright traces:\n${lines}\n` +
        'Add `test.use({ trace: \'off\', video: \'off\', screenshot: \'off\' })` to the offending spec(s).',
    );
  }
}

export async function cleanupIpfsPins() {
  const cids = readCapturedCids();
  if (cids.length === 0) {
    resetCapturedCids();
    return;
  }

  const ipfsApiUrl = process.env.IPFS_API_URL;
  const redisUrl = process.env.REDIS_URL;
  const appTag = process.env.APP_TAG;

  if (!ipfsApiUrl) {
    console.warn(
      `[e2e teardown] IPFS_API_URL not set — skipping unpin for ${cids.length} CID(s). ` +
        'Backend orphan cleanup will remove them within 24h.',
    );
    resetCapturedCids();
    return;
  }

  let redis = null;
  if (redisUrl && appTag) {
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    });
    redis.on('error', () => {}); // swallow — we'll fall through to log on use
    try {
      await redis.connect();
    } catch (err) {
      console.warn(`[e2e teardown] Redis connect failed: ${err.message}`);
      redis = null;
    }
  } else if (!redisUrl) {
    console.warn('[e2e teardown] REDIS_URL not set. skipping redis key deletion.');
  } else {
    console.warn('[e2e teardown] APP_TAG not set. skipping redis key deletion to avoid wrong-prefix deletes.');
  }

  let unpinned = 0;
  let unpinFailed = 0;
  let redisDeleted = 0;
  let redisFailed = 0;

  for (const cid of cids) {
    try {
      await unpinFromKubo(ipfsApiUrl, cid);
      unpinned++;
    } catch (err) {
      unpinFailed++;
      console.warn(`[e2e teardown] unpin ${cid} failed: ${err.message}`);
    }

    if (redis) {
      try {
        const removed = await redis.del(`${appTag}:ipfs:pending:${cid}`);
        if (removed > 0) redisDeleted++;
      } catch (err) {
        redisFailed++;
        console.warn(`[e2e teardown] redis del ${cid} failed: ${err.message}`);
      }
    }
  }

  if (redis) {
    await redis.quit().catch(() => {});
  }

  console.log(
    `[e2e teardown] IPFS cleanup: ${unpinned}/${cids.length} unpinned` +
      (unpinFailed ? ` (${unpinFailed} failed)` : '') +
      (redis ? `, ${redisDeleted} redis keys deleted` : '') +
      (redisFailed ? ` (${redisFailed} redis failed)` : ''),
  );

  resetCapturedCids();
}

export default async function globalTeardown() {
  loadEnvFile(resolve(FRONTEND_ROOT, '.env.test'));
  loadEnvFile(resolve(REPO_ROOT, '.env'));

  // Capture scan error so IPFS cleanup still runs. Previously a leak-detected
  // throw short-circuited teardown and orphaned CIDs on the shared Kubo node.
  // Cleanup-first semantics: always unpin what the run pinned, then surface
  // the scan failure so the CI job still fails on secret leakage.
  let scanError = null;
  try {
    scanTracesForSecrets();
  } catch (err) {
    scanError = err;
  }

  await cleanupIpfsPins();

  if (scanError) throw scanError;
}

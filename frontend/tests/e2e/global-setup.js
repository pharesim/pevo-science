/**
 * Playwright global-setup — resets the `pevo_app_test` Postgres DB before every
 * E2E run by invoking the backend-provided reset hook from TEST-001-BE.
 *
 * DB routing:
 *   - `APP_DATABASE_URL` must point at the dedicated `pevo_app_test` database,
 *     never the dev `pevo_app`. The backend script's safety gate refuses to run
 *     unless the database name ends in `_test`, so this is also enforced server
 *     side.
 *   - The env var can be set on the command line or in `frontend/.env.test`
 *     (key=value lines). CLI env wins.
 *
 * HAF and the Hive network stay read-only in E2E; no setup is needed there.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import { resetCapturedCids } from './fixtures/captured-cids.js';

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

export default async function globalSetup() {
  loadEnvFile(resolve(FRONTEND_ROOT, '.env.test'));

  // Clear any leftover CIDs from a previous run so teardown doesn't try to
  // unpin CIDs that were already cleaned up.
  resetCapturedCids();

  // Belt-and-suspenders: refuse to run E2E against anything that isn't
  // localhost. The auth fixture mints real JWTs from SESSION_SECRET, and
  // specs write to pevo_app_test via direct pg.Pool; pointing either at a
  // live deployment would authenticate against or corrupt it. Pairs with
  // the repo-root `.env` fallback removal in fixtures/auth.js.
  const baseURL = process.env.PEVO_TEST_BASE_URL || 'http://localhost:3001';
  if (!baseURL.startsWith('http://localhost') && !baseURL.startsWith('http://127.0.0.1')) {
    throw new Error(
      `[e2e global-setup] PEVO_TEST_BASE_URL must point at localhost (got "${baseURL}"). ` +
        'E2E specs mint real JWTs and write directly to the backing DB; running ' +
        'against a remote target is unsafe by design.',
    );
  }

  if (!process.env.APP_DATABASE_URL) {
    throw new Error(
      '[e2e global-setup] APP_DATABASE_URL is not set. ' +
        'Point it at pevo_app_test (e.g. via frontend/.env.test) before running E2E.',
    );
  }

  const result = spawnSync(
    'npm',
    ['run', '--prefix', 'backend', '--silent', 'test-db:reset'],
    {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
    },
  );

  if (result.status !== 0) {
    throw new Error(`[e2e global-setup] test-db:reset exited with code ${result.status}`);
  }

  await resetRateLimitKeys();
}

/**
 * Delete every rate-limit key the backend may have written during a prior
 * test run (or dev usage of the same Redis). Rate-limit keys carry the
 * prefix `${appTag}:rl:<limiter-name>:<ip-or-account>` — see
 * `backend/src/middleware/rateLimit.ts`. The signup/recovery limiters are
 * strict enough (e.g. 3 per IP per hour) that a couple of prior failed
 * runs exhaust the quota for the rest of the day, causing spurious 429s
 * on specs that drive those endpoints.
 *
 * Narrow-by-design: we only touch `${appTag}:rl:*`. Caches, session keys,
 * accreditation-status keys, and the IPFS pending-pin ledger that
 * global-teardown relies on are all left intact.
 */
async function resetRateLimitKeys() {
  const redisUrl = process.env.REDIS_URL;
  const appTag = process.env.APP_TAG || 'pevotest';
  if (!redisUrl) {
    console.warn(
      '[e2e global-setup] REDIS_URL not set — skipping rate-limit reset. ' +
        'Specs that drive signup/recovery endpoints may 429 if Redis carries ' +
        'quota from prior runs.',
    );
    return;
  }

  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });
  redis.on('error', () => {});
  try {
    await redis.connect();
  } catch (err) {
    console.warn(
      `[e2e global-setup] Redis connect failed (${err.message}); ` +
        'skipping rate-limit reset.',
    );
    return;
  }

  const pattern = `${appTag}:rl:*`;
  let deleted = 0;
  try {
    const stream = redis.scanStream({ match: pattern, count: 500 });
    for await (const keys of stream) {
      if (keys.length === 0) continue;
      deleted += await redis.del(...keys);
    }
  } catch (err) {
    console.warn(
      `[e2e global-setup] rate-limit key scan failed (${err.message}); ` +
        'E2E specs may hit 429s.',
    );
  } finally {
    await redis.quit().catch(() => {});
  }
  if (deleted > 0) {
    console.log(`[e2e global-setup] cleared ${deleted} rate-limit key(s) under "${pattern}"`);
  }
}

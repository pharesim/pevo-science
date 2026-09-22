/**
 * Playwright global-setup — resets the `pevo_app_test` Postgres DB before every
 * E2E run by invoking the backend-provided database reset hook.
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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import { resetCapturedCids } from './fixtures/captured-cids.js';
import { parseEnvFile } from './fixtures/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = resolve(__dirname, '..', '..');
const REPO_ROOT = resolve(FRONTEND_ROOT, '..');

/**
 * Hydrate process.env from frontend/.env.test without overwriting values
 * already set on the command line. Delegates parsing to parseEnvFile (the
 * same helper fixtures/auth.js uses) so a single parser covers both paths
 * and corner-cases like inline `# comment` stripping can't diverge.
 */
function hydrateEnvFromFile(path) {
  const parsed = parseEnvFile(path);
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

export default async function globalSetup() {
  hydrateEnvFromFile(resolve(FRONTEND_ROOT, '.env.test'));

  // Clear any leftover CIDs from a previous run so teardown doesn't try to
  // unpin CIDs that were already cleaned up.
  resetCapturedCids();

  // Belt-and-suspenders: refuse to run E2E against anything that isn't
  // localhost. The auth fixture mints real JWTs from SESSION_SECRET, and
  // specs write to pevo_app_test via direct pg.Pool; pointing either at a
  // live deployment would authenticate against or corrupt it. Pairs with
  // the repo-root `.env` fallback removal in fixtures/auth.js.
  const baseURL = process.env.PEVO_TEST_BASE_URL || 'http://localhost:3001';
  // Parse the URL and compare hostname exactly. startsWith() would accept
  // `http://localhost.attacker.com` — the attacker-controlled subdomain
  // resolves normally via DNS and the fixture would happily mint JWTs
  // against it. Hostname equality against `localhost` / `127.0.0.1` /
  // `[::1]` closes that.
  let hostname;
  try {
    hostname = new URL(baseURL).hostname;
  } catch {
    throw new Error(
      `[e2e global-setup] PEVO_TEST_BASE_URL is not a valid URL: "${baseURL}".`,
    );
  }
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]') {
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
 *
 * Fails the run rather than skipping. REDIS_URL carries a password, so it
 * cannot be defaulted the way the secret-free values are, and the common
 * misconfiguration is not "unset" but "set and stale": the stack is in dev
 * mode so nothing is published on the loopback port, or the password moved.
 * Skipping turns either into intermittent 429s in whichever signup or
 * recovery spec happens to run first, which costs far more to diagnose than
 * a named failure here.
 */
async function resetRateLimitKeys() {
  const redisUrl = process.env.REDIS_URL;
  const appTag = process.env.APP_TAG || 'pevotest';
  if (!redisUrl) {
    throw new Error(
      '[e2e global-setup] REDIS_URL is not set. Point it at the Redis the ' +
        'test override publishes on loopback (see frontend/.env.test.example) ' +
        'before running E2E.',
    );
  }

  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });
  // Keep the last transport error instead of logging each one. The rejection
  // from connect() is a generic "Connection is closed."; the cause that names
  // the actual problem (WRONGPASS, ECONNREFUSED) only ever arrives on this
  // event, so the throw below folds it in. Neither message embeds the URL, so
  // nothing here can print the password.
  let lastRedisError = null;
  redis.on('error', (err) => {
    lastRedisError = err;
  });

  const pattern = `${appTag}:rl:*`;
  let deleted = 0;
  try {
    await redis.connect();
    const stream = redis.scanStream({ match: pattern, count: 500 });
    for await (const keys of stream) {
      if (keys.length === 0) continue;
      deleted += await redis.del(...keys);
    }
  } catch (err) {
    // disconnect(), not quit(): quit() round-trips to a server we may never
    // have reached, and leaving the client open lets ioredis reconnect on its
    // default schedule for the rest of the process.
    redis.disconnect();
    const cause =
      lastRedisError && lastRedisError.message !== err.message
        ? `${err.message}; cause: ${lastRedisError.message}`
        : err.message;
    throw new Error(
      `[e2e global-setup] rate-limit reset failed (${cause}). Check that ` +
        'the stack is running under `./deploy.sh test-up`, which publishes ' +
        'Redis on loopback, and that the password matches REDIS_PASSWORD in ' +
        'the repo-root .env.',
    );
  }
  await redis.quit().catch(() => {});
  if (deleted > 0) {
    console.log(`[e2e global-setup] cleared ${deleted} rate-limit key(s) under "${pattern}"`);
  }
}

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
}

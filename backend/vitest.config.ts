import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // Load ../.env (project root) so tests have APP_TAG, HAF_DATABASE_URL, etc.
  // without requiring agents/developers to manually source the env file.
  const env = loadEnv(mode, resolve(__dirname, '..'), '');
  return {
    test: {
      globals: true,
      environment: 'node',
      env: {
        ...env,
        // Backend auth.ts asserts UV_THREADPOOL_SIZE >= 16 at module load.
        // Explicit here so tests pass regardless of the ambient shell env.
        UV_THREADPOOL_SIZE: '16',
      },
      include: ['tests/**/*.test.ts'],
      testTimeout: 30_000,
      hookTimeout: 15_000,
      // maxWorkers=2 + retry=3: the external HAF SQL endpoint has limited
      // connection capacity, so 3+ concurrent test files saturate it and
      // tests fail with ECONNRESET/ETIMEDOUT bursts. retry=3 absorbs the
      // residual flake when both workers happen to hit a transient drop.
      // Paired with `tests/support/haf-query.ts queryWithRetry`'s 8-attempt
      // exponential backoff at the query level, which absorbs most HAF
      // ECONNRESET/ETIMEDOUT bursts within a single test attempt.
      maxWorkers: 2,
      retry: 3,
      setupFiles: ['tests/setup.ts'],
      coverage: {
        provider: 'v8',
        include: ['src/**/*.ts'],
        exclude: ['src/index.ts'],
      },
    },
  };
});

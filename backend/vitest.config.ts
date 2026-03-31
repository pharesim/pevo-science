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
      env,
      include: ['tests/**/*.test.ts'],
      testTimeout: 30_000,
      hookTimeout: 15_000,
      maxWorkers: 3,
      retry: 1,
      setupFiles: ['tests/setup.ts'],
      coverage: {
        provider: 'v8',
        include: ['src/**/*.ts'],
        exclude: ['src/index.ts'],
      },
    },
  };
});

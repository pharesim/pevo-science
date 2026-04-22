import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.js$/,
  baseURL: process.env.PEVO_TEST_BASE_URL || 'http://localhost:3001',
  globalSetup: './tests/e2e/global-setup.js',
  globalTeardown: './tests/e2e/global-teardown.js',
  reporter: [['list'], ['html', { open: 'never' }]],
  // HAF SQL is a shared external dependency. Under parallel worker load,
  // /api/papers, /api/accreditations, and per-paper enrichment queries return
  // empty or partial data often enough that retries don't absorb it — the
  // backpressure persists across retry attempts in the same run. Serializing
  // to a single worker is the only configuration that yields a reliably
  // green suite against the dev HAF node. Retries stay enabled as a
  // belt-and-suspenders for the occasional lone-query timeout.
  workers: 1,
  retries: 1,
  use: {
    baseURL: process.env.PEVO_TEST_BASE_URL || 'http://localhost:3001',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

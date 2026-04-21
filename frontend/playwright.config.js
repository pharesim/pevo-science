import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.js$/,
  baseURL: process.env.PEVO_TEST_BASE_URL || 'http://localhost:3001',
  globalSetup: './tests/e2e/global-setup.js',
  globalTeardown: './tests/e2e/global-teardown.js',
  reporter: [['list'], ['html', { open: 'never' }]],
  // HAF SQL is a shared external dependency — a handful of specs read real
  // accreditations/papers/enrichment from it, and concurrent queries from
  // multiple Playwright workers occasionally throttle or time out. One
  // retry soaks up the transient failure without serializing the suite.
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

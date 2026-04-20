import { test, expect } from './fixtures/keychain.js';

test('harness smoke — Keychain stub is injected before app scripts', async ({ page }) => {
  await page.goto('/');
  const kind = await page.evaluate(() => typeof window.hive_keychain?.requestSignBuffer);
  expect(kind).toBe('function');
});

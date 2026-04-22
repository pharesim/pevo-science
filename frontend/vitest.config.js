import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.js'],
    globals: false,
    // Globally restore all mocks after each test so console spies created
    // inline (vi.spyOn(console, 'warn')) can't leak suppressed-warn
    // behavior into subsequent tests if an assertion throws before the
    // inline mockRestore(). See FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-
    // FRONTEND hold item #4.
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
    },
  },
});

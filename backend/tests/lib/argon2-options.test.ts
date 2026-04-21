import { describe, it, expect } from 'vitest';
import argon2 from 'argon2';
import { ARGON2_OPTIONS } from '../../src/lib/argon2-options.js';

// OWASP Password Storage Cheat Sheet (2024) minimums for argon2id:
// memoryCost >= 19456 KiB, timeCost >= 2, parallelism >= 1.
// A future weakening of ARGON2_OPTIONS will fail these assertions.
describe('ARGON2_OPTIONS', () => {
  it('uses argon2id variant', () => {
    expect(ARGON2_OPTIONS.type).toBe(argon2.argon2id);
  });

  it('meets OWASP memoryCost minimum (>= 19456)', () => {
    expect(ARGON2_OPTIONS.memoryCost).toBeGreaterThanOrEqual(19456);
  });

  it('meets OWASP timeCost minimum (>= 2)', () => {
    expect(ARGON2_OPTIONS.timeCost).toBeGreaterThanOrEqual(2);
  });

  it('meets OWASP parallelism minimum (>= 1)', () => {
    expect(ARGON2_OPTIONS.parallelism).toBeGreaterThanOrEqual(1);
  });

  it('produces a valid argon2id hash end-to-end', async () => {
    const hash = await argon2.hash('pevo-argon2-options-test', ARGON2_OPTIONS);
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(hash, 'pevo-argon2-options-test')).toBe(true);
  });
});

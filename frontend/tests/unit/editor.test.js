import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  markdownToHtml,
  createTurndown,
  wrapMarkdownSelection,
  prefixMarkdownLines,
  isImageFile,
} from '../../src/editor.js';

// --- markdownToHtml ---

describe('markdownToHtml', () => {
  it('converts inline math to Tiptap format', () => {
    const html = markdownToHtml('The formula $x^2$ is nice.');
    expect(html).toContain('data-type="inline-math"');
    expect(html).toContain('data-latex="x^2"');
  });

  it('converts block math to Tiptap format', () => {
    const html = markdownToHtml('$$\nE = mc^2\n$$');
    expect(html).toContain('data-type="block-math"');
    expect(html).toContain('data-latex="E = mc^2"');
  });

  it('converts multiple inline math expressions in one paragraph', () => {
    // Guards against the 'g' flag being dropped from the inline math regex
    const html = markdownToHtml('Both $a^2$ and $b^2$ are squared.');
    const matches = html.match(/data-type="inline-math"/g) || [];
    expect(matches.length).toBe(2);
    expect(html).toContain('data-latex="a^2"');
    expect(html).toContain('data-latex="b^2"');
  });

  it('converts multiple block math expressions', () => {
    // Guards against the 'g' flag being dropped from the block math regex
    const html = markdownToHtml('$$\nE=mc^2\n$$\n\n$$\nF=ma\n$$');
    const matches = html.match(/data-type="block-math"/g) || [];
    expect(matches.length).toBe(2);
    expect(html).toContain('data-latex="E=mc^2"');
    expect(html).toContain('data-latex="F=ma"');
  });

  it('strips autolinked literals (bare URLs)', () => {
    const html = markdownToHtml('Visit https://example.com today.');
    // Should NOT wrap bare URL in <a> tag
    expect(html).not.toContain('<a');
    expect(html).toContain('https://example.com');
  });

  it('preserves explicit markdown links', () => {
    const html = markdownToHtml('[Link](https://example.com)');
    expect(html).toContain('<a');
    expect(html).toContain('href="https://example.com"');
  });

  it('sanitizes script tag XSS payloads', () => {
    const html = markdownToHtml('<script>alert("xss")</script>');
    expect(html).not.toContain('<script>');
  });

  it('sanitizes event handler XSS', () => {
    const html = markdownToHtml('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('onerror');
  });

  it('strips <iframe> tags', () => {
    // DOMPurify ADD_TAGS is ['span','div'] — iframe must not slip through
    const html = markdownToHtml('<iframe src="https://evil.com"></iframe>');
    expect(html).not.toContain('<iframe');
  });

  it('strips style attributes', () => {
    // DOMPurify ADD_ATTR is ['data-type','data-latex'] — style must be stripped
    const html = markdownToHtml('<span style="background:url(javascript:alert(1))">x</span>');
    expect(html).not.toContain('style=');
  });

  it('strips javascript: protocol links', () => {
    const html = markdownToHtml('[click](javascript:alert(1))');
    expect(html).not.toMatch(/href\s*=\s*"javascript:/i);
  });

  it('strips onerror injected via raw html span in markdown', () => {
    // Raw HTML passes through remarkHtml (sanitize:false), so DOMPurify is the
    // only defense. A user-injected <span ...> with onerror must have onerror
    // stripped as an executable handler even if data-latex is allowed.
    const md = 'x <span data-type="inline-math" data-latex="a" onerror="alert(1)">';
    const html = markdownToHtml(md);
    // DOMPurify should strip onerror as an attribute — it must not appear as
    // a live attribute (i.e. not followed by ="). It may appear inside an
    // encoded attribute value (e.g. data-latex="onerror=...") which is inert.
    expect(html).not.toMatch(/<[a-z]+[^>]*\sonerror\s*=/i);
  });

  it('preserves allowed data attributes for math', () => {
    const html = markdownToHtml('$a+b$');
    expect(html).toContain('data-type');
    expect(html).toContain('data-latex');
  });

  it('escapes quotes in math latex for attributes', () => {
    const html = markdownToHtml('$x="y"$');
    expect(html).toContain('&quot;');
  });
});

// --- createTurndown (HTML -> Markdown) ---

describe('createTurndown', () => {
  let td;

  beforeEach(() => {
    td = createTurndown();
  });

  it('converts <del> strikethrough via custom rule', () => {
    const md = td.turndown('<del>removed</del>');
    expect(md).toBe('~~removed~~');
  });

  it('converts <s> strikethrough via custom rule', () => {
    const md = td.turndown('<s>removed</s>');
    expect(md).toBe('~~removed~~');
  });

  it('converts inline math spans via custom rule', () => {
    const html = '<span data-type="inline-math" data-latex="x^2"></span>';
    const md = td.turndown(html);
    expect(md).toBe('$x^2$');
  });

  it('converts block math divs via custom rule', () => {
    const html = '<div data-type="block-math" data-latex="E=mc^2"></div>';
    const md = td.turndown(html);
    expect(md).toContain('$$\nE=mc^2\n$$');
  });

  it('converts tables to GFM format via custom rule', () => {
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
    const md = td.turndown(html);
    expect(md).toContain('| A | B |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| 1 | 2 |');
  });

  it('handles empty table gracefully', () => {
    const html = '<table></table>';
    const md = td.turndown(html);
    expect(md).toBe('');
  });
});

// --- Round-trip tests (markdown -> html -> markdown) ---

describe('markdown round-trip', () => {
  let td;

  beforeEach(() => {
    td = createTurndown();
  });

  it('inline math round-trips through markdownToHtml and turndown', () => {
    const html = '<span data-type="inline-math" data-latex="x^2"></span>';
    const result = td.turndown(html);
    expect(result).toBe('$x^2$');
  });

  it('block math round-trips', () => {
    const md = '$$\nE=mc^2\n$$';
    const html = markdownToHtml(md);
    const result = td.turndown(html);
    expect(result).toContain('$$\nE=mc^2\n$$');
  });
});

// --- wrapMarkdownSelection ---

describe('wrapMarkdownSelection', () => {
  function makeTextarea(value, selStart, selEnd) {
    return {
      value,
      selectionStart: selStart,
      selectionEnd: selEnd,
      focus: vi.fn(),
    };
  }

  it('wraps selected text with before/after', () => {
    const ta = makeTextarea('hello world', 6, 11);
    const setSource = vi.fn();
    const onChange = vi.fn();
    wrapMarkdownSelection(ta, '**', '**', setSource, onChange);
    expect(setSource).toHaveBeenCalledWith('hello **world**');
    expect(onChange).toHaveBeenCalledWith('hello **world**');
  });

  it('inserts placeholder when no selection', () => {
    const ta = makeTextarea('hello ', 6, 6);
    const setSource = vi.fn();
    const onChange = vi.fn();
    wrapMarkdownSelection(ta, '**', '**', setSource, onChange);
    expect(setSource).toHaveBeenCalledWith('hello **text**');
  });

  it('wraps with asymmetric markers', () => {
    const ta = makeTextarea('some text here', 5, 9);
    const setSource = vi.fn();
    const onChange = vi.fn();
    wrapMarkdownSelection(ta, '[', '](url)', setSource, onChange);
    expect(setSource).toHaveBeenCalledWith('some [text](url) here');
  });
});

// --- prefixMarkdownLines ---

describe('prefixMarkdownLines', () => {
  function makeTextarea(value, selStart, selEnd) {
    return {
      value,
      selectionStart: selStart,
      selectionEnd: selEnd,
      focus: vi.fn(),
    };
  }

  it('prefixes single selected line', () => {
    const ta = makeTextarea('hello', 0, 5);
    const setSource = vi.fn();
    const onChange = vi.fn();
    prefixMarkdownLines(ta, '## ', setSource, onChange);
    expect(setSource).toHaveBeenCalledWith('## hello');
  });

  it('prefixes multiple selected lines', () => {
    const ta = makeTextarea('line1\nline2\nline3', 0, 17);
    const setSource = vi.fn();
    const onChange = vi.fn();
    prefixMarkdownLines(ta, '- ', setSource, onChange);
    expect(setSource).toHaveBeenCalledWith('- line1\n- line2\n- line3');
  });

  it('inserts prefix on empty selection', () => {
    const ta = makeTextarea('text', 4, 4);
    const setSource = vi.fn();
    const onChange = vi.fn();
    prefixMarkdownLines(ta, '> ', setSource, onChange);
    expect(setSource).toHaveBeenCalledWith('text> ');
  });
});

// --- isImageFile ---

describe('isImageFile', () => {
  it('returns true for image mime types', () => {
    expect(isImageFile({ type: 'image/png' })).toBe(true);
  });

  it('returns false for non-image mime types', () => {
    expect(isImageFile({ type: 'application/pdf' })).toBe(false);
  });
});

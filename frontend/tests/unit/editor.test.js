import { describe, it, expect, vi, beforeEach } from 'vitest';

// editor.js uploads inline images via the single-shot helper in the upload lib.
const mockUploadFile = vi.fn();
vi.mock('../../src/lib/ipfs-upload.js', () => ({
  uploadFile: (...a) => mockUploadFile(...a),
  createUploadSession: () => ({ upload: (...a) => mockUploadFile(...a), dispose: vi.fn() }),
  describeUploadError: (err) =>
    err?.code === 'UPLOAD_REAUTH_UNAVAILABLE' ? 'common.uploadReauthRequired'
      : err?.code === 'UPLOAD_CANCELLED' ? 'common.uploadCancelled'
        : 'common.uploadFailed',
}));

// Minimal Alpine mock used by PevoEditor._handleImageUpload's dynamic import.
const toastShow = vi.fn();
vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name) => {
      if (name === 'toast') return { show: toastShow };
      if (name === 'auth') return { username: 'alice' };
      if (name === 'i18n') return { t: (k) => k };
      return null;
    }),
  },
}));

import {
  markdownToHtml,
  createTurndown,
  wrapMarkdownSelection,
  prefixMarkdownLines,
  isImageFile,
  PevoEditor,
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

// --- Error sanitization for _handleImageUpload ---
//
// UI-ERR-MESSAGE-SANITIZE-PAPER-DETAIL-SURVIVORS: the image-upload catch
// was sanitized in commit 0ee5bfe to bind the generic 'imageUploadFailed'
// key instead of err?.message. Mirrors the pages-paper-detail.test.js
// pattern: generic i18n key bound to the toast, raw err reaches
// console.warn, leak sentinel does NOT surface in the toast message.
//
// We skip PevoEditor's real constructor (it renders DOM / mounts Tiptap) and
// drive _handleImageUpload directly on a prototype-backed stub. The catch
// branch is reached by making uploadToIpfs() reject with a leaky error.
describe('PevoEditor._handleImageUpload error sanitization', () => {
  const LEAK_SENTINEL = 'deadbeef-leak-sentinel';

  function leakyError() {
    return new Error(`ipfs leak: ${LEAK_SENTINEL} pg=bucket_missing`);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    toastShow.mockClear();
  });

  it('generic key bound to toast, raw err to warn, no leak', async () => {
    const err = leakyError();
    mockUploadFile.mockRejectedValue(err);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Stub the editor instance without invoking the DOM-mounting constructor.
    const stub = Object.create(PevoEditor.prototype);
    stub.editor = {};
    stub.isUploading = false;
    stub._els = { toolbar: { querySelector: () => null } };
    stub._t = (key) => key;

    await stub._handleImageUpload({ type: 'image/png', name: 'x.png' });

    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][1]).toBe(err);
    expect(toastShow).toHaveBeenCalledWith('imageUploadFailed', 'error');
    expect(toastShow.mock.calls[0][0]).not.toContain(LEAK_SENTINEL);
    warnSpy.mockRestore();
  });
});

// --- Sequential image-upload queue ---
//
// Drop/paste/file-select can hand the editor several images at once. They must
// drain one at a time through _handleImageUpload so a light account sees a
// single shared re-auth prompt for the batch (concurrent uploads would each
// open a session + modal, and the modal's refuse-while-open guard would cancel
// all but the first). We drive _queueImageUploads/_drainImageUploadQueue on a
// prototype-backed stub (no DOM / no Tiptap mount) with _handleImageUpload
// replaced by a recorder.
describe('PevoEditor image-upload queue', () => {
  function makeQueueStub() {
    const stub = Object.create(PevoEditor.prototype);
    stub.editor = {};
    stub._imageUploadQueue = [];
    stub._imageUploadDraining = false;
    return stub;
  }

  const img = (name) => ({ type: 'image/png', name });
  // Macrotask flush: lets the fire-and-forget drain settle all its microtasks.
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('_queueImageUploads enqueues all files and drains them in FIFO order, one at a time', async () => {
    const stub = makeQueueStub();
    const order = [];
    let inFlight = 0;
    let maxInFlight = 0;
    stub._handleImageUpload = vi.fn(async (file) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(file.name);
      await Promise.resolve(); // yield so any concurrency would surface
      inFlight -= 1;
    });

    stub._queueImageUploads([img('a.png'), img('b.png'), img('c.png')]);
    await flush();

    expect(stub._handleImageUpload).toHaveBeenCalledTimes(3);
    expect(order).toEqual(['a.png', 'b.png', 'c.png']); // FIFO
    expect(maxInFlight).toBe(1); // strictly sequential, never concurrent
    expect(stub._imageUploadDraining).toBe(false); // flag cleared when done
  });

  it('the _imageUploadDraining guard prevents a concurrent second drain from double-processing', async () => {
    const stub = makeQueueStub();
    let release;
    const gate = new Promise((r) => { release = r; });
    stub._handleImageUpload = vi.fn(async () => { await gate; });

    stub._imageUploadQueue.push(img('a.png'));
    const first = stub._drainImageUploadQueue(); // starts; parks awaiting a.png
    // A second drain entered while the first holds the flag must early-return,
    // not pick up the newly-queued file itself.
    stub._imageUploadQueue.push(img('b.png'));
    await stub._drainImageUploadQueue();
    expect(stub._handleImageUpload).toHaveBeenCalledTimes(1); // only a.png so far

    release();
    await first; // the original drain continues and picks up b.png
    expect(stub._handleImageUpload).toHaveBeenCalledTimes(2);
    expect(stub._imageUploadDraining).toBe(false);
  });

  it('stops draining when the editor is torn down mid-drain and resets the flag', async () => {
    const stub = makeQueueStub();
    const seen = [];
    stub._handleImageUpload = vi.fn(async (file) => {
      seen.push(file.name);
      stub.editor = null; // simulate destroy() landing during the first upload
    });

    stub._imageUploadQueue.push(img('a.png'), img('b.png'));
    await stub._drainImageUploadQueue();

    expect(seen).toEqual(['a.png']); // b.png never processed
    expect(stub._handleImageUpload).toHaveBeenCalledTimes(1);
    expect(stub._imageUploadDraining).toBe(false); // flag reset even on early break
  });
});

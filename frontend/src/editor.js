import { Editor } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { Mathematics } from '@tiptap/extension-mathematics';
import TurndownService from 'turndown';
import { remark } from 'remark';
import remarkHtml from 'remark-html';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import DOMPurify from 'dompurify';
import { visit } from 'unist-util-visit';
import { uploadToIpfs } from './api.js';

// --- Markdown -> HTML conversion ---

function remarkStripAutolinkLiterals() {
  return (tree, file) => {
    const source = typeof file.value === 'string' ? file.value : '';
    visit(tree, 'link', (node, index, parent) => {
      if (index == null || !parent || !node.position) return;
      const off = node.position.start.offset;
      if (off != null && source[off] !== '[' && source[off] !== '<') {
        parent.children.splice(index, 1, ...node.children);
        return index;
      }
    });
  };
}

function markdownToHtml(md) {
  const file = remark()
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkStripAutolinkLiterals)
    .use(remarkHtml, { sanitize: false })
    .processSync(md);
  let html = String(file);

  // Convert remark-math output to Tiptap Mathematics extension format
  html = html.replace(
    /<code class="language-math math-inline">([^<]*)<\/code>/g,
    (_match, latex) => `<span data-type="inline-math" data-latex="${latex.replace(/"/g, '&quot;')}"></span>`
  );
  html = html.replace(
    /<pre><code class="language-math math-display">([^<]*)<\/code><\/pre>/g,
    (_match, latex) => `<div data-type="block-math" data-latex="${latex.replace(/"/g, '&quot;')}"></div>`
  );

  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['span', 'div'],
    ADD_ATTR: ['data-type', 'data-latex'],
  });
}

// --- Turndown configuration for HTML -> Markdown ---

function createTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    blankReplacement(content, node) {
      const el = node;
      if (el.getAttribute?.('data-type') === 'inline-math') {
        const latex = el.getAttribute('data-latex') || '';
        return `$${latex}$`;
      }
      if (el.getAttribute?.('data-type') === 'block-math') {
        const latex = el.getAttribute('data-latex') || '';
        return `\n\n$$\n${latex}\n$$\n\n`;
      }
      if (el.nodeName === 'P') {
        return '\n\n';
      }
      return content;
    },
  });

  td.addRule('strikethrough', {
    filter: ['s', 'del'],
    replacement(content) {
      return `~~${content}~~`;
    },
  });

  td.addRule('inlineMath', {
    filter(node) {
      return (
        node.nodeName === 'SPAN' &&
        node.hasAttribute('data-latex') &&
        node.getAttribute('data-type') === 'inline-math'
      );
    },
    replacement(_content, node) {
      const latex = node.getAttribute('data-latex') || '';
      return `$${latex}$`;
    },
  });

  td.addRule('blockMath', {
    filter(node) {
      return (
        node.nodeName === 'DIV' &&
        node.hasAttribute('data-latex') &&
        node.getAttribute('data-type') === 'block-math'
      );
    },
    replacement(_content, node) {
      const latex = node.getAttribute('data-latex') || '';
      return `\n\n$$\n${latex}\n$$\n\n`;
    },
  });

  td.addRule('tableCell', {
    filter: ['td', 'th'],
    replacement(content) {
      return ` ${content.trim()} |`;
    },
  });

  td.addRule('tableRow', {
    filter: 'tr',
    replacement(content) {
      return `|${content}\n`;
    },
  });

  td.addRule('table', {
    filter: 'table',
    replacement(_content, node) {
      const el = node;
      const rows = el.querySelectorAll('tr');
      if (rows.length === 0) return '';

      const lines = [];
      rows.forEach((row, i) => {
        const cells = row.querySelectorAll('th, td');
        const cellTexts = [];
        cells.forEach((cell) => cellTexts.push(cell.textContent?.trim() || ''));
        lines.push('| ' + cellTexts.join(' | ') + ' |');
        if (i === 0) {
          lines.push('| ' + cellTexts.map(() => '---').join(' | ') + ' |');
        }
      });
      return '\n\n' + lines.join('\n') + '\n\n';
    },
  });

  return td;
}

// --- Custom extensions ---

const EnsureEditableBoundaries = Extension.create({
  name: 'ensureEditableBoundaries',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _oldState, newState) {
          const isFullReplace = transactions.some((tr) => {
            if (tr.steps.length !== 1) return false;
            const step = tr.steps[0];
            return step.from === 0 && step.to === _oldState.doc.content.size;
          });
          if (isFullReplace) return null;

          const { doc, schema } = newState;
          const paragraphType = schema.nodes.paragraph;
          if (!paragraphType) return null;

          const firstChild = doc.firstChild;
          const lastChild = doc.lastChild;
          const needsBefore = firstChild && firstChild.isBlock && firstChild.isAtom;
          const needsAfter = lastChild && lastChild.isBlock && lastChild.isAtom;
          if (!needsBefore && !needsAfter) return null;

          const tr = newState.tr;
          if (needsAfter) tr.insert(tr.doc.content.size, paragraphType.create());
          if (needsBefore) tr.insert(0, paragraphType.create());

          return tr;
        },
      }),
    ];
  },
});

const ExitBlockOnEnter = Extension.create({
  name: 'exitBlockOnEnter',

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        if (editor.isActive('heading')) {
          const { $from } = editor.state.selection;
          if ($from.parentOffset === $from.parent.content.size) {
            editor.chain().insertContentAt(editor.state.selection.to, { type: 'paragraph' }).focus().run();
            return true;
          }
        }

        if (editor.isActive('bulletList') || editor.isActive('orderedList')) {
          const { $from } = editor.state.selection;
          if ($from.parent.content.size === 0) {
            requestAnimationFrame(() => editor.commands.focus());
            return false;
          }
        }

        if (editor.isActive('blockquote')) {
          const { $from } = editor.state.selection;
          if ($from.parent.content.size === 0) {
            editor.chain().liftEmptyBlock().focus().run();
            return true;
          }
        }

        return false;
      },
    };
  },
});

// --- Markdown source helpers ---

function wrapMarkdownSelection(textarea, before, after, setSource, onChange) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  const selected = text.slice(start, end);
  const wrapped = before + (selected || 'text') + after;
  const newText = text.slice(0, start) + wrapped + text.slice(end);
  setSource(newText);
  onChange(newText);
  requestAnimationFrame(() => {
    textarea.focus();
    textarea.selectionStart = start + before.length;
    textarea.selectionEnd = start + before.length + (selected || 'text').length;
  });
}

function prefixMarkdownLines(textarea, prefix, setSource, onChange) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  const selected = text.slice(start, end);
  const lines = selected ? selected.split('\n') : [''];
  const prefixed = lines.map((line) => prefix + line).join('\n');
  const newText = text.slice(0, start) + prefixed + text.slice(end);
  setSource(newText);
  onChange(newText);
  requestAnimationFrame(() => {
    textarea.focus();
    textarea.selectionStart = start;
    textarea.selectionEnd = start + prefixed.length;
  });
}

function isImageFile(file) {
  return file.type.startsWith('image/');
}

// --- Toolbar button CSS helper ---

const BTN_BASE = 'px-2.5 py-1.5 min-h-[36px] rounded text-sm font-medium transition-colors cursor-pointer';
const BTN_ACTIVE = 'bg-pevo-teal text-white';
const BTN_INACTIVE = 'text-ink-muted hover:bg-parchment-warm hover:text-ink';
const BTN_WIDE = `${BTN_BASE} min-w-[36px]`;

// --- Standalone PevoEditor class ---

export class PevoEditor {
  /**
   * @param {HTMLElement} container — element to render into
   * @param {Object} options
   * @param {'full'|'abstract'} options.variant
   * @param {string}  [options.placeholder]
   * @param {number}  [options.maxLength]
   * @param {function} [options.onChange]
   * @param {string}  [options.username]
   * @param {number}  [options.remainingChars]
   * @param {string}  [options.initialMarkdown]
   */
  constructor(container, options = {}) {
    this.container = container;
    this.variant = options.variant || 'full';
    this.placeholder = options.placeholder || null;
    this.maxLength = options.maxLength ?? null;
    this.onChange = options.onChange || (() => {});
    this.username = options.username || null;
    this.remainingChars = options.remainingChars ?? null;
    this.initialMarkdown = options.initialMarkdown || '';

    this.editor = null;           // Tiptap Editor instance
    this.turndown = null;
    this.charCount = 0;
    this.isDirty = false;
    this.markdownMode = false;
    this.markdownSource = '';
    this.isFullscreen = false;
    this.isUploading = false;

    // Modal / popover state
    this._showTablePicker = false;
    this._showLinkPopover = false;
    this._showMathModal = false;
    this._mathModalIsBlock = false;
    this._mathModalLatex = '';
    this._linkUrl = '';
    this._linkText = '';
    this._hoverRows = 0;
    this._hoverCols = 0;

    // DOM references (set in _render)
    this._els = {};

    this._render();
    this._init();
  }

  get isAbstract() {
    return this.variant === 'abstract';
  }

  // --- DOM rendering ---

  _render() {
    const isAbstract = this.isAbstract;
    const minH = isAbstract ? 'min-h-[120px]' : 'min-h-[280px]';
    const mdPlaceholder = this.placeholder || (isAbstract ? 'Write your abstract here...' : 'Write your paper body here...');

    this.container.innerHTML = /* html */ `
      <div class="border border-parchment-dark rounded-lg overflow-hidden bg-white" data-editor-shell>
        <div role="toolbar" aria-label="Text formatting" class="flex flex-wrap items-center gap-0.5 px-2 py-1.5 border-b border-parchment-dark bg-parchment">
          ${this._toolbarHtml()}
        </div>
        <div data-md-wrap style="display:none">
          <textarea data-md-textarea
                    class="w-full font-mono text-sm px-4 py-3 focus:outline-none text-ink bg-white resize-y ${minH}"
                    placeholder="${this._esc(mdPlaceholder)}"></textarea>
        </div>
        <div data-visual-wrap class="pevo-editor">
          <div data-editor-content></div>
        </div>
        <div class="flex justify-end px-3 py-1.5 border-t border-parchment-dark bg-parchment">
          <span data-char-count class="text-xs text-ink-muted">0</span>
        </div>
      </div>
      <input data-file-input type="file" accept="image/*" multiple class="hidden" />
      <div data-math-modal style="display:none" class="fixed inset-0 bg-black/30 flex items-center justify-center z-50"></div>
      <div data-link-popover style="display:none" class="absolute top-full right-0 mt-1 bg-white border border-parchment-dark rounded-lg shadow-lg p-3 z-50 w-80"></div>
    `;

    const q = (sel) => this.container.querySelector(`[${sel}]`);
    this._els = {
      shell: q('data-editor-shell'),
      toolbar: this.container.querySelector('[role="toolbar"]'),
      mdWrap: q('data-md-wrap'),
      mdTextarea: q('data-md-textarea'),
      visualWrap: q('data-visual-wrap'),
      editorContent: q('data-editor-content'),
      charCount: q('data-char-count'),
      fileInput: q('data-file-input'),
      mathModal: q('data-math-modal'),
      linkPopover: q('data-link-popover'),
    };

    this._bindToolbarEvents();
    this._bindFileInput();
    this._bindMarkdownTextarea();
  }

  _esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  _toolbarHtml() {
    const isAbstract = this.isAbstract;
    const btn = (action, label, title, wide) =>
      `<button type="button" data-action="${action}" class="${wide ? BTN_WIDE : BTN_BASE} ${BTN_INACTIVE}" title="${title}">${label}</button>`;
    const sep = () => '<div class="w-px h-5 bg-parchment-dark mx-1"></div>';

    let html = '';
    html += btn('bold', '<strong>B</strong>', 'Bold', true);
    html += btn('italic', '<em>I</em>', 'Italic', true);
    html += btn('strike', '<s>S</s>', 'Strikethrough', true);
    html += sep();

    if (!isAbstract) {
      html += btn('heading-2', 'H2', 'Heading 2');
      html += btn('heading-3', 'H3', 'Heading 3');
      html += btn('heading-4', 'H4', 'Heading 4');
      html += btn('bulletList', '&bull; List', 'Bullet List');
      html += btn('orderedList', '1. List', 'Ordered List');
      html += btn('blockquote', '&ldquo; Quote', 'Blockquote');
      html += sep();
    }

    html += btn('inlineMath', '$ Math', 'Inline Math ($...$)');
    html += btn('blockMath', '$$ Block', 'Display Math ($$...$$)');

    // Link button needs a relative wrapper for popover positioning
    html += `<div class="relative" data-link-wrap>`;
    html += btn('link', 'Link', 'Insert Link');
    html += `</div>`;

    html += sep();

    if (!isAbstract) {
      // Table button with picker
      html += `<div class="relative" data-table-wrap>`;
      html += btn('table', 'Table', 'Insert Table');
      html += `<div data-table-picker style="display:none" class="absolute top-full left-0 mt-1 bg-white border border-parchment-dark rounded-lg shadow-lg p-3 z-50">
        <div data-table-label class="text-xs text-ink-muted mb-2 text-center">Select size</div>
        <div class="grid gap-1" style="grid-template-columns: repeat(8, 1fr)">${this._tableGridHtml()}</div>
      </div>`;
      html += `</div>`;

      html += sep();
      html += btn('image', 'Image', 'Upload Image');
    }

    html += sep();
    html += btn('markdownToggle', '&lt;/&gt;', 'Switch editor mode');
    html += sep();
    html += btn('undo', 'Undo', 'Undo');
    html += btn('redo', 'Redo', 'Redo');

    if (!isAbstract) {
      html += btn('fullscreen', '\u229E', 'Full-screen');
    }

    return html;
  }

  _tableGridHtml() {
    let html = '';
    for (let i = 1; i <= 64; i++) {
      const r = Math.floor((i - 1) / 8) + 1;
      const c = (i - 1) % 8 + 1;
      html += `<button type="button" data-table-cell data-tr="${r}" data-tc="${c}"
        class="w-5 h-5 border rounded-sm transition-colors bg-parchment border-parchment-dark hover:border-pevo-teal/50"></button>`;
    }
    return html;
  }

  // --- Toolbar event binding ---

  _bindToolbarEvents() {
    const toolbar = this._els.toolbar;

    // Prevent focus loss on any toolbar button mousedown
    toolbar.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });

    toolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      this._handleToolbarAction(action);
    });

    // Table picker hover + select
    const tablePicker = this.container.querySelector('[data-table-picker]');
    if (tablePicker) {
      const tableWrap = this.container.querySelector('[data-table-wrap]');
      tableWrap.addEventListener('mouseleave', () => {
        this._showTablePicker = false;
        tablePicker.style.display = 'none';
      });

      tablePicker.addEventListener('mouseenter', (e) => {
        const cell = e.target.closest('[data-table-cell]');
        if (cell) this._updateTableHover(+cell.dataset.tr, +cell.dataset.tc);
      });
      tablePicker.addEventListener('mouseover', (e) => {
        const cell = e.target.closest('[data-table-cell]');
        if (cell) this._updateTableHover(+cell.dataset.tr, +cell.dataset.tc);
      });
      tablePicker.addEventListener('click', (e) => {
        const cell = e.target.closest('[data-table-cell]');
        if (cell) this._selectTableSize(+cell.dataset.tr, +cell.dataset.tc);
      });
    }

    // Link popover - close on outside click
    document.addEventListener('click', this._outsideClickHandler = (e) => {
      if (this._showLinkPopover && this._els.linkPopover && !this._els.linkPopover.contains(e.target)) {
        const linkBtn = this.container.querySelector('[data-action="link"]');
        if (!linkBtn || !linkBtn.contains(e.target)) {
          this._closeLinkPopover();
        }
      }
    });
  }

  _bindFileInput() {
    this._els.fileInput.addEventListener('change', (e) => {
      const files = e.target.files;
      if (files) {
        Array.from(files).filter(isImageFile).forEach((f) => this._handleImageUpload(f));
      }
      e.target.value = '';
    });
  }

  _bindMarkdownTextarea() {
    this._els.mdTextarea.addEventListener('input', (e) => {
      this.markdownSource = e.target.value;
      this.charCount = e.target.value.length;
      this._updateCharCount();
      this.onChange(e.target.value);
    });
  }

  // --- Tiptap initialization ---

  _init() {
    this.turndown = createTurndown();
    const isAbstract = this.isAbstract;

    const extensions = [
      StarterKit.configure({
        heading: isAbstract ? false : { levels: [2, 3, 4] },
        bulletList: isAbstract ? false : undefined,
        orderedList: isAbstract ? false : undefined,
        blockquote: isAbstract ? false : undefined,
        link: false,
      }),
      ...(isAbstract
        ? []
        : [
            Table.configure({ resizable: false }),
            TableRow,
            TableCell,
            TableHeader,
            Image,
          ]),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer nofollow' },
      }).extend({
        renderHTML({ HTMLAttributes }) {
          const { target: _target, ...rest } = HTMLAttributes;
          return ['a', { ...rest, title: rest.href, 'data-href': rest.href }, 0];
        },
        addProseMirrorPlugins() {
          return [
            new Plugin({
              props: {
                handleClick(_view, _pos, event) {
                  const link = event.target.closest('a');
                  if (link) {
                    event.preventDefault();
                    return true;
                  }
                  return false;
                },
              },
            }),
          ];
        },
      }),
      Placeholder.configure({
        placeholder: this.placeholder ?? (isAbstract
          ? 'Write your abstract here...'
          : 'Write your paper body here. Use the toolbar for formatting, math, and tables...'),
      }),
      Mathematics.configure({
        katexOptions: { throwOnError: false },
      }),
      ExitBlockOnEnter.configure(),
      EnsureEditableBoundaries.configure(),
    ];

    const editorEl = this._els.editorContent;
    const initialHtml = this.initialMarkdown ? markdownToHtml(this.initialMarkdown) : '';

    this.editor = new Editor({
      element: editorEl,
      extensions,
      content: initialHtml,
      onUpdate: ({ editor: ed }) => {
        const html = ed.getHTML();
        const md = this.turndown.turndown(html);
        if (this.maxLength && ed.state.doc.textContent.length > this.maxLength) return;
        this.isDirty = true;
        this.onChange(md);
      },
      onTransaction: ({ editor: ed }) => {
        this.charCount = ed.state.doc.textContent.length;
        this._updateCharCount();
        this._updateToolbarActiveStates();
      },
      editorProps: {
        attributes: {
          class: `prose prose-sm max-w-none ${isAbstract ? 'min-h-[120px]' : 'min-h-[280px]'} px-4 py-3 focus:outline-none text-ink`,
        },
        handleDrop: (_view, event) => {
          const files = event.dataTransfer?.files;
          if (files && files.length > 0) {
            const imageFiles = Array.from(files).filter(isImageFile);
            if (imageFiles.length > 0) {
              event.preventDefault();
              imageFiles.forEach((f) => this._handleImageUpload(f));
              return true;
            }
          }
          return false;
        },
        handlePaste: (_view, event) => {
          const files = event.clipboardData?.files;
          if (files && files.length > 0) {
            const imageFiles = Array.from(files).filter(isImageFile);
            if (imageFiles.length > 0) {
              event.preventDefault();
              imageFiles.forEach((f) => this._handleImageUpload(f));
              return true;
            }
          }
          return false;
        },
      },
    });

    // Fullscreen Escape handler
    this._escHandler = (e) => {
      if (e.key === 'Escape' && this.isFullscreen) this._toggleFullscreen();
    };
    document.addEventListener('keydown', this._escHandler);
  }

  // --- Public API ---

  setContent(markdown) {
    if (!this.editor) return;
    if (markdown) {
      const html = markdownToHtml(markdown);
      this.editor.commands.setContent(html, false);
    } else {
      this.editor.commands.clearContent(false);
    }
  }

  getMarkdown() {
    if (!this.editor) return '';
    if (this.markdownMode) return this.markdownSource;
    return this.turndown.turndown(this.editor.getHTML());
  }

  /** Update the remainingChars value shown in the char counter. */
  setRemainingChars(n) {
    this.remainingChars = n;
    this._updateCharCount();
  }

  destroy() {
    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
    }
    if (this._escHandler) document.removeEventListener('keydown', this._escHandler);
    if (this._outsideClickHandler) document.removeEventListener('click', this._outsideClickHandler);
    this.container.innerHTML = '';
  }

  // --- Toolbar command dispatch ---

  _cmd() {
    if (!this.editor) return null;
    this.editor.view.focus();
    return this.editor.chain();
  }

  _handleToolbarAction(action) {
    const md = this.markdownMode;
    const ta = this._els.mdTextarea;
    const setSource = (v) => { this.markdownSource = v; ta.value = v; };

    switch (action) {
      case 'bold':
        if (md) { if (ta) wrapMarkdownSelection(ta, '**', '**', setSource, this.onChange); }
        else this._cmd()?.toggleBold().run();
        break;
      case 'italic':
        if (md) { if (ta) wrapMarkdownSelection(ta, '*', '*', setSource, this.onChange); }
        else this._cmd()?.toggleItalic().run();
        break;
      case 'strike':
        if (md) { if (ta) wrapMarkdownSelection(ta, '~~', '~~', setSource, this.onChange); }
        else this._cmd()?.toggleStrike().run();
        break;
      case 'heading-2':
        if (md) { if (ta) prefixMarkdownLines(ta, '## ', setSource, this.onChange); }
        else this._cmd()?.toggleHeading({ level: 2 }).run();
        break;
      case 'heading-3':
        if (md) { if (ta) prefixMarkdownLines(ta, '### ', setSource, this.onChange); }
        else this._cmd()?.toggleHeading({ level: 3 }).run();
        break;
      case 'heading-4':
        if (md) { if (ta) prefixMarkdownLines(ta, '#### ', setSource, this.onChange); }
        else this._cmd()?.toggleHeading({ level: 4 }).run();
        break;
      case 'bulletList':
        if (md) { if (ta) prefixMarkdownLines(ta, '- ', setSource, this.onChange); }
        else this._cmd()?.toggleBulletList().run();
        break;
      case 'orderedList':
        if (md) { if (ta) prefixMarkdownLines(ta, '1. ', setSource, this.onChange); }
        else this._cmd()?.toggleOrderedList().run();
        break;
      case 'blockquote':
        if (md) { if (ta) prefixMarkdownLines(ta, '> ', setSource, this.onChange); }
        else this._cmd()?.toggleBlockquote().run();
        break;
      case 'inlineMath':
        if (md) { if (ta) wrapMarkdownSelection(ta, '$', '$', setSource, this.onChange); }
        else this._openMathModal(false);
        break;
      case 'blockMath':
        if (md) { if (ta) wrapMarkdownSelection(ta, '$$\n', '\n$$', setSource, this.onChange); }
        else this._openMathModal(true);
        break;
      case 'link':
        if (md) { if (ta) wrapMarkdownSelection(ta, '[', '](url)', setSource, this.onChange); }
        else this._toggleLinkPopover();
        break;
      case 'table':
        if (md) { this._insertMarkdownTable(); }
        else { this._toggleTablePicker(); }
        break;
      case 'image':
        if (md) { if (ta) wrapMarkdownSelection(ta, '![', '](url)', setSource, this.onChange); }
        else this._els.fileInput.click();
        break;
      case 'markdownToggle':
        this._toggleMarkdownMode();
        break;
      case 'undo':
        if (md) document.execCommand('undo');
        else this._cmd()?.undo().run();
        break;
      case 'redo':
        if (md) document.execCommand('redo');
        else this._cmd()?.redo().run();
        break;
      case 'fullscreen':
        this._toggleFullscreen();
        break;
    }
  }

  // --- Active state updates ---

  _updateToolbarActiveStates() {
    if (!this.editor || this.markdownMode) return;
    const ed = this.editor;

    const map = {
      bold: ed.isActive('bold'),
      italic: ed.isActive('italic'),
      strike: ed.isActive('strike'),
      'heading-2': ed.isActive('heading', { level: 2 }),
      'heading-3': ed.isActive('heading', { level: 3 }),
      'heading-4': ed.isActive('heading', { level: 4 }),
      bulletList: ed.isActive('bulletList'),
      orderedList: ed.isActive('orderedList'),
      blockquote: ed.isActive('blockquote'),
      link: ed.isActive('link'),
      markdownToggle: this.markdownMode,
    };

    this._els.toolbar.querySelectorAll('[data-action]').forEach((btn) => {
      const action = btn.dataset.action;
      if (action in map) {
        const active = map[action];
        if (active) {
          btn.classList.remove(...BTN_INACTIVE.split(' '));
          btn.classList.add(...BTN_ACTIVE.split(' '));
        } else {
          btn.classList.remove(...BTN_ACTIVE.split(' '));
          btn.classList.add(...BTN_INACTIVE.split(' '));
        }
      }
    });
  }

  _updateCharCount() {
    const el = this._els.charCount;
    if (!el) return;

    let text;
    if (this.maxLength != null) {
      text = `${this.charCount} / ${this.maxLength}`;
    } else if (this.remainingChars != null) {
      text = `${this.remainingChars.toLocaleString()} characters remaining`;
    } else {
      text = String(this.charCount);
    }
    el.textContent = text;

    const over = (this.maxLength != null && this.charCount > this.maxLength) ||
                 (this.remainingChars != null && this.remainingChars < 0);
    el.className = over ? 'text-xs text-pevo-crimson font-semibold' : 'text-xs text-ink-muted';
  }

  // --- Markdown mode ---

  _toggleMarkdownMode() {
    if (!this.editor) return;
    if (this.markdownMode) {
      // Switching back to visual
      const html = markdownToHtml(this.markdownSource);
      this.editor.commands.setContent(html, false);
      this.markdownMode = false;
      this._els.mdWrap.style.display = 'none';
      this._els.visualWrap.style.display = '';
    } else {
      // Switching to markdown source
      const html = this.editor.getHTML();
      const md = this.turndown.turndown(html);
      this.markdownSource = md;
      this._els.mdTextarea.value = md;
      this.markdownMode = true;
      this._els.mdWrap.style.display = '';
      this._els.visualWrap.style.display = 'none';
    }
    this._updateToolbarActiveStates();
  }

  // --- Fullscreen ---

  _toggleFullscreen() {
    this.isFullscreen = !this.isFullscreen;
    const shell = this._els.shell;
    if (this.isFullscreen) {
      shell.classList.add('fixed', 'inset-0', 'z-50', 'bg-parchment', 'flex', 'flex-col');
      this._els.visualWrap.classList.add('flex-1', 'overflow-y-auto');
      this._els.mdTextarea.classList.add('flex-1');
      this._els.mdTextarea.classList.remove('min-h-[120px]', 'min-h-[280px]');
    } else {
      shell.classList.remove('fixed', 'inset-0', 'z-50', 'bg-parchment', 'flex', 'flex-col');
      this._els.visualWrap.classList.remove('flex-1', 'overflow-y-auto');
      this._els.mdTextarea.classList.remove('flex-1');
      this._els.mdTextarea.classList.add(this.isAbstract ? 'min-h-[120px]' : 'min-h-[280px]');
    }
    // Update fullscreen button
    const btn = this._els.toolbar.querySelector('[data-action="fullscreen"]');
    if (btn) {
      btn.textContent = this.isFullscreen ? '\u2295' : '\u229E';
      btn.title = this.isFullscreen ? 'Exit full-screen' : 'Full-screen';
      if (this.isFullscreen) {
        btn.classList.remove(...BTN_INACTIVE.split(' '));
        btn.classList.add(...BTN_ACTIVE.split(' '));
      } else {
        btn.classList.remove(...BTN_ACTIVE.split(' '));
        btn.classList.add(...BTN_INACTIVE.split(' '));
      }
    }
  }

  // --- Table picker ---

  _toggleTablePicker() {
    const picker = this.container.querySelector('[data-table-picker]');
    if (!picker) return;
    this._showTablePicker = !this._showTablePicker;
    picker.style.display = this._showTablePicker ? '' : 'none';
  }

  _updateTableHover(rows, cols) {
    this._hoverRows = rows;
    this._hoverCols = cols;
    const label = this.container.querySelector('[data-table-label]');
    if (label) label.textContent = `${rows} x ${cols}`;
    this.container.querySelectorAll('[data-table-cell]').forEach((cell) => {
      const r = +cell.dataset.tr;
      const c = +cell.dataset.tc;
      if (r <= rows && c <= cols) {
        cell.className = 'w-5 h-5 border rounded-sm transition-colors bg-pevo-teal/30 border-pevo-teal';
      } else {
        cell.className = 'w-5 h-5 border rounded-sm transition-colors bg-parchment border-parchment-dark hover:border-pevo-teal/50';
      }
    });
  }

  _selectTableSize(rows, cols) {
    this._cmd()?.insertTable({ rows, cols, withHeaderRow: true }).run();
    this._showTablePicker = false;
    const picker = this.container.querySelector('[data-table-picker]');
    if (picker) picker.style.display = 'none';
  }

  _insertMarkdownTable() {
    const ta = this._els.mdTextarea;
    if (!ta) return;
    const table = '\n| Header | Header |\n| --- | --- |\n| Cell | Cell |\n';
    const start = ta.selectionStart;
    const text = ta.value;
    const newText = text.slice(0, start) + table + text.slice(start);
    this.markdownSource = newText;
    ta.value = newText;
    this.onChange(newText);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = start + 3;
      ta.selectionEnd = start + 9;
    });
  }

  // --- Math modal ---

  _openMathModal(isBlock) {
    this._mathModalIsBlock = isBlock;
    this._mathModalLatex = '';
    this._showMathModal = true;

    const modal = this._els.mathModal;
    modal.style.display = '';
    modal.innerHTML = `
      <div class="bg-white rounded-lg shadow-xl border border-parchment-dark p-5 w-full max-w-lg mx-4" data-math-inner>
        <h3 class="text-sm font-semibold text-ink mb-3">${isBlock ? 'Block Math ($$...$$)' : 'Inline Math ($...$)'}</h3>
        <textarea data-math-input placeholder="${isBlock ? '\\\\int_0^\\\\infty f(x)\\\\,dx' : 'x^2 + y^2 = r^2'}"
          class="w-full font-mono text-sm border border-parchment-dark rounded-md px-3 py-2 min-h-[80px] focus:border-pevo-teal focus:ring-1 focus:ring-pevo-teal focus:outline-none resize-y"></textarea>
        <div class="flex justify-end gap-2 mt-3">
          <button type="button" data-math-cancel class="px-3 py-1.5 text-sm rounded-md border border-parchment-dark text-ink-muted hover:bg-parchment-warm">Cancel</button>
          <button type="button" data-math-submit class="px-3 py-1.5 text-sm rounded-md bg-pevo-teal text-white hover:bg-pevo-teal-dark">Insert</button>
        </div>
        <p class="text-xs text-ink-light mt-2">Press Ctrl+Enter to insert</p>
      </div>
    `;

    const input = modal.querySelector('[data-math-input]');
    const inner = modal.querySelector('[data-math-inner]');

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
      if (!inner.contains(e.target)) this._closeMathModal();
    }, { once: false });

    // Stop propagation inside
    inner.addEventListener('click', (e) => e.stopPropagation());

    modal.querySelector('[data-math-cancel]').addEventListener('click', () => this._closeMathModal());
    modal.querySelector('[data-math-submit]').addEventListener('click', () => this._submitMathModal());

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) this._submitMathModal();
      if (e.key === 'Escape') this._closeMathModal();
    });

    requestAnimationFrame(() => input.focus());
  }

  _submitMathModal() {
    const input = this._els.mathModal.querySelector('[data-math-input]');
    const trimmed = (input?.value || '').trim();
    if (trimmed && this.editor) {
      const type = this._mathModalIsBlock ? 'blockMath' : 'inlineMath';
      this._cmd()?.insertContent({ type, attrs: { latex: trimmed } }).run();
    }
    this._closeMathModal();
  }

  _closeMathModal() {
    this._showMathModal = false;
    this._els.mathModal.style.display = 'none';
    this._els.mathModal.innerHTML = '';
  }

  // --- Link popover ---

  _toggleLinkPopover() {
    if (this._showLinkPopover) {
      this._closeLinkPopover();
      return;
    }
    this._showLinkPopover = true;

    const currentHref = this.editor ? (this.editor.getAttributes('link').href || '') : '';
    this._linkUrl = currentHref;
    this._linkText = '';

    const hasSelection = this.editor && this.editor.state.selection.from !== this.editor.state.selection.to;

    const popover = this._els.linkPopover;
    // Place popover inside the link button wrapper
    const linkWrap = this.container.querySelector('[data-link-wrap]');
    if (linkWrap && popover.parentElement !== linkWrap) {
      linkWrap.appendChild(popover);
    }

    let html = '';
    if (!hasSelection && !currentHref) {
      html += `<label class="text-xs text-ink-muted mb-1 block">Text</label>
        <input type="text" data-link-text-input placeholder="Link text"
          class="w-full text-sm border border-parchment-dark rounded-md px-3 py-1.5 mb-2 focus:border-pevo-teal focus:ring-1 focus:ring-pevo-teal focus:outline-none" />`;
    }
    html += `<label class="text-xs text-ink-muted mb-1 block">URL</label>
      <input type="url" data-link-url-input placeholder="https://example.com" value="${this._esc(currentHref)}"
        class="w-full text-sm border border-parchment-dark rounded-md px-3 py-1.5 focus:border-pevo-teal focus:ring-1 focus:ring-pevo-teal focus:outline-none" />`;
    html += `<div class="flex justify-between mt-2">`;
    if (currentHref) {
      html += `<button type="button" data-link-remove class="text-xs text-pevo-crimson hover:text-pevo-crimson-dark">Remove link</button>`;
    } else {
      html += `<span></span>`;
    }
    html += `<div class="flex gap-2">
      <button type="button" data-link-cancel class="px-2 py-1 text-xs rounded border border-parchment-dark text-ink-muted hover:bg-parchment-warm">Cancel</button>
      <button type="button" data-link-apply class="px-2 py-1 text-xs rounded bg-pevo-teal text-white hover:bg-pevo-teal-dark">Apply</button>
    </div></div>`;

    popover.innerHTML = html;
    popover.style.display = '';

    const urlInput = popover.querySelector('[data-link-url-input]');
    const textInput = popover.querySelector('[data-link-text-input]');

    const onKey = (e) => {
      if (e.key === 'Enter') this._submitLink();
      if (e.key === 'Escape') this._closeLinkPopover();
    };
    urlInput.addEventListener('keydown', onKey);
    if (textInput) textInput.addEventListener('keydown', onKey);

    popover.querySelector('[data-link-cancel]')?.addEventListener('click', () => this._closeLinkPopover());
    popover.querySelector('[data-link-apply]')?.addEventListener('click', () => this._submitLink());
    popover.querySelector('[data-link-remove]')?.addEventListener('click', () => this._removeLink());

    requestAnimationFrame(() => (textInput || urlInput).focus());
  }

  _submitLink() {
    const popover = this._els.linkPopover;
    const urlInput = popover.querySelector('[data-link-url-input]');
    const textInput = popover.querySelector('[data-link-text-input]');
    const url = (urlInput?.value || '').trim();
    if (!url || !this.editor) { this._closeLinkPopover(); return; }
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
        return;
      }
    } catch {
      return;
    }

    this.editor.view.focus();
    const { from, to } = this.editor.state.selection;
    if (from === to) {
      const label = (textInput?.value || '').trim() || url;
      this.editor.chain()
        .insertContent([
          { type: 'text', marks: [{ type: 'link', attrs: { href: url } }], text: label },
          { type: 'text', text: ' ' },
        ])
        .run();
    } else {
      this.editor.chain()
        .setLink({ href: url })
        .setTextSelection(to)
        .insertContent(' ')
        .unsetMark('link')
        .run();
    }
    this._closeLinkPopover();
  }

  _removeLink() {
    if (this.editor) this._cmd()?.unsetLink().run();
    this._closeLinkPopover();
  }

  _closeLinkPopover() {
    this._showLinkPopover = false;
    this._els.linkPopover.style.display = 'none';
    this._els.linkPopover.innerHTML = '';
  }

  // --- Image upload ---

  async _handleImageUpload(file) {
    if (!this.editor || !isImageFile(file)) return;

    this.isUploading = true;
    const imgBtn = this._els.toolbar.querySelector('[data-action="image"]');
    if (imgBtn) imgBtn.textContent = '...';

    try {
      // Try IPFS upload if user is authenticated
      let Alpine;
      try { Alpine = (await import('alpinejs')).default; } catch { Alpine = null; }
      const auth = Alpine?.store?.('auth');

      if (!auth?.username) {
        // Cannot upload without authentication — show error instead of embedding
        // base64 data URLs which would exceed the Hive transaction size limit
        try {
          const Alpine = (await import('alpinejs')).default;
          Alpine.store('toast')?.show('Please connect your wallet to upload images', 'error');
        } catch { /* toast unavailable */ }
        return;
      }

      const result = await uploadToIpfs(file);
      if (result.data?.cid) {
        const gateway = (window.__PEVO_CONFIG__?.ipfsGateway) || '/api/ipfs/';
        const ipfsUrl = `${gateway.replace(/\/+$/, '')}/${result.data.cid}`;
        this._cmd()?.setImage({ src: ipfsUrl }).run();
      }
    } catch (err) {
      try {
        const Alpine = (await import('alpinejs')).default;
        Alpine.store('toast')?.show(err?.message || 'Image upload failed', 'error');
      } catch { /* toast unavailable */ }
    } finally {
      this.isUploading = false;
      if (imgBtn) imgBtn.textContent = 'Image';
    }
  }
}

// --- Factory function ---

/**
 * Create a standalone PEvO editor instance.
 *
 * @param {HTMLElement} container
 * @param {Object} options — see PevoEditor constructor
 * @returns {PevoEditor}
 */
export function createEditor(container, options) {
  return new PevoEditor(container, options);
}

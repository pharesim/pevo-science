import Alpine from 'alpinejs';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';

/**
 * Process LaTeX math expressions before passing to marked.
 * Converts $...$ (inline) and $$...$$ (display) to KaTeX HTML.
 */
function processMath(text) {
  if (!text) return '';

  // Display math: $$...$$
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_match, tex) => {
    try {
      return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false });
    } catch {
      return `<span class="text-pevo-crimson">[math error]</span>`;
    }
  });

  // Inline math: $...$  (but not $$)
  text = text.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_match, tex) => {
    try {
      return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false });
    } catch {
      return `<span class="text-pevo-crimson">[math error]</span>`;
    }
  });

  return text;
}

/**
 * Render markdown to sanitised HTML.
 */
export function renderMarkdown(content) {
  if (!content) return '';
  const withMath = processMath(content);
  const rawHtml = marked.parse(withMath, { breaks: true, gfm: true });
  return DOMPurify.sanitize(rawHtml, {
    ADD_TAGS: ['semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub',
               'mfrac', 'mover', 'munder', 'msqrt', 'mtext', 'mspace', 'mtable',
               'mtr', 'mtd', 'math', 'mpadded', 'menclose', 'mglyph', 'mstyle',
               'merror', 'mphantom', 'mmultiscripts', 'mprescripts'],
    ADD_ATTR: ['xmlns', 'mathvariant', 'encoding', 'displaystyle', 'scriptlevel',
               'fence', 'stretchy', 'symmetric', 'lspace', 'rspace', 'movablelimits',
               'accent', 'accentunder', 'columnalign', 'columnspacing', 'rowspacing',
               'class', 'style', 'width', 'height', 'aria-hidden'],
  });
}

export function initMarkdownRenderer() {
  // Register an Alpine directive: x-markdown="someVariable"
  Alpine.directive('markdown', (el, { expression }, { evaluateLater, effect }) => {
    const evaluate = evaluateLater(expression);
    effect(() => {
      evaluate((content) => {
        el.innerHTML = renderMarkdown(content);
      });
    });
  });
}

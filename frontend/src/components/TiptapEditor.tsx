"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table";
import { TableHeader } from "@tiptap/extension-table";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Mathematics } from "@tiptap/extension-mathematics";
import {
  useCallback,
  useRef,
  useEffect,
  useState,
  type ChangeEvent,
} from "react";
import TurndownService from "turndown";
import { remark } from "remark";
import remarkHtml from "remark-html";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import DOMPurify from "dompurify";
import { visit } from "unist-util-visit";

// --- Markdown -> HTML conversion ---

/** Strip GFM autolink literals (bare emails/URLs) so they stay as plain text.
 *  Explicit links written as [text](url) or <url> are preserved. */
function remarkStripAutolinkLiterals() {
  return (tree: any, file: any) => {
    const source: string = typeof file.value === "string" ? file.value : "";
    visit(tree, "link", (node: any, index: number | undefined, parent: any) => {
      if (index == null || !parent || !node.position) return;
      const off = node.position.start.offset;
      if (off != null && source[off] !== "[" && source[off] !== "<") {
        parent.children.splice(index, 1, ...node.children);
        return index; // revisit spliced position
      }
    });
  };
}

function markdownToHtml(md: string): string {
  const file = remark()
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkStripAutolinkLiterals)
    .use(remarkHtml, { sanitize: false })
    .processSync(md);
  let html = String(file);

  // Convert remark-math output to Tiptap Mathematics extension format
  // Inline: <code class="language-math math-inline">latex</code> → <span data-type="inline-math" data-latex="latex"></span>
  html = html.replace(
    /<code class="language-math math-inline">([^<]*)<\/code>/g,
    (_match, latex) => `<span data-type="inline-math" data-latex="${latex.replace(/"/g, '&quot;')}"></span>`
  );
  // Block: <pre><code class="language-math math-display">latex</code></pre> → <div data-type="block-math" data-latex="latex"></div>
  html = html.replace(
    /<pre><code class="language-math math-display">([^<]*)<\/code><\/pre>/g,
    (_match, latex) => `<div data-type="block-math" data-latex="${latex.replace(/"/g, '&quot;')}"></div>`
  );

  return DOMPurify.sanitize(html, {
    ADD_TAGS: ["span", "div"],
    ADD_ATTR: ["data-type", "data-latex"],
  });
}

// --- Turndown configuration for HTML -> Markdown ---

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    blankReplacement(content, node) {
      const el = node as HTMLElement;
      // Preserve math nodes that Turndown would otherwise discard as blank
      if (el.getAttribute?.("data-type") === "inline-math") {
        const latex = el.getAttribute("data-latex") || "";
        return `$${latex}$`;
      }
      if (el.getAttribute?.("data-type") === "block-math") {
        const latex = el.getAttribute("data-latex") || "";
        return `\n\n$$\n${latex}\n$$\n\n`;
      }
      // Preserve empty paragraphs as blank lines
      if (el.nodeName === "P") {
        return "\n\n";
      }
      return content;
    },
  });

  td.addRule("strikethrough", {
    filter: ["s", "del"],
    replacement(content) {
      return `~~${content}~~`;
    },
  });

  td.addRule("inlineMath", {
    filter(node) {
      return (
        node.nodeName === "SPAN" &&
        (node as HTMLElement).hasAttribute("data-latex") &&
        (node as HTMLElement).getAttribute("data-type") === "inline-math"
      );
    },
    replacement(_content, node) {
      const latex = (node as HTMLElement).getAttribute("data-latex") || "";
      return `$${latex}$`;
    },
  });

  td.addRule("blockMath", {
    filter(node) {
      return (
        node.nodeName === "DIV" &&
        (node as HTMLElement).hasAttribute("data-latex") &&
        (node as HTMLElement).getAttribute("data-type") === "block-math"
      );
    },
    replacement(_content, node) {
      const latex = (node as HTMLElement).getAttribute("data-latex") || "";
      return `\n\n$$\n${latex}\n$$\n\n`;
    },
  });

  td.addRule("tableCell", {
    filter: ["td", "th"],
    replacement(content) {
      return ` ${content.trim()} |`;
    },
  });

  td.addRule("tableRow", {
    filter: "tr",
    replacement(content) {
      return `|${content}\n`;
    },
  });

  td.addRule("table", {
    filter: "table",
    replacement(_content, node) {
      const el = node as HTMLElement;
      const rows = el.querySelectorAll("tr");
      if (rows.length === 0) return "";

      const lines: string[] = [];
      rows.forEach((row, i) => {
        const cells = row.querySelectorAll("th, td");
        const cellTexts: string[] = [];
        cells.forEach((cell) => cellTexts.push(cell.textContent?.trim() || ""));
        lines.push("| " + cellTexts.join(" | ") + " |");
        if (i === 0) {
          lines.push("| " + cellTexts.map(() => "---").join(" | ") + " |");
        }
      });
      return "\n\n" + lines.join("\n") + "\n\n";
    },
  });

  return td;
}

// --- Props ---

export interface TiptapEditorProps {
  content: string;
  onChange: (markdown: string) => void;
  username?: string;
  variant?: "full" | "abstract";
  placeholder?: string;
  maxLength?: number;
  remainingChars?: number;
}

// --- Toolbar Button ---

function ToolbarButton({
  onClick,
  active = false,
  disabled = false,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`px-2.5 py-1.5 min-h-[36px] min-w-[36px] rounded text-sm font-medium transition-colors ${
        active
          ? "bg-pevo-teal text-white"
          : "text-ink-muted hover:bg-parchment-warm hover:text-ink"
      } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="w-px h-5 bg-parchment-dark mx-1" />;
}

// --- Table Dimension Picker ---

const MAX_TABLE_SIZE = 8;

function TableDimensionPicker({
  onSelect,
  onClose,
}: {
  onSelect: (rows: number, cols: number) => void;
  onClose: () => void;
}) {
  const [hoverRows, setHoverRows] = useState(0);
  const [hoverCols, setHoverCols] = useState(0);

  return (
    <div
      className="absolute top-full left-0 mt-1 bg-white border border-parchment-dark rounded-lg shadow-lg p-3 z-50"
      onMouseLeave={onClose}
    >
      <div className="text-xs text-ink-muted mb-2 text-center">
        {hoverRows > 0 ? `${hoverRows} x ${hoverCols}` : "Select size"}
      </div>
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${MAX_TABLE_SIZE}, 1fr)` }}>
        {Array.from({ length: MAX_TABLE_SIZE * MAX_TABLE_SIZE }, (_, i) => {
          const row = Math.floor(i / MAX_TABLE_SIZE) + 1;
          const col = (i % MAX_TABLE_SIZE) + 1;
          const isHighlighted = row <= hoverRows && col <= hoverCols;
          return (
            <button
              key={i}
              type="button"
              aria-label={`${row} rows by ${col} columns`}
              className={`w-5 h-5 border rounded-sm transition-colors ${
                isHighlighted
                  ? "bg-pevo-teal/30 border-pevo-teal"
                  : "bg-parchment border-parchment-dark hover:border-pevo-teal/50"
              }`}
              onMouseEnter={() => {
                setHoverRows(row);
                setHoverCols(col);
              }}
              onClick={() => onSelect(row, col)}
            />
          );
        })}
      </div>
    </div>
  );
}

// --- Math Input Modal ---

function MathInputModal({
  initialLatex,
  isBlock,
  onInsert,
  onClose,
}: {
  initialLatex: string;
  isBlock: boolean;
  onInsert: (latex: string) => void;
  onClose: () => void;
}) {
  const [latex, setLatex] = useState(initialLatex);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = () => {
    const trimmed = latex.trim();
    if (trimmed) onInsert(trimmed);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="math-modal-title">
      <div
        className="bg-white rounded-lg shadow-xl border border-parchment-dark p-5 w-full max-w-lg mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="math-modal-title" className="text-sm font-semibold text-ink mb-3">
          {isBlock ? "Block Math ($$...$$)" : "Inline Math ($...$)"}
        </h3>
        <label htmlFor="math-latex-input" className="sr-only">LaTeX expression</label>
        <textarea
          id="math-latex-input"
          ref={inputRef}
          value={latex}
          onChange={(e) => setLatex(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
            if (e.key === "Escape") onClose();
          }}
          placeholder={isBlock ? "\\int_0^\\infty f(x)\\,dx" : "x^2 + y^2 = r^2"}
          className="w-full font-mono text-sm border border-parchment-dark rounded-md px-3 py-2 min-h-[80px] focus:border-pevo-teal focus:ring-1 focus:ring-pevo-teal focus:outline-none resize-y"
        />
        <div className="flex justify-end gap-2 mt-3">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-md border border-parchment-dark text-ink-muted hover:bg-parchment-warm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            className="px-3 py-1.5 text-sm rounded-md bg-pevo-teal text-white hover:bg-pevo-teal-dark"
          >
            Insert
          </button>
        </div>
        <p className="text-xs text-ink-light mt-2">Press Ctrl+Enter to insert</p>
      </div>
    </div>
  );
}

// --- Link Input Popover ---

function LinkPopover({
  initialUrl,
  hasSelection,
  onSubmit,
  onRemove,
  onClose,
}: {
  initialUrl: string;
  hasSelection: boolean;
  onSubmit: (url: string, text: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [text, setText] = useState("");
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    const trimmedUrl = url.trim();
    if (trimmedUrl) onSubmit(trimmedUrl, text.trim());
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSubmit();
    if (e.key === "Escape") onClose();
  };

  return (
    <div className="absolute top-full right-0 mt-1 bg-white border border-parchment-dark rounded-lg shadow-lg p-3 z-50 w-80" role="dialog" aria-label="Insert link">
      {!hasSelection && !initialUrl && (
        <>
          <label htmlFor="link-text-input" className="text-xs text-ink-muted mb-1 block">Text</label>
          <input
            id="link-text-input"
            ref={firstInputRef}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Link text"
            className="w-full text-sm border border-parchment-dark rounded-md px-3 py-1.5 mb-2 focus:border-pevo-teal focus:ring-1 focus:ring-pevo-teal focus:outline-none"
          />
        </>
      )}
      <label htmlFor="link-url-input" className="text-xs text-ink-muted mb-1 block">URL</label>
      <input
        id="link-url-input"
        ref={hasSelection || initialUrl ? firstInputRef : undefined}
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="https://example.com"
        className="w-full text-sm border border-parchment-dark rounded-md px-3 py-1.5 focus:border-pevo-teal focus:ring-1 focus:ring-pevo-teal focus:outline-none"
      />
      <div className="flex justify-between mt-2">
        {initialUrl ? (
          <button
            type="button"
            onClick={() => { onRemove(); onClose(); }}
            className="text-xs text-pevo-crimson hover:text-pevo-crimson-dark"
          >
            Remove link
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-2 py-1 text-xs rounded border border-parchment-dark text-ink-muted hover:bg-parchment-warm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            className="px-2 py-1 text-xs rounded bg-pevo-teal text-white hover:bg-pevo-teal-dark"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Image Upload Helpers ---

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

// --- Custom extension: fix toolbar button state on Enter ---

// Ensures the document always has an editable paragraph before the first
// and after the last block-level atom node (e.g. blockMath, image).
// Without this, users cannot place the cursor to type above/below such nodes.
const EnsureEditableBoundaries = Extension.create({
  name: "ensureEditableBoundaries",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(_transactions, _oldState, newState) {
          const { doc, schema } = newState;
          const paragraphType = schema.nodes.paragraph;
          if (!paragraphType) return null;

          let tr: Transaction | null = null;
          const firstChild = doc.firstChild;
          const lastChild = doc.lastChild;

          // If the first node is an atom block, prepend an empty paragraph
          if (firstChild && firstChild.isBlock && firstChild.isAtom) {
            tr = tr ?? newState.tr;
            tr.insert(0, paragraphType.create());
          }

          // If the last node is an atom block, append an empty paragraph
          if (lastChild && lastChild.isBlock && lastChild.isAtom) {
            tr = tr ?? newState.tr;
            tr.insert(tr.doc.content.size, paragraphType.create());
          }

          return tr;
        },
      }),
    ];
  },
});

const ExitBlockOnEnter = Extension.create({
  name: "exitBlockOnEnter",

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        // At end of a heading → insert paragraph below
        if (editor.isActive("heading")) {
          const { $from } = editor.state.selection;
          if ($from.parentOffset === $from.parent.content.size) {
            editor.chain().insertContentAt(editor.state.selection.to, { type: "paragraph" }).focus().run();
            return true;
          }
        }

        // Empty list item (double-Enter to exit list) → the default StarterKit
        // handles lifting, but we force a view update so isActive refreshes
        if (editor.isActive("bulletList") || editor.isActive("orderedList")) {
          const { $from } = editor.state.selection;
          if ($from.parent.content.size === 0) {
            // Let StarterKit handle the lift, then force toolbar refresh
            requestAnimationFrame(() => editor.commands.focus());
            return false;
          }
        }

        // Empty blockquote line → exit blockquote
        if (editor.isActive("blockquote")) {
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

function wrapMarkdownSelection(
  textarea: HTMLTextAreaElement,
  before: string,
  after: string,
  setSource: (v: string) => void,
  onChange: (v: string) => void,
) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  const selected = text.slice(start, end);
  const wrapped = before + (selected || "text") + after;
  const newText = text.slice(0, start) + wrapped + text.slice(end);
  setSource(newText);
  onChange(newText);
  requestAnimationFrame(() => {
    textarea.focus();
    textarea.selectionStart = start + before.length;
    textarea.selectionEnd = start + before.length + (selected || "text").length;
  });
}

function prefixMarkdownLines(
  textarea: HTMLTextAreaElement,
  prefix: string,
  setSource: (v: string) => void,
  onChange: (v: string) => void,
) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  const selected = text.slice(start, end);
  const lines = selected ? selected.split("\n") : [""];
  const prefixed = lines.map((line) => prefix + line).join("\n");
  const newText = text.slice(0, start) + prefixed + text.slice(end);
  setSource(newText);
  onChange(newText);
  requestAnimationFrame(() => {
    textarea.focus();
    textarea.selectionStart = start;
    textarea.selectionEnd = start + prefixed.length;
  });
}

// --- Editor Component ---

export default function TiptapEditor({ content, onChange, username, variant = "full", placeholder, maxLength, remainingChars }: TiptapEditorProps) {
  const isAbstract = variant === "abstract";
  const turndownRef = useRef<TurndownService | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showTablePicker, setShowTablePicker] = useState(false);
  const [showLinkPopover, setShowLinkPopover] = useState(false);
  const [mathModal, setMathModal] = useState<{ isBlock: boolean; latex: string } | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [markdownMode, setMarkdownMode] = useState(false);
  const [markdownSource, setMarkdownSource] = useState("");
  const markdownTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  if (!turndownRef.current) {
    turndownRef.current = createTurndown();
  }

  const htmlToMarkdown = useCallback((html: string): string => {
    if (!turndownRef.current) return "";
    return turndownRef.current.turndown(html);
  }, []);

  const [charCount, setCharCount] = useState(0);
  const [, setTxn] = useState(0);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: isAbstract ? false : { levels: [2, 3] },
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
        HTMLAttributes: { rel: "noopener noreferrer nofollow" },
      }).extend({
        renderHTML({ HTMLAttributes }) {
          // Strip target so clicks don't navigate; show href on hover via title
          const { target: _target, ...rest } = HTMLAttributes;
          return ["a", { ...rest, title: rest.href, "data-href": rest.href }, 0];
        },
        addProseMirrorPlugins() {
          return [
            new Plugin({
              props: {
                handleClick(_view, _pos, event) {
                  const link = (event.target as HTMLElement).closest("a");
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
        placeholder: placeholder ?? (isAbstract
          ? "Write your abstract here..."
          : "Write your paper body here. Use the toolbar for formatting, math, and tables..."),
      }),
      Mathematics.configure({
        katexOptions: { throwOnError: false },
      }),
      ExitBlockOnEnter,
      EnsureEditableBoundaries,
    ],
    content: "",
    onUpdate({ editor: ed }) {
      const html = ed.getHTML();
      const md = htmlToMarkdown(html);
      if (maxLength && ed.state.doc.textContent.length > maxLength) return;
      onChange(md);
    },
    onTransaction({ editor: ed }) {
      setCharCount(ed.state.doc.textContent.length);
      setTxn((n) => n + 1);
    },
    editorProps: {
      attributes: {
        class: `prose prose-sm max-w-none ${isAbstract ? "min-h-[120px]" : "min-h-[280px]"} px-4 py-3 focus:outline-none text-ink`,
      },
      handleDrop: (_view, event) => {
        const files = event.dataTransfer?.files;
        if (files && files.length > 0) {
          const imageFiles = Array.from(files).filter(isImageFile);
          if (imageFiles.length > 0) {
            event.preventDefault();
            imageFiles.forEach((f) => handleImageUpload(f));
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
            imageFiles.forEach((f) => handleImageUpload(f));
            return true;
          }
        }
        return false;
      },
    },
  });

  // Exit full-screen on Escape
  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFullscreen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen]);

  // Set initial content once (only on mount, not from own onChange round-trips)
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!editor) return;
    if (initializedRef.current) return;
    initializedRef.current = true;
    if (content) {
      const html = markdownToHtml(content);
      editor.commands.setContent(html);
    }
  }, [editor, content]);

  // Image upload handler — uses IPFS endpoint or falls back to object URL
  const handleImageUpload = useCallback(
    async (file: File) => {
      if (!editor || !isImageFile(file)) return;

      setIsUploading(true);
      try {
        // Try IPFS upload if available (requires auth context)
        const { uploadToIpfs } = await import("@/lib/api");

        if (!username) {
          // Fallback: insert as data URL for preview
          const reader = new FileReader();
          reader.onload = () => {
            editor.chain().focus().setImage({ src: reader.result as string }).run();
          };
          reader.readAsDataURL(file);
          return;
        }

        const result = await uploadToIpfs(file);
        if (result.data?.cid) {
          const gateway = process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs/';
          const ipfsUrl = `${gateway.replace(/\/+$/, '')}/${result.data.cid}`;
          editor.chain().focus().setImage({ src: ipfsUrl }).run();
        }
      } catch {
        // Fallback: insert as data URL
        const reader = new FileReader();
        reader.onload = () => {
          editor.chain().focus().setImage({ src: reader.result as string }).run();
        };
        reader.readAsDataURL(file);
      } finally {
        setIsUploading(false);
      }
    },
    [editor, username]
  );

  const handleFileInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files) {
        Array.from(files).filter(isImageFile).forEach((f) => handleImageUpload(f));
      }
      // Reset so same file can be re-selected
      e.target.value = "";
    },
    [handleImageUpload]
  );

  const insertInlineMath = useCallback(() => {
    setMathModal({ isBlock: false, latex: "" });
  }, []);

  const insertBlockMath = useCallback(() => {
    setMathModal({ isBlock: true, latex: "" });
  }, []);

  const handleMathInsert = useCallback(
    (latex: string) => {
      if (!editor || !mathModal) return;
      const type = mathModal.isBlock ? "blockMath" : "inlineMath";
      editor.chain().focus().insertContent({ type, attrs: { latex } }).run();
    },
    [editor, mathModal]
  );

  const handleLinkSubmit = useCallback(
    (url: string, text: string) => {
      if (!editor) return;
      const { from, to } = editor.state.selection;
      if (from === to) {
        // No selection — insert link with text (or URL as fallback) + trailing space
        const label = text || url;
        editor.chain().focus()
          .insertContent([
            { type: "text", marks: [{ type: "link", attrs: { href: url } }], text: label },
            { type: "text", text: " " },
          ])
          .run();
      } else {
        // Apply link to selection, then add a trailing space outside the link
        const end = to;
        editor.chain().focus()
          .setLink({ href: url })
          .setTextSelection(end)
          .insertContent(" ")
          .unsetMark("link")
          .run();
      }
    },
    [editor]
  );

  const handleLinkRemove = useCallback(() => {
    if (!editor) return;
    editor.chain().focus().unsetLink().run();
  }, [editor]);

  if (!editor) {
    return null;
  }

  const currentLinkUrl = editor.getAttributes("link").href || "";

  return (
    <div className={`border border-parchment-dark rounded-lg overflow-hidden bg-white ${
      isFullscreen ? "fixed inset-0 z-50 bg-parchment flex flex-col" : ""
    }`}>
      {/* Toolbar */}
      <div role="toolbar" aria-label="Text formatting" className="flex flex-wrap items-center gap-0.5 px-2 py-1.5 border-b border-parchment-dark bg-parchment">
        {/* Text formatting */}
        <ToolbarButton
          onClick={() => {
            if (markdownMode && markdownTextareaRef.current) {
              wrapMarkdownSelection(markdownTextareaRef.current, "**", "**", setMarkdownSource, onChange);
            } else {
              editor.chain().focus().toggleBold().run();
            }
          }}
          active={!markdownMode && editor.isActive("bold")}
          title="Bold"
        >
          <strong>B</strong>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => {
            if (markdownMode && markdownTextareaRef.current) {
              wrapMarkdownSelection(markdownTextareaRef.current, "*", "*", setMarkdownSource, onChange);
            } else {
              editor.chain().focus().toggleItalic().run();
            }
          }}
          active={!markdownMode && editor.isActive("italic")}
          title="Italic"
        >
          <em>I</em>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => {
            if (markdownMode && markdownTextareaRef.current) {
              wrapMarkdownSelection(markdownTextareaRef.current, "~~", "~~", setMarkdownSource, onChange);
            } else {
              editor.chain().focus().toggleStrike().run();
            }
          }}
          active={!markdownMode && editor.isActive("strike")}
          title="Strikethrough"
        >
          <s>S</s>
        </ToolbarButton>

        {!isAbstract && (
          <>
            <ToolbarDivider />

            {/* Structure */}
            <ToolbarButton
              onClick={() => {
                if (markdownMode && markdownTextareaRef.current) {
                  prefixMarkdownLines(markdownTextareaRef.current, "## ", setMarkdownSource, onChange);
                } else {
                  editor.chain().focus().toggleHeading({ level: 2 }).run();
                }
              }}
              active={!markdownMode && editor.isActive("heading", { level: 2 })}
              title="Heading 2"
            >
              H2
            </ToolbarButton>
            <ToolbarButton
              onClick={() => {
                if (markdownMode && markdownTextareaRef.current) {
                  prefixMarkdownLines(markdownTextareaRef.current, "### ", setMarkdownSource, onChange);
                } else {
                  editor.chain().focus().toggleHeading({ level: 3 }).run();
                }
              }}
              active={!markdownMode && editor.isActive("heading", { level: 3 })}
              title="Heading 3"
            >
              H3
            </ToolbarButton>
            <ToolbarButton
              onClick={() => {
                if (markdownMode && markdownTextareaRef.current) {
                  prefixMarkdownLines(markdownTextareaRef.current, "- ", setMarkdownSource, onChange);
                } else {
                  editor.chain().focus().toggleBulletList().run();
                }
              }}
              active={!markdownMode && editor.isActive("bulletList")}
              title="Bullet List"
            >
              &bull; List
            </ToolbarButton>
            <ToolbarButton
              onClick={() => {
                if (markdownMode && markdownTextareaRef.current) {
                  prefixMarkdownLines(markdownTextareaRef.current, "1. ", setMarkdownSource, onChange);
                } else {
                  editor.chain().focus().toggleOrderedList().run();
                }
              }}
              active={!markdownMode && editor.isActive("orderedList")}
              title="Ordered List"
            >
              1. List
            </ToolbarButton>
            <ToolbarButton
              onClick={() => {
                if (markdownMode && markdownTextareaRef.current) {
                  prefixMarkdownLines(markdownTextareaRef.current, "> ", setMarkdownSource, onChange);
                } else {
                  editor.chain().focus().toggleBlockquote().run();
                }
              }}
              active={!markdownMode && editor.isActive("blockquote")}
              title="Blockquote"
            >
              &ldquo; Quote
            </ToolbarButton>
          </>
        )}

        <ToolbarDivider />

        {/* Science */}
        <ToolbarButton
          onClick={() => {
            if (markdownMode && markdownTextareaRef.current) {
              wrapMarkdownSelection(markdownTextareaRef.current, "$", "$", setMarkdownSource, onChange);
            } else {
              insertInlineMath();
            }
          }}
          title="Inline Math ($...$)"
        >
          $ Math
        </ToolbarButton>
        <ToolbarButton
          onClick={() => {
            if (markdownMode && markdownTextareaRef.current) {
              wrapMarkdownSelection(markdownTextareaRef.current, "$$\n", "\n$$", setMarkdownSource, onChange);
            } else {
              insertBlockMath();
            }
          }}
          title="Display Math ($$...$$)"
        >
          $$ Block
        </ToolbarButton>

        {!isAbstract && (
          <>
            {/* Table with dimension picker */}
            <div className="relative">
              <ToolbarButton
                onClick={() => {
                  if (markdownMode && markdownTextareaRef.current) {
                    // Insert a simple 2x2 markdown table template
                    const table = "\n| Header | Header |\n| --- | --- |\n| Cell | Cell |\n";
                    const ta = markdownTextareaRef.current;
                    const start = ta.selectionStart;
                    const text = ta.value;
                    const newText = text.slice(0, start) + table + text.slice(start);
                    setMarkdownSource(newText);
                    onChange(newText);
                    requestAnimationFrame(() => {
                      ta.focus();
                      ta.selectionStart = start + 3;
                      ta.selectionEnd = start + 9;
                    });
                  } else {
                    setShowTablePicker((v) => !v);
                  }
                }}
                title="Insert Table"
              >
                Table
              </ToolbarButton>
              {showTablePicker && !markdownMode && (
                <TableDimensionPicker
                  onSelect={(rows, cols) => {
                    editor
                      .chain()
                      .focus()
                      .insertTable({ rows, cols, withHeaderRow: true })
                      .run();
                    setShowTablePicker(false);
                  }}
                  onClose={() => setShowTablePicker(false)}
                />
              )}
            </div>

            <ToolbarDivider />

            {/* Media */}
            <ToolbarButton
              onClick={() => {
                if (markdownMode && markdownTextareaRef.current) {
                  wrapMarkdownSelection(markdownTextareaRef.current, "![", "](url)", setMarkdownSource, onChange);
                } else {
                  fileInputRef.current?.click();
                }
              }}
              title="Upload Image"
            >
              {isUploading && !markdownMode ? "..." : "Image"}
            </ToolbarButton>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
              onChange={handleFileInputChange}
            />
          </>
        )}

        {/* Link with inline popover */}
        <div className="relative">
          <ToolbarButton
            onClick={() => {
              if (markdownMode && markdownTextareaRef.current) {
                wrapMarkdownSelection(markdownTextareaRef.current, "[", "](url)", setMarkdownSource, onChange);
              } else {
                setShowLinkPopover((v) => !v);
              }
            }}
            active={!markdownMode && editor.isActive("link")}
            title="Insert Link"
          >
            Link
          </ToolbarButton>
          {showLinkPopover && (
            <LinkPopover
              initialUrl={currentLinkUrl}
              hasSelection={editor.state.selection.from !== editor.state.selection.to}
              onSubmit={handleLinkSubmit}
              onRemove={handleLinkRemove}
              onClose={() => setShowLinkPopover(false)}
            />
          )}
        </div>

        <ToolbarDivider />

        {/* Markdown source toggle */}
        <ToolbarButton
          onClick={() => {
            if (markdownMode) {
              // Switching from Markdown → Visual: parse markdown into editor
              const html = markdownToHtml(markdownSource);
              editor.commands.setContent(html);
              setMarkdownMode(false);
            } else {
              // Switching from Visual → Markdown: serialize to markdown
              const html = editor.getHTML();
              const md = htmlToMarkdown(html);
              setMarkdownSource(md);
              setMarkdownMode(true);
            }
          }}
          active={markdownMode}
          title={markdownMode ? "Switch to Visual editor" : "Switch to Markdown source"}
        >
          {"</>"}
        </ToolbarButton>

        <ToolbarDivider />

        {/* Utility */}
        <ToolbarButton
          onClick={() => {
            if (markdownMode && markdownTextareaRef.current) {
              document.execCommand('undo');
            } else {
              editor.chain().focus().undo().run();
            }
          }}
          title="Undo"
        >
          Undo
        </ToolbarButton>
        <ToolbarButton
          onClick={() => {
            if (markdownMode && markdownTextareaRef.current) {
              document.execCommand('redo');
            } else {
              editor.chain().focus().redo().run();
            }
          }}
          title="Redo"
        >
          Redo
        </ToolbarButton>
        {!isAbstract && (
          <ToolbarButton
            onClick={() => setIsFullscreen((v) => !v)}
            active={isFullscreen}
            title={isFullscreen ? "Exit full-screen" : "Full-screen"}
          >
            {isFullscreen ? "⊡" : "⊞"}
          </ToolbarButton>
        )}
      </div>

      {/* Editor area */}
      {markdownMode ? (
        <textarea
          ref={markdownTextareaRef}
          value={markdownSource}
          onChange={(e) => {
            setMarkdownSource(e.target.value);
            setCharCount(e.target.value.length);
            onChange(e.target.value);
          }}
          className={`w-full font-mono text-sm px-4 py-3 focus:outline-none text-ink bg-white resize-y ${
            isFullscreen ? "flex-1" : isAbstract ? "min-h-[120px]" : "min-h-[280px]"
          }`}
          placeholder={placeholder ?? (isAbstract
            ? "Write your abstract here..."
            : "Write your paper body here...")}
        />
      ) : (
        <div className={`pevo-editor ${isFullscreen ? "flex-1 overflow-y-auto" : ""}`}>
          <EditorContent editor={editor} />
        </div>
      )}

      {/* Character counter */}
      <div className="flex justify-end px-3 py-1.5 border-t border-parchment-dark bg-parchment">
        <span className={`text-xs ${maxLength != null && charCount > maxLength ? "text-pevo-crimson font-semibold" : remainingChars != null && remainingChars < 0 ? "text-pevo-crimson font-semibold" : "text-ink-muted"}`}>
          {maxLength != null
            ? `${charCount} / ${maxLength}`
            : remainingChars != null
              ? `${remainingChars.toLocaleString()} characters remaining`
              : charCount}
        </span>
      </div>

      {/* Math input modal */}
      {mathModal && (
        <MathInputModal
          initialLatex={mathModal.latex}
          isBlock={mathModal.isBlock}
          onInsert={handleMathInsert}
          onClose={() => setMathModal(null)}
        />
      )}
    </div>
  );
}

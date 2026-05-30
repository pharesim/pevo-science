/**
 * Pure-function tests for the citation-export builders in
 * `src/routes/papers.ts` (`generateBibtex`, `generateRis`, `generateApa`) and
 * their escape helpers (`bibtexEscape`, `risEscape`, `singleLine`).
 *
 * These exercise file-format-injection defenses: a chain-sourced paper title or
 * author name must not be able to break out of a BibTeX `@article{...}` entry,
 * inject extra RIS records/tag lines, or split a one-line APA citation. The
 * builders are pure (they take a synthetic `detail` object and return a string),
 * so no DB, Redis, HAF, or auth middleware is involved — these are direct unit
 * tests against the exported functions, not route-level integration tests.
 */
import { describe, it, expect } from 'vitest';
import {
  bibtexEscape,
  risEscape,
  singleLine,
  generateBibtex,
  generateRis,
  generateApa,
} from '../../src/routes/papers.js';

function detailWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    author: 'alice',
    permlink: 'my-paper',
    title: 'Some Paper Title',
    created: '2023-06-01T00:00:00Z',
    json_metadata: { pevo: { authors: [{ name: 'Alice Smith' }] } },
    ...overrides,
  };
}

describe('bibtexEscape', () => {
  it('escapes braces so a value cannot close the entry', () => {
    expect(bibtexEscape('a}b{c')).toBe('a\\}b\\{c');
  });

  it('escapes TeX special chars', () => {
    expect(bibtexEscape('100% awesome & cheap')).toBe('100\\% awesome \\& cheap');
    expect(bibtexEscape('a#b$c_d^e~f')).toBe('a\\#b\\$c\\_d\\^e\\~f');
  });

  it('rewrites backslash without re-escaping its own output', () => {
    expect(bibtexEscape('a\\b')).toBe('a\\textbackslash{}b');
  });

  it('flattens CR/LF to a space', () => {
    expect(bibtexEscape('line1\r\nline2')).toBe('line1 line2');
  });
});

describe('risEscape', () => {
  it('strips CR/LF (no quoting mechanism in RIS)', () => {
    expect(risEscape('Innocent\r\nAU  - Fake')).toBe('Innocent AU  - Fake');
  });

  it('trims surrounding whitespace', () => {
    expect(risEscape('  padded  ')).toBe('padded');
  });
});

describe('singleLine', () => {
  it('flattens newlines and trims', () => {
    expect(singleLine('a\nb\r\nc  ')).toBe('a b c');
  });
});

describe('generateBibtex', () => {
  it('defeats entry-injection via a crafted title', () => {
    const detail = detailWith({
      title: 'Hello } extra-entry @article{evil, author={attacker}',
      json_metadata: { pevo: { authors: [{ name: 'Alice Smith' }] } },
    });
    const out = generateBibtex(detail);
    // The smuggled `@article{` must be escaped into the title value, leaving
    // exactly one real entry header.
    const entries = out.match(/@article\{/g) || [];
    expect(entries).toHaveLength(1);
    expect(out).toContain('\\}');
    expect(out).toContain('\\{');
  });

  it('escapes TeX specials in the title', () => {
    const detail = detailWith({ title: '100% awesome & cheap' });
    const out = generateBibtex(detail);
    expect(out).toContain('title = {100\\% awesome \\& cheap}');
    expect(out).not.toMatch(/title = \{[^}]*[^\\]%/);
  });

  it('escapes brace/CRLF in an author name without corrupting the author field', () => {
    const detail = detailWith({
      json_metadata: { pevo: { authors: [{ name: 'Eve}{' }, { name: 'Mallory\r\nFake' }] } },
    });
    const out = generateBibtex(detail);
    // Still exactly one entry; both names live in the single author = {...} field.
    expect((out.match(/@article\{/g) || [])).toHaveLength(1);
    expect(out).toContain('author = {Eve\\}\\{ and Mallory Fake}');
  });

  it('round-trips a legitimate title unescaped', () => {
    const detail = detailWith({ title: 'Some Paper Title' });
    const out = generateBibtex(detail);
    expect(out).toContain('title = {Some Paper Title}');
  });

  it('escapes a free-form doi field', () => {
    const detail = detailWith({ title: 'X', doi: '10.1000/abc}evil' });
    const out = generateBibtex(detail);
    expect(out).toContain('doi = {10.1000/abc\\}evil}');
    expect((out.match(/@article\{/g) || [])).toHaveLength(1);
  });
});

describe('generateRis', () => {
  it('defeats line injection via a crafted title', () => {
    const detail = detailWith({
      title: 'Innocent\r\nAU  - Fake Author\r\nER  -',
      json_metadata: { pevo: { authors: [{ name: 'Alice Smith' }] } },
    });
    const out = generateRis(detail);
    const lines = out.split('\n');
    // One legit AU line (Alice), no smuggled Fake Author AU line.
    expect(lines.filter((l) => l.startsWith('AU  - '))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('ER  -'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('Fake Author'))).toBe(true); // present, but inside TI value
    expect(lines.filter((l) => l === 'AU  - Fake Author')).toHaveLength(0);
  });

  it('strips CR/LF from an author name', () => {
    const detail = detailWith({
      json_metadata: { pevo: { authors: [{ name: 'Real\r\nER  -' }] } },
    });
    const out = generateRis(detail);
    const lines = out.split('\n');
    expect(lines.filter((l) => l.startsWith('ER  -'))).toHaveLength(1);
    expect(lines).toContain('AU  - Real ER  -');
  });

  it('round-trips a legitimate title', () => {
    const detail = detailWith({ title: 'Some Paper Title' });
    const out = generateRis(detail);
    expect(out).toContain('TI  - Some Paper Title');
  });
});

describe('generateApa', () => {
  it('flattens CR/LF in title and authors into one line', () => {
    const detail = detailWith({
      title: 'Title\r\nInjected',
      json_metadata: { pevo: { authors: [{ name: 'Alice\nSmith' }] } },
    });
    const out = generateApa(detail);
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('Title Injected');
    expect(out).toContain('Alice Smith');
  });
});

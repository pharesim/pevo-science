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

// The line-terminator class must cover more than CR/LF. Form-feed (0x0C),
// vertical-tab (0x0B), NEL (0x85), LINE SEPARATOR (0x2028), and PARAGRAPH
// SEPARATOR (0x2029) are treated as line breaks by lenient RIS importers and
// plain-text renderers, so a crafted title using them reaches the same
// file-format-injection class through a wider separator alphabet. Separator
// code points are built via String.fromCharCode so this source stays pure ASCII
// (no invisible bytes, no transport-fragile escape sequences).
const SEP = {
  FF: String.fromCharCode(0x0c),
  VT: String.fromCharCode(0x0b),
  NEL: String.fromCharCode(0x85),
  LS: String.fromCharCode(0x2028),
  PS: String.fromCharCode(0x2029),
  CR: String.fromCharCode(0x0d),
  LF: String.fromCharCode(0x0a),
};
const ANY_SEP = new RegExp('[' + SEP.VT + SEP.FF + SEP.NEL + SEP.LS + SEP.PS + ']');
const countEntries = (bib: string): number => bib.split('@article{').length - 1;

describe('extended line-terminator alphabet', () => {
  const SEPARATORS: ReadonlyArray<readonly [string, string]> = [
    ['form-feed 0x0C', SEP.FF],
    ['vertical-tab 0x0B', SEP.VT],
    ['NEL 0x85', SEP.NEL],
    ['line-separator 0x2028', SEP.LS],
    ['paragraph-separator 0x2029', SEP.PS],
  ];

  for (const [label, sep] of SEPARATORS) {
    it('bibtexEscape flattens ' + label + ' to a space', () => {
      expect(bibtexEscape('a' + sep + 'b')).toBe('a b');
    });
    it('risEscape strips ' + label, () => {
      expect(risEscape('a' + sep + 'b')).toBe('a b');
    });
    it('singleLine flattens ' + label, () => {
      expect(singleLine('a' + sep + 'b')).toBe('a b');
    });
  }

  it('RIS: a form-feed/line-separator-smuggled record cannot emit extra TY/ER/AU lines', () => {
    const detail = detailWith({
      // Same attack as the CR/LF line-injection test, reached via 0x0C + 0x2028.
      title: 'Innocent' + SEP.FF + 'ER  - ' + SEP.LS + 'TY  - JOUR' + SEP.LS + 'AU  - Forged',
      json_metadata: { pevo: { authors: [{ name: 'Alice Smith' }] } },
    });
    const lines = generateRis(detail).split(SEP.LF);
    expect(lines.filter((l) => l.startsWith('TY  - '))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('ER  -'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('AU  - '))).toHaveLength(1);
  });

  it('APA: a line-separator/form-feed title stays on one line with no raw separators', () => {
    const detail = detailWith({ title: 'Title' + SEP.LS + 'Injected' + SEP.FF + 'More' });
    const out = generateApa(detail);
    expect(out.split(SEP.LF)).toHaveLength(1);
    expect(out).not.toMatch(ANY_SEP);
    expect(out).toContain('Title Injected More');
  });

  it('BibTeX: a line-separator-smuggled entry header cannot create a second entry', () => {
    const detail = detailWith({ title: 'X' + SEP.LS + '@article{evil, title={y' });
    const out = generateBibtex(detail);
    expect(countEntries(out)).toBe(1);
    expect(out).not.toMatch(ANY_SEP);
  });
});

// Cover the empty-`pevo.authors` fallback branch (author fields fall back to the
// post account) — previously untested in all three formats.
describe('empty-authors fallback', () => {
  it('BibTeX author falls back to the post account when pevo.authors is empty', () => {
    const detail = detailWith({ author: 'alice', json_metadata: { pevo: { authors: [] } } });
    expect(generateBibtex(detail)).toContain('author = {alice}');
  });

  it('RIS author falls back to the post account when pevo.authors is empty', () => {
    const detail = detailWith({ author: 'alice', json_metadata: { pevo: { authors: [] } } });
    const lines = generateRis(detail).split(SEP.LF);
    expect(lines.filter((l) => l.startsWith('AU  - '))).toHaveLength(1);
    expect(lines).toContain('AU  - alice');
  });

  it('APA author falls back to the post account when pevo.authors is empty', () => {
    const detail = detailWith({ author: 'alice', json_metadata: { pevo: { authors: [] } } });
    expect(generateApa(detail)).toContain('alice (');
  });
});

// The DOI branch reads top-level detail.doi. NOTE: detail.doi is not populated
// on the live /cite path today (a pre-existing keying issue surfaced during
// review keeps the live DOI/author data under meta[APP_TAG], unread by the
// generators) — see the re-review signal. This pins the branch's escape via the
// field the generators actually read, so a caller that does set detail.doi
// cannot forge a record.
describe('DOI branch (detail.doi)', () => {
  it('RIS emits an escaped DO line; CR/LF in the DOI cannot forge a record', () => {
    const detail = detailWith({
      doi: '10.1000/abc' + SEP.CR + SEP.LF + 'ER  - ',
      json_metadata: { pevo: { authors: [{ name: 'Alice Smith' }] } },
    });
    const lines = generateRis(detail).split(SEP.LF);
    const doLines = lines.filter((l) => l.startsWith('DO  - '));
    expect(doLines).toHaveLength(1);
    expect(doLines[0]).toBe('DO  - 10.1000/abc ER  -');
    expect(lines.filter((l) => l.startsWith('ER  -'))).toHaveLength(1);
  });

  it('no DO line when detail.doi is absent', () => {
    const detail = detailWith({ json_metadata: { pevo: { authors: [{ name: 'Alice Smith' }] } } });
    expect(generateRis(detail).split(SEP.LF).filter((l) => l.startsWith('DO  - '))).toHaveLength(0);
  });
});

// The `as string` casts on chain fields are crash-reachable: a missing OR
// wrong-typed (number, object) chain field would reach .replace / title.split.
// The helpers coerce ANY non-string to '' so the export degrades to an empty
// value instead of 500ing.
describe('defensive coercion of absent or wrong-typed chain fields', () => {
  it('escape helpers return empty string on nullish or non-string input', () => {
    expect(bibtexEscape(undefined as unknown as string)).toBe('');
    expect(bibtexEscape(null as unknown as string)).toBe('');
    expect(bibtexEscape(42 as unknown as string)).toBe('');
    expect(risEscape(undefined as unknown as string)).toBe('');
    expect(risEscape({} as unknown as string)).toBe('');
    expect(singleLine(null as unknown as string)).toBe('');
    expect(singleLine(['x'] as unknown as string)).toBe('');
  });

  it('generators do not throw when title and author are absent', () => {
    const detail = { permlink: 'p', created: '2023-01-01T00:00:00Z', json_metadata: { pevo: {} } };
    expect(() => generateBibtex(detail)).not.toThrow();
    expect(() => generateRis(detail)).not.toThrow();
    expect(() => generateApa(detail)).not.toThrow();
  });

  it('generators do not throw on a wrong-typed author name (chain-controlled)', () => {
    // pevo.authors[].name is broadcaster-controlled with no per-element type
    // check; a numeric name must not crash the RIS/APA per-author escape.
    const detail = detailWith({ json_metadata: { pevo: { authors: [{ name: 42 as unknown as string }] } } });
    expect(() => generateRis(detail)).not.toThrow();
    expect(() => generateApa(detail)).not.toThrow();
    expect(() => generateBibtex(detail)).not.toThrow();
  });
});

/**
 * Pure-function tests for the citation-export builders in
 * `src/routes/papers.ts` (`generateBibtex`, `generateRis`, `generateApa`) and
 * their escape helpers (`bibtexEscape`, `risEscape`, `singleLine`).
 *
 * These exercise file-format-injection defenses: a chain-sourced paper title or
 * author name must not be able to break out of a BibTeX `@article{...}` entry,
 * inject extra RIS records/tag lines, or split a one-line APA citation. The
 * builders are pure (they take a `detail` object and return a string), so no DB,
 * Redis, HAF, or auth middleware is involved — these are direct unit tests
 * against the exported functions, not route-level integration tests.
 *
 * The `detail` shape mirrors the live `/cite` path: co-author names live in
 * `detail.authors` (the supersession/cumulative projection that always carries a
 * `name`), and the DOI lives under `meta[config.appTag].source.doi` (read via
 * `safePevoMeta`). The generators do NOT read a `detail.json_metadata.pevo`
 * sub-key — that key is never populated on the live path.
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
import { config } from '../../src/config.js';

// The generators read co-author names from `detail.authors` and the DOI from
// `safePevoMeta(detail.json_metadata).source.doi` — i.e. the PEvO object keyed
// under `meta[config.appTag]`, the live chain-metadata shape — NOT from a
// `detail.json_metadata.pevo` sub-key, which is never populated. The default
// `json_metadata` here is keyed under `config.appTag` (so `safePevoMeta` finds
// it) and the default author list lives in `detail.authors`; tests that vary
// the author list pass `authors: [...]` directly, and tests that exercise the
// DOI branch pass `json_metadata: pevoMeta({ source: { doi } })`.
function pevoMeta(pevo: Record<string, unknown>): Record<string, unknown> {
  return { [config.appTag]: pevo };
}

function detailWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    author: 'alice',
    permlink: 'my-paper',
    title: 'Some Paper Title',
    created: '2023-06-01T00:00:00Z',
    authors: [{ name: 'Alice Smith' }],
    json_metadata: pevoMeta({}),
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
      authors: [{ name: 'Alice Smith' }],
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
      authors: [{ name: 'Eve}{' }, { name: 'Mallory\r\nFake' }],
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
    const detail = detailWith({ title: 'X', json_metadata: pevoMeta({ source: { doi: '10.1000/abc}evil' } }) });
    const out = generateBibtex(detail);
    expect(out).toContain('doi = {10.1000/abc\\}evil}');
    expect((out.match(/@article\{/g) || [])).toHaveLength(1);
  });
});

describe('generateRis', () => {
  it('defeats line injection via a crafted title', () => {
    const detail = detailWith({
      title: 'Innocent\r\nAU  - Fake Author\r\nER  -',
      authors: [{ name: 'Alice Smith' }],
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
      authors: [{ name: 'Real\r\nER  -' }],
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
      authors: [{ name: 'Alice\nSmith' }],
    });
    const out = generateApa(detail);
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('Title Injected');
    expect(out).toContain('Alice Smith');
  });
});

// The line-terminator class must cover more than CR/LF. Form-feed (0x0C),
// vertical-tab (0x0B), the C0 information separators FS/GS/RS (0x1C-0x1E), NEL
// (0x85), LINE SEPARATOR (0x2028), and PARAGRAPH SEPARATOR (0x2029) are treated
// as line breaks by lenient RIS importers and plain-text renderers (FS/GS/RS
// additionally break splitlines()-class tokenizers), so a crafted title using
// them reaches the same file-format-injection class through a wider separator
// alphabet. Separator code points are built via String.fromCharCode so this
// source stays pure ASCII (no invisible bytes, no transport-fragile escape
// sequences).
const SEP = {
  FF: String.fromCharCode(0x0c),
  VT: String.fromCharCode(0x0b),
  FS: String.fromCharCode(0x1c),
  GS: String.fromCharCode(0x1d),
  RS: String.fromCharCode(0x1e),
  NEL: String.fromCharCode(0x85),
  LS: String.fromCharCode(0x2028),
  PS: String.fromCharCode(0x2029),
  CR: String.fromCharCode(0x0d),
  LF: String.fromCharCode(0x0a),
};
const ANY_SEP = new RegExp('[' + SEP.VT + SEP.FF + SEP.FS + SEP.GS + SEP.RS + SEP.NEL + SEP.LS + SEP.PS + ']');
const countEntries = (bib: string): number => bib.split('@article{').length - 1;

describe('extended line-terminator alphabet', () => {
  const SEPARATORS: ReadonlyArray<readonly [string, string]> = [
    ['form-feed 0x0C', SEP.FF],
    ['vertical-tab 0x0B', SEP.VT],
    ['file-separator 0x1C', SEP.FS],
    ['group-separator 0x1D', SEP.GS],
    ['record-separator 0x1E', SEP.RS],
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
      authors: [{ name: 'Alice Smith' }],
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

  it('RIS: a C0-separator-smuggled record (FS/GS/RS) cannot emit extra TY/ER/AU lines', () => {
    const detail = detailWith({
      // FS/GS/RS (0x1C-0x1E) are non-whitespace and break splitlines()-class
      // RIS importers; a crafted title using them must not fracture into a
      // forged second record. Mirrors the form-feed/line-separator attack above.
      title: 'Innocent' + SEP.RS + 'ER  - ' + SEP.GS + 'TY  - JOUR' + SEP.FS + 'AU  - Forged',
      authors: [{ name: 'Alice Smith' }],
    });
    const out = generateRis(detail);
    // Load-bearing closure assertion: if the FS/GS/RS code points are dropped
    // from LINE_TERMINATORS, risEscape stops flattening them and they survive
    // mid-line inside the TI value, so this goes RED. The TY/ER/AU cardinality
    // checks below stay as defense-in-depth but hold even on revert (records
    // join on LF, not FS/GS/RS), so they cannot prove the C0 closure alone.
    // Mirrors the BibTeX C0 test below.
    expect(out).not.toMatch(ANY_SEP);
    const lines = out.split(SEP.LF);
    expect(lines.filter((l) => l.startsWith('TY  - '))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('ER  -'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('AU  - '))).toHaveLength(1);
  });

  it('BibTeX: a C0-separator-smuggled entry header (GS) cannot create a second entry', () => {
    const detail = detailWith({ title: 'X' + SEP.GS + '@article{evil, title={y' });
    const out = generateBibtex(detail);
    expect(countEntries(out)).toBe(1);
    expect(out).not.toMatch(ANY_SEP);
  });
});

// The generators read co-author names from `detail.authors` and the DOI from
// `meta[config.appTag].source.doi`. These pin the SOURCE of the data (not just
// the escaping): each test goes RED if the generators revert to reading
// `detail.json_metadata.pevo.authors` / `detail.doi`, which are never populated
// on the live path. Two author shapes are covered: the single-link projection
// (`{name, hive, orcid}`) and the continuation/supersession projection (which
// also carries `orcid_verified`/`orcid_discrepancy` but the same `name`).
describe('author/DOI source (detail.authors, meta[config.appTag].source.doi)', () => {
  it('BibTeX lists every co-author name (single-link shape) and the DOI', () => {
    const detail = detailWith({
      authors: [
        { name: 'Alice Smith', hive: 'alice', orcid: '0000-0001-0000-0001' },
        { name: 'Bob Jones', hive: 'bob', orcid: '0000-0002-0000-0002' },
      ],
      json_metadata: pevoMeta({ source: { doi: '10.1000/xyz123' } }),
    });
    const out = generateBibtex(detail);
    expect(out).toContain('author = {Alice Smith and Bob Jones}');
    expect(out).toContain('doi = {10.1000/xyz123}');
  });

  it('RIS emits one AU line per co-author (continuation/supersession shape) and a DO line', () => {
    const detail = detailWith({
      authors: [
        { name: 'Alice Smith', hive: 'alice', orcid: '0000-0001-0000-0001', orcid_verified: '0000-0001-0000-0001', orcid_discrepancy: false },
        { name: 'Carol White', hive: 'carol', orcid: '0000-0003-0000-0003', orcid_verified: null, orcid_discrepancy: false },
      ],
      json_metadata: pevoMeta({ source: { doi: '10.1000/xyz123' } }),
    });
    const lines = generateRis(detail).split(SEP.LF);
    expect(lines.filter((l) => l.startsWith('AU  - '))).toEqual(['AU  - Alice Smith', 'AU  - Carol White']);
    expect(lines.filter((l) => l.startsWith('DO  - '))).toEqual(['DO  - 10.1000/xyz123']);
  });

  it('APA joins every co-author name', () => {
    const detail = detailWith({
      authors: [{ name: 'Alice Smith' }, { name: 'Bob Jones' }],
    });
    const out = generateApa(detail);
    expect(out).toContain('Alice Smith, Bob Jones (');
  });

  it('mutation-kill: reading detail.json_metadata.pevo instead of detail.authors yields the post account', () => {
    // The OLD buggy read sourced authors from `detail.json_metadata.pevo.authors`.
    // With the live shape, that key is empty, so the buggy code would fall back
    // to the post account. detail.authors carries the real names; assert they win.
    const detail = detailWith({
      author: 'alice',
      authors: [{ name: 'Alice Smith' }, { name: 'Bob Jones' }],
      // A populated legacy `.pevo` sub-key that the generators must IGNORE.
      json_metadata: { pevo: { authors: [{ name: 'Ghost Author' }] } },
    });
    const out = generateBibtex(detail);
    expect(out).toContain('author = {Alice Smith and Bob Jones}');
    expect(out).not.toContain('Ghost Author');
    expect(out).not.toContain('author = {alice}');
  });
});

// Cover the empty-`detail.authors` fallback branch (author fields fall back to
// the post account) — previously untested in all three formats.
describe('empty-authors fallback', () => {
  it('BibTeX author falls back to the post account when detail.authors is empty', () => {
    const detail = detailWith({ author: 'alice', authors: [] });
    expect(generateBibtex(detail)).toContain('author = {alice}');
  });

  it('RIS author falls back to the post account when detail.authors is empty', () => {
    const detail = detailWith({ author: 'alice', authors: [] });
    const lines = generateRis(detail).split(SEP.LF);
    expect(lines.filter((l) => l.startsWith('AU  - '))).toHaveLength(1);
    expect(lines).toContain('AU  - alice');
  });

  it('APA author falls back to the post account when detail.authors is empty', () => {
    const detail = detailWith({ author: 'alice', authors: [] });
    expect(generateApa(detail)).toContain('alice (');
  });
});

// The DOI branch reads `safePevoMeta(detail.json_metadata).source.doi` — i.e.
// `meta[config.appTag].source.doi`, the live chain-metadata shape. This pins
// the branch's escape via the field the generators actually read, so a crafted
// DOI cannot forge a record.
describe('DOI branch (meta[config.appTag].source.doi)', () => {
  it('RIS emits an escaped DO line; CR/LF in the DOI cannot forge a record', () => {
    const detail = detailWith({
      json_metadata: pevoMeta({ source: { doi: '10.1000/abc' + SEP.CR + SEP.LF + 'ER  - ' } }),
    });
    const lines = generateRis(detail).split(SEP.LF);
    const doLines = lines.filter((l) => l.startsWith('DO  - '));
    expect(doLines).toHaveLength(1);
    expect(doLines[0]).toBe('DO  - 10.1000/abc ER  -');
    expect(lines.filter((l) => l.startsWith('ER  -'))).toHaveLength(1);
  });

  it('no DO line when the DOI is absent', () => {
    const detail = detailWith({ json_metadata: pevoMeta({}) });
    expect(generateRis(detail).split(SEP.LF).filter((l) => l.startsWith('DO  - '))).toHaveLength(0);
  });
});

// The `as string` casts on chain fields are crash-reachable: a missing OR
// wrong-typed (number, object) chain field would reach .replace / title.split.
// The helpers coerce ANY non-string to '' so the export degrades to an empty
// value instead of 500ing.
describe('defensive coercion of absent or wrong-typed chain fields', () => {
  it('escape helpers return empty string on nullish or non-string input', () => {
    // The helpers are typed `(s: unknown)` so these intentional non-string
    // inputs pass without casts; each coerces to '' internally.
    expect(bibtexEscape(undefined)).toBe('');
    expect(bibtexEscape(null)).toBe('');
    expect(bibtexEscape(42)).toBe('');
    expect(risEscape(undefined)).toBe('');
    expect(risEscape({})).toBe('');
    expect(singleLine(null)).toBe('');
    expect(singleLine(['x'])).toBe('');
  });

  it('generators do not throw when title and author are absent', () => {
    const detail = { permlink: 'p', created: '2023-01-01T00:00:00Z', authors: [], json_metadata: pevoMeta({}) };
    expect(() => generateBibtex(detail)).not.toThrow();
    expect(() => generateRis(detail)).not.toThrow();
    expect(() => generateApa(detail)).not.toThrow();
  });

  it('generators do not throw on a wrong-typed author name (chain-controlled)', () => {
    // detail.authors[].name is broadcaster-derived; a wrong-typed (numeric)
    // name must coerce to '' and not crash the RIS/APA per-author escape.
    const detail = detailWith({ authors: [{ name: 42 as unknown as string }] });
    expect(() => generateRis(detail)).not.toThrow();
    expect(() => generateApa(detail)).not.toThrow();
    expect(() => generateBibtex(detail)).not.toThrow();
  });
});

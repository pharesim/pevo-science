import { describe, it, expect } from 'vitest';
import { parseMeta, isPevoPaper, isPevoReview, isPevoBridgePaper, isPevoAnyPaper, toPaperSummary, pevoString, pevoStringArray } from '../src/helpers.js';
import { config } from '../src/config.js';

const TAG = config.appTag;
const APP_ID = config.appId;

describe('parseMeta', () => {
  it('parses a valid JSON string', () => {
    const jsonStr = JSON.stringify({ app: APP_ID });
    const result = parseMeta(jsonStr);
    expect(result).toEqual({ app: APP_ID });
  });

  it('returns empty object for invalid JSON', () => {
    expect(parseMeta('not json')).toEqual({});
  });

  it('returns the object as-is if already an object', () => {
    const obj = { app: APP_ID };
    expect(parseMeta(obj)).toBe(obj);
  });

  it('returns empty object for null/undefined', () => {
    expect(parseMeta(null)).toEqual({});
    expect(parseMeta(undefined)).toEqual({});
  });
});

describe('isPevoPaper', () => {
  it('returns true for a valid PEvO paper metadata', () => {
    expect(isPevoPaper({ app: APP_ID, [TAG]: { type: 'paper' } })).toBe(true);
  });

  it('returns false if pevo.type is not paper', () => {
    expect(isPevoPaper({ app: APP_ID, [TAG]: { type: 'review' } })).toBe(false);
  });

  it('returns false if app does not start with pevo/', () => {
    expect(isPevoPaper({ app: 'other/0.1', [TAG]: { type: 'paper' } })).toBe(false);
  });

  it('returns false if pevo field is missing', () => {
    expect(isPevoPaper({ app: APP_ID })).toBe(false);
  });
});

describe('isPevoBridgePaper', () => {
  // Author argument is load-bearing: bridge identity is what distinguishes a
  // real bridge import from a spoofed self-claim. See
  //   agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md
  it('returns true for bridge_paper type when author is config.hiveBridgeAccount', () => {
    expect(isPevoBridgePaper({ app: APP_ID, [TAG]: { type: 'bridge_paper' } }, config.hiveBridgeAccount)).toBe(true);
  });

  it('returns false for bridge_paper type when author is NOT config.hiveBridgeAccount (spoof)', () => {
    expect(isPevoBridgePaper({ app: APP_ID, [TAG]: { type: 'bridge_paper' } }, 'attacker')).toBe(false);
  });

  it('returns false for native paper type', () => {
    expect(isPevoBridgePaper({ app: APP_ID, [TAG]: { type: 'paper' } }, config.hiveBridgeAccount)).toBe(false);
  });
});

describe('isPevoAnyPaper', () => {
  it('returns true for native paper (any author)', () => {
    expect(isPevoAnyPaper({ app: APP_ID, [TAG]: { type: 'paper' } }, 'alice')).toBe(true);
  });

  it('returns true for bridge paper authored by bridge account', () => {
    expect(isPevoAnyPaper({ app: APP_ID, [TAG]: { type: 'bridge_paper' } }, config.hiveBridgeAccount)).toBe(true);
  });

  it('returns false for spoofed bridge_paper from non-bridge author', () => {
    expect(isPevoAnyPaper({ app: APP_ID, [TAG]: { type: 'bridge_paper' } }, 'attacker')).toBe(false);
  });

  it('returns false for review', () => {
    expect(isPevoAnyPaper({ app: APP_ID, [TAG]: { type: 'review' } }, 'alice')).toBe(false);
  });
});

describe('isPevoReview', () => {
  it('returns true for a valid PEvO review metadata', () => {
    expect(isPevoReview({ app: APP_ID, [TAG]: { type: 'review' } })).toBe(true);
  });

  it('returns false for paper type', () => {
    expect(isPevoReview({ app: APP_ID, [TAG]: { type: 'paper' } })).toBe(false);
  });
});

describe('pevoString', () => {
  // Round-4 hold item 1: typed read for `pevo`-string fields. Replaces the
  // `(pevo[key] as string) ?? null` cast pattern at the per-version IPFS
  // triple in `papers.ts` head-meta override. Three runtime-shape failure
  // modes the cast pattern silently lets through:
  //   (a) `''` empty-string flows through `??`, breaking head-fallback-to-root
  //       and diverging from `|| null` sites elsewhere in the codebase.
  //   (b) Numeric `0` flows through unchanged, ending up as a number where a
  //       string was expected.
  //   (c) Object/array values flow through unchanged with the same shape mismatch.
  it('returns the string when the field is a non-empty string', () => {
    expect(pevoString({ ipfs_cid: 'QmFoo' }, 'ipfs_cid')).toBe('QmFoo');
  });

  it('returns null for an empty string (codebase-wide convention: "" collapses to null)', () => {
    expect(pevoString({ ipfs_cid: '' }, 'ipfs_cid')).toBeNull();
  });

  it('returns null for numeric values (e.g. 0 must not flow through as a string)', () => {
    expect(pevoString({ ipfs_cid: 0 }, 'ipfs_cid')).toBeNull();
    expect(pevoString({ ipfs_cid: 42 }, 'ipfs_cid')).toBeNull();
  });

  it('returns null for object/array values (cast pattern would have leaked the object through)', () => {
    expect(pevoString({ ipfs_cid: {} }, 'ipfs_cid')).toBeNull();
    expect(pevoString({ ipfs_cid: ['Qm1', 'Qm2'] }, 'ipfs_cid')).toBeNull();
  });

  it('returns null for boolean values', () => {
    expect(pevoString({ ipfs_cid: false }, 'ipfs_cid')).toBeNull();
    expect(pevoString({ ipfs_cid: true }, 'ipfs_cid')).toBeNull();
  });

  it('returns null for null / undefined / missing keys', () => {
    expect(pevoString({ ipfs_cid: null }, 'ipfs_cid')).toBeNull();
    expect(pevoString({ ipfs_cid: undefined }, 'ipfs_cid')).toBeNull();
    expect(pevoString({}, 'ipfs_cid')).toBeNull();
  });
});

describe('pevoStringArray', () => {
  // Round-7 sibling helper for `pevoString`. Mirrors the runtime-shape
  // failure modes the cast pattern `(pevo[key] as string[]) || []`
  // silently lets through:
  //   (a) Non-array runtime values (string, number, object) flow through
  //       as `string[]` from the checker's perspective, then crash
  //       downstream `.map`/`.filter`/`.join` consumers.
  //   (b) Array values with non-string entries (e.g. `[42, 'foo', null]`)
  //       coerce to display garbage when joined or shown.
  // The helper unifies the read pattern: the result is always a real
  // `string[]` whose entries are guaranteed non-empty strings.
  it('returns the array when all entries are non-empty strings', () => {
    expect(pevoStringArray({ keywords: ['brain', 'cognition'] }, 'keywords')).toEqual(['brain', 'cognition']);
  });

  it('returns an empty array for an empty array', () => {
    expect(pevoStringArray({ keywords: [] }, 'keywords')).toEqual([]);
  });

  it('filters non-string entries out of an array (mixed types)', () => {
    expect(pevoStringArray({ keywords: [42, 'foo', null, 'bar', undefined, true, {}] }, 'keywords')).toEqual(['foo', 'bar']);
  });

  it('filters empty-string entries out of an array (codebase-wide convention: "" collapses to drop)', () => {
    expect(pevoStringArray({ keywords: ['', 'foo', ''] }, 'keywords')).toEqual(['foo']);
  });

  // Round-2 hold item 1: pin the whitespace-vs-empty boundary explicitly.
  // The filter is `entry.length > 0`, NOT `entry.trim().length > 0` — a
  // future "polish" change to trim-and-test would silently change public
  // API behavior (whitespace-only keywords would start dropping). This
  // test fails red on that mutation.
  it('keeps whitespace-only entries (filter is length > 0, not trim().length > 0)', () => {
    expect(pevoStringArray({ keywords: ['   ', 'foo'] }, 'keywords')).toEqual(['   ', 'foo']);
  });

  it('returns [] for non-array values (string, number, object, boolean, null, undefined, missing)', () => {
    expect(pevoStringArray({ keywords: 'not-an-array' }, 'keywords')).toEqual([]);
    expect(pevoStringArray({ keywords: 42 }, 'keywords')).toEqual([]);
    expect(pevoStringArray({ keywords: { 0: 'foo' } }, 'keywords')).toEqual([]);
    expect(pevoStringArray({ keywords: true }, 'keywords')).toEqual([]);
    expect(pevoStringArray({ keywords: false }, 'keywords')).toEqual([]);
    expect(pevoStringArray({ keywords: null }, 'keywords')).toEqual([]);
    expect(pevoStringArray({ keywords: undefined }, 'keywords')).toEqual([]);
    expect(pevoStringArray({}, 'keywords')).toEqual([]);
  });

  it('returns a fresh array on each call (no caller-mutates-source aliasing)', () => {
    const pevo = { keywords: ['a', 'b'] };
    const r1 = pevoStringArray(pevo, 'keywords');
    const r2 = pevoStringArray(pevo, 'keywords');
    expect(r1).not.toBe(r2);
    r1.push('c');
    expect(r2).toEqual(['a', 'b']);
    // Source array is also unmutated.
    expect(pevo.keywords).toEqual(['a', 'b']);
  });
});

describe('toPaperSummary', () => {
  it('extracts fields from a post and metadata', () => {
    const post = {
      author: 'alice',
      permlink: 'my-paper',
      title: 'Test Paper',
      body: 'Abstract text here that is short',
      created: '2026-01-01T00:00:00',
      net_votes: 5,
    };
    const meta = {
      app: APP_ID,
      [TAG]: {
        type: 'paper',
        discipline: 'neuroscience',
        keywords: ['brain', 'cognition'],
        authors: [{ name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' }],
        ipfs_cid: 'QmTest123',
      },
    };

    const result = toPaperSummary(post, meta);
    expect(result.author).toBe('alice');
    expect(result.permlink).toBe('my-paper');
    expect(result.title).toBe('Test Paper');
    expect(result.abstract).toBe('Abstract text here that is short');
    expect(result.discipline).toBe('neuroscience');
    expect(result.keywords).toEqual(['brain', 'cognition']);
    expect(result.ipfs_cid).toBe('QmTest123');
    expect(result.net_votes).toBe(5);
    expect(result.review_count).toBe(0); // accurate count requires HAF; defaults to 0
    expect(result.citation_count).toBe(0);
    expect(result.author_reputation).toBe(0);
    expect(result.is_accredited).toBe(false);
    // Round-4 hold item 4(b): native-paper case — `type: 'paper'` with any
    // author renders source_type='native'. The bridge-author identity check
    // is not load-bearing here (native-typed metadata never reaches the bridge
    // arm of `isPevoBridgePaper`); pinning it explicitly closes the symmetry
    // gap left by the round-3 spoofed/legitimate bridge_paper specs above.
    expect(result.source_type).toBe('native');
  });

  it('handles missing pevo fields gracefully', () => {
    const post = {
      author: 'bob',
      permlink: 'paper-2',
      title: 'Another Paper',
      body: 'x'.repeat(400),
      created: '2026-02-01T00:00:00',
      net_votes: 0,
    };
    const meta = { app: APP_ID, [TAG]: {} };

    const result = toPaperSummary(post, meta);
    expect(result.abstract.length).toBe(300);
    expect(result.discipline).toBe('');
    expect(result.keywords).toEqual([]);
    expect(result.authors).toEqual([]);
    expect(result.ipfs_cid).toBeNull();
    expect(result.review_count).toBe(0);
  });

  // Round-3 hold item 3: `isPevoBridgePaper` is the load-bearing identity check
  // for `toPaperSummary`'s source_type/doi rendering. A spoofed bridge_paper
  // (type set, but author ≠ config.hiveBridgeAccount) MUST degrade to the
  // native render shape. Without this assertion, a future regression that
  // narrowed `isPevoBridgePaper` back to a meta-only check would slip past
  // both helpers.test.ts (which only tests the predicate directly) and
  // bridge-paper-author-gate.test.ts (which only tests SQL shape).
  it("degrades a spoofed bridge_paper (non-bridge author) to native source_type with null doi", () => {
    const post = {
      author: 'attacker',
      permlink: 'spoof-1',
      title: 'Spoofed',
      body: 'Body',
      created: '2026-04-30T00:00:00',
      net_votes: 0,
    };
    const meta = {
      app: APP_ID,
      [TAG]: {
        type: 'bridge_paper',
        source: { type: 'arxiv', doi: '10.0000/spoof.1' },
      },
    };
    const result = toPaperSummary(post, meta);
    // Source_type falls back to 'native' because the author is not the bridge
    // account; the metadata `source.type` MUST NOT leak through.
    expect(result.source_type).toBe('native');
    // doi is null in the native render path; the metadata `doi` MUST NOT leak.
    expect(result.doi).toBeNull();
  });

  it("renders a legitimate bridge_paper authored by config.hiveBridgeAccount with bridge metadata", () => {
    const post = {
      author: config.hiveBridgeAccount,
      permlink: 'legit-bridge-1',
      title: 'Legit Bridge Paper',
      body: 'Body',
      created: '2026-04-30T00:00:00',
      net_votes: 0,
    };
    const meta = {
      app: APP_ID,
      [TAG]: {
        type: 'bridge_paper',
        source: { type: 'crossref', doi: '10.1000/legit.1' },
      },
    };
    const result = toPaperSummary(post, meta);
    expect(result.source_type).toBe('crossref');
    expect(result.doi).toBe('10.1000/legit.1');
  });
});

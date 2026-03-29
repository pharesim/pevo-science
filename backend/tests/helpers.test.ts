import { describe, it, expect } from 'vitest';
import { parseMeta, isPevoPaper, isPevoReview, isPevoBridgePaper, isPevoAnyPaper, toPaperSummary } from '../src/helpers.js';

describe('parseMeta', () => {
  it('parses a valid JSON string', () => {
    const result = parseMeta('{"app":"pevo/0.1"}');
    expect(result).toEqual({ app: 'pevo/0.1' });
  });

  it('returns empty object for invalid JSON', () => {
    expect(parseMeta('not json')).toEqual({});
  });

  it('returns the object as-is if already an object', () => {
    const obj = { app: 'pevo/0.1' };
    expect(parseMeta(obj)).toBe(obj);
  });

  it('returns empty object for null/undefined', () => {
    expect(parseMeta(null)).toEqual({});
    expect(parseMeta(undefined)).toEqual({});
  });
});

describe('isPevoPaper', () => {
  it('returns true for a valid PEvO paper metadata', () => {
    expect(isPevoPaper({ app: 'pevo/0.1', pevo: { type: 'paper' } })).toBe(true);
  });

  it('returns false if pevo.type is not paper', () => {
    expect(isPevoPaper({ app: 'pevo/0.1', pevo: { type: 'review' } })).toBe(false);
  });

  it('returns false if app does not start with pevo/', () => {
    expect(isPevoPaper({ app: 'other/0.1', pevo: { type: 'paper' } })).toBe(false);
  });

  it('returns false if pevo field is missing', () => {
    expect(isPevoPaper({ app: 'pevo/0.1' })).toBe(false);
  });
});

describe('isPevoBridgePaper', () => {
  it('returns true for bridge_paper type', () => {
    expect(isPevoBridgePaper({ app: 'pevo/0.1', pevo: { type: 'bridge_paper' } })).toBe(true);
  });

  it('returns false for native paper type', () => {
    expect(isPevoBridgePaper({ app: 'pevo/0.1', pevo: { type: 'paper' } })).toBe(false);
  });
});

describe('isPevoAnyPaper', () => {
  it('returns true for native paper', () => {
    expect(isPevoAnyPaper({ app: 'pevo/0.1', pevo: { type: 'paper' } })).toBe(true);
  });

  it('returns true for bridge paper', () => {
    expect(isPevoAnyPaper({ app: 'pevo/0.1', pevo: { type: 'bridge_paper' } })).toBe(true);
  });

  it('returns false for review', () => {
    expect(isPevoAnyPaper({ app: 'pevo/0.1', pevo: { type: 'review' } })).toBe(false);
  });
});

describe('isPevoReview', () => {
  it('returns true for a valid PEvO review metadata', () => {
    expect(isPevoReview({ app: 'pevo/0.1', pevo: { type: 'review' } })).toBe(true);
  });

  it('returns false for paper type', () => {
    expect(isPevoReview({ app: 'pevo/0.1', pevo: { type: 'paper' } })).toBe(false);
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
      app: 'pevo/0.1',
      pevo: {
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
    const meta = { app: 'pevo/0.1', pevo: {} };

    const result = toPaperSummary(post, meta);
    expect(result.abstract.length).toBe(300);
    expect(result.discipline).toBe('');
    expect(result.keywords).toEqual([]);
    expect(result.authors).toEqual([]);
    expect(result.ipfs_cid).toBeNull();
    expect(result.review_count).toBe(0);
  });
});

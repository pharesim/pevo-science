import { describe, it, expect } from 'vitest';
import { parseMeta, isPevoPaper, isPevoReview, isPevoBridgePaper, isPevoAnyPaper, toPaperSummary } from '../src/helpers.js';
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
});

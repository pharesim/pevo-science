import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  getAppTag: () => 'pevotest',
}));

import { computeVersionDiff } from '../../src/lib/version-diff.js';

describe('version-diff', () => {
  const baseVersion = {
    title: 'Original Title',
    body: 'Original body text.',
    authors: [{ hive: 'alice', name: 'Alice' }],
    supplementary_files: [],
    citations: [],
    keywords: ['science'],
  };

  describe('textDiff (via computeVersionDiff)', () => {
    it('detects no change when versions are identical', () => {
      const diff = computeVersionDiff(baseVersion, { ...baseVersion });
      expect(diff.title.changed).toBe(false);
      expect(diff.body.changed).toBe(false);
      expect(diff.authors.changed).toBe(false);
      expect(diff.keywords.changed).toBe(false);
    });

    it('detects title change', () => {
      const v2 = { ...baseVersion, title: 'Updated Title' };
      const diff = computeVersionDiff(baseVersion, v2);
      expect(diff.title.changed).toBe(true);
      expect(diff.title.segments.length).toBeGreaterThan(0);
      expect(diff.title.segments.some(s => s.type === 'insert')).toBe(true);
    });

    it('detects body change', () => {
      const v2 = { ...baseVersion, body: 'New body text.' };
      const diff = computeVersionDiff(baseVersion, v2);
      expect(diff.body.changed).toBe(true);
      expect(diff.body.diffable).toBe(true);
      expect(diff.body.segments.some(s => s.type === 'delete')).toBe(true);
      expect(diff.body.segments.some(s => s.type === 'insert')).toBe(true);
    });

    it('handles null/undefined text gracefully', () => {
      const v1 = { ...baseVersion, title: null, body: undefined };
      const v2 = { ...baseVersion, title: 'New', body: 'New body' };
      const diff = computeVersionDiff(v1, v2);
      expect(diff.title.changed).toBe(true);
      expect(diff.body.changed).toBe(true);
    });
  });

  describe('body diffable flag', () => {
    it('marks body as not diffable when versionA has ipfs_cid', () => {
      const v1 = { ...baseVersion, ipfs_cid: 'Qm123' };
      const v2 = { ...baseVersion, body: 'Changed' };
      const diff = computeVersionDiff(v1, v2);
      expect(diff.body.diffable).toBe(false);
      expect(diff.body.changed).toBe(false);
      expect(diff.body.segments).toEqual([]);
    });

    it('marks body as not diffable when versionB has ipfs_cid', () => {
      const v1 = { ...baseVersion };
      const v2 = { ...baseVersion, ipfs_cid: 'Qm456' };
      const diff = computeVersionDiff(v1, v2);
      expect(diff.body.diffable).toBe(false);
    });

    it('marks body as not diffable when both have ipfs_cid', () => {
      const v1 = { ...baseVersion, ipfs_cid: 'Qm123' };
      const v2 = { ...baseVersion, ipfs_cid: 'Qm456' };
      const diff = computeVersionDiff(v1, v2);
      expect(diff.body.diffable).toBe(false);
    });
  });

  describe('setDiff (via computeVersionDiff)', () => {
    it('detects added authors', () => {
      const v2 = { ...baseVersion, authors: [...baseVersion.authors, { hive: 'bob', name: 'Bob' }] };
      const diff = computeVersionDiff(baseVersion, v2);
      expect(diff.authors.changed).toBe(true);
      expect(diff.authors.added).toEqual([{ hive: 'bob', name: 'Bob' }]);
      expect(diff.authors.removed).toEqual([]);
    });

    it('detects removed authors', () => {
      const v2 = { ...baseVersion, authors: [] };
      const diff = computeVersionDiff(baseVersion, v2);
      expect(diff.authors.changed).toBe(true);
      expect(diff.authors.removed).toEqual([{ hive: 'alice', name: 'Alice' }]);
      expect(diff.authors.added).toEqual([]);
    });

    it('detects no author change when same set', () => {
      const diff = computeVersionDiff(baseVersion, { ...baseVersion });
      expect(diff.authors.changed).toBe(false);
      expect(diff.authors.added).toEqual([]);
      expect(diff.authors.removed).toEqual([]);
    });

    it('detects added and removed keywords', () => {
      const v2 = { ...baseVersion, keywords: ['biology', 'chemistry'] };
      const diff = computeVersionDiff(baseVersion, v2);
      expect(diff.keywords.changed).toBe(true);
      expect(diff.keywords.added).toEqual(['biology', 'chemistry']);
      expect(diff.keywords.removed).toEqual(['science']);
    });

    it('handles null/undefined lists gracefully', () => {
      const v1 = { ...baseVersion, authors: null, keywords: undefined };
      const v2 = { ...baseVersion, authors: [{ hive: 'bob' }], keywords: ['new'] };
      const diff = computeVersionDiff(v1, v2);
      expect(diff.authors.changed).toBe(true);
      expect(diff.authors.added).toEqual([{ hive: 'bob' }]);
      expect(diff.keywords.changed).toBe(true);
      expect(diff.keywords.added).toEqual(['new']);
    });
  });

  describe('supplementary files', () => {
    it('detects added supplementary files', () => {
      const v2 = { ...baseVersion, supplementary_files: [{ cid: 'QmFile1', name: 'data.csv' }] };
      const diff = computeVersionDiff(baseVersion, v2);
      expect(diff.supplementaryFiles.changed).toBe(true);
      expect(diff.supplementaryFiles.added).toEqual([{ cid: 'QmFile1', name: 'data.csv' }]);
    });

    it('uses empty array when both supplementary_files and json_metadata are absent', () => {
      const v1 = { ...baseVersion, supplementary_files: undefined };
      const v2 = { ...baseVersion, supplementary_files: undefined };
      delete v1.json_metadata;
      delete v2.json_metadata;
      const diff = computeVersionDiff(v1, v2);
      expect(diff.supplementaryFiles.changed).toBe(false);
      expect(diff.supplementaryFiles.added).toEqual([]);
      expect(diff.supplementaryFiles.removed).toEqual([]);
    });

    it('falls back to json_metadata for supplementary files', () => {
      const v1 = {
        ...baseVersion,
        supplementary_files: undefined,
        json_metadata: { pevotest: { supplementary_files: [{ cid: 'QmOld', name: 'old.csv' }] } },
      };
      const v2 = {
        ...baseVersion,
        supplementary_files: undefined,
        json_metadata: { pevotest: { supplementary_files: [{ cid: 'QmNew', name: 'new.csv' }] } },
      };
      const diff = computeVersionDiff(v1, v2);
      expect(diff.supplementaryFiles.changed).toBe(true);
      expect(diff.supplementaryFiles.removed).toEqual([{ cid: 'QmOld', name: 'old.csv' }]);
      expect(diff.supplementaryFiles.added).toEqual([{ cid: 'QmNew', name: 'new.csv' }]);
    });
  });

  describe('citations', () => {
    it('detects added citations', () => {
      const v2 = {
        ...baseVersion,
        citations: [{ author: 'bob', permlink: 'paper-1' }],
      };
      const diff = computeVersionDiff(baseVersion, v2);
      expect(diff.citations.changed).toBe(true);
      expect(diff.citations.added).toEqual([{ author: 'bob', permlink: 'paper-1' }]);
    });

    it('detects removed citations', () => {
      const v1 = {
        ...baseVersion,
        citations: [{ author: 'alice', permlink: 'paper-2' }],
      };
      const diff = computeVersionDiff(v1, baseVersion);
      expect(diff.citations.changed).toBe(true);
      expect(diff.citations.removed).toEqual([{ author: 'alice', permlink: 'paper-2' }]);
    });

    it('uses empty array when both citations and json_metadata are absent', () => {
      const v1 = { ...baseVersion, citations: undefined };
      const v2 = { ...baseVersion, citations: undefined };
      delete v1.json_metadata;
      delete v2.json_metadata;
      const diff = computeVersionDiff(v1, v2);
      expect(diff.citations.changed).toBe(false);
    });

    it('falls back to json_metadata for citations', () => {
      const v1 = {
        ...baseVersion,
        citations: undefined,
        json_metadata: { pevotest: { citations: [{ author: 'a', permlink: 'p1' }] } },
      };
      const v2 = {
        ...baseVersion,
        citations: undefined,
        json_metadata: { pevotest: { citations: [{ author: 'b', permlink: 'p2' }] } },
      };
      const diff = computeVersionDiff(v1, v2);
      expect(diff.citations.changed).toBe(true);
    });
  });

  describe('keywords via tags fallback', () => {
    it('uses tags when keywords is absent', () => {
      const v1 = { ...baseVersion, keywords: undefined, tags: ['tag1'] };
      const v2 = { ...baseVersion, keywords: undefined, tags: ['tag2'] };
      const diff = computeVersionDiff(v1, v2);
      expect(diff.keywords.changed).toBe(true);
      expect(diff.keywords.added).toEqual(['tag2']);
      expect(diff.keywords.removed).toEqual(['tag1']);
    });

    it('falls back to empty array when both keywords and tags are absent', () => {
      const v1 = { ...baseVersion, keywords: undefined, tags: undefined };
      const v2 = { ...baseVersion, keywords: undefined, tags: undefined };
      const diff = computeVersionDiff(v1, v2);
      expect(diff.keywords.changed).toBe(false);
      expect(diff.keywords.added).toEqual([]);
      expect(diff.keywords.removed).toEqual([]);
    });

    it('prefers keywords over tags', () => {
      const v1 = { ...baseVersion, keywords: ['kw1'], tags: ['tag1'] };
      const v2 = { ...baseVersion, keywords: ['kw1'], tags: ['tag2'] };
      const diff = computeVersionDiff(v1, v2);
      expect(diff.keywords.changed).toBe(false);
    });
  });
});

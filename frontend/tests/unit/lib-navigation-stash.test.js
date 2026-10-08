// The navigation stash against the real module and jsdom's real
// sessionStorage. Storage failures are planted with spies on
// Storage.prototype, never on the sessionStorage instance.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  takeNavigationStash,
  hasNavigationStash,
  writeNavigationStash,
  clearNavigationStash,
} from '../../src/lib/navigation-stash.js';
import { NAVIGATION_STASH_KEY } from '../../src/lib/subject-bound-keys.js';

const REVIEW_TARGET = { author: 'alice', permlink: 'paper-1' };
const REVIEW_PAYLOAD = {
  reviewBody: 'A careful review.',
  ratings: { methodology: 4, originality: 3, clarity: 5, significance: 2 },
  isAnonymous: true,
};

function reviewRecord(overrides = {}) {
  return {
    surface: 'review',
    target: { ...REVIEW_TARGET },
    subject: 'bob',
    payload: REVIEW_PAYLOAD,
    savedAt: Date.now(),
    ...overrides,
  };
}

function seed(value) {
  sessionStorage.setItem(
    NAVIGATION_STASH_KEY,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

function slot() {
  return sessionStorage.getItem(NAVIGATION_STASH_KEY);
}

describe('navigation stash', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  describe('takeNavigationStash', () => {
    it('returns the payload of a record matching surface, target and subject, and empties the slot', () => {
      seed(reviewRecord());
      expect(takeNavigationStash('review', { author: 'alice', permlink: 'paper-1' }, 'bob'))
        .toEqual(REVIEW_PAYLOAD);
      expect(slot()).toBeNull();
      expect(takeNavigationStash('review', REVIEW_TARGET, 'bob')).toBeNull();
    });

    it('matches a target regardless of key order', () => {
      seed(reviewRecord());
      expect(takeNavigationStash('review', { permlink: 'paper-1', author: 'alice' }, 'bob'))
        .toEqual(REVIEW_PAYLOAD);
    });

    it('leaves a record for another surface in place and does not return it', () => {
      seed(reviewRecord());
      const before = slot();
      expect(takeNavigationStash('comment', REVIEW_TARGET, 'bob')).toBeNull();
      expect(slot()).toBe(before);
    });

    it('leaves a record whose target differs in a value in place and does not return it', () => {
      seed(reviewRecord());
      const before = slot();
      expect(takeNavigationStash('review', { author: 'alice', permlink: 'paper-2' }, 'bob')).toBeNull();
      expect(takeNavigationStash('review', { author: 'carol', permlink: 'paper-1' }, 'bob')).toBeNull();
      expect(slot()).toBe(before);
    });

    it('leaves a record whose target carries an extra key in place and does not return it', () => {
      seed(reviewRecord({ target: { ...REVIEW_TARGET, extra: 'x' } }));
      const before = slot();
      expect(takeNavigationStash('review', REVIEW_TARGET, 'bob')).toBeNull();
      expect(slot()).toBe(before);
    });

    it('does not return a record whose target lacks a key the reader names', () => {
      seed(reviewRecord());
      const before = slot();
      expect(takeNavigationStash('review', { ...REVIEW_TARGET, extra: 'x' }, 'bob')).toBeNull();
      expect(slot()).toBe(before);
    });

    it('compares target values strictly', () => {
      seed(reviewRecord({ target: { vouchee: '1' } }));
      expect(takeNavigationStash('review', { vouchee: 1 }, 'bob')).toBeNull();
      expect(slot()).not.toBeNull();
    });

    it('removes a record naming another subject and does not return it', () => {
      seed(reviewRecord({ subject: 'mallory' }));
      expect(takeNavigationStash('review', REVIEW_TARGET, 'bob')).toBeNull();
      expect(slot()).toBeNull();
    });

    it('removes a record naming another subject even when surface and target also differ', () => {
      seed(reviewRecord({ subject: 'mallory' }));
      expect(takeNavigationStash('comment', { rootAuthor: 'x', rootPermlink: 'y' }, 'bob')).toBeNull();
      expect(slot()).toBeNull();
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['an empty string', ''],
    ])('returns null and leaves the slot when the subject is %s', (_label, subject) => {
      seed(reviewRecord());
      const before = slot();
      expect(takeNavigationStash('review', REVIEW_TARGET, subject)).toBeNull();
      expect(slot()).toBe(before);
    });

    it('returns null for an empty slot', () => {
      expect(takeNavigationStash('review', REVIEW_TARGET, 'bob')).toBeNull();
    });

    it('returns null and leaves the slot for an empty subject even against a record whose subject is empty', () => {
      seed(reviewRecord({ subject: '' }));
      const before = slot();
      expect(takeNavigationStash('review', REVIEW_TARGET, '')).toBeNull();
      expect(slot()).toBe(before);
    });

    it('still restores a matching record saved two hours ago', () => {
      seed(reviewRecord({ savedAt: Date.now() - 2 * 60 * 60 * 1000 }));
      expect(takeNavigationStash('review', REVIEW_TARGET, 'bob')).toEqual(REVIEW_PAYLOAD);
    });

    it('leaves a record for its own reader: a non-matching take first, then the matching take', () => {
      seed({
        surface: 'comment',
        target: { rootAuthor: 'bob', rootPermlink: 'review-1', parentAuthor: 'carol', parentPermlink: 'c1' },
        subject: 'dave',
        payload: { body: 'my reply' },
        savedAt: Date.now(),
      });
      expect(takeNavigationStash(
        'comment',
        { rootAuthor: 'alice', rootPermlink: 'paper-1', parentAuthor: 'alice', parentPermlink: 'paper-1' },
        'dave',
      )).toBeNull();
      expect(takeNavigationStash(
        'comment',
        { rootAuthor: 'bob', rootPermlink: 'review-1', parentAuthor: 'carol', parentPermlink: 'c1' },
        'dave',
      )).toEqual({ body: 'my reply' });
      expect(slot()).toBeNull();
    });
  });

  describe('hasNavigationStash', () => {
    const COMMENT_RECORD = {
      surface: 'comment',
      target: { rootAuthor: 'bob', rootPermlink: 'review-1', parentAuthor: 'carol', parentPermlink: 'c1' },
      subject: 'dave',
      payload: { body: 'my reply' },
      savedAt: Date.now(),
    };

    it('is true for a record of that surface and subject whose target carries every field of the partial target', () => {
      seed(COMMENT_RECORD);
      expect(hasNavigationStash('comment', { rootAuthor: 'bob', rootPermlink: 'review-1' }, 'dave')).toBe(true);
    });

    it('does not consume the record', () => {
      seed(COMMENT_RECORD);
      const before = slot();
      expect(hasNavigationStash('comment', { rootAuthor: 'bob', rootPermlink: 'review-1' }, 'dave')).toBe(true);
      expect(slot()).toBe(before);
      expect(takeNavigationStash('comment', COMMENT_RECORD.target, 'dave')).toEqual({ body: 'my reply' });
    });

    it.each([
      ['another subject', 'comment', { rootAuthor: 'bob', rootPermlink: 'review-1' }, 'erin'],
      ['another surface', 'review', { rootAuthor: 'bob', rootPermlink: 'review-1' }, 'dave'],
      ['a partial target with a differing value', 'comment', { rootAuthor: 'bob', rootPermlink: 'review-2' }, 'dave'],
      ['a partial target naming a field the record lacks', 'comment', { rootAuthor: 'bob', paperAuthor: 'bob' }, 'dave'],
      ['a null subject', 'comment', { rootAuthor: 'bob', rootPermlink: 'review-1' }, null],
      ['an empty subject', 'comment', { rootAuthor: 'bob', rootPermlink: 'review-1' }, ''],
    ])('is false for %s and leaves the record', (_label, surface, partialTarget, subject) => {
      seed(COMMENT_RECORD);
      const before = slot();
      expect(hasNavigationStash(surface, partialTarget, subject)).toBe(false);
      expect(slot()).toBe(before);
    });

    it('is false for an empty slot', () => {
      expect(hasNavigationStash('comment', { rootAuthor: 'bob' }, 'dave')).toBe(false);
    });

    it('is false for an empty subject even against a record whose subject is empty', () => {
      seed({ ...COMMENT_RECORD, subject: '' });
      expect(hasNavigationStash('comment', { rootAuthor: 'bob', rootPermlink: 'review-1' }, '')).toBe(false);
    });
  });

  describe('unreadable slot contents', () => {
    it.each([
      ['unparseable JSON', '{not json'],
      ['a JSON array', JSON.stringify([reviewRecord()])],
      ['a JSON string', JSON.stringify('review')],
      ['a JSON null', 'null'],
      ['a record missing its payload', JSON.stringify({ ...reviewRecord(), payload: undefined })],
      ['a record whose payload is an array', JSON.stringify(reviewRecord({ payload: ['x'] }))],
      ['a record whose target is not an object', JSON.stringify(reviewRecord({ target: 'alice/paper-1' }))],
      ['a record whose target is an array', JSON.stringify(reviewRecord({ target: ['alice', 'paper-1'] }))],
      ['a record whose surface is not a string', JSON.stringify(reviewRecord({ surface: 7 }))],
      ['a record whose subject is not a string', JSON.stringify(reviewRecord({ subject: { name: 'bob' } }))],
    ])('takeNavigationStash removes %s and returns null without throwing', (_label, raw) => {
      seed(raw);
      expect(() => takeNavigationStash('review', REVIEW_TARGET, 'bob')).not.toThrow();
      expect(slot()).toBeNull();
      seed(raw);
      expect(takeNavigationStash('review', REVIEW_TARGET, 'bob')).toBeNull();
    });

    it.each([
      ['unparseable JSON', '{not json'],
      ['a JSON array', JSON.stringify([reviewRecord()])],
      ['a record missing its payload', JSON.stringify({ ...reviewRecord(), payload: undefined })],
      ['a record whose target is not an object', JSON.stringify(reviewRecord({ target: 'alice/paper-1' }))],
      ['a record whose surface is not a string', JSON.stringify(reviewRecord({ surface: 7 }))],
      ['a record whose subject is not a string', JSON.stringify(reviewRecord({ subject: { name: 'bob' } }))],
    ])('hasNavigationStash removes %s and returns false without throwing', (_label, raw) => {
      seed(raw);
      let answer;
      expect(() => { answer = hasNavigationStash('review', { author: 'alice' }, 'bob'); }).not.toThrow();
      expect(answer).toBe(false);
      expect(slot()).toBeNull();
    });
  });

  describe('storage that cannot be reached', () => {
    it('take returns null and has returns false when reading storage throws, and the record survives', () => {
      seed(reviewRecord());
      const before = slot();
      const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
      let taken;
      let has;
      expect(() => { taken = takeNavigationStash('review', REVIEW_TARGET, 'bob'); }).not.toThrow();
      expect(() => { has = hasNavigationStash('review', { author: 'alice' }, 'bob'); }).not.toThrow();
      expect(taken).toBeNull();
      expect(has).toBe(false);
      getItem.mockRestore();
      expect(slot()).toBe(before);
    });

    it('writeNavigationStash stores the record and returns true', () => {
      const record = reviewRecord();
      expect(writeNavigationStash(record)).toBe(true);
      expect(JSON.parse(slot())).toEqual(record);
    });

    it('writeNavigationStash replaces the record already in the slot', () => {
      seed(reviewRecord({ subject: 'mallory' }));
      const record = reviewRecord();
      expect(writeNavigationStash(record)).toBe(true);
      expect(JSON.parse(slot())).toEqual(record);
    });

    it('writeNavigationStash returns false without throwing when storage refuses the write', () => {
      const original = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(key, value) {
        if (key === NAVIGATION_STASH_KEY) throw new DOMException('full', 'QuotaExceededError');
        return original.call(this, key, value);
      });
      let written;
      expect(() => { written = writeNavigationStash(reviewRecord()); }).not.toThrow();
      expect(written).toBe(false);
      expect(slot()).toBeNull();
    });

    it('clearNavigationStash empties the slot', () => {
      seed(reviewRecord());
      clearNavigationStash();
      expect(slot()).toBeNull();
    });

    it('clearNavigationStash does not throw when removing from storage throws', () => {
      seed(reviewRecord());
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
      expect(() => clearNavigationStash()).not.toThrow();
    });

    it('takeNavigationStash does not throw when removing an unreadable record throws', () => {
      seed('{not json');
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
      let taken;
      expect(() => { taken = takeNavigationStash('review', REVIEW_TARGET, 'bob'); }).not.toThrow();
      expect(taken).toBeNull();
    });
  });
});

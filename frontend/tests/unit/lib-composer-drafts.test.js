import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  publishDraftKey,
  editDraftKey,
  removeLegacyDrafts,
  removeAccountDrafts,
  readDraftEntry,
  draftHasText,
  composeDraftEntry,
  snapshotFields,
  fieldsMatchSnapshot,
  headMarkerOf,
} from '../../src/lib/composer-drafts.js';

describe('composer draft storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('keys a draft by account, and on the edit page by the canonical paper', () => {
    expect(publishDraftKey('alice')).toBe('pevo-draft-publish:alice');
    expect(editDraftKey('bob', 'alice', 'p1')).toBe('pevo-draft-edit:bob:alice:p1');
  });

  it('removes the keys used before drafts were bound to an account, and only those', () => {
    localStorage.setItem('pevo-draft-publish', '{}');
    localStorage.setItem('pevo-draft-edit-alice-p1', '{}');
    localStorage.setItem('pevo-draft-publish:alice', '{}');
    localStorage.setItem('pevo-draft-edit:alice:alice:p1', '{}');
    localStorage.setItem('pevo_session', '{}');

    removeLegacyDrafts();

    expect(Object.keys(localStorage).sort()).toEqual([
      'pevo-draft-edit:alice:alice:p1',
      'pevo-draft-publish:alice',
      'pevo_session',
    ]);
  });

  it("removes one account's drafts and leaves an account whose name extends it alone", () => {
    localStorage.setItem('pevo-draft-publish:bob', '{}');
    localStorage.setItem('pevo-draft-edit:bob:alice:p1', '{}');
    localStorage.setItem('pevo-draft-publish:bobby', '{}');
    localStorage.setItem('pevo-draft-edit:bobby:alice:p1', '{}');
    localStorage.setItem('pevo-draft-edit:alice:bob:p1', '{}');

    removeAccountDrafts('bob');

    expect(Object.keys(localStorage).sort()).toEqual([
      'pevo-draft-edit:alice:bob:p1',
      'pevo-draft-edit:bobby:alice:p1',
      'pevo-draft-publish:bobby',
    ]);
  });

  it('reads a stored entry, and removes one that does not parse to an object', () => {
    localStorage.setItem('k', JSON.stringify({ title: 't' }));
    expect(readDraftEntry('k')).toEqual({ title: 't' });
    expect(readDraftEntry('missing')).toBe(null);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const raw of ['{not json', '"a string"', '[1,2]', 'null']) {
      localStorage.setItem('k', raw);
      expect(readDraftEntry('k')).toBe(null);
      expect(localStorage.getItem('k')).toBe(null);
    }
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it('treats an entry as restorable text only when its title is a string', () => {
    expect(draftHasText({ title: '' })).toBe(true);
    expect(draftHasText({ attempt: { at: 1 } })).toBe(false);
    expect(draftHasText(null)).toBe(false);
  });

  describe('composeDraftEntry', () => {
    const fields = { title: 'T', body: 'B' };

    it('stores the text with the time it changed and, when given, the head marker', () => {
      expect(composeDraftEntry(null, fields, { atBaseline: false, now: 5, headMarker: 'a/p/1/9' }))
        .toEqual({ title: 'T', body: 'B', savedAt: 5, head_marker: 'a/p/1/9' });
      expect(composeDraftEntry(null, fields, { atBaseline: false, now: 5 }))
        .toEqual({ title: 'T', body: 'B', savedAt: 5 });
    });

    it('keeps the time when the text is unchanged, and moves only the marker', () => {
      const stored = { title: 'T', body: 'B', savedAt: 1, head_marker: 'a/p/1/8' };
      expect(composeDraftEntry(stored, fields, { atBaseline: false, now: 5, headMarker: 'a/p/1/9' }))
        .toEqual({ title: 'T', body: 'B', savedAt: 1, head_marker: 'a/p/1/9' });
      expect(composeDraftEntry(stored, { ...fields, body: 'B2' }, { atBaseline: false, now: 5, headMarker: 'a/p/1/9' }))
        .toEqual({ title: 'T', body: 'B2', savedAt: 5, head_marker: 'a/p/1/9' });
    });

    it('drops the text and its bookkeeping at the baseline, keeping any other state', () => {
      const stored = { title: 'T', body: 'B', savedAt: 1, head_marker: 'a/p/1/8', attempt: { at: 3 } };
      expect(composeDraftEntry(stored, fields, { atBaseline: true, now: 5, headMarker: 'a/p/1/9' }))
        .toEqual({ attempt: { at: 3 } });
      expect(composeDraftEntry({ title: 'T', savedAt: 1 }, fields, { atBaseline: true, now: 5 })).toBe(null);
      expect(composeDraftEntry(null, fields, { atBaseline: true, now: 5 })).toBe(null);
    });

    it('carries other state through a text write', () => {
      const stored = { title: 'old', savedAt: 1, attempt: { at: 3 } };
      expect(composeDraftEntry(stored, fields, { atBaseline: false, now: 5 }))
        .toEqual({ attempt: { at: 3 }, title: 'T', body: 'B', savedAt: 5 });
    });
  });

  it('compares fields against a snapshot by value', () => {
    const snapshot = snapshotFields({ title: 'T', rows: [{ a: 1 }] });
    expect(fieldsMatchSnapshot({ title: 'T', rows: [{ a: 1 }] }, snapshot)).toBe(true);
    expect(fieldsMatchSnapshot({ title: 'T', rows: [] }, snapshot)).toBe(false);
  });

  describe('headMarkerOf', () => {
    const versions = [
      { version_number: 1, block_num: 100 },
      { version_number: 2, block_num: 140 },
    ];

    it('is the head pair, the version count and the newest block', () => {
      expect(headMarkerOf({ author: 'alice', permlink: 'p1', head_author: 'bob', head_permlink: 'p2', versions }))
        .toBe('bob/p2/2/140');
    });

    it('is null for the one-entry stub a failed or empty replay leaves', () => {
      expect(headMarkerOf({ author: 'alice', permlink: 'p1', head_author: 'alice', head_permlink: 'p1', versions: [{ version_number: 1, block_num: 0 }] }))
        .toBe(null);
    });

    it("takes the payload's own marker whenever the payload carries one, null included", () => {
      expect(headMarkerOf({ head_marker: 'x/y/3/7', versions })).toBe('x/y/3/7');
      expect(headMarkerOf({ head_marker: null, author: 'alice', permlink: 'p1', versions })).toBe(null);
    });
  });
});

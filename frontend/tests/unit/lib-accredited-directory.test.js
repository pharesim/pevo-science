import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/api.js', () => ({
  fetchAccreditations: vi.fn(),
}));

import { fetchAccreditations } from '../../src/api.js';
import {
  loadAccreditedDirectory,
  lookupAccredited,
  filterAccreditedByPrefix,
  _resetAccreditedDirectoryForTests,
} from '../../src/lib/accredited-directory.js';

beforeEach(() => {
  _resetAccreditedDirectoryForTests();
  fetchAccreditations.mockReset();
});

describe('lookupAccredited', () => {
  const directory = {
    alice: { username: 'alice', orcid: '0000-0001-1111-1111', name: 'Alice' },
    bob: { username: 'bob', orcid: '0000-0002-2222-2222', name: 'Bob' },
  };

  it('returns the row for a matching username', () => {
    expect(lookupAccredited(directory, 'alice')).toEqual(directory.alice);
  });

  it('normalizes whitespace, case, and a leading @', () => {
    expect(lookupAccredited(directory, '  ALICE  ')).toEqual(directory.alice);
    expect(lookupAccredited(directory, '@alice')).toEqual(directory.alice);
    expect(lookupAccredited(directory, '@ALICE')).toEqual(directory.alice);
  });

  it('returns null on miss, empty, null, or undefined input', () => {
    expect(lookupAccredited(directory, 'carol')).toBeNull();
    expect(lookupAccredited(directory, '')).toBeNull();
    expect(lookupAccredited(directory, null)).toBeNull();
    expect(lookupAccredited(directory, undefined)).toBeNull();
  });

  it('returns null when the directory itself is null or empty', () => {
    expect(lookupAccredited(null, 'alice')).toBeNull();
    expect(lookupAccredited({}, 'alice')).toBeNull();
  });
});

describe('filterAccreditedByPrefix', () => {
  const directory = {
    alice: { username: 'alice' },
    alicia: { username: 'alicia' },
    bob: { username: 'bob' },
    alfred: { username: 'alfred' },
  };

  it('returns rows whose username starts with the prefix', () => {
    const matches = filterAccreditedByPrefix(directory, 'al');
    expect(matches.map((m) => m.username).sort()).toEqual(['alfred', 'alice', 'alicia']);
  });

  it('normalizes the prefix (trim, lowercase, strip @)', () => {
    expect(filterAccreditedByPrefix(directory, '  AL  ').length).toBe(3);
    expect(filterAccreditedByPrefix(directory, '@alic').length).toBe(2);
  });

  it('caps results at the max parameter', () => {
    const matches = filterAccreditedByPrefix(directory, 'a', 2);
    expect(matches.length).toBe(2);
  });

  it('returns [] for empty/missing prefix or directory', () => {
    expect(filterAccreditedByPrefix(directory, '')).toEqual([]);
    expect(filterAccreditedByPrefix(directory, null)).toEqual([]);
    expect(filterAccreditedByPrefix(null, 'al')).toEqual([]);
  });
});

describe('loadAccreditedDirectory', () => {
  it('builds a username-keyed map from the API response', async () => {
    fetchAccreditations.mockResolvedValue({
      data: [
        { username: 'alice', orcid: '0000-0001-1111-1111', name: 'Alice' },
        { username: 'bob', orcid: '0000-0002-2222-2222', name: 'Bob' },
      ],
    });
    const dir = await loadAccreditedDirectory();
    expect(dir.alice.orcid).toBe('0000-0001-1111-1111');
    expect(dir.bob.name).toBe('Bob');
    expect(fetchAccreditations).toHaveBeenCalledTimes(1);
  });

  it('caches across calls (single network request)', async () => {
    fetchAccreditations.mockResolvedValue({ data: [{ username: 'alice', orcid: 'x', name: 'A' }] });
    await loadAccreditedDirectory();
    await loadAccreditedDirectory();
    await loadAccreditedDirectory();
    expect(fetchAccreditations).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent calls into a single in-flight request', async () => {
    let resolveFn;
    fetchAccreditations.mockReturnValue(new Promise((r) => { resolveFn = r; }));
    const a = loadAccreditedDirectory();
    const b = loadAccreditedDirectory();
    const c = loadAccreditedDirectory();
    resolveFn({ data: [{ username: 'alice', orcid: 'x', name: 'A' }] });
    await Promise.all([a, b, c]);
    expect(fetchAccreditations).toHaveBeenCalledTimes(1);
  });

  it('returns {} on fetch failure without throwing', async () => {
    fetchAccreditations.mockRejectedValue(new Error('network down'));
    const dir = await loadAccreditedDirectory();
    expect(dir).toEqual({});
  });

  it('skips rows without a username', async () => {
    fetchAccreditations.mockResolvedValue({
      data: [
        { username: 'alice', orcid: 'x', name: 'A' },
        { orcid: 'y', name: 'No Username' },
        { username: '', orcid: 'z', name: 'Empty' },
      ],
    });
    const dir = await loadAccreditedDirectory();
    expect(Object.keys(dir)).toEqual(['alice']);
  });

  it('handles empty data gracefully', async () => {
    fetchAccreditations.mockResolvedValue({ data: [] });
    const dir = await loadAccreditedDirectory();
    expect(dir).toEqual({});
  });
});

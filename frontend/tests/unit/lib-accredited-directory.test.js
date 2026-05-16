// CARVE-OUT JUSTIFICATION (root CLAUDE.md "Carve-out for deterministic
// edge-case coverage", clauses a/b/c):
//
// (a) Impractical real path: `loadAccreditedDirectory` calls
//     `fetchAccreditations` against the backend, which reads HAF's live
//     accreditation set. The directory's row shape, presence/absence of
//     `orcid` fields, and concurrent-rejection failure modes are
//     deterministically expressible only by mocking `fetchAccreditations`.
//     A real-path test would (1) require seeding then revoking
//     accreditation records mid-test, and (2) couple every assertion to
//     whatever the live HAF set happens to contain, breaking the
//     normalization, malformed-row, and rejection-coalescing assertions
//     this file pins.
// (b) No auth/permission middleware is mocked. `fetchAccreditations` calls
//     a public `GET /api/accreditations` route with no auth header; there
//     is no `verifyHiveSignature` boundary to bypass.
// (c) Real-path companion: the integrated
//     `fetchAccreditations → loadAccreditedDirectory → publish-form-prefill`
//     flow is exercised at the Playwright E2E layer by
//     `frontend/tests/e2e/publish.spec.ts` (paper-publish flow), which
//     hits the real backend and verifies the published `authors[]` row's
//     ORCID matches the accredited identity. The follow-up task
//     `agents/docs/tasks/pending/ui-e2e-coauthor-accredited-prefill.md`
//     extends that coverage with a multi-co-author + accreditation-revoke
//     scenario to pin the transition-out semantic this file mocks.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/api.js', () => ({
  fetchAccreditations: vi.fn(),
}));

import { fetchAccreditations } from '../../src/api.js';
import {
  loadAccreditedDirectory,
  lookupAccredited,
  applyHiveChangePrefill,
  applyAccreditedPrefill,
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

  // The catch block in loadAccreditedDirectory intentionally does NOT cache
  // on rejection — a transient failure must be recoverable on the next call.
  // Pin that semantic: after a rejection resolves, a subsequent call
  // re-issues `fetchAccreditations` (it does not stick at the empty result).
  it('refetches on the next call after a rejection (no negative caching)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchAccreditations.mockRejectedValueOnce(new Error('network down'));
    const firstDir = await loadAccreditedDirectory();
    expect(firstDir).toEqual({});
    expect(fetchAccreditations).toHaveBeenCalledTimes(1);

    fetchAccreditations.mockResolvedValueOnce({
      data: [{ username: 'alice', orcid: '0000-0001-1111-1111', name: 'Alice' }],
    });
    const secondDir = await loadAccreditedDirectory();
    expect(secondDir.alice.orcid).toBe('0000-0001-1111-1111');
    expect(fetchAccreditations).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
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

  // Held re-review item 8: rejection path must also coalesce concurrent
  // callers — none of the three concurrent calls should throw; all three
  // resolve to {}.
  it('coalesces concurrent calls on rejection (no thrown errors, all resolve to {})', async () => {
    let rejectFn;
    fetchAccreditations.mockReturnValue(new Promise((_, reject) => { rejectFn = reject; }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = loadAccreditedDirectory();
    const b = loadAccreditedDirectory();
    const c = loadAccreditedDirectory();
    rejectFn(new Error('network down'));
    const results = await Promise.all([a, b, c]);
    expect(results).toEqual([{}, {}, {}]);
    expect(fetchAccreditations).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  // Held re-review item 9: a malformed accreditation row (no `orcid` field)
  // must NOT cause downstream consumers to blank a user-typed ORCID. The
  // directory still indexes the row by username (so the input still locks),
  // but the row's orcid is undefined.
  it('keeps rows without an orcid field in the directory (orcid is undefined)', async () => {
    fetchAccreditations.mockResolvedValue({
      data: [
        { username: 'alice', name: 'Alice' }, // no orcid field
      ],
    });
    const dir = await loadAccreditedDirectory();
    expect(dir.alice).toBeDefined();
    expect(dir.alice.orcid).toBeUndefined();
    expect(lookupAccredited(dir, 'alice')).toBe(dir.alice);
  });
});

describe('applyHiveChangePrefill', () => {
  const directory = {
    alice: { username: 'alice', orcid: '0000-0001-1111-1111', name: 'Alice' },
    carol: { username: 'carol', name: 'Carol' }, // no orcid field (malformed)
  };

  it('writes orcid from the accreditation when hive is accredited', () => {
    const row = { name: 'A', hive: 'alice', orcid: '', affiliation: '' };
    applyHiveChangePrefill(row, directory);
    expect(row.orcid).toBe('0000-0001-1111-1111');
  });

  it('clears orcid when hive transitions from accredited to non-accredited (item 1)', () => {
    // Simulates: user had hive=alice, orcid prefilled. User now sets
    // hive=bob (not in directory). The row was mutated upstream so
    // row.hive='bob' before this call.
    const row = { name: 'A', hive: 'bob', orcid: '0000-0001-1111-1111', affiliation: '' };
    applyHiveChangePrefill(row, directory);
    expect(row.orcid).toBe('');
  });

  it('clears orcid when hive becomes empty', () => {
    const row = { name: 'A', hive: '', orcid: '0000-0001-1111-1111', affiliation: '' };
    applyHiveChangePrefill(row, directory);
    expect(row.orcid).toBe('');
  });

  it('leaves existing orcid alone when accredited row has no orcid field (item 9 semantic)', () => {
    // hive=carol is in the directory but carol's row has no orcid. We must
    // NOT blank the value — the field locks (isCoAuthorAccredited returns
    // true upstream) but whatever value sits in the row is preserved.
    const row = { name: 'A', hive: 'carol', orcid: '0000-0002-9999-9999', affiliation: '' };
    applyHiveChangePrefill(row, directory);
    expect(row.orcid).toBe('0000-0002-9999-9999');
  });

  it('is a no-op on null/undefined row', () => {
    expect(() => applyHiveChangePrefill(null, directory)).not.toThrow();
    expect(() => applyHiveChangePrefill(undefined, directory)).not.toThrow();
  });

  it('handles missing directory (treats as non-accredited, clears orcid)', () => {
    const row = { name: 'A', hive: 'alice', orcid: 'stale', affiliation: '' };
    applyHiveChangePrefill(row, null);
    expect(row.orcid).toBe('');
  });
});

describe('applyAccreditedPrefill', () => {
  const directory = {
    alice: { username: 'alice', orcid: '0000-0001-1111-1111', name: 'Alice' },
    bob: { username: 'bob', orcid: '0000-0002-2222-2222', name: 'Bob' },
    carol: { username: 'carol', name: 'Carol' }, // no orcid field
  };

  it('prefills ORCID for accredited rows with blank orcid', () => {
    const rows = [
      { name: 'A', hive: 'alice', orcid: '', affiliation: '' },
      { name: 'B', hive: 'bob', orcid: '', affiliation: '' },
    ];
    applyAccreditedPrefill(rows, directory);
    expect(rows[0].orcid).toBe('0000-0001-1111-1111');
    expect(rows[1].orcid).toBe('0000-0002-2222-2222');
  });

  it('preserves user-typed ORCID even when hive is accredited (item 2)', () => {
    // User typed an ORCID before the directory resolved. Reapplication
    // must NOT clobber it.
    const rows = [
      { name: 'A', hive: 'alice', orcid: '0000-9999-9999-9999', affiliation: '' },
    ];
    applyAccreditedPrefill(rows, directory);
    expect(rows[0].orcid).toBe('0000-9999-9999-9999');
  });

  it('leaves non-accredited rows alone', () => {
    const rows = [
      { name: 'X', hive: 'mallory', orcid: 'user-typed', affiliation: '' },
      { name: 'Y', hive: '', orcid: '', affiliation: '' },
    ];
    applyAccreditedPrefill(rows, directory);
    expect(rows[0].orcid).toBe('user-typed');
    expect(rows[1].orcid).toBe('');
  });

  it('skips accredited rows whose directory entry has no orcid (item 9)', () => {
    const rows = [
      { name: 'C', hive: 'carol', orcid: '', affiliation: '' },
    ];
    applyAccreditedPrefill(rows, directory);
    // No blank-to-blank writeback, but more importantly: must not blow up.
    expect(rows[0].orcid).toBe('');
  });

  it('is a no-op on non-array rows', () => {
    expect(() => applyAccreditedPrefill(null, directory)).not.toThrow();
    expect(() => applyAccreditedPrefill(undefined, directory)).not.toThrow();
    expect(() => applyAccreditedPrefill('not an array', directory)).not.toThrow();
  });

  it('skips null/undefined entries within the array', () => {
    const rows = [
      null,
      { name: 'A', hive: 'alice', orcid: '', affiliation: '' },
      undefined,
    ];
    expect(() => applyAccreditedPrefill(rows, directory)).not.toThrow();
    expect(rows[1].orcid).toBe('0000-0001-1111-1111');
  });
});

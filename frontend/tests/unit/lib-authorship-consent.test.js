import { describe, it, expect, vi, beforeEach } from 'vitest';

// withAuthorshipFreshAuth orchestrates the authorship consent/credit fresh-auth
// flow (Routes 2 & 3). The HTTP mint lives in api.js and the ORCID redirect +
// target-bound proof cache live in fresh-auth.js (both covered in their own
// suites). Mock those so these tests assert the orchestration: custody routing,
// per-target cache lookup, factor selection, password re-prompt, ORCID redirect,
// the 401 re-mint+retry, and the freshAuthFailed outcomes. Sibling of
// lib-settings-fresh-auth.test.js (the same shell, keyed on a paper target).
//
// Mocking justification (project-CLAUDE.md carve-out, clause-a/b): the mocked
// modules are mint transport + cache, not auth-verification paths; the proof's
// cryptographic binding is verified server-side (backend integration tests).
const mockMintAuthorshipFreshAuthProof = vi.fn();
vi.mock('../../src/api.js', () => ({
  mintAuthorshipFreshAuthProof: (...a) => mockMintAuthorshipFreshAuthProof(...a),
  // The real fresh-auth.js (loaded via importActual below) imports these at
  // module load; stub them so the import resolves. Never called from here.
  startOrcid: vi.fn(),
  consentOpRequestFields: vi.fn(),
}));

// signer.js is a module-load dependency of the real fresh-auth.js; mock it so the
// partial mock below loads the real module without pulling real broadcast I/O.
vi.mock('../../src/signer.js', () => ({ broadcastOps: vi.fn() }));

const mockGetCachedConsentOpProof = vi.fn();
const mockClearCachedConsentOpProof = vi.fn();
const mockBeginAuthorshipOrcid = vi.fn();
// Partial mock: keep the REAL shared password-factor helper, outcome sentinels,
// and REMINTABLE_REASONS so the orchestrator exercises the real
// mintViaPasswordFactor and compares against the real sentinel symbols (a
// re-stubbed Symbol would never be === the helper's return). Mock only the
// cache and the ORCID redirect.
vi.mock('../../src/lib/fresh-auth.js', async (importActual) => ({
  ...(await importActual()),
  getCachedConsentOpProof: (...a) => mockGetCachedConsentOpProof(...a),
  clearCachedConsentOpProof: (...a) => mockClearCachedConsentOpProof(...a),
  beginAuthorshipOrcidFreshAuth: (...a) => mockBeginAuthorshipOrcid(...a),
}));

const reauthRequest = vi.fn();
const authDisconnect = vi.fn();
const toastShow = vi.fn();
vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name) => {
      if (name === 'reauthModal') return { request: (...a) => reauthRequest(...a) };
      if (name === 'auth') return { disconnect: (...a) => authDisconnect(...a) };
      if (name === 'toast') return { show: (...a) => toastShow(...a) };
      if (name === 'i18n') return { messages: null };
      return null;
    }),
  },
}));

import { withAuthorshipFreshAuth } from '../../src/lib/authorship-consent.js';

// Mirrors the signer.js broadcastOps error shape consumed by the orchestrator:
// a `code` (FRESH_AUTH_REQUIRED) plus `details.reason`. The retry gate keys on
// details.reason, never on a fabricated status.
const codedError = (code, reason) =>
  Object.assign(new Error(code), { code, details: reason ? { reason } : undefined });

// An approve target binds the richest set (paper + slot + claimer).
const TARGET = { action: 'approve_authorship', rootAuthor: 'alice', rootPermlink: 'perm', authorIndex: 2, claimer: 'bob' };
const LIGHT = { custody: 'light', username: 'carol', hasPassword: true };
const LIGHT_NOPW = { custody: 'light', username: 'carol', hasPassword: false };

describe('withAuthorshipFreshAuth', () => {
  let run;
  beforeEach(() => {
    mockMintAuthorshipFreshAuthProof.mockReset();
    mockGetCachedConsentOpProof.mockReset();
    mockClearCachedConsentOpProof.mockReset();
    mockBeginAuthorshipOrcid.mockReset();
    reauthRequest.mockReset();
    authDisconnect.mockReset();
    toastShow.mockReset();
    mockGetCachedConsentOpProof.mockReturnValue(null);
    reauthRequest.mockResolvedValue('hunter2');
    mockMintAuthorshipFreshAuthProof.mockResolvedValue('minted-proof');
    mockBeginAuthorshipOrcid.mockResolvedValue(null); // redirect-pending sentinel
    run = vi.fn().mockResolvedValue({ tx_id: 'tx1' });
  });

  it('self-custody calls run with no proof and mints nothing', async () => {
    const out = await withAuthorshipFreshAuth(TARGET, { custody: 'self', username: 'carol' }, run);
    expect(out).toEqual({ ok: { tx_id: 'tx1' } });
    expect(run).toHaveBeenCalledWith(undefined);
    expect(mockGetCachedConsentOpProof).not.toHaveBeenCalled();
    expect(mockMintAuthorshipFreshAuthProof).not.toHaveBeenCalled();
  });

  it('light account looks up the cache keyed on the FULL target', async () => {
    mockGetCachedConsentOpProof.mockReturnValue('cached-proof');
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(mockGetCachedConsentOpProof).toHaveBeenCalledWith('approve_authorship', 'alice', 'perm', 2, 'bob');
    expect(run).toHaveBeenCalledWith('cached-proof');
    expect(out).toEqual({ ok: { tx_id: 'tx1' } });
    // Single-use proof: cache cleared after a successful run.
    expect(mockClearCachedConsentOpProof).toHaveBeenCalled();
  });

  it('password factor: cache miss + hasPassword → prompt, mint, run(minted)', async () => {
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(reauthRequest).toHaveBeenCalled();
    expect(mockMintAuthorshipFreshAuthProof).toHaveBeenCalledWith(TARGET, 'hunter2');
    expect(run).toHaveBeenCalledWith('minted-proof');
    expect(out).toEqual({ ok: { tx_id: 'tx1' } });
    expect(mockBeginAuthorshipOrcid).not.toHaveBeenCalled();
  });

  it('ORCID factor: cache miss + no password → redirect (no password prompt)', async () => {
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT_NOPW, run);
    expect(reauthRequest).not.toHaveBeenCalled();
    expect(mockBeginAuthorshipOrcid).toHaveBeenCalledWith(TARGET);
    expect(out).toEqual({ redirect: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('password modal dismissed → { cancelled }, no broadcast', async () => {
    reauthRequest.mockResolvedValue(null);
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ cancelled: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('401 re-mintable (password factor) → re-mint and retry once → ok', async () => {
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'))
      .mockResolvedValueOnce({ tx_id: 'tx2' });
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ ok: { tx_id: 'tx2' } });
    expect(mockMintAuthorshipFreshAuthProof).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('401 re-mintable (ORCID factor, no password) → freshAuthFailed, no inline re-OAuth', async () => {
    // First call resolves a cached proof so we reach run(); run then 401s.
    mockGetCachedConsentOpProof.mockReturnValueOnce('cached-proof');
    run.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'));
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT_NOPW, run);
    expect(out).toEqual({ freshAuthFailed: true });
    // No second full-page ORCID redirect attempted inline.
    expect(mockBeginAuthorshipOrcid).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('403 target_mismatch → freshAuthFailed (not fixable by re-mint)', async () => {
    mockGetCachedConsentOpProof.mockReturnValue('cached-proof');
    run.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'target_mismatch'));
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ freshAuthFailed: true });
  });

  it('403 username_mismatch → tears down the session and surfaces sessionInconsistent', async () => {
    // Corrupted session: the JWT subject and the proof subject diverge. Matches
    // broadcastWithFreshAuth's session-kind handling — disconnect + re-login
    // toast — rather than the retryable freshAuthFailed "try again" outcome.
    mockGetCachedConsentOpProof.mockReturnValue('cached-proof');
    run.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'username_mismatch'));
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ sessionInconsistent: true });
    expect(authDisconnect).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it('non-fresh-auth errors propagate to the caller', async () => {
    mockGetCachedConsentOpProof.mockReturnValue('cached-proof');
    run.mockRejectedValueOnce(codedError('FORBIDDEN'));
    await expect(withAuthorshipFreshAuth(TARGET, LIGHT, run)).rejects.toThrow('FORBIDDEN');
  });
});

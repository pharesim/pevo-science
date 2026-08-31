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
const mockFetchEmailStatus = vi.fn();
vi.mock('../../src/api.js', () => ({
  mintAuthorshipFreshAuthProof: (...a) => mockMintAuthorshipFreshAuthProof(...a),
  // Factor selection runs through the REAL shared resolver (importActual below),
  // which reads the account status. This mock is what the resolver sees.
  fetchEmailStatus: (...a) => mockFetchEmailStatus(...a),
  // The real fresh-auth.js (loaded via importActual below) imports these at
  // module load; stub them so the import resolves. Never called from here.
  startOrcid: vi.fn(),
  consentOpRequestFields: vi.fn(),
  mintSessionAuthProof: vi.fn(),
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
      // `username` matches the LIGHT ctx below so the shared resolver's
      // username-keyed memo branches are live in this suite; without it the
      // memo is never read or written and the retry-gate reuse is untestable.
      if (name === 'auth') return { disconnect: (...a) => authDisconnect(...a), username: 'carol' };
      if (name === 'toast') return { show: (...a) => toastShow(...a) };
      if (name === 'i18n') return { messages: null };
      return null;
    }),
  },
}));

import { withAuthorshipFreshAuth } from '../../src/lib/authorship-consent.js';
import { clearPasswordFactorMemo } from '../../src/lib/fresh-auth.js';
import { REAUTH_PROMPT_BUSY } from '../../src/components/reauth-modal.js';

// Mirrors the signer.js broadcastOps error shape consumed by the orchestrator:
// a `code` (FRESH_AUTH_REQUIRED) plus `details.reason`. The retry gate keys on
// details.reason, never on a fabricated status.
const codedError = (code, reason) =>
  Object.assign(new Error(code), { code, details: reason ? { reason } : undefined });

// An approve target binds the richest set (paper + slot + claimer).
const TARGET = { action: 'approve_authorship', rootAuthor: 'alice', rootPermlink: 'perm', authorIndex: 2, claimer: 'bob' };
// The ctx carries no factor hint any more: the orchestrator resolves
// password-vs-ORCID through the shared resolver, so the account status is the
// only thing that moves it. These helpers set what the resolver sees.
const LIGHT = { custody: 'light', username: 'carol' };
const passwordless = () =>
  mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
const statusUnavailable = () => mockFetchEmailStatus.mockRejectedValue(new Error('Failed to fetch'));

describe('withAuthorshipFreshAuth', () => {
  let run;
  beforeEach(() => {
    mockMintAuthorshipFreshAuthProof.mockReset();
    mockFetchEmailStatus.mockReset();
    // The resolver memoizes a positive answer per username for the tab; drop it
    // so one test's password-holder cannot decide the next test's factor.
    clearPasswordFactorMemo();
    mockGetCachedConsentOpProof.mockReset();
    mockClearCachedConsentOpProof.mockReset();
    mockBeginAuthorshipOrcid.mockReset();
    reauthRequest.mockReset();
    authDisconnect.mockReset();
    toastShow.mockReset();
    mockGetCachedConsentOpProof.mockReturnValue(null);
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
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
    passwordless();
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
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
    passwordless();
    mockGetCachedConsentOpProof.mockReturnValueOnce('cached-proof');
    run.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'));
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
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

  it('an unavailable account status prompts for a password instead of redirecting', async () => {
    // The failure direction the shared resolver enforces, on the surface where
    // it costs the most: a full-page ORCID navigation from a paper page throws
    // away the reader's scroll position, open modals, and in-flight state. A
    // transient status failure must not be what triggers it.
    statusUnavailable();
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ ok: { tx_id: 'tx1' } });
    expect(reauthRequest).toHaveBeenCalledTimes(1);
    expect(mockBeginAuthorshipOrcid).not.toHaveBeenCalled();
  });

  it('an unavailable status on the 401 retry gate retries inline instead of dead-ending', async () => {
    // The retry gate reads the same resolver as the initial mint, so the two
    // cannot disagree about which factor this account has.
    statusUnavailable();
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'))
      .mockResolvedValueOnce({ tx_id: 'tx2' });
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ ok: { tx_id: 'tx2' } });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('the 401 retry gate reuses the memoized factor instead of a second status read', async () => {
    // The initial gate observed hasPassword true and memoized it; the retry
    // gate must ride that memo rather than spending the rate-limited status
    // budget again mid-op.
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'))
      .mockResolvedValueOnce({ tx_id: 'tx2' });
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ ok: { tx_id: 'tx2' } });
    expect(run).toHaveBeenCalledTimes(2);
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(1);
  });

  it('an assumed password the backend rejects at the mint falls back to the ORCID redirect', async () => {
    // With the status unavailable the password factor is a guess, and the
    // mint's 401 is the first hard evidence the account has no password. A
    // second prompt would dead-end every consent op for exactly the accounts
    // whose only registered factor is ORCID; one prompt, then the round-trip.
    statusUnavailable();
    mockMintAuthorshipFreshAuthProof.mockRejectedValue(
      Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' }),
    );
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ redirect: true });
    expect(reauthRequest).toHaveBeenCalledTimes(1);
    expect(mockBeginAuthorshipOrcid).toHaveBeenCalledWith(TARGET);
    expect(run).not.toHaveBeenCalled();
  });

  it('an observed password that 401s still re-prompts instead of redirecting', async () => {
    // The escape hatch is for guesses only: an observed password's 401 is a
    // typo and earns the second prompt.
    mockMintAuthorshipFreshAuthProof
      .mockRejectedValueOnce(Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' }))
      .mockResolvedValueOnce('proof-ok');
    reauthRequest.mockResolvedValueOnce('wrong').mockResolvedValueOnce('right');
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ ok: { tx_id: 'tx1' } });
    expect(reauthRequest).toHaveBeenCalledTimes(2);
    expect(mockBeginAuthorshipOrcid).not.toHaveBeenCalled();
  });

  it('non-fresh-auth errors propagate to the caller', async () => {
    mockGetCachedConsentOpProof.mockReturnValue('cached-proof');
    run.mockRejectedValueOnce(codedError('FORBIDDEN'));
    await expect(withAuthorshipFreshAuth(TARGET, LIGHT, run)).rejects.toThrow('FORBIDDEN');
  });

  // ─── Refuse-while-open (busy) discriminates from a cancel ────────────────
  //
  // The reauth modal is a singleton, and a vote and an authorship action on
  // the same paper page can collide on it. The refused action unwinds through
  // the same { cancelled } outcome a cancel takes — the busy toast is the
  // whole difference, and without these cases the busy branches are deletable
  // with every suite still green.

  it('a prompt owned by another action unwinds as { cancelled } WITH the busy toast', async () => {
    reauthRequest.mockResolvedValue(REAUTH_PROMPT_BUSY);
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ cancelled: true });
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledWith(expect.any(String), 'error');
    expect(mockMintAuthorshipFreshAuthProof).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('a plain cancel unwinds with NO toast, so busy and cancel stay distinguishable', async () => {
    reauthRequest.mockResolvedValue(null);
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ cancelled: true });
    expect(toastShow).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('a busy refusal at the 401 retry gate also toasts instead of dropping silently', async () => {
    // The retry gate is a separately deletable branch from the initial one.
    run.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'));
    reauthRequest
      .mockResolvedValueOnce('hunter2')
      .mockResolvedValueOnce(REAUTH_PROMPT_BUSY);
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ cancelled: true });
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

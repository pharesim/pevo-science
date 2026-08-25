// Tests for `broadcastWithFreshAuth` error-recovery paths in
// `frontend/src/lib/fresh-auth.js`.
//
// Mocking justification (clause-a of project-CLAUDE.md
// "Carve-out for deterministic edge-case coverage"):
// `signer.js#broadcastOps` performs real fetch() against the backend
// `/api/custody/broadcast` endpoint. Exercising the real path per-test
// would require a running backend + Hive + ORCID stack and the ability
// to induce specific FRESH_AUTH_REQUIRED status/reason combinations
// (401 missing/expired/malformed; 403 username_mismatch). That setup is
// the E2E suite's domain (`non-consent-fresh-auth.spec.js`). Here we
// mock signer.broadcastOps so we can deterministically trigger each
// error shape and assert the wrapper's branching: dropping the dead
// window, re-authing, retrying, disconnecting, toasting.
//
// Auth-focus carve-out (clause-b): broadcastWithFreshAuth is not an
// auth-verification path itself — it consumes window proofs minted
// upstream and reacts to backend rejections. Cryptographic verification
// is performed server-side. No frontend auth middleware is mocked.
//
// Clause-c real-path companion: the E2E spec at
// `frontend/tests/e2e/non-consent-fresh-auth.spec.js` exercises
// broadcastWithFreshAuth against the real backend for the happy path
// and the window-reuse path.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockBroadcastOps = vi.fn();
const mockStartOrcid = vi.fn();
const mockFetchEmailStatus = vi.fn();
const mockMintSessionAuthProof = vi.fn();
const mockAuthStore = {
  custody: 'light', username: 'alice', token: 'jwt-abc', disconnect: vi.fn(),
};
const mockToastStore = { show: vi.fn() };
const mockReauthModal = { request: vi.fn() };
// Distinct sentinel so the localized-vs-fallback discrimination is real: if a
// future regression breaks the i18n lookup chain (typo in
// `messages?.auth?.sessionInconsistency`, key snake-case drift, etc.) the
// fallback English string fires instead of the sentinel and this test fails.
// Using the same English string in both the mock and the fallback would make
// such a regression invisible.
const LOCALIZED_SENTINEL = 'LOCALIZED-i18n-bundle-source-sentinel';
const FALLBACK_ENGLISH = 'Session inconsistency detected. Please sign in again.';
const REAUTH_FAILED_SENTINEL = 'LOCALIZED-reauth-failed-sentinel';
const mockI18nStore = {
  messages: {
    auth: { sessionInconsistency: LOCALIZED_SENTINEL },
    settings: { reauthFailed: REAUTH_FAILED_SENTINEL },
  },
};
const mockRouterStore = {};

vi.mock('../../src/signer.js', () => ({
  broadcastOps: (...args) => mockBroadcastOps(...args),
}));

vi.mock('../../src/api.js', () => ({
  startOrcid: (...args) => mockStartOrcid(...args),
  consentOpRequestFields: (t) => t,
  fetchEmailStatus: (...args) => mockFetchEmailStatus(...args),
  mintSessionAuthProof: (...args) => mockMintSessionAuthProof(...args),
}));

vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name) => {
      if (name === 'auth') return mockAuthStore;
      if (name === 'toast') return mockToastStore;
      if (name === 'i18n') return mockI18nStore;
      if (name === 'router') return mockRouterStore;
      if (name === 'reauthModal') return mockReauthModal;
      return {};
    }),
  },
}));

const { broadcastWithFreshAuth, FRESH_AUTH_REDIRECT_PENDING } =
  await import('../../src/lib/fresh-auth.js');

const PROOF_KEY = 'pevo_fresh_auth_session_proof';

// Seed a live window in the cache: an idle deadline a minute out and an
// absolute cap an hour out, matching the shape the issuance responses produce.
function setWindow(token, { idleMs = 60_000, absoluteMs = 3_600_000 } = {}) {
  sessionStorage.setItem(PROOF_KEY, JSON.stringify({
    token,
    expiresAt: new Date(Date.now() + idleMs).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + absoluteMs).toISOString(),
    idlePeriodMs: idleMs,
  }));
}

function issuance(token) {
  return {
    fresh_auth_proof: token,
    expires_at: new Date(Date.now() + 900_000).toISOString(),
    absolute_expires_at: new Date(Date.now() + 7_200_000).toISOString(),
    mechanism: 'password',
  };
}

function freshAuthError(status, reason) {
  return Object.assign(new Error('FRESH_AUTH_REQUIRED'), {
    status, code: 'FRESH_AUTH_REQUIRED', details: { reason },
  });
}

describe('broadcastWithFreshAuth — error-recovery paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.custody = 'light';
    mockAuthStore.username = 'alice';
    sessionStorage.clear();
    // Password factor by default; the reauth modal returns a password and the
    // mint succeeds, so re-auth is inline and observable.
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    mockReauthModal.request.mockResolvedValue('hunter2');
    mockMintSessionAuthProof.mockImplementation(async () => issuance('second-proof'));
  });

  it('401 expired → drops the dead window, re-auths, retries the broadcast', async () => {
    setWindow('first-proof');
    mockBroadcastOps
      .mockRejectedValueOnce(freshAuthError(401, 'expired'))
      .mockResolvedValueOnce({ tx_id: 't1', block_num: 42 });

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

    expect(result).toEqual({ tx_id: 't1', block_num: 42 });
    expect(mockBroadcastOps).toHaveBeenCalledTimes(2);
    // First attempt used the stale window; the second used the re-authed one.
    expect(mockBroadcastOps.mock.calls[0][2]).toMatchObject({ freshAuthProof: 'first-proof' });
    expect(mockBroadcastOps.mock.calls[1][2]).toMatchObject({ freshAuthProof: 'second-proof' });
    // A closed window is a real re-auth act, not a silent re-mint: the user was
    // prompted rather than the client quietly minting behind their back.
    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
    // The password factor never navigates.
    expect(mockStartOrcid).not.toHaveBeenCalled();
  });

  it('401 missing → re-auths and retries (alternate reason in the contract)', async () => {
    setWindow('stale');
    mockBroadcastOps
      .mockRejectedValueOnce(freshAuthError(401, 'missing'))
      .mockResolvedValueOnce({ tx_id: 't2' });

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);
    expect(result).toEqual({ tx_id: 't2' });
    expect(mockBroadcastOps).toHaveBeenCalledTimes(2);
    expect(mockBroadcastOps.mock.calls[1][2]).toMatchObject({ freshAuthProof: 'second-proof' });
  });

  it('401 malformed → re-auths and retries', async () => {
    setWindow('garbage-proof');
    mockBroadcastOps
      .mockRejectedValueOnce(freshAuthError(401, 'malformed'))
      .mockResolvedValueOnce({ tx_id: 't3' });

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);
    expect(result).toEqual({ tx_id: 't3' });
    expect(mockBroadcastOps).toHaveBeenCalledTimes(2);
  });

  it('401 wrong_mechanism is not re-authable — it rethrows without a retry', async () => {
    setWindow('proof-w');
    mockBroadcastOps.mockRejectedValueOnce(freshAuthError(401, 'wrong_mechanism'));

    await expect(broadcastWithFreshAuth('alice', [['vote', {}]]))
      .rejects.toMatchObject({ code: 'FRESH_AUTH_REQUIRED' });
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(mockReauthModal.request).not.toHaveBeenCalled();
  });

  it('a dismissed re-auth on the retry aborts cleanly with no error toast', async () => {
    setWindow('proof-d');
    mockBroadcastOps.mockRejectedValueOnce(freshAuthError(401, 'expired'));
    mockReauthModal.request.mockResolvedValue(null);

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    // The user chose to stop; nothing failed, so nothing is reported.
    expect(mockToastStore.show).not.toHaveBeenCalled();
  });

  it('a spent re-auth aborts with the re-auth-failed toast, not the op error', async () => {
    // Two wrong passwords: the user has been prompted twice and would otherwise
    // watch the action do nothing at all.
    setWindow('proof-s');
    mockBroadcastOps.mockRejectedValueOnce(freshAuthError(401, 'expired'));
    mockMintSessionAuthProof.mockRejectedValue(
      Object.assign(new Error('bad password'), { code: 'UNAUTHORIZED' }),
    );

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockReauthModal.request).toHaveBeenCalledTimes(2);
    expect(mockToastStore.show).toHaveBeenCalledWith(REAUTH_FAILED_SENTINEL, 'error');
  });

  it('403 username_mismatch → disconnects auth, shows toast, returns null sentinel', async () => {
    setWindow('proof-x');
    mockBroadcastOps.mockRejectedValueOnce(freshAuthError(403, 'username_mismatch'));

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockAuthStore.disconnect).toHaveBeenCalledTimes(1);
    expect(mockToastStore.show).toHaveBeenCalledTimes(1);
    // Asserts the toast came from the i18n bundle (the LOCALIZED_SENTINEL),
    // not from the English fallback at fresh-auth.js's `||` branch. A
    // regression that breaks the i18n lookup would collapse to the fallback
    // and this assertion would fail.
    expect(mockToastStore.show).toHaveBeenCalledWith(LOCALIZED_SENTINEL, 'error');
    // No retry on this branch — broadcastOps called exactly once.
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
  });

  it('403 username_mismatch falls back to raw English when i18n bundle absent', async () => {
    setWindow('proof-x');
    mockBroadcastOps.mockRejectedValueOnce(freshAuthError(403, 'username_mismatch'));

    const saved = mockI18nStore.messages.auth.sessionInconsistency;
    delete mockI18nStore.messages.auth.sessionInconsistency;
    try {
      await broadcastWithFreshAuth('alice', [['vote', {}]]);
      // With the bundle absent the fallback English string fires; this
      // pairs with the LOCALIZED_SENTINEL assertion above to prove the
      // branch discriminates correctly.
      expect(mockToastStore.show).toHaveBeenCalledWith(FALLBACK_ENGLISH, 'error');
    } finally {
      mockI18nStore.messages.auth.sessionInconsistency = saved;
    }
  });

  it('a transport failure during the retry surfaces the contract error shape', async () => {
    // Without the wrap, a network failure during re-auth escapes as a bare
    // TypeError and the call sites' error discriminators misclassify it.
    setWindow('proof-t');
    mockBroadcastOps.mockRejectedValueOnce(freshAuthError(401, 'expired'));
    mockMintSessionAuthProof.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(broadcastWithFreshAuth('alice', [['vote', {}]]))
      .rejects.toMatchObject({ status: 0, code: 'FRESH_AUTH_RETRY_FAILED' });
  });

  it('expired cached window is evicted on read AND triggers re-auth', async () => {
    // Regression coverage for the expiry wire-contract fix (epoch-seconds vs
    // ISO-8601). With a closed window in cache, the read MUST return null AND
    // remove the slot — and broadcastWithFreshAuth MUST re-auth rather than
    // passing the stale token to broadcastOps.
    setWindow('expired-token', { idleMs: -60_000 });
    mockMintSessionAuthProof.mockResolvedValue(issuance('minted'));
    mockBroadcastOps.mockResolvedValueOnce({ tx_id: 't4' });

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

    expect(result).toEqual({ tx_id: 't4' });
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(mockBroadcastOps.mock.calls[0][2]).toMatchObject({ freshAuthProof: 'minted' });
    expect(mockBroadcastOps.mock.calls[0][2].freshAuthProof).not.toBe('expired-token');
  });

  it('non-light custody bypasses acquisition entirely (Keychain users)', async () => {
    mockAuthStore.custody = 'keychain';
    mockBroadcastOps.mockResolvedValueOnce({ tx_id: 'kc' });

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);
    expect(result).toEqual({ tx_id: 'kc' });
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    // No freshAuthProof passed for Keychain — the request-signing IS the proof.
    expect(mockBroadcastOps.mock.calls[0][2]?.freshAuthProof).toBeUndefined();
    expect(mockFetchEmailStatus).not.toHaveBeenCalled();
  });
});

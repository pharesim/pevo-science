// Tests for `broadcastWithFreshAuth` error-recovery paths in
// `frontend/src/lib/fresh-auth.js`.
//
// Mocking justification (round-2 hold-block clause-a, project-CLAUDE.md
// "Carve-out for deterministic edge-case coverage"):
// `signer.js#broadcastOps` performs real fetch() against the backend
// `/api/custody/broadcast` endpoint. Exercising the real path per-test
// would require a running backend + Hive + ORCID stack and the ability
// to induce specific FRESH_AUTH_REQUIRED status/reason combinations
// (401 missing/expired/malformed; 403 username_mismatch). That setup is
// the E2E suite's domain (`non-consent-fresh-auth.spec.js`). Here we
// mock signer.broadcastOps so we can deterministically trigger each
// error shape and assert the wrapper's branching: cache clearing
// between attempts, re-mint, retry, disconnect, toast.
//
// Auth-focus carve-out (clause-b): broadcastWithFreshAuth is not an
// auth-verification path itself — it consumes proofs minted upstream
// and reacts to backend rejections. Cryptographic verification is
// performed server-side. No frontend auth middleware is mocked.
//
// Clause-c real-path companion: the E2E spec at
// `frontend/tests/e2e/non-consent-fresh-auth.spec.js` exercises
// broadcastWithFreshAuth against the real backend for the happy path
// and the cache-reuse path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockBroadcastOps = vi.fn();
const mockStartOrcid = vi.fn();
const mockAuthStore = { custody: 'light', token: 'jwt-abc', disconnect: vi.fn() };
const mockToastStore = { show: vi.fn() };
// Distinct sentinel so the localized-vs-fallback discrimination is real: if a
// future regression breaks the i18n lookup chain (typo in
// `messages?.auth?.sessionInconsistency`, key snake-case drift, etc.) the
// fallback English string fires instead of the sentinel and this test fails.
// Using the same English string in both the mock and the fallback would make
// such a regression invisible.
const LOCALIZED_SENTINEL = 'LOCALIZED-i18n-bundle-source-sentinel';
const FALLBACK_ENGLISH = 'Session inconsistency detected. Please sign in again.';
const mockI18nStore = { messages: { auth: { sessionInconsistency: LOCALIZED_SENTINEL } } };
const mockRouterStore = {};

vi.mock('../../src/signer.js', () => ({
  broadcastOps: (...args) => mockBroadcastOps(...args),
}));

vi.mock('../../src/api.js', () => ({
  startOrcid: (...args) => mockStartOrcid(...args),
}));

vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name) => {
      if (name === 'auth') return mockAuthStore;
      if (name === 'toast') return mockToastStore;
      if (name === 'i18n') return mockI18nStore;
      if (name === 'router') return mockRouterStore;
      return {};
    }),
  },
}));

const { broadcastWithFreshAuth, FRESH_AUTH_REDIRECT_PENDING } = await import('../../src/lib/fresh-auth.js');

const PROOF_KEY = 'pevo_fresh_auth_session_proof';

function freshExpiry(ttlMs = 60_000) {
  return new Date(Date.now() + ttlMs).toISOString();
}

function pastExpiry() {
  return new Date(Date.now() - 60_000).toISOString();
}

function setProof(token, expiresAt = freshExpiry()) {
  sessionStorage.setItem(PROOF_KEY, JSON.stringify({ token, expiresAt }));
}

// `vi.spyOn(sessionStorage, 'removeItem')` does NOT intercept in jsdom
// (Storage methods live on the prototype and direct property assignment
// is silently ignored). Patch the prototype instead and restore after.
// The callback runs synchronously AFTER the original removeItem returns
// so the re-seed lands in time for the next synchronous getItem call in
// `mintNonConsentProof` → `getCachedSessionProof`.
function patchProtoOnRemove(callback) {
  const original = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function (key) {
    const result = original.call(this, key);
    callback(key, this);
    return result;
  };
  return () => { Storage.prototype.removeItem = original; };
}

describe('broadcastWithFreshAuth — error-recovery paths', () => {
  let restoreProto = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.custody = 'light';
    sessionStorage.clear();
  });

  afterEach(() => {
    if (restoreProto) { restoreProto(); restoreProto = null; }
  });

  it('401 expired → clears cache, re-mints (from cache hit post-removal), retries broadcast', async () => {
    setProof('first-proof');

    const err = Object.assign(new Error('FRESH_AUTH_REQUIRED'), {
      status: 401, code: 'FRESH_AUTH_REQUIRED', details: { reason: 'expired' },
    });
    mockBroadcastOps
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ tx_id: 't1', block_num: 42 });

    // When `clearCachedSessionProof` fires (in the catch block), re-seed
    // the cache so the subsequent `mintNonConsentProof` lookup returns
    // a fresh proof and skips the ORCID redirect.
    restoreProto = patchProtoOnRemove((key) => {
      if (key === PROOF_KEY) {
        // patchProtoOnRemove runs this callback AFTER the original
        // removeItem returns, so a synchronous re-seed here lands in
        // sessionStorage before the next getItem call in
        // mintNonConsentProof → getCachedSessionProof.
        setProof('second-proof');
      }
    });

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

    expect(result).toEqual({ tx_id: 't1', block_num: 42 });
    expect(mockBroadcastOps).toHaveBeenCalledTimes(2);
    // First attempt used the stale proof; second used the fresh re-minted one.
    expect(mockBroadcastOps.mock.calls[0][2]).toMatchObject({ freshAuthProof: 'first-proof' });
    expect(mockBroadcastOps.mock.calls[1][2]).toMatchObject({ freshAuthProof: 'second-proof' });
    // The mint flow did not redirect — startOrcid was never invoked because
    // the cache lookup post-clear found the re-seeded fresh proof.
    expect(mockStartOrcid).not.toHaveBeenCalled();
  });

  it('401 missing → re-mints and retries (alternate reason in the contract)', async () => {
    setProof('stale');
    const err = Object.assign(new Error('FRESH_AUTH_REQUIRED'), {
      status: 401, code: 'FRESH_AUTH_REQUIRED', details: { reason: 'missing' },
    });
    mockBroadcastOps
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ tx_id: 't2' });

    restoreProto = patchProtoOnRemove((key) => {
      if (key === PROOF_KEY) setProof('fresh');
    });

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);
    expect(result).toEqual({ tx_id: 't2' });
    expect(mockBroadcastOps).toHaveBeenCalledTimes(2);
    expect(mockBroadcastOps.mock.calls[1][2]).toMatchObject({ freshAuthProof: 'fresh' });
  });

  it('401 malformed → re-mints and retries', async () => {
    setProof('garbage-proof');
    const err = Object.assign(new Error('FRESH_AUTH_REQUIRED'), {
      status: 401, code: 'FRESH_AUTH_REQUIRED', details: { reason: 'malformed' },
    });
    mockBroadcastOps
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ tx_id: 't3' });

    restoreProto = patchProtoOnRemove((key) => {
      if (key === PROOF_KEY) setProof('good');
    });

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);
    expect(result).toEqual({ tx_id: 't3' });
    expect(mockBroadcastOps).toHaveBeenCalledTimes(2);
  });

  it('403 username_mismatch → disconnects auth, shows toast, returns null sentinel', async () => {
    setProof('proof-x');
    const err = Object.assign(new Error('FRESH_AUTH_REQUIRED'), {
      status: 403, code: 'FRESH_AUTH_REQUIRED', details: { reason: 'username_mismatch' },
    });
    mockBroadcastOps.mockRejectedValueOnce(err);

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
    setProof('proof-x');
    const err = Object.assign(new Error('FRESH_AUTH_REQUIRED'), {
      status: 403, code: 'FRESH_AUTH_REQUIRED', details: { reason: 'username_mismatch' },
    });
    mockBroadcastOps.mockRejectedValueOnce(err);

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

  it('expired cached proof is evicted on read AND triggers re-mint (B1 regression)', async () => {
    // Regression coverage for the B1 wire-contract fix (epoch-seconds vs
    // ISO-8601). With an expired proof in cache, getCachedSessionProof
    // MUST return null AND remove the slot — and broadcastWithFreshAuth
    // MUST mint a fresh one rather than passing the stale token to
    // broadcastOps.
    setProof('expired-token', pastExpiry());

    let removalSeen = false;
    restoreProto = patchProtoOnRemove((key) => {
      if (key === PROOF_KEY) {
        removalSeen = true;
        // First removeItem comes from the getCachedSessionProof eviction
        // path. Re-seed synchronously so the subsequent mint call finds
        // a fresh entry (patchProtoOnRemove runs this after the original
        // removeItem returns, so setProof here is observed by the next
        // getItem).
        setProof('minted');
      }
    });

    mockBroadcastOps.mockResolvedValueOnce({ tx_id: 't4' });

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

    expect(result).toEqual({ tx_id: 't4' });
    expect(removalSeen).toBe(true);
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    // The expired token never reached broadcastOps — the freshly minted
    // one did.
    expect(mockBroadcastOps.mock.calls[0][2]).toMatchObject({ freshAuthProof: 'minted' });
    expect(mockBroadcastOps.mock.calls[0][2].freshAuthProof).not.toBe('expired-token');
  });

  it('non-light custody bypasses the mint flow entirely (Keychain users)', async () => {
    mockAuthStore.custody = 'keychain';
    mockBroadcastOps.mockResolvedValueOnce({ tx_id: 'kc' });

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);
    expect(result).toEqual({ tx_id: 'kc' });
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    // No freshAuthProof passed for Keychain — the request-signing IS the proof.
    expect(mockBroadcastOps.mock.calls[0][2]?.freshAuthProof).toBeUndefined();
  });
});

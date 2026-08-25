// Coverage for the session-kind re-auth WINDOW in
// `frontend/src/lib/fresh-auth.js`: factor selection, the acquire-before-commit
// gate (`ensureSessionWindow`), and the client-side model of the window's two
// deadlines.
//
// The window is what makes a light account usable: one re-auth act authorizes
// every broadcast and every IPFS upload until the window closes, rather than
// one act per action. Nothing covered this before — the previous behavior was a
// single-use proof re-minted by ORCID redirect on every publish, vote, comment,
// review, and edit, and that redirect is what the old tests asserted.
//
// Mocking justification (clause-a of project-CLAUDE.md "Carve-out for
// deterministic edge-case coverage"): `fetchEmailStatus`, `mintSessionAuthProof`
// and `startOrcid` perform real fetch() against the backend. Reproducing the
// three factor branches per-test (password registered / passwordless / status
// unreachable) would need three differently-provisioned live accounts plus an
// induced network failure, and asserting that the password path performs NO
// navigation requires observing `window.location` rather than following it.
// `signer.js#broadcastOps` is mocked for the same reason as its sibling suite.
//
// Auth-focus carve-out (clause-b): no auth middleware is mocked and no
// cryptographic verification is bypassed — the proof is minted and verified
// server-side; these tests assert which factor the client chooses and how it
// models the window it was handed.
//
// Clause-c real-path companion: `frontend/tests/e2e/non-consent-fresh-auth.spec.js`
// exercises acquisition + broadcast against the real backend.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockBroadcastOps = vi.fn();
const mockStartOrcid = vi.fn();
const mockFetchEmailStatus = vi.fn();
const mockMintSessionAuthProof = vi.fn();
const mockReauthModal = { request: vi.fn() };
const mockToastStore = { show: vi.fn() };
const mockAuthStore = { custody: 'light', username: 'alice', disconnect: vi.fn() };

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
      if (name === 'reauthModal') return mockReauthModal;
      if (name === 'i18n') return { messages: {} };
      return {};
    }),
  },
}));

const {
  broadcastWithFreshAuth,
  ensureSessionWindow,
  cacheSessionProof,
  slideSessionWindow,
  clearCachedSessionProof,
} = await import('../../src/lib/fresh-auth.js');

const PROOF_KEY = 'pevo_fresh_auth_session_proof';
const IDLE_MS = 900_000;      // 15 minutes, the backend's idle period
const ABSOLUTE_MS = 7_200_000; // 2 hours, the backend's absolute cap

function issuance(token, { idleMs = IDLE_MS, absoluteMs = ABSOLUTE_MS } = {}) {
  return {
    fresh_auth_proof: token,
    expires_at: new Date(Date.now() + idleMs).toISOString(),
    absolute_expires_at: new Date(Date.now() + absoluteMs).toISOString(),
    mechanism: 'password',
  };
}

function cached() {
  const raw = sessionStorage.getItem(PROOF_KEY);
  return raw ? JSON.parse(raw) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mockAuthStore.custody = 'light';
  // A fresh username per test defeats the tab-lifetime password-factor memo,
  // which would otherwise carry a `hasPassword: true` answer from one test's
  // account into the next test's differently-provisioned one.
  mockAuthStore.username = `user-${Math.random().toString(36).slice(2)}`;
  mockReauthModal.request.mockResolvedValue('hunter2');
  mockMintSessionAuthProof.mockImplementation(async () => issuance('window-proof'));
  mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
  mockBroadcastOps.mockResolvedValue({ tx_id: 'tx' });
  // Stub window.location so a redirect assignment is observable and does not
  // trigger jsdom navigation. Mirrors lib-fresh-auth-settings-orcid.test.js.
  vi.stubGlobal('window', { ...globalThis.window, location: { href: '', pathname: '/publish' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('factor selection', () => {
  it('an account with a password re-auths inline, never by navigation', async () => {
    // This is the whole point of adopting the password factor: a modal instead
    // of a full-page redirect out of the page the user is working on.
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });

    const outcome = await ensureSessionWindow();

    expect(outcome).toEqual({ ready: true, proof: 'window-proof' });
    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
    expect(mockMintSessionAuthProof).toHaveBeenCalledWith('hunter2');
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(window.location.href).toBe('');
  });

  it('a passwordless account takes the ORCID round-trip', async () => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });

    const outcome = await ensureSessionWindow();

    expect(outcome).toEqual({ ready: false, redirect: true });
    expect(mockStartOrcid).toHaveBeenCalledWith('session_auth', {});
    expect(window.location.href).toBe('https://orcid.org/oauth/authorize?x=1');
    // No password prompt for an account that has no password to enter.
    expect(mockReauthModal.request).not.toHaveBeenCalled();
    // The callback must dispatch to the session-auth handler on return.
    expect(sessionStorage.getItem('pevo_orcid_mode')).toBe('session_auth');
    expect(sessionStorage.getItem('pevo_fresh_auth_return_to')).toBe('/publish');
  });

  it('an unreachable account status falls through to the password prompt', async () => {
    // Only an explicit `false` routes to ORCID. A transient status failure must
    // not dead-end a valid password holder — the backend rejects a genuinely
    // passwordless account at the mint route anyway.
    mockFetchEmailStatus.mockRejectedValue(new Error('network down'));

    const outcome = await ensureSessionWindow();

    expect(outcome).toEqual({ ready: true, proof: 'window-proof' });
    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).not.toHaveBeenCalled();
  });

  it('a status response missing hasPassword falls through to the password prompt', async () => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: {} });

    const outcome = await ensureSessionWindow();

    expect(outcome.ready).toBe(true);
    expect(mockStartOrcid).not.toHaveBeenCalled();
  });

  it('self-custody needs no window at all', async () => {
    mockAuthStore.custody = 'self';

    const outcome = await ensureSessionWindow();

    expect(outcome).toEqual({ ready: true, proof: null });
    expect(mockFetchEmailStatus).not.toHaveBeenCalled();
    expect(mockReauthModal.request).not.toHaveBeenCalled();
  });

  it('a dismissed modal and a spent re-auth are distinguishable outcomes', async () => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });

    mockReauthModal.request.mockResolvedValue(null);
    expect(await ensureSessionWindow()).toEqual({ ready: false, cancelled: true });

    mockReauthModal.request.mockResolvedValue('wrong');
    mockMintSessionAuthProof.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'UNAUTHORIZED' }),
    );
    expect(await ensureSessionWindow()).toEqual({ ready: false, failed: true });
  });
});

describe('one re-auth act per window', () => {
  beforeEach(() => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
  });

  it('voting twice in quick succession prompts once', async () => {
    await broadcastWithFreshAuth('alice', [['vote', { weight: 10000 }]]);
    await broadcastWithFreshAuth('alice', [['vote', { weight: 0 }]]);

    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
    expect(mockBroadcastOps).toHaveBeenCalledTimes(2);
    expect(mockBroadcastOps.mock.calls[1][2]).toMatchObject({ freshAuthProof: 'window-proof' });
  });

  it('concurrent acquisitions coalesce onto a single prompt', async () => {
    // A submit and a vote button firing in the same tick must not race the
    // singleton reauth modal — the loser would resolve null and silently drop
    // its action. This coalescing is what lets the upload layer drop its own
    // prompt-serialization gate.
    const [a, b] = await Promise.all([ensureSessionWindow(), ensureSessionWindow()]);

    expect(a.proof).toBe('window-proof');
    expect(b.proof).toBe('window-proof');
    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
    expect(mockMintSessionAuthProof).toHaveBeenCalledTimes(1);
  });

  it('the upload leg and the broadcast leg share one window', async () => {
    // Publishing a paper with a PDF costs one re-auth act total: the proof the
    // upload pre-flight uses is the same one the broadcast carries.
    const forUpload = await ensureSessionWindow();
    await broadcastWithFreshAuth('alice', [['comment', {}]]);

    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
    expect(forUpload.proof).toBe('window-proof');
    expect(mockBroadcastOps.mock.calls[0][2]).toMatchObject({ freshAuthProof: 'window-proof' });
  });
});

describe('window model', () => {
  it('a successful broadcast slides the idle deadline instead of spending the proof', async () => {
    // The backend slides on every consume but echoes nothing, so the client
    // replays the slide. Without it the cached window would expire on its
    // mint-time deadline while the server still honours it.
    // A window minted five minutes ago: its idle deadline still sits at
    // mint + 15 minutes, and a use now should push it to now + 15 minutes.
    sessionStorage.setItem(PROOF_KEY, JSON.stringify({
      token: 'w',
      expiresAt: new Date(Date.now() + IDLE_MS - 300_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + ABSOLUTE_MS).toISOString(),
      idlePeriodMs: IDLE_MS,
    }));
    const before = new Date(cached().expiresAt).getTime();

    await broadcastWithFreshAuth('alice', [['vote', {}]]);

    const after = new Date(cached().expiresAt).getTime();
    expect(after).toBeGreaterThan(before);
    // Still the same window, not a re-mint.
    expect(cached().token).toBe('w');
    expect(mockMintSessionAuthProof).not.toHaveBeenCalled();
  });

  it('the slide never pushes past the absolute cap', async () => {
    // The cap is the security property: a proof exfiltrated alongside a JWT is
    // worth at most the cap, no matter how much activity is manufactured.
    const capAt = Date.now() + 5_000;
    cacheSessionProof(
      'w', new Date(Date.now() + 1_000).toISOString(), new Date(capAt).toISOString(),
    );

    slideSessionWindow();

    expect(new Date(cached().expiresAt).getTime()).toBeLessThanOrEqual(capAt);
  });

  it('a reached absolute cap closes the window even with idle time left', async () => {
    sessionStorage.setItem(PROOF_KEY, JSON.stringify({
      token: 'capped',
      expiresAt: new Date(Date.now() + IDLE_MS).toISOString(),
      absoluteExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      idlePeriodMs: IDLE_MS,
    }));
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });

    const outcome = await ensureSessionWindow();

    // The capped entry was evicted and a real re-auth act replaced it.
    expect(outcome.proof).toBe('window-proof');
    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
  });

  it('a corrupt deadline is treated as corruption, not as never-expiring', async () => {
    // `Date.now() >= NaN` is false, so a naive comparison would hand a proof of
    // unknown lifetime to every subsequent action.
    for (const entry of [
      { token: 't', expiresAt: 'not-a-date', absoluteExpiresAt: new Date(Date.now() + ABSOLUTE_MS).toISOString(), idlePeriodMs: IDLE_MS },
      { token: 't', expiresAt: new Date(Date.now() + IDLE_MS).toISOString(), absoluteExpiresAt: 'garbage', idlePeriodMs: IDLE_MS },
      { token: 't', expiresAt: new Date(Date.now() + IDLE_MS).toISOString(), absoluteExpiresAt: new Date(Date.now() + ABSOLUTE_MS).toISOString(), idlePeriodMs: 'nope' },
      { token: 't', expiresAt: new Date(Date.now() + IDLE_MS).toISOString() },
    ]) {
      sessionStorage.setItem(PROOF_KEY, JSON.stringify(entry));
      mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
      mockReauthModal.request.mockClear();

      const outcome = await ensureSessionWindow();

      expect(outcome.proof).toBe('window-proof');
      expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
      clearCachedSessionProof();
    }
  });

  it('caching records the idle period the issuance implies', () => {
    cacheSessionProof(
      'w',
      new Date(Date.now() + IDLE_MS).toISOString(),
      new Date(Date.now() + ABSOLUTE_MS).toISOString(),
    );

    // The backend publishes no period field; the distance to the idle deadline
    // is the only place the client can learn it.
    expect(cached().idlePeriodMs).toBeGreaterThan(IDLE_MS - 5_000);
    expect(cached().idlePeriodMs).toBeLessThanOrEqual(IDLE_MS);
  });
});

describe('acquire-before-commit', () => {
  beforeEach(() => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
  });

  it('re-auths ahead of a submit when the window is about to close', async () => {
    // Discovering the window closed after the upload has been paid for is the
    // loss this gate exists to prevent, so a window with only seconds left
    // reads as already spent.
    cacheSessionProof(
      'nearly-closed',
      new Date(Date.now() + 5_000).toISOString(),
      new Date(Date.now() + ABSOLUTE_MS).toISOString(),
    );

    const outcome = await ensureSessionWindow();

    expect(outcome.proof).toBe('window-proof');
    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
  });

  it('a cancelled proactive re-auth leaves the still-live window usable', async () => {
    // The margin is a preference, not an eviction: the user declining to
    // re-auth early must not lose the window they already hold.
    cacheSessionProof(
      'nearly-closed',
      new Date(Date.now() + 5_000).toISOString(),
      new Date(Date.now() + ABSOLUTE_MS).toISOString(),
    );
    mockReauthModal.request.mockResolvedValue(null);

    expect(await ensureSessionWindow()).toEqual({ ready: false, cancelled: true });

    // The broadcast path demands no margin, so it still finds the live window.
    await broadcastWithFreshAuth('alice', [['vote', {}]]);
    expect(mockBroadcastOps.mock.calls[0][2]).toMatchObject({ freshAuthProof: 'nearly-closed' });
  });

  it('a comfortably open window is a plain cache hit — no prompt', async () => {
    cacheSessionProof(
      'wide-open',
      new Date(Date.now() + IDLE_MS).toISOString(),
      new Date(Date.now() + ABSOLUTE_MS).toISOString(),
    );

    const outcome = await ensureSessionWindow();

    expect(outcome).toEqual({ ready: true, proof: 'wide-open' });
    expect(mockReauthModal.request).not.toHaveBeenCalled();
    expect(mockFetchEmailStatus).not.toHaveBeenCalled();
  });
});

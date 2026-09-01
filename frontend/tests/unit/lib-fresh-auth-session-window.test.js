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

const { REAUTH_PROMPT_BUSY } = await import('../../src/components/reauth-modal.js');
const {
  broadcastWithFreshAuth,
  ensureSessionWindow,
  freshAuthWindowReady,
  cacheSessionProof,
  slideSessionWindow,
  clearCachedSessionProof,
  clearPasswordFactorMemo,
  resolvePasswordFactor,
  abandonInFlightAcquisitions,
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

// Seed a window that has already been open for a while. Issuance anchors and
// clamps what it is handed (a freshly minted window always spans a full
// period), so an aged or nearly-closed window can only be produced by writing
// the entry the way elapsed time would have left it.
function seedWindow(token, { idleInMs, absoluteInMs = ABSOLUTE_MS, idlePeriodMs = IDLE_MS } = {}) {
  sessionStorage.setItem(PROOF_KEY, JSON.stringify({
    token,
    expiresAt: new Date(Date.now() + idleInMs).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + absoluteInMs).toISOString(),
    idlePeriodMs,
  }));
}

function cached() {
  const raw = sessionStorage.getItem(PROOF_KEY);
  return raw ? JSON.parse(raw) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  clearCachedSessionProof();
  mockAuthStore.custody = 'light';
  mockAuthStore.username = 'alice';
  // Drop the tab-lifetime password-factor memo, which would otherwise carry a
  // `hasPassword: true` answer from one test's account into the next test's
  // differently-provisioned one.
  clearPasswordFactorMemo();
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

  it('an assumed password the backend rejects falls back to the ORCID round-trip', async () => {
    // With the status unavailable the password factor is a GUESS, and the
    // backend's 401 is the first hard evidence the account has no password.
    // Re-prompting would dead-end the action for exactly the accounts whose
    // only registered factor is the one not being offered; one prompt, then
    // the round-trip.
    mockFetchEmailStatus.mockRejectedValue(new Error('rate limited'));
    mockMintSessionAuthProof.mockRejectedValue(
      Object.assign(new Error('null hash'), { code: 'UNAUTHORIZED' }),
    );

    const outcome = await ensureSessionWindow();

    expect(outcome).toEqual({ ready: false, redirect: true });
    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).toHaveBeenCalledWith('session_auth', {});
    expect(window.location.href).toBe('https://orcid.org/oauth/authorize?x=1');
  });

  it('an assumed-password 401 with navigation suppressed refuses instead of redirecting', async () => {
    // The fallback obeys the same navigation policy as the known-passwordless
    // branch: a caller already holding work the user would lose gets the
    // non-navigating refusal, not a round-trip fired out from under it.
    mockFetchEmailStatus.mockRejectedValue(new Error('rate limited'));
    mockMintSessionAuthProof.mockRejectedValue(
      Object.assign(new Error('null hash'), { code: 'UNAUTHORIZED' }),
    );

    const outcome = await ensureSessionWindow({ allowRedirect: false });

    expect(outcome).toEqual({ ready: false, reauthRequired: true });
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(window.location.href).toBe('');
  });

  it('an observed password that 401s re-prompts and never falls back to ORCID', async () => {
    // The escape hatch is for guesses only: when the status SAID the account
    // has a password, a 401 is a typo and earns the second prompt.
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    mockMintSessionAuthProof.mockRejectedValue(
      Object.assign(new Error('wrong password'), { code: 'UNAUTHORIZED' }),
    );

    const outcome = await ensureSessionWindow();

    expect(outcome).toEqual({ ready: false, failed: true });
    expect(mockReauthModal.request).toHaveBeenCalledTimes(2);
    expect(mockStartOrcid).not.toHaveBeenCalled();
  });
});

describe('password-factor memo', () => {
  it('a password holder is asked once per tab, not once per acquisition', async () => {
    // An account that has a password cannot lose one without a navigation that
    // resets module state, so re-fetching the status on every acquisition is
    // pure latency in front of the modal. A memo hit is an OBSERVED answer.
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });

    expect(await resolvePasswordFactor()).toEqual({ usesPassword: true, assumed: false });
    expect(await resolvePasswordFactor()).toEqual({ usesPassword: true, assumed: false });

    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(1);
  });

  it('a passwordless answer is re-checked, so a password set in settings takes effect', async () => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
    expect((await resolvePasswordFactor()).usesPassword).toBe(false);

    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    expect((await resolvePasswordFactor()).usesPassword).toBe(true);

    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(2);
  });

  it('a re-login as a different account cannot inherit the memo', async () => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    expect((await resolvePasswordFactor()).usesPassword).toBe(true);

    // Same tab, different subject: the memo is username-keyed, so the second
    // account's own status decides its factor.
    mockAuthStore.username = 'bob';
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
    expect((await resolvePasswordFactor()).usesPassword).toBe(false);
  });

  it('clearing the memo retires a stale positive for the same account', async () => {
    // What `auth.disconnect()` calls. A password can disappear from an account
    // that had one (recover via ORCID with no new password), and the memo is
    // the one thing that would keep answering for the account it was written
    // against.
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    expect((await resolvePasswordFactor()).usesPassword).toBe(true);

    clearPasswordFactorMemo();
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
    expect((await resolvePasswordFactor()).usesPassword).toBe(false);
  });

  it('an unavailable status resolves as an ASSUMED password, never memoized', async () => {
    // The guess must not harden into a fact: the next resolution re-fetches,
    // and the `assumed` flag is what lets a 401 at the mint route the caller
    // to ORCID instead of a second prompt for a password that may not exist.
    mockFetchEmailStatus.mockRejectedValue(new Error('network down'));
    expect(await resolvePasswordFactor()).toEqual({ usesPassword: true, assumed: true });

    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
    expect((await resolvePasswordFactor()).usesPassword).toBe(false);
  });

  it('a status response missing the field is an ASSUMED answer too', async () => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: {} });
    expect(await resolvePasswordFactor()).toEqual({ usesPassword: true, assumed: true });
  });

  it('concurrent resolutions coalesce onto one status request', async () => {
    // The resolver has direct callers at several surfaces with no shared gate
    // above it. Two racing callers must not each spend the rate-limited
    // status budget, nor land on different factors when one request succeeds
    // and its sibling transiently fails.
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });

    const [a, b] = await Promise.all([resolvePasswordFactor(), resolvePasswordFactor()]);

    expect(a).toEqual({ usesPassword: false, assumed: false });
    expect(b).toEqual({ usesPassword: false, assumed: false });
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(1);
  });

  it('a clear landing mid-resolution is not undone by the resolving fetch', async () => {
    // `auth.disconnect()` can clear the memo while a status fetch is in
    // flight; the fetch resolving afterwards must not resurrect the answer it
    // was started for. The generation captured before the await declines the
    // write.
    let resolveFetch;
    mockFetchEmailStatus.mockReturnValueOnce(new Promise((res) => { resolveFetch = res; }));

    const pending = resolvePasswordFactor();
    clearPasswordFactorMemo();
    resolveFetch({ status: 'ok', data: { hasPassword: true } });
    expect(await pending).toEqual({ usesPassword: true, assumed: false });

    // Had the memo been written after the clear, this would be a memo hit
    // with no second fetch.
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
    expect((await resolvePasswordFactor()).usesPassword).toBe(false);
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(2);
  });

  it('a successful mint under an assumed factor is memoized: no re-fetch, and no fallback on a later 401', async () => {
    // The mint route VERIFYING the password outranks anything the status
    // endpoint could report. Without the mint-success report the tab keeps
    // re-guessing while the status read stays rate-limited, and a later
    // mistype fires the navigating ORCID fallback at an account that just
    // proved its password exists.
    mockFetchEmailStatus.mockRejectedValue(new Error('rate limited'));
    expect((await ensureSessionWindow()).ready).toBe(true);
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(1);

    // The next resolution rides the mint-proven memo instead of re-guessing.
    expect(await resolvePasswordFactor()).toEqual({ usesPassword: true, assumed: false });
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(1);

    // And a later mistype re-prompts as a typo (spent re-auth), never as the
    // assumed-password ORCID round-trip.
    clearCachedSessionProof();
    mockMintSessionAuthProof.mockRejectedValue(
      Object.assign(new Error('wrong password'), { code: 'UNAUTHORIZED' }),
    );
    expect(await ensureSessionWindow()).toEqual({ ready: false, failed: true });
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(1);
  });

  it('a clear landing while the mint prompt sits open vetoes the mint-success memo write', async () => {
    // The mint-success report mirrors the status-fetch write's
    // capture-before-await discipline: the generation is captured before the
    // prompt opens, so a subject scrub while the modal sits open declines
    // the write rather than re-memoizing for a subject the tab no longer
    // represents.
    mockFetchEmailStatus.mockRejectedValue(new Error('rate limited'));
    let openPrompt;
    mockReauthModal.request.mockReturnValueOnce(
      new Promise((resolve) => { openPrompt = resolve; }),
    );

    const pending = ensureSessionWindow();
    // A macrotask hop: the factor resolves as assumed and the prompt opens.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    clearPasswordFactorMemo();
    openPrompt('hunter2');
    expect((await pending).ready).toBe(true);

    // A vetoed write means the next resolution still re-fetches.
    expect(await resolvePasswordFactor()).toEqual({ usesPassword: true, assumed: true });
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(2);
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
    // The fixture only exercises the clamp when a full idle period would land
    // BEYOND the cap — a window nearly two hours old with its idle deadline
    // still open. With the cap further out than the period, `Math.min` never
    // selects it and deleting the clamp keeps the assertion green.
    const capAt = Date.now() + 5_000;
    seedWindow('w', { idleInMs: 1_000, absoluteInMs: 5_000 });

    slideSessionWindow();

    const slid = new Date(cached().expiresAt).getTime();
    expect(slid).toBeLessThanOrEqual(capAt);
    // An unclamped slide would land a full idle period out, far past the cap.
    expect(slid).toBeLessThan(Date.now() + IDLE_MS);
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

  it('the idle period is learned from the issuance, not hardcoded', async () => {
    // Every other fixture mints with the same period the client would assume,
    // so a hardcoded constant would keep them all green while the client
    // silently diverged from a backend that changed its idle seconds. Mint a
    // deliberately different (but plausible) period and watch it survive into
    // the slide.
    const shorterPeriod = 600_000;
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    mockMintSessionAuthProof.mockResolvedValue(
      issuance('short-window', { idleMs: shorterPeriod }),
    );

    await ensureSessionWindow();

    expect(cached().idlePeriodMs).toBeGreaterThan(shorterPeriod - 5_000);
    expect(cached().idlePeriodMs).toBeLessThanOrEqual(shorterPeriod);

    slideSessionWindow();
    const slid = new Date(cached().expiresAt).getTime() - Date.now();
    expect(slid).toBeGreaterThan(shorterPeriod - 5_000);
    expect(slid).toBeLessThanOrEqual(shorterPeriod);
  });

  it('a client clock behind the server does not infer an over-long window', () => {
    // The server's deadlines are in ITS clock. A client five minutes behind
    // measures twenty minutes to a fifteen-minute deadline; believing that
    // buys a mid-flow 401 exactly where the pre-flight margin exists to
    // prevent one. Both clocks tick at the same rate, so the real window is
    // one period of wall time regardless of the offset.
    cacheSessionProof(
      'skewed',
      new Date(Date.now() + IDLE_MS + 300_000).toISOString(),
      new Date(Date.now() + ABSOLUTE_MS + 300_000).toISOString(),
    );

    expect(cached().idlePeriodMs).toBeLessThanOrEqual(IDLE_MS);
    expect(new Date(cached().expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(IDLE_MS);
  });

  it('a badly-ahead client clock degrades to a full window, not a lockout', async () => {
    // A client thirteen or more minutes ahead measures a span under the
    // pre-flight margin. Honouring it would make every acquisition read as
    // instantly stale, and for a passwordless account that is an ORCID
    // redirect loop: the round-trip caches a window the next gate rejects.
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    cacheSessionProof(
      'skewed-ahead',
      new Date(Date.now() + 60_000).toISOString(),
      new Date(Date.now() + ABSOLUTE_MS - 780_000).toISOString(),
    );

    const outcome = await ensureSessionWindow();

    expect(outcome).toEqual({ ready: true, proof: 'skewed-ahead' });
    expect(mockReauthModal.request).not.toHaveBeenCalled();
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

  it('a malformed issuance deadline drops the window instead of throwing', () => {
    // An unparseable deadline anchors to NaN, and an unguarded write would
    // throw a RangeError out of a cache call no consumer expects to reject —
    // the corruption guard on the read side can never fire if the write throws
    // first. Fail closed: the slot ends empty and the next consumer re-auths.
    for (const [idle, absolute] of [
      ['not-a-date', new Date(Date.now() + ABSOLUTE_MS).toISOString()],
      [new Date(Date.now() + IDLE_MS).toISOString(), 'garbage'],
      [undefined, undefined],
    ]) {
      seedWindow('previous-window', { idleInMs: IDLE_MS });

      expect(() => cacheSessionProof('t', idle, absolute)).not.toThrow();
      expect(cached()).toBeNull();
    }
  });

  it('a failed write cannot leave a stale stored entry shadowing the fresher mirror', async () => {
    // The read consults storage before the in-memory mirror, so a failed write
    // that leaves an OLDER entry readable would serve the stale copy. The
    // failed-write path removes the key before installing the mirror, so a
    // non-empty storage read always implies a current entry.
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    seedWindow('stale-window', { idleInMs: IDLE_MS });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    try {
      cacheSessionProof(
        'fresh-window',
        new Date(Date.now() + IDLE_MS).toISOString(),
        new Date(Date.now() + ABSOLUTE_MS).toISOString(),
      );
    } finally {
      setItem.mockRestore();
    }

    const outcome = await ensureSessionWindow();

    expect(outcome).toEqual({ ready: true, proof: 'fresh-window' });
    expect(mockReauthModal.request).not.toHaveBeenCalled();
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
    seedWindow('nearly-closed', { idleInMs: 5_000 });

    const outcome = await ensureSessionWindow();

    expect(outcome.proof).toBe('window-proof');
    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
  });

  it('a cancelled proactive re-auth leaves the still-live window usable', async () => {
    // The margin is a preference, not an eviction: the user declining to
    // re-auth early must not lose the window they already hold.
    seedWindow('nearly-closed', { idleInMs: 5_000 });
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

describe('the gate never fails open into silence', () => {
  beforeEach(() => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
  });

  it('a non-auth mint failure refuses the work instead of escaping', async () => {
    // The gate runs AHEAD of the caller's own try, so a rejection escapes into
    // nothing: the step machine never leaves idle, no toast fires, and the user
    // re-clicks a dead-looking button. A 503 one layer later at the broadcast
    // is handled, so an unhandled one here is strictly worse than no gate.
    mockMintSessionAuthProof.mockRejectedValue(
      Object.assign(new Error('service unavailable'), { code: 'SERVICE_UNAVAILABLE' }),
    );

    await expect(freshAuthWindowReady()).resolves.toBe(false);
    expect(mockToastStore.show).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it('a window survives a failed sessionStorage write', async () => {
    // A swallowed write leaves the gate reporting a window nothing recorded:
    // one publish then pays for three acquisitions, and a passwordless
    // account's submit gate can never be satisfied. The in-memory mirror is
    // what keeps the page load coherent when storage is blocked.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    try {
      expect(await freshAuthWindowReady()).toBe(true);
      expect(await freshAuthWindowReady()).toBe(true);
      await broadcastWithFreshAuth('alice', [['vote', {}]]);
    } finally {
      setItem.mockRestore();
    }

    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
    expect(mockBroadcastOps.mock.calls[0][2]).toMatchObject({ freshAuthProof: 'window-proof' });
  });
});

describe('teardown abandons in-flight acquisitions', () => {
  // The subject-bound scrub that runs on logout and on a cross-user login
  // clears the proof caches AND abandons the module-level in-flight state as
  // one act (the auth store routes both through its scrub). These tests drive
  // the fresh-auth half directly, composed the way that scrub invokes it.
  function teardownSubjectState() {
    clearCachedSessionProof();
    clearPasswordFactorMemo();
    abandonInFlightAcquisitions();
  }

  // Real timers in this file; a macrotask hop lets a pending flight advance
  // through its internal awaits to the point currently blocking it.
  const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

  beforeEach(() => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
  });

  it('a caller arriving after teardown starts its own acquisition instead of joining the old flight', async () => {
    const promptResolvers = [];
    mockReauthModal.request.mockImplementation(
      () => new Promise((resolve) => { promptResolvers.push(resolve); }),
    );

    const preTeardown = ensureSessionWindow();
    await tick();
    expect(promptResolvers).toHaveLength(1);

    teardownSubjectState();

    const postTeardown = ensureSessionWindow();
    await tick();
    // Joining the abandoned flight would mean no second prompt.
    expect(promptResolvers).toHaveLength(2);

    // The abandoned flight unwinds as a clean cancel; the new one mints.
    promptResolvers[0](null);
    promptResolvers[1]('hunter2');
    expect(await preTeardown).toEqual({ ready: false, cancelled: true });
    expect(await postTeardown).toEqual({ ready: true, proof: 'window-proof' });
  });

  it('a mint resolving after teardown does not repopulate the scrubbed window cache', async () => {
    let resolveMint;
    mockMintSessionAuthProof.mockReturnValueOnce(
      new Promise((resolve) => { resolveMint = resolve; }),
    );

    const pending = ensureSessionWindow();
    await tick(); // the default prompt answered; the mint round-trip is now pending
    teardownSubjectState();

    resolveMint(issuance('late-proof'));
    const outcome = await pending;

    // The late issuance is dropped, not delivered: the caller that started
    // before the teardown unwinds as a clean cancel and the slot stays empty.
    expect(outcome).toEqual({ ready: false, cancelled: true });
    expect(sessionStorage.getItem(PROOF_KEY)).toBeNull();

    // The next acquisition re-auths from scratch rather than finding a
    // resurrected window (the in-memory mirror included).
    mockReauthModal.request.mockClear();
    const next = await ensureSessionWindow();
    expect(next).toEqual({ ready: true, proof: 'window-proof' });
    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
  });

  it('a factor resolution in flight at teardown is not joined by a later caller', async () => {
    // The resolution's answer belongs to the subject whose JWT authenticated
    // the status read; a caller under the next subject must trigger a fresh
    // read instead of inheriting it.
    let resolveStatus;
    mockFetchEmailStatus.mockReturnValueOnce(
      new Promise((resolve) => { resolveStatus = resolve; }),
    );

    const stale = resolvePasswordFactor();
    teardownSubjectState();

    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
    const fresh = resolvePasswordFactor();

    resolveStatus({ status: 'ok', data: { hasPassword: true } });
    expect((await fresh).usesPassword).toBe(false);
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(2);
    // The abandoned resolution still answers its own original caller.
    expect((await stale).usesPassword).toBe(true);
  });

  it('a caller under a different subject does not join a pending factor resolution', async () => {
    // The join is identity-keyed, independent of the teardown: even when a
    // subject swap reaches the resolver without the scrub having run, the
    // pending flight's answer stays with the subject whose JWT made the
    // status read, and the new subject's caller spends its own fetch.
    let resolveStatus;
    mockFetchEmailStatus.mockReturnValueOnce(
      new Promise((resolve) => { resolveStatus = resolve; }),
    );

    const firstSubject = resolvePasswordFactor();

    mockAuthStore.username = 'bob';
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
    const secondSubject = resolvePasswordFactor();

    resolveStatus({ status: 'ok', data: { hasPassword: true } });
    expect((await secondSubject).usesPassword).toBe(false);
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(2);
    // Each flight still answers the caller that started it.
    expect((await firstSubject).usesPassword).toBe(true);
  });

  it('an abandoned flight resolving late does not evict its successor from the in-flight slot', async () => {
    const promptResolvers = [];
    mockReauthModal.request.mockImplementation(
      () => new Promise((resolve) => { promptResolvers.push(resolve); }),
    );

    const abandoned = ensureSessionWindow();
    await tick();
    teardownSubjectState();

    const successor = ensureSessionWindow();
    await tick();
    expect(promptResolvers).toHaveLength(2);

    // The abandoned flight resolves first; its cleanup must not clear the
    // slot the successor now owns...
    promptResolvers[0](null);
    expect(await abandoned).toEqual({ ready: false, cancelled: true });

    // ...so a third caller still coalesces onto the successor instead of
    // opening a third prompt.
    const joined = ensureSessionWindow();
    await tick();
    expect(promptResolvers).toHaveLength(2);

    promptResolvers[1]('hunter2');
    expect(await successor).toEqual({ ready: true, proof: 'window-proof' });
    expect(await joined).toEqual({ ready: true, proof: 'window-proof' });
  });

  it('the scrub drops a window held only in the in-memory mirror', async () => {
    // A failed storage write parks the window in the module mirror; the
    // scrub must drop that copy too, or a cross-user login inherits a window
    // that no storage inspection can see.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    try {
      cacheSessionProof(
        'mirror-only',
        new Date(Date.now() + IDLE_MS).toISOString(),
        new Date(Date.now() + ABSOLUTE_MS).toISOString(),
      );
    } finally {
      setItem.mockRestore();
    }

    teardownSubjectState();

    const outcome = await ensureSessionWindow();
    // A surviving mirror would be a silent cache hit with no prompt.
    expect(outcome).toEqual({ ready: true, proof: 'window-proof' });
    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
  });

  it('a passwordless answer arriving after teardown does not navigate to ORCID', async () => {
    // The acquisition was started for the previous subject; if its factor
    // read resolves passwordless after the scrub, firing the ORCID
    // round-trip would navigate the next subject's tab on the previous
    // subject's behalf. The abandoned flight must unwind as a clean cancel.
    let resolveStatus;
    mockFetchEmailStatus.mockReturnValueOnce(
      new Promise((resolve) => { resolveStatus = resolve; }),
    );

    const pending = ensureSessionWindow();
    await tick(); // the factor read is now pending
    teardownSubjectState();

    resolveStatus({ status: 'ok', data: { hasPassword: false } });
    const outcome = await pending;

    expect(outcome).toEqual({ ready: false, cancelled: true });
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(window.location.href).toBe('');
  });

  it('a password typed into a prompt left open across teardown does not spend a mint', async () => {
    // The prompt belongs to the previous subject, but the mint request would
    // ride the tab's CURRENT credentials; no mint may leave the tab.
    let resolvePrompt;
    mockReauthModal.request.mockImplementationOnce(
      () => new Promise((resolve) => { resolvePrompt = resolve; }),
    );

    const pending = ensureSessionWindow();
    await tick(); // the prompt is now open
    teardownSubjectState();

    resolvePrompt('hunter2');
    const outcome = await pending;

    expect(outcome).toEqual({ ready: false, cancelled: true });
    expect(mockMintSessionAuthProof).not.toHaveBeenCalled();
    // The outcome is the same sentinel a user's own dismissal produces, and
    // the vocabulary keeps that one silent — so the abort site is what tells
    // the two apart. Without a message the user answers a prompt and watches
    // the action do nothing at all. Pinned here so the session path and the
    // consent-op orchestrators report a teardown identically.
    expect(mockToastStore.show).toHaveBeenCalledTimes(1);
    expect(mockToastStore.show).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it('the assumed-password ORCID fallback does not navigate after teardown', async () => {
    // The status read is down, so the factor is assumed; a mint 401 would
    // normally hand the caller back to its ORCID factor by full-page
    // navigation. When the 401 lands after the scrub, that navigation would
    // fire for a subject this tab no longer represents.
    mockFetchEmailStatus.mockRejectedValueOnce(new Error('status unreachable'));
    let rejectMint;
    mockMintSessionAuthProof.mockReturnValueOnce(
      new Promise((resolve, reject) => { rejectMint = reject; }),
    );

    const pending = ensureSessionWindow();
    await tick(); // the default prompt answered; the mint round-trip is pending
    teardownSubjectState();

    rejectMint(Object.assign(new Error('bad password'), { code: 'UNAUTHORIZED' }));
    const outcome = await pending;

    expect(outcome).toEqual({ ready: false, cancelled: true });
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(window.location.href).toBe('');
  });

  it('an ORCID redirect start resolving after teardown does not navigate', async () => {
    // The passwordless branch's `startOrcid` round-trip is the last await
    // before the full-page navigation: both passwordless outcomes reach it
    // after their final generation check, so a teardown landing inside the
    // round-trip must be re-checked at the navigation itself. Without that,
    // the resolution sends the new subject's tab to ORCID on the previous
    // subject's behalf. The flight unwinds as a clean cancel instead, and
    // the redirect keys it wrote are cleared, mirroring the error unwinds.
    mockFetchEmailStatus.mockResolvedValueOnce({ status: 'ok', data: { hasPassword: false } });
    let resolveStart;
    mockStartOrcid.mockReturnValueOnce(
      new Promise((resolve) => { resolveStart = resolve; }),
    );

    const pending = ensureSessionWindow();
    await tick(); // the startOrcid round-trip is now pending
    teardownSubjectState();

    resolveStart({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
    const outcome = await pending;

    expect(outcome).toEqual({ ready: false, cancelled: true });
    expect(window.location.href).toBe('');
    expect(sessionStorage.getItem('pevo_orcid_mode')).toBeNull();
    expect(sessionStorage.getItem('pevo_fresh_auth_return_to')).toBeNull();
  });

  it('a stale factor resolution settling late does not evict its successor from the in-flight slot', async () => {
    let resolveStale;
    mockFetchEmailStatus.mockReturnValueOnce(
      new Promise((resolve) => { resolveStale = resolve; }),
    );

    const stale = resolvePasswordFactor();
    teardownSubjectState();

    let resolveSuccessor;
    mockFetchEmailStatus.mockReturnValueOnce(
      new Promise((resolve) => { resolveSuccessor = resolve; }),
    );
    const successor = resolvePasswordFactor();

    // The stale resolution settles first; its cleanup must not clear the
    // slot the successor now owns...
    resolveStale({ status: 'ok', data: { hasPassword: true } });
    await stale;

    // ...so a later caller coalesces onto the successor's status request
    // instead of spending the rate-limited status budget again.
    const joined = resolvePasswordFactor();
    resolveSuccessor({ status: 'ok', data: { hasPassword: false } });

    expect((await joined).usesPassword).toBe(false);
    expect((await successor).usesPassword).toBe(false);
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(2);
  });
});

describe('collisions and suppressed navigation', () => {
  it('a prompt already open is not silently dropped as a cancel', async () => {
    // Two orchestrators that share the singleton modal but not an in-flight
    // coalescer — a vote and an authorship action on one paper page — collide
    // here. Collapsing the refusal into a cancel loses one action with no
    // feedback at all.
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    mockReauthModal.request.mockResolvedValue(REAUTH_PROMPT_BUSY);

    const outcome = await ensureSessionWindow();

    expect(outcome).toEqual({ ready: false, busy: true });
    expect(await freshAuthWindowReady()).toBe(false);
    expect(mockToastStore.show).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it('a suppressed round-trip refuses instead of navigating away', async () => {
    // Callers already holding work the user would lose (a picked image, a
    // batch of completed pins) ask for acquisition without navigation. A
    // passwordless account gets a refusal it can act on, not a full-page
    // round-trip fired out from under the composition.
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });

    const outcome = await ensureSessionWindow({ allowRedirect: false });

    expect(outcome).toEqual({ ready: false, reauthRequired: true });
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(window.location.href).toBe('');
  });

  it('suppressing navigation still lets a password account prompt inline', async () => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });

    const outcome = await ensureSessionWindow({ allowRedirect: false });

    expect(outcome).toEqual({ ready: true, proof: 'window-proof' });
    expect(window.location.href).toBe('');
  });

  it('a suppressed refusal is told to the user, not returned in silence', async () => {
    // The page gate refuses without a prompt ever appearing; a gate that
    // just returns false leaves a dead-looking button — the same silence the
    // failed and busy outcomes already toast their way out of.
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });

    expect(await freshAuthWindowReady({ allowRedirect: false })).toBe(false);
    expect(mockToastStore.show).toHaveBeenCalledWith(
      'Please confirm your identity again, then try once more.',
      'error',
    );
  });

  it('concurrent callers with opposite redirect postures do not inherit each other', async () => {
    // The in-flight slot is keyed on the redirect policy. A single shared slot
    // hands the joiner the first caller's outcome, and the two postures resolve
    // the passwordless branch oppositely — so a submit entitled to navigate
    // could inherit an inline-image acquisition's refusal, or a suppressed leg
    // could inherit a navigation fired out from under the work it protects.
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });

    const [suppressed, permissive] = await Promise.all([
      ensureSessionWindow({ allowRedirect: false }),
      ensureSessionWindow(),
    ]);

    expect(suppressed).toEqual({ ready: false, reauthRequired: true });
    expect(permissive).toEqual({ ready: false, redirect: true });
    // The permissive caller ran its own acquisition rather than joining the
    // suppressed one: exactly one round-trip started.
    expect(mockStartOrcid).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe('https://orcid.org/oauth/authorize?x=1');
  });

  it('concurrent callers sharing the suppressed posture still coalesce', async () => {
    // Keying by posture must not cost same-posture coalescing: two upload legs
    // in one batch still resolve one status read, not one each.
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });

    const [a, b] = await Promise.all([
      ensureSessionWindow({ allowRedirect: false }),
      ensureSessionWindow({ allowRedirect: false }),
    ]);

    expect(a.proof).toBe('window-proof');
    expect(b.proof).toBe('window-proof');
    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
    expect(mockMintSessionAuthProof).toHaveBeenCalledTimes(1);
  });
});

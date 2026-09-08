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
// What a flight parked mid-acquisition does when its subject is scrubbed out
// from under it (a logout, or a cross-user login in the same tab) is covered in
// the sibling `lib-fresh-auth-teardown.test.js`, over this same scaffolding.
//
// Mocking justification (clause-a of project-CLAUDE.md "Carve-out for
// deterministic edge-case coverage"): `fetchEmailStatus`, `mintSessionAuthProof`
// and `startOrcid` perform real fetch() against the backend. Reproducing the
// three factor branches per-test (password registered / passwordless / status
// unreachable) would need three differently-provisioned live accounts plus an
// induced network failure, and asserting that the password path performs NO
// navigation requires observing `window.location` rather than following it.
// `signer.js#broadcastOps` is what carries the operations out of the tab; it
// is mocked so the cases that broadcast can observe each call and the proof it
// carried.
//
// Auth-focus carve-out (clause-b): no auth middleware is mocked and no
// cryptographic verification is bypassed — the proof is minted and verified
// server-side; these tests assert which factor the client chooses and how it
// models the window it was handed.
//
// Clause-c real-path companion: none exists yet for this suite's risk class.
// `frontend/tests/e2e/non-consent-fresh-auth.spec.js` was cited for acquisition
// and broadcast, and drives neither. It hand-seeds the ORCID mode and return
// path that `beginSessionAuthOrcidRedirect` would have written, so no factor is
// selected and nothing is minted, and it stubs the callback response, so the
// window it caches is test-authored rather than backend-issued. What it does
// drive is that return leg's client-side cache write. It issues no broadcast.
// `frontend/tests/e2e/publish.spec.js` was cited for the upload leg; it runs
// self-custody, where `ensureSessionWindow` short-circuits and no window is
// involved. The shared factor resolver is exercised for real on the settings
// surface: `frontend/tests/e2e/settings.spec.js` resolves the password factor
// against a real GET /settings/email and mints at the real POST
// /custody/fresh-auth, and `frontend/tests/e2e/settings-orcid-factor.spec.js`
// completes a genuine backend-minted proof end to end. Both mint the per-action
// consent-op kind, so they stand in for factor selection only, not for the
// multi-use window this suite models. What has no real-path coverage is a
// light-account broadcast or upload carrying a window proof, and a follow-up is
// filed to add one.

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
  // The module-level acquisition slots outlive a case that fails while a flight
  // is parked: the pending promise stays installed, and the next case's
  // `ensureSessionWindow()` joins it instead of starting cold. One red case then
  // reports as several, which is worst exactly when a mutation probe is being
  // read for which case it killed. Start every case with no flights in hand.
  abandonInFlightAcquisitions();
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

    // The rejected attempt proved nothing, so it must not have hardened the
    // guess into a memo: the next resolution still re-reads the status. A
    // memo written on the attempt rather than on success would lock a
    // passwordless account onto a password that does not exist after its
    // first failed guess.
    expect(await resolvePasswordFactor()).toEqual({ usesPassword: true, assumed: true });
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(2);
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
    // A password is lost through one rare transition (an ORCID recovery with
    // no new password), and a memo that outlives it has its own erasers, so
    // re-fetching the status on every acquisition would be pure latency in
    // front of the modal. A memo hit is an OBSERVED answer.
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

  it('two consecutive rejections of an observed password retire the memo, restoring the in-flow ORCID escape', async () => {
    // A memo hit answers "observed", the one answer that never falls back to
    // ORCID, and the memo can outlive the password it vouches for: an ORCID
    // recovery with no new password in another tab drops the password, and a
    // re-login as the same subject keeps this tab's state on purpose. Without
    // a way out, every action then prompts for a password that no longer
    // exists, 401s, re-prompts, and loops until a page reload. Two
    // rejections at the verifying route outrank the memo exactly as one
    // success there outranks the status endpoint.
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    expect(await resolvePasswordFactor()).toEqual({ usesPassword: true, assumed: false });

    // The password is gone: both prompts' mints are rejected.
    mockMintSessionAuthProof.mockRejectedValue(
      Object.assign(new Error('null hash'), { code: 'UNAUTHORIZED' }),
    );
    expect(await ensureSessionWindow()).toEqual({ ready: false, failed: true });
    expect(mockReauthModal.request).toHaveBeenCalledTimes(2);
    expect(mockStartOrcid).not.toHaveBeenCalled();

    // The memo is retired: the next resolution re-reads the status, and with
    // that read unavailable the answer is a guess again, which is what lets
    // the next rejection hand the action to the ORCID round-trip.
    mockFetchEmailStatus.mockRejectedValue(new Error('rate limited'));
    expect(await resolvePasswordFactor()).toEqual({ usesPassword: true, assumed: true });
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(2);

    expect(await ensureSessionWindow()).toEqual({ ready: false, redirect: true });
    expect(mockStartOrcid).toHaveBeenCalledTimes(1);
  });

  it('one rejection, a dismissed re-prompt, or a transport failure on the retry mint leaves the memo standing', async () => {
    // Retirement is reserved for the second consecutive rejection of the
    // password itself. A single typo followed by a dismissed second prompt is
    // not evidence the password is gone, and neither is a retry mint that
    // never reached the verifying route.
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    expect(await resolvePasswordFactor()).toEqual({ usesPassword: true, assumed: false });

    // One rejection, then the second prompt dismissed.
    mockMintSessionAuthProof.mockRejectedValueOnce(
      Object.assign(new Error('wrong password'), { code: 'UNAUTHORIZED' }),
    );
    mockReauthModal.request.mockResolvedValueOnce('typo').mockResolvedValueOnce(null);
    expect(await ensureSessionWindow()).toEqual({ ready: false, cancelled: true });

    // One rejection, then a transport failure on the retry mint.
    mockMintSessionAuthProof
      .mockRejectedValueOnce(Object.assign(new Error('wrong password'), { code: 'UNAUTHORIZED' }))
      .mockRejectedValueOnce(new Error('Failed to fetch'));
    expect(await ensureSessionWindow()).toEqual({ ready: false, failed: true });

    // Neither retired the memo: no second status read.
    expect(await resolvePasswordFactor()).toEqual({ usesPassword: true, assumed: false });
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(1);
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

  // The guard names the whole non-string class, and these rows drive the class
  // the WIRE can put in front of it: four ways a mint can answer without a
  // proof string. The mint callback narrows all four to `undefined` before the
  // guard reads them, so a row proves its own response shape is refused, not
  // that the guard tells four types apart; the cached entry the eviction case
  // seeds is what drives the guard's predicate from the other leg.
  // A Symbol is the least consequential member:
  // `JSON.stringify` omits a Symbol-valued field, so it never reaches the
  // sessionStorage entry (only the in-memory mirror `persistWindow` falls back
  // to on a failed write keeps it) and never reaches the wire either. A mint
  // response simply missing `fresh_auth_proof` is what a backend contract slip
  // actually produces, and a guard narrowed to symbols reads exactly that as a
  // ready window with no proof behind it. The null row is the one value the
  // wire can land in the vocabulary's own sentinel space, the redirect member
  // being `null`, so it reaches the guard at all only because the mint
  // callback narrows a non-string return to `undefined`; handed on as it
  // stands it classifies as a redirect, which this gate and the broadcast
  // unwinder refuse without a word and the upload pre-flight reports as a
  // cancel the user never asked for.
  it.each([
    { label: 'a mint response with no proof field', value: undefined },
    { label: 'a numeric proof', value: 4242 },
    { label: 'a null proof field', value: null },
    { label: 'a sentinel nobody registered', value: Symbol('an outcome nobody registered') },
  ])('an acquisition result the vocabulary does not name refuses the work: $label', async ({ value }) => {
    // Classification is a lookup, so a result nobody registered classifies to
    // nothing — and the quiet direction is the dangerous one: read as a ready
    // window, an unclassified result travels on AS the proof and dead-ends
    // downstream with nothing the user can answer. Which way it dead-ends
    // depends on its truthiness; the split itself is spelled out at
    // `ensureSessionWindow`'s fail-closed guard, and each case in this table
    // exercises one side of it. Refusing costs one re-auth act and says so.
    mockMintSessionAuthProof.mockImplementation(async () => ({
      ...issuance('window-proof'),
      fresh_auth_proof: value,
    }));

    expect(await ensureSessionWindow()).toEqual({ ready: false, failed: true });

    // And the refusal reaches the user, rather than ending as the silence this
    // block is named for.
    mockToastStore.show.mockClear();
    expect(await freshAuthWindowReady()).toBe(false);
    expect(mockToastStore.show).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it('the refusal evicts the entry that caused it', async () => {
    // Both legs that can produce a non-string run through the window slot, and
    // neither type-checks what goes through it: the cache read passes back any
    // token that is not FALSY, and the mint writes its response value in
    // before narrowing what it hands back. So refusing without clearing leaves
    // the entry to be re-read and re-refused for the rest of its idle life,
    // with retrying no way out. This case seeds the cache leg, where the entry
    // outlives the acquisition that produced it and a number survives the
    // round-trip through storage. Before the guard existed that value went to
    // the network, drew a remintable rejection, and the upload retry's own
    // clear healed it.
    seedWindow(4242, { idleInMs: IDLE_MS });

    expect(await ensureSessionWindow()).toEqual({ ready: false, failed: true });
    expect(cached()).toBeNull();

    // And the next attempt is an ordinary acquisition rather than a second
    // refusal of the same poisoned entry.
    expect(await ensureSessionWindow()).toEqual({ ready: true, proof: 'window-proof' });
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

describe('the broadcast path leaves no poisoned window behind', () => {
  beforeEach(() => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
  });

  // Two rows, chosen for REACHABILITY rather than for illustrating the type: a
  // number and an object are what a backend contract slip can actually put in
  // the slot, since both survive the JSON round-trip through `sessionStorage`
  // and both read as truthy, which is what makes the entry stick. A Symbol
  // would be the tidier illustration and the wrong pin: `JSON.stringify` omits
  // it, so the next read drops the entry as tokenless on its own and a check
  // narrowed to numbers would still look covered.
  it.each([
    { label: 'a numeric token', value: 4242 },
    { label: 'an object token', value: { not: 'a proof' } },
  ])('an entry the vocabulary does not name is evicted, not re-refused on every later action: $label', async ({ value }) => {
    // `acquisitionAborted` applies the same string test the acquire-before-commit
    // gate does, and for a long time it was the only reading that did not clear.
    // A refusal that leaves its own cause readable is a lockout: the next vote,
    // comment and review each re-read the entry and each abort in silence, with
    // no way out until the idle deadline arrives, a sign-out scrubs the slot, or
    // an unrelated page gate or upload pre-flight happens to run the eviction.
    seedWindow(value, { idleInMs: IDLE_MS });

    expect(await broadcastWithFreshAuth('alice', [['vote', {}]])).toBeNull();
    expect(mockBroadcastOps).not.toHaveBeenCalled();
    expect(cached()).toBeNull();

    // And the action after it is an ordinary acquisition rather than a second
    // silent refusal of the same entry.
    await broadcastWithFreshAuth('alice', [['vote', {}]]);
    expect(mockBroadcastOps.mock.calls[0][2]).toMatchObject({ freshAuthProof: 'window-proof' });
  });

  it.each([
    { label: 'a numeric proof', value: 4242 },
    { label: 'an object proof', value: { not: 'a proof' } },
  ])('a mint that answers without a proof string strands nothing in the slot either: $label', async ({ value }) => {
    // The mint leg poisons the slot on its way past: the response value is
    // written through `cacheSessionProof` even though the acquisition narrows
    // a non-string one out of what it hands back, so the entry outlives the
    // value. Evicting only what the cache leg produced would refuse this
    // action and still strand the one after it.
    mockMintSessionAuthProof.mockImplementationOnce(async () => ({
      ...issuance('window-proof'),
      fresh_auth_proof: value,
    }));

    expect(await broadcastWithFreshAuth('alice', [['vote', {}]])).toBeNull();
    expect(mockBroadcastOps).not.toHaveBeenCalled();
    expect(cached()).toBeNull();

    await broadcastWithFreshAuth('alice', [['vote', {}]]);
    expect(mockBroadcastOps.mock.calls[0][2]).toMatchObject({ freshAuthProof: 'window-proof' });
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

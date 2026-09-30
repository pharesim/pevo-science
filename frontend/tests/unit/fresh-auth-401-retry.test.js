// Tests for `broadcastWithFreshAuth` error-recovery paths in
// `frontend/src/lib/fresh-auth.js`.
//
// Mocking justification (clause-a of project-CLAUDE.md
// "Carve-out for deterministic edge-case coverage"):
// `signer.js#broadcastOps` performs real fetch() against the backend
// `/api/custody/broadcast` endpoint. Exercising the real path per-test
// would require a running backend + Hive + ORCID stack and the ability
// to induce specific FRESH_AUTH_REQUIRED status/reason combinations
// (401 missing/expired/malformed; 403 username_mismatch). That setup
// belongs to the E2E layer, and no spec there induces those rejections
// against broadcastWithFreshAuth itself (the e2e controls induce a 401
// refusal and a 403 kind_mismatch through Playwright's request fixture,
// outside the SPA; username_mismatch is induced nowhere). Here we
// mock signer.broadcastOps so we can deterministically trigger each
// error shape and assert the wrapper's branching: dropping the dead
// window, re-authing, retrying, disconnecting, toasting.
//
// Auth-focus carve-out (clause-b): broadcastWithFreshAuth is not an
// auth-verification path itself — it consumes window proofs minted
// upstream and reacts to backend rejections. Cryptographic verification
// is performed server-side. No frontend auth middleware is mocked.
//
// Clause-c real-path companion: `frontend/tests/e2e/non-consent-fresh-auth.spec.js`
// drives `broadcastWithFreshAuth` against the real backend on the happy
// path. A light account's vote acquires the window through the real
// POST /custody/session-auth, and the real POST /custody/broadcast
// carries it, passes the fresh-auth gate, and stops at the seeded
// account's posting-key availability guard, before the decrypt; a
// tampered proof through the same route
// is refused at the gate, and the same window is accepted again on a
// replay. The 401-retry, the username_mismatch teardown, and the
// redirect-posture branches this suite pins have no real-path companion:
// no e2e spec closes or corrupts a window on a broadcast the SPA itself
// issues (the controls go through Playwright's request fixture, so this
// wrapper's branching never runs). The per-action mint the settings
// surface exercises for real
// (`frontend/tests/e2e/settings.spec.js`,
// `frontend/tests/e2e/settings-orcid-factor.spec.js`) is the consent-op
// kind, not the window this wrapper consumes.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockBroadcastOps = vi.fn();
const mockStartOrcid = vi.fn();
const mockFetchEmailStatus = vi.fn();
const mockMintSessionAuthProof = vi.fn();
const mockAuthStore = {
  custody: 'light', username: 'alice', token: 'jwt-abc', isConnected: true, disconnect: vi.fn(),
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
const PROMPT_BUSY_SENTINEL = 'LOCALIZED-prompt-busy-sentinel';
const REAUTH_REQUIRED_SENTINEL = 'LOCALIZED-reauth-required-sentinel';
const TEARDOWN_CANCEL_SENTINEL = 'LOCALIZED-teardown-cancel-sentinel';
const mockI18nStore = {
  messages: {
    auth: { sessionInconsistency: LOCALIZED_SENTINEL, reauthCancelled: TEARDOWN_CANCEL_SENTINEL },
    settings: { reauthFailed: REAUTH_FAILED_SENTINEL },
    common: { reauthPromptOpen: PROMPT_BUSY_SENTINEL, reauthRequired: REAUTH_REQUIRED_SENTINEL },
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

const {
  broadcastWithFreshAuth,
  freshAuthWindowReady,
  FRESH_AUTH_REDIRECT_PENDING,
  WINDOW_OUTCOME_KEYS,
  showWindowOutcomeToast,
  clearPasswordFactorMemo,
  abandonInFlightAcquisitions,
} = await import('../../src/lib/fresh-auth.js');

// Real timers in this file; a macrotask hop lets a parked acquisition advance
// to the await currently blocking it.
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const { REAUTH_PROMPT_BUSY } = await import('../../src/components/reauth-modal.js');

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

// The production disconnect in full, as far as this module can see it: the
// liveness flag drops and the subject scrub abandons every flight in the air.
function scrubbingDisconnect() {
  mockAuthStore.isConnected = false;
  abandonInFlightAcquisitions();
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
    // The store's liveness flag moves the way the real disconnect moves it, so
    // a teardown leaves the store looking torn down to whoever reads it next.
    // Installed per test: the store object is shared across the file, and a
    // flag left false would silence every later detection.
    mockAuthStore.isConnected = true;
    mockAuthStore.disconnect.mockImplementation(() => { mockAuthStore.isConnected = false; });
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

  it('a teardown between the first attempt and the 401 retry re-acquires nothing for the new subject', async () => {
    // The retry's re-acquisition reads the store at call time: after a
    // cross-tab login as someone else, an unguarded retry would read the NEW
    // subject's factor, prompt them with the generic re-auth message, spend
    // their mint, and broadcast the departed subject's operations under their
    // name. The guard opened at entry is the only cross-attempt memory of
    // which subject the broadcast belongs to, so the retry must refuse and
    // report rather than re-acquire.
    setWindow('doomed-by-teardown');
    mockBroadcastOps.mockImplementationOnce(async () => {
      abandonInFlightAcquisitions();
      throw freshAuthError(401, 'expired');
    });

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    // One attempt, no retry: nothing was re-acquired for the new subject.
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(mockReauthModal.request).not.toHaveBeenCalled();
    expect(mockMintSessionAuthProof).not.toHaveBeenCalled();
    expect(mockFetchEmailStatus).not.toHaveBeenCalled();
    // The teardown reported exactly once, with its own message — not the
    // generic re-auth copy a fresh prompt would have carried.
    expect(mockToastStore.show).toHaveBeenCalledTimes(1);
    expect(mockToastStore.show).toHaveBeenCalledWith(TEARDOWN_CANCEL_SENTINEL, 'error');
  });

  it('a mismatch teardown is not talked over by the flights it abandoned', async () => {
    // handleSessionInconsistency disconnects, which runs the subject scrub and
    // so abandons every acquisition in flight. Its own message is the one the
    // user needs. A gate parked at its factor read resumes into a torn-down
    // guard, and without the teardown claim it would stack a second, vaguer
    // message on top of a report the user has already been given.
    //
    // The window is seeded short: past the gate's pre-flight margin (so the
    // gate acquires cold and parks) but still live for the broadcast, whose
    // acquisition takes no margin at all.
    mockAuthStore.disconnect.mockImplementation(scrubbingDisconnect);
    // The tab-lifetime factor memo would answer the gate's status question
    // without a round-trip, leaving nothing parked for the teardown to land in.
    clearPasswordFactorMemo();
    setWindow('about-to-close', { idleMs: 30_000 });
    let resolveStatus;
    mockFetchEmailStatus.mockReturnValueOnce(new Promise((resolve) => { resolveStatus = resolve; }));

    const gate = freshAuthWindowReady();
    await tick(); // the gate's factor read is now parked
    mockBroadcastOps.mockRejectedValueOnce(freshAuthError(403, 'username_mismatch'));
    const broadcast = await broadcastWithFreshAuth('alice', [['vote', {}]]);

    resolveStatus({ status: 'ok', data: { hasPassword: true } });
    expect(await gate).toBe(false);
    expect(broadcast).toBe(FRESH_AUTH_REDIRECT_PENDING);
    // Exactly one message, and it is the teardown's own.
    expect(mockToastStore.show).toHaveBeenCalledTimes(1);
    expect(mockToastStore.show).toHaveBeenCalledWith(LOCALIZED_SENTINEL, 'error');
  });

  it('two flights detecting the same corrupted session tear down and report once', async () => {
    // To the user, one corrupted session is one incident however many
    // requests were in the air when it surfaced. Each detector's disconnect
    // would run the scrub again and mint a generation the teardown claim has
    // never seen, so the claim cannot collapse them; the store's liveness is
    // what tells the second detector the work is done.
    mockAuthStore.disconnect.mockImplementation(scrubbingDisconnect);
    setWindow('proof-x');
    let rejectFirst;
    let rejectSecond;
    mockBroadcastOps
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }))
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectSecond = reject; }));

    const first = broadcastWithFreshAuth('alice', [['vote', {}]]);
    const second = broadcastWithFreshAuth('alice', [['vote', {}]]);
    await tick();
    // Both flights are parked in their broadcast, so both guards pre-date the
    // teardown and neither unwinds through its guard instead of detecting.
    expect(mockBroadcastOps).toHaveBeenCalledTimes(2);

    rejectFirst(freshAuthError(403, 'username_mismatch'));
    rejectSecond(freshAuthError(403, 'username_mismatch'));

    expect(await first).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(await second).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockAuthStore.disconnect).toHaveBeenCalledTimes(1);
    expect(mockToastStore.show).toHaveBeenCalledTimes(1);
    expect(mockToastStore.show).toHaveBeenCalledWith(LOCALIZED_SENTINEL, 'error');
  });

  it('a mismatch landing on a session that was ended in silence still says one word', async () => {
    // A sign-out (this tab's, or another tab's arriving over the storage
    // event) disconnects without a message of its own. A mismatch that lands
    // afterwards finds nothing left to tear down, and its caller still returns
    // the already-reported shape, so a bare return here would end the action
    // with no word at all. The re-login message would be wrong too: the user
    // was not thrown out, they left.
    setWindow('proof-x');
    let rejectBroadcast;
    mockBroadcastOps.mockImplementationOnce(
      () => new Promise((_, reject) => { rejectBroadcast = reject; }),
    );

    const pending = broadcastWithFreshAuth('alice', [['vote', {}]]);
    await tick();
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    scrubbingDisconnect(); // the sign-out, which shows nothing

    rejectBroadcast(freshAuthError(403, 'username_mismatch'));

    expect(await pending).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockAuthStore.disconnect).not.toHaveBeenCalled();
    expect(mockToastStore.show).toHaveBeenCalledTimes(1);
    expect(mockToastStore.show).toHaveBeenCalledWith(TEARDOWN_CANCEL_SENTINEL, 'error');
  });

  it('a late 401 from a departed subject leaves the successor\'s window alone', async () => {
    // The dead-window eviction above is right for the flight that owns the
    // window, and wrong the instant that flight is no longer the tab's. The
    // subject scrub evicts this flight's window before it bumps the
    // generation, so once the guard reads torn-down the only entry that can
    // be in the cache was minted by whoever the tab represents NOW. Evicting
    // it charges the successor a re-auth act for a rejection that was never
    // theirs.
    setWindow('doomed-by-teardown');
    mockBroadcastOps.mockImplementationOnce(async () => {
      abandonInFlightAcquisitions(); // the scrub's generation bump
      setWindow('successor-window'); // the next subject opened their own
      throw freshAuthError(401, 'expired');
    });

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    // Read the raw entry first: an eviction leaves null, and asserting on the
    // parsed token would surface that as a TypeError instead of a diff.
    const survivor = sessionStorage.getItem(PROOF_KEY);
    expect(survivor).not.toBeNull();
    expect(JSON.parse(survivor).token).toBe('successor-window');
    // The departed flight still unwinds without re-acquiring, reporting once.
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(mockToastStore.show).toHaveBeenCalledTimes(1);
    expect(mockToastStore.show).toHaveBeenCalledWith(TEARDOWN_CANCEL_SENTINEL, 'error');
  });

  it('a response landing after a subject change does not slide the successor\'s window', async () => {
    // The mirror image of the eviction above. The window slot is a single
    // unkeyed entry with no subject binding, so once the guard reads torn-down
    // the only window that can be in it was minted by whoever the tab
    // represents NOW. Replaying the idle slide on the departed subject's
    // response would re-anchor that window and extend the successor's
    // deadline on traffic that was never theirs.
    setWindow('doomed-by-teardown');
    const successorDeadline = Date.now() + 30_000;
    mockBroadcastOps.mockImplementationOnce(async () => {
      abandonInFlightAcquisitions(); // the scrub's generation bump
      // The successor's window, half its idle period already spent: a slide
      // would push its deadline out to a full period from now.
      sessionStorage.setItem(PROOF_KEY, JSON.stringify({
        token: 'successor-window',
        expiresAt: new Date(successorDeadline).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        idlePeriodMs: 60_000,
      }));
      return { tx_id: 'landed-late' };
    });

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

    // The broadcast itself went through; only the slide is withheld.
    expect(result).toEqual({ tx_id: 'landed-late' });
    const survivor = JSON.parse(sessionStorage.getItem(PROOF_KEY));
    expect(survivor.token).toBe('successor-window');
    expect(new Date(survivor.expiresAt).getTime()).toBe(successorDeadline);
  });

  it('username_mismatch on the 401 retry tears down too, not just on the first attempt', async () => {
    // The retry leg is a separately deletable branch. Its shape-preserving
    // rethrow matches a mismatch (the signer error carries both status and
    // code), so the mismatch used to reach the call site's generic op-failure
    // message with the corrupted session left standing — the first-attempt
    // branch below never sees it, because it inspects the FIRST error, which
    // by construction is the remintable 401 that opened the retry.
    setWindow('proof-r');
    mockBroadcastOps
      .mockRejectedValueOnce(freshAuthError(401, 'expired'))
      .mockRejectedValueOnce(freshAuthError(403, 'username_mismatch'));

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockAuthStore.disconnect).toHaveBeenCalledTimes(1);
    // Exactly one message: the teardown's. A second would mean the unwind
    // reported twice for one failure.
    expect(mockToastStore.show).toHaveBeenCalledTimes(1);
    expect(mockToastStore.show).toHaveBeenCalledWith(LOCALIZED_SENTINEL, 'error');
    expect(mockBroadcastOps).toHaveBeenCalledTimes(2);
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

  it('a prompt owned by another action refuses the broadcast WITH the busy toast', async () => {
    // The reauth modal is a singleton; a consent-op or settings prompt already
    // open resolves this acquisition to the busy sentinel. Dropping that in
    // silence would lose the action with no feedback — the ambiguity the
    // sentinel exists to remove.
    mockReauthModal.request.mockResolvedValue(REAUTH_PROMPT_BUSY);

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockBroadcastOps).not.toHaveBeenCalled();
    expect(mockToastStore.show).toHaveBeenCalledWith(PROMPT_BUSY_SENTINEL, 'error');
  });

  it('a dismissed prompt at acquisition aborts with NO toast — busy and cancel discriminate', async () => {
    // The paired case: a cancel is the user's own decision to stop and
    // warrants no message. If this one ever toasts, the busy branch above has
    // stopped discriminating.
    mockReauthModal.request.mockResolvedValue(null);

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockBroadcastOps).not.toHaveBeenCalled();
    expect(mockToastStore.show).not.toHaveBeenCalled();
  });

  it('a busy refusal at the 401 retry gate also toasts instead of dropping silently', async () => {
    // The retry gate re-acquires through the same path, so it owes the same
    // message when the modal is owned by a different action mid-retry.
    setWindow('proof-b');
    mockBroadcastOps.mockRejectedValueOnce(freshAuthError(401, 'expired'));
    mockReauthModal.request.mockResolvedValue(REAUTH_PROMPT_BUSY);

    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(mockToastStore.show).toHaveBeenCalledWith(PROMPT_BUSY_SENTINEL, 'error');
  });

  it('a passwordless remintable 401 with redirect suppressed refuses with the toast instead of navigating', async () => {
    // The post-upload posture: publish and edit pass `allowRedirect: false`
    // because the completed pins live in submit-handler locals. When the
    // window dies between their suppressed pre-broadcast gate and the
    // broadcast (another tab's custody upgrade or password reset closes open
    // windows server-side), the 401 retry's re-acquisition must inherit the
    // suppression: a passwordless account gets the re-authenticate toast, not
    // the full-page ORCID round-trip that discards the pins.
    clearPasswordFactorMemo();
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
    setWindow('doomed-proof');
    mockBroadcastOps.mockRejectedValueOnce(freshAuthError(401, 'expired'));

    const result = await broadcastWithFreshAuth('alice', [['comment', {}]], { allowRedirect: false });

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    // One attempt, no retry: the suppressed re-acquisition refused.
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(mockReauthModal.request).not.toHaveBeenCalled();
    expect(mockToastStore.show).toHaveBeenCalledWith(REAUTH_REQUIRED_SENTINEL, 'error');
  });

  it('a suppressed call with no window at all refuses up front, before any broadcast', async () => {
    // The initial acquisition threads the same posture as the retry's: a
    // passwordless caller that forbids navigation and holds no live window is
    // refused with the toast rather than bounced to ORCID or silently sent
    // into a broadcast that must 401.
    clearPasswordFactorMemo();
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });

    const result = await broadcastWithFreshAuth('alice', [['comment', {}]], { allowRedirect: false });

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockBroadcastOps).not.toHaveBeenCalled();
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(mockToastStore.show).toHaveBeenCalledWith(REAUTH_REQUIRED_SENTINEL, 'error');
  });

  it('the permissive default still hands a passwordless 401 retry to the ORCID round-trip', async () => {
    // Control for the suppressed pair above: the call sites outside the
    // publish and edit submit sequences pass no option, and for them the
    // navigating factor remains the way through. Pins-at-risk suppression is
    // opt-in, not a new global posture.
    clearPasswordFactorMemo();
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
    mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
    vi.stubGlobal('window', { ...globalThis.window, location: { href: '', pathname: '/paper/alice/p1' } });
    try {
      setWindow('doomed-proof');
      mockBroadcastOps.mockRejectedValueOnce(freshAuthError(401, 'expired'));

      const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

      expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
      expect(mockStartOrcid).toHaveBeenCalledTimes(1);
      expect(window.location.href).toBe('https://orcid.org/oauth/authorize?x=1');
      expect(mockToastStore.show).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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

  describe('what the refusal tells the user', () => {
    // Two things are pinned here. First, that an acquisition result the
    // vocabulary does not name refuses the broadcast OUT LOUD: it classifies
    // to nothing, and a null key is what the shared dispatch keeps silent for
    // a ready outcome, so the unwinder used to drop this one class without a
    // word while `ensureSessionWindow` reported the same condition as a
    // re-auth failure. Second, that giving it a voice changed nothing for the
    // members that were already registered — driven from the vocabulary
    // itself, so a member added later cannot slip past unasserted.

    // Every registered member, paired with an arrangement that drives it out
    // of a real acquisition inside `broadcastWithFreshAuth`, and the options
    // that posture needs. The key set is checked against WINDOW_OUTCOME_KEYS
    // below rather than trusted.
    //
    // `evidence` is what keeps a row from passing on the wrong member. The
    // comparison against the shared dispatch discriminates the three members
    // that speak, since their three messages differ — but `redirect` and
    // `cancelled` are both deliberately silent, so an arrangement that quietly
    // produced the other one would match anyway. Each row therefore pins a
    // second observable the two do not share: whether a round-trip started,
    // and whether the modal was asked at all.
    const BROADCAST_ROUTE_BY_OUTCOME = {
      // The passwordless factor navigates, and the round-trip in flight is
      // the outcome.
      redirect: {
        opts: {},
        arrange: () => {
          clearPasswordFactorMemo();
          mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
          mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
        },
        evidence: () => {
          expect(mockStartOrcid).toHaveBeenCalledTimes(1);
          expect(window.location.href).toBe('https://orcid.org/oauth/authorize?x=1');
        },
      },
      // The user dismissed the password prompt.
      cancelled: {
        opts: {},
        arrange: () => { mockReauthModal.request.mockResolvedValue(null); },
        evidence: () => {
          expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
          expect(mockStartOrcid).not.toHaveBeenCalled();
        },
      },
      // Two consecutive rejections of the password: the re-prompt is spent.
      failed: {
        opts: {},
        arrange: () => {
          mockMintSessionAuthProof.mockRejectedValue(
            Object.assign(new Error('bad password'), { code: 'UNAUTHORIZED' }),
          );
        },
        evidence: () => { expect(mockReauthModal.request).toHaveBeenCalledTimes(2); },
      },
      // Another action's prompt owns the singleton modal.
      busy: {
        opts: {},
        arrange: () => { mockReauthModal.request.mockResolvedValue(REAUTH_PROMPT_BUSY); },
        evidence: () => { expect(mockReauthModal.request).toHaveBeenCalledTimes(1); },
      },
      // A passwordless account on a call site that forbids navigation.
      reauthRequired: {
        opts: { allowRedirect: false },
        arrange: () => {
          clearPasswordFactorMemo();
          mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
        },
        evidence: () => {
          expect(mockStartOrcid).not.toHaveBeenCalled();
          expect(mockReauthModal.request).not.toHaveBeenCalled();
        },
      },
    };

    it('routes every registered vocabulary member, and no phantom ones', () => {
      // Key-set equality both ways. A member added to the vocabulary with no
      // route here would go unasserted at the unwinder, which is exactly the
      // silent drop this block exists to close; a route for a member that no
      // longer exists is dead arrangement.
      expect(Object.keys(BROADCAST_ROUTE_BY_OUTCOME).sort()).toEqual(
        [...WINDOW_OUTCOME_KEYS].sort(),
      );
    });

    it.each(WINDOW_OUTCOME_KEYS)(
      'a registered member says through the unwinder exactly what the dispatch says: %s',
      async (key) => {
        // The expectation is READ from the shared dispatch rather than copied
        // here, so a member's message and its deliberate silence are pinned
        // without either being restated: whatever `showWindowOutcomeToast`
        // does for this member is what the broadcast path must do, and the
        // two move together when the copy changes.
        vi.stubGlobal('window', {
          ...globalThis.window,
          location: { href: '', pathname: '/paper/alice/p1' },
        });
        try {
          const { arrange, opts, evidence } = BROADCAST_ROUTE_BY_OUTCOME[key];
          arrange();

          const result = await broadcastWithFreshAuth('alice', [['vote', {}]], opts);
          const throughUnwinder = [...mockToastStore.show.mock.calls];

          mockToastStore.show.mockClear();
          showWindowOutcomeToast(key);
          const throughDispatch = [...mockToastStore.show.mock.calls];

          expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
          expect(mockBroadcastOps).not.toHaveBeenCalled();
          evidence();
          expect(throughUnwinder).toEqual(throughDispatch);
        } finally {
          vi.unstubAllGlobals();
        }
      },
    );

    // The two legs that can carry a non-string out of an acquisition.
    // `evictUnnamedAcquisition` drops the entry behind the refusal, so neither
    // leg leaves a stuck entry for a later action to re-read: a poisoned window
    // costs one action and the next acquires normally. What recurs is the mint
    // leg. A mint that keeps answering without a proof string prompts for the
    // password on every broadcast action and refuses every one, and
    // answering correctly to be told nothing, per action, is what silence here
    // costs.
    it.each([
      {
        label: 'an entry the window slot handed back',
        arrange: () => { setWindow(4242); },
      },
      {
        label: 'a mint that answered without a proof string',
        arrange: () => {
          mockMintSessionAuthProof.mockResolvedValue({
            ...issuance('unused'),
            fresh_auth_proof: { not: 'a proof' },
          });
        },
      },
    ])('a result the vocabulary does not name refuses the broadcast and says why: $label', async ({ arrange }) => {
      arrange();

      const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

      expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
      expect(mockBroadcastOps).not.toHaveBeenCalled();
      // Exactly once: the unwinder is reached at the initial acquisition and
      // at the 401 retry's re-acquisition, and the second is only reachable
      // when the first handed back a real proof string, so one action can
      // never collect two of these.
      expect(mockToastStore.show).toHaveBeenCalledTimes(1);
      expect(mockToastStore.show).toHaveBeenCalledWith(REAUTH_FAILED_SENTINEL, 'error');
    });

    it('the 401 retry gate owes the same message when ITS re-acquisition is unnamed', async () => {
      // The other reading of a raw acquisition result inside this wrapper. A
      // window that dies server-side puts the user through a re-auth act, and
      // a mint answering without a proof string then loses the action; the
      // first attempt's proof was real, so this leg is the only one that
      // speaks.
      setWindow('doomed-proof');
      mockBroadcastOps.mockRejectedValueOnce(freshAuthError(401, 'expired'));
      mockMintSessionAuthProof.mockResolvedValue({
        ...issuance('unused'),
        fresh_auth_proof: 4242,
      });

      const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

      expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
      expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
      expect(mockToastStore.show).toHaveBeenCalledTimes(1);
      expect(mockToastStore.show).toHaveBeenCalledWith(REAUTH_FAILED_SENTINEL, 'error');
    });
  });
});

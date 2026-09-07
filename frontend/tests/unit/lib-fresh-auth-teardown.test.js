// Coverage for the subject-bound TEARDOWN of the session-kind re-auth window in
// `frontend/src/lib/fresh-auth.js`: what an acquisition parked mid-flight does
// when the subject it was started for is scrubbed out from under it (a logout,
// or a cross-user login in the same tab), and what it must leave alone.
//
// A torn-down flight resumes at whichever await boundary it was parked on: the
// factor read, the open prompt, the mint round-trip, the ORCID start
// round-trip. At every one of them it must unwind as a clean cancel — no late
// issuance cached, no navigation on the departed subject's behalf, no mint
// spent on the tab's current credentials, no eviction of the successor flight
// from the in-flight slot, no removal of the successor's flow keys — and the
// user is told exactly once, however many flights one scrub abandons. The one
// boundary past acquisition, the upload transfer, is different: a transfer the
// scrub lands inside still completes and its result still reaches the caller,
// but the departed subject's upload may not re-anchor the idle deadline of
// whatever window the successor has minted since. The sibling
// `lib-fresh-auth-session-window.test.js` covers the window itself (factor
// selection, the acquire-before-commit gate, the two-deadline model) over this
// same scaffolding.
//
// Mocking justification (clause-a of project-CLAUDE.md "Carve-out for
// deterministic edge-case coverage"): `fetchEmailStatus`, `mintSessionAuthProof`,
// `startOrcid` and `uploadFileToIpfs` perform real fetch() against the backend.
// The cases here park a flight on one of those round-trips and land the scrub
// while it is parked, which needs each round-trip to settle on the test's
// signal rather than the network's. The upload transport is mocked for the
// same reason; two cases drive the real `lib/ipfs-upload.js` over this suite's
// real acquisition, to pin which teardown boundary speaks and how often, and
// that a retry landing late does not re-anchor the successor's window (the
// upload suite's own guard is a stand-in that cannot tell the entry guard from
// one opened after the transfer). Asserting that a torn-down flight performs
// NO navigation requires observing `window.location` rather than following it.
// `signer.js#broadcastOps` is mocked because it is a module-load dependency of
// the real `fresh-auth.js`; no case here broadcasts.
//
// Auth-focus carve-out (clause-b): no auth middleware is mocked and no
// cryptographic verification is bypassed — the proof is minted and verified
// server-side; these tests assert what the client does with a flight whose
// subject is gone.
//
// Clause-c real-path companion: none exists for this suite's risk class. No
// e2e spec changes subject while a fresh-auth acquisition is parked, and the
// e2e follow-up filed for the sibling session-window suite (a light-account
// broadcast or upload carrying a window proof) does not reach a scrub landing
// mid-flight either. The scrub these cases stage by hand is composed for real
// only in `src/auth.js` (`_scrubSubjectBoundState`), and that store's own suite
// stubs the in-flight abandonment the composition calls into.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockStartOrcid = vi.fn();
const mockFetchEmailStatus = vi.fn();
const mockMintSessionAuthProof = vi.fn();
// The upload leg's transport. The real `lib/ipfs-upload.js` runs over the real
// acquisition here, so only its wire call is stubbed.
const mockUploadFileToIpfs = vi.fn();
const mockReauthModal = { request: vi.fn() };
const mockToastStore = { show: vi.fn() };
const mockAuthStore = { custody: 'light', username: 'alice', disconnect: vi.fn() };

vi.mock('../../src/signer.js', () => ({
  broadcastOps: vi.fn(),
}));

vi.mock('../../src/api.js', () => ({
  startOrcid: (...args) => mockStartOrcid(...args),
  consentOpRequestFields: (t) => t,
  fetchEmailStatus: (...args) => mockFetchEmailStatus(...args),
  mintSessionAuthProof: (...args) => mockMintSessionAuthProof(...args),
  uploadFileToIpfs: (...args) => mockUploadFileToIpfs(...args),
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
  ensureSessionWindow,
  freshAuthWindowReady,
  cacheSessionProof,
  clearCachedSessionProof,
  clearPasswordFactorMemo,
  resolvePasswordFactor,
  abandonInFlightAcquisitions,
} = await import('../../src/lib/fresh-auth.js');
// The real upload pre-flight, over the real acquisition above: the two
// together are what decide whether a teardown mid-acquisition reaches the user.
const { uploadFile, describeUploadError, UPLOAD_SUBJECT_CHANGED } = await import(
  '../../src/lib/ipfs-upload.js'
);
// The storage half of the subject scrub, plus the two flow keys the redirect
// starter writes and the teardown cases below read back — all from the shared
// single source of truth, so neither the staged teardown nor the assertions can
// drift from the keys the module actually uses. The module is dependency-free,
// so importing it here cannot disturb this suite's partial api.js / alpinejs
// mocks.
const { ORCID_MODE_KEY, RETURN_PATH_KEY, SUBJECT_BOUND_STORAGE_KEYS } = await import(
  '../../src/lib/subject-bound-keys.js'
);

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
  // Stub window.location so a redirect assignment is observable and does not
  // trigger jsdom navigation. Mirrors lib-fresh-auth-settings-orcid.test.js.
  vi.stubGlobal('window', { ...globalThis.window, location: { href: '', pathname: '/publish' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('teardown abandons in-flight acquisitions', () => {
  // The subject-bound scrub that runs on logout and on a cross-user login
  // clears the proof caches, abandons the module-level in-flight state, and
  // removes every subject-bound storage key as one act (the auth store's
  // `_scrubSubjectBoundState` routes all of it through itself). These tests
  // drive the fresh-auth half directly, staged the way that scrub composes it —
  // the key loop included, because a case asserting what a torn-down flight
  // leaves in sessionStorage proves nothing unless the teardown it staged is
  // what emptied those keys. One piece of the real scrub is deliberately left
  // out: `dismissOpenReauthPrompt()`, because several cases below hold the
  // prompt open and resolve it by hand to control when a flight resumes.
  function teardownSubjectState() {
    clearCachedSessionProof();
    clearPasswordFactorMemo();
    abandonInFlightAcquisitions();
    for (const key of SUBJECT_BOUND_STORAGE_KEYS) sessionStorage.removeItem(key);
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
    // subject's behalf. The flight resolves as a clean cancel instead. The
    // flow keys read null because the staged teardown removed them, the way
    // `_scrubSubjectBoundState` does; the starter's own unwind is not what
    // empties them, and the two cases below are what hold it to that.
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
    expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBeNull();
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBeNull();
    // Nothing downstream speaks for this unwind: the flight resolves the same
    // `cancelled` outcome a user's own dismissal produces, and the shared
    // table keeps that one silent. Without a report here the user watches a
    // full-page round-trip they asked for simply not happen.
    expect(mockToastStore.show).toHaveBeenCalledTimes(1);
  });

  // The two cases below are the other half of that boundary: what the departed
  // flight must NOT do on its way out. Both stage a successor ORCID flow in the
  // same tab after the teardown, because that is the only state in which the
  // flow keys are populated when the stale flight resumes — the scrub emptied
  // the ones this flight wrote before it ever got control back.
  it('a stale start resolving mid-successor leaves the successor its own flow keys', async () => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
    let resolveStale;
    let resolveSuccessor;
    mockStartOrcid
      .mockReturnValueOnce(new Promise((resolve) => { resolveStale = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSuccessor = resolve; }));

    const stale = ensureSessionWindow();
    await tick(); // the previous subject's startOrcid round-trip is pending

    teardownSubjectState();

    // The successor is a fresh flow under the new subject, started from a
    // different page so its return path is distinguishable from the one the
    // departed flight wrote.
    window.location.pathname = '/papers/alice/a-discovery';
    const successor = ensureSessionWindow();
    await tick(); // the successor wrote its own flow keys and is parked on its start
    expect(mockStartOrcid).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBe('session_auth');
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBe('/papers/alice/a-discovery');

    resolveStale({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
    expect(await stale).toEqual({ ready: false, cancelled: true });

    // The stale flight cancels silently past the keys: they are the successor's
    // now, and removing them would send the successor to ORCID with no mode
    // marker, so `completeOrcid` would post the callback unauthenticated and
    // the round-trip would dead-end on return.
    expect(window.location.href).toBe('');
    expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBe('session_auth');
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBe('/papers/alice/a-discovery');

    resolveSuccessor({ redirect_url: 'https://orcid.org/oauth/authorize?x=2' });
    expect(await successor).toEqual({ ready: false, redirect: true });
    expect(window.location.href).toBe('https://orcid.org/oauth/authorize?x=2');
  });

  it('a stale start REJECTING mid-successor leaves the successor its own flow keys', async () => {
    // The start round-trip carries a 30s timeout and nothing aborts it when the
    // subject changes, so a rejection is at least as likely an ending for a
    // flight that outlived its subject as a late resolution. The rejection
    // unwind runs before the staleness re-check, so it needs the same rule.
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
    let rejectStale;
    let resolveSuccessor;
    mockStartOrcid
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectStale = reject; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSuccessor = resolve; }));

    const stale = ensureSessionWindow();
    await tick();

    teardownSubjectState();

    window.location.pathname = '/papers/alice/a-discovery';
    const successor = ensureSessionWindow();
    await tick();
    expect(mockStartOrcid).toHaveBeenCalledTimes(2);

    rejectStale(Object.assign(new Error('signal timed out'), { code: 'TIMEOUT' }));
    // The rejection still escapes the departed flight (the page-level gate is
    // what turns it into a refusal); what it may not do is take the successor's
    // keys with it.
    await expect(stale).rejects.toThrow('signal timed out');

    expect(window.location.href).toBe('');
    expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBe('session_auth');
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBe('/papers/alice/a-discovery');

    resolveSuccessor({ redirect_url: 'https://orcid.org/oauth/authorize?x=2' });
    expect(await successor).toEqual({ ready: false, redirect: true });
    expect(window.location.href).toBe('https://orcid.org/oauth/authorize?x=2');
  });

  it('one teardown across two cross-posture flights still reports exactly once', async () => {
    // The acquisition slots are keyed on the redirect posture, so a page can
    // hold two cold flights at once: its own submit gate (permissive) and the
    // editor's inline-image upload (suppressed). They share ONE coalesced
    // factor read, so one subject change abandons both — but each carries its
    // own guard, and a report per guard would stack two identical messages
    // describing a single event.
    let resolveStatus;
    mockFetchEmailStatus.mockReturnValueOnce(
      new Promise((resolve) => { resolveStatus = resolve; }),
    );

    const suppressed = ensureSessionWindow({ minRemainingMs: 0, allowRedirect: false });
    const permissive = freshAuthWindowReady();
    await tick(); // both are parked on the same factor read
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(1);

    teardownSubjectState();
    resolveStatus({ status: 'ok', data: { hasPassword: true } });

    expect(await suppressed).toEqual({ ready: false, cancelled: true });
    expect(await permissive).toBe(false);
    // Both flights unwound; the user is told once.
    expect(mockToastStore.show).toHaveBeenCalledTimes(1);
  });

  it('a flight parked across two subject changes folds into the newer change\'s one report', async () => {
    // The claim is keyed to the live generation, not to the change that
    // abandoned a given flight: once any party has narrated the newer change,
    // an older flight unwinding under it stays silent. Two rapid subject
    // changes therefore cost the user one message, not one per change. A
    // decision, not an accident: the second message would describe a session
    // the user has just been told is gone, and it would only stack.
    //
    // The older flight is parked on its mint round-trip, the boundary a
    // subject change cannot resolve for it: an open prompt is dismissed (and
    // its flight unwound) by the first scrub, but a request in flight resumes
    // only when its response lands, however many changes have passed by then.
    let resolveOlderMint;
    mockMintSessionAuthProof.mockReturnValueOnce(
      new Promise((resolve) => { resolveOlderMint = resolve; }),
    );
    const older = ensureSessionWindow();
    await tick(); // the default prompt answered; the mint round-trip is pending
    teardownSubjectState(); // the first subject change

    let dismissYoungerPrompt;
    mockReauthModal.request.mockImplementationOnce(
      () => new Promise((resolve) => { dismissYoungerPrompt = resolve; }),
    );
    const younger = ensureSessionWindow();
    await tick(); // a fresh flight under the next subject, parked on its prompt
    teardownSubjectState(); // the second subject change abandons both

    // The scrub dismisses the open prompt (resolving it null, as the modal's
    // cancel does); the younger flight resumes first and narrates the change
    // that ended it.
    dismissYoungerPrompt(null);
    expect(await younger).toEqual({ ready: false, cancelled: true });
    expect(mockToastStore.show).toHaveBeenCalledTimes(1);

    // The older flight's mint lands after both changes: it unwinds under a
    // generation already claimed, so the earlier change gets no report of its
    // own, and the late issuance is dropped rather than cached.
    resolveOlderMint(issuance('late-proof'));
    expect(await older).toEqual({ ready: false, cancelled: true });
    expect(mockToastStore.show).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(PROOF_KEY)).toBeNull();
  });

  it('a teardown inside the upload\'s own factor read reports exactly once', async () => {
    // The upload pre-flight's acquisition is a cold one on any first upload of
    // a window, and the status read it awaits is a real round-trip whose
    // negative and assumed answers are never memoized — so this boundary is
    // reachable, not theoretical.
    //
    // Every layer past it is deliberately quiet: the flight resolves
    // `cancelled`, the shared dispatch table keeps that outcome silent, and
    // the upload layer throws an already-reported code whose describe-key is
    // null so the page stays quiet too. The acquisition is therefore the only
    // site that can speak, and it must — exactly once.
    let resolveStatus;
    mockFetchEmailStatus.mockReturnValueOnce(
      new Promise((resolve) => { resolveStatus = resolve; }),
    );

    const pending = uploadFile(new Blob(['x'], { type: 'application/pdf' }));
    await tick(); // the status read is now pending
    teardownSubjectState();

    resolveStatus({ status: 'ok', data: { hasPassword: true } });
    const err = await pending.then(() => null, (e) => e);

    expect(err).toMatchObject({ code: UPLOAD_SUBJECT_CHANGED });
    // The page layer is told the failure already spoke...
    expect(describeUploadError(err)).toBeNull();
    // ...so this is the only message the user gets, and it is not zero.
    expect(mockToastStore.show).toHaveBeenCalledTimes(1);
    expect(mockToastStore.show).toHaveBeenCalledWith(expect.any(String), 'error');
    // No prompt, no mint, no upload for the subject the tab no longer has.
    expect(mockReauthModal.request).not.toHaveBeenCalled();
    expect(mockMintSessionAuthProof).not.toHaveBeenCalled();
    expect(mockUploadFileToIpfs).not.toHaveBeenCalled();
  });

  it('an upload retry landing after a subject change does not slide the successor\'s window', async () => {
    // The retry leg re-acquires the window and consumes it exactly as the
    // first attempt does, so it owes the same restraint: a response landing
    // after a subject change must not re-anchor whatever window the successor
    // has minted since. Driven over the real upload module and the real
    // acquisition because the upload suite's own guard is a stand-in that
    // cannot tell the entry guard from one opened after the transfer.
    seedWindow('doomed-window', { idleInMs: IDLE_MS });
    const successorDeadline = Date.now() + 30_000;
    mockUploadFileToIpfs
      // The first attempt's pre-flight rejects the window it was handed.
      .mockRejectedValueOnce({ code: 'FRESH_AUTH_REQUIRED', details: { reason: 'expired' } })
      // The retry re-acquired (prompt, mint) and is mid-transfer when the
      // subject changes; the successor opens a window of their own, with half
      // its idle period spent, before the response lands.
      .mockImplementationOnce(async () => {
        teardownSubjectState();
        sessionStorage.setItem(PROOF_KEY, JSON.stringify({
          token: 'successor-window',
          expiresAt: new Date(successorDeadline).toISOString(),
          absoluteExpiresAt: new Date(Date.now() + ABSOLUTE_MS).toISOString(),
          idlePeriodMs: 60_000,
        }));
        return { status: 'ok', data: { cid: 'bafy-late' } };
      });

    const res = await uploadFile(new Blob(['x'], { type: 'application/pdf' }));

    // The transfer completed and its result reaches the caller...
    expect(res.data.cid).toBe('bafy-late');
    expect(mockReauthModal.request).toHaveBeenCalledTimes(1); // the retry's re-acquisition
    // ...but the successor's deadline is exactly where they left it.
    expect(cached().token).toBe('successor-window');
    expect(new Date(cached().expiresAt).getTime()).toBe(successorDeadline);
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

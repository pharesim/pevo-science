// Coverage for the navigation stash seam in `frontend/src/lib/fresh-auth.js`:
// the `stash` option of `broadcastWithFreshAuth`, which a passwordless light
// account's ORCID round-trip writes to the one subject-bound sessionStorage
// slot (`lib/navigation-stash.js`) at the moment the navigation fires, and
// which a successful broadcast removes again. Covered here: where the record is
// written (the entry acquisition, the remintable-401 retry, the assumed-password
// fallback, and a coalesced flight whatever caller installed it), where nothing
// is written (the password factor, a cached window, self-custody, a teardown, a
// start round-trip that rejects or names a host outside the allowlist, the
// suppressed posture), the refusal a failed write turns into and the
// cost-stating confirm that is its way through, and the success clear.
//
// What a composer does with the slot when it mounts, and the slot's own read
// rules in `lib/navigation-stash.js`, are not pinned here.
//
// Mocking justification (clause-a of project-CLAUDE.md "Carve-out for
// deterministic edge-case coverage"): `fetchEmailStatus`, `mintSessionAuthProof`
// and `startOrcid` perform real fetch() against the backend. The cases here
// pick the factor per test (passwordless, password, status unreachable) and
// park the start round-trip so a second caller, a teardown or a page change
// can land while it is pending, which needs each round-trip to settle on the
// test's signal rather than the network's. A full-page navigation can only be
// observed in jsdom, not followed: `window.location` is stubbed so the
// assignment records the target and what the slot held at that instant.
// `signer.js#broadcastOps` is what carries the operations out of the tab; it is
// mocked so the cases that broadcast can observe each call and its options.
//
// Auth-focus carve-out (clause-b): no auth middleware is mocked and no
// cryptographic verification is bypassed. The proof is minted and verified
// server-side; these tests assert what the client writes to storage before it
// navigates, and what it offers when that write fails.
//
// Clause-c real-path companion: `frontend/tests/e2e/non-consent-fresh-auth.spec.js`
// drives a real broadcast with a real session window on the password factor.
// No e2e spec completes a session_auth ORCID round-trip, so the write at the
// navigating moment and the refusal of a failed write are pinned here only.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockBroadcastOps = vi.fn();
const mockStartOrcid = vi.fn();
const mockFetchEmailStatus = vi.fn();
const mockMintSessionAuthProof = vi.fn();
const mockReauthModal = { request: vi.fn() };
const mockToastStore = { show: vi.fn() };
const mockBroadcastConfirm = { request: vi.fn() };
const mockI18nStore = { messages: {} };
const mockAuthStore = { custody: 'light', username: 'alice', isConnected: true, disconnect: vi.fn() };

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
      if (name === 'broadcastConfirm') return mockBroadcastConfirm;
      if (name === 'i18n') return mockI18nStore;
      return {};
    }),
  },
}));

const {
  broadcastWithFreshAuth,
  FRESH_AUTH_REDIRECT_PENDING,
  clearCachedSessionProof,
  clearPasswordFactorMemo,
  abandonInFlightAcquisitions,
} = await import('../../src/lib/fresh-auth.js');
const {
  NAVIGATION_STASH_KEY,
  ORCID_MODE_KEY,
  RETURN_PATH_KEY,
  SESSION_PROOF_KEY,
  SUBJECT_BOUND_STORAGE_KEYS,
} = await import('../../src/lib/subject-bound-keys.js');

const ORCID_URL = 'https://orcid.org/oauth/authorize?x=1';
const START_PATH = '/papers/alice/paper-1';
const OTHER_PATH = '/papers/carol/another-paper';

const COMMENT_TARGET = Object.freeze({
  rootAuthor: 'alice',
  rootPermlink: 'paper-1',
  parentAuthor: 'bob',
  parentPermlink: 're-paper-1',
});
const OTHER_COMMENT_TARGET = Object.freeze({
  rootAuthor: 'alice',
  rootPermlink: 'paper-1',
  parentAuthor: 'carol',
  parentPermlink: 're-paper-1-carol',
});
const COMMENT_OPS = [['comment', { parent_author: 'bob', parent_permlink: 're-paper-1', body: 'x' }]];
const VOTE_OPS = [['vote', { voter: 'alice', author: 'bob', permlink: 're-paper-1', weight: 10000 }]];

const UNKEPT_MESSAGE =
  'Confirming your identity with ORCID means leaving this page. What you have entered here could not be kept, so it will be lost.';
const REAUTH_REQUIRED_TOAST = 'Please confirm your identity again, then try once more.';
const TEARDOWN_TOAST = 'Your session changed, so the confirmation was cancelled.';

// Real timers in this file; a macrotask hop lets a pending flight advance
// through its internal awaits to the point currently blocking it.
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function commentStash(body, target = COMMENT_TARGET) {
  return { surface: 'comment', target: { ...target }, payload: () => ({ body }) };
}

function storedRecord(subject, body, target = COMMENT_TARGET) {
  return { surface: 'comment', target: { ...target }, subject, payload: { body }, savedAt: Date.now() - 1000 };
}

function seedRecord(record) {
  sessionStorage.setItem(NAVIGATION_STASH_KEY, JSON.stringify(record));
}

function readSlot() {
  const raw = sessionStorage.getItem(NAVIGATION_STASH_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function seedLiveWindow(token) {
  sessionStorage.setItem(SESSION_PROOF_KEY, JSON.stringify({
    token,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    idlePeriodMs: 900_000,
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
    status,
    code: 'FRESH_AUTH_REQUIRED',
    details: { reason },
  });
}

// The parts of the subject scrub (`_scrubSubjectBoundState` in src/auth.js)
// this suite's flights reach, staged by hand.
function teardownSubjectState() {
  clearCachedSessionProof();
  clearPasswordFactorMemo();
  abandonInFlightAcquisitions();
  for (const key of SUBJECT_BOUND_STORAGE_KEYS) sessionStorage.removeItem(key);
}

// What the tab held at one instant: the location's href, the two flow keys
// and the raw navigation stash slot.
function snapshot() {
  return {
    href: window.location.href,
    mode: sessionStorage.getItem(ORCID_MODE_KEY),
    returnPath: sessionStorage.getItem(RETURN_PATH_KEY),
    stash: sessionStorage.getItem(NAVIGATION_STASH_KEY),
  };
}

// Every assignment to `window.location.href`, with the storage the tab held at
// that instant. The stash must already be in the slot when the navigation
// fires, so it is read inside the setter rather than after the call returns.
let navigations;

function stubWindow() {
  const location = {
    pathname: START_PATH,
    assigned: '',
    get href() { return this.assigned; },
    set href(value) {
      this.assigned = value;
      navigations.push({
        href: value,
        mode: sessionStorage.getItem(ORCID_MODE_KEY),
        returnPath: sessionStorage.getItem(RETURN_PATH_KEY),
        stash: sessionStorage.getItem(NAVIGATION_STASH_KEY),
      });
    },
  };
  vi.stubGlobal('window', { ...globalThis.window, location });
}

// Storage refuses the stash key only. A blanket throw fails earlier, at the
// unguarded ORCID mode-marker write, and never reaches the stash write.
function failStashWrites() {
  const { setItem } = Storage.prototype;
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key === NAVIGATION_STASH_KEY) throw new Error('quota exceeded');
    return setItem.call(this, key, value);
  });
}

// Records every write to the stash key and lets it through. A case that ends
// in a successful broadcast cannot read "nothing was written" off the slot,
// because the success clear would have removed a write by then.
function recordStashWrites() {
  const { setItem } = Storage.prototype;
  const writes = [];
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key === NAVIGATION_STASH_KEY) writes.push(value);
    return setItem.call(this, key, value);
  });
  return writes;
}

// Park the next start round-trip until the case resolves it.
function parkStart() {
  const parked = {};
  mockStartOrcid.mockReturnValueOnce(new Promise((resolve) => { parked.resolve = resolve; }));
  return parked;
}

// Answer every confirm request with `answer`, recording what the tab held each
// time it was asked.
function answerDialogWith(answer) {
  const asked = [];
  mockBroadcastConfirm.request.mockImplementation(() => {
    asked.push(snapshot());
    return Promise.resolve(answer);
  });
  return asked;
}

// A confirm that stays open until the case answers it and, like the real
// broadcastConfirm store, resolves false at once for a second request made
// while it is open.
function openDialog() {
  const dialog = { answer: null, asked: [] };
  mockBroadcastConfirm.request.mockImplementation(() => {
    dialog.asked.push(snapshot());
    if (dialog.answer) return Promise.resolve(false);
    return new Promise((resolve) => {
      dialog.answer = (value) => {
        dialog.answer = null;
        resolve(value);
      };
    });
  });
  return dialog;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  clearCachedSessionProof();
  // The tab-lifetime password-factor memo would carry one case's
  // `hasPassword: true` into the next case's passwordless account.
  clearPasswordFactorMemo();
  // A case that fails while a flight is parked leaves it installed; the next
  // case would join it instead of starting cold. This also starts each case on
  // a fresh teardown-report generation.
  abandonInFlightAcquisitions();
  mockAuthStore.custody = 'light';
  mockAuthStore.username = 'alice';
  mockI18nStore.messages = {};
  mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
  mockStartOrcid.mockResolvedValue({ redirect_url: ORCID_URL });
  mockBroadcastOps.mockResolvedValue({ tx_id: 'tx' });
  mockReauthModal.request.mockResolvedValue(null);
  mockBroadcastConfirm.request.mockResolvedValue(false);
  navigations = [];
  stubWindow();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a passwordless broadcast writes its stash at the navigating moment', () => {
  it('the entry navigation finds the record in the slot when it assigns the ORCID URL', async () => {
    const result = await broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('a careful reply'),
    });

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(navigations).toHaveLength(1);
    expect(navigations[0].href).toBe(ORCID_URL);
    expect(JSON.parse(navigations[0].stash)).toEqual({
      surface: 'comment',
      target: COMMENT_TARGET,
      subject: 'alice',
      payload: { body: 'a careful reply' },
      savedAt: expect.any(Number),
    });
    expect(navigations[0].mode).toBe('session_auth');
    expect(navigations[0].returnPath).toBe(START_PATH);
    // Nothing removes the record after the navigation: it is there for the
    // composer to take back on return.
    expect(readSlot()).toEqual(JSON.parse(navigations[0].stash));
    expect(mockStartOrcid).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).toHaveBeenCalledWith('session_auth', {});
    expect(mockBroadcastOps).not.toHaveBeenCalled();
    expect(mockToastStore.show).not.toHaveBeenCalled();
    expect(mockBroadcastConfirm.request).not.toHaveBeenCalled();
  });

  it('reads the payload when the navigation fires, not when the broadcast is called', async () => {
    const composer = { body: 'first draft' };
    const parked = parkStart();

    const pending = broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: { surface: 'comment', target: { ...COMMENT_TARGET }, payload: () => ({ body: composer.body }) },
    });
    await tick(); // the start round-trip is pending
    composer.body = 'typed while the start was pending';
    parked.resolve({ redirect_url: ORCID_URL });

    expect(await pending).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(navigations).toHaveLength(1);
    expect(JSON.parse(navigations[0].stash).payload).toEqual({ body: 'typed while the start was pending' });
  });

  it('the re-acquisition after a remintable 401 carries the stash to its navigation', async () => {
    seedLiveWindow('doomed-proof');
    mockBroadcastOps.mockRejectedValueOnce(freshAuthError(401, 'expired'));

    const result = await broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('survives the retry'),
    });

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).toHaveBeenCalledTimes(1);
    expect(navigations).toHaveLength(1);
    expect(navigations[0].href).toBe(ORCID_URL);
    expect(JSON.parse(navigations[0].stash)).toMatchObject({
      surface: 'comment',
      target: COMMENT_TARGET,
      subject: 'alice',
      payload: { body: 'survives the retry' },
    });
    expect(mockToastStore.show).not.toHaveBeenCalled();
    expect(mockBroadcastConfirm.request).not.toHaveBeenCalled();
  });

  it('an assumed password the mint rejects falls back to ORCID with the record written', async () => {
    // Status unreachable: the password factor is assumed, and a 401 at the
    // mint hands the flight back to its ORCID factor.
    mockFetchEmailStatus.mockRejectedValue(new Error('status unavailable'));
    mockReauthModal.request.mockResolvedValue('typed-password');
    mockMintSessionAuthProof.mockRejectedValue(
      Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' }),
    );

    const result = await broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('kept through the fallback'),
    });

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
    expect(mockMintSessionAuthProof).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).toHaveBeenCalledTimes(1);
    expect(navigations).toHaveLength(1);
    expect(JSON.parse(navigations[0].stash)).toMatchObject({
      surface: 'comment',
      subject: 'alice',
      payload: { body: 'kept through the fallback' },
    });
    expect(mockBroadcastOps).not.toHaveBeenCalled();
  });

  it('a navigation with no stash registered removes a record left in the slot', async () => {
    seedRecord(storedRecord('alice', 'from an earlier round-trip', OTHER_COMMENT_TARGET));

    const result = await broadcastWithFreshAuth('alice', VOTE_OPS);

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(navigations).toHaveLength(1);
    expect(navigations[0].href).toBe(ORCID_URL);
    expect(navigations[0].stash).toBeNull();
  });
});

describe('coalesced callers share one navigation', () => {
  it('a stash joining a stash-less flight is written by that flight', async () => {
    const parked = parkStart();

    const vote = broadcastWithFreshAuth('alice', VOTE_OPS);
    await tick(); // the vote's flight is parked on its start round-trip
    const comment = broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('joined the vote'),
    });
    await tick();
    parked.resolve({ redirect_url: ORCID_URL });

    expect(await vote).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(await comment).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockStartOrcid).toHaveBeenCalledTimes(1);
    expect(navigations).toHaveLength(1);
    expect(JSON.parse(navigations[0].stash)).toMatchObject({
      surface: 'comment',
      target: COMMENT_TARGET,
      subject: 'alice',
      payload: { body: 'joined the vote' },
    });
    expect(mockBroadcastConfirm.request).not.toHaveBeenCalled();
    expect(mockToastStore.show).not.toHaveBeenCalled();
  });

  it('a stash-less caller joining a stash flight registers nothing beside it', async () => {
    const parked = parkStart();

    const comment = broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('started the flight'),
    });
    await tick();
    const vote = broadcastWithFreshAuth('alice', VOTE_OPS);
    await tick();
    parked.resolve({ redirect_url: ORCID_URL });

    expect(await comment).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(await vote).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockStartOrcid).toHaveBeenCalledTimes(1);
    expect(navigations).toHaveLength(1);
    expect(JSON.parse(navigations[0].stash)).toEqual({
      surface: 'comment',
      target: COMMENT_TARGET,
      subject: 'alice',
      payload: { body: 'started the flight' },
      savedAt: expect.any(Number),
    });
    expect(mockBroadcastConfirm.request).not.toHaveBeenCalled();
    expect(mockToastStore.show).not.toHaveBeenCalled();
  });

  it('two stashes on one flight refuse the navigation, and a yes navigates without either', async () => {
    const dialog = openDialog();
    const parked = parkStart();

    const first = broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('the first reply'),
    });
    await tick();
    const second = broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('the second reply', OTHER_COMMENT_TARGET),
    });
    await tick();
    parked.resolve({ redirect_url: ORCID_URL });
    await tick(); // the refused flight reaches both callers

    expect(navigations).toHaveLength(0);
    // Both callers ask; the confirm refuses the one that arrives while the
    // other's dialog is open.
    expect(mockBroadcastConfirm.request).toHaveBeenCalledTimes(2);
    // The refusal unwound the flow keys and wrote neither record.
    expect(dialog.asked[0]).toEqual({ href: '', mode: null, returnPath: null, stash: null });

    dialog.answer(true);

    expect(await first).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(await second).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockStartOrcid).toHaveBeenCalledTimes(2);
    expect(navigations).toEqual([
      { href: ORCID_URL, mode: 'session_auth', returnPath: START_PATH, stash: null },
    ]);
    expect(mockToastStore.show).not.toHaveBeenCalled();
    expect(mockBroadcastOps).not.toHaveBeenCalled();
  });
});

describe('no record is written where nothing navigates', () => {
  it('the password factor mints inline and broadcasts without writing or asking', async () => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    mockReauthModal.request.mockResolvedValue('correct-password');
    mockMintSessionAuthProof.mockResolvedValue(issuance('minted-proof'));
    const writes = recordStashWrites();

    const result = await broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('typed with a password account'),
    });

    expect(result).toEqual({ tx_id: 'tx' });
    expect(writes).toEqual([]);
    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(navigations).toHaveLength(0);
    expect(mockBroadcastConfirm.request).not.toHaveBeenCalled();
    // The option is consumed by the wrapper, never forwarded to the signer.
    expect(mockBroadcastOps).toHaveBeenCalledWith('alice', COMMENT_OPS, { freshAuthProof: 'minted-proof' });
  });

  it('a cached live window broadcasts without writing, and forwards the other options without the stash', async () => {
    seedLiveWindow('live-proof');
    const writes = recordStashWrites();

    const result = await broadcastWithFreshAuth('alice', COMMENT_OPS, {
      keyType: 'posting',
      stash: commentStash('sent inside a live window'),
    });

    expect(result).toEqual({ tx_id: 'tx' });
    expect(writes).toEqual([]);
    expect(mockFetchEmailStatus).not.toHaveBeenCalled();
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(navigations).toHaveLength(0);
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(mockBroadcastOps.mock.calls[0][2]).toEqual({ keyType: 'posting', freshAuthProof: 'live-proof' });
  });

  it('a self-custody broadcast forwards no stash to the signer and writes nothing', async () => {
    mockAuthStore.custody = 'keychain';
    const writes = recordStashWrites();

    const result = await broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('signed by Keychain'),
    });

    expect(result).toEqual({ tx_id: 'tx' });
    expect(writes).toEqual([]);
    expect(mockBroadcastOps).toHaveBeenCalledWith('alice', COMMENT_OPS, {});
  });

  it('a teardown while the start round-trip is pending writes nothing and does not navigate', async () => {
    const writes = recordStashWrites();
    const parked = parkStart();

    const pending = broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('typed by the departing subject'),
    });
    await tick(); // the start round-trip is pending
    teardownSubjectState();
    parked.resolve({ redirect_url: ORCID_URL });

    expect(await pending).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(writes).toEqual([]);
    expect(readSlot()).toBeNull();
    expect(window.location.href).toBe('');
    expect(navigations).toHaveLength(0);
    expect(mockBroadcastConfirm.request).not.toHaveBeenCalled();
    expect(mockToastStore.show).toHaveBeenCalledTimes(1);
    expect(mockToastStore.show).toHaveBeenCalledWith(TEARDOWN_TOAST, 'error');
  });

  it('a redirect host outside the allowlist rejects before anything is written', async () => {
    const writes = recordStashWrites();
    mockStartOrcid.mockResolvedValue({ redirect_url: 'https://evil.example/oauth/authorize' });

    await expect(
      broadcastWithFreshAuth('alice', COMMENT_OPS, { stash: commentStash('never written') }),
    ).rejects.toThrow('Invalid ORCID redirect URL');

    expect(writes).toEqual([]);
    expect(readSlot()).toBeNull();
    expect(navigations).toHaveLength(0);
    expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBeNull();
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBeNull();
    expect(mockBroadcastConfirm.request).not.toHaveBeenCalled();
  });

  it('a start round-trip that rejects writes nothing', async () => {
    const writes = recordStashWrites();
    mockStartOrcid.mockRejectedValue(new Error('network down'));

    await expect(
      broadcastWithFreshAuth('alice', COMMENT_OPS, { stash: commentStash('never written') }),
    ).rejects.toThrow('network down');

    expect(writes).toEqual([]);
    expect(readSlot()).toBeNull();
    expect(navigations).toHaveLength(0);
    expect(mockBroadcastConfirm.request).not.toHaveBeenCalled();
  });

  it('the suppressed posture refuses with the re-authenticate toast and neither writes nor asks', async () => {
    const writes = recordStashWrites();

    const result = await broadcastWithFreshAuth('alice', COMMENT_OPS, {
      allowRedirect: false,
      stash: commentStash('held by a suppressed caller'),
    });

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(writes).toEqual([]);
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(navigations).toHaveLength(0);
    expect(mockBroadcastConfirm.request).not.toHaveBeenCalled();
    expect(mockToastStore.show).toHaveBeenCalledTimes(1);
    expect(mockToastStore.show).toHaveBeenCalledWith(REAUTH_REQUIRED_TOAST, 'error');
  });
});

describe('a stash write that fails refuses the navigation and offers a way through', () => {
  it('unwinds the flow keys, asks with the unkept copy, and a no ends in silence', async () => {
    failStashWrites();
    const asked = answerDialogWith(false);

    const result = await broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('could not be kept'),
    });

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockBroadcastConfirm.request).toHaveBeenCalledTimes(1);
    expect(mockBroadcastConfirm.request).toHaveBeenCalledWith({
      title: 'Confirm your identity',
      message: UNKEPT_MESSAGE,
      confirmLabel: 'Continue to ORCID',
    });
    // Asked with the navigation refused and the flow keys already unwound.
    expect(asked).toEqual([{ href: '', mode: null, returnPath: null, stash: null }]);
    expect(navigations).toHaveLength(0);
    expect(mockStartOrcid).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBeNull();
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBeNull();
    expect(mockBroadcastOps).not.toHaveBeenCalled();
    expect(mockToastStore.show).not.toHaveBeenCalled();
  });

  it('a yes navigates without the work and removes a record left in the slot', async () => {
    seedRecord(storedRecord('alice', 'from an earlier round-trip', OTHER_COMMENT_TARGET));
    failStashWrites();
    answerDialogWith(true);

    const result = await broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('could not be kept'),
    });

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockBroadcastConfirm.request).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).toHaveBeenCalledTimes(2);
    expect(navigations).toEqual([
      { href: ORCID_URL, mode: 'session_auth', returnPath: START_PATH, stash: null },
    ]);
    expect(mockBroadcastOps).not.toHaveBeenCalled();
    expect(mockToastStore.show).not.toHaveBeenCalled();
  });

  it('asks with the localized copy when the bundle carries it', async () => {
    mockI18nStore.messages = {
      confirm: {
        reauthNavigateTitle: 'TITLE_SENTINEL',
        reauthNavigateUnkeptMessage: 'UNKEPT_SENTINEL',
        reauthNavigate: 'LABEL_SENTINEL',
      },
    };
    failStashWrites();
    answerDialogWith(false);

    await broadcastWithFreshAuth('alice', COMMENT_OPS, { stash: commentStash('could not be kept') });

    expect(mockBroadcastConfirm.request).toHaveBeenCalledWith({
      title: 'TITLE_SENTINEL',
      message: 'UNKEPT_SENTINEL',
      confirmLabel: 'LABEL_SENTINEL',
    });
  });

  it('a payload producer that throws refuses the navigation the same way', async () => {
    const asked = answerDialogWith(false);

    const result = await broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: {
        surface: 'comment',
        target: { ...COMMENT_TARGET },
        payload: () => { throw new Error('composer state unreadable'); },
      },
    });

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(navigations).toHaveLength(0);
    expect(mockBroadcastConfirm.request).toHaveBeenCalledTimes(1);
    expect(mockBroadcastConfirm.request).toHaveBeenCalledWith(
      expect.objectContaining({ message: UNKEPT_MESSAGE }),
    );
    expect(asked).toEqual([{ href: '', mode: null, returnPath: null, stash: null }]);
    expect(mockToastStore.show).not.toHaveBeenCalled();
  });

  it('after a declined refusal, a later attempt with working storage writes and navigates', async () => {
    const failing = failStashWrites();
    answerDialogWith(false);

    expect(
      await broadcastWithFreshAuth('alice', COMMENT_OPS, { stash: commentStash('first attempt') }),
    ).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(navigations).toHaveLength(0);

    failing.mockRestore();

    expect(
      await broadcastWithFreshAuth('alice', COMMENT_OPS, { stash: commentStash('second attempt') }),
    ).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockBroadcastConfirm.request).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).toHaveBeenCalledTimes(2);
    expect(navigations).toHaveLength(1);
    expect(navigations[0].href).toBe(ORCID_URL);
    expect(JSON.parse(navigations[0].stash)).toMatchObject({
      surface: 'comment',
      target: COMMENT_TARGET,
      subject: 'alice',
      payload: { body: 'second attempt' },
    });
    expect(mockToastStore.show).not.toHaveBeenCalled();
  });

  it('a teardown while the dialog is open outranks a yes and is reported once', async () => {
    failStashWrites();
    mockBroadcastConfirm.request.mockImplementation(async () => {
      teardownSubjectState();
      return true;
    });

    const result = await broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('could not be kept'),
    });

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockBroadcastConfirm.request).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).toHaveBeenCalledTimes(1);
    expect(navigations).toHaveLength(0);
    expect(mockToastStore.show).toHaveBeenCalledTimes(1);
    expect(mockToastStore.show).toHaveBeenCalledWith(TEARDOWN_TOAST, 'error');
  });

  it('is not asked once the tab has left the page the broadcast started on', async () => {
    failStashWrites();
    const parked = parkStart();

    const pending = broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('could not be kept'),
    });
    await tick(); // the start round-trip is pending
    window.location.pathname = OTHER_PATH;
    parked.resolve({ redirect_url: ORCID_URL });

    expect(await pending).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockBroadcastConfirm.request).not.toHaveBeenCalled();
    expect(navigations).toHaveLength(0);
    expect(mockToastStore.show).not.toHaveBeenCalled();
  });

  it('is not asked once the account is no longer a light one', async () => {
    failStashWrites();
    const parked = parkStart();

    const pending = broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('could not be kept'),
    });
    await tick(); // the start round-trip is pending
    mockAuthStore.custody = 'keychain';
    parked.resolve({ redirect_url: ORCID_URL });

    expect(await pending).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockBroadcastConfirm.request).not.toHaveBeenCalled();
    expect(navigations).toHaveLength(0);
    expect(mockToastStore.show).not.toHaveBeenCalled();
  });

  it('a yes given after the tab left the page during the dialog does not navigate', async () => {
    failStashWrites();
    mockBroadcastConfirm.request.mockImplementation(async () => {
      window.location.pathname = OTHER_PATH;
      return true;
    });

    const result = await broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('could not be kept'),
    });

    expect(result).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockBroadcastConfirm.request).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).toHaveBeenCalledTimes(1);
    expect(navigations).toHaveLength(0);
    expect(mockToastStore.show).not.toHaveBeenCalled();
  });

  it('a stash-less caller that joined the refused flight stays silent while the stash caller is asked', async () => {
    failStashWrites();
    answerDialogWith(false);
    const parked = parkStart();

    const comment = broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('could not be kept'),
    });
    await tick();
    const vote = broadcastWithFreshAuth('alice', VOTE_OPS);
    await tick();
    parked.resolve({ redirect_url: ORCID_URL });

    expect(await comment).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(await vote).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockStartOrcid).toHaveBeenCalledTimes(1);
    expect(mockBroadcastConfirm.request).toHaveBeenCalledTimes(1);
    expect(navigations).toHaveLength(0);
    expect(mockToastStore.show).not.toHaveBeenCalled();
  });
});

describe('a successful broadcast removes its own record and no other', () => {
  it('removes a record for its own surface, target and subject', async () => {
    seedRecord(storedRecord('alice', 'restored and sent'));
    seedLiveWindow('live-proof');

    const result = await broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('restored and sent'),
    });

    expect(result).toEqual({ tx_id: 'tx' });
    expect(readSlot()).toBeNull();
    expect(navigations).toHaveLength(0);
  });

  it('leaves a record for another target in place', async () => {
    const other = storedRecord('alice', 'waiting for another composer', OTHER_COMMENT_TARGET);
    seedRecord(other);
    seedLiveWindow('live-proof');

    const result = await broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('sent'),
    });

    expect(result).toEqual({ tx_id: 'tx' });
    expect(readSlot()).toEqual(other);
  });

  it('a broadcast with no stash leaves an existing record alone', async () => {
    const waiting = storedRecord('alice', 'waiting for its composer');
    seedRecord(waiting);
    seedLiveWindow('live-proof');

    const result = await broadcastWithFreshAuth('alice', VOTE_OPS);

    expect(result).toEqual({ tx_id: 'tx' });
    expect(readSlot()).toEqual(waiting);
  });

  it('leaves the slot alone when a teardown lands during the broadcast', async () => {
    const record = storedRecord('alice', 'not this broadcast\'s to clear any more');
    seedRecord(record);
    seedLiveWindow('live-proof');
    mockBroadcastOps.mockImplementationOnce(async () => {
      abandonInFlightAcquisitions();
      return { tx_id: 'tx' };
    });

    const result = await broadcastWithFreshAuth('alice', COMMENT_OPS, {
      stash: commentStash('sent across a teardown'),
    });

    expect(result).toEqual({ tx_id: 'tx' });
    expect(readSlot()).toEqual(record);
  });
});

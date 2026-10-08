// The review page keeps a review across the full-page ORCID round-trip a
// passwordless light account takes to open its re-auth window. `handleSubmit`
// hands `broadcastWithFreshAuth` the review (body, the four ratings and the
// anonymous flag) as a navigation stash bound to the paper it was written for,
// the session-auth redirect writes it at the moment it navigates, and `init()`
// takes it back when the page mounts on return. A successful broadcast removes
// its own record.
//
// The page runs over the REAL `lib/fresh-auth.js` and `lib/navigation-stash.js`
// and the real jsdom sessionStorage, so each spec observes what the page and
// the helper do together rather than what a stubbed helper was handed.
//
// Mocking justification (clause-a of project-CLAUDE.md "Carve-out for
// deterministic edge-case coverage"): `startOrcid`, `fetchEmailStatus`,
// `mintSessionAuthProof`, `fetchPaper` and `submitAnonymousReview` perform real
// fetch() against the backend, and `signer.js#broadcastOps` is what carries
// the operations out of the tab; it is mocked so each broadcast and the proof
// it carried can be observed. The passwordless branch ends in a full-page
// navigation to ORCID, which jsdom can only observe through a stubbed
// `window.location`, not follow, so the return leg is staged by mounting a
// fresh page instance over the same sessionStorage. Alpine is mocked because
// the page is built from its `Alpine.data` factory with stubbed magics, the
// way `pages-review.test.js` builds it; `crypto.js` and `config.js` are mocked
// as there.
//
// Auth-focus carve-out (clause-b): no auth middleware is mocked and no
// cryptographic verification is bypassed. The proof is minted and verified
// server-side; these tests assert what the page keeps, writes and restores
// around the navigation.
//
// Clause-c real-path companion: `frontend/tests/e2e/non-consent-fresh-auth.spec.js`
// drives a real broadcast with a real session window. No e2e spec completes a
// session_auth ORCID round-trip, so the stash written at the navigation and
// taken back on return are pinned by unit suites only.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetchPaper = vi.fn();
const mockSubmitAnonymousReview = vi.fn();
const mockStartOrcid = vi.fn();
const mockFetchEmailStatus = vi.fn();
const mockMintSessionAuthProof = vi.fn();
const mockBroadcastOps = vi.fn();

vi.mock('../../src/api.js', () => ({
  fetchPaper: (...args) => mockFetchPaper(...args),
  submitAnonymousReview: (...args) => mockSubmitAnonymousReview(...args),
  startOrcid: (...args) => mockStartOrcid(...args),
  consentOpRequestFields: (t) => t,
  fetchEmailStatus: (...args) => mockFetchEmailStatus(...args),
  mintSessionAuthProof: (...args) => mockMintSessionAuthProof(...args),
}));

vi.mock('../../src/signer.js', () => ({
  broadcastOps: (...args) => mockBroadcastOps(...args),
}));

vi.mock('../../src/crypto.js', () => ({
  slugify: (s) => s.toLowerCase().replace(/\s+/g, '-'),
}));

vi.mock('../../src/config.js', () => ({
  getAppTag: () => 'pevotest',
  getAppId: () => 'pevotest/1.0',
  getMaxUploadSize: () => 50 * 1024 * 1024,
  getMaxUploadSizeMB: () => 50,
}));

const mockStores = {
  router: { params: { author: 'alice', permlink: 'paper-1' }, navigate: vi.fn() },
  auth: { isConnected: true, isAccredited: true, username: 'bob', custody: 'light' },
  toast: { show: vi.fn() },
  broadcastConfirm: { request: vi.fn() },
  reauthModal: { request: vi.fn() },
  i18n: { messages: {} },
};

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: (name) => mockStores[name] || {},
  },
}));

const { default: Alpine } = await import('alpinejs');
const { initReviewPage } = await import('../../src/pages/review.js');
const {
  clearCachedSessionProof,
  clearPasswordFactorMemo,
  abandonInFlightAcquisitions,
} = await import('../../src/lib/fresh-auth.js');
const {
  NAVIGATION_STASH_KEY,
  SESSION_PROOF_KEY,
  ORCID_MODE_KEY,
  RETURN_PATH_KEY,
} = await import('../../src/lib/subject-bound-keys.js');

const ORCID_URL = 'https://orcid.org/oauth/authorize?x=1';
const REVIEW_PATH = '/review/alice/paper-1';
const IDLE_MS = 900_000;
const ABSOLUTE_MS = 7_200_000;
const BODY = 'The method is sound; the second experiment needs a control.';
const RATINGS = Object.freeze({ methodology: 4, novelty: 3, clarity: 5, significance: 2 });
const UNKEPT_TITLE = 'Confirm your identity';
const UNKEPT_MESSAGE =
  'Confirming your identity with ORCID means leaving this page. What you have entered here could not be kept, so it will be lost.';
const UNKEPT_LABEL = 'Continue to ORCID';

function createComponent(overrides = {}) {
  initReviewPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$store = mockStores;
  comp.$t = (key) => key;
  comp.$watch = vi.fn();
  comp.$nextTick = vi.fn((fn) => fn && fn());
  Object.assign(comp, overrides);
  return comp;
}

// The review a user has composed, on a fresh copy so no spec can mutate the
// shared ratings.
function composedReview(overrides = {}) {
  return {
    ratings: { ...RATINGS },
    reviewBody: BODY,
    isAnonymous: false,
    paper: { title: 'Paper' },
    ...overrides,
  };
}

// Every assignment to `window.location.href`, with the stash slot as it stood
// at that instant. The stash is written after the start round-trip resolves,
// so a startOrcid mock cannot see it; the href setter is the one place that
// proves the record was in storage when the page left.
let navigations = [];

function stubLocation(pathname = REVIEW_PATH) {
  let href = '';
  const location = {
    pathname,
    get href() { return href; },
    set href(value) {
      navigations.push({ href: value, stash: sessionStorage.getItem(NAVIGATION_STASH_KEY) });
      href = value;
    },
  };
  vi.stubGlobal('window', { ...globalThis.window, location });
}

function issuance(token) {
  return {
    fresh_auth_proof: token,
    expires_at: new Date(Date.now() + IDLE_MS).toISOString(),
    absolute_expires_at: new Date(Date.now() + ABSOLUTE_MS).toISOString(),
    mechanism: 'password',
  };
}

// A window already open in this tab, written the way issuance leaves it.
function seedWindow(token) {
  sessionStorage.setItem(SESSION_PROOF_KEY, JSON.stringify({
    token,
    expiresAt: new Date(Date.now() + IDLE_MS).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + ABSOLUTE_MS).toISOString(),
    idlePeriodMs: IDLE_MS,
  }));
}

function reviewRecord(overrides = {}) {
  return {
    surface: 'review',
    target: { author: 'alice', permlink: 'paper-1' },
    subject: 'bob',
    payload: { reviewBody: BODY, ratings: { ...RATINGS }, isAnonymous: false },
    savedAt: Date.now(),
    ...overrides,
  };
}

function seedStash(record) {
  const raw = JSON.stringify(record);
  sessionStorage.setItem(NAVIGATION_STASH_KEY, raw);
  return raw;
}

function stashSlot() {
  return sessionStorage.getItem(NAVIGATION_STASH_KEY);
}

// Records every write of the stash key and passes all writes through. A
// success that follows would remove a record the flow wrote, so the slot's
// end state cannot show that nothing was written; the call record can.
function recordStashWrites() {
  const { setItem } = Storage.prototype;
  const writes = [];
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key === NAVIGATION_STASH_KEY) writes.push(value);
    return setItem.call(this, key, value);
  });
  return writes;
}

// Storage that refuses the stash key only. A blanket throw would fail earlier,
// at the ORCID mode-marker write, and never reach the stash.
function refuseStashWrites() {
  const { setItem } = Storage.prototype;
  const attempts = [];
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key === NAVIGATION_STASH_KEY) {
      attempts.push(value);
      throw new Error('quota exceeded');
    }
    return setItem.call(this, key, value);
  });
  return attempts;
}

function expectUntouchedForm(comp) {
  expect(comp.reviewBody).toBe('');
  expect(comp.ratings).toEqual({ methodology: 0, novelty: 0, clarity: 0, significance: 0 });
  expect(comp.isAnonymous).toBe(false);
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  clearCachedSessionProof();
  clearPasswordFactorMemo();
  abandonInFlightAcquisitions();
  navigations = [];
  mockStores.router.params = { author: 'alice', permlink: 'paper-1' };
  Object.assign(mockStores.auth, {
    isConnected: true,
    isAccredited: true,
    username: 'bob',
    custody: 'light',
  });
  mockFetchPaper.mockResolvedValue({ data: { title: 'Paper' } });
  mockSubmitAnonymousReview.mockResolvedValue({ data: { ok: true } });
  mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
  mockStartOrcid.mockResolvedValue({ redirect_url: ORCID_URL });
  mockMintSessionAuthProof.mockImplementation(async () => issuance('window-proof'));
  mockBroadcastOps.mockResolvedValue({ tx_id: 'tx' });
  mockStores.broadcastConfirm.request.mockResolvedValue(true);
  mockStores.reauthModal.request.mockResolvedValue('hunter2');
  stubLocation();
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('reviewPage keeps the review across the passwordless ORCID round-trip', () => {
  it('writes the review to the stash slot before the ORCID navigation fires', async () => {
    const before = Date.now();
    const comp = createComponent(composedReview());

    await comp.handleSubmit();

    expect(navigations).toHaveLength(1);
    expect(navigations[0].href).toBe(ORCID_URL);
    const written = JSON.parse(navigations[0].stash);
    expect(written).toEqual({
      surface: 'review',
      target: { author: 'alice', permlink: 'paper-1' },
      subject: 'bob',
      payload: { reviewBody: BODY, ratings: { ...RATINGS }, isAnonymous: false },
      savedAt: expect.any(Number),
    });
    expect(written.savedAt).toBeGreaterThanOrEqual(before);
    expect(written.savedAt).toBeLessThanOrEqual(Date.now());
    expect(mockBroadcastOps).not.toHaveBeenCalled();
    // Only the intent confirm was asked: a kept review navigates unasked.
    expect(mockStores.broadcastConfirm.request).toHaveBeenCalledTimes(1);
    expect(mockStores.toast.show).not.toHaveBeenCalled();
    expect(comp.step).toBe('idle');
    expect(comp.reviewBody).toBe(BODY);
    expect(comp.ratings).toEqual({ ...RATINGS });
    expect(comp.isAnonymous).toBe(false);
  });

  it('restores the review the navigation wrote into the page mounted on return, and empties the slot', async () => {
    const leaving = createComponent(composedReview());
    await leaving.handleSubmit();
    expect(navigations).toHaveLength(1);
    expect(stashSlot()).not.toBeNull();

    // The return leg: a new page load, a fresh instance over the same tab
    // storage.
    stubLocation();
    const returned = createComponent();
    expectUntouchedForm(returned);
    returned.init();

    expect(returned.reviewBody).toBe(BODY);
    expect(returned.ratings).toEqual({ ...RATINGS });
    expect(returned.isAnonymous).toBe(false);
    expect(stashSlot()).toBeNull();
    expect(mockFetchPaper).toHaveBeenCalledWith('alice', 'paper-1');
  });

  it('submits the restored review inside the window the round-trip opened, with no second navigation', async () => {
    const leaving = createComponent(composedReview());
    await leaving.handleSubmit();
    expect(navigations).toHaveLength(1);

    stubLocation();
    navigations = [];
    // The ORCID callback opened the window before the page mounted again.
    seedWindow('window-proof');
    const returned = createComponent();
    returned.init();

    await returned.handleSubmit();

    expect(navigations).toEqual([]);
    expect(mockStartOrcid).toHaveBeenCalledTimes(1);
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    const [username, ops, opts] = mockBroadcastOps.mock.calls[0];
    expect(username).toBe('bob');
    expect(ops[0][0]).toBe('comment');
    expect(ops[0][1]).toMatchObject({
      parent_author: 'alice',
      parent_permlink: 'paper-1',
      author: 'bob',
      body: BODY,
    });
    expect(JSON.parse(ops[0][1].json_metadata).pevotest.rating).toEqual({ ...RATINGS });
    expect(ops[1][0]).toBe('comment_options');
    expect(opts).toEqual({ freshAuthProof: 'window-proof' });
    expect(returned.step).toBe('success');
    expect(stashSlot()).toBeNull();
    returned.destroy();
  });

  it('binds the record to the paper the submit started on, even when the route moves during the intent confirm', async () => {
    mockStores.broadcastConfirm.request.mockImplementationOnce(async () => {
      mockStores.router.params = { author: 'carol', permlink: 'paper-2' };
      return true;
    });
    const comp = createComponent(composedReview());

    await comp.handleSubmit();

    expect(navigations).toHaveLength(1);
    expect(JSON.parse(navigations[0].stash).target).toEqual({ author: 'alice', permlink: 'paper-1' });
  });
});

describe('reviewPage restore on mount is bound to paper, surface and subject', () => {
  it('restores every field of a matching record, the anonymous flag included', () => {
    seedStash(reviewRecord({
      payload: { reviewBody: BODY, ratings: { ...RATINGS }, isAnonymous: true },
    }));
    const comp = createComponent();

    comp.init();

    expect(comp.reviewBody).toBe(BODY);
    expect(comp.ratings).toEqual({ ...RATINGS });
    expect(comp.isAnonymous).toBe(true);
    expect(stashSlot()).toBeNull();
  });

  it.each([
    ['another paper by the same author', { author: 'alice', permlink: 'paper-2' }],
    ['the same permlink by another author', { author: 'carol', permlink: 'paper-1' }],
  ])('does not restore a record when the page shows %s, and leaves the record in the slot', (_label, params) => {
    const raw = seedStash(reviewRecord());
    mockStores.router.params = params;
    const comp = createComponent();

    comp.init();

    expectUntouchedForm(comp);
    expect(stashSlot()).toBe(raw);
  });

  it('does not restore a record written by another surface for the same target, and leaves it in the slot', () => {
    const raw = seedStash(reviewRecord({ surface: 'comment' }));
    const comp = createComponent();

    comp.init();

    expectUntouchedForm(comp);
    expect(stashSlot()).toBe(raw);
  });

  it('does not restore a record written by another account, and removes it', () => {
    seedStash(reviewRecord({ subject: 'carol' }));
    const comp = createComponent();

    comp.init();

    expectUntouchedForm(comp);
    expect(stashSlot()).toBeNull();
  });

  it('does not restore while no account is signed in, and leaves the record for the account to return to', () => {
    const raw = seedStash(reviewRecord());
    mockStores.auth.username = null;
    const comp = createComponent();

    comp.init();

    expectUntouchedForm(comp);
    expect(stashSlot()).toBe(raw);
  });

  it('ignores a body, rating or anonymous flag of the wrong type, field by field', () => {
    seedStash(reviewRecord({
      payload: {
        reviewBody: 42,
        ratings: { methodology: 9, novelty: '4', clarity: -1, significance: 3 },
        isAnonymous: 'true',
      },
    }));
    const comp = createComponent();

    comp.init();

    expect(comp.reviewBody).toBe('');
    expect(comp.ratings).toEqual({ methodology: 0, novelty: 0, clarity: 0, significance: 3 });
    expect(comp.isAnonymous).toBe(false);
    expect(stashSlot()).toBeNull();
  });

  it('restores a valid body and flag next to ratings that are not whole stars', () => {
    seedStash(reviewRecord({
      payload: {
        reviewBody: 'Kept.',
        ratings: { methodology: 2.5, novelty: 5, clarity: null, significance: 1 },
        isAnonymous: true,
      },
    }));
    const comp = createComponent();

    comp.init();

    expect(comp.reviewBody).toBe('Kept.');
    expect(comp.ratings).toEqual({ methodology: 0, novelty: 5, clarity: 0, significance: 1 });
    expect(comp.isAnonymous).toBe(true);
  });

  it('restores the body of a record that carries no ratings at all', () => {
    seedStash(reviewRecord({ payload: { reviewBody: 'Only the text.' } }));
    const comp = createComponent();

    comp.init();

    expect(comp.reviewBody).toBe('Only the text.');
    expect(comp.ratings).toEqual({ methodology: 0, novelty: 0, clarity: 0, significance: 0 });
    expect(comp.isAnonymous).toBe(false);
  });
});

describe('reviewPage clears its own record when the review broadcasts', () => {
  // `init()` consumes a matching record, so each spec mounts first and seeds
  // after: what empties the slot can then only be the submit.
  it('a successful broadcast removes the record for this paper', async () => {
    const comp = createComponent(composedReview());
    comp.init();
    seedStash(reviewRecord());
    seedWindow('window-proof');

    await comp.handleSubmit();

    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(comp.step).toBe('success');
    expect(stashSlot()).toBeNull();
    comp.destroy();
  });

  it('a successful broadcast leaves a record for another paper in place', async () => {
    const comp = createComponent(composedReview());
    comp.init();
    const raw = seedStash(reviewRecord({ target: { author: 'alice', permlink: 'paper-2' } }));
    seedWindow('window-proof');

    await comp.handleSubmit();

    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(comp.step).toBe('success');
    expect(stashSlot()).toBe(raw);
    comp.destroy();
  });

  it('an anonymous submit removes the record an earlier signed submit of the same review left', async () => {
    // The signed submit navigated and wrote its record, and the page is still
    // on screen (the ORCID page was left with Back).
    const comp = createComponent(composedReview());
    await comp.handleSubmit();
    expect(navigations).toHaveLength(1);
    expect(stashSlot()).not.toBeNull();
    mockSubmitAnonymousReview.mockResolvedValue({ data: {} });

    comp.isAnonymous = true;
    await comp.handleSubmit();

    expect(mockSubmitAnonymousReview).toHaveBeenCalledTimes(1);
    expect(comp.step).toBe('success');
    expect(stashSlot()).toBeNull();
    comp.destroy();
  });
});

describe('reviewPage when the stash write fails', () => {
  it('does not navigate, asks the unkept-work confirm, and on no keeps the review on screen in silence', async () => {
    mockStores.broadcastConfirm.request
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const attempts = refuseStashWrites();
    const comp = createComponent(composedReview());

    await comp.handleSubmit();

    expect(attempts).toHaveLength(1);
    expect(navigations).toEqual([]);
    expect(window.location.href).toBe('');
    expect(mockStores.broadcastConfirm.request).toHaveBeenCalledTimes(2);
    expect(mockStores.broadcastConfirm.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ title: 'confirm.reviewTitle' }),
    );
    expect(mockStores.broadcastConfirm.request).toHaveBeenNthCalledWith(2, {
      title: UNKEPT_TITLE,
      message: UNKEPT_MESSAGE,
      confirmLabel: UNKEPT_LABEL,
    });
    expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBeNull();
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBeNull();
    expect(mockBroadcastOps).not.toHaveBeenCalled();
    expect(mockStores.toast.show).not.toHaveBeenCalled();
    expect(comp.step).toBe('idle');
    expect(comp.reviewBody).toBe(BODY);
    expect(comp.ratings).toEqual({ ...RATINGS });
    expect(comp.isAnonymous).toBe(false);
  });

  it('on yes navigates to ORCID without the record', async () => {
    mockStores.broadcastConfirm.request
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const attempts = refuseStashWrites();
    const comp = createComponent(composedReview());

    await comp.handleSubmit();

    expect(attempts).toHaveLength(1);
    expect(mockStores.broadcastConfirm.request).toHaveBeenCalledTimes(2);
    expect(mockStores.broadcastConfirm.request).toHaveBeenNthCalledWith(2, {
      title: UNKEPT_TITLE,
      message: UNKEPT_MESSAGE,
      confirmLabel: UNKEPT_LABEL,
    });
    expect(navigations).toEqual([{ href: ORCID_URL, stash: null }]);
    expect(window.location.href).toBe(ORCID_URL);
    expect(mockBroadcastOps).not.toHaveBeenCalled();
    expect(mockStores.toast.show).not.toHaveBeenCalled();
    expect(comp.step).toBe('idle');
  });
});

describe('reviewPage writes no record on a path that does not navigate', () => {
  it('a password-factor account re-auths inline, broadcasts, and writes no record', async () => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    const writes = recordStashWrites();
    const comp = createComponent(composedReview());

    await comp.handleSubmit();

    expect(mockStores.reauthModal.request).toHaveBeenCalledTimes(1);
    expect(mockMintSessionAuthProof).toHaveBeenCalledWith('hunter2');
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(mockBroadcastOps.mock.calls[0][2]).toEqual({ freshAuthProof: 'window-proof' });
    expect(navigations).toEqual([]);
    expect(window.location.href).toBe('');
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(mockStores.broadcastConfirm.request).toHaveBeenCalledTimes(1);
    expect(mockStores.broadcastConfirm.request).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'confirm.reviewTitle' }),
    );
    expect(comp.step).toBe('success');
    comp.destroy();
  });

  it('a passwordless account with a window already open broadcasts and writes no record', async () => {
    seedWindow('window-proof');
    const writes = recordStashWrites();
    const comp = createComponent(composedReview());

    await comp.handleSubmit();

    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(navigations).toEqual([]);
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(comp.step).toBe('success');
    comp.destroy();
  });

  it('an anonymous review goes through the proxy endpoint and writes no record', async () => {
    const writes = recordStashWrites();
    const comp = createComponent(composedReview({ isAnonymous: true }));

    await comp.handleSubmit();

    expect(mockSubmitAnonymousReview).toHaveBeenCalledWith({
      paper_author: 'alice',
      paper_permlink: 'paper-1',
      body: BODY,
      rating: { ...RATINGS },
    });
    expect(writes).toEqual([]);
    expect(navigations).toEqual([]);
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(mockBroadcastOps).not.toHaveBeenCalled();
    expect(mockStores.broadcastConfirm.request).not.toHaveBeenCalled();
    expect(comp.step).toBe('success');
    comp.destroy();
  });
});

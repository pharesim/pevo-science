// Coverage for the comment composer's side of the navigation stash
// (`frontend/src/lib/navigation-stash.js`): what `commentComposer` hands
// `broadcastWithFreshAuth` to keep across a passwordless account's ORCID
// round-trip, and what it takes back when it mounts on return. The composer
// runs here against the REAL fresh-auth helper and the REAL stash module.
// `components-comment-composer.test.js` replaces the helper wholesale, so it
// cannot see the navigation, the stash write or the success clear; that is
// why these cases live in their own file.
//
// Mocking justification (clause-a of project-CLAUDE.md "Carve-out for
// deterministic edge-case coverage"): `startOrcid`, `fetchEmailStatus` and
// `mintSessionAuthProof` perform real fetch() against the backend, and
// exercising the passwordless and the password factor per test would need two
// differently-provisioned live accounts. The ORCID leg is a full-page
// navigation, which jsdom can only observe (through a stubbed
// `window.location` whose href setter records what the stash slot held at the
// moment of assignment), not follow; the return is staged by mounting a fresh
// composer over the sessionStorage the navigation left behind.
// `signer.js#broadcastOps` carries the operations out of the tab; it is mocked
// so a successful submit can be observed with the window proof it carried.
// Alpine is mocked so the component factory runs without a DOM mount, with
// `$nextTick` recorded rather than run, so the deferral of the restore event
// and of the scroll can be asserted.
//
// Auth-focus carve-out (clause-b): no auth middleware is mocked and no
// cryptographic verification is bypassed. These tests assert what the client
// stores and restores around a navigation; the proof itself is minted and
// verified server-side.
//
// Clause-c real-path companion: `frontend/tests/e2e/non-consent-fresh-auth.spec.js`
// drives a real broadcast through a real session window on the password
// factor. No e2e spec completes a session_auth ORCID round-trip, so the stash
// write at the navigation and the restore on return are pinned here only.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockBroadcastOps = vi.fn();
const mockStartOrcid = vi.fn();
const mockFetchEmailStatus = vi.fn();
const mockMintSessionAuthProof = vi.fn();
const mockReauthModal = { request: vi.fn() };
const mockToastStore = { show: vi.fn() };
const mockBroadcastConfirm = { request: vi.fn() };
const mockAuthStore = {
  custody: 'light',
  username: 'alice',
  isConnected: true,
  isAccredited: true,
  disconnect: vi.fn(),
};

vi.mock('../../src/signer.js', () => ({
  broadcastOps: (...args) => mockBroadcastOps(...args),
}));

vi.mock('../../src/api.js', () => ({
  startOrcid: (...args) => mockStartOrcid(...args),
  consentOpRequestFields: (t) => t,
  fetchEmailStatus: (...args) => mockFetchEmailStatus(...args),
  mintSessionAuthProof: (...args) => mockMintSessionAuthProof(...args),
}));

vi.mock('../../src/config.js', () => ({
  getAppTag: () => 'pevotest',
  getAppId: () => 'pevo/1.0',
}));

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'auth') return mockAuthStore;
      if (name === 'toast') return mockToastStore;
      if (name === 'reauthModal') return mockReauthModal;
      if (name === 'broadcastConfirm') return mockBroadcastConfirm;
      if (name === 'i18n') return { messages: {} };
      return {};
    }),
  },
}));

const { default: Alpine } = await import('alpinejs');
const { initCommentComposer } = await import('../../src/components/comment-composer.js');
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
const PAPER_PATH = '/paper/carol/paper-1';

// The confirm a refused stash write asks, in its English fallbacks (the i18n
// store holds no messages here).
const UNKEPT_CONFIRM = {
  title: 'Confirm your identity',
  message: 'Confirming your identity with ORCID means leaving this page. What you have entered here could not be kept, so it will be lost.',
  confirmLabel: 'Continue to ORCID',
};

// A reply composer in the paper's discussion thread, and the discussion
// composer itself: the same thread root, different parents. Each opts object
// has exactly the shape of the stash target the composer builds from it.
const REPLY = { rootAuthor: 'carol', rootPermlink: 'paper-1', parentAuthor: 'bob', parentPermlink: 'c1' };
const DISCUSSION = { rootAuthor: 'carol', rootPermlink: 'paper-1', parentAuthor: 'carol', parentPermlink: 'paper-1' };

// Every href assignment, with what the stash slot held at that instant.
let navigations = [];

function stubWindow() {
  navigations = [];
  let href = '';
  vi.stubGlobal('window', {
    ...globalThis.window,
    location: {
      pathname: PAPER_PATH,
      get href() { return href; },
      set href(value) {
        navigations.push({ href: value, stash: sessionStorage.getItem(NAVIGATION_STASH_KEY) });
        href = value;
      },
    },
  });
}

// `$nextTick` callbacks are queued per component and run only by flushTick,
// one generation at a time: a callback queued while a flush runs waits for
// the next flush.
const tickQueues = new WeakMap();

function flushTick(comp) {
  const queued = tickQueues.get(comp).splice(0);
  for (const fn of queued) fn();
}

function createComposer(opts) {
  initCommentComposer();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory(opts);
  const queue = [];
  tickQueues.set(comp, queue);
  comp.$t = (key) => key;
  comp.$dispatch = vi.fn();
  comp.$el = document.createElement('div');
  comp.$el.scrollIntoView = vi.fn();
  comp.$nextTick = vi.fn((fn) => { queue.push(fn); });
  return comp;
}

function seedStash(record) {
  sessionStorage.setItem(NAVIGATION_STASH_KEY, JSON.stringify({ savedAt: Date.now(), ...record }));
}

function storedStash() {
  const raw = sessionStorage.getItem(NAVIGATION_STASH_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function seedLiveWindow(token) {
  sessionStorage.setItem(SESSION_PROOF_KEY, JSON.stringify({
    token,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    idlePeriodMs: 900_000,
  }));
}

// Records every write to the stash key, passing every write through to the
// real storage, or throwing for the stash key alone when `fail` is set. A
// blanket throw would fail earlier, at the ORCID mode-marker write, and never
// reach the stash.
function recordStashWrites({ fail = false } = {}) {
  const writes = [];
  const { setItem } = Storage.prototype;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function recordingSetItem(key, value) {
    if (key === NAVIGATION_STASH_KEY) {
      writes.push(value);
      if (fail) throw new Error('quota exceeded');
    }
    return setItem.call(this, key, value);
  });
  return writes;
}

// Submit a comment from a freshly mounted composer, with no window open, and
// let the passwordless acquisition navigate to ORCID.
async function submitAndNavigate(opts, body) {
  const comp = createComposer(opts);
  comp.init();
  comp.body = body;
  await comp.handleSubmit();
  expect(navigations.map((n) => n.href)).toEqual([ORCID_URL]);
  return comp;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  clearCachedSessionProof();
  clearPasswordFactorMemo();
  abandonInFlightAcquisitions();
  mockAuthStore.custody = 'light';
  mockAuthStore.username = 'alice';
  mockAuthStore.isConnected = true;
  mockAuthStore.isAccredited = true;
  mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
  mockStartOrcid.mockResolvedValue({ redirect_url: ORCID_URL });
  mockBroadcastOps.mockResolvedValue({ tx_id: 'tx' });
  mockBroadcastConfirm.request.mockResolvedValue(true);
  stubWindow();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('commentComposer keeps a comment across the passwordless ORCID round-trip', () => {
  it('writes the comment, bound to its thread root, parent and account, before it navigates to ORCID', async () => {
    const comp = createComposer(REPLY);
    comp.init();
    comp.body = 'A reply worth keeping';

    await comp.handleSubmit();

    expect(navigations).toHaveLength(1);
    expect(navigations[0].href).toBe(ORCID_URL);
    expect(JSON.parse(navigations[0].stash)).toEqual({
      surface: 'comment',
      target: { rootAuthor: 'carol', rootPermlink: 'paper-1', parentAuthor: 'bob', parentPermlink: 'c1' },
      subject: 'alice',
      payload: { body: 'A reply worth keeping' },
      savedAt: expect.any(Number),
    });
    // The page is leaving: the composer keeps its text and does not report a
    // posted comment.
    expect(comp.body).toBe('A reply worth keeping');
    expect(comp.isSubmitting).toBe(false);
    expect(comp.error).toBeNull();
    expect(comp.$dispatch).not.toHaveBeenCalled();
    expect(mockBroadcastOps).not.toHaveBeenCalled();
    expect(mockToastStore.show).not.toHaveBeenCalled();
  });

  it('a fresh composer for the same root and parent takes the comment back at init, then announces it and scrolls on later ticks', async () => {
    await submitAndNavigate(REPLY, 'A reply worth keeping');

    const returned = createComposer(REPLY);
    returned.init();

    expect(returned.body).toBe('A reply worth keeping');
    expect(storedStash()).toBeNull();
    // A listener on the composer's own element is bound only after init
    // returns, so the event waits a tick, and the scroll waits one more for
    // the reply box the event opens.
    expect(returned.$dispatch).not.toHaveBeenCalled();
    expect(returned.$el.scrollIntoView).not.toHaveBeenCalled();

    flushTick(returned);
    expect(returned.$dispatch).toHaveBeenCalledTimes(1);
    expect(returned.$dispatch).toHaveBeenCalledWith('comment-restored');
    expect(returned.$el.scrollIntoView).not.toHaveBeenCalled();

    flushTick(returned);
    expect(returned.$el.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(returned.$el.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
  });

  it('a composer for another parent mounting first leaves the record for the reply composer that mounts later', async () => {
    await submitAndNavigate(REPLY, 'A reply worth keeping');
    const written = storedStash();

    // The paper page mounts its discussion composer before the reply
    // composers its comment tree renders once the comments load.
    const discussion = createComposer(DISCUSSION);
    discussion.init();

    expect(discussion.body).toBe('');
    expect(discussion.$nextTick).not.toHaveBeenCalled();
    expect(discussion.$dispatch).not.toHaveBeenCalled();
    expect(storedStash()).toEqual(written);

    const reply = createComposer(REPLY);
    reply.init();

    expect(reply.body).toBe('A reply worth keeping');
    expect(storedStash()).toBeNull();
  });

  it('a composer with the same parent under another thread root does not take the comment', async () => {
    await submitAndNavigate(REPLY, 'A reply worth keeping');
    const written = storedStash();

    const otherThread = createComposer({ ...REPLY, rootAuthor: 'dave', rootPermlink: 'review-1' });
    otherThread.init();

    expect(otherThread.body).toBe('');
    expect(otherThread.$nextTick).not.toHaveBeenCalled();
    expect(storedStash()).toEqual(written);
  });

  it("another account's comment is not restored, and is removed from the slot", () => {
    seedStash({ surface: 'comment', target: { ...REPLY }, subject: 'mallory', payload: { body: "mallory's reply" } });

    const comp = createComposer(REPLY);
    comp.init();

    expect(comp.body).toBe('');
    expect(comp.$nextTick).not.toHaveBeenCalled();
    expect(storedStash()).toBeNull();
  });

  it('a record whose body is not text restores nothing and announces nothing', () => {
    seedStash({ surface: 'comment', target: { ...REPLY }, subject: 'alice', payload: { body: 42 } });

    const comp = createComposer(REPLY);
    comp.init();

    expect(comp.body).toBe('');
    expect(comp.$nextTick).not.toHaveBeenCalled();
  });

  it('a successful submit inside a live window removes its own record from the slot', async () => {
    seedLiveWindow('live-window');
    const comp = createComposer(REPLY);
    // Mounted first, so the record seeded next is the one the success clears
    // and not one init() already consumed.
    comp.init();
    seedStash({ surface: 'comment', target: { ...REPLY }, subject: 'alice', payload: { body: 'kept' } });
    comp.body = 'kept';

    await comp.handleSubmit();

    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(mockBroadcastOps.mock.calls[0][2]).toEqual({ freshAuthProof: 'live-window' });
    expect(navigations).toEqual([]);
    expect(storedStash()).toBeNull();
    expect(comp.body).toBe('');
    expect(comp.$dispatch).toHaveBeenCalledWith('comment-posted', { parentPermlink: 'c1' });
  });

  it("a successful submit leaves another composer's record in the slot", async () => {
    seedLiveWindow('live-window');
    const comp = createComposer(REPLY);
    comp.init();
    const discussionRecord = {
      surface: 'comment',
      target: { ...DISCUSSION },
      subject: 'alice',
      payload: { body: 'a discussion comment' },
      savedAt: 1,
    };
    seedStash(discussionRecord);
    comp.body = 'a reply';

    await comp.handleSubmit();

    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(storedStash()).toEqual(discussionRecord);
  });

  it('a stash write that fails does not navigate, asks the unkept-work confirm, and a no keeps the comment on screen', async () => {
    // The first answer is the composer's own intent confirm.
    mockBroadcastConfirm.request.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const comp = createComposer(REPLY);
    comp.init();
    comp.body = 'A reply worth keeping';
    const writes = recordStashWrites({ fail: true });

    await comp.handleSubmit();

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({ surface: 'comment', target: REPLY, payload: { body: 'A reply worth keeping' } });
    expect(mockBroadcastConfirm.request).toHaveBeenCalledTimes(2);
    expect(mockBroadcastConfirm.request).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: 'confirm.commentTitle' }));
    expect(mockBroadcastConfirm.request).toHaveBeenNthCalledWith(2, UNKEPT_CONFIRM);
    expect(navigations).toEqual([]);
    expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBeNull();
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBeNull();
    expect(storedStash()).toBeNull();
    expect(comp.body).toBe('A reply worth keeping');
    expect(comp.isSubmitting).toBe(false);
    expect(comp.error).toBeNull();
    expect(comp.$dispatch).not.toHaveBeenCalled();
    expect(mockToastStore.show).not.toHaveBeenCalled();
    expect(mockBroadcastOps).not.toHaveBeenCalled();
  });

  it('a stash write that fails, answered yes, navigates to ORCID without the comment', async () => {
    mockBroadcastConfirm.request.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    const comp = createComposer(REPLY);
    comp.init();
    comp.body = 'A reply worth keeping';
    recordStashWrites({ fail: true });

    await comp.handleSubmit();

    expect(mockBroadcastConfirm.request).toHaveBeenNthCalledWith(2, UNKEPT_CONFIRM);
    expect(navigations).toEqual([{ href: ORCID_URL, stash: null }]);
    expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBe('session_auth');
    expect(comp.isSubmitting).toBe(false);
    expect(mockToastStore.show).not.toHaveBeenCalled();
    expect(mockBroadcastOps).not.toHaveBeenCalled();
  });

  it('a password-factor account mints inline: nothing is written to the stash and the comment is broadcast', async () => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    mockReauthModal.request.mockResolvedValue('hunter2');
    mockMintSessionAuthProof.mockResolvedValue({
      fresh_auth_proof: 'password-window',
      expires_at: new Date(Date.now() + 900_000).toISOString(),
      absolute_expires_at: new Date(Date.now() + 7_200_000).toISOString(),
      mechanism: 'password',
    });
    const comp = createComposer(REPLY);
    comp.init();
    comp.body = 'Typed inline';
    const writes = recordStashWrites();

    await comp.handleSubmit();

    expect(writes).toEqual([]);
    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(navigations).toEqual([]);
    // Only the composer's own intent confirm: no navigation cost to state.
    expect(mockBroadcastConfirm.request).toHaveBeenCalledTimes(1);
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(mockBroadcastOps.mock.calls[0][2]).toEqual({ freshAuthProof: 'password-window' });
    expect(comp.body).toBe('');
  });
});

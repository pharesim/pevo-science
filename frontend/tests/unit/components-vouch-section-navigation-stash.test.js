// Coverage for the vouch section's side of the navigation stash
// (`frontend/src/lib/navigation-stash.js`): what `handleVouch` and
// `handleRetract` hand `broadcastWithFreshAuth` to keep across a passwordless
// account's ORCID round-trip, and what `vouchSection`'s init() takes back on
// return, the relationship at once and the retraction reason once the vouch
// status confirms the vouch. The section runs here against the REAL fresh-auth
// helper and the REAL stash module. `components-vouch-section.test.js`
// replaces the helper wholesale, so it cannot see the navigation, the stash
// write or the success clear; that is why these cases live in their own file.
// Each handler's record is pinned exactly (surface, target and payload), so a
// change to one handler's stash cannot pass under the other's assertions.
//
// Mocking justification (clause-a of project-CLAUDE.md "Carve-out for
// deterministic edge-case coverage"): `startOrcid`, `fetchEmailStatus` and
// `mintSessionAuthProof` perform real fetch() against the backend, and
// exercising the passwordless and the password factor per test would need two
// differently-provisioned live accounts. The ORCID leg is a full-page
// navigation, which jsdom can only observe (through a stubbed
// `window.location` whose href setter records what the stash slot held at the
// moment of assignment), not follow; the return is staged by mounting a fresh
// section over the sessionStorage the navigation left behind.
// `fetchVouchStatus`, `notifyVouch` and `notifyRetractVouch` read and notify
// the backend: they are mocked so the status can be parked, failed or shaped
// per case, which is what orders the retraction restore after the status.
// `signer.js#broadcastOps` carries the operations out of the tab; it is mocked
// so a successful broadcast can be observed with the window proof it carried.
// Alpine is mocked so the component factory runs without a DOM mount.
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
const mockFetchVouchStatus = vi.fn();
const mockNotifyVouch = vi.fn();
const mockNotifyRetractVouch = vi.fn();
const mockReauthModal = { request: vi.fn() };
const mockToastStore = { show: vi.fn() };
const mockBroadcastConfirm = { request: vi.fn() };
const mockRouterStore = { navigate: vi.fn() };
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
  fetchVouchStatus: (...args) => mockFetchVouchStatus(...args),
  notifyVouch: (...args) => mockNotifyVouch(...args),
  notifyRetractVouch: (...args) => mockNotifyRetractVouch(...args),
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
      if (name === 'router') return mockRouterStore;
      if (name === 'i18n') return { messages: {} };
      return {};
    }),
  },
}));

const { default: Alpine } = await import('alpinejs');
const { initVouchSection } = await import('../../src/components/vouch-section.js');
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
const PROFILE_PATH = '/profile/bob';

// The confirm a refused stash write asks, in its English fallbacks (the i18n
// store holds no messages here).
const UNKEPT_CONFIRM = {
  title: 'Confirm your identity',
  message: 'Confirming your identity with ORCID means leaving this page. What you have entered here could not be kept, so it will be lost.',
  confirmLabel: 'Continue to ORCID',
};

const NO_VOUCHES = { data: { vouches: [] } };
const ALICE_VOUCHED = {
  data: { vouches: [{ voucher: 'alice', relationship: 'colleague', created_at: '2026-10-01T00:00:00Z' }] },
};

// Every href assignment, with what the stash slot held at that instant.
let navigations = [];

function stubWindow() {
  navigations = [];
  let href = '';
  vi.stubGlobal('window', {
    ...globalThis.window,
    location: {
      pathname: PROFILE_PATH,
      get href() { return href; },
      set href(value) {
        navigations.push({ href: value, stash: sessionStorage.getItem(NAVIGATION_STASH_KEY) });
        href = value;
      },
    },
  });
}

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function createSection(opts = { targetUsername: 'bob' }) {
  initVouchSection();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory(opts);
  comp.$t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);
  comp.$dispatch = vi.fn();
  comp.$el = document.createElement('div');
  return comp;
}

// A section mounted with its vouch status loaded, and init()'s restore pass
// over the status already run.
async function mountSection(status, opts = { targetUsername: 'bob' }) {
  mockFetchVouchStatus.mockResolvedValueOnce(status);
  const comp = createSection(opts);
  comp.init();
  await tick();
  expect(comp.loading).toBe(false);
  return comp;
}

function parkVouchStatus() {
  let resolve;
  mockFetchVouchStatus.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  return (status) => resolve(status);
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

// vouchAndNavigate and retractAndNavigate submit from a freshly mounted
// section with no window open, so the passwordless acquisition navigates to
// ORCID and leaves that handler's record in the slot.
async function vouchAndNavigate(relationship, opts) {
  const comp = await mountSection(NO_VOUCHES, opts);
  comp.relationship = relationship;
  await comp.handleVouch();
  expect(navigations.map((n) => n.href)).toEqual([ORCID_URL]);
  return comp;
}

async function retractAndNavigate(reason, opts) {
  const comp = await mountSection(ALICE_VOUCHED, opts);
  comp.showRetract = true;
  comp.retractReason = reason;
  await comp.handleRetract();
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
  mockFetchVouchStatus.mockResolvedValue(NO_VOUCHES);
  mockNotifyVouch.mockResolvedValue({ data: { accredited: false } });
  mockNotifyRetractVouch.mockResolvedValue({ data: { revocation_outcome: 'skipped', revocations: [] } });
  stubWindow();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('vouchSection writes its work to the stash before the ORCID navigation', () => {
  it('handleVouch writes the chosen relationship as a vouch record for this vouchee and account', async () => {
    const comp = await mountSection(NO_VOUCHES);
    comp.relationship = 'advisor';

    await comp.handleVouch();

    expect(navigations).toHaveLength(1);
    expect(navigations[0].href).toBe(ORCID_URL);
    expect(JSON.parse(navigations[0].stash)).toEqual({
      surface: 'vouch',
      target: { vouchee: 'bob' },
      subject: 'alice',
      payload: { relationship: 'advisor' },
      savedAt: expect.any(Number),
    });
    expect(comp.step).toBe('idle');
    expect(comp.relationship).toBe('advisor');
    expect(comp.message).toBe('');
    expect(mockBroadcastOps).not.toHaveBeenCalled();
    expect(mockNotifyVouch).not.toHaveBeenCalled();
    expect(mockToastStore.show).not.toHaveBeenCalled();
  });

  it('handleRetract writes the reason as a retract record for this vouchee and account', async () => {
    const comp = await mountSection(ALICE_VOUCHED);
    expect(comp.canRetract).toBe(true);
    comp.showRetract = true;
    comp.retractReason = 'conflict';

    await comp.handleRetract();

    expect(navigations).toHaveLength(1);
    expect(navigations[0].href).toBe(ORCID_URL);
    expect(JSON.parse(navigations[0].stash)).toEqual({
      surface: 'retract',
      target: { vouchee: 'bob' },
      subject: 'alice',
      payload: { retractReason: 'conflict' },
      savedAt: expect.any(Number),
    });
    expect(comp.step).toBe('idle');
    expect(comp.retractReason).toBe('conflict');
    expect(comp.showRetract).toBe(true);
    expect(mockBroadcastOps).not.toHaveBeenCalled();
    expect(mockNotifyRetractVouch).not.toHaveBeenCalled();
    expect(mockToastStore.show).not.toHaveBeenCalled();
  });
});

describe('vouchSection takes its work back when it mounts on return', () => {
  it('a vouch record restores the relationship in init(), before the vouch status has loaded', async () => {
    await vouchAndNavigate('advisor');

    const resolveStatus = parkVouchStatus();
    const returned = createSection();
    returned.init();

    expect(returned.relationship).toBe('advisor');
    expect(returned.loading).toBe(true);
    expect(returned.vouchStatus).toBeNull();
    expect(storedStash()).toBeNull();
    expect(mockFetchVouchStatus).toHaveBeenLastCalledWith('bob');

    resolveStatus(NO_VOUCHES);
    await tick();
    expect(returned.relationship).toBe('advisor');
    expect(returned.showRetract).toBe(false);
  });

  it('a retract record is taken only once the status confirms the vouch, then reopens the retraction with its reason', async () => {
    await retractAndNavigate('conflict');
    const written = storedStash();

    const resolveStatus = parkVouchStatus();
    const returned = createSection();
    returned.init();

    expect(returned.retractReason).toBe('');
    expect(returned.showRetract).toBe(false);
    expect(storedStash()).toEqual(written);

    resolveStatus(ALICE_VOUCHED);
    await tick();

    expect(returned.retractReason).toBe('conflict');
    expect(returned.showRetract).toBe(true);
    expect(returned.relationship).toBe('colleague');
    expect(storedStash()).toBeNull();
  });

  it.each([
    ['the vouch status cannot be read', () => mockFetchVouchStatus.mockRejectedValueOnce(new Error('status unavailable'))],
    ['the vouch status shows no vouch by this account', () => mockFetchVouchStatus.mockResolvedValueOnce({ data: { vouches: [{ voucher: 'carol' }] } })],
  ])('a retract record is left in the slot and nothing is shown when %s', async (_label, arrangeStatus) => {
    const record = { surface: 'retract', target: { vouchee: 'bob' }, subject: 'alice', payload: { retractReason: 'conflict' }, savedAt: 1 };
    seedStash(record);
    arrangeStatus();

    const comp = createSection();
    comp.init();
    await tick();

    expect(comp.loading).toBe(false);
    expect(comp.retractReason).toBe('');
    expect(comp.showRetract).toBe(false);
    expect(storedStash()).toEqual(record);
  });

  it('a retract record is left in the slot when the section is torn down before the status loads', async () => {
    const record = { surface: 'retract', target: { vouchee: 'bob' }, subject: 'alice', payload: { retractReason: 'conflict' }, savedAt: 1 };
    seedStash(record);
    const resolveStatus = parkVouchStatus();

    const comp = createSection();
    comp.init();
    comp.destroy();
    resolveStatus(ALICE_VOUCHED);
    await tick();

    expect(comp.retractReason).toBe('');
    expect(comp.showRetract).toBe(false);
    expect(storedStash()).toEqual(record);
  });

  it('a retract record whose reason is not text reopens nothing', async () => {
    seedStash({ surface: 'retract', target: { vouchee: 'bob' }, subject: 'alice', payload: { retractReason: 42 } });
    mockFetchVouchStatus.mockResolvedValueOnce(ALICE_VOUCHED);

    const comp = createSection();
    comp.init();
    await tick();

    expect(comp.canRetract).toBe(true);
    expect(comp.showRetract).toBe(false);
    expect(comp.retractReason).toBe('');
  });

  it('a retract record does not restore into the relationship', async () => {
    const record = {
      surface: 'retract',
      target: { vouchee: 'bob' },
      subject: 'alice',
      payload: { relationship: 'advisor', retractReason: 'conflict' },
      savedAt: 1,
    };
    seedStash(record);

    const comp = createSection();
    comp.init();

    expect(comp.relationship).toBe('colleague');
    expect(storedStash()).toEqual(record);
    await tick();
    expect(comp.relationship).toBe('colleague');
  });

  it('a vouch record does not open the retraction', async () => {
    seedStash({
      surface: 'vouch',
      target: { vouchee: 'bob' },
      subject: 'alice',
      payload: { relationship: 'advisor', retractReason: 'conflict' },
    });
    mockFetchVouchStatus.mockResolvedValueOnce(ALICE_VOUCHED);

    const comp = createSection();
    comp.init();
    await tick();

    expect(comp.canRetract).toBe(true);
    expect(comp.showRetract).toBe(false);
    expect(comp.retractReason).toBe('');
    expect(storedStash()).toBeNull();
  });

  it('a relationship outside the offered choices is ignored', () => {
    seedStash({ surface: 'vouch', target: { vouchee: 'bob' }, subject: 'alice', payload: { relationship: 'enemy' } });

    const comp = createSection();
    comp.init();

    expect(comp.relationship).toBe('colleague');
    expect(storedStash()).toBeNull();
  });

  it("a vouch for another vouchee is not restored on this vouchee's section", async () => {
    await vouchAndNavigate('advisor', { targetUsername: 'carol' });
    const written = storedStash();

    const comp = createSection({ targetUsername: 'bob' });
    comp.init();

    expect(comp.relationship).toBe('colleague');
    expect(storedStash()).toEqual(written);
  });

  it("a retraction for another vouchee is not restored on this vouchee's section", async () => {
    await retractAndNavigate('conflict', { targetUsername: 'carol' });
    const written = storedStash();
    mockFetchVouchStatus.mockResolvedValueOnce(ALICE_VOUCHED);

    const comp = createSection({ targetUsername: 'bob' });
    comp.init();
    await tick();

    expect(comp.canRetract).toBe(true);
    expect(comp.showRetract).toBe(false);
    expect(comp.retractReason).toBe('');
    expect(storedStash()).toEqual(written);
  });

  it("another account's vouch is not restored, and is removed from the slot", () => {
    seedStash({ surface: 'vouch', target: { vouchee: 'bob' }, subject: 'mallory', payload: { relationship: 'advisor' } });

    const comp = createSection();
    comp.init();

    expect(comp.relationship).toBe('colleague');
    expect(storedStash()).toBeNull();
  });
});

describe('vouchSection removes its own record when the broadcast succeeds', () => {
  it('a successful vouch removes the vouch record', async () => {
    seedLiveWindow('live-window');
    // Mounted first, so the record seeded next is the one the success clears
    // and not one init() already consumed.
    const comp = await mountSection(NO_VOUCHES);
    seedStash({ surface: 'vouch', target: { vouchee: 'bob' }, subject: 'alice', payload: { relationship: 'advisor' } });
    comp.relationship = 'advisor';

    await comp.handleVouch();

    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(mockBroadcastOps.mock.calls[0][2]).toEqual({ freshAuthProof: 'live-window' });
    expect(navigations).toEqual([]);
    expect(comp.step).toBe('success');
    expect(storedStash()).toBeNull();
  });

  it('a successful retraction removes the retract record', async () => {
    seedLiveWindow('live-window');
    const comp = await mountSection(ALICE_VOUCHED);
    seedStash({ surface: 'retract', target: { vouchee: 'bob' }, subject: 'alice', payload: { retractReason: 'conflict' } });
    comp.showRetract = true;
    comp.retractReason = 'conflict';

    await comp.handleRetract();

    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(mockBroadcastOps.mock.calls[0][2]).toEqual({ freshAuthProof: 'live-window' });
    expect(navigations).toEqual([]);
    expect(comp.step).toBe('success');
    expect(storedStash()).toBeNull();
  });
});

describe('vouchSection when the stash write fails', () => {
  it('handleVouch does not navigate, asks the unkept-work confirm, and a no keeps the relationship', async () => {
    mockBroadcastConfirm.request.mockResolvedValue(false);
    const comp = await mountSection(NO_VOUCHES);
    comp.relationship = 'advisor';
    const writes = recordStashWrites({ fail: true });

    await comp.handleVouch();

    expect(writes.map((w) => JSON.parse(w))).toEqual([expect.objectContaining({
      surface: 'vouch',
      target: { vouchee: 'bob' },
      payload: { relationship: 'advisor' },
    })]);
    expect(mockBroadcastConfirm.request).toHaveBeenCalledTimes(1);
    expect(mockBroadcastConfirm.request).toHaveBeenCalledWith(UNKEPT_CONFIRM);
    expect(navigations).toEqual([]);
    expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBeNull();
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBeNull();
    expect(storedStash()).toBeNull();
    expect(comp.step).toBe('idle');
    expect(comp.message).toBe('');
    expect(comp.relationship).toBe('advisor');
    expect(mockToastStore.show).not.toHaveBeenCalled();
    expect(mockBroadcastOps).not.toHaveBeenCalled();
  });

  it('handleRetract does not navigate, asks the unkept-work confirm, and a no keeps the reason on screen', async () => {
    mockBroadcastConfirm.request.mockResolvedValue(false);
    const comp = await mountSection(ALICE_VOUCHED);
    comp.showRetract = true;
    comp.retractReason = 'conflict';
    const writes = recordStashWrites({ fail: true });

    await comp.handleRetract();

    expect(writes.map((w) => JSON.parse(w))).toEqual([expect.objectContaining({
      surface: 'retract',
      target: { vouchee: 'bob' },
      payload: { retractReason: 'conflict' },
    })]);
    expect(mockBroadcastConfirm.request).toHaveBeenCalledTimes(1);
    expect(mockBroadcastConfirm.request).toHaveBeenCalledWith(UNKEPT_CONFIRM);
    expect(navigations).toEqual([]);
    expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBeNull();
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBeNull();
    expect(storedStash()).toBeNull();
    expect(comp.step).toBe('idle');
    expect(comp.message).toBe('');
    expect(comp.retractReason).toBe('conflict');
    expect(comp.showRetract).toBe(true);
    expect(mockToastStore.show).not.toHaveBeenCalled();
    expect(mockBroadcastOps).not.toHaveBeenCalled();
  });
});

describe('vouchSection on a password-factor account', () => {
  beforeEach(() => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    mockReauthModal.request.mockResolvedValue('hunter2');
    mockMintSessionAuthProof.mockResolvedValue({
      fresh_auth_proof: 'password-window',
      expires_at: new Date(Date.now() + 900_000).toISOString(),
      absolute_expires_at: new Date(Date.now() + 7_200_000).toISOString(),
      mechanism: 'password',
    });
  });

  it.each([
    ['handleVouch', NO_VOUCHES, (comp) => { comp.relationship = 'advisor'; }],
    ['handleRetract', ALICE_VOUCHED, (comp) => { comp.showRetract = true; comp.retractReason = 'conflict'; }],
  ])('%s mints inline: nothing is written to the stash and the broadcast goes out', async (handler, status, compose) => {
    const comp = await mountSection(status);
    compose(comp);
    const writes = recordStashWrites();

    await comp[handler]();

    expect(writes).toEqual([]);
    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(mockBroadcastConfirm.request).not.toHaveBeenCalled();
    expect(navigations).toEqual([]);
    expect(mockBroadcastOps).toHaveBeenCalledTimes(1);
    expect(mockBroadcastOps.mock.calls[0][2]).toEqual({ freshAuthProof: 'password-window' });
    expect(comp.step).toBe('success');
  });
});

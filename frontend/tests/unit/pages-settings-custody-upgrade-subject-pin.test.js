// Custody-upgrade re-login subject pin.
//
// Test focus: the subject contract of the two custody-upgrade
// `loginFromResponse` call sites (the upgrade executor and its backend-only
// retry). The backend cleanup POST can take up to 20 seconds, and the error
// screen the retry starts from has no timeout at all; a sign-out or a
// cross-tab login as a different user inside either window moves the
// singleton auth store off the account the upgrade started for. Each call
// site pins that account before its first await, and a landing for a subject
// the tab no longer represents is dropped rather than adopted: the store is
// left to its current owner and the flow ends in a terminal sub-case. An
// ordinary same-subject upgrade still lands and keeps its live fresh-auth
// window, and the retry leg refuses to spend a proof attempt against a
// store that has moved on.
//
// Carve-out clause (a): mirrors the sibling settings suites' fixture shape —
// Alpine stores, dhive, and hive-keys are stubbed because driving a real
// chain broadcast plus backend cleanup per test is impractical, and the focus
// here is the frontend subject-adoption payload contract, not cryptographic
// verification. The risk class (proof/signature correctness) is covered
// real-path by sec-001-equivalence.test.js and the backend custody tests.
// The intervening cross-tab login is simulated by mutating the store fields
// and tab-subject marker directly — the net effect of the storage-event
// restore path, which auth.test.js covers against the real store.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLoginFromResponse } from './fixtures/mock-auth.js';
import {
  TAB_SUBJECT_KEY,
  SESSION_PROOF_KEY,
} from '../../src/lib/subject-bound-keys.js';

const mockFetchEmailStatus = vi.fn();
const mockSubmitEmail = vi.fn();
const mockDeleteEmail = vi.fn();
const mockStartOrcid = vi.fn();
const mockSetPassword = vi.fn();
const mockSubmitAccreditationMetadata = vi.fn();
const mockFetchAdminRoster = vi.fn(() => Promise.resolve({ data: { tier: null } }));
const mockIsKeychainInstalled = vi.fn(() => true);

vi.mock('../../src/api.js', () => ({
  fetchEmailStatus: (...args) => mockFetchEmailStatus(...args),
  submitEmail: (...args) => mockSubmitEmail(...args),
  deleteEmail: (...args) => mockDeleteEmail(...args),
  startOrcid: (...args) => mockStartOrcid(...args),
  setPassword: (...args) => mockSetPassword(...args),
  submitAccreditationMetadata: (...args) => mockSubmitAccreditationMetadata(...args),
  fetchAdminRoster: (...args) => mockFetchAdminRoster(...args),
}));

vi.mock('../../src/keychain.js', () => ({
  isKeychainInstalled: (...args) => mockIsKeychainInstalled(...args),
}));

const STUB_WIFS = {
  owner: '5K' + 'A'.repeat(48),
  active: '5K' + 'B'.repeat(48),
  posting: '5K' + 'C'.repeat(48),
  memo: '5K' + 'D'.repeat(48),
};

vi.mock('../../src/hive-keys.js', () => ({
  deriveHiveKeys: vi.fn(async () => ({ ...STUB_WIFS })),
  deriveHivePublicKeys: vi.fn(async () => ({
    owner: 'STM' + 'o'.repeat(50),
    active: 'STM' + 'a'.repeat(50),
    posting: 'STM' + 'p'.repeat(50),
    memo: 'STM' + 'm'.repeat(50),
  })),
  loadDhive: vi.fn(async () => await import('@hiveio/dhive')),
  generateMnemonic: vi.fn(() => Array(12).fill('test').join(' ')),
  validateMnemonic: vi.fn(() => true),
}));

function fakePrivateKey() {
  return {
    toString: () => STUB_WIFS.active,
    createPublic: () => ({ toString: () => 'STM' + 'a'.repeat(50) }),
    sign: () => ({ toString: () => '20' + 'f'.repeat(128) }),
  };
}
vi.mock('@hiveio/dhive', () => ({
  PrivateKey: {
    fromString: vi.fn(() => fakePrivateKey()),
  },
  Client: vi.fn(() => ({
    broadcast: {
      sendOperations: vi.fn(async () => ({ id: 'stub-tx' })),
    },
  })),
  cryptoUtils: {
    sha256: vi.fn(() => new Uint8Array(32)),
  },
}));

const mockAuthStore = {
  isConnected: true,
  username: 'alice',
  custody: 'light',
  isAccredited: true,
  accreditation: { orcid: '0000-0001' },
  token: 'alice-jwt',
  expiresAt: '2099-01-01T00:00:00.000Z',
  _saveSession: vi.fn(),
  _checkAccreditation: vi.fn(),
  _startAccreditationPolling: vi.fn(),
  loginFromResponse: vi.fn(mockLoginFromResponse),
};
const mockRouterStore = {
  navigate: vi.fn(),
  registerNavigationGuard: vi.fn(),
  unregisterNavigationGuard: vi.fn(),
};
const mockToastStore = { show: vi.fn() };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'auth') return mockAuthStore;
      if (name === 'router') return mockRouterStore;
      if (name === 'toast') return mockToastStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initSettingsPage } from '../../src/pages/settings.js';

function createComponent() {
  initSettingsPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  comp.$watch = vi.fn();
  return comp;
}

function seedUpgradeEntry(comp) {
  comp.oldSeedPhrase = Array(12).fill('old').join(' ');
  comp.newSeedPhrase = Array(12).fill('new').join(' ');
  comp.upgradePhase = 'enter-old';
}

// Deferred fetch response: lets a test hold the backend cleanup POST open
// while it simulates the intervening cross-tab login, then release it.
function deferredResponse() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return { gate, release };
}

function okUpgradeResponse(token) {
  return {
    ok: true,
    json: async () => ({
      data: { token, expires_at: '2099-06-01T00:00:00.000Z' },
    }),
  };
}

// The net tab-local effect of a different user logging in from another tab
// while this tab's upgrade POST is in flight: the storage event's restore
// adopts the new subject (store fields + tab marker), and the new subject
// accrues their own subject-bound tab state afterwards. The accreditation
// pair is part of that restore, and it is what makes a carry-over visible:
// the upgrade payload omits both fields, so a landing that adopted this
// store would file the intervening user's badge under the upgrade subject.
function simulateCrossTabLoginAs(username, token) {
  mockAuthStore.username = username;
  mockAuthStore.token = token;
  mockAuthStore.custody = 'light';
  mockAuthStore.isAccredited = false;
  mockAuthStore.accreditation = { orcid: '0000-0002' };
  sessionStorage.setItem(TAB_SUBJECT_KEY, username);
  sessionStorage.setItem(SESSION_PROOF_KEY, `${username}-proof`);
}

// The net tab-local effect of the header sign-out landing while this tab's
// upgrade POST is in flight: `disconnect()` nulls every store field and the
// tab marker is one of the subject-bound keys its scrub removes. Sign-out
// does not navigate, so the settings component stays mounted and its
// post-await continuation still runs.
function simulateSignOut() {
  mockAuthStore.isConnected = false;
  mockAuthStore.username = null;
  mockAuthStore.token = null;
  mockAuthStore.expiresAt = null;
  mockAuthStore.custody = null;
  mockAuthStore.isAccredited = false;
  mockAuthStore.accreditation = null;
  sessionStorage.removeItem(TAB_SUBJECT_KEY);
  sessionStorage.removeItem(SESSION_PROOF_KEY);
}

// Drives the executor to the retryable post-broadcast 503 state: the chain
// rotation lands, the backend cleanup fails, and the seed survives so
// `retryUpgradeBackend` can re-derive.
async function driveToBackendUnavailable(comp) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: { code: 'SERVICE_UNAVAILABLE' } }),
  })));
  seedUpgradeEntry(comp);
  await comp.executeUpgrade();
}

describe('custody-upgrade re-login subject pin', () => {
  let warnSpy;
  let mockRequestImportKey;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockAuthStore.isConnected = true;
    mockAuthStore.username = 'alice';
    mockAuthStore.custody = 'light';
    mockAuthStore.isAccredited = true;
    mockAuthStore.accreditation = { orcid: '0000-0001' };
    mockAuthStore.token = 'alice-jwt';
    mockAuthStore.expiresAt = '2099-01-01T00:00:00.000Z';
    mockIsKeychainInstalled.mockReturnValue(true);
    mockRequestImportKey = vi.fn((_a, _k, cb) => { queueMicrotask(() => cb({ success: true })); });
    vi.stubGlobal('window', {
      ...globalThis.window,
      hive_keychain: {
        requestImportKey: (...args) => mockRequestImportKey(...args),
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('executeUpgrade: a landing for a subject this tab no longer represents is dropped, not adopted', async () => {
    const { gate, release } = deferredResponse();
    const fetchMock = vi.fn(() => gate);
    vi.stubGlobal('fetch', fetchMock);

    const comp = createComponent();
    seedUpgradeEntry(comp);
    sessionStorage.setItem(TAB_SUBJECT_KEY, 'alice');

    const run = comp.executeUpgrade();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    simulateCrossTabLoginAs('brenda', 'brenda-jwt');

    release(okUpgradeResponse('alice-upgraded-jwt'));
    await run;

    // The singleton store belongs to the intervening user now, so the stale
    // landing must not touch it at all: no adoption, no token rotation, no
    // durable session write.
    expect(mockAuthStore.loginFromResponse).not.toHaveBeenCalled();
    expect(mockAuthStore._saveSession).not.toHaveBeenCalled();
    expect(mockAuthStore.username).toBe('brenda');
    expect(mockAuthStore.token).toBe('brenda-jwt');
    expect(mockAuthStore.custody).toBe('light');
    // The intervening user's own accreditation stays theirs. Adopting the
    // payload would have preserved these under the upgrade subject's name,
    // because the upgrade response omits both fields.
    expect(mockAuthStore.isAccredited).toBe(false);
    expect(mockAuthStore.accreditation).toEqual({ orcid: '0000-0002' });
    // Their tab state is untouched too: no scrub fires for a landing that
    // never reaches the store.
    expect(sessionStorage.getItem(TAB_SUBJECT_KEY)).toBe('brenda');
    expect(sessionStorage.getItem(SESSION_PROOF_KEY)).toBe('brenda-proof');
    // Terminal sub-case: the upgrade did complete on-chain and at the
    // backend, so there is nothing to retry and the seed has no further use.
    expect(comp.upgradePhase).toBe('error');
    expect(comp.upgradeErrorKey).toBe('upgrade.sessionChanged');
    expect(comp.canRetryUpgrade).toBe(false);
    expect(comp.newSeedPhrase).toBe('');
    // The Keychain tail belongs to a session this tab no longer holds.
    expect(mockRequestImportKey).not.toHaveBeenCalled();
  });

  it('executeUpgrade: a sign-out during the backend window is not reversed by the landing', async () => {
    const { gate, release } = deferredResponse();
    const fetchMock = vi.fn(() => gate);
    vi.stubGlobal('fetch', fetchMock);

    const comp = createComponent();
    seedUpgradeEntry(comp);
    sessionStorage.setItem(TAB_SUBJECT_KEY, 'alice');

    const run = comp.executeUpgrade();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    simulateSignOut();

    release(okUpgradeResponse('alice-upgraded-jwt'));
    await run;

    // A disconnected store is a diverged store. Adopting here would write a
    // full durable session for a user who just signed out, and propagate it
    // to every other tab.
    expect(mockAuthStore.loginFromResponse).not.toHaveBeenCalled();
    expect(mockAuthStore._saveSession).not.toHaveBeenCalled();
    expect(mockAuthStore.isConnected).toBe(false);
    expect(mockAuthStore.username).toBe(null);
    expect(mockAuthStore.token).toBe(null);
    expect(sessionStorage.getItem(TAB_SUBJECT_KEY)).toBe(null);
    expect(comp.upgradePhase).toBe('error');
    expect(comp.upgradeErrorKey).toBe('upgrade.sessionChanged');
    expect(comp.canRetryUpgrade).toBe(false);
    expect(mockRequestImportKey).not.toHaveBeenCalled();
  });

  it('executeUpgrade: an ordinary upgrade with no intervening login stays same-subject with no spurious scrub', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okUpgradeResponse('alice-upgraded-jwt')));

    const comp = createComponent();
    seedUpgradeEntry(comp);
    // Alice's live tab state: the marker plus a fresh-auth proof that a
    // same-subject re-login must preserve.
    sessionStorage.setItem(TAB_SUBJECT_KEY, 'alice');
    sessionStorage.setItem(SESSION_PROOF_KEY, 'alice-live-proof');

    await comp.executeUpgrade();

    expect(comp.upgradePhase).toBe('done');
    expect(mockAuthStore.username).toBe('alice');
    expect(mockAuthStore.token).toBe('alice-upgraded-jwt');
    expect(mockAuthStore.custody).toBe('self');
    // Same-subject: the live window survives, no scrub fired.
    expect(sessionStorage.getItem(SESSION_PROOF_KEY)).toBe('alice-live-proof');
    expect(sessionStorage.getItem(TAB_SUBJECT_KEY)).toBe('alice');
    expect(mockAuthStore.loginFromResponse).toHaveBeenCalledTimes(1);
    expect(mockAuthStore.loginFromResponse.mock.calls[0][0].username).toBe('alice');
  });

  it('retryUpgradeBackend: a stale landing after a cross-tab login is dropped, not adopted', async () => {
    const comp = createComponent();
    sessionStorage.setItem(TAB_SUBJECT_KEY, 'alice');

    await driveToBackendUnavailable(comp);
    expect(comp.upgradePhase).toBe('error');
    expect(comp.upgradeErrorKey).toBe('upgrade.backendUnavailable');
    expect(mockAuthStore.loginFromResponse).not.toHaveBeenCalled();

    // Retry: hold the POST open, flip the tab to another user mid-flight,
    // then let the stale success land.
    const { gate, release } = deferredResponse();
    const retryFetchMock = vi.fn(() => gate);
    vi.stubGlobal('fetch', retryFetchMock);

    const run = comp.retryUpgradeBackend();
    await vi.waitFor(() => expect(retryFetchMock).toHaveBeenCalledTimes(1));

    simulateCrossTabLoginAs('brenda', 'brenda-jwt');

    release(okUpgradeResponse('alice-upgraded-jwt'));
    await run;

    expect(mockAuthStore.loginFromResponse).not.toHaveBeenCalled();
    expect(mockAuthStore._saveSession).not.toHaveBeenCalled();
    expect(mockAuthStore.username).toBe('brenda');
    expect(mockAuthStore.token).toBe('brenda-jwt');
    expect(sessionStorage.getItem(TAB_SUBJECT_KEY)).toBe('brenda');
    expect(sessionStorage.getItem(SESSION_PROOF_KEY)).toBe('brenda-proof');
    expect(comp.upgradePhase).toBe('error');
    expect(comp.upgradeErrorKey).toBe('upgrade.sessionChanged');
    expect(comp.canRetryUpgrade).toBe(false);
    expect(mockRequestImportKey).not.toHaveBeenCalled();
  });

  it('retryUpgradeBackend: a subject flip while the error screen idles stops the retry before the POST', async () => {
    const comp = createComponent();
    sessionStorage.setItem(TAB_SUBJECT_KEY, 'alice');

    await driveToBackendUnavailable(comp);
    expect(comp.upgradePhase).toBe('error');
    const preservedSeed = comp.newSeedPhrase;
    expect(preservedSeed).not.toBe('');

    // The error screen has no timeout: the user can leave the tab idle for
    // minutes before pressing Try Again, and a cross-tab login in that window
    // is already baked in by the time the click arrives.
    simulateCrossTabLoginAs('brenda', 'brenda-jwt');

    const retryFetchMock = vi.fn(() => { throw new Error('retry must not POST'); });
    vi.stubGlobal('fetch', retryFetchMock);

    await comp.retryUpgradeBackend();

    // No proof signed for the wrong account, no POST, no proof attempt spent.
    expect(retryFetchMock).not.toHaveBeenCalled();
    expect(comp._proofRetryAttempts).toBe(0);
    expect(mockAuthStore.loginFromResponse).not.toHaveBeenCalled();
    // The backend cleanup never ran, so the seed is still the user's only
    // key to the rotated account. Declining to act must not destroy it.
    expect(comp.newSeedPhrase).toBe(preservedSeed);
    expect(comp.upgradePhase).toBe('error');
    expect(comp.upgradeErrorKey).toBe('upgrade.sessionChangedIncomplete');
    expect(comp.canRetryUpgrade).toBe(false);
  });

  it('retryUpgradeBackend: an ordinary retry pins the upgrade-start subject and keeps the live window', async () => {
    const comp = createComponent();
    sessionStorage.setItem(TAB_SUBJECT_KEY, 'alice');

    await driveToBackendUnavailable(comp);
    expect(comp.upgradePhase).toBe('error');

    sessionStorage.setItem(SESSION_PROOF_KEY, 'alice-live-proof');
    vi.stubGlobal('fetch', vi.fn(async () => okUpgradeResponse('alice-upgraded-jwt')));

    await comp.retryUpgradeBackend();

    expect(comp.upgradePhase).toBe('done');
    expect(mockAuthStore.loginFromResponse).toHaveBeenCalledTimes(1);
    // The pinned subject is the one the upgrade started for, not whatever the
    // store happened to hold when Try Again was clicked.
    expect(mockAuthStore.loginFromResponse.mock.calls[0][0].username).toBe('alice');
    expect(mockAuthStore.username).toBe('alice');
    expect(mockAuthStore.token).toBe('alice-upgraded-jwt');
    expect(mockAuthStore.custody).toBe('self');
    // Same-subject retry: the live fresh-auth window survives and the marker
    // is unchanged.
    expect(sessionStorage.getItem(SESSION_PROOF_KEY)).toBe('alice-live-proof');
    expect(sessionStorage.getItem(TAB_SUBJECT_KEY)).toBe('alice');
  });
});

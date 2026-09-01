// Custody-upgrade re-login subject pin.
//
// Test focus: the subject-adoption contract of the two custody-upgrade
// `loginFromResponse` call sites (the upgrade executor and its backend-only
// retry). The backend cleanup POST can take up to 20 seconds; a cross-tab
// login as a different user during that window advances the auth store's
// username and the tab-subject marker before the upgrade response lands.
// Each call site must capture the subject before its first await and pass
// it explicitly, so adoption recognizes the stale landing as a subject
// change (scrub fires, the upgraded token does not land under the other
// user's username) while an ordinary same-subject upgrade stays scrub-free.
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
// accrues their own subject-bound tab state afterwards.
function simulateCrossTabLoginAs(username, token) {
  mockAuthStore.username = username;
  mockAuthStore.token = token;
  mockAuthStore.custody = 'light';
  sessionStorage.setItem(TAB_SUBJECT_KEY, username);
  sessionStorage.setItem(SESSION_PROOF_KEY, `${username}-proof`);
}

describe('custody-upgrade re-login subject pin', () => {
  let warnSpy;

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
    vi.stubGlobal('window', {
      ...globalThis.window,
      hive_keychain: {
        requestImportKey: (_a, _k, cb) => { queueMicrotask(() => cb({ success: true })); },
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

  it('executeUpgrade: a response landing after a cross-tab login as a different user is a recognized subject change', async () => {
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

    expect(comp.upgradePhase).toBe('done');
    // The upgraded token must not land under the intervening user's
    // username: adoption pins to the subject the upgrade started for.
    expect(mockAuthStore.username).toBe('alice');
    expect(mockAuthStore.token).toBe('alice-upgraded-jwt');
    expect(mockAuthStore.custody).toBe('self');
    // Recognized subject change: the intervening subject's tab state is
    // scrubbed and the marker names the upgrade's subject again.
    expect(sessionStorage.getItem(SESSION_PROOF_KEY)).toBe(null);
    expect(sessionStorage.getItem(TAB_SUBJECT_KEY)).toBe('alice');
    // The call site pins the subject explicitly rather than relying on the
    // helper's current-username fallback.
    expect(mockAuthStore.loginFromResponse).toHaveBeenCalledTimes(1);
    expect(mockAuthStore.loginFromResponse.mock.calls[0][0].username).toBe('alice');
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

  it('retryUpgradeBackend: the retry leg pins the subject across the same race window', async () => {
    // Drive the executor to the retryable backend-unavailable error state
    // first: broadcast lands, backend cleanup 503s, seed preserved.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: 'SERVICE_UNAVAILABLE' } }),
    })));

    const comp = createComponent();
    seedUpgradeEntry(comp);
    sessionStorage.setItem(TAB_SUBJECT_KEY, 'alice');

    await comp.executeUpgrade();
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

    expect(comp.upgradePhase).toBe('done');
    expect(mockAuthStore.username).toBe('alice');
    expect(mockAuthStore.token).toBe('alice-upgraded-jwt');
    expect(mockAuthStore.custody).toBe('self');
    expect(sessionStorage.getItem(SESSION_PROOF_KEY)).toBe(null);
    expect(sessionStorage.getItem(TAB_SUBJECT_KEY)).toBe('alice');
    expect(mockAuthStore.loginFromResponse).toHaveBeenCalledTimes(1);
    expect(mockAuthStore.loginFromResponse.mock.calls[0][0].username).toBe('alice');
  });
});

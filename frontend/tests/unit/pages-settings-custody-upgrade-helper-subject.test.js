// Custody-upgrade helper subject and credential threading.
//
// Test focus: every step of the upgrade after its first await acts for the
// account the upgrade started for, not for whoever the singleton auth store
// names when that step resumes. `this.username` is a getter over the store,
// and the flow suspends at four macrotask-scale gaps a cross-tab login (or a
// same-tab sign-out) can land in: the dynamic dhive import, the chain
// broadcast, the up-to-20s cleanup POST, and each of the three Keychain
// popups. The rotation op's account, both key derivations, the proof
// challenge, the bearer credential, and the Keychain import target are
// therefore passed in explicitly, and the executor stops before the next
// irreversible or credentialed step when the store has moved on.
//
// Carve-out clause (a): mirrors the sibling settings suites' fixture shape.
// Alpine stores, dhive, hive-keys and Keychain are stubbed because driving a
// real chain broadcast plus backend cleanup per test is impractical, and
// because these assertions need to interleave a store mutation with a
// specific await, which only a controllable stub can schedule. Cryptographic
// verification is bypassed: the stubbed signer returns a fixed signature, so
// nothing here proves a proof verifies. Clause (b) does not apply, the focus
// is which account each step binds to, not whether a signature recovers.
// Clause (c): that bypassed risk class is covered real-path by
// `backend/tests/routes/custody-upgrade.test.ts`, which signs genuine proofs
// against the `-custody-upgrade|v1|` challenge and asserts the route rejects a
// `derived_pubkey` absent from the account's on-chain key set. The
// account-binding pinned here is the frontend half of that contract: the
// backend rebuilds the challenge from the JWT subject, so a step that named
// the wrong account produces a proof it refuses.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLoginFromResponse } from './fixtures/mock-auth.js';
import { TAB_SUBJECT_KEY } from '../../src/lib/subject-bound-keys.js';

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
const STUB_PUBKEYS = {
  owner: 'STM' + 'o'.repeat(50),
  active: 'STM' + 'a'.repeat(50),
  posting: 'STM' + 'p'.repeat(50),
  memo: 'STM' + 'm'.repeat(50),
};

vi.mock('../../src/hive-keys.js', () => ({
  deriveHiveKeys: vi.fn(async () => ({ ...STUB_WIFS })),
  deriveHivePublicKeys: vi.fn(async () => ({ ...STUB_PUBKEYS })),
  loadDhive: vi.fn(async () => await import('@hiveio/dhive')),
  generateMnemonic: vi.fn(() => Array(12).fill('test').join(' ')),
  validateMnemonic: vi.fn(() => true),
}));

// Module-scope spies for the two dhive surfaces the assertions read: the
// broadcast (whose op carries the rotated account) and the hasher (which
// receives the proof challenge string verbatim).
const mockSendOperations = vi.fn(async () => ({ id: 'stub-tx' }));
const mockSign = vi.fn(() => ({ toString: () => '20' + 'f'.repeat(128) }));

vi.mock('@hiveio/dhive', () => ({
  PrivateKey: {
    fromString: vi.fn(() => ({
      toString: () => STUB_WIFS.active,
      createPublic: () => ({ toString: () => STUB_PUBKEYS.active }),
      sign: (...args) => mockSign(...args),
    })),
  },
  Client: vi.fn(() => ({
    broadcast: { sendOperations: (...args) => mockSendOperations(...args) },
  })),
  cryptoUtils: { sha256: vi.fn((msg) => msg) },
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
import { deriveHiveKeys } from '../../src/hive-keys.js';
import { initSettingsPage } from '../../src/pages/settings.js';

function createComponent() {
  initSettingsPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key, params) => (params ? `${key}(${JSON.stringify(params)})` : key);
  comp.$watch = vi.fn();
  return comp;
}

function seedUpgradeEntry(comp) {
  comp.oldSeedPhrase = Array(12).fill('old').join(' ');
  comp.newSeedPhrase = Array(12).fill('new').join(' ');
  comp.upgradePhase = 'enter-old';
}

function okUpgradeResponse(token) {
  return {
    ok: true,
    json: async () => ({ data: { token, expires_at: '2099-06-01T00:00:00.000Z' } }),
  };
}

// A different user's login landing from another tab: the storage event's
// restore advances the store and the tab-subject marker together.
function driftToOtherUser() {
  mockAuthStore.username = 'brenda';
  mockAuthStore.token = 'brenda-jwt';
  mockAuthStore.custody = 'light';
  sessionStorage.setItem(TAB_SUBJECT_KEY, 'brenda');
}

// Runs `fn` on the nth call of the derivation, so a test can interleave a
// store mutation with a specific await inside the flow. Derivation order in
// one upgrade run is: 1 and 2 in the key rotation, 3 in the proof, 4 in the
// Keychain import.
function driftOnDerivation(n, fn) {
  let calls = 0;
  vi.mocked(deriveHiveKeys).mockImplementation(async () => {
    calls += 1;
    if (calls === n) fn();
    return { ...STUB_WIFS };
  });
}

describe('custody-upgrade helper subject and credential threading', () => {
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
    vi.mocked(deriveHiveKeys).mockImplementation(async () => ({ ...STUB_WIFS }));
    mockSendOperations.mockImplementation(async () => ({ id: 'stub-tx' }));
    mockSign.mockImplementation(() => ({ toString: () => '20' + 'f'.repeat(128) }));
    mockRequestImportKey = vi.fn((_a, _k, cb) => { queueMicrotask(() => cb({ success: true })); });
    vi.stubGlobal('window', {
      ...globalThis.window,
      hive_keychain: {
        requestImportKey: (...args) => mockRequestImportKey(...args),
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    sessionStorage.setItem(TAB_SUBJECT_KEY, 'alice');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('rotates the upgrade-start account even when the store moves during the derivation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okUpgradeResponse('alice-upgraded-jwt')));
    // The first derivation is the earliest point a storage event can land:
    // it sits behind the dynamic dhive import.
    driftOnDerivation(1, driftToOtherUser);

    const comp = createComponent();
    seedUpgradeEntry(comp);
    await comp.executeUpgrade();

    // Both key sets are salted with the account name, so a drifted read here
    // would derive a different owner key and the broadcast would not
    // authenticate. Both derivations name the upgrade's subject.
    const derivationSubjects = vi.mocked(deriveHiveKeys).mock.calls.map((c) => c[1]);
    expect(derivationSubjects.slice(0, 2)).toEqual(['alice', 'alice']);
    // And the op rotates the upgrade's account, not the one now in the store.
    expect(mockSendOperations).toHaveBeenCalledTimes(1);
    const [ops] = mockSendOperations.mock.calls[0];
    const [[opName, op]] = ops;
    expect(opName).toBe('account_update');
    expect(op.account).toBe('alice');
  });

  it('stops before signing a proof when the store moves during the chain broadcast', async () => {
    const fetchMock = vi.fn(async () => okUpgradeResponse('alice-upgraded-jwt'));
    vi.stubGlobal('fetch', fetchMock);
    mockSendOperations.mockImplementation(async () => {
      driftToOtherUser();
      return { id: 'stub-tx' };
    });

    const comp = createComponent();
    seedUpgradeEntry(comp);
    const proofSpy = vi.spyOn(comp, '_signUpgradeProof');

    await comp.executeUpgrade();

    // The broadcast landed, so the account's authorities have rotated. The
    // flow stops there rather than signing with the new seed and spending
    // the session on a step it can no longer attribute to this tab.
    expect(mockSendOperations).toHaveBeenCalledTimes(1);
    expect(proofSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockAuthStore.loginFromResponse).not.toHaveBeenCalled();
    expect(comp.upgradePhase).toBe('error');
    expect(comp.upgradeErrorKey).toBe('upgrade.sessionChangedBeforeCleanup');
    // The cleanup never ran, so the mnemonic is still the only key to the
    // rotated account and the stop must not destroy it.
    expect(comp.newSeedPhrase).not.toBe('');
  });

  it('builds the proof challenge for the upgrade-start account when the store moves during its derivation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okUpgradeResponse('alice-upgraded-jwt')));
    // The third derivation is the proof's own key derivation.
    driftOnDerivation(3, driftToOtherUser);

    const comp = createComponent();
    seedUpgradeEntry(comp);
    await comp.executeUpgrade();

    // The challenge is rebuilt server-side from the JWT subject, so a
    // drifted name here produces a proof the backend cannot verify.
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(String(mockSign.mock.calls[0][0])).toContain('|alice|');
    expect(vi.mocked(deriveHiveKeys).mock.calls[2][1]).toBe('alice');
  });

  it('stops before the cleanup POST when the store moves while the proof is signed', async () => {
    const fetchMock = vi.fn(async () => okUpgradeResponse('alice-upgraded-jwt'));
    vi.stubGlobal('fetch', fetchMock);
    mockSign.mockImplementation(() => {
      driftToOtherUser();
      return { toString: () => '20' + 'f'.repeat(128) };
    });

    const comp = createComponent();
    seedUpgradeEntry(comp);
    await comp.executeUpgrade();

    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockAuthStore.loginFromResponse).not.toHaveBeenCalled();
    expect(comp.upgradePhase).toBe('error');
    expect(comp.upgradeErrorKey).toBe('upgrade.sessionChangedBeforeCleanup');
    expect(comp.newSeedPhrase).not.toBe('');
  });

  it('sends the cleanup POST with the credential held at upgrade start', async () => {
    const fetchMock = vi.fn(async () => okUpgradeResponse('alice-upgraded-jwt'));
    vi.stubGlobal('fetch', fetchMock);
    // A same-subject re-login in another tab rotates the stored token without
    // changing the account, so the divergence guards see nothing and the POST
    // still has to carry the credential this flow started with.
    mockSendOperations.mockImplementation(async () => {
      mockAuthStore.token = 'rotated-elsewhere-jwt';
      return { id: 'stub-tx' };
    });

    const comp = createComponent();
    seedUpgradeEntry(comp);
    await comp.executeUpgrade();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer alice-jwt');
  });

  it('imports keys for the upgrade-start account when the store moves mid-Keychain-loop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okUpgradeResponse('alice-upgraded-jwt')));
    // Each popup is its own multi-second suspension, and the loop re-reads
    // its target once per role.
    mockRequestImportKey = vi.fn((_a, _k, cb) => {
      driftToOtherUser();
      queueMicrotask(() => cb({ success: true }));
    });

    const comp = createComponent();
    seedUpgradeEntry(comp);
    await comp.executeUpgrade();

    expect(comp.upgradePhase).toBe('done');
    expect(mockRequestImportKey).toHaveBeenCalledTimes(3);
    for (const call of mockRequestImportKey.mock.calls) {
      expect(call[0]).toBe('alice');
    }
    // The loop's own derivation is salted with the same account.
    expect(vi.mocked(deriveHiveKeys).mock.calls[3][1]).toBe('alice');
  });

  it('a navigate-away during the broadcast still lets the cleanup POST land', async () => {
    const fetchMock = vi.fn(async () => okUpgradeResponse('alice-upgraded-jwt'));
    vi.stubGlobal('fetch', fetchMock);

    const comp = createComponent();
    seedUpgradeEntry(comp);
    // Real teardown, not a hand-flipped flag: destroy() wipes the upgrade's
    // reactive state (the pinned account among it) and only then marks the
    // component unmounted.
    mockSendOperations.mockImplementation(async () => {
      comp.destroy();
      return { id: 'stub-tx' };
    });

    await comp.executeUpgrade();

    // The chain rotation has landed. Abandoning the cleanup here would leave
    // the account rotated on-chain while the backend still holds keys that no
    // longer sign for it, which is the one irreversible gap this flow has.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/custody/upgrade');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer alice-jwt');
    // The wiped pin must not have reached the proof: a null account name
    // would derive the wrong key and sign a challenge the backend rebuilds
    // differently.
    expect(String(mockSign.mock.calls[0][0])).toContain('|alice|');
    // Unmounted: the store stays untouched and no popup opens.
    expect(mockAuthStore.loginFromResponse).not.toHaveBeenCalled();
    expect(mockRequestImportKey).not.toHaveBeenCalled();
    // And the teardown is not reported to the user as a session change.
    expect(comp.upgradeErrorKey).toBe(null);
  });

  it('a navigate-away that coincides with a real subject change still lets the cleanup POST land', async () => {
    const fetchMock = vi.fn(async () => okUpgradeResponse('alice-upgraded-jwt'));
    vi.stubGlobal('fetch', fetchMock);
    // Both at once: the tab is torn down AND the store really has moved to
    // another account. The divergence is genuine, but there is no longer a
    // component to show the terminal message on, and stopping would strand
    // the account between the rotation and the cleanup.
    mockSendOperations.mockImplementation(async () => {
      driftToOtherUser();
      comp.destroy();
      return { id: 'stub-tx' };
    });

    const comp = createComponent();
    seedUpgradeEntry(comp);
    await comp.executeUpgrade();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer alice-jwt');
    expect(String(mockSign.mock.calls[0][0])).toContain('|alice|');
    // The other user's store is left exactly as it was.
    expect(mockAuthStore.loginFromResponse).not.toHaveBeenCalled();
    expect(mockAuthStore.username).toBe('brenda');
    expect(mockRequestImportKey).not.toHaveBeenCalled();
  });

  it('a navigate-away during the retry proof still lets the cleanup POST land', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: 'SERVICE_UNAVAILABLE' } }),
    })));

    const comp = createComponent();
    seedUpgradeEntry(comp);
    await comp.executeUpgrade();
    expect(comp.upgradeErrorKey).toBe('upgrade.backendUnavailable');

    const retryFetch = vi.fn(async () => okUpgradeResponse('alice-upgraded-jwt'));
    vi.stubGlobal('fetch', retryFetch);
    mockSign.mockImplementation(() => {
      comp.destroy();
      return { toString: () => '20' + 'f'.repeat(128) };
    });

    await comp.retryUpgradeBackend();

    expect(retryFetch).toHaveBeenCalledTimes(1);
    expect(retryFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer alice-jwt');
    expect(mockAuthStore.loginFromResponse).not.toHaveBeenCalled();
  });

  it('sends the retry POST with the credential held when the retry started', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: 'SERVICE_UNAVAILABLE' } }),
    })));

    const comp = createComponent();
    seedUpgradeEntry(comp);
    await comp.executeUpgrade();
    expect(comp.upgradeErrorKey).toBe('upgrade.backendUnavailable');

    const retryFetch = vi.fn(async () => okUpgradeResponse('alice-upgraded-jwt'));
    vi.stubGlobal('fetch', retryFetch);
    mockSign.mockImplementation(() => {
      mockAuthStore.token = 'rotated-elsewhere-jwt';
      return { toString: () => '20' + 'f'.repeat(128) };
    });

    await comp.retryUpgradeBackend();

    expect(retryFetch).toHaveBeenCalledTimes(1);
    expect(retryFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer alice-jwt');
    expect(comp.upgradePhase).toBe('done');
  });
});

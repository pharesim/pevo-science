// Custody-upgrade cleanup POST against a session that has ended.
//
// Test focus: the post-broadcast error ladder's split between a rejected
// upgrade proof and a session that can no longer authenticate the cleanup
// POST. The proof-retry budget exists for the first: its second rejection
// wipes the new recovery phrase. A revoked session (`401
// SESSION_INVALIDATED`) or an expired one (caught before the POST is sent)
// says nothing about the proof, so it must spend none of that budget and
// must not wipe a phrase that is still the only key to an account whose
// on-chain authorities already rotated. It lands in the retryable
// before-cleanup session-changed sub-case instead, the auth store is told
// about the pinned token, and once the user signs back in the next Try Again
// runs the cleanup. A genuine proof rejection still spends the budget and
// still wipes on the second. The expiry check reads the store's own expiry,
// so it runs only while the store still holds the pinned token: a store that
// signed out or moved to a newer session must not stop a POST whose bearer
// the server still accepts, and must not have that newer session torn down.
//
// The auth store here is the REAL one (`initAuth`), registered through a
// minimal Alpine store registry, so its stale-token check and its teardown
// run as shipped.
//
// Carve-out clause (a): Alpine's component registry, dhive, hive-keys, the
// Keychain extension and the backend POST (`fetch`) are stubbed, because
// driving a real chain broadcast plus backend cleanup per test is
// impractical, and the focus here is how the component routes each answer,
// not cryptographic verification. Clause (b) does not apply, no auth
// middleware runs on this path. Clause (c): the bypassed risk classes are
// whether a proof actually binds to the account it claims, and whether the
// route answers a revoked bearer with `401 SESSION_INVALIDATED`, which the
// stubbed POST stands in for. `backend/tests/routes/custody-upgrade.test.ts`
// covers both real-path: it signs genuine proofs and asserts the route
// rejects a `derived_pubkey` absent from the account's on-chain key set, and
// it asserts `SESSION_INVALIDATED` for a pre-upgrade token replayed after an
// upgrade.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const stores = {};
vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name, value) => {
      if (value !== undefined) {
        stores[name] = value;
        return undefined;
      }
      return stores[name];
    }),
    $data: vi.fn(() => null),
  },
}));

vi.mock('../../src/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchAccreditationStatus: vi.fn(() => new Promise(() => {})),
  fetchAdminRoster: vi.fn(() => Promise.resolve({ data: { tier: null } })),
  fetchEmailStatus: vi.fn(() => new Promise(() => {})),
}));

vi.mock('../../src/keychain.js', () => ({
  isKeychainInstalled: vi.fn(() => true),
  waitForKeychain: vi.fn(async () => true),
}));

const STUB_WIFS = {
  owner: '5K' + 'A'.repeat(48),
  active: '5K' + 'B'.repeat(48),
  posting: '5K' + 'C'.repeat(48),
  memo: '5K' + 'D'.repeat(48),
};
const mockSendOperations = vi.fn();
vi.mock('../../src/hive-keys.js', () => ({
  deriveHiveKeys: vi.fn(async () => ({ ...STUB_WIFS })),
  deriveHivePublicKeys: vi.fn(async () => ({
    owner: 'STM' + 'o'.repeat(50),
    active: 'STM' + 'a'.repeat(50),
    posting: 'STM' + 'p'.repeat(50),
    memo: 'STM' + 'm'.repeat(50),
  })),
  loadDhive: vi.fn(async () => ({
    PrivateKey: {
      fromString: () => ({
        createPublic: () => ({ toString: () => 'STM' + 'a'.repeat(50) }),
        sign: () => ({ toString: () => '20' + 'f'.repeat(128) }),
      }),
    },
    Client: vi.fn(() => ({
      broadcast: { sendOperations: (...args) => mockSendOperations(...args) },
    })),
    cryptoUtils: { sha256: () => new Uint8Array(32) },
  })),
  generateMnemonic: vi.fn(() => Array(12).fill('test').join(' ')),
  validateMnemonic: vi.fn(() => true),
}));

import Alpine from 'alpinejs';
import { initAuth } from '../../src/auth.js';
import { initSettingsPage, settingsPageTemplate } from '../../src/pages/settings.js';

const NEW_SEED = Array(12).fill('new').join(' ');
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';
const SESSION_KEY = 'pevo_session';

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
  comp.newSeedPhrase = NEW_SEED;
  comp.upgradePhase = 'enter-old';
}

function rejectedResponse(status, code) {
  return {
    ok: false,
    status,
    json: async () => ({ status: 'error', error: { code, message: 'x' } }),
  };
}

function okUpgradeResponse(token) {
  return {
    ok: true,
    json: async () => ({
      data: { token, expires_at: '2099-06-01T00:00:00.000Z' },
    }),
  };
}

// A light-account sign-in as alice, through the store's own login helper.
function signInAsAlice(auth, token) {
  auth.loginFromResponse({
    token,
    expires_at: FUTURE,
    username: 'alice',
    custody: 'light',
    is_accredited: true,
    accreditation: null,
  });
}

const bearerOf = (fetchMock, call) => fetchMock.mock.calls[call][1].headers.Authorization;

describe('custody-upgrade cleanup POST on an ended session', () => {
  let auth;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    stores.router = {
      navigate: vi.fn(),
      registerNavigationGuard: vi.fn(),
      unregisterNavigationGuard: vi.fn(),
    };
    stores.toast = { show: vi.fn() };
    stores.i18n = { messages: {} };
    initAuth();
    auth = stores.auth;
    signInAsAlice(auth, 'alice-jwt');
    mockSendOperations.mockImplementation(async () => ({ id: 'stub-tx' }));
    vi.stubGlobal('window', {
      ...globalThis.window,
      hive_keychain: {
        requestImportKey: (_a, _k, cb) => { queueMicrotask(() => cb({ success: true })); },
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    auth._stopAccreditationPolling();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  function expectRetryableBeforeCleanup(comp, attemptsSpent) {
    expect(comp.upgradePhase).toBe('error');
    expect(comp.upgradeErrorKey).toBe('upgrade.sessionChangedBeforeCleanup');
    expect(comp.upgradeError).toBe('upgrade.sessionChangedBeforeCleanup({"username":"alice"})');
    expect(comp.canRetryUpgrade).toBe(true);
    expect(comp._proofRetryAttempts).toBe(attemptsSpent);
    expect(comp.newSeedPhrase).toBe(NEW_SEED);
    expect(comp._upgradeSubject).toBe('alice');
  }

  it('executeUpgrade: a revoked session keeps the seed and the budget, and the store ends that session', async () => {
    const comp = createComponent();
    const fetchMock = vi.fn(async () => rejectedResponse(401, 'SESSION_INVALIDATED'));
    vi.stubGlobal('fetch', fetchMock);
    seedUpgradeEntry(comp);

    await comp.executeUpgrade();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bearerOf(fetchMock, 0)).toBe('Bearer alice-jwt');
    expectRetryableBeforeCleanup(comp, 0);
    expect(auth.isConnected).toBe(false);
    expect(localStorage.getItem(SESSION_KEY)).toBe(null);
    expect(stores.toast.show).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it('two revoked sessions in a row still leave the seed intact, and the next sign-in finishes the upgrade', async () => {
    const comp = createComponent();
    const fetchMock = vi.fn(async () => rejectedResponse(401, 'SESSION_INVALIDATED'));
    vi.stubGlobal('fetch', fetchMock);
    seedUpgradeEntry(comp);

    await comp.executeUpgrade();
    expectRetryableBeforeCleanup(comp, 0);

    // The re-login's session is revoked too before the user presses Try Again.
    signInAsAlice(auth, 'alice-jwt-2');
    await comp.retryUpgradeBackend();

    expect(bearerOf(fetchMock, 1)).toBe('Bearer alice-jwt-2');
    expectRetryableBeforeCleanup(comp, 0);
    expect(auth.isConnected).toBe(false);

    signInAsAlice(auth, 'alice-jwt-3');
    const retryFetch = vi.fn(async () => okUpgradeResponse('alice-upgraded-jwt'));
    vi.stubGlobal('fetch', retryFetch);

    await comp.retryUpgradeBackend();

    expect(retryFetch).toHaveBeenCalledTimes(1);
    expect(bearerOf(retryFetch, 0)).toBe('Bearer alice-jwt-3');
    expect(comp.upgradePhase).toBe('done');
    expect(auth.token).toBe('alice-upgraded-jwt');
    expect(auth.custody).toBe('self');
    expect(comp.newSeedPhrase).toBe('');
    expect(comp._upgradeSubject).toBe(null);
  });

  it('a revoked session between two proof rejections spends nothing, and the second rejection still wipes', async () => {
    const comp = createComponent();
    vi.stubGlobal('fetch', vi.fn(async () => rejectedResponse(401, 'UNAUTHORIZED')));
    seedUpgradeEntry(comp);

    await comp.executeUpgrade();
    expect(comp.upgradeErrorKey).toBe('upgrade.proofRejected');
    expect(comp._proofRetryAttempts).toBe(1);
    expect(comp.newSeedPhrase).toBe(NEW_SEED);

    vi.stubGlobal('fetch', vi.fn(async () => rejectedResponse(401, 'SESSION_INVALIDATED')));
    await comp.retryUpgradeBackend();
    expectRetryableBeforeCleanup(comp, 1);

    signInAsAlice(auth, 'alice-jwt-2');
    vi.stubGlobal('fetch', vi.fn(async () => rejectedResponse(401, 'UNAUTHORIZED')));
    await comp.retryUpgradeBackend();

    expect(comp._proofRetryAttempts).toBe(2);
    expect(comp.upgradeErrorKey).toBe('upgrade.partialApplyFailed');
    expect(comp.canRetryUpgrade).toBe(false);
    expect(comp.newSeedPhrase).toBe('');
  });

  it('executeUpgrade: a session that expires during the broadcast is ended before the cleanup POST, which is never sent', async () => {
    const comp = createComponent();
    mockSendOperations.mockImplementation(async () => {
      auth.expiresAt = PAST;
      return { id: 'stub-tx' };
    });
    const fetchMock = vi.fn(async () => { throw new Error('an expired session must not POST'); });
    vi.stubGlobal('fetch', fetchMock);
    seedUpgradeEntry(comp);

    await comp.executeUpgrade();

    expect(fetchMock).not.toHaveBeenCalled();
    expectRetryableBeforeCleanup(comp, 0);
    expect(auth.isConnected).toBe(false);
    expect(stores.toast.show).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it('retryUpgradeBackend: a session that expired while the error screen idled is ended before the POST, and a sign-in lets the next try finish', async () => {
    const comp = createComponent();
    vi.stubGlobal('fetch', vi.fn(async () => rejectedResponse(503, 'SERVICE_UNAVAILABLE')));
    seedUpgradeEntry(comp);
    await comp.executeUpgrade();
    expect(comp.upgradeErrorKey).toBe('upgrade.backendUnavailable');

    auth.expiresAt = PAST;
    const expiredFetch = vi.fn(async () => { throw new Error('an expired session must not POST'); });
    vi.stubGlobal('fetch', expiredFetch);

    await comp.retryUpgradeBackend();

    expect(expiredFetch).not.toHaveBeenCalled();
    expectRetryableBeforeCleanup(comp, 0);
    expect(auth.isConnected).toBe(false);

    signInAsAlice(auth, 'alice-relogin-jwt');
    const retryFetch = vi.fn(async () => okUpgradeResponse('alice-upgraded-jwt'));
    vi.stubGlobal('fetch', retryFetch);

    await comp.retryUpgradeBackend();

    expect(bearerOf(retryFetch, 0)).toBe('Bearer alice-relogin-jwt');
    expect(comp.upgradePhase).toBe('done');
    expect(comp.newSeedPhrase).toBe('');
  });

  it('executeUpgrade: a sign-out during the broadcast does not stop the cleanup POST, whose bearer the server still accepts', async () => {
    const comp = createComponent();
    mockSendOperations.mockImplementation(async () => {
      auth.disconnect();
      return { id: 'stub-tx' };
    });
    const fetchMock = vi.fn(async () => okUpgradeResponse('alice-upgraded-jwt'));
    vi.stubGlobal('fetch', fetchMock);
    seedUpgradeEntry(comp);

    await comp.executeUpgrade();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bearerOf(fetchMock, 0)).toBe('Bearer alice-jwt');
    // The cleanup landed; the landing is dropped for a store that signed out.
    expect(comp.upgradeErrorKey).toBe('upgrade.sessionChangedAfterCleanup');
    expect(auth.isConnected).toBe(false);
  });

  it('a revoked pinned token does not end the newer session another tab saved, and the next try runs on that session', async () => {
    const comp = createComponent();
    // Another tab signs in again as alice during the broadcast, and this tab
    // takes up the stored session as the storage event would.
    mockSendOperations.mockImplementation(async () => {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        token: 'alice-jwt-other-tab',
        username: 'alice',
        expiresAt: FUTURE,
        isAccredited: true,
        accreditation: null,
        custody: 'light',
      }));
      auth._restoreSession();
      return { id: 'stub-tx' };
    });
    const fetchMock = vi.fn(async () => rejectedResponse(401, 'SESSION_INVALIDATED'));
    vi.stubGlobal('fetch', fetchMock);
    seedUpgradeEntry(comp);

    await comp.executeUpgrade();

    expect(bearerOf(fetchMock, 0)).toBe('Bearer alice-jwt');
    expectRetryableBeforeCleanup(comp, 0);
    expect(auth.isConnected).toBe(true);
    expect(auth.token).toBe('alice-jwt-other-tab');
    expect(stores.toast.show).not.toHaveBeenCalled();

    const retryFetch = vi.fn(async () => okUpgradeResponse('alice-upgraded-jwt'));
    vi.stubGlobal('fetch', retryFetch);

    await comp.retryUpgradeBackend();

    expect(bearerOf(retryFetch, 0)).toBe('Bearer alice-jwt-other-tab');
    expect(comp.upgradePhase).toBe('done');
  });

  it("the signed-out page's Sign In goes to the login route when no backend-only retry waits", async () => {
    const comp = createComponent();
    const connectSpy = vi.spyOn(auth, 'connect').mockResolvedValue(undefined);

    expect(comp.upgradeRetryAwaitsSignIn).toBe(false);
    await comp.signInFromSignedOutBody();

    expect(stores.router.navigate).toHaveBeenCalledWith('/login');
    expect(connectSpy).not.toHaveBeenCalled();
  });

  // Each sub-case whose Try Again re-sends only the cleanup keeps the seed
  // and the pin, and the session can end while it waits: here by the expiry
  // the api.js poll would detect, or by the revocation that set it.
  const waitingRetries = [
    {
      name: 'a revoked session',
      key: 'upgrade.sessionChangedBeforeCleanup',
      answer: () => rejectedResponse(401, 'SESSION_INVALIDATED'),
      endSession: () => {},
    },
    {
      name: 'an unreachable chain lookup (503) whose session then expired',
      key: 'upgrade.backendUnavailable',
      answer: () => rejectedResponse(503, 'SERVICE_UNAVAILABLE'),
      endSession: () => {
        auth.expiresAt = PAST;
        auth.endSessionIfExpired(auth.token);
      },
    },
    {
      name: 'a first proof rejection whose session then expired',
      key: 'upgrade.proofRejected',
      answer: () => rejectedResponse(401, 'UNAUTHORIZED'),
      endSession: () => {
        auth.expiresAt = PAST;
        auth.endSessionIfExpired(auth.token);
      },
    },
  ];

  for (const retry of waitingRetries) {
    it(`the signed-out page's Sign In opens the in-place prompt while ${retry.name} waits`, async () => {
      const comp = createComponent();
      const connectSpy = vi.spyOn(auth, 'connect').mockResolvedValue(undefined);
      vi.stubGlobal('fetch', vi.fn(async () => retry.answer()));
      seedUpgradeEntry(comp);
      await comp.executeUpgrade();
      retry.endSession();

      expect(comp.upgradeErrorKey).toBe(retry.key);
      expect(auth.isConnected).toBe(false);
      expect(comp.upgradeRetryAwaitsSignIn).toBe(true);

      await comp.signInFromSignedOutBody();

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(stores.router.navigate).not.toHaveBeenCalled();
      expect(comp.newSeedPhrase).toBe(NEW_SEED);
      expect(comp._upgradeSubject).toBe('alice');
    });
  }

  it("a failed in-place sign-in from the signed-out page reports it and stays on the page", async () => {
    const comp = createComponent();
    vi.spyOn(auth, 'connect').mockRejectedValue(new Error('modal missing'));
    vi.stubGlobal('fetch', vi.fn(async () => rejectedResponse(401, 'SESSION_INVALIDATED')));
    seedUpgradeEntry(comp);
    await comp.executeUpgrade();
    stores.toast.show.mockClear();

    await comp.signInFromSignedOutBody();

    expect(stores.toast.show).toHaveBeenCalledWith('common.connectionFailed', 'error');
    expect(stores.router.navigate).not.toHaveBeenCalled();
    expect(comp.newSeedPhrase).toBe(NEW_SEED);
  });

  it('the signed-out page renders the waiting message and wires its Sign In to the in-place handler', () => {
    const start = settingsPageTemplate.indexOf('<template x-if="!isConnected">');
    const block = settingsPageTemplate.slice(start, settingsPageTemplate.indexOf('<template x-if="isConnected">', start));

    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('<template x-if="upgradeRetryAwaitsSignIn">');
    expect(block).toContain('x-text="upgradeError"');
    expect(block).toContain('@click="signInFromSignedOutBody()"');
    expect(block).not.toContain("navigate('/login')");
  });
});

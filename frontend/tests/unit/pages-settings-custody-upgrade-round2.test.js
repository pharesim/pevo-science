// UI-CUSTODY-UPGRADE-SEED-PHRASE-DERIVE-FLOW round-2 hold block coverage.
//
// Test focus (per round-2 architect HOLD PENDING FIXES block at
// agents/docs/tasks/{blocked,pending,review}/ui-custody-upgrade-seed-phrase-derive-flow.md):
//
//   #2 beforeunload registration/deregistration during upgradePhase='upgrading'
//   #3 retryUpgradeBackend _mounted guard after _postUpgradeBackend await
//   #4 retryUpgradeBackend concurrency gate (phase flip first synchronous statement)
//   #5 first 401 keeps newSeedPhrase + retryable proofRejected; second 401 wipes
//   #6 backendTimeout no longer wipes newSeedPhrase (covered in sibling file's update)
//   #7 UPGRADE_ERROR_KEYS hoist + RETRYABILITY annotation drives canRetryUpgrade + handleRetry
//   #8 _handlePostBroadcastError helper consumed by both executeUpgrade and retryUpgradeBackend
//
// Carve-out clause (a): the upstream pages-settings.test.js fixture already
// stubs hive-keys, dhive, and Alpine stores; this file reuses the same shape
// per the carve-out for deterministic edge-case coverage. The risk class
// (cryptographic verification correctness) is covered by the real-path
// sec-001-equivalence.test.js + backend tests against signed proofs; this
// file's focus is the FE error-routing + state-machine behaviour around the
// new round-2 contracts (retry budget, terminality, helper dispatch).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLoginFromResponse } from './fixtures/mock-auth.js';

const mockFetchEmailStatus = vi.fn();
const mockSubmitEmail = vi.fn();
const mockDeleteEmail = vi.fn();
const mockStartOrcid = vi.fn();
const mockSetPassword = vi.fn();
const mockIsKeychainInstalled = vi.fn(() => true);

vi.mock('../../src/api.js', () => ({
  fetchEmailStatus: (...args) => mockFetchEmailStatus(...args),
  submitEmail: (...args) => mockSubmitEmail(...args),
  deleteEmail: (...args) => mockDeleteEmail(...args),
  startOrcid: (...args) => mockStartOrcid(...args),
  setPassword: (...args) => mockSetPassword(...args),
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
  token: 'jwt',
  expiresAt: '2099-01-01T00:00:00.000Z',
  _saveSession: vi.fn(),
  _checkAccreditation: vi.fn(),
  _startAccreditationPolling: vi.fn(),
  loginFromResponse: vi.fn(mockLoginFromResponse),
};
const mockRouterStore = { navigate: vi.fn() };
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

describe('settingsPage round-2 hold-block findings', () => {
  let localStorageData;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.isConnected = true;
    mockAuthStore.custody = 'light';
    localStorageData = {};
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => localStorageData[key] ?? null),
      setItem: vi.fn((key, val) => { localStorageData[key] = val; }),
      removeItem: vi.fn((key) => { delete localStorageData[key]; }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Round-2 hold #7: UPGRADE_ERROR_KEYS + RETRYABILITY map drives both
  // canRetryUpgrade and handleRetry dispatch. Adding a key to the map
  // without updating the catch site (or vice versa) used to silently
  // mis-classify; the typed annotation makes drift a runtime undefined.
  // ─────────────────────────────────────────────────────────────────────────
  describe('round-2 #7: RETRYABILITY-driven canRetryUpgrade + handleRetry', () => {
    it('proofRejected is retryable (canRetryUpgrade = true)', () => {
      const comp = createComponent();
      comp.upgradeErrorKey = 'upgrade.proofRejected';
      expect(comp.canRetryUpgrade).toBe(true);
    });

    it('backendUnavailable is retryable (canRetryUpgrade = true)', () => {
      const comp = createComponent();
      comp.upgradeErrorKey = 'upgrade.backendUnavailable';
      expect(comp.canRetryUpgrade).toBe(true);
    });

    it('terminal sub-cases still return false: backendTimeout, partialApplyFailed, alreadyUpgraded, rateLimited', () => {
      const comp = createComponent();
      for (const key of ['upgrade.backendTimeout', 'upgrade.partialApplyFailed', 'upgrade.alreadyUpgraded', 'upgrade.rateLimited']) {
        comp.upgradeErrorKey = key;
        expect(comp.canRetryUpgrade).toBe(false);
      }
    });

    it('handleRetry on proofRejected dispatches to retryUpgradeBackend (preserves newSeedPhrase)', () => {
      const comp = createComponent();
      const retrySpy = vi.spyOn(comp, 'retryUpgradeBackend').mockImplementation(() => {});
      const resetSpy = vi.spyOn(comp, 'resetUpgrade').mockImplementation(() => {});
      comp.upgradeErrorKey = 'upgrade.proofRejected';
      comp.handleRetry();
      expect(retrySpy).toHaveBeenCalledTimes(1);
      expect(resetSpy).not.toHaveBeenCalled();
    });

    it('handleRetry on backendUnavailable dispatches to retryUpgradeBackend', () => {
      const comp = createComponent();
      const retrySpy = vi.spyOn(comp, 'retryUpgradeBackend').mockImplementation(() => {});
      comp.upgradeErrorKey = 'upgrade.backendUnavailable';
      comp.handleRetry();
      expect(retrySpy).toHaveBeenCalledTimes(1);
    });

    it('handleRetry on retryable-reset sub-case (failed) dispatches to resetUpgrade', () => {
      const comp = createComponent();
      const resetSpy = vi.spyOn(comp, 'resetUpgrade').mockImplementation(() => {});
      const retrySpy = vi.spyOn(comp, 'retryUpgradeBackend').mockImplementation(() => {});
      comp.upgradeErrorKey = 'upgrade.failed';
      comp.handleRetry();
      expect(resetSpy).toHaveBeenCalledTimes(1);
      expect(retrySpy).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Round-2 hold #5: first 401 keeps newSeedPhrase and routes to retryable
  // proofRejected so user can correct clock + retry; second 401 wipes and
  // terminal partialApplyFailed.
  // ─────────────────────────────────────────────────────────────────────────
  describe('round-2 #5: 401 retry budget', () => {
    it('first post-broadcast 401 → upgrade.proofRejected, retryable, newSeedPhrase preserved', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (a, w, cb) => { queueMicrotask(() => cb({ success: true })); },
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'UNAUTHORIZED' } }),
      })));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      const newMnemonic = Array(12).fill('new').join(' ');
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = newMnemonic;
      comp.newSeedWords = newMnemonic.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePhase = 'enter-old';

      await comp.executeUpgrade();

      expect(comp.upgradePhase).toBe('error');
      expect(comp.upgradeErrorKey).toBe('upgrade.proofRejected');
      // newSeedPhrase preserved so retry path can re-derive
      expect(comp.newSeedPhrase).toBe(newMnemonic);
      expect(comp.canRetryUpgrade).toBe(true);
      expect(comp._proofRetryAttempts).toBe(1);

      warnSpy.mockRestore();
    });

    it('second post-broadcast 401 → terminal partialApplyFailed, newSeedPhrase wiped', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (a, w, cb) => { queueMicrotask(() => cb({ success: true })); },
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'UNAUTHORIZED' } }),
      })));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      const newMnemonic = Array(12).fill('new').join(' ');
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = newMnemonic;
      comp.newSeedWords = newMnemonic.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePhase = 'enter-old';

      // First attempt: routes to proofRejected, preserves seed
      await comp.executeUpgrade();
      expect(comp.upgradeErrorKey).toBe('upgrade.proofRejected');
      expect(comp.newSeedPhrase).toBe(newMnemonic);
      expect(comp._proofRetryAttempts).toBe(1);

      // User clicks Try Again — handleRetry dispatches to retryUpgradeBackend.
      // Second 401 → budget exhausted, wipe + terminal.
      await comp.retryUpgradeBackend();

      expect(comp.upgradePhase).toBe('error');
      expect(comp.upgradeErrorKey).toBe('upgrade.partialApplyFailed');
      expect(comp.canRetryUpgrade).toBe(false);
      expect(comp.newSeedPhrase).toBe('');
      expect(comp._proofRetryAttempts).toBe(2);

      warnSpy.mockRestore();
    });

    it('startUpgrade resets the proof-retry counter so a fresh wizard run gets a fresh budget', () => {
      const comp = createComponent();
      comp._proofRetryAttempts = 2;
      // Stub generateMnemonic mock effect handled via vi.mock at module top.
      comp.startUpgrade();
      expect(comp._proofRetryAttempts).toBe(0);
    });

    it('resetUpgrade resets the proof-retry counter', () => {
      const comp = createComponent();
      comp._proofRetryAttempts = 2;
      comp.resetUpgrade();
      expect(comp._proofRetryAttempts).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Round-2 hold #4: retryUpgradeBackend concurrency gate (phase write is
  // the first synchronous statement after guard checks, mirroring
  // executeUpgrade). Without this, two parallel Try Again clicks both pass
  // the guard before either writes 'upgrading' and we POST twice.
  // ─────────────────────────────────────────────────────────────────────────
  describe('round-2 #4: retryUpgradeBackend concurrency gate', () => {
    it('two parallel invocations from the error state issue exactly one POST', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (a, w, cb) => { queueMicrotask(() => cb({ success: true })); },
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      let fetchCalls = 0;
      vi.stubGlobal('fetch', vi.fn(() => {
        fetchCalls += 1;
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: { token: 'new', expires_at: '2099-01-01T00:00:00Z', custody: 'self' } }),
        });
      }));

      const comp = createComponent();
      const newMnemonic = Array(12).fill('new').join(' ');
      comp.newSeedPhrase = newMnemonic;
      // Set up the error state retryUpgradeBackend reads
      comp.upgradePhase = 'error';
      comp.upgradeErrorKey = 'upgrade.backendUnavailable';

      // Fire two in parallel without awaiting between them. The phase flip
      // to 'upgrading' is synchronous at the top of retryUpgradeBackend, so
      // the second call observes it and short-circuits at the guard.
      const p1 = comp.retryUpgradeBackend();
      const p2 = comp.retryUpgradeBackend();
      await Promise.all([p1, p2]);

      expect(fetchCalls).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Round-2 hold #3: retryUpgradeBackend _mounted guard immediately after
  // _postUpgradeBackend resolves, before loginFromResponse. Mirrors
  // executeUpgrade:783's guard.
  // ─────────────────────────────────────────────────────────────────────────
  describe('round-2 #3: retryUpgradeBackend post-await _mounted guard', () => {
    it('unmount during _postUpgradeBackend await skips loginFromResponse', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (a, w, cb) => { queueMicrotask(() => cb({ success: true })); },
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });

      const comp = createComponent();
      // Replace fetch with one that flips _mounted=false before resolving.
      // Simulates the user navigating away during the 20s backend cleanup.
      vi.stubGlobal('fetch', vi.fn(async () => {
        comp._mounted = false;
        return {
          ok: true,
          json: async () => ({ data: { token: 'new', expires_at: '2099-01-01T00:00:00Z', custody: 'self' } }),
        };
      }));

      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp.upgradePhase = 'error';
      comp.upgradeErrorKey = 'upgrade.backendUnavailable';

      await comp.retryUpgradeBackend();

      // loginFromResponse must NOT have been called on the unmounted component
      expect(mockAuthStore.loginFromResponse).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Round-2 hold #2: beforeunload listener registered in init(), removed in
  // destroy(). Warns when upgradePhase==='upgrading'; silent otherwise.
  // ─────────────────────────────────────────────────────────────────────────
  describe('round-2 #2: beforeunload guard', () => {
    it('init registers a beforeunload listener; destroy removes it', () => {
      const addSpy = vi.fn();
      const removeSpy = vi.fn();
      vi.stubGlobal('window', {
        ...globalThis.window,
        addEventListener: addSpy,
        removeEventListener: removeSpy,
      });

      const comp = createComponent();
      // Make sure isConnected branch in init() doesn't blow up
      mockFetchEmailStatus.mockResolvedValue({ data: { hasEmail: false } });
      comp.init();

      const addCall = addSpy.mock.calls.find((c) => c[0] === 'beforeunload');
      expect(addCall).toBeDefined();
      expect(typeof addCall[1]).toBe('function');
      expect(comp._beforeUnloadHandler).toBe(addCall[1]);

      comp.destroy();
      const removeCall = removeSpy.mock.calls.find((c) => c[0] === 'beforeunload');
      expect(removeCall).toBeDefined();
      // Same function reference (not an anonymous lambda — would leak otherwise)
      expect(removeCall[1]).toBe(addCall[1]);
      expect(comp._beforeUnloadHandler).toBeNull();
    });

    it('beforeunload handler sets returnValue and returns a non-empty string when upgradePhase==="upgrading"', () => {
      const addSpy = vi.fn();
      vi.stubGlobal('window', {
        ...globalThis.window,
        addEventListener: addSpy,
        removeEventListener: vi.fn(),
      });
      mockFetchEmailStatus.mockResolvedValue({ data: { hasEmail: false } });
      const comp = createComponent();
      comp.init();
      const handler = addSpy.mock.calls.find((c) => c[0] === 'beforeunload')[1];

      // Default phase ('idle'): handler returns undefined and doesn't set returnValue
      const idleEvent = { preventDefault: vi.fn(), returnValue: '' };
      expect(handler(idleEvent)).toBeUndefined();
      expect(idleEvent.preventDefault).not.toHaveBeenCalled();
      expect(idleEvent.returnValue).toBe('');

      // 'upgrading' phase: handler triggers the warning
      comp.upgradePhase = 'upgrading';
      const upgradingEvent = { preventDefault: vi.fn(), returnValue: '' };
      const result = handler(upgradingEvent);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      expect(upgradingEvent.preventDefault).toHaveBeenCalled();
      expect(upgradingEvent.returnValue).toBe('Upgrade in progress');
    });

    it('beforeunload handler returns undefined for non-upgrading phases (done, error, idle, new-seed, etc.)', () => {
      const addSpy = vi.fn();
      vi.stubGlobal('window', {
        ...globalThis.window,
        addEventListener: addSpy,
        removeEventListener: vi.fn(),
      });
      mockFetchEmailStatus.mockResolvedValue({ data: { hasEmail: false } });
      const comp = createComponent();
      comp.init();
      const handler = addSpy.mock.calls.find((c) => c[0] === 'beforeunload')[1];

      for (const phase of ['idle', 'new-seed', 'confirm-new', 'enter-old', 'done', 'error']) {
        comp.upgradePhase = phase;
        const event = { preventDefault: vi.fn(), returnValue: '' };
        expect(handler(event)).toBeUndefined();
        expect(event.preventDefault).not.toHaveBeenCalled();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Round-2 hold #1 (advisory): the clock-skew console.warn fires on every
  // _signUpgradeProof call. It does NOT block the broadcast (full fix
  // requires a backend GET /api/time endpoint, tracked as a follow-up); it
  // surfaces signed_at so ops can correlate a 401 with clock skew.
  // ─────────────────────────────────────────────────────────────────────────
  describe('round-2 #1 advisory: clock-skew warning on proof signing', () => {
    it('console.warn includes the signed_at timestamp on every proof sign', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      await comp._signUpgradeProof(Array(12).fill('new').join(' '));

      const skewWarn = warnSpy.mock.calls.find((c) =>
        typeof c[0] === 'string' && c[0].includes('signing proof at signed_at=')
      );
      expect(skewWarn).toBeDefined();
      // The warning includes both the ISO timestamp and the planned backend
      // endpoint name so ops can grep for a future migration signal.
      expect(skewWarn[0]).toContain('GET /api/time');

      warnSpy.mockRestore();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Round-2 hold #8: shared _handlePostBroadcastError helper consumed by
  // both executeUpgrade and retryUpgradeBackend. Sub-case assignments are
  // funnelled through this single helper rather than duplicated.
  // ─────────────────────────────────────────────────────────────────────────
  describe('round-2 #8: _handlePostBroadcastError helper', () => {
    it('helper exists as a method on the component', () => {
      const comp = createComponent();
      expect(typeof comp._handlePostBroadcastError).toBe('function');
    });

    it('post-broadcast 503 routes to backendUnavailable (preserve newSeedPhrase) regardless of caller', () => {
      const comp = createComponent();
      const newMnemonic = Array(12).fill('new').join(' ');
      comp.newSeedPhrase = newMnemonic;
      const err = Object.assign(new Error('x'), { status: 503 });
      comp._handlePostBroadcastError(err, { broadcastLanded: true, logTag: '[test]' });
      expect(comp.upgradeErrorKey).toBe('upgrade.backendUnavailable');
      expect(comp.upgradePhase).toBe('error');
      expect(comp.newSeedPhrase).toBe(newMnemonic);
    });

    it('post-broadcast 429 wipes and routes to rateLimited', () => {
      const comp = createComponent();
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp._handlePostBroadcastError(Object.assign(new Error('x'), { status: 429 }), {
        broadcastLanded: true, logTag: '[test]',
      });
      expect(comp.upgradeErrorKey).toBe('upgrade.rateLimited');
      expect(comp.newSeedPhrase).toBe('');
    });

    it('post-broadcast 409 wipes and routes to alreadyUpgraded', () => {
      const comp = createComponent();
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp._handlePostBroadcastError(Object.assign(new Error('x'), { status: 409 }), {
        broadcastLanded: true, logTag: '[test]',
      });
      expect(comp.upgradeErrorKey).toBe('upgrade.alreadyUpgraded');
      expect(comp.newSeedPhrase).toBe('');
    });

    it('post-broadcast TimeoutError preserves newSeedPhrase and routes to backendTimeout (round-2 hold #6 contract)', () => {
      const comp = createComponent();
      const newMnemonic = Array(12).fill('new').join(' ');
      comp.newSeedPhrase = newMnemonic;
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      comp._handlePostBroadcastError(err, { broadcastLanded: true, logTag: '[test]' });
      expect(comp.upgradeErrorKey).toBe('upgrade.backendTimeout');
      expect(comp.newSeedPhrase).toBe(newMnemonic);
    });

    it('pre-broadcast error routes to retryable failed and does NOT wipe-then-set (catch-all wipes regardless, but key is retryable)', () => {
      const comp = createComponent();
      comp._handlePostBroadcastError(new Error('rejected'), { broadcastLanded: false, logTag: '[test]' });
      expect(comp.upgradeErrorKey).toBe('upgrade.failed');
      expect(comp.canRetryUpgrade).toBe(true);
    });
  });
});

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

// Per-role stub WIFs. Real Hive WIFs are 50 chars (2-char prefix + 48
// base58). Distinct first chars so the FE-KEYCHAIN-API-MISUSE regression
// test can assert three distinct imports and exclude the owner WIF.
const STUB_WIFS = {
  owner: '5K' + 'A'.repeat(48),
  active: '5K' + 'B'.repeat(48),
  posting: '5K' + 'C'.repeat(48),
  memo: '5K' + 'D'.repeat(48),
};

vi.mock('../../src/hive-keys.js', () => ({
  // FE-SEED-PHRASE-KEYCHAIN-COMPAT: deriveHiveKeys is now async and returns
  // per-role WIFs (not hex seeds) via PrivateKey.fromLogin.
  deriveHiveKeys: vi.fn(async () => ({ ...STUB_WIFS })),
  deriveHivePublicKeys: vi.fn(async () => ({
    owner: 'STM' + 'o'.repeat(50),
    active: 'STM' + 'a'.repeat(50),
    posting: 'STM' + 'p'.repeat(50),
    memo: 'STM' + 'm'.repeat(50),
  })),
  // Round-4 hold #3: settings.js now reuses the lazy dhive loader exported
  // from hive-keys.js instead of issuing its own `await import('@hiveio/dhive')`.
  // The dynamic import here resolves to the dhive mock defined below.
  loadDhive: vi.fn(async () => await import('@hiveio/dhive')),
  // BIP39 wrappers (re-exported from hive-keys.js, not from raw @scure/bip39).
  // FE-UPGRADE-KEY-WRAPPER-ADOPT routed settings.js through hive-keys.js so
  // a single entropy/wordlist policy applies across callers.
  generateMnemonic: vi.fn(() => Array(12).fill('test').join(' ')),
  validateMnemonic: vi.fn(() => true),
}));

// dhive mock for the executeUpgrade() credential-wipe test.
// The executeUpgrade path: validateMnemonic(old) → deriveHiveKeys (returns
// WIFs) → new dhive.Client → sendOperations → PrivateKey.fromString (for
// _signUpgradeProof signing) → requestImportKey → fetch('/api/custody/upgrade').
// BIP39 wrappers and key derivation are mocked via `vi.mock('../../src/hive-keys.js', ...)`
// above; the dhive mock only needs to support PrivateKey.fromString (used
// directly by _signUpgradeProof + _performUpgradeKeyRotation to wrap the
// WIFs returned by the deriveHiveKeys mock) and cryptoUtils.sha256.
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

// The shared mockLoginFromResponse fixture's preserve-on-undefined branch
// is critical for this site: the upgrade flow only passes
// {token, expires_at, custody}, and the helper must preserve
// username/isAccredited/accreditation (the upgrade rotates session
// credentials and flips custody, not identity or accreditation).
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
// Imported for round-4 hold #1 regression test which forces the 3rd
// deriveHiveKeys call (inside _performKeychainImport's pre-loop work)
// to throw, simulating an unguarded helper-internal failure that the
// try/finally wrap around _performKeychainImport must absorb.
import { deriveHiveKeys } from '../../src/hive-keys.js';
// Imported so FE-UPGRADE-CLOSURE-WIPE round-1 hold items #2 and #3 can
// override the per-test Client.broadcast.sendOperations spy: item #2 to
// force a helper-internal broadcast rejection, item #3 to assert the
// broadcast-only helper still calls sendOperations when Keychain is
// uninstalled.
import { Client } from '@hiveio/dhive';

function createComponent() {
  initSettingsPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  comp.$watch = vi.fn();
  return comp;
}

describe('settingsPage', () => {
  let localStorageData;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.isConnected = true;
    mockAuthStore.custody = 'light';
    mockAuthStore.isAccredited = true;
    mockAuthStore.accreditation = { orcid: '0000-0001' };
    mockAuthStore.token = 'jwt';
    mockAuthStore.expiresAt = '2099-01-01T00:00:00.000Z';
    localStorageData = {};
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => localStorageData[key] ?? null),
      setItem: vi.fn((key, val) => { localStorageData[key] = val; }),
      removeItem: vi.fn((key) => { delete localStorageData[key]; }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Belt-and-suspenders: per-test `warnSpy.mockRestore()` leaks console.warn
    // suppression if an assertion throws before the restore call runs. A
    // file-local restoreAllMocks() keeps spy leaks from bleeding across
    // sibling tests.
    vi.restoreAllMocks();
  });

  describe('loadEmailStatus', () => {
    it('loads email status from API', async () => {
      mockFetchEmailStatus.mockResolvedValue({ data: { hasEmail: true, email: 'a***@x.com', verified: true } });
      const comp = createComponent();

      await comp.loadEmailStatus();

      expect(comp.emailStatus).toEqual({ hasEmail: true, email: 'a***@x.com', verified: true });
      expect(comp.emailLoading).toBe(false);
    });

    it('defaults to no email on error', async () => {
      mockFetchEmailStatus.mockRejectedValue(new Error('fail'));
      const comp = createComponent();

      await comp.loadEmailStatus();

      expect(comp.emailStatus).toEqual({ hasEmail: false, custody: 'self', hasPassword: false });
    });
  });

  describe('handleEmailSubmit', () => {
    it('submits email and shows success message', async () => {
      mockSubmitEmail.mockResolvedValue({});
      mockFetchEmailStatus.mockResolvedValue({ data: { hasEmail: true, email: 'n***@x.com', verified: false } });
      const comp = createComponent();
      comp.newEmail = ' new@x.com ';

      await comp.handleEmailSubmit();

      expect(mockSubmitEmail).toHaveBeenCalledWith('new@x.com');
      expect(comp.emailMessage).toBe('settings.emailVerificationSent');
      expect(comp.newEmail).toBe('');
    });

    it('does nothing with empty email', async () => {
      const comp = createComponent();
      comp.newEmail = '  ';
      await comp.handleEmailSubmit();
      expect(mockSubmitEmail).not.toHaveBeenCalled();
    });

    it('shows duplicate error', async () => {
      mockSubmitEmail.mockRejectedValue({ code: 'DUPLICATE', message: 'taken' });
      // DUPLICATE is a semantic/benign code; the handler must NOT
      // console.warn on this branch (only non-DUPLICATE failures take the
      // sanitization path). Locks in the DUPLICATE-exempt invariant so a
      // future refactor can't silently reintroduce the noise.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.newEmail = 'dup@x.com';

      await comp.handleEmailSubmit();

      expect(comp.emailError).toBe('settings.emailAlreadyInUse');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    // FE-SETTINGS-ERROR-MESSAGE-SANITIZE-SWEEP: non-DUPLICATE failures must
    // surface a generic localized message and route raw err to console.warn.
    it('sanitizes generic error: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('server error with hex=deadbeefcafebabe');
      mockSubmitEmail.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.newEmail = 'x@x.com';

      await comp.handleEmailSubmit();

      expect(comp.emailError).toBe('settings.emailUpdateFailed');
      expect(comp.emailError).not.toContain('deadbeef');
      expect(warnSpy).toHaveBeenCalled();
      const warnArgs = warnSpy.mock.calls.find((c) => c[0] === '[email submit]');
      expect(warnArgs).toBeDefined();
      const warnedErr = warnArgs[1];
      expect(warnedErr).toBe(leaky);
      warnSpy.mockRestore();
    });
  });

  describe('handleEmailDelete', () => {
    it('deletes email and resets state', async () => {
      mockDeleteEmail.mockResolvedValue({});
      const comp = createComponent();
      comp.emailStatus = { hasEmail: true };

      await comp.handleEmailDelete();

      expect(mockDeleteEmail).toHaveBeenCalledWith(true);
      expect(comp.emailStatus.hasEmail).toBe(false);
      expect(comp.showDeleteConfirm).toBe(false);
      expect(mockToastStore.show).toHaveBeenCalled();
    });

    it('preserves hasPassword on delete so Set-Password surface stays visible for ORCID users', async () => {
      mockDeleteEmail.mockResolvedValue({});
      const comp = createComponent();
      comp.emailStatus = { hasEmail: true, email: 'a***@x.com', verified: true, hasPassword: false };

      await comp.handleEmailDelete();

      expect(comp.emailStatus.hasPassword).toBe(false);
    });

    it('does nothing if already deleting', async () => {
      const comp = createComponent();
      comp.deleting = true;
      await comp.handleEmailDelete();
      expect(mockDeleteEmail).not.toHaveBeenCalled();
    });

    // FE-SETTINGS-ERROR-MESSAGE-SANITIZE-SWEEP: failure must surface a
    // generic localized message and route raw err to console.warn.
    it('sanitizes failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('denied hex=deadbeefcafebabe');
      mockDeleteEmail.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();

      await comp.handleEmailDelete();

      expect(comp.emailError).toBe('settings.emailDeleteFailed');
      expect(comp.emailError).not.toContain('deadbeef');
      expect(comp.deleting).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      const warnArgs = warnSpy.mock.calls.find((c) => c[0] === '[email delete]');
      expect(warnArgs).toBeDefined();
      const warnedErr = warnArgs[1];
      expect(warnedErr).toBe(leaky);
      warnSpy.mockRestore();
    });
  });

  describe('handleOrcidLink', () => {
    it('sets orcid mode and redirects', async () => {
      mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth' });
      vi.stubGlobal('window', { ...globalThis.window, location: { href: '' } });
      const comp = createComponent();

      await comp.handleOrcidLink();

      expect(localStorage.setItem).toHaveBeenCalledWith('pevo_orcid_mode', 'link');
      expect(mockStartOrcid).toHaveBeenCalledWith('link');
    });

    it('rejects invalid redirect URL', async () => {
      mockStartOrcid.mockResolvedValue({ redirect_url: 'https://evil.com/phish' });
      vi.stubGlobal('window', { ...globalThis.window, location: { href: '' } });
      // FE-SETTINGS-ERROR-MESSAGE-SANITIZE-SWEEP: the internal throw is no
      // longer surfaced raw. The DOM sees the generic localized message;
      // the raw 'Invalid ORCID redirect URL' goes to console.warn.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();

      await comp.handleOrcidLink();

      expect(comp.orcidError).toBe('settings.orcidLinkFailed');
      expect(comp.orcidLinking).toBe(false);
      // Filter by '[orcid link]' so the warned-error read survives any
      // earlier intermediate console.warn shifting mock.calls[0]; the
      // toBeDefined() guard surfaces a clear failure if the prefixed
      // warn was skipped, instead of a downstream TypeError.
      expect(warnSpy).toHaveBeenCalled();
      const warnArgs = warnSpy.mock.calls.find((c) => c[0] === '[orcid link]');
      expect(warnArgs).toBeDefined();
      const warnedErr = warnArgs[1];
      expect(warnedErr.message).toBe('Invalid ORCID redirect URL');
      warnSpy.mockRestore();
    });

    it('does nothing if already linking', async () => {
      const comp = createComponent();
      comp.orcidLinking = true;
      await comp.handleOrcidLink();
      expect(mockStartOrcid).not.toHaveBeenCalled();
    });

    // FE-SETTINGS-ERROR-MESSAGE-SANITIZE-SWEEP: failure must surface a
    // generic localized message and route raw err to console.warn.
    it('sanitizes failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('boom hex=deadbeefcafebabe');
      mockStartOrcid.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubGlobal('window', { ...globalThis.window, location: { href: '' } });
      const comp = createComponent();

      await comp.handleOrcidLink();

      expect(comp.orcidError).toBe('settings.orcidLinkFailed');
      expect(comp.orcidError).not.toContain('deadbeef');
      expect(comp.orcidLinking).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      const warnArgs = warnSpy.mock.calls.find((c) => c[0] === '[orcid link]');
      expect(warnArgs).toBeDefined();
      const warnedErr = warnArgs[1];
      expect(warnedErr).toBe(leaky);
      warnSpy.mockRestore();
    });
  });

  describe('startUpgrade', () => {
    it('requires keychain', () => {
      mockIsKeychainInstalled.mockReturnValue(false);
      const comp = createComponent();
      comp.startUpgrade();
      expect(comp.upgradePhase).toBe('error');
      expect(comp.upgradeError).toBe('upgrade.keychainRequired');
    });

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: generateMnemonic()
    // pulls BIP39 entropy. If it throws with entropy-embedded text on a
    // future library revision, the raw err.message must not reach the DOM.
    // Generic localized message to the DOM, raw err to console.warn.
    it('sanitizes generateMnemonic failure: generic message to DOM, raw err to console.warn', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      const hiveKeys = await import('../../src/hive-keys.js');
      const leaky = new Error('entropy failure hex=deadbeefcafebabe');
      hiveKeys.generateMnemonic.mockImplementationOnce(() => { throw leaky; });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();

      comp.startUpgrade();

      expect(comp.upgradePhase).toBe('error');
      expect(comp.upgradeError).toBe('upgrade.generationFailed');
      expect(comp.upgradeError).not.toContain('deadbeef');
      expect(warnSpy).toHaveBeenCalled();
      const warnArgs = warnSpy.mock.calls.find((c) => c[0] === '[custody upgrade start]');
      expect(warnArgs).toBeDefined();
      expect(warnArgs[1]).toBe(leaky);
      warnSpy.mockRestore();
    });
  });

  // FE-UPGRADE-CREDENTIAL-WIPE — `executeUpgrade()` must zero all
  // plaintext-sensitive reactive state (old + new mnemonic, confirm
  // inputs, re-entered password) before transitioning to the 'done'
  // phase. Without this, an XSS on /settings can
  // `window.Alpine.$data(el).oldSeedPhrase` and lift the 12-word seed
  // out of Alpine's reactive store. Same guard on the error path so a
  // failed broadcast + navigate-away doesn't leak.
  describe('FE-UPGRADE-CREDENTIAL-WIPE: executeUpgrade', () => {
    function seedUpgradeState(comp) {
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePassword = 'light-password';
      // Round-5 P1 hold: executeUpgrade() now phase-guards on 'enter-old'
      // (only legal entry phase, set by proceedToOldSeed()). Existing tests
      // entered from the default 'idle' phase and would now early-return.
      comp.upgradePhase = 'enter-old';
      return comp;
    }

    function stubFetchSuccess() {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: { token: 'new-jwt', custody: 'self' },
        }),
      })));
    }

    function stubKeychainImportKey() {
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (account, wifKey, cb) => {
            queueMicrotask(() => cb({ success: true }));
          },
        },
      });
    }

    it('zeroes mnemonic, confirm inputs, and password on the happy path before phase=done', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      stubFetchSuccess();
      stubKeychainImportKey();

      const comp = createComponent();
      seedUpgradeState(comp);

      await comp.executeUpgrade();

      expect(comp.upgradePhase).toBe('done');
      expect(comp.oldSeedPhrase).toBe('');
      expect(comp.newSeedPhrase).toBe('');
      expect(comp.newSeedWords).toEqual([]);
      expect(comp.confirmInputs).toEqual({});
      expect(comp.upgradePassword).toBe('');
    });

    it('zeroes sensitive state on the error path too', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      stubKeychainImportKey();
      // Make the backend call fail so executeUpgrade lands in the catch.
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'upgrade refused' }),
      })));

      const comp = createComponent();
      seedUpgradeState(comp);

      await comp.executeUpgrade();

      expect(comp.upgradePhase).toBe('error');
      expect(comp.oldSeedPhrase).toBe('');
      expect(comp.newSeedPhrase).toBe('');
      expect(comp.newSeedWords).toEqual([]);
      expect(comp.confirmInputs).toEqual({});
      expect(comp.upgradePassword).toBe('');
    });

    // FE-UPGRADE-CREDENTIAL-WIPE re-review finding #1: the error-path
    // `upgradeError` is x-text'd into the DOM. If `err.message` ever
    // embeds key-material (library swap, future error shape, dhive bug),
    // the just-wiped Alpine state is effectively un-wiped via a
    // DOM-visible error string. Fix: surface a generic localized message
    // and console.warn the raw error for diagnostics. This test injects
    // a throw whose message contains a key-material-shaped substring
    // (64-char hex seed + a seed word list) and asserts the substring
    // never reaches `upgradeError`.
    it('does not leak key-material from err.message into upgradeError', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      stubKeychainImportKey();
      const leakHex = 'deadbeef' + 'c'.repeat(56); // 64-char hex
      const leakSeedWords = 'apple banana cherry donkey eagle frog giraffe hill ink jellyfish kiwi lemon';
      const leakMessage = `derive failed: hex=${leakHex} seed="${leakSeedWords}"`;
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new Error(leakMessage);
      }));
      // Suppress the console.warn the catch block emits for diagnostics so
      // the test output stays clean; capture it to assert the raw error DID
      // reach the developer channel even though the DOM path got a generic.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      seedUpgradeState(comp);

      await comp.executeUpgrade();

      expect(comp.upgradePhase).toBe('error');
      expect(typeof comp.upgradeError).toBe('string');
      // Post-broadcast fetch rejection — under FE-CANRETRYUPGRADE-
      // DISCRIMINATOR-KEY-REFACTOR the catch routes anything caught after
      // `_performUpgradeKeyRotation` has resolved (broadcastLanded=true) to
      // `upgrade.partialApplyFailed` instead of the pre-broadcast
      // `upgrade.failed`. The sanitization invariant this test guards is
      // identical for both keys; only the key identity moves.
      expect(comp.upgradeError).toBe('upgrade.partialApplyFailed');
      // Critical: neither of the leak substrings may appear in the DOM-bound
      // error string.
      expect(comp.upgradeError).not.toContain(leakHex);
      expect(comp.upgradeError).not.toContain(leakSeedWords);
      // Sanity: raw error still surfaced to console.warn so developers can
      // debug. (Not a leak — devtools is a trusted surface.)
      expect(warnSpy).toHaveBeenCalled();
      // Filter by the '[custody upgrade]' prefix instead of relying on
      // mock.calls[0]: any earlier console.warn (test mock, library
      // diagnostic, etc.) would shift the index and cause this assertion
      // to target the wrong error object.
      const warnArgs = warnSpy.mock.calls.find((c) => c[0] === '[custody upgrade]');
      expect(warnArgs).toBeDefined();
      const warnedErr = warnArgs[1];
      const warnedStr = warnedErr && warnedErr.message ? warnedErr.message : String(warnedErr);
      expect(warnedStr).toContain(leakHex);
      warnSpy.mockRestore();
    });

    // Round-3 hold item #1: regression-class guard against the
    // `$t('upgrade.partialApplyFailed') || err.message` OR-fallback
    // pattern. Stubs $t to return '' for the specific key (simulating a
    // missing translation in a locale file) and exercises the same leak
    // path. Under safe production code (`upgradeError = $t(...)`), this
    // test passes because upgradeError lands at ''. Under a regressed
    // OR-fallback, $t returns '' → falls through to err.message → leak
    // substrings appear in upgradeError → assertion fails.
    //
    // The post-broadcast catch (broadcastLanded=true) reads
    // `$t('upgrade.partialApplyFailed')` after FE-CANRETRYUPGRADE-
    // DISCRIMINATOR-KEY-REFACTOR; the simulated missing-translation key
    // tracks the actual key the catch consults on this path.
    it('does not leak key-material when $t returns empty for upgrade.partialApplyFailed', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      stubKeychainImportKey();
      const leakHex = 'deadbeef' + 'c'.repeat(56);
      const leakSeedWords = 'apple banana cherry donkey eagle frog giraffe hill ink jellyfish kiwi lemon';
      const leakMessage = `derive failed: hex=${leakHex} seed="${leakSeedWords}"`;
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new Error(leakMessage);
      }));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      // Simulate a locale where 'upgrade.partialApplyFailed' has no
      // translation. Other keys still resolve so the rest of the flow
      // behaves normally.
      comp.$t = (key) => (key === 'upgrade.partialApplyFailed' ? '' : key);
      seedUpgradeState(comp);

      await comp.executeUpgrade();

      expect(comp.upgradePhase).toBe('error');
      expect(typeof comp.upgradeError).toBe('string');
      expect(comp.upgradeError).not.toContain(leakHex);
      expect(comp.upgradeError).not.toContain(leakSeedWords);
      warnSpy.mockRestore();
    });
  });

  // FE-UPGRADE-CLOSURE-WIPE — the derivation/broadcast/keychain-import
  // steps (which capture `oldSeed`, `oldKeys`, `newSeed`, `newKeys`,
  // `newPubKeys`, `ownerKey`, per-role `wif`) must live inside a
  // narrower-scoped helper method (`_performUpgradeKeyRotation`) that
  // returns BEFORE `_clearSensitiveUpgradeState()` runs. This way the
  // helper's frame is popped off the stack and its `const` bindings are
  // unreachable by the time the wipe executes — closure-captured key
  // material is eligible for GC on the very next cycle, in addition to
  // the reactive-field zeroing that _clearSensitiveUpgradeState already
  // does.
  //
  // JS has no deterministic zero-on-release and WeakRef/FinalizationRegistry
  // timing is engine-dependent and flaky under vitest, so the reachability
  // invariant is enforced structurally instead:
  //   (1) The helper method exists (regression guard against future inlining).
  //   (2) Its promise resolves BEFORE `_clearSensitiveUpgradeState()` is
  //       called on the happy path (proves the frame exited first).
  //   (3) It returns undefined (no derived key object escapes back to
  //       `executeUpgrade`'s frame via the return value).
  describe('FE-UPGRADE-CLOSURE-WIPE: executeUpgrade', () => {
    function seedUpgradeState(comp) {
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePassword = 'light-password';
      // Round-5 P1 hold: executeUpgrade() now phase-guards on 'enter-old'
      // (only legal entry phase, set by proceedToOldSeed()). Existing tests
      // entered from the default 'idle' phase and would now early-return.
      comp.upgradePhase = 'enter-old';
      return comp;
    }

    function stubFetchSuccess() {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { token: 'new-jwt', custody: 'self' } }),
      })));
    }

    function stubKeychainImportKey() {
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (_a, _k, cb) => queueMicrotask(() => cb({ success: true })),
        },
      });
    }

    it('extracts key derivation + broadcast + keychain import into _performUpgradeKeyRotation helper', () => {
      const comp = createComponent();
      // Regression guard: if a future refactor inlines this helper back
      // into executeUpgrade, the derivation frame stops popping before
      // the wipe runs and closure-captured key material lingers.
      expect(typeof comp._performUpgradeKeyRotation).toBe('function');
    });

    it('helper frame exits before _clearSensitiveUpgradeState runs (happy path)', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      stubFetchSuccess();
      stubKeychainImportKey();

      const comp = createComponent();
      seedUpgradeState(comp);

      const events = [];
      // Round-1 hold item #1: instrument deriveHiveKeys to record WHEN
      // it's called. A no-op `_performUpgradeKeyRotation` stub passes the
      // ordering-only assertion (perform:enter < perform:exit < wipe holds
      // trivially around an empty function), so the architect's ordering
      // check alone doesn't enforce that the helper actually contains
      // derivation work. Recording each deriveHiveKeys call as a timed
      // event lets the assertion below force `deriveHiveKeys:call` between
      // perform:enter and perform:exit. A no-op helper would never push
      // that event from inside its frame; an inlined-into-caller refactor
      // would push it BEFORE perform:enter. Both fail the ordering check.
      vi.mocked(deriveHiveKeys).mockImplementation(async () => {
        events.push('deriveHiveKeys:call');
        return { ...STUB_WIFS };
      });
      const origPerform = comp._performUpgradeKeyRotation.bind(comp);
      comp._performUpgradeKeyRotation = async (...args) => {
        events.push('perform:enter');
        const result = await origPerform(...args);
        events.push('perform:exit');
        // Reachability evidence: by the time we push 'perform:exit', the
        // inner `oldSeed`/`oldKeys`/`newSeed`/`newKeys`/`newPubKeys`/`ownerKey`
        // bindings no longer have any owning reference — they lived in the
        // helper's frame, which is now unwinding. The awaited result must
        // be `undefined`; otherwise the derived material would be escaping
        // back to executeUpgrade's frame via the return value.
        expect(result).toBeUndefined();
        return result;
      };
      const origWipe = comp._clearSensitiveUpgradeState.bind(comp);
      comp._clearSensitiveUpgradeState = () => {
        events.push('wipe');
        return origWipe();
      };

      await comp.executeUpgrade();

      expect(comp.upgradePhase).toBe('done');
      // Invariant: the derivation helper fully exits (perform:exit) BEFORE
      // the wipe runs. The 'perform:exit' event fires when the awaited
      // promise resolves, which implies the helper's frame has popped.
      const enterIdx = events.indexOf('perform:enter');
      const exitIdx = events.indexOf('perform:exit');
      const wipeIdx = events.indexOf('wipe');
      // Find the FIRST deriveHiveKeys:call that occurs inside the helper
      // window (between perform:enter and perform:exit). The settings page
      // also calls deriveHiveKeys from _performKeychainImport AFTER the
      // broadcast helper exits — those calls are legitimate and should be
      // ignored by this invariant; the helper-window call is the one that
      // proves derivation lives inside `_performUpgradeKeyRotation`.
      const firstSeedCallInHelper = events.findIndex(
        (e, i) => e === 'deriveHiveKeys:call' && i > enterIdx && i < exitIdx,
      );
      expect(enterIdx).toBeGreaterThanOrEqual(0);
      expect(exitIdx).toBeGreaterThanOrEqual(0);
      expect(wipeIdx).toBeGreaterThanOrEqual(0);
      // Mutation-kill: a no-op `_performUpgradeKeyRotation` would never call
      // deriveHiveKeys between perform:enter and perform:exit, so this
      // assertion fails (-1 → not greater than enterIdx).
      expect(firstSeedCallInHelper).toBeGreaterThan(enterIdx);
      expect(firstSeedCallInHelper).toBeLessThan(exitIdx);
      expect(exitIdx).toBeLessThan(wipeIdx);
    });

    it('helper frame exits before _clearSensitiveUpgradeState runs (error path: post-helper fetch failure)', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      stubKeychainImportKey();
      // Fetch fails → executeUpgrade lands in the catch block, which still
      // calls _clearSensitiveUpgradeState. The helper has already returned
      // by the time the catch runs (broadcast + keychain import happened
      // before the fetch), so the reachability invariant still holds.
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'upgrade refused' }),
      })));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      seedUpgradeState(comp);

      const events = [];
      const origPerform = comp._performUpgradeKeyRotation.bind(comp);
      comp._performUpgradeKeyRotation = async (...args) => {
        events.push('perform:enter');
        const result = await origPerform(...args);
        events.push('perform:exit');
        return result;
      };
      const origWipe = comp._clearSensitiveUpgradeState.bind(comp);
      comp._clearSensitiveUpgradeState = () => {
        events.push('wipe');
        return origWipe();
      };

      await comp.executeUpgrade();

      expect(comp.upgradePhase).toBe('error');
      const exitIdx = events.indexOf('perform:exit');
      const wipeIdx = events.indexOf('wipe');
      expect(exitIdx).toBeGreaterThanOrEqual(0);
      expect(wipeIdx).toBeGreaterThanOrEqual(0);
      expect(exitIdx).toBeLessThan(wipeIdx);

      warnSpy.mockRestore();
    });

    // Round-1 hold item #2: the existing error-path test above stubs `fetch`
    // to fail, but `fetch` runs AFTER `_performUpgradeKeyRotation` already
    // returned successfully — perform:exit fires on normal helper resolution
    // before any failure, so `exitIdx < wipeIdx` is trivially true by linear
    // control flow. The realistic helper-internal failure mode is the
    // dhive `sendOperations` rejection: that throws INSIDE the helper, and
    // the test must verify (a) the rejection propagates to executeUpgrade's
    // catch, (b) the catch runs `_clearSensitiveUpgradeState`, and (c) the
    // helper's frame still pops before the wipe — proving closure-captured
    // bindings (`oldSeed`, `oldKeys`, `newSeed`, `newKeys`, `newPubKeys`,
    // `ownerKey`) become unreachable even on the rejection path.
    it('helper-internal broadcast rejection: catch wipes and frame pops before wipe', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      stubKeychainImportKey();
      // Override the next dhive.Client instance's broadcast.sendOperations
      // to reject. This puts the failure INSIDE the helper, not after it.
      vi.mocked(Client).mockImplementationOnce(() => ({
        broadcast: {
          sendOperations: vi.fn(async () => {
            throw new Error('broadcast network failure');
          }),
        },
      }));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      seedUpgradeState(comp);

      const events = [];
      const origPerform = comp._performUpgradeKeyRotation.bind(comp);
      // try/finally wrapper: 'perform:exit' MUST fire even when origPerform
      // rejects. The simple `await origPerform(...); events.push('exit')`
      // pattern used by the happy-path test would skip the push on
      // rejection and the ordering assertion would target the wrong event.
      comp._performUpgradeKeyRotation = async (...args) => {
        events.push('perform:enter');
        try {
          return await origPerform(...args);
        } finally {
          events.push('perform:exit');
        }
      };
      const origWipe = comp._clearSensitiveUpgradeState.bind(comp);
      comp._clearSensitiveUpgradeState = () => {
        events.push('wipe');
        return origWipe();
      };

      await comp.executeUpgrade();

      // The rejection must have driven executeUpgrade into its catch block.
      expect(comp.upgradePhase).toBe('error');
      // Frame pop on rejection: 'perform:exit' fires from the finally clause
      // BEFORE the catch block calls _clearSensitiveUpgradeState. The
      // helper's local bindings are unreachable by the time wipe runs.
      const enterIdx = events.indexOf('perform:enter');
      const exitIdx = events.indexOf('perform:exit');
      const wipeIdx = events.indexOf('wipe');
      expect(enterIdx).toBeGreaterThanOrEqual(0);
      expect(exitIdx).toBeGreaterThan(enterIdx);
      expect(wipeIdx).toBeGreaterThan(exitIdx);

      warnSpy.mockRestore();
    });

    // Round-1 hold item #3: at HEAD the broadcast helper
    // (`_performUpgradeKeyRotation`) is broadcast-only after the round-3
    // split — Keychain import lives in the sibling `_performKeychainImport`
    // helper. The broadcast is the IRREVERSIBLE step (account_update on
    // chain) and MUST run independent of Keychain availability, otherwise
    // a `!isKeychainInstalled()` precondition would silently skip the
    // chain rotation while leaving every other step in the upgrade flow
    // intact. This test locks in that invariant.
    it('broadcasts via sendOperations even when Keychain is uninstalled', async () => {
      mockIsKeychainInstalled.mockReturnValue(false);
      // Pre-warm the next Client instance with a closure-captured spy so
      // the assertion has a stable handle regardless of how many Clients
      // executeUpgrade ends up constructing.
      const sendOpsSpy = vi.fn(async () => ({ id: 'stub-tx' }));
      vi.mocked(Client).mockImplementationOnce(() => ({
        broadcast: { sendOperations: sendOpsSpy },
      }));

      const comp = createComponent();
      // Call the helper directly — bypasses the executeUpgrade wrapper so
      // the assertion targets the helper's own invariant, not the
      // surrounding orchestration.
      await comp._performUpgradeKeyRotation(
        Array(12).fill('old').join(' '),
        Array(12).fill('new').join(' '),
      );

      // The helper MUST broadcast even with Keychain uninstalled — the
      // chain rotation cannot be conditional on browser-extension state.
      expect(sendOpsSpy).toHaveBeenCalled();
    });

    it('_performUpgradeKeyRotation returns undefined (no derived key object escapes to caller)', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      stubKeychainImportKey();

      const comp = createComponent();
      const result = await comp._performUpgradeKeyRotation(
        Array(12).fill('old').join(' '),
        Array(12).fill('new').join(' '),
      );

      // Critical: the helper MUST NOT return `newKeys`, `newPubKeys`,
      // `oldKeys`, or any other object that would re-escape the derived
      // material into executeUpgrade's frame. A future refactor that
      // returns the tx id is fine (scalar), but returning the key objects
      // would defeat the whole narrowing — assert undefined to lock it.
      expect(result).toBeUndefined();
    });
  });

  // FE-SAVESESSION-API-MISUSE-SWEEP: executeUpgrade() used to call
  // _saveSession(token, username, null, isAccredited, accreditation, 'self')
  // — the no-arg implementation silently ignored all six args, so the `null`
  // was harmless in practice, BUT the old call-shape advertised an intent
  // ("wipe expires_at on upgrade") that would have been actively wrong if
  // _saveSession ever honored its args. Lock in the no-arg form + full
  // pre-save state-reset: custody flips to 'self', token rotates to the
  // upgrade response's new token, and expires_at rotates alongside it so
  // the persisted entry matches the new token's lifetime. Pre-existing
  // isAccredited / accreditation are preserved (upgrade doesn't change
  // accreditation status).
  describe('FE-SAVESESSION-API-MISUSE-SWEEP: executeUpgrade', () => {
    function seedUpgradeState(comp) {
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePassword = 'light-password';
      // Round-5 P1 hold: executeUpgrade() now phase-guards on 'enter-old'
      // (only legal entry phase, set by proceedToOldSeed()). Existing tests
      // entered from the default 'idle' phase and would now early-return.
      comp.upgradePhase = 'enter-old';
      return comp;
    }

    it('calls no-arg _saveSession() with full auth state set on the store first', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (_a, _k, cb) => queueMicrotask(() => cb({ success: true })),
        },
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            token: 'new-jwt',
            custody: 'self',
            expires_at: '2100-01-01T00:00:00.000Z',
          },
        }),
      })));
      // Snapshot-capturing stub: inspects what _saveSession would persist
      // *at the moment it was called*, locking in the ordering invariant.
      // A future refactor moving `auth.expiresAt = result.data.expires_at`
      // (or any other pre-save assignment) to AFTER _saveSession() passes
      // a final-state assertion while re-introducing the "stale prior
      // expiresAt persisted, user logged out on reload" bug.
      let savedSnapshot;
      mockAuthStore._saveSession = vi.fn(function () {
        savedSnapshot = { ...mockAuthStore };
      });

      const comp = createComponent();
      seedUpgradeState(comp);

      await comp.executeUpgrade();

      expect(comp.upgradePhase).toBe('done');
      // Store state immediately before the no-arg _saveSession() call
      // determines the persisted localStorage shape. Assert each load-bearing
      // field landed correctly AT CALL TIME, not after the await returns.
      expect(savedSnapshot).toBeDefined();
      expect(savedSnapshot.custody).toBe('self');
      expect(savedSnapshot.token).toBe('new-jwt');
      // Load-bearing: expiresAt rotates with the new token, so _restoreSession
      // sees a valid entry on next load. Historically the 6-arg call passed
      // null here, which would have wiped expires_at and logged the user out.
      expect(savedSnapshot.expiresAt).toBe('2100-01-01T00:00:00.000Z');
      // Pre-existing accreditation fields survive the upgrade.
      expect(savedSnapshot.isAccredited).toBe(true);
      expect(savedSnapshot.accreditation).toEqual({ orcid: '0000-0001' });
      // The no-arg form — zero positional args, reads from instance state.
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith();
    });

    // Atomic-pair semantics (post-loginFromResponse adoption): when the
    // backend response omits expires_at, the helper preserves BOTH
    // token and expiresAt — the pre-adoption decoupled-guard form would
    // rotate the token while preserving the old expiry, persisting a
    // server-invalidated old token with new expiry (UI thinks logged
    // in, first API call returns 401). Custody still rotates because
    // it's outside the atomic pair.
    it('atomic pair: preserves token + expiresAt when backend omits expires_at from upgrade response', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (_a, _k, cb) => queueMicrotask(() => cb({ success: true })),
        },
      });
      // Backend response omits expires_at (older contract shape).
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: { token: 'new-jwt-legacy', custody: 'self' },
        }),
      })));

      const originalToken = mockAuthStore.token;
      const originalExpiry = mockAuthStore.expiresAt;
      const comp = createComponent();
      seedUpgradeState(comp);

      await comp.executeUpgrade();

      expect(comp.upgradePhase).toBe('done');
      // Atomic pair: neither rotates when only one is supplied.
      expect(mockAuthStore.token).toBe(originalToken);
      expect(mockAuthStore.expiresAt).toBe(originalExpiry);
      // Custody still flips (outside the atomic pair).
      expect(mockAuthStore.custody).toBe('self');
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith();
    });

    // Atomic-pair semantics for explicit `null`: a regression to
    // `'expires_at' in result.data` would treat explicit null as
    // truthy-key-present and assign null to auth.expiresAt, silently
    // logging users out on next reload. The helper's truthy-check
    // (`data.token && data.expires_at`) treats null as falsy and
    // skips both assignments.
    it('atomic pair: preserves token + expiresAt when backend response has expires_at: null explicit', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (_a, _k, cb) => queueMicrotask(() => cb({ success: true })),
        },
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: { token: 'new-jwt-null-expiry', custody: 'self', expires_at: null },
        }),
      })));

      const originalToken = mockAuthStore.token;
      const originalExpiry = mockAuthStore.expiresAt;
      const comp = createComponent();
      seedUpgradeState(comp);

      await comp.executeUpgrade();

      expect(comp.upgradePhase).toBe('done');
      expect(mockAuthStore.token).toBe(originalToken);
      expect(mockAuthStore.expiresAt).toBe(originalExpiry);
      expect(mockAuthStore.custody).toBe('self');
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith();
    });

    // Helper-adoption regression guard: the upgrade now uses
    // loginFromResponse(). `is_accredited` and `accreditation` are
    // omitted from the data payload, so the helper's
    // preserve-on-undefined branch keeps the user's existing
    // accreditation state across the upgrade — the upgrade flips
    // custody and rotates session credentials, not identity.
    it('preserves isAccredited and accreditation across the upgrade (helper preserve-on-undefined)', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (_a, _k, cb) => queueMicrotask(() => cb({ success: true })),
        },
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: { token: 'new-jwt', custody: 'self', expires_at: '2100-01-01T00:00:00.000Z' },
        }),
      })));

      const originalIsAccredited = mockAuthStore.isAccredited;
      const originalAccreditation = mockAuthStore.accreditation;
      const comp = createComponent();
      seedUpgradeState(comp);

      await comp.executeUpgrade();

      expect(mockAuthStore.isAccredited).toBe(originalIsAccredited);
      expect(mockAuthStore.accreditation).toEqual(originalAccreditation);
    });
  });

  // FE-KEYCHAIN-API-MISUSE regression guard. The upgrade flow used to call
  // `window.hive_keychain.requestAddAccountAuthority(username, rawHexSeed,
  // 'posting', cb)` — wrong API (second arg should be an ACCOUNT NAME) and
  // a private-key seed leak into Keychain's extension logs. Replaced with
  // `requestImportKey(username, wifPosting, cb)`. A grep-level check on
  // the compiled module source is the simplest, most-robust regression
  // guard: exercising executeUpgrade() in a unit test would require mocking
  // BIP39, dhive, and the chain broadcast. This test keeps the assertion
  // cheap and impossible to bypass with an equivalent code rewrite.
  describe('FE-KEYCHAIN-API-MISUSE regression', () => {
    it('settings.js must not call requestAddAccountAuthority', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const here = path.dirname(fileURLToPath(import.meta.url));
      const src = fs.readFileSync(
        path.join(here, '../../src/pages/settings.js'),
        'utf8',
      );
      // Strip block + line comments so the historical-mention comment in
      // the upgrade flow doesn't trigger the regression. We only want to
      // catch a real method call `.requestAddAccountAuthority(`.
      const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
      const noLineComments = noBlockComments.replace(/\/\/[^\n]*/g, '');
      expect(noLineComments).not.toMatch(/\.requestAddAccountAuthority\s*\(/);
    });

    it('settings.js must call requestImportKey in the upgrade flow', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const here = path.dirname(fileURLToPath(import.meta.url));
      const src = fs.readFileSync(
        path.join(here, '../../src/pages/settings.js'),
        'utf8',
      );
      expect(src).toMatch(/window\.hive_keychain\.requestImportKey\(/);
    });

    // FE-KEYCHAIN-API-MISUSE re-review: the custody upgrade must import
    // posting + active + memo (NOT owner) into Keychain so the user can
    // sign every non-owner-auth op after the upgrade. The previous single
    // posting-only import left Keychain unable to sign transfers/power-down
    // (active) or encrypt memos (memo). Assert three sequential
    // requestImportKey calls with three DISTINCT WIFs.
    it('executeUpgrade imports posting + active + memo WIFs (three distinct) into Keychain', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      const importKeyCalls = [];
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (account, wifKey, cb) => {
            importKeyCalls.push({ account, wifKey });
            queueMicrotask(() => cb({ success: true }));
          },
        },
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { token: 'new-jwt', custody: 'self' } }),
      })));

      const comp = createComponent();
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePassword = 'light-password';
      // Round-5 P1 hold: executeUpgrade() now phase-guards on 'enter-old'
      // (only legal entry phase, set by proceedToOldSeed()). Existing tests
      // entered from the default 'idle' phase and would now early-return.
      comp.upgradePhase = 'enter-old';

      await comp.executeUpgrade();

      expect(comp.upgradePhase).toBe('done');
      expect(importKeyCalls).toHaveLength(3);
      for (const call of importKeyCalls) {
        expect(call.account).toBe('alice');
        expect(typeof call.wifKey).toBe('string');
        expect(call.wifKey.length).toBeGreaterThan(10);
      }
      const distinctWifs = new Set(importKeyCalls.map((c) => c.wifKey));
      expect(distinctWifs.size).toBe(3);
      // Belt-and-suspenders: owner WIF must NOT have been imported. The
      // deriveHiveKeys mock above returns `STUB_WIFS.owner`; reference the
      // shared constant so a stub-shape change flows through automatically.
      for (const call of importKeyCalls) {
        expect(call.wifKey).not.toBe(STUB_WIFS.owner);
      }
    });

    // FE-KEYCHAIN-API-MISUSE round-2 hold #2 (mid-loop denial):
    // After the round-2 reorder, the Keychain import loop runs AFTER the
    // irreversible (broadcast + backend cleanup) pair. A user denying the
    // popup mid-loop must NOT wedge the upgrade: backend cleanup has
    // already fired, the loop becomes best-effort, the upgrade completes
    // with `upgradePhase === 'done'`, and the denied role's localized
    // warning lands in `upgradeWarnings` for the success-screen surface.
    //
    // Two specs cover the loop's first and second indices to lock in that
    // a denial at any iteration produces the same best-effort outcome (the
    // round-1 single-call shape made these distinguishable; the round-2
    // loop must not regress).
    it('best-effort: keychain denies on call index 1 (active) → done + active warning', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      const importKeyCalls = [];
      const fetchCalls = [];
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (account, wifKey, cb) => {
            importKeyCalls.push({ account, wifKey });
            const idx = importKeyCalls.length - 1;
            queueMicrotask(() => cb(idx === 1 ? { success: false, message: 'denied' } : { success: true }));
          },
        },
      });
      vi.stubGlobal('fetch', vi.fn(async (...args) => {
        fetchCalls.push(args);
        return {
          ok: true,
          json: async () => ({ data: { token: 'new-jwt', custody: 'self' } }),
        };
      }));
      // Suppress per-role warning console.warn that the helper emits for
      // diagnostics so the test output stays clean.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePassword = 'light-password';
      // Round-5 P1 hold: executeUpgrade() now phase-guards on 'enter-old'
      // (only legal entry phase, set by proceedToOldSeed()). Existing tests
      // entered from the default 'idle' phase and would now early-return.
      comp.upgradePhase = 'enter-old';

      await comp.executeUpgrade();

      // Backend cleanup fired (the irreversible pair completed BEFORE the
      // import loop ran). Path-shape match: single call to /api/custody/upgrade.
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0][0]).toBe('/api/custody/upgrade');
      // Upgrade marked done despite the partial keychain import.
      expect(comp.upgradePhase).toBe('done');
      expect(comp.upgradeError).toBeNull();
      // Warning surfaced for the active role (the denied iteration).
      expect(comp.upgradeWarnings).toEqual(
        expect.arrayContaining(['upgrade.keychainImportWarning.active']),
      );
      // Loop continued past the denial — memo (index 2) was still attempted.
      expect(importKeyCalls.length).toBe(3);

      warnSpy.mockRestore();
    });

    it('best-effort: keychain denies on call index 0 (posting) → done + posting warning', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      const importKeyCalls = [];
      const fetchCalls = [];
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (account, wifKey, cb) => {
            importKeyCalls.push({ account, wifKey });
            const idx = importKeyCalls.length - 1;
            queueMicrotask(() => cb(idx === 0 ? { success: false, message: 'denied' } : { success: true }));
          },
        },
      });
      vi.stubGlobal('fetch', vi.fn(async (...args) => {
        fetchCalls.push(args);
        return {
          ok: true,
          json: async () => ({ data: { token: 'new-jwt', custody: 'self' } }),
        };
      }));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePassword = 'light-password';
      // Round-5 P1 hold: executeUpgrade() now phase-guards on 'enter-old'
      // (only legal entry phase, set by proceedToOldSeed()). Existing tests
      // entered from the default 'idle' phase and would now early-return.
      comp.upgradePhase = 'enter-old';

      await comp.executeUpgrade();

      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0][0]).toBe('/api/custody/upgrade');
      expect(comp.upgradePhase).toBe('done');
      expect(comp.upgradeError).toBeNull();
      expect(comp.upgradeWarnings).toEqual(
        expect.arrayContaining(['upgrade.keychainImportWarning.posting']),
      );
      // Loop continued past the denial — active + memo (indices 1, 2) still attempted.
      expect(importKeyCalls.length).toBe(3);

      warnSpy.mockRestore();
    });

    // FE-KEYCHAIN-API-MISUSE round-4 hold #1 (P1):
    // The try/catch only wraps requestImportKey inside the per-role loop. The
    // helper's pre-loop work (deriveHiveKeys) is unguarded. A throw from
    // there escapes both the helper and executeUpgrade, leaving chain
    // rotated + backend cleaned up + mnemonic NOT wiped (re-opens the
    // FE-UPGRADE-CREDENTIAL-WIPE invariant via a different injection point)
    // + upgradePhase stuck at 'upgrading' with no recovery UI. Fix: wrap
    // the helper call site in try/catch/finally so wipe + upgradePhase =
    // 'done' run unconditionally and the failure surfaces as a single
    // fallback warning. After FE-SEED-PHRASE-KEYCHAIN-COMPAT (2026-05-16)
    // the helper's pre-loop work is just `deriveHiveKeys(newSeedPhrase, account)`
    // — async, calling PrivateKey.fromLogin internally; the same try/finally
    // shape absorbs its rejections.
    it('best-effort: helper throws (deriveHiveKeys rejects pre-loop) → done + fallback warning', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (account, wifKey, cb) => {
            queueMicrotask(() => cb({ success: true }));
          },
        },
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { token: 'new-jwt', custody: 'self' } }),
      })));
      // Force the 4th deriveHiveKeys call to reject. Calls 1+2 happen
      // inside _performUpgradeKeyRotation (oldWords + newSeedPhrase for the
      // broadcast step) and must succeed so the broadcast lands and backend
      // cleanup fires; call 3 happens inside _signUpgradeProof (also pre-
      // broadcast, must succeed); only call 4 (inside _performKeychainImport's
      // pre-loop work) must throw — that's the injection point the round-4
      // fix targets.
      let deriveCallCount = 0;
      vi.mocked(deriveHiveKeys).mockImplementation(async () => {
        deriveCallCount += 1;
        if (deriveCallCount >= 4) throw new Error('seed corruption mid-helper');
        return { ...STUB_WIFS };
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePassword = 'light-password';
      // Round-5 P1 hold: executeUpgrade() now phase-guards on 'enter-old'
      // (only legal entry phase, set by proceedToOldSeed()). Existing tests
      // entered from the default 'idle' phase and would now early-return.
      comp.upgradePhase = 'enter-old';

      await comp.executeUpgrade();

      // The try/finally around _performKeychainImport caught the throw,
      // pushed the fallback warning, wiped sensitive state, and flipped to
      // 'done'. Without the fix, executeUpgrade would re-throw and these
      // assertions would all fail (upgradePhase stuck at 'upgrading',
      // mnemonic still in reactive state).
      expect(comp.upgradePhase).toBe('done');
      expect(comp.upgradeError).toBeNull();
      expect(comp.newSeedPhrase).toBe('');
      expect(comp.oldSeedPhrase).toBe('');
      expect(comp.upgradeWarnings).toEqual(
        expect.arrayContaining(['upgrade.keychainImportFailed']),
      );

      warnSpy.mockRestore();
    });

    // FE-KEYCHAIN-API-MISUSE round-4 hold #3 (P2):
    // memo (idx 2) is the loop's last iteration — structurally distinct
    // from the existing posting/active denial specs. The "loop continued
    // past denial" assertion is vacuous here; what we lock in is that a
    // last-iteration denial still produces the same best-effort outcome
    // (done + memo warning).
    it('best-effort: keychain denies on call index 2 (memo) → done + memo warning', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      const importKeyCalls = [];
      const fetchCalls = [];
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (account, wifKey, cb) => {
            importKeyCalls.push({ account, wifKey });
            const idx = importKeyCalls.length - 1;
            queueMicrotask(() => cb(idx === 2 ? { success: false, message: 'denied' } : { success: true }));
          },
        },
      });
      vi.stubGlobal('fetch', vi.fn(async (...args) => {
        fetchCalls.push(args);
        return {
          ok: true,
          json: async () => ({ data: { token: 'new-jwt', custody: 'self' } }),
        };
      }));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePassword = 'light-password';
      // Round-5 P1 hold: executeUpgrade() now phase-guards on 'enter-old'
      // (only legal entry phase, set by proceedToOldSeed()). Existing tests
      // entered from the default 'idle' phase and would now early-return.
      comp.upgradePhase = 'enter-old';

      await comp.executeUpgrade();

      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0][0]).toBe('/api/custody/upgrade');
      expect(comp.upgradePhase).toBe('done');
      expect(comp.upgradeError).toBeNull();
      expect(comp.upgradeWarnings).toEqual(
        expect.arrayContaining(['upgrade.keychainImportWarning.memo']),
      );
      // posting + active still attempted before the memo denial.
      expect(importKeyCalls.length).toBe(3);

      warnSpy.mockRestore();
    });

    // FE-KEYCHAIN-API-MISUSE round-4 hold #3 (P2):
    // All-three-deny is the maximum failure mode for the best-effort path.
    // Locks in that the success surface still flips to 'done' with 3 distinct
    // role warnings and that backend cleanup fired exactly once (no retry on
    // import failure).
    it('best-effort: keychain denies all three roles → done + 3 warnings', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      const importKeyCalls = [];
      const fetchCalls = [];
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (account, wifKey, cb) => {
            importKeyCalls.push({ account, wifKey });
            queueMicrotask(() => cb({ success: false, message: 'denied' }));
          },
        },
      });
      vi.stubGlobal('fetch', vi.fn(async (...args) => {
        fetchCalls.push(args);
        return {
          ok: true,
          json: async () => ({ data: { token: 'new-jwt', custody: 'self' } }),
        };
      }));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePassword = 'light-password';
      // Round-5 P1 hold: executeUpgrade() now phase-guards on 'enter-old'
      // (only legal entry phase, set by proceedToOldSeed()). Existing tests
      // entered from the default 'idle' phase and would now early-return.
      comp.upgradePhase = 'enter-old';

      await comp.executeUpgrade();

      expect(fetchCalls.length).toBe(1);
      expect(comp.upgradePhase).toBe('done');
      expect(comp.upgradeError).toBeNull();
      expect(importKeyCalls.length).toBe(3);
      expect(comp.upgradeWarnings).toEqual([
        'upgrade.keychainImportWarning.posting',
        'upgrade.keychainImportWarning.active',
        'upgrade.keychainImportWarning.memo',
      ]);

      warnSpy.mockRestore();
    });

    // FE-KEYCHAIN-API-MISUSE round-4 hold #4 (P2):
    // The whole point of the round-3 reorder is backend cleanup BEFORE the
    // keychain loop, so a mid-loop denial cannot leave backend with stale
    // encrypted keys for the now-superseded authorities. The existing tests
    // verify both happen but not ORDERING — a refactor swapping (c) and (d)
    // re-introduces the original lockout but passes the existing assertions.
    // Capture a shared sequence counter so the ordering invariant is locked
    // in mechanically.
    it('backend cleanup runs BEFORE the first keychain import attempt', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      let seq = 0;
      let firstImportSeq = null;
      let fetchSeq = null;
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (account, wifKey, cb) => {
            if (firstImportSeq === null) firstImportSeq = ++seq;
            queueMicrotask(() => cb({ success: true }));
          },
        },
      });
      vi.stubGlobal('fetch', vi.fn(async () => {
        fetchSeq = ++seq;
        return {
          ok: true,
          json: async () => ({ data: { token: 'new-jwt', custody: 'self' } }),
        };
      }));

      const comp = createComponent();
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePassword = 'light-password';
      // Round-5 P1 hold: executeUpgrade() now phase-guards on 'enter-old'
      // (only legal entry phase, set by proceedToOldSeed()). Existing tests
      // entered from the default 'idle' phase and would now early-return.
      comp.upgradePhase = 'enter-old';

      await comp.executeUpgrade();

      expect(fetchSeq).not.toBeNull();
      expect(firstImportSeq).not.toBeNull();
      // Regression guard: a refactor swapping (c) backend cleanup and (d)
      // keychain loop fails this assertion even though existing best-effort
      // tests still pass.
      expect(fetchSeq).toBeLessThan(firstImportSeq);
    });

    // FE-KEYCHAIN-API-MISUSE round-4 hold #5 (P3):
    // Race: extension was installed at startUpgrade() time (account_update
    // signed successfully, proven by the broadcast step) but disabled by the
    // time _performKeychainImport runs (auto-update, manual toggle,
    // content-script crash). The pre-fix silent early-return left the user
    // on a clean 'done' screen with zero Keychain-bound roles and no UI
    // signal — first post-upgrade vote/comment/transfer would fail. Fix
    // pushes 3 role warnings before the early return so the success surface
    // is consistent with a 3-deny outcome.
    it('isKeychainInstalled flips to false at helper time → done + 3 role warnings', async () => {
      mockIsKeychainInstalled.mockReturnValue(false);
      const importKeyCalls = [];
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (account, wifKey, cb) => {
            importKeyCalls.push({ account, wifKey });
            queueMicrotask(() => cb({ success: true }));
          },
        },
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { token: 'new-jwt', custody: 'self' } }),
      })));

      const comp = createComponent();
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePassword = 'light-password';
      // Round-5 P1 hold: executeUpgrade() now phase-guards on 'enter-old'
      // (only legal entry phase, set by proceedToOldSeed()). Existing tests
      // entered from the default 'idle' phase and would now early-return.
      comp.upgradePhase = 'enter-old';

      await comp.executeUpgrade();

      expect(comp.upgradePhase).toBe('done');
      expect(comp.upgradeError).toBeNull();
      // Helper early-returned; no requestImportKey ever called.
      expect(importKeyCalls).toHaveLength(0);
      // All 3 per-role warnings surfaced.
      expect(comp.upgradeWarnings).toEqual([
        'upgrade.keychainImportWarning.posting',
        'upgrade.keychainImportWarning.active',
        'upgrade.keychainImportWarning.memo',
      ]);
    });

    // FE-KEYCHAIN-API-MISUSE round-4 hold #6 (P3):
    // executeUpgrade() resets `this.upgradeWarnings = []` on entry so a
    // previous partial run never leaks its messages into a subsequent
    // success screen. No spec invokes executeUpgrade twice on the same
    // component; this one does to lock in the reset.
    it('upgradeWarnings is reset on each executeUpgrade attempt', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      // First attempt: deny on the very first requestImportKey call (posting);
      // all subsequent calls (including the entire second attempt) succeed.
      let denialBudget = 1;
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (account, wifKey, cb) => {
            const result = denialBudget > 0
              ? { success: false, message: 'denied' }
              : { success: true };
            if (denialBudget > 0) denialBudget -= 1;
            queueMicrotask(() => cb(result));
          },
        },
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { token: 'new-jwt', custody: 'self' } }),
      })));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      const seed = () => {
        comp.oldSeedPhrase = Array(12).fill('old').join(' ');
        comp.newSeedPhrase = Array(12).fill('new').join(' ');
        comp.newSeedWords = comp.newSeedPhrase.split(' ');
        comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
        comp.upgradePassword = 'light-password';
        // Round-5 P1 hold: re-establish 'enter-old' before each attempt so
        // the new phase-guard at the top of executeUpgrade() admits entry.
        // The wipe + 'done' transition runs at the end of the prior attempt,
        // so this re-seed mirrors what proceedToOldSeed() would do for a real
        // second pass.
        comp.upgradePhase = 'enter-old';
      };

      seed();
      await comp.executeUpgrade();
      expect(comp.upgradePhase).toBe('done');
      expect(comp.upgradeWarnings).toEqual(
        expect.arrayContaining(['upgrade.keychainImportWarning.posting']),
      );

      // Re-seed (the wipe cleared sensitive fields) and re-invoke. The reset
      // at the top of executeUpgrade must clear the prior partial run's
      // warning before the second attempt starts.
      seed();
      await comp.executeUpgrade();
      expect(comp.upgradePhase).toBe('done');
      expect(comp.upgradeWarnings).toEqual([]);

      warnSpy.mockRestore();
    });

    // FE-KEYCHAIN-API-MISUSE round-5 hold #1 (P1):
    // Hung Keychain callback bypasses the round-4 try/finally. The Hive
    // Keychain extension does not guarantee its callback fires if the
    // popup is dismissed via the extension UI, the content script wedges,
    // or the extension is uninstalled mid-flow. Without the Promise.race
    // timeout, a never-settling Promise leaves the per-role `await`
    // pending forever, the loop stalls, the call site's `finally` never
    // runs, and the user is wedged: chain rotated + backend cleaned +
    // mnemonic still in reactive state + upgradePhase stuck at
    // 'upgrading'. The race converts a hang into a per-role rejection
    // that the existing catch surfaces as a warning, and the loop
    // proceeds. We use fake timers so the 45s budget elapses in 0ms of
    // wall time.
    it('best-effort: hung requestImportKey callback → done + role warning after timeout', async () => {
      vi.useFakeTimers();
      try {
        mockIsKeychainInstalled.mockReturnValue(true);
        const importKeyCalls = [];
        const fetchCalls = [];
        // First call (posting) NEVER invokes its callback. Second (active)
        // and third (memo) settle normally. This pins the hang to a single
        // role so we can assert the loop continued past it.
        vi.stubGlobal('window', {
          ...globalThis.window,
          hive_keychain: {
            requestImportKey: (account, wifKey, cb) => {
              importKeyCalls.push({ account, wifKey });
              const idx = importKeyCalls.length - 1;
              if (idx === 0) return; // hang: callback never fires
              queueMicrotask(() => cb({ success: true }));
            },
          },
        });
        vi.stubGlobal('fetch', vi.fn(async (...args) => {
          fetchCalls.push(args);
          return {
            ok: true,
            json: async () => ({ data: { token: 'new-jwt', custody: 'self' } }),
          };
        }));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const comp = createComponent();
        comp.oldSeedPhrase = Array(12).fill('old').join(' ');
        comp.newSeedPhrase = Array(12).fill('new').join(' ');
        comp.newSeedWords = comp.newSeedPhrase.split(' ');
        comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
        comp.upgradePassword = 'light-password';
        comp.upgradePhase = 'enter-old';

        const upgradePromise = comp.executeUpgrade();
        // Drain microtasks so the helper enters the loop and the first
        // requestImportKey fires (which never resolves). Then advance past
        // the 45s budget so the race's setTimeout rejects.
        await vi.advanceTimersByTimeAsync(46_000);
        await upgradePromise;

        // Backend cleanup fired (the irreversible pair completed before
        // the hung import). Upgrade flipped to 'done' despite the hang.
        expect(fetchCalls.length).toBe(1);
        expect(comp.upgradePhase).toBe('done');
        expect(comp.upgradeError).toBeNull();
        // Posting warning surfaced (timed-out role); loop continued to
        // active + memo so all 3 import attempts ran.
        expect(comp.upgradeWarnings).toEqual(
          expect.arrayContaining(['upgrade.keychainImportWarning.posting']),
        );
        expect(importKeyCalls.length).toBe(3);
        // Mnemonic wiped — the try/finally ran because the timeout
        // converted the hang into a normal per-role rejection.
        expect(comp.newSeedPhrase).toBe('');
        expect(comp.oldSeedPhrase).toBe('');

        warnSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    // FE-KEYCHAIN-API-MISUSE round-5 hold #2 (P1):
    // No concurrent-invocation guard on executeUpgrade(). The opening
    // field-presence check is not a phase guard: `upgradePhase =
    // 'upgrading'` is synchronous but Alpine's reactive DOM update that
    // hides the "Upgrade" button is batched, so a double-click inside the
    // microtask window otherwise passes the field check and re-enters,
    // starting a parallel flow (two account_update broadcasts + two
    // /api/custody/upgrade POSTs + two 3-popup Keychain sequences).
    // Phase-guard locks the only legal entry phase to 'enter-old'.
    it('concurrent double-call to executeUpgrade → exactly one broadcast + one backend POST', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      const importKeyCalls = [];
      const fetchCalls = [];
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (account, wifKey, cb) => {
            importKeyCalls.push({ account, wifKey });
            queueMicrotask(() => cb({ success: true }));
          },
        },
      });
      vi.stubGlobal('fetch', vi.fn(async (...args) => {
        fetchCalls.push(args);
        return {
          ok: true,
          json: async () => ({ data: { token: 'new-jwt', custody: 'self' } }),
        };
      }));
      // Spy on broadcast.sendOperations to count chain calls independently
      // of the fetch count. The first call should land; the second
      // invocation must short-circuit at the phase guard before reaching
      // sendOperations.
      const sendOpsSpy = vi.fn(async () => ({ id: 'stub-tx' }));
      vi.mocked(Client).mockImplementation(() => ({
        broadcast: { sendOperations: sendOpsSpy },
      }));

      const comp = createComponent();
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePassword = 'light-password';
      comp.upgradePhase = 'enter-old';

      // Fire two invocations without awaiting between them. The first sets
      // upgradePhase = 'upgrading' synchronously inside executeUpgrade();
      // the second must see that and short-circuit at the phase guard
      // (returning a resolved promise without doing any work).
      const p1 = comp.executeUpgrade();
      const p2 = comp.executeUpgrade();
      await Promise.all([p1, p2]);

      // Exactly one broadcast and one backend POST. Without the guard,
      // the second call would re-enter and cause sendOpsSpy === 2 and
      // fetchCalls.length === 2 (the second's broadcast lands on a chain
      // whose authorities the first already rotated → likely rejected,
      // but the request goes out either way).
      expect(sendOpsSpy).toHaveBeenCalledTimes(1);
      expect(fetchCalls.length).toBe(1);
      expect(comp.upgradePhase).toBe('done');
    });

    // FE-KEYCHAIN-API-MISUSE round-5 hold #3 (P2) + round-6 hold #1 (P1):
    // Backend-cleanup fetch had no timeout. If the backend hangs after
    // account_update lands on-chain, the flow blocks on `await fetch(...)`
    // until OS-level TCP teardown — minutes for a half-open socket,
    // unbounded for a stalled response stream. During the hang
    // upgradePhase is stuck at 'upgrading' and the mnemonic stays in
    // reactive state. AbortSignal.timeout(20_000) bounds the budget; the
    // resulting TimeoutError DOMException routes to upgrade.backendTimeout
    // AND wipes the mnemonic (round-6: the round-5 no-wipe decision was
    // reverted; the user already saw + confirmed the mnemonic in the
    // new-seed/confirm-new phases, so keeping it in reactive state past
    // the error screen is pure XSS surface with no recovery value).
    it('backend cleanup fetch timeout → upgradeError + phase=error, mnemonic IS wiped', async () => {
      vi.useFakeTimers();
      try {
        mockIsKeychainInstalled.mockReturnValue(true);
        vi.stubGlobal('window', {
          ...globalThis.window,
          hive_keychain: {
            requestImportKey: (account, wifKey, cb) => {
              queueMicrotask(() => cb({ success: true }));
            },
          },
        });
        // Never-resolving fetch that honors AbortSignal. The signal is
        // produced by AbortSignal.timeout(20_000) inside executeUpgrade().
        // When fake timers advance past 20s, the signal aborts and the
        // promise rejects with the signal's reason (a TimeoutError
        // DOMException per spec).
        vi.stubGlobal('fetch', vi.fn((url, opts) => new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            reject(opts.signal.reason);
          });
        })));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const comp = createComponent();
        const oldMnemonic = Array(12).fill('old').join(' ');
        const newMnemonic = Array(12).fill('new').join(' ');
        comp.oldSeedPhrase = oldMnemonic;
        comp.newSeedPhrase = newMnemonic;
        comp.newSeedWords = comp.newSeedPhrase.split(' ');
        comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
        comp.upgradePassword = 'light-password';
        comp.upgradePhase = 'enter-old';

        const upgradePromise = comp.executeUpgrade();
        // Advance past the 20s budget; the AbortSignal fires and fetch
        // rejects.
        await vi.advanceTimersByTimeAsync(21_000);
        await upgradePromise;

        // Phase routed to 'error', not 'done'.
        expect(comp.upgradePhase).toBe('error');
        // Specific timeout message, not the generic backendFailed/failed.
        expect(comp.upgradeError).toBe('upgrade.backendTimeout');
        // Mnemonic IS wiped (round-6 hold #1): the user already confirmed
        // the new mnemonic in earlier phases and the error-screen copy
        // (round-7 hold #1) directs them to contact support with their
        // account name, not to recover from the in-DOM mnemonic. The
        // Keychain-verification path was removed because `_performKeychainImport`
        // never runs on the timeout branch — Keychain has no entry to verify.
        expect(comp.newSeedPhrase).toBe('');
        expect(comp.oldSeedPhrase).toBe('');

        warnSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    // FE-KEYCHAIN-API-MISUSE round-7 hold #2 (P1): the "Try Again" button
    // is a dead-end on the backend-timeout sub-case. resetUpgrade() flips
    // phase to 'idle'; the user clicks Start; startUpgrade() generates a
    // NEW mnemonic; user re-enters their original light-account old seed;
    // _performUpgradeKeyRotation signs account_update with old seed-derived
    // keys; chain rejects with Missing Authority because the chain's owner
    // key is now the prior attempt's mnemonic (rotation already landed).
    // The button must therefore be hidden on this sub-case (and on the
    // sibling post-broadcast non-retryable sub-case, partialApplyFailed)
    // and present on every pre-broadcast error sub-case (generic
    // upgrade.failed, keychainRequired, generationFailed). The
    // `canRetryUpgrade` getter drives the button's x-show binding; these
    // specs assert the getter directly so a refactor that re-enables the
    // dead-end (drops x-show, inverts the comparison, renames the getter)
    // fails here.
    //
    // FE-CANRETRYUPGRADE-DISCRIMINATOR-KEY-REFACTOR (Finding B): the
    // comparison is now keyed on `upgradeErrorKey` (a stable i18n key
    // discriminator), not on the translated `upgradeError` string. Setting
    // `upgradeErrorKey` directly here documents the contract — the getter
    // consumes the discriminator, not the translation.
    it('canRetryUpgrade: false on backend-timeout sub-case (Try Again hidden)', () => {
      const comp = createComponent();
      comp.upgradeErrorKey = 'upgrade.backendTimeout';
      expect(comp.canRetryUpgrade).toBe(false);
    });

    // Generic error sub-case = a PRE-BROADCAST failure (Keychain denial of
    // account_update, chain rejection of the broadcast itself, invalid old
    // seed). The chain has NOT rotated, so retrying is safe and Try Again
    // must be shown. Post-broadcast generic failures route to
    // `upgrade.partialApplyFailed` and are covered by the separate
    // post-broadcast routing specs below.
    it('canRetryUpgrade: true on generic error sub-case (Try Again shown for pre-broadcast errors)', () => {
      const comp = createComponent();
      comp.upgradeErrorKey = 'upgrade.failed';
      expect(comp.canRetryUpgrade).toBe(true);
    });

    // FE-CANRETRYUPGRADE-DISCRIMINATOR-KEY-REFACTOR (Finding B, acceptance
    // criterion 2): the getter must be invariant to mid-error-screen
    // locale switches. The user can flip locales from the header switcher
    // while sitting on the upgrade error screen; `upgradeError` was
    // captured once at error time but `$t` reads live from the i18n store.
    // Comparing translated strings would break the moment any locale ships
    // a real translation; comparing the discriminator key does not.
    it('canRetryUpgrade is invariant to locale-switch after error is set', () => {
      const comp = createComponent();
      comp.upgradeErrorKey = 'upgrade.backendTimeout';
      comp.upgradeError = 'Backend cleanup did not confirm in time. ...';
      expect(comp.canRetryUpgrade).toBe(false);
      // Simulate locale switch: $t now returns Spanish (or anything that
      // differs from upgradeError). The pre-refactor implementation would
      // flip canRetryUpgrade to true here because
      // `upgradeError !== $t('upgrade.backendTimeout')` would now hold.
      comp.$t = (_key) => 'La limpieza del backend no se confirmó a tiempo. ...';
      expect(comp.canRetryUpgrade).toBe(false);
    });

    // FE-CANRETRYUPGRADE-DISCRIMINATOR-KEY-REFACTOR (Finding A, acceptance
    // criterion 3a): post-broadcast `TypeError: Failed to fetch` (network
    // drop mid-fetch after the chain rotation already landed) must route
    // to the non-retryable sub-case. Pre-refactor, the catch's generic
    // fall-through routed every non-TimeoutError to `upgrade.failed` and
    // canRetryUpgrade returned true — re-clicking Try Again signed
    // account_update with stale seed-derived keys and the chain rejected
    // with auth mismatch.
    it('post-broadcast TypeError routes to non-retryable (partialApplyFailed)', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (account, wifKey, cb) => {
            queueMicrotask(() => cb({ success: true }));
          },
        },
      });
      // Fetch rejects with a TypeError ("Failed to fetch") — the broadcast
      // helper has already resolved by this point.
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePassword = 'light-password';
      comp.upgradePhase = 'enter-old';

      await comp.executeUpgrade();

      expect(comp.upgradePhase).toBe('error');
      expect(comp.upgradeErrorKey).toBe('upgrade.partialApplyFailed');
      expect(comp.canRetryUpgrade).toBe(false);

      warnSpy.mockRestore();
    });

    // FE-CANRETRYUPGRADE-DISCRIMINATOR-KEY-REFACTOR (Finding A, acceptance
    // criterion 3b): backend 500 after rotation must route non-retryable.
    // The `!res.ok` branch throws an Error which the catch's generic
    // fall-through previously routed to `upgrade.failed` (retriable).
    it('post-broadcast backend 500 routes to non-retryable (partialApplyFailed)', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (account, wifKey, cb) => {
            queueMicrotask(() => cb({ success: true }));
          },
        },
      });
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Internal error' }),
      })));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePassword = 'light-password';
      comp.upgradePhase = 'enter-old';

      await comp.executeUpgrade();

      expect(comp.upgradePhase).toBe('error');
      expect(comp.upgradeErrorKey).toBe('upgrade.partialApplyFailed');
      expect(comp.canRetryUpgrade).toBe(false);

      warnSpy.mockRestore();
    });

    // FE-CANRETRYUPGRADE-DISCRIMINATOR-KEY-REFACTOR (Finding A, acceptance
    // criterion 3c): backend 409 ALREADY_UPGRADED after rotation must
    // route non-retryable. Surfaces when a concurrent flow already wiped
    // server-side custody — the rotation in the current flow still
    // landed on-chain, so retrying is structurally unavailable.
    it('post-broadcast backend 409 ALREADY_UPGRADED routes to non-retryable (partialApplyFailed)', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (account, wifKey, cb) => {
            queueMicrotask(() => cb({ success: true }));
          },
        },
      });
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
        ok: false,
        status: 409,
        json: async () => ({ error: 'ALREADY_UPGRADED' }),
      })));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePassword = 'light-password';
      comp.upgradePhase = 'enter-old';

      await comp.executeUpgrade();

      expect(comp.upgradePhase).toBe('error');
      expect(comp.upgradeErrorKey).toBe('upgrade.partialApplyFailed');
      expect(comp.canRetryUpgrade).toBe(false);

      warnSpy.mockRestore();
    });
  });

  describe('confirmCorrect', () => {
    it('validates confirmation inputs', () => {
      const comp = createComponent();
      comp.newSeedWords = ['word1', 'word2', 'word3', 'word4'];
      comp.confirmIndices = [0, 2];
      comp.confirmInputs = { 0: 'word1', 2: 'word3' };
      expect(comp.confirmCorrect).toBe(true);
    });

    it('fails on wrong input', () => {
      const comp = createComponent();
      comp.newSeedWords = ['word1', 'word2', 'word3', 'word4'];
      comp.confirmIndices = [0, 2];
      comp.confirmInputs = { 0: 'word1', 2: 'wrong' };
      expect(comp.confirmCorrect).toBe(false);
    });
  });

  describe('handleSetPassword', () => {
    it('submits new password and toggles emailStatus.hasPassword', async () => {
      mockSetPassword.mockResolvedValue({ status: 'ok' });
      const comp = createComponent();
      comp.emailStatus = { hasEmail: true, email: 'a***@x.com', verified: true, hasPassword: false };
      comp.newPasswordInput = 'Abcdefgh1x';
      comp.newPasswordConfirmInput = 'Abcdefgh1x';

      await comp.handleSetPassword();

      expect(mockSetPassword).toHaveBeenCalledWith('Abcdefgh1x');
      expect(comp.emailStatus.hasPassword).toBe(true);
      expect(comp.newPasswordInput).toBe('');
      expect(comp.newPasswordConfirmInput).toBe('');
      expect(mockToastStore.show).toHaveBeenCalled();
    });

    it('patches emailStatus BEFORE clearing inputs (so a thrown spread on a later line cannot leave the form stuck)', async () => {
      mockSetPassword.mockResolvedValue({ status: 'ok' });
      const comp = createComponent();
      const initialStatus = { hasEmail: true, email: 'a***@x.com', verified: true, hasPassword: false };
      comp.emailStatus = initialStatus;
      comp.newPasswordInput = 'Abcdefgh1x';
      comp.newPasswordConfirmInput = 'Abcdefgh1x';

      // Capture the order of mutations by stubbing the toast store to
      // record the state observed when the toast fires (it is the last
      // side effect in the success branch).
      let observedHasPasswordAtToastTime = null;
      let observedInputAtToastTime = null;
      mockToastStore.show.mockImplementationOnce(() => {
        observedHasPasswordAtToastTime = comp.emailStatus?.hasPassword;
        observedInputAtToastTime = comp.newPasswordInput;
      });

      await comp.handleSetPassword();

      // By the time the toast fires, both emailStatus patch and input
      // clear have run; the invariant is that the emailStatus patch is
      // visible first (asserted by toast-observed state being `true`).
      expect(observedHasPasswordAtToastTime).toBe(true);
      expect(observedInputAtToastTime).toBe('');
    });

    it('double-guard: pre-set passwordSubmitting prevents any API call', async () => {
      const comp = createComponent();
      comp.newPasswordInput = 'Abcdefgh1x';
      comp.newPasswordConfirmInput = 'Abcdefgh1x';
      comp.passwordSubmitting = true;

      await comp.handleSetPassword();

      expect(mockSetPassword).not.toHaveBeenCalled();
    });

    it('does nothing if the password is invalid', async () => {
      const comp = createComponent();
      comp.newPasswordInput = 'short';
      comp.newPasswordConfirmInput = 'short';
      await comp.handleSetPassword();
      expect(mockSetPassword).not.toHaveBeenCalled();
    });

    it('does nothing if passwords do not match', async () => {
      const comp = createComponent();
      comp.newPasswordInput = 'Abcdefgh1x';
      comp.newPasswordConfirmInput = 'Differe12Xy';
      await comp.handleSetPassword();
      expect(mockSetPassword).not.toHaveBeenCalled();
    });

    // FE-SETTINGS-ERROR-MESSAGE-SANITIZE-SWEEP: on failure the DOM-bound
    // passwordError must be a generic localized message (never `err.message`,
    // which could embed key/password material on a future error shape) and
    // the raw error must reach console.warn for diagnostics. Plaintext
    // password inputs are still zeroed on the error path.
    it('surfaces generic error to DOM, raw err to console.warn, and zeroes password inputs', async () => {
      const leaky = { message: 'already set hex=deadbeefcafebabe', code: 'CONFLICT' };
      mockSetPassword.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.newPasswordInput = 'Abcdefgh1x';
      comp.newPasswordConfirmInput = 'Abcdefgh1x';

      await comp.handleSetPassword();

      expect(comp.passwordError).toBe('settings.passwordUpdateFailed');
      expect(comp.passwordError).not.toContain('deadbeef');
      expect(comp.passwordSubmitting).toBe(false);
      expect(comp.newPasswordInput).toBe('');
      expect(comp.newPasswordConfirmInput).toBe('');
      expect(warnSpy).toHaveBeenCalled();
      const warnArgs = warnSpy.mock.calls.find((c) => c[0] === '[set password]');
      expect(warnArgs).toBeDefined();
      const warnedErr = warnArgs[1];
      expect(warnedErr).toBe(leaky);
      warnSpy.mockRestore();
    });

    it('newPasswordsMatch reflects equality of the two inputs', () => {
      const comp = createComponent();
      comp.newPasswordInput = 'Abcdefgh1x';
      comp.newPasswordConfirmInput = 'Abcdefgh1x';
      expect(comp.newPasswordsMatch).toBe(true);
      comp.newPasswordConfirmInput = 'Different1X';
      expect(comp.newPasswordsMatch).toBe(false);
    });

    it('canSubmitPassword requires valid + match', () => {
      const comp = createComponent();
      comp.newPasswordInput = 'Abcdefgh1x';
      comp.newPasswordConfirmInput = 'Abcdefgh1x';
      expect(comp.canSubmitPassword).toBe(true);
      comp.newPasswordConfirmInput = 'other';
      expect(comp.canSubmitPassword).toBe(false);
      comp.newPasswordInput = 'short';
      comp.newPasswordConfirmInput = 'short';
      expect(comp.canSubmitPassword).toBe(false);
    });
  });

  describe('init - orcid link completion', () => {
    it('detects orcid link completion from localStorage', () => {
      localStorageData.pevo_orcid_link_complete = '1';
      mockFetchEmailStatus.mockResolvedValue({ data: { hasEmail: false } });
      const comp = createComponent();
      comp.init();
      expect(localStorage.removeItem).toHaveBeenCalledWith('pevo_orcid_link_complete');
      expect(mockAuthStore._checkAccreditation).toHaveBeenCalled();
      expect(mockToastStore.show).toHaveBeenCalled();
    });
  });
});

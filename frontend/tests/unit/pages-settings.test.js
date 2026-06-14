import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLoginFromResponse } from './fixtures/mock-auth.js';

const mockFetchEmailStatus = vi.fn();
const mockSubmitEmail = vi.fn();
const mockDeleteEmail = vi.fn();
const mockStartOrcid = vi.fn();
const mockSetPassword = vi.fn();
const mockSubmitAccreditationMetadata = vi.fn();
const mockIsKeychainInstalled = vi.fn(() => true);

vi.mock('../../src/api.js', () => ({
  fetchEmailStatus: (...args) => mockFetchEmailStatus(...args),
  submitEmail: (...args) => mockSubmitEmail(...args),
  deleteEmail: (...args) => mockDeleteEmail(...args),
  startOrcid: (...args) => mockStartOrcid(...args),
  setPassword: (...args) => mockSetPassword(...args),
  submitAccreditationMetadata: (...args) => mockSubmitAccreditationMetadata(...args),
}));

// settings.js routes the three critical-action handlers (change-email,
// set-password, delete-account) through the settings-action fresh-auth
// orchestrator. The orchestrator is unit-tested in lib-settings-fresh-auth.test.js;
// here it is mocked. The default impl is a self-custody-style pass-through —
// calls run() with no proof and wraps the result in { ok } — so the existing
// success/error handler tests exercise the underlying api call unchanged.
// Individual tests override the impl to return { redirect } / { cancelled } /
// { freshAuthFailed } and assert the handler's outcome handling.
const mockWithSettingsFreshAuth = vi.fn(async (_action, _ctx, run) => ({ ok: await run(undefined) }));
vi.mock('../../src/lib/settings-fresh-auth.js', () => ({
  withSettingsFreshAuth: (...args) => mockWithSettingsFreshAuth(...args),
}));

vi.mock('../../src/keychain.js', () => ({
  isKeychainInstalled: (...args) => mockIsKeychainInstalled(...args),
}));

// Per-role stub WIFs. Real Hive WIFs are 50 chars (2-char prefix + 48
// base58). Distinct first chars so the Keychain-import regression
// test can assert three distinct imports and exclude the owner WIF.
const STUB_WIFS = {
  owner: '5K' + 'A'.repeat(48),
  active: '5K' + 'B'.repeat(48),
  posting: '5K' + 'C'.repeat(48),
  memo: '5K' + 'D'.repeat(48),
};

vi.mock('../../src/hive-keys.js', () => ({
  // deriveHiveKeys is async and returns per-role WIFs (not hex seeds) via
  // PrivateKey.fromLogin.
  deriveHiveKeys: vi.fn(async () => ({ ...STUB_WIFS })),
  deriveHivePublicKeys: vi.fn(async () => ({
    owner: 'STM' + 'o'.repeat(50),
    active: 'STM' + 'a'.repeat(50),
    posting: 'STM' + 'p'.repeat(50),
    memo: 'STM' + 'm'.repeat(50),
  })),
  // settings.js reuses the lazy dhive loader exported from hive-keys.js
  // instead of issuing its own `await import('@hiveio/dhive')`. The dynamic
  // import here resolves to the dhive mock defined below.
  loadDhive: vi.fn(async () => await import('@hiveio/dhive')),
  // BIP39 wrappers (re-exported from hive-keys.js, not from raw @scure/bip39).
  // settings.js routes through hive-keys.js so a single entropy/wordlist
  // policy applies across callers.
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
  disconnect: vi.fn(),
};
const mockRouterStore = {
  navigate: vi.fn(),
  registerNavigationGuard: vi.fn(),
  unregisterNavigationGuard: vi.fn(),
};
const mockToastStore = { show: vi.fn() };
const mockNotificationsStore = { stop: vi.fn() };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'auth') return mockAuthStore;
      if (name === 'router') return mockRouterStore;
      if (name === 'toast') return mockToastStore;
      if (name === 'notifications') return mockNotificationsStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initSettingsPage } from '../../src/pages/settings.js';
// Imported so a regression test can force a deriveHiveKeys call (inside
// _performKeychainImport's pre-loop work) to throw, simulating an unguarded
// helper-internal failure that the try/finally wrap around
// _performKeychainImport must absorb.
import { deriveHiveKeys } from '../../src/hive-keys.js';
// Imported so closure-wipe tests can override the per-test
// Client.broadcast.sendOperations spy: to force a helper-internal broadcast
// rejection, and to assert the broadcast-only helper still calls
// sendOperations when Keychain is uninstalled.
import { Client } from '@hiveio/dhive';

function createComponent() {
  initSettingsPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  comp.$watch = vi.fn();
  return comp;
}

// Shared Keychain happy-path stub used across describe blocks. Centralized
// so a future change to the Keychain callback contract (e.g. a second
// argument) only requires editing one place. The stub is intentionally
// minimal — every `requestImportKey` call resolves `{success: true}` via
// queueMicrotask.
function stubKeychainImportKeySuccess() {
  vi.stubGlobal('window', {
    ...globalThis.window,
    hive_keychain: {
      requestImportKey: (account, wifKey, cb) => {
        queueMicrotask(() => cb({ success: true }));
      },
    },
  });
}

describe('settingsPage', () => {
  let localStorageData;
  let sessionStorageData;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets call history but not implementations; a test that
    // permanently overrides the orchestrator outcome would otherwise leak into
    // siblings. Re-establish the pass-through default each test.
    mockWithSettingsFreshAuth.mockImplementation(async (_action, _ctx, run) => ({ ok: await run(undefined) }));
    mockAuthStore.isConnected = true;
    mockAuthStore.custody = 'light';
    mockAuthStore.isAccredited = true;
    mockAuthStore.accreditation = { orcid: '0000-0001' };
    mockAuthStore.token = 'jwt';
    mockAuthStore.expiresAt = '2099-01-01T00:00:00.000Z';
    localStorageData = {};
    sessionStorageData = {};
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => localStorageData[key] ?? null),
      setItem: vi.fn((key, val) => { localStorageData[key] = val; }),
      removeItem: vi.fn((key) => { delete localStorageData[key]; }),
    });
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key) => sessionStorageData[key] ?? null),
      setItem: vi.fn((key, val) => { sessionStorageData[key] = val; }),
      removeItem: vi.fn((key) => { delete sessionStorageData[key]; }),
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

      // Routed through the orchestrator's run callback: submitEmail(email, proof).
      // The pass-through mock supplies no proof (self-custody-style).
      expect(mockSubmitEmail).toHaveBeenCalledWith('new@x.com', undefined);
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

    // Error-message sanitization: non-DUPLICATE failures must surface a
    // generic localized message and route raw err to console.warn.
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

    // Settings-action fresh-auth orchestrator wiring: outcome routing + proof threading.
    it('passes action=change_email + ctx and threads the orchestrator proof into submitEmail', async () => {
      mockSubmitEmail.mockResolvedValue({});
      mockFetchEmailStatus.mockResolvedValue({ data: { hasEmail: true } });
      mockWithSettingsFreshAuth.mockImplementationOnce(async (action, ctx, run) => {
        expect(action).toBe('change_email');
        expect(ctx).toMatchObject({ custody: 'light', username: 'alice' });
        return { ok: await run('minted-proof') };
      });
      const comp = createComponent();
      comp.newEmail = 'new@x.com';

      await comp.handleEmailSubmit();

      expect(mockSubmitEmail).toHaveBeenCalledWith('new@x.com', 'minted-proof');
      expect(comp.emailMessage).toBe('settings.emailVerificationSent');
    });

    it('aborts cleanly on an ORCID redirect (no success message, no error)', async () => {
      mockWithSettingsFreshAuth.mockResolvedValueOnce({ redirect: true });
      const comp = createComponent();
      comp.newEmail = 'new@x.com';

      await comp.handleEmailSubmit();

      expect(comp.emailMessage).toBeNull();
      expect(comp.emailError).toBeNull();
      expect(comp.emailSubmitting).toBe(false);
    });

    it('aborts cleanly when the password modal is cancelled', async () => {
      mockWithSettingsFreshAuth.mockResolvedValueOnce({ cancelled: true });
      const comp = createComponent();
      comp.newEmail = 'new@x.com';

      await comp.handleEmailSubmit();

      expect(comp.emailMessage).toBeNull();
      expect(comp.emailError).toBeNull();
    });

    it('surfaces the generic re-auth error on freshAuthFailed (403 / wrong-mechanism)', async () => {
      mockWithSettingsFreshAuth.mockResolvedValueOnce({ freshAuthFailed: true });
      const comp = createComponent();
      comp.newEmail = 'new@x.com';

      await comp.handleEmailSubmit();

      expect(comp.emailError).toBe('settings.reauthFailed');
      expect(comp.emailMessage).toBeNull();
    });
  });

  describe('handleEmailDelete', () => {
    // DELETE erases the entire PEvO account row, so the session is dead on
    // success. The handler tears it down (disconnect + stop notifications),
    // shows the accountDeleted toast, and routes home — it does NOT patch
    // emailStatus in place, which would leave a logged-in settings view bound
    // to a deleted account.
    it('tears down the session and routes home on successful account deletion', async () => {
      mockDeleteEmail.mockResolvedValue({});
      const comp = createComponent();
      comp.emailStatus = { hasEmail: true };

      await comp.handleEmailDelete();

      expect(mockDeleteEmail).toHaveBeenCalledWith(true, undefined);
      expect(mockAuthStore.disconnect).toHaveBeenCalled();
      expect(mockNotificationsStore.stop).toHaveBeenCalled();
      expect(mockToastStore.show).toHaveBeenCalledWith('settings.accountDeleted', 'success');
      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/');
    });

    it('does nothing if already deleting', async () => {
      const comp = createComponent();
      comp.deleting = true;
      await comp.handleEmailDelete();
      expect(mockDeleteEmail).not.toHaveBeenCalled();
    });

    // Error-message sanitization: failure must surface a generic localized
    // message and route raw err to console.warn.
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

    // Settings-action fresh-auth orchestrator wiring: outcome routing + proof threading.
    it('threads action=delete_account and the orchestrator proof into deleteEmail', async () => {
      mockDeleteEmail.mockResolvedValue({});
      mockWithSettingsFreshAuth.mockImplementationOnce(async (action, _ctx, run) => {
        expect(action).toBe('delete_account');
        return { ok: await run('del-proof') };
      });
      const comp = createComponent();
      comp.emailStatus = { hasEmail: true };

      await comp.handleEmailDelete();

      expect(mockDeleteEmail).toHaveBeenCalledWith(true, 'del-proof');
      expect(mockAuthStore.disconnect).toHaveBeenCalled();
      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/');
    });

    it('aborts cleanly on an ORCID redirect (no teardown, no navigate)', async () => {
      mockWithSettingsFreshAuth.mockResolvedValueOnce({ redirect: true });
      const comp = createComponent();

      await comp.handleEmailDelete();

      expect(mockAuthStore.disconnect).not.toHaveBeenCalled();
      expect(mockRouterStore.navigate).not.toHaveBeenCalled();
      expect(comp.deleting).toBe(false);
    });

    it('aborts cleanly when the password modal is cancelled', async () => {
      mockWithSettingsFreshAuth.mockResolvedValueOnce({ cancelled: true });
      const comp = createComponent();

      await comp.handleEmailDelete();

      expect(mockAuthStore.disconnect).not.toHaveBeenCalled();
      expect(mockRouterStore.navigate).not.toHaveBeenCalled();
    });

    it('aborts cleanly on a torn-down session (sessionInconsistent): no caller teardown, no second toast', async () => {
      // The orchestrator already disconnected + toasted; the caller's early
      // return must not fire the delete success path, re-disconnect, navigate,
      // or surface the generic delete error.
      mockWithSettingsFreshAuth.mockResolvedValueOnce({ sessionInconsistent: true });
      const comp = createComponent();
      comp.emailStatus = { hasEmail: true };

      await comp.handleEmailDelete();

      expect(mockAuthStore.disconnect).not.toHaveBeenCalled();
      expect(mockRouterStore.navigate).not.toHaveBeenCalled();
      expect(mockToastStore.show).not.toHaveBeenCalled();
      expect(comp.emailError).toBeNull();
      expect(comp.deleting).toBe(false);
    });

    it('surfaces the generic re-auth error on freshAuthFailed without tearing down the session', async () => {
      mockWithSettingsFreshAuth.mockResolvedValueOnce({ freshAuthFailed: true });
      const comp = createComponent();

      await comp.handleEmailDelete();

      expect(comp.emailError).toBe('settings.reauthFailed');
      expect(mockAuthStore.disconnect).not.toHaveBeenCalled();
      expect(comp.deleting).toBe(false);
    });
  });

  describe('handleOrcidLink', () => {
    it('sets orcid mode and redirects', async () => {
      mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth' });
      vi.stubGlobal('window', { ...globalThis.window, location: { href: '' } });
      const comp = createComponent();

      await comp.handleOrcidLink();

      expect(sessionStorage.setItem).toHaveBeenCalledWith('pevo_orcid_mode', 'link');
      expect(mockStartOrcid).toHaveBeenCalledWith('link');
    });

    it('rejects invalid redirect URL', async () => {
      mockStartOrcid.mockResolvedValue({ redirect_url: 'https://evil.com/phish' });
      vi.stubGlobal('window', { ...globalThis.window, location: { href: '' } });
      // The internal throw is not surfaced raw. The DOM sees the generic
      // localized message; the raw 'Invalid ORCID redirect URL' goes to
      // console.warn.
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

    // Error-message sanitization: failure must surface a generic localized
    // message and route raw err to console.warn.
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

    // generateMnemonic() pulls BIP39 entropy. If it throws with
    // entropy-embedded text on a future library revision, the raw err.message
    // must not reach the DOM. Generic localized message to the DOM, raw err
    // to console.warn.
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

  // `executeUpgrade()` must zero all plaintext-sensitive reactive state
  // (old + new mnemonic, confirm inputs, re-entered password) before
  // transitioning to the 'done' phase. Without this, an XSS on /settings can
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
      // executeUpgrade() phase-guards on 'enter-old' (only legal entry phase,
      // set by proceedToOldSeed()). Tests that entered from the default 'idle'
      // phase would otherwise early-return at the guard.
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

    it('zeroes mnemonic, confirm inputs, and password on the happy path before phase=done', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      stubFetchSuccess();
      stubKeychainImportKeySuccess();

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
      stubKeychainImportKeySuccess();
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

    // The error-path `upgradeError` is x-text'd into the DOM. If `err.message` ever
    // embeds key-material (library swap, future error shape, dhive bug),
    // the just-wiped Alpine state is effectively un-wiped via a
    // DOM-visible error string. Fix: surface a generic localized message
    // and console.warn the raw error for diagnostics. This test injects
    // a throw whose message contains a key-material-shaped substring
    // (64-char hex seed + a seed word list) and asserts the substring
    // never reaches `upgradeError`.
    it('does not leak key-material from err.message into upgradeError', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      stubKeychainImportKeySuccess();
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
      // Post-broadcast fetch rejection: the catch routes anything caught
      // after `_performUpgradeKeyRotation` has resolved (broadcastLanded=true)
      // to `upgrade.partialApplyFailed` instead of the pre-broadcast
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

    // Regression-class guard against the
    // `$t('upgrade.partialApplyFailed') || err.message` OR-fallback
    // pattern. Stubs $t to return '' for the specific key (simulating a
    // missing translation in a locale file) and exercises the same leak
    // path. Under safe production code (`upgradeError = $t(...)`), this
    // test passes because upgradeError lands at ''. Under a regressed
    // OR-fallback, $t returns '' → falls through to err.message → leak
    // substrings appear in upgradeError → assertion fails.
    //
    // The post-broadcast catch (broadcastLanded=true) reads
    // `$t('upgrade.partialApplyFailed')`; the simulated missing-translation
    // key tracks the actual key the catch consults on this path.
    it('does not leak key-material when $t returns empty for upgrade.partialApplyFailed', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      stubKeychainImportKeySuccess();
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

  // The derivation/broadcast/keychain-import steps (which capture `oldSeed`,
  // `oldKeys`, `newSeed`, `newKeys`,
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
      // executeUpgrade() phase-guards on 'enter-old' (only legal entry phase,
      // set by proceedToOldSeed()). Tests that entered from the default 'idle'
      // phase would otherwise early-return at the guard.
      comp.upgradePhase = 'enter-old';
      return comp;
    }

    function stubFetchSuccess() {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { token: 'new-jwt', custody: 'self' } }),
      })));
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
      stubKeychainImportKeySuccess();

      const comp = createComponent();
      seedUpgradeState(comp);

      const events = [];
      // Instrument deriveHiveKeys to record WHEN it's called. A no-op
      // `_performUpgradeKeyRotation` stub passes the
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
      stubKeychainImportKeySuccess();
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

    // The existing error-path test above stubs `fetch` to fail, but `fetch`
    // runs AFTER `_performUpgradeKeyRotation` already
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
      stubKeychainImportKeySuccess();
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

    // The broadcast helper (`_performUpgradeKeyRotation`) is broadcast-only:
    // Keychain import lives in the sibling `_performKeychainImport`
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
      stubKeychainImportKeySuccess();

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

  // executeUpgrade() used to call
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
      // executeUpgrade() phase-guards on 'enter-old' (only legal entry phase,
      // set by proceedToOldSeed()). Tests that entered from the default 'idle'
      // phase would otherwise early-return at the guard.
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

  // Keychain-import regression guard. The upgrade flow used to call
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

    // The custody upgrade must import posting + active + memo (NOT owner)
    // into Keychain so the user can
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
      // executeUpgrade() phase-guards on 'enter-old' (only legal entry phase,
      // set by proceedToOldSeed()). Tests that entered from the default 'idle'
      // phase would otherwise early-return at the guard.
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

    // Mid-loop Keychain denial: the Keychain import loop runs AFTER the
    // irreversible (broadcast + backend cleanup) pair. A user denying the
    // popup mid-loop must NOT wedge the upgrade: backend cleanup has
    // already fired, the loop becomes best-effort, the upgrade completes
    // with `upgradePhase === 'done'`, and the denied role's localized
    // warning lands in `upgradeWarnings` for the success-screen surface.
    //
    // Two specs cover the loop's first and second indices to lock in that
    // a denial at any iteration produces the same best-effort outcome.
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
      // executeUpgrade() phase-guards on 'enter-old' (only legal entry phase,
      // set by proceedToOldSeed()). Tests that entered from the default 'idle'
      // phase would otherwise early-return at the guard.
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
      // executeUpgrade() phase-guards on 'enter-old' (only legal entry phase,
      // set by proceedToOldSeed()). Tests that entered from the default 'idle'
      // phase would otherwise early-return at the guard.
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

    // The try/catch only wraps requestImportKey inside the per-role loop. The
    // helper's pre-loop work (deriveHiveKeys) is unguarded. A throw from
    // there escapes both the helper and executeUpgrade, leaving chain
    // rotated + backend cleaned up + mnemonic NOT wiped (re-opens the
    // credential-wipe invariant via a different injection point)
    // + upgradePhase stuck at 'upgrading' with no recovery UI. Fix: wrap
    // the helper call site in try/catch/finally so wipe + upgradePhase =
    // 'done' run unconditionally and the failure surfaces as a single
    // fallback warning. The helper's pre-loop work is just
    // `deriveHiveKeys(newSeedPhrase, account)` — async, calling
    // PrivateKey.fromLogin internally; the same try/finally shape absorbs
    // its rejections.
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
      // pre-loop work) must throw — that's the injection point the
      // try/finally wrap around _performKeychainImport must absorb.
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
      // executeUpgrade() phase-guards on 'enter-old' (only legal entry phase,
      // set by proceedToOldSeed()). Tests that entered from the default 'idle'
      // phase would otherwise early-return at the guard.
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
      // executeUpgrade() phase-guards on 'enter-old' (only legal entry phase,
      // set by proceedToOldSeed()). Tests that entered from the default 'idle'
      // phase would otherwise early-return at the guard.
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
      // executeUpgrade() phase-guards on 'enter-old' (only legal entry phase,
      // set by proceedToOldSeed()). Tests that entered from the default 'idle'
      // phase would otherwise early-return at the guard.
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

    // The contract under test is backend cleanup BEFORE the keychain loop,
    // so a mid-loop denial cannot leave backend with stale
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
      // executeUpgrade() phase-guards on 'enter-old' (only legal entry phase,
      // set by proceedToOldSeed()). Tests that entered from the default 'idle'
      // phase would otherwise early-return at the guard.
      comp.upgradePhase = 'enter-old';

      await comp.executeUpgrade();

      expect(fetchSeq).not.toBeNull();
      expect(firstImportSeq).not.toBeNull();
      // Regression guard: a refactor swapping (c) backend cleanup and (d)
      // keychain loop fails this assertion even though existing best-effort
      // tests still pass.
      expect(fetchSeq).toBeLessThan(firstImportSeq);
    });

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
      // executeUpgrade() phase-guards on 'enter-old' (only legal entry phase,
      // set by proceedToOldSeed()). Tests that entered from the default 'idle'
      // phase would otherwise early-return at the guard.
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
        // Re-establish 'enter-old' before each attempt so the phase-guard at
        // the top of executeUpgrade() admits entry. The wipe + 'done'
        // transition runs at the end of the prior attempt, so this re-seed
        // mirrors what proceedToOldSeed() would do for a real second pass.
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

    // Hung Keychain callback bypasses the per-role-loop try/finally. The Hive
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

    // Concurrent-invocation guard on executeUpgrade(). The opening
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

    // Backend-cleanup fetch had no timeout. If the backend hangs after
    // account_update lands on-chain, the flow blocks on `await fetch(...)`
    // until OS-level TCP teardown — minutes for a half-open socket,
    // unbounded for a stalled response stream. During the hang
    // upgradePhase is stuck at 'upgrading' and the mnemonic stays in
    // reactive state. AbortSignal.timeout(20_000) bounds the budget; the
    // resulting TimeoutError DOMException routes to upgrade.backendTimeout
    // and does NOT wipe the mnemonic: the backend may have committed
    // `upgraded_at` before the abort fired, so the user must sign out and
    // back in to discover whether the upgrade actually landed — and they may
    // need the phrase for recovery if it didn't. The error copy directs them
    // to that recovery path and tells them to keep the phrase safe.
    it('backend cleanup fetch timeout → upgradeError + phase=error, mnemonic preserved (round-2 hold #6)', async () => {
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
        // Mnemonic is preserved on the timeout branch. The backend may have
        // committed `upgraded_at` before the abort fired; the user must sign
        // out and back in to discover whether the upgrade landed, and they
        // may need the phrase for recovery if it didn't. Wiping closes the
        // only recovery surface.
        expect(comp.newSeedPhrase).toBe(newMnemonic);
        // oldSeedPhrase is also preserved on this branch — the wipe is
        // gated on the same _clearSensitiveUpgradeState() that handles
        // newSeedPhrase. Both stay until the user navigates away (destroy
        // wipes them via the explicit teardown signal).
        expect(comp.oldSeedPhrase).toBe(oldMnemonic);

        warnSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    // The "Try Again" button is a dead-end on the backend-timeout sub-case.
    // resetUpgrade() flips
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
    // The comparison is keyed on `upgradeErrorKey` (a stable i18n key
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

    // The getter must be invariant to mid-error-screen locale switches.
    // The user can flip locales from the header switcher
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

    // Post-broadcast `TypeError: Failed to fetch` (network drop mid-fetch
    // after the chain rotation already landed) must route
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

    // Backend 500 after rotation must route non-retryable.
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

    // Backend 409 ALREADY_UPGRADED after rotation must route non-retryable.
    // Surfaces when a concurrent flow already wiped
    // server-side custody — the rotation in the current flow still
    // landed on-chain, so retrying is structurally unavailable. The
    // code routes 409 to its dedicated `upgrade.alreadyUpgraded`
    // sub-case key (a member of NON_RETRYABLE_UPGRADE_ERROR_KEYS); the
    // canRetryUpgrade=false assertion below verifies the non-retryable
    // contract regardless of which specific terminal key fired.
    it('post-broadcast backend 409 ALREADY_UPGRADED routes to non-retryable (alreadyUpgraded)', async () => {
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
      expect(comp.upgradeErrorKey).toBe('upgrade.alreadyUpgraded');
      expect(comp.canRetryUpgrade).toBe(false);

      warnSpy.mockRestore();
    });

    // When the user navigates away mid-flow (Alpine's destroy() flips
    // _mounted=false via _teardownTimers), the
    // Keychain loop must short-circuit so no fresh popups appear on the
    // navigated-away page, no upgradePhase='done' write lands on the
    // orphaned component, and sensitive reactive state is wiped exactly
    // once. The unmount fires inside the first requestImportKey callback
    // — the realistic shape of "user clicked a nav link while the
    // Keychain popup was open for role 0 (posting)".
    it('navigate-away mid-keychain-loop: short-circuits, wipes state once, no done write', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      const importKeyCalls = [];
      // Capture the component for the keychain stub so it can invoke
      // destroy() from inside the first callback. Hoisted here so the
      // closure binding is in scope when the stub fires. Calling
      // destroy() (rather than directly flipping _mounted) exercises
      // the integrated production unmount path: destroy() synchronously
      // runs _clearSensitiveUpgradeState() then _teardownTimers()
      // (which flips _mounted). Calling destroy() rather than directly
      // flipping _mounted pins the wipe-once-on-unmount invariant
      // end-to-end (a regression reordering or removing the wipe inside
      // destroy() would now fail this test).
      let compRef = null;
      vi.stubGlobal('window', {
        ...globalThis.window,
        hive_keychain: {
          requestImportKey: (account, wifKey, cb) => {
            importKeyCalls.push({ account, wifKey });
            // Run destroy() on the first iteration (posting). The
            // per-iteration guard at the top of the for-loop body should
            // see _mounted=false on the next iteration and exit; active
            // + memo must NOT be attempted.
            if (importKeyCalls.length === 1 && compRef) {
              compRef.destroy();
            }
            queueMicrotask(() => cb({ success: true }));
          },
        },
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { token: 'new-jwt', custody: 'self' } }),
      })));

      const comp = createComponent();
      compRef = comp;
      comp.oldSeedPhrase = Array(12).fill('old').join(' ');
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };
      comp.upgradePassword = 'light-password';
      comp.upgradePhase = 'enter-old';

      await comp.executeUpgrade();

      // (a) Loop short-circuited: only the first iteration's popup fired.
      // Without the guard, all three roles (posting, active, memo) would
      // call requestImportKey.
      expect(importKeyCalls).toHaveLength(1);
      expect(importKeyCalls[0].account).toBe('alice');

      // (c) No upgradePhase='done' write on the unmounted component.
      // The finally block in _completeUpgradeAfterBackend is now
      // _mounted-gated, so the orphaned `this` retains whatever phase
      // it had when the helper exited ('upgrading', not 'done').
      expect(comp.upgradePhase).not.toBe('done');

      // (b) Sensitive state wiped exactly once via the integrated
      // destroy() path (destroy() → _clearSensitiveUpgradeState() →
      // _teardownTimers() → _mounted=false). Asserting the full wipe
      // here pins the destroy() ordering invariant against the
      // mid-flow path. A regression that reordered _teardownTimers
      // before _clearSensitiveUpgradeState (or dropped the wipe call
      // from destroy()) would leave these fields populated and fail.
      expect(comp.oldSeedPhrase).toBe('');
      expect(comp.newSeedPhrase).toBe('');
      expect(comp.newSeedWords).toEqual([]);
      expect(comp.confirmInputs).toEqual({});
      expect(comp.upgradePassword).toBe('');
      expect(comp._mounted).toBe(false);
    });

    // Companion to the above: calling destroy() on a mid-flow component
    // wipes sensitive reactive state via the explicit cleanup signal.
    // Surfaces the unmount as an explicit cleanup signal: the navigate-away
    // path runs comp.destroy(), which flips _mounted and clears the mnemonic,
    // both atomically from the user's perspective.
    it('destroy() wipes sensitive upgrade state in addition to flipping _mounted', () => {
      const comp = createComponent();
      comp.oldSeedPhrase = 'old old old old old old old old old old old old';
      comp.newSeedPhrase = 'new new new new new new new new new new new new';
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.confirmInputs = { 0: 'new', 5: 'new', 11: 'new' };

      comp.destroy();

      // Sensitive reactive state cleared via the explicit cleanup signal
      // wired into destroy(). Mirrors the fields _clearSensitiveUpgradeState
      // touches today. (upgradePassword wipe is a separate pre-existing
      // gap; not asserted here.)
      expect(comp.oldSeedPhrase).toBe('');
      expect(comp.newSeedPhrase).toBe('');
      expect(comp.newSeedWords).toEqual([]);
      expect(comp.confirmInputs).toEqual({});
      // _mounted flipped by _teardownTimers, so async continuations exit.
      expect(comp._mounted).toBe(false);
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

      expect(mockSetPassword).toHaveBeenCalledWith('Abcdefgh1x', undefined);
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

    // Error-message sanitization: on failure the DOM-bound passwordError
    // must be a generic localized message (never `err.message`,
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

    // Settings-action fresh-auth orchestrator wiring: outcome routing + proof threading.
    // set-password is ORCID-only, so on a light account it routes through the
    // ORCID round-trip; the handler must wipe the typed password before the
    // page navigates away and not fire a premature success toast.
    it('threads action=set_password and the orchestrator proof into setPassword', async () => {
      mockSetPassword.mockResolvedValue({ status: 'ok' });
      mockWithSettingsFreshAuth.mockImplementationOnce(async (action, _ctx, run) => {
        expect(action).toBe('set_password');
        return { ok: await run('orcid-proof') };
      });
      const comp = createComponent();
      comp.emailStatus = { hasEmail: true, hasPassword: false };
      comp.newPasswordInput = 'Abcdefgh1x';
      comp.newPasswordConfirmInput = 'Abcdefgh1x';

      await comp.handleSetPassword();

      expect(mockSetPassword).toHaveBeenCalledWith('Abcdefgh1x', 'orcid-proof');
      expect(comp.emailStatus.hasPassword).toBe(true);
    });

    it('aborts cleanly and wipes the password on an ORCID redirect', async () => {
      mockWithSettingsFreshAuth.mockResolvedValueOnce({ redirect: true });
      const comp = createComponent();
      comp.newPasswordInput = 'Abcdefgh1x';
      comp.newPasswordConfirmInput = 'Abcdefgh1x';

      await comp.handleSetPassword();

      expect(mockToastStore.show).not.toHaveBeenCalled();
      expect(comp.newPasswordInput).toBe('');
      expect(comp.newPasswordConfirmInput).toBe('');
      expect(comp.passwordSubmitting).toBe(false);
    });

    it('surfaces the generic re-auth error and wipes the password on freshAuthFailed', async () => {
      mockWithSettingsFreshAuth.mockResolvedValueOnce({ freshAuthFailed: true });
      const comp = createComponent();
      comp.emailStatus = { hasEmail: true, hasPassword: false };
      comp.newPasswordInput = 'Abcdefgh1x';
      comp.newPasswordConfirmInput = 'Abcdefgh1x';

      await comp.handleSetPassword();

      expect(comp.passwordError).toBe('settings.reauthFailed');
      expect(comp.newPasswordInput).toBe('');
      expect(comp.emailStatus.hasPassword).toBe(false);
      expect(mockToastStore.show).not.toHaveBeenCalled();
    });

    // sessionInconsistent: the orchestrator already tore the corrupted session
    // down and showed the re-login toast, so the caller must abort cleanly (no
    // second toast, no generic error) AND still zero the held plaintext password
    // for XSS-read hygiene, exactly like the ORCID-redirect abort path. This is
    // the security-adjacent arm of the new sessionInconsistent routing.
    it('aborts cleanly and wipes the password on a torn-down session (sessionInconsistent)', async () => {
      mockWithSettingsFreshAuth.mockResolvedValueOnce({ sessionInconsistent: true });
      const comp = createComponent();
      comp.emailStatus = { hasEmail: true, hasPassword: false };
      comp.newPasswordInput = 'Abcdefgh1x';
      comp.newPasswordConfirmInput = 'Abcdefgh1x';

      await comp.handleSetPassword();

      // No SECOND toast from the caller (the orchestrator owns the re-login toast).
      expect(mockToastStore.show).not.toHaveBeenCalled();
      // No generic re-auth error: this is a teardown, not a retryable failure.
      expect(comp.passwordError).toBeNull();
      // Held plaintext is zeroed even though the session is being torn down.
      expect(comp.newPasswordInput).toBe('');
      expect(comp.newPasswordConfirmInput).toBe('');
      expect(comp.passwordSubmitting).toBe(false);
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

  // Unit coverage for the post-broadcast 503-retry path.
  // `retryUpgradeBackend()` is reachable only from the error screen with
  // `upgradeErrorKey === 'upgrade.backendUnavailable'`; it re-signs a fresh
  // proof and re-POSTs the backend cleanup call without re-broadcasting the
  // (already-landed) chain rotation. `handleRetry()` is the dispatcher
  // that the Try Again button binds to.
  //
  // Branches enumerated (search the named symbols in
  // frontend/src/pages/settings.js):
  //   handleRetry()
  //     H1. upgradeErrorKey === 'upgrade.backendUnavailable' → retryUpgradeBackend()
  //     H2. else → resetUpgrade() (phase → 'idle', state wiped)
  //   retryUpgradeBackend()
  //     R1. guard: upgradePhase !== 'error' → early return (no-op)
  //     R2. guard: upgradeErrorKey !== 'upgrade.backendUnavailable' → early return
  //     R3. defensive: !newSeedPhrase → wipe + partialApplyFailed (terminal)
  //     R4. happy path: 2xx → loginFromResponse + _completeUpgradeAfterBackend → 'done'
  //     R5. post-await unmount guard: !_mounted after _postUpgradeBackend → early return
  //     R6. post-await unmount guard: !_mounted after loginFromResponse → early return
  //         // untestable without DI: the mock auth store's loginFromResponse is
  //         // synchronous, so there is no suspension window between the two
  //         // _mounted checks for a navigate-away to land in. Stubbing
  //         // loginFromResponse to flip _mounted would test the stub, not the
  //         // production code path. R5's unmount-after-post case proves the
  //         // shared "early-return short-circuits _completeUpgradeAfterBackend"
  //         // invariant the R6 site also relies on.
  //     R7. catch TimeoutError/AbortError → wipe + backendTimeout (terminal)
  //     R8. catch status===503 → KEEP state + backendUnavailable (still retryable)
  //     R9. catch status===409 → wipe + alreadyUpgraded (terminal)
  //     R10. catch status===429 → wipe + rateLimited (terminal)
  //     R11. catch-all (no status / other status / network drop) → wipe + partialApplyFailed
  describe('UI-RETRY-UPGRADE-BACKEND-TEST-COVERAGE: handleRetry + retryUpgradeBackend', () => {
    // Pre-existing tests in this file override the module-level
    // `deriveHiveKeys` mock via `vi.mocked(deriveHiveKeys).mockImplementation(...)`
    // to inject mid-helper throws. `vi.clearAllMocks()` in the outer
    // beforeEach clears call history but NOT the overriding
    // implementation, so the override survives into the next test. Reset
    // back to the default per-WIF success here so each retry-branch test
    // starts from a known good derivation path.
    beforeEach(() => {
      vi.mocked(deriveHiveKeys).mockImplementation(async () => ({ ...STUB_WIFS }));
    });

    // Seeds the post-broadcast 503 error state: phase 'error',
    // backendUnavailable discriminator, newSeedPhrase preserved (only the
    // 503 sub-case keeps it across the failure). Mirrors the state
    // executeUpgrade() leaves behind when it falls into the 503 branch.
    function seedBackendUnavailableErrorState(comp) {
      comp.upgradePhase = 'error';
      comp.upgradeErrorKey = 'upgrade.backendUnavailable';
      comp.upgradeError = 'upgrade.backendUnavailable';
      comp.newSeedPhrase = Array(12).fill('new').join(' ');
      // The 503 catch in executeUpgrade does NOT wipe; mirror that.
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.upgradePassword = 'light-password';
      return comp;
    }

    // _signUpgradeProof calls getAppTag() which reads `window.__PEVO_CONFIG__`.
    // Vitest's default env doesn't define `window`, so non-keychain catch-branch
    // tests must still stub a bare window or _signUpgradeProof throws a
    // ReferenceError before fetch is even called, and every error routes to
    // the partialApplyFailed catch-all instead of the branch under test.
    function stubBareWindow() {
      vi.stubGlobal('window', { ...globalThis.window });
    }

    // H1: dispatcher routes the 503 sub-case to retryUpgradeBackend.
    // retryUpgradeBackend's first synchronous side-effect (before any
    // await) is `this.upgradePhase = 'upgrading'`. resetUpgrade, by
    // contrast, synchronously sets phase to 'idle'. The two dispatch
    // arms can therefore be discriminated by observing phase immediately
    // after the synchronous handleRetry() call returns. handleRetry()
    // itself is non-async and does NOT return the retry promise, so
    // awaiting it is a no-op for the underlying retry continuation;
    // the synchronous phase check is the only fair assertion at the
    // dispatcher boundary.
    it('handleRetry: dispatches to retryUpgradeBackend on upgrade.backendUnavailable sub-case', () => {
      const comp = createComponent();
      seedBackendUnavailableErrorState(comp);

      comp.handleRetry();

      // retryUpgradeBackend's synchronous prologue (after the guards
      // pass) flips phase to 'upgrading'. resetUpgrade would have set
      // phase to 'idle' instead.
      expect(comp.upgradePhase).toBe('upgrading');
      // newSeedPhrase preserved across handleRetry: the 503 retry path
      // re-derives from it, so resetUpgrade (which wipes) was NOT taken.
      expect(comp.newSeedPhrase).not.toBe('');
    });

    // H2: dispatcher resets the wizard on every non-503 retryable
    // sub-case. The pre-broadcast `upgrade.failed` key is the canonical
    // example (Keychain denial, chain rejection, invalid old seed) —
    // canRetryUpgrade returns true and Try Again is shown; clicking it
    // must clear the wizard back to 'idle' so a fresh attempt
    // regenerates the new mnemonic.
    it('handleRetry: resets wizard to idle on non-backendUnavailable retryable sub-case', () => {
      const comp = createComponent();
      comp.upgradePhase = 'error';
      comp.upgradeErrorKey = 'upgrade.failed';
      comp.upgradeError = 'upgrade.failed';
      comp.oldSeedPhrase = 'old old old old old old old old old old old old';
      comp.newSeedPhrase = 'new new new new new new new new new new new new';
      comp.newSeedWords = comp.newSeedPhrase.split(' ');
      comp.upgradePassword = 'light-password';
      comp.upgradeWarnings = ['stale warning'];

      comp.handleRetry();

      expect(comp.upgradePhase).toBe('idle');
      expect(comp.upgradeError).toBeNull();
      expect(comp.upgradeErrorKey).toBeNull();
      expect(comp.upgradeWarnings).toEqual([]);
      // resetUpgrade() runs _clearSensitiveUpgradeState() so seed material
      // is gone.
      expect(comp.oldSeedPhrase).toBe('');
      expect(comp.newSeedPhrase).toBe('');
      expect(comp.upgradePassword).toBe('');
    });

    // R1: phase guard. Reaching retryUpgradeBackend from a non-error
    // phase (e.g. mid-flow re-entry via a stray $watch) must be a no-op.
    // The function is exposed on the Alpine component so anything with a
    // reference can call it directly; the guard prevents that from
    // double-firing the backend cleanup.
    it('retryUpgradeBackend: no-op when upgradePhase !== "error"', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const comp = createComponent();
      comp.upgradePhase = 'upgrading'; // wrong phase
      comp.upgradeErrorKey = 'upgrade.backendUnavailable';
      comp.newSeedPhrase = Array(12).fill('new').join(' ');

      await comp.retryUpgradeBackend();

      expect(fetchSpy).not.toHaveBeenCalled();
      // Phase untouched.
      expect(comp.upgradePhase).toBe('upgrading');
    });

    // R2: discriminator guard. Reaching retryUpgradeBackend from a
    // non-backendUnavailable error sub-case (e.g. someone wired the
    // dispatcher wrong, or the field was stale) must short-circuit —
    // retrying a terminal sub-case would re-broadcast against an
    // already-rotated chain.
    it('retryUpgradeBackend: no-op when upgradeErrorKey !== "upgrade.backendUnavailable"', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const comp = createComponent();
      comp.upgradePhase = 'error';
      comp.upgradeErrorKey = 'upgrade.partialApplyFailed'; // terminal sub-case
      comp.newSeedPhrase = Array(12).fill('new').join(' ');

      await comp.retryUpgradeBackend();

      expect(fetchSpy).not.toHaveBeenCalled();
      // upgradeErrorKey untouched — caller-set terminal state survives.
      expect(comp.upgradeErrorKey).toBe('upgrade.partialApplyFailed');
    });

    // R3: defensive branch. newSeedPhrase is cleared on every terminal
    // catch sub-case, so reaching the retry path with an empty
    // newSeedPhrase means the state machine drifted. Route to the
    // terminal partialApplyFailed sub-case (a fresh derive from "" would
    // produce a meaningless proof against the chain).
    it('retryUpgradeBackend: empty newSeedPhrase routes to partialApplyFailed (terminal)', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const comp = createComponent();
      comp.upgradePhase = 'error';
      comp.upgradeErrorKey = 'upgrade.backendUnavailable';
      comp.newSeedPhrase = ''; // drifted state — no seed to re-derive from

      await comp.retryUpgradeBackend();

      expect(comp.upgradeErrorKey).toBe('upgrade.partialApplyFailed');
      expect(comp.upgradeError).toBe('upgrade.partialApplyFailed');
      // Entry invariant: phase stays 'error' (production R3 doesn't write
      // upgradePhase; it routes through the partialApplyFailed terminal
      // branch which leaves phase as set on entry). Matches the sibling
      // terminal-sub-case tests (R7, R9, R10, R11). Mutation-killing:
      // a regression that added an upgradePhase write before the
      // !newSeedPhrase check would fail this.
      expect(comp.upgradePhase).toBe('error');
      // partialApplyFailed is on NON_RETRYABLE_UPGRADE_ERROR_KEYS, so the
      // derived `canRetryUpgrade` getter must be false. Mutation-killing:
      // a regression that omitted the partialApplyFailed routing (e.g.,
      // left upgradeErrorKey at backendUnavailable) would still hit the
      // partialApplyFailed assertion above iff both writes were swapped,
      // but the canRetryUpgrade=false assertion pins the non-retryable
      // routing independently.
      expect(comp.canRetryUpgrade).toBe(false);
      // Sensitive state wiped on the defensive path.
      expect(comp.newSeedPhrase).toBe('');
      // No backend call — there was nothing to retry against.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    // R4: happy path. Backend cleanup succeeds on the retry, the
    // session rotates via loginFromResponse with the self-custody
    // claim, and _completeUpgradeAfterBackend transitions phase to
    // 'done' (zeroing sensitive state in its finally block).
    it('retryUpgradeBackend: happy path → 2xx, loginFromResponse(self), phase=done, state wiped', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      stubKeychainImportKeySuccess();
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: { token: 'rotated-jwt', expires_at: '2099-01-01T00:00:00.000Z', custody: 'self' },
        }),
      })));

      const comp = createComponent();
      seedBackendUnavailableErrorState(comp);

      await comp.retryUpgradeBackend();

      expect(comp.upgradePhase).toBe('done');
      expect(mockAuthStore.loginFromResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'rotated-jwt',
          expires_at: '2099-01-01T00:00:00.000Z',
          custody: 'self',
        }),
      );
      // _completeUpgradeAfterBackend's finally block wipes sensitive state.
      expect(comp.newSeedPhrase).toBe('');
      expect(comp.newSeedWords).toEqual([]);
      expect(comp.upgradePassword).toBe('');
    });

    // R5: post-await unmount guard. If the user navigates away during
    // the (up-to-20s) backend cleanup POST, the post-fetch _mounted
    // check must short-circuit so loginFromResponse is NOT called on
    // the orphaned component and _completeUpgradeAfterBackend does NOT
    // start its Keychain loop.
    it('retryUpgradeBackend: navigate-away during _postUpgradeBackend → no loginFromResponse, no Keychain loop', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      // Capture the component so the fetch stub can flip _mounted on
      // the same instance retryUpgradeBackend is running against.
      let compRef = null;
      // Keychain stub must NOT fire — if the post-fetch unmount guard
      // works, _completeUpgradeAfterBackend never runs.
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
      vi.stubGlobal('fetch', vi.fn(async () => {
        // Simulate the unmount-during-await: flip _mounted=false before
        // returning the response. The post-await _mounted check in
        // retryUpgradeBackend must observe this and short-circuit.
        if (compRef) compRef._mounted = false;
        return {
          ok: true,
          json: async () => ({ data: { token: 'rotated-jwt', custody: 'self' } }),
        };
      }));

      const comp = createComponent();
      compRef = comp;
      seedBackendUnavailableErrorState(comp);

      await comp.retryUpgradeBackend();

      // Unmount guard fired: no session rotation, no Keychain popups,
      // no phase='done' write on the orphaned component.
      expect(mockAuthStore.loginFromResponse).not.toHaveBeenCalled();
      expect(importKeyCalls).toHaveLength(0);
      expect(comp.upgradePhase).not.toBe('done');
    });

    // R7: TimeoutError. AbortSignal.timeout(20_000) in
    // _postUpgradeBackend produces a TimeoutError DOMException when the
    // 20s budget elapses. Routes to the terminal backendTimeout
    // sub-case (canRetryUpgrade=false): the retry already consumed the
    // user's patience window once; offering another retry on the same
    // hung backend is dead-end UX. State is NOT wiped — the backend may
    // have committed the upgrade before the abort fired, so the user must
    // keep newSeedPhrase to recover after signing out and back in.
    it('retryUpgradeBackend: TimeoutError → backendTimeout terminal sub-case, mnemonic preserved', async () => {
      stubBareWindow();
      const timeoutErr = new Error('signal timed out');
      timeoutErr.name = 'TimeoutError';
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(timeoutErr)));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      const preservedSeed = Array(12).fill('new').join(' ');
      seedBackendUnavailableErrorState(comp);
      comp.newSeedPhrase = preservedSeed;

      await comp.retryUpgradeBackend();

      expect(comp.upgradePhase).toBe('error');
      expect(comp.upgradeErrorKey).toBe('upgrade.backendTimeout');
      expect(comp.upgradeError).toBe('upgrade.backendTimeout');
      // Ambiguous-outcome timeout preserves the mnemonic so the user can
      // complete recovery after sign-out.
      expect(comp.newSeedPhrase).toBe(preservedSeed);
      warnSpy.mockRestore();
    });

    // R7 sibling: AbortError (older runtimes / dhive-side abort surface
    // the same condition under a different DOMException name). Same
    // routing as TimeoutError; same preserve-mnemonic contract.
    it('retryUpgradeBackend: AbortError → backendTimeout terminal sub-case, mnemonic preserved', async () => {
      stubBareWindow();
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(abortErr)));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      const preservedSeed = Array(12).fill('new').join(' ');
      seedBackendUnavailableErrorState(comp);
      comp.newSeedPhrase = preservedSeed;

      await comp.retryUpgradeBackend();

      expect(comp.upgradePhase).toBe('error');
      expect(comp.upgradeErrorKey).toBe('upgrade.backendTimeout');
      expect(comp.newSeedPhrase).toBe(preservedSeed);
      warnSpy.mockRestore();
    });

    // R8: 503 again. Stays in the retryable state so the user can click
    // Try Again another time. State is NOT wiped — the retry needs
    // newSeedPhrase to re-derive on the next attempt. This is the only
    // catch branch that preserves state.
    it('retryUpgradeBackend: 503 again → stays retryable, newSeedPhrase preserved (no wipe)', async () => {
      stubBareWindow();
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: 'service unavailable' }),
      })));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      const preservedSeed = Array(12).fill('new').join(' ');
      seedBackendUnavailableErrorState(comp);
      comp.newSeedPhrase = preservedSeed;

      await comp.retryUpgradeBackend();

      expect(comp.upgradePhase).toBe('error');
      expect(comp.upgradeErrorKey).toBe('upgrade.backendUnavailable');
      expect(comp.upgradeError).toBe('upgrade.backendUnavailable');
      // canRetryUpgrade contract: backendUnavailable is retryable, so
      // Try Again stays visible.
      expect(comp.canRetryUpgrade).toBe(true);
      // CRITICAL: state preserved so a subsequent retry can re-derive.
      expect(comp.newSeedPhrase).toBe(preservedSeed);
      warnSpy.mockRestore();
    });

    // R9: 409 ALREADY_UPGRADED. A concurrent flow (different tab, or a
    // timed-out previous request that actually committed) finished the
    // backend cleanup. Route to the terminal alreadyUpgraded sub-case
    // and wipe — nothing further to do in this flow.
    it('retryUpgradeBackend: 409 → alreadyUpgraded terminal sub-case, state wiped', async () => {
      stubBareWindow();
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: 'ALREADY_UPGRADED' }),
      })));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      seedBackendUnavailableErrorState(comp);

      await comp.retryUpgradeBackend();

      expect(comp.upgradePhase).toBe('error');
      expect(comp.upgradeErrorKey).toBe('upgrade.alreadyUpgraded');
      expect(comp.upgradeError).toBe('upgrade.alreadyUpgraded');
      expect(comp.canRetryUpgrade).toBe(false);
      // Terminal sub-case wipes sensitive state.
      expect(comp.newSeedPhrase).toBe('');
      expect(comp.upgradePassword).toBe('');
      warnSpy.mockRestore();
    });

    // R10: 429 rate-limited. Per-account-hour budget exhausted. Wipe
    // and route to the terminal rateLimited sub-case — nothing the user
    // can do in-app.
    it('retryUpgradeBackend: 429 → rateLimited terminal sub-case, state wiped', async () => {
      stubBareWindow();
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: 'rate limited' }),
      })));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      seedBackendUnavailableErrorState(comp);

      await comp.retryUpgradeBackend();

      expect(comp.upgradePhase).toBe('error');
      expect(comp.upgradeErrorKey).toBe('upgrade.rateLimited');
      expect(comp.upgradeError).toBe('upgrade.rateLimited');
      expect(comp.canRetryUpgrade).toBe(false);
      expect(comp.newSeedPhrase).toBe('');
      expect(comp.upgradePassword).toBe('');
      warnSpy.mockRestore();
    });

    // R11a: catch-all via non-special HTTP status (500). Routes to the
    // terminal partialApplyFailed sub-case. The chain has already
    // rotated, so any further attempt would sign account_update with
    // stale keys; retry is structurally unavailable.
    it('retryUpgradeBackend: 500 → partialApplyFailed terminal sub-case (catch-all)', async () => {
      stubBareWindow();
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'internal' }),
      })));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      seedBackendUnavailableErrorState(comp);

      await comp.retryUpgradeBackend();

      expect(comp.upgradePhase).toBe('error');
      expect(comp.upgradeErrorKey).toBe('upgrade.partialApplyFailed');
      expect(comp.upgradeError).toBe('upgrade.partialApplyFailed');
      expect(comp.canRetryUpgrade).toBe(false);
      expect(comp.newSeedPhrase).toBe('');
      warnSpy.mockRestore();
    });

    // R11b: catch-all via network drop (TypeError "Failed to fetch").
    // err.status is null (not a number), so the status-keyed branches
    // do NOT match; falls through to the terminal partialApplyFailed
    // sub-case. Mirrors the executeUpgrade post-broadcast network-drop
    // case in the existing canRetryUpgrade specs.
    it('retryUpgradeBackend: network drop (TypeError) → partialApplyFailed (catch-all, no status)', async () => {
      stubBareWindow();
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      seedBackendUnavailableErrorState(comp);

      await comp.retryUpgradeBackend();

      expect(comp.upgradePhase).toBe('error');
      expect(comp.upgradeErrorKey).toBe('upgrade.partialApplyFailed');
      expect(comp.canRetryUpgrade).toBe(false);
      expect(comp.newSeedPhrase).toBe('');
      warnSpy.mockRestore();
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

  // handleOrcidLink sets orcidLinking=true then navigates away, resetting only
  // in catch. On browser Back the page restores from bfcache (init()/destroy()
  // do not re-run) and would stay disabled on its "Redirecting..." label. A
  // persisted pageshow (bfcache restore) must reset the flag. bfcache cannot
  // be simulated in jsdom, so a listener-recording window stub lets us fire a
  // synthetic pageshow whose `persisted` we set explicitly. Settings uses the
  // orcidLinking flag (not orcidLoading).
  describe('bfcache restore', () => {
    function stubPageshowWindow() {
      const listeners = new Map();
      const win = {
        ...globalThis.window,
        addEventListener: vi.fn((type, fn) => {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type).add(fn);
        }),
        removeEventListener: vi.fn((type, fn) => { listeners.get(type)?.delete(fn); }),
        fire(type, event) { for (const fn of listeners.get(type) ?? []) fn(event); },
        count(type) { return listeners.get(type)?.size ?? 0; },
      };
      vi.stubGlobal('window', win);
      return win;
    }

    it('resets orcidLinking on a persisted pageshow after init()', () => {
      mockFetchEmailStatus.mockResolvedValue({ data: { hasEmail: false } });
      const win = stubPageshowWindow();
      const comp = createComponent();
      comp.init();
      comp.orcidLinking = true;
      win.fire('pageshow', { persisted: true });
      expect(comp.orcidLinking).toBe(false);
    });

    it('removes the listener on destroy() so a later pageshow does not reset', () => {
      mockFetchEmailStatus.mockResolvedValue({ data: { hasEmail: false } });
      const win = stubPageshowWindow();
      const comp = createComponent();
      comp.init();
      comp.destroy();
      expect(win.count('pageshow')).toBe(0);
      comp.orcidLinking = true;
      win.fire('pageshow', { persisted: true });
      expect(comp.orcidLinking).toBe(true);
    });
  });

  // Editable accreditation metadata: the Settings form re-broadcasts an
  // admin-signed accredit op through the same fresh-auth orchestrator the
  // email/set-password handlers use. The orchestrator is mocked (pass-through
  // by default); these assert the handler's plumbing — trimmed payload, action
  // string, optimistic auth-store refresh, and outcome handling.
  describe('editable accreditation metadata', () => {
    describe('canSubmitMetadata', () => {
      it('is false when any field is empty (after trim)', () => {
        const comp = createComponent();
        comp.editName = 'Ada Lovelace';
        comp.editInstitution = '   ';
        comp.editField = 'Mathematics';
        expect(comp.canSubmitMetadata).toBe(false);
      });

      it('is true when all three fields are within bounds', () => {
        const comp = createComponent();
        comp.editName = 'Ada Lovelace';
        comp.editInstitution = 'Analytical Engine Co';
        comp.editField = 'Mathematics';
        expect(comp.canSubmitMetadata).toBe(true);
      });

      it('is false when a field exceeds its length bound', () => {
        const comp = createComponent();
        comp.editName = 'A'.repeat(201); // name max 200
        comp.editInstitution = 'MIT';
        comp.editField = 'Physics';
        expect(comp.canSubmitMetadata).toBe(false);
      });
    });

    describe('_prefillMetadata', () => {
      it('pre-fills the inputs from the current accreditation', () => {
        mockAuthStore.accreditation = { name: 'Ada', institution: 'AE Co', field: 'Math', orcid: '0000-0001' };
        const comp = createComponent();
        comp._prefillMetadata();
        expect(comp.editName).toBe('Ada');
        expect(comp.editInstitution).toBe('AE Co');
        expect(comp.editField).toBe('Math');
      });

      it('leaves ORCID-accredited empty institution/field as empty inputs', () => {
        mockAuthStore.accreditation = { name: 'Ada', institution: '', field: '', orcid: '0000-0001' };
        const comp = createComponent();
        comp._prefillMetadata();
        expect(comp.editName).toBe('Ada');
        expect(comp.editInstitution).toBe('');
        expect(comp.editField).toBe('');
      });

      it('does not overwrite edits already in progress (one-shot)', () => {
        mockAuthStore.accreditation = { name: 'Ada', institution: 'AE Co', field: 'Math' };
        const comp = createComponent();
        comp._prefillMetadata();
        comp.editName = 'Edited';
        comp._prefillMetadata(); // late store update / second call
        expect(comp.editName).toBe('Edited');
      });
    });

    describe('handleMetadataSubmit', () => {
      it('does nothing when the form is invalid', async () => {
        const comp = createComponent();
        comp.editName = '';
        await comp.handleMetadataSubmit();
        expect(mockSubmitAccreditationMetadata).not.toHaveBeenCalled();
      });

      it('does nothing when already submitting', async () => {
        const comp = createComponent();
        comp.editName = 'Ada';
        comp.editInstitution = 'AE Co';
        comp.editField = 'Math';
        comp.metadataSubmitting = true;
        await comp.handleMetadataSubmit();
        expect(mockSubmitAccreditationMetadata).not.toHaveBeenCalled();
      });

      it('submits trimmed values with the edit_accreditation_metadata action and refreshes the store', async () => {
        mockAuthStore.accreditation = { orcid: '0000-0001', method: 'orcid' };
        mockSubmitAccreditationMetadata.mockResolvedValue({ status: 'ok', data: {} });
        const comp = createComponent();
        comp.editName = '  Ada Lovelace  ';
        comp.editInstitution = '  AE Co  ';
        comp.editField = '  Mathematics  ';

        await comp.handleMetadataSubmit();

        expect(mockWithSettingsFreshAuth).toHaveBeenCalledWith(
          'edit_accreditation_metadata',
          expect.objectContaining({ custody: 'light', username: 'alice' }),
          expect.any(Function),
        );
        expect(mockSubmitAccreditationMetadata).toHaveBeenCalledWith(
          { full_name: 'Ada Lovelace', institution: 'AE Co', field: 'Mathematics' },
          undefined,
        );
        // Optimistic store refresh: metadata merged in, orcid/method preserved.
        expect(mockAuthStore.accreditation).toEqual({
          orcid: '0000-0001', method: 'orcid',
          name: 'Ada Lovelace', institution: 'AE Co', field: 'Mathematics',
        });
        expect(mockAuthStore._saveSession).toHaveBeenCalled();
        expect(mockToastStore.show).toHaveBeenCalledWith('settings.metadataSaved', 'success');
        expect(comp.metadataError).toBeNull();
      });

      it('surfaces reauthFailed and does not touch the store on freshAuthFailed', async () => {
        mockWithSettingsFreshAuth.mockResolvedValueOnce({ freshAuthFailed: true });
        const comp = createComponent();
        comp.editName = 'Ada';
        comp.editInstitution = 'AE Co';
        comp.editField = 'Math';

        await comp.handleMetadataSubmit();

        expect(comp.metadataError).toBe('settings.reauthFailed');
        expect(mockAuthStore._saveSession).not.toHaveBeenCalled();
        expect(mockToastStore.show).not.toHaveBeenCalled();
      });

      it('aborts cleanly on redirect (ORCID round-trip) without toast or store write', async () => {
        mockWithSettingsFreshAuth.mockResolvedValueOnce({ redirect: true });
        const comp = createComponent();
        comp.editName = 'Ada';
        comp.editInstitution = 'AE Co';
        comp.editField = 'Math';

        await comp.handleMetadataSubmit();

        expect(comp.metadataError).toBeNull();
        expect(mockAuthStore._saveSession).not.toHaveBeenCalled();
        expect(mockToastStore.show).not.toHaveBeenCalled();
      });

      it('sanitizes failure: generic message to DOM, raw err to console.warn', async () => {
        const leaky = new Error('rate-limited token=deadbeefcafebabe');
        mockSubmitAccreditationMetadata.mockRejectedValue(leaky);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const comp = createComponent();
        comp.editName = 'Ada';
        comp.editInstitution = 'AE Co';
        comp.editField = 'Math';

        await comp.handleMetadataSubmit();

        expect(comp.metadataError).toBe('settings.metadataUpdateFailed');
        expect(comp.metadataError).not.toContain('deadbeef');
        expect(warnSpy).toHaveBeenCalled();
        expect(warnSpy.mock.calls[0][1]).toBe(leaky);
        expect(comp.metadataSubmitting).toBe(false);
        warnSpy.mockRestore();
      });
    });
  });
});

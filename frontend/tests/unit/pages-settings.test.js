import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('../../src/hive-keys.js', () => ({
  deriveHiveKeys: vi.fn(() => ({
    owner: 'a'.repeat(64),
    active: 'b'.repeat(64),
    posting: 'c'.repeat(64),
    memo: 'd'.repeat(64),
  })),
  deriveHivePublicKeys: vi.fn(async () => ({
    owner: 'STM' + 'o'.repeat(50),
    active: 'STM' + 'a'.repeat(50),
    posting: 'STM' + 'p'.repeat(50),
    memo: 'STM' + 'm'.repeat(50),
  })),
  // BIP39 wrappers (re-exported from hive-keys.js, not from raw @scure/bip39).
  // FE-UPGRADE-KEY-WRAPPER-ADOPT routed settings.js through hive-keys.js so
  // a single entropy/wordlist policy applies across callers.
  generateMnemonic: vi.fn(() => Array(12).fill('test').join(' ')),
  validateMnemonic: vi.fn(() => true),
  mnemonicToSeedSync: vi.fn(() => new Uint8Array(64)),
}));

// dhive mock for the executeUpgrade() credential-wipe test.
// The executeUpgrade path: validateMnemonic(old) → mnemonicToSeedSync →
// deriveHiveKeys → new dhive.Client → sendOperations → requestImportKey →
// fetch('/api/custody/upgrade'). BIP39 wrappers are mocked via
// `vi.mock('../../src/hive-keys.js', ...)` above (settings.js imports them
// from the wrapper, not raw @scure/bip39, after FE-UPGRADE-KEY-WRAPPER-ADOPT).
// Map each hex seed char to a distinct WIF so the three Keychain
// `requestImportKey` calls (posting + active + memo) get distinguishable
// WIFs — required by the FE-KEYCHAIN-API-MISUSE regression test that
// asserts three distinct WIFs.
function stubWifForHex(hex) {
  if (typeof hex !== 'string' || hex.length === 0) return '5' + 'K' + 'x'.repeat(49);
  const tag = hex[0].toLowerCase();
  const pad = ({ a: 'A', b: 'B', c: 'C', d: 'D' }[tag]) || 'x';
  return '5K' + pad.repeat(49);
}
vi.mock('@hiveio/dhive', () => ({
  PrivateKey: {
    fromSeed: vi.fn((hex) => ({
      toString: () => stubWifForHex(hex),
    })),
  },
  Client: vi.fn(() => ({
    broadcast: {
      sendOperations: vi.fn(async () => ({ id: 'stub-tx' })),
    },
  })),
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
      const warnedErr = warnSpy.mock.calls[0][1];
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
      const warnedErr = warnSpy.mock.calls[0][1];
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
      // Guard the warnSpy.mock.calls[0][1] read below: without this
      // assertion a regression that skips the console.warn throws a
      // TypeError here instead of surfacing a clear test failure.
      expect(warnSpy).toHaveBeenCalled();
      const warnedErr = warnSpy.mock.calls[0][1];
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
      const warnedErr = warnSpy.mock.calls[0][1];
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
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
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
      // The user-facing error must be the generic localized message. The
      // $t stub in this suite returns the key verbatim, so assert the key.
      expect(comp.upgradeError).toBe('upgrade.failed');
      // Critical: neither of the leak substrings may appear in the DOM-bound
      // error string.
      expect(comp.upgradeError).not.toContain(leakHex);
      expect(comp.upgradeError).not.toContain(leakSeedWords);
      // Sanity: raw error still surfaced to console.warn so developers can
      // debug. (Not a leak — devtools is a trusted surface.)
      expect(warnSpy).toHaveBeenCalled();
      const warnArgs = warnSpy.mock.calls[0];
      const warnedErr = warnArgs[1];
      const warnedStr = warnedErr && warnedErr.message ? warnedErr.message : String(warnedErr);
      expect(warnedStr).toContain(leakHex);
      warnSpy.mockRestore();
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

      const comp = createComponent();
      seedUpgradeState(comp);

      await comp.executeUpgrade();

      expect(comp.upgradePhase).toBe('done');
      // Store state immediately before the no-arg _saveSession() call
      // determines the persisted localStorage shape. Assert each load-bearing
      // field landed correctly.
      expect(mockAuthStore.custody).toBe('self');
      expect(mockAuthStore.token).toBe('new-jwt');
      // Load-bearing: expiresAt rotates with the new token, so _restoreSession
      // sees a valid entry on next load. Historically the 6-arg call passed
      // null here, which would have wiped expires_at and logged the user out.
      expect(mockAuthStore.expiresAt).toBe('2100-01-01T00:00:00.000Z');
      // Pre-existing accreditation fields survive the upgrade.
      expect(mockAuthStore.isAccredited).toBe(true);
      expect(mockAuthStore.accreditation).toEqual({ orcid: '0000-0001' });
      // The no-arg form — zero positional args, reads from instance state.
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith();
    });

    it('preserves existing expiresAt when backend omits expires_at from the upgrade response', async () => {
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

      const originalExpiry = mockAuthStore.expiresAt;
      const comp = createComponent();
      seedUpgradeState(comp);

      await comp.executeUpgrade();

      expect(comp.upgradePhase).toBe('done');
      expect(mockAuthStore.token).toBe('new-jwt-legacy');
      // Critical: the no-arg _saveSession() must persist the existing
      // expiresAt, not clobber it to null (which the pre-sweep call-shape
      // advertised with its hard-coded `null` positional arg).
      expect(mockAuthStore.expiresAt).toBe(originalExpiry);
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith();
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
      // deriveHiveKeys mock above returns `owner: 'a'.repeat(64)`; the
      // stubWifForHex mapping produces `5K` + 'A'*49 for that seed. None
      // of the three imported WIFs may equal that value.
      const ownerWif = '5K' + 'A'.repeat(49);
      for (const call of importKeyCalls) {
        expect(call.wifKey).not.toBe(ownerWif);
      }
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

  describe('SEC-004: handleSetPassword', () => {
    it('submits new password and toggles emailStatus.hasPassword', async () => {
      mockSetPassword.mockResolvedValue({ status: 'ok' });
      const comp = createComponent();
      comp.emailStatus = { hasEmail: true, email: 'a***@x.com', verified: true, hasPassword: false };
      comp.newPasswordInput = 'Abcdefgh1x';
      comp.newPasswordConfirmInput = 'Abcdefgh1x';

      await comp.handleSetPassword();

      expect(mockSetPassword).toHaveBeenCalledWith('Abcdefgh1x');
      expect(comp.passwordSetDone).toBe(true);
      expect(comp.emailStatus.hasPassword).toBe(true);
      expect(comp.newPasswordInput).toBe('');
      expect(comp.newPasswordConfirmInput).toBe('');
      expect(mockToastStore.show).toHaveBeenCalled();
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
      expect(comp.passwordSetDone).toBe(false);
      expect(comp.passwordSubmitting).toBe(false);
      expect(comp.newPasswordInput).toBe('');
      expect(comp.newPasswordConfirmInput).toBe('');
      expect(warnSpy).toHaveBeenCalled();
      const warnedErr = warnSpy.mock.calls[0][1];
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

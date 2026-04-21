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
    localStorageData = {};
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => localStorageData[key] ?? null),
      setItem: vi.fn((key, val) => { localStorageData[key] = val; }),
      removeItem: vi.fn((key) => { delete localStorageData[key]; }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
      const comp = createComponent();
      comp.newEmail = 'dup@x.com';

      await comp.handleEmailSubmit();

      expect(comp.emailError).toBe('settings.emailAlreadyInUse');
    });

    it('shows generic error', async () => {
      mockSubmitEmail.mockRejectedValue({ message: 'server error' });
      const comp = createComponent();
      comp.newEmail = 'x@x.com';

      await comp.handleEmailSubmit();

      expect(comp.emailError).toBe('server error');
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

    it('sets error on failure', async () => {
      mockDeleteEmail.mockRejectedValue(new Error('denied'));
      const comp = createComponent();

      await comp.handleEmailDelete();

      expect(comp.emailError).toBe('denied');
      expect(comp.deleting).toBe(false);
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
      const comp = createComponent();

      await comp.handleOrcidLink();

      expect(comp.orcidError).toBe('Invalid ORCID redirect URL');
      expect(comp.orcidLinking).toBe(false);
    });

    it('does nothing if already linking', async () => {
      const comp = createComponent();
      comp.orcidLinking = true;
      await comp.handleOrcidLink();
      expect(mockStartOrcid).not.toHaveBeenCalled();
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

    it('surfaces backend error and zeroes password inputs', async () => {
      mockSetPassword.mockRejectedValue({ message: 'already set', code: 'CONFLICT' });
      const comp = createComponent();
      comp.newPasswordInput = 'Abcdefgh1x';
      comp.newPasswordConfirmInput = 'Abcdefgh1x';
      await comp.handleSetPassword();
      expect(comp.passwordError).toBe('already set');
      expect(comp.passwordSetDone).toBe(false);
      expect(comp.passwordSubmitting).toBe(false);
      expect(comp.newPasswordInput).toBe('');
      expect(comp.newPasswordConfirmInput).toBe('');
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRecoverWithSeedPhrase = vi.fn();
const mockRecoverWithOrcid = vi.fn();
const mockFetchAccreditationStatus = vi.fn();
const mockStartOrcid = vi.fn();
const mockValidateMnemonic = vi.fn(() => true);
const mockDeriveAllKeys = vi.fn(() => ({
  owner: { public: 'pub_o' },
  active: { public: 'pub_a' },
  posting: { public: 'pub_p', private: 'priv_p' },
  memo: { public: 'pub_m', private: 'priv_m' },
}));

vi.mock('../../src/api.js', () => ({
  recoverWithSeedPhrase: (...args) => mockRecoverWithSeedPhrase(...args),
  recoverWithOrcid: (...args) => mockRecoverWithOrcid(...args),
  fetchAccreditationStatus: (...args) => mockFetchAccreditationStatus(...args),
  startOrcid: (...args) => mockStartOrcid(...args),
}));

vi.mock('../../src/hive-keys.js', () => ({
  validateMnemonic: (...args) => mockValidateMnemonic(...args),
  deriveAllKeys: (...args) => mockDeriveAllKeys(...args),
}));

const mockRouterStore = { navigate: vi.fn() };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'router') return mockRouterStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initRecoverPage } from '../../src/pages/recover.js';

function createComponent() {
  initRecoverPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  return comp;
}

describe('recoverPage', () => {
  let localStorageData;
  let sessionStorageData;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('password validation', () => {
    it('passwordValid requires mixed case + digit + 10 chars', () => {
      const comp = createComponent();
      comp.newPassword = 'Abcdefgh1x';
      expect(comp.passwordValid).toBe(true);

      comp.newPassword = 'short';
      expect(comp.passwordValid).toBe(false);
    });

    it('passwordsMatch checks equality', () => {
      const comp = createComponent();
      comp.newPassword = 'Abcdefgh1x';
      comp.newPasswordConfirm = 'Abcdefgh1x';
      expect(comp.passwordsMatch).toBe(true);

      comp.newPasswordConfirm = 'other';
      expect(comp.passwordsMatch).toBe(false);
    });
  });

  describe('canSubmitSeed', () => {
    it('requires all fields', () => {
      const comp = createComponent();
      expect(comp.canSubmitSeed).toBeFalsy();

      comp.username = 'alice';
      comp.seedPhrase = 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12';
      comp.newEmail = 'a@x.com';
      comp.newPassword = 'Abcdefgh1x';
      comp.newPasswordConfirm = 'Abcdefgh1x';
      expect(comp.canSubmitSeed).toBeTruthy();
    });
  });

  describe('canSubmitOrcid', () => {
    it('requires orcid token instead of seed phrase', () => {
      const comp = createComponent();
      comp.username = 'alice';
      comp.orcidToken = 'orcid-tok';
      comp.newEmail = 'a@x.com';
      comp.newPassword = 'Abcdefgh1x';
      comp.newPasswordConfirm = 'Abcdefgh1x';
      expect(comp.canSubmitOrcid).toBeTruthy();
    });

    it('SEC-004: is truthy even with no password (ORCID branch skips password)', () => {
      const comp = createComponent();
      comp.username = 'alice';
      comp.orcidToken = 'orcid-tok';
      comp.newEmail = 'a@x.com';
      comp.newPassword = '';
      comp.newPasswordConfirm = '';
      expect(comp.canSubmitOrcid).toBeTruthy();
    });

    it('SEC-004: is falsy without orcid token even if other fields set', () => {
      const comp = createComponent();
      comp.username = 'alice';
      comp.orcidToken = '';
      comp.newEmail = 'a@x.com';
      expect(comp.canSubmitOrcid).toBeFalsy();
    });
  });

  describe('init', () => {
    it('restores draft from localStorage', () => {
      localStorageData.pevo_recover_draft = JSON.stringify({
        username: 'bob',
        newEmail: 'b@x.com',
      });
      const comp = createComponent();
      comp.init();
      expect(comp.username).toBe('bob');
      expect(comp.method).toBe('orcid');
      expect(comp.orcidAvailable).toBe(true);
    });

    it('SEC-004: does NOT restore password from legacy drafts', () => {
      // Regression guard on the SEC-004 fix: even if an older draft
      // contains password fields, init() must never rehydrate them.
      localStorageData.pevo_recover_draft = JSON.stringify({
        username: 'bob',
        newEmail: 'b@x.com',
        newPassword: 'LeakedHunter2',
        newPasswordConfirm: 'LeakedHunter2',
      });
      const comp = createComponent();
      comp.init();
      expect(comp.username).toBe('bob');
      expect(comp.newPassword).toBe('');
      expect(comp.newPasswordConfirm).toBe('');
    });

    it('restores orcid token/id from localStorage', () => {
      localStorageData.pevo_signup_orcid_token = 'tok';
      localStorageData.pevo_signup_orcid_id = '0000-0001';
      const comp = createComponent();
      comp.init();
      expect(comp.orcidToken).toBe('tok');
      expect(comp.orcidId).toBe('0000-0001');
    });
  });

  describe('checkOrcidAvailability', () => {
    it('sets orcidAvailable false for short username', () => {
      const comp = createComponent();
      comp.username = 'ab';
      comp.checkOrcidAvailability();
      expect(comp.orcidAvailable).toBe(false);
    });

    it('debounces and checks accreditation for valid username', async () => {
      mockFetchAccreditationStatus.mockResolvedValue({
        data: { accreditation: { method: 'orcid' } },
      });
      const comp = createComponent();
      comp.username = 'alice';
      comp.checkOrcidAvailability();

      expect(comp.orcidChecking).toBe(true);

      await vi.advanceTimersByTimeAsync(500);
      // Flush microtasks
      await Promise.resolve();
      await Promise.resolve();

      expect(mockFetchAccreditationStatus).toHaveBeenCalledWith('alice');
    });
  });

  describe('handleSubmit - seed method', () => {
    it('validates mnemonic and calls recoverWithSeedPhrase', async () => {
      mockRecoverWithSeedPhrase.mockResolvedValue({});
      const comp = createComponent();
      comp.method = 'seed';
      comp.username = 'alice';
      comp.seedPhrase = 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12';
      comp.newEmail = 'a@x.com';
      comp.newPassword = 'Abcdefgh1x';
      comp.newPasswordConfirm = 'Abcdefgh1x';

      await comp.handleSubmit();

      expect(mockValidateMnemonic).toHaveBeenCalled();
      expect(mockDeriveAllKeys).toHaveBeenCalled();
      expect(mockRecoverWithSeedPhrase).toHaveBeenCalledWith(
        'alice', 'priv_m', 'a@x.com', 'Abcdefgh1x'
      );
      expect(comp.phase).toBe('done');
    });

    it('sets error when mnemonic invalid', async () => {
      mockValidateMnemonic.mockReturnValueOnce(false);
      const comp = createComponent();
      comp.method = 'seed';
      comp.username = 'alice';
      comp.seedPhrase = 'bad words';
      comp.newEmail = 'a@x.com';
      comp.newPassword = 'Abcdefgh1x';
      comp.newPasswordConfirm = 'Abcdefgh1x';

      await comp.handleSubmit();

      expect(comp.error).toBe('recover.seedPhraseInvalid');
    });

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: the seed-phrase
    // recovery path derives keys from the BIP39 mnemonic. Raw err.message
    // must not reach the DOM; it goes to console.warn.
    it('sanitizes API failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('fail hex=deadbeefcafebabe');
      mockRecoverWithSeedPhrase.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.method = 'seed';
      comp.username = 'alice';
      comp.seedPhrase = 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12';
      comp.newEmail = 'a@x.com';
      comp.newPassword = 'Abcdefgh1x';
      comp.newPasswordConfirm = 'Abcdefgh1x';

      await comp.handleSubmit();

      expect(comp.error).toBe('recover.seedRecoveryFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(comp.isSubmitting).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });
  });

  describe('handleSubmit - orcid method', () => {
    it('SEC-004: calls recoverWithOrcid with newPassword: null', async () => {
      mockRecoverWithOrcid.mockResolvedValue({});
      const comp = createComponent();
      comp.method = 'orcid';
      comp.username = 'alice';
      comp.orcidToken = 'orcid-tok';
      comp.newEmail = 'a@x.com';
      // Even if the password fields somehow have values (shouldn't in
      // production. They're hidden on the ORCID branch), they must NOT
      // be transmitted. Backend SEC-004-BE accepts null and preserves
      // password_hash = NULL.
      comp.newPassword = 'StaleLeaked1x';
      comp.newPasswordConfirm = 'StaleLeaked1x';

      await comp.handleSubmit();

      expect(mockRecoverWithOrcid).toHaveBeenCalledWith('alice', 'orcid-tok', 'a@x.com', null);
      expect(comp.phase).toBe('done');
    });

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: failure surfaces a
    // generic localized message; raw err reaches console.warn.
    it('sanitizes API failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('boom hex=deadbeefcafebabe');
      mockRecoverWithOrcid.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.method = 'orcid';
      comp.username = 'alice';
      comp.orcidToken = 'orcid-tok';
      comp.newEmail = 'a@x.com';

      await comp.handleSubmit();

      expect(comp.error).toBe('recover.orcidRecoveryFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(comp.isSubmitting).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });
  });

  describe('handleOrcidVerify', () => {
    it('saves draft and redirects to orcid', async () => {
      mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/auth' });
      vi.stubGlobal('window', { ...globalThis.window, location: { href: '' } });
      const comp = createComponent();
      comp.username = 'alice';

      await comp.handleOrcidVerify();

      expect(localStorage.setItem).toHaveBeenCalledWith('pevo_recover_draft', expect.any(String));
      expect(sessionStorage.setItem).toHaveBeenCalledWith('pevo_orcid_return_to', 'recover');
      expect(mockStartOrcid).toHaveBeenCalledWith('signup');
    });

    it('SEC-004: persists only non-sensitive fields to pevo_recover_draft', async () => {
      mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/auth' });
      vi.stubGlobal('window', { ...globalThis.window, location: { href: '' } });
      const comp = createComponent();
      comp.username = 'alice';
      comp.newEmail = 'a@x.com';
      comp.newPassword = 'LeakedHunter1x';
      comp.newPasswordConfirm = 'LeakedHunter1x';

      await comp.handleOrcidVerify();

      const draftCall = localStorage.setItem.mock.calls.find(
        (c) => c[0] === 'pevo_recover_draft',
      );
      expect(draftCall).toBeDefined();
      const draft = JSON.parse(draftCall[1]);
      expect(draft).toEqual({ username: 'alice', newEmail: 'a@x.com' });
      expect(draft).not.toHaveProperty('newPassword');
      expect(draft).not.toHaveProperty('newPasswordConfirm');
    });

    it('does nothing if loading', async () => {
      const comp = createComponent();
      comp.orcidLoading = true;
      await comp.handleOrcidVerify();
      expect(mockStartOrcid).not.toHaveBeenCalled();
    });

    it('does nothing without username', async () => {
      const comp = createComponent();
      comp.username = '';
      await comp.handleOrcidVerify();
      expect(mockStartOrcid).not.toHaveBeenCalled();
    });

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: failure surfaces a
    // generic localized message; raw err reaches console.warn.
    it('sanitizes failure: clears orcid state, generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('fail hex=deadbeefcafebabe');
      mockStartOrcid.mockRejectedValue(leaky);
      vi.stubGlobal('window', { ...globalThis.window, location: { href: '' } });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.username = 'alice';

      await comp.handleOrcidVerify();

      expect(comp.error).toBe('recover.orcidStartFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(comp.orcidLoading).toBe(false);
      expect(sessionStorage.removeItem).toHaveBeenCalledWith('pevo_orcid_return_to');
      expect(sessionStorage.removeItem).toHaveBeenCalledWith('pevo_orcid_mode');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });

    // A non-allowlisted redirect_url host throws before navigating, routing
    // through the same sanitized error path the start-failure case uses.
    it('rejects a non-allowlisted redirect host without navigating', async () => {
      mockStartOrcid.mockResolvedValue({ redirect_url: 'https://evil.example.com/phish' });
      vi.stubGlobal('window', { ...globalThis.window, location: { href: '' } });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.username = 'alice';

      await comp.handleOrcidVerify();

      expect(window.location.href).toBe(''); // never navigated
      expect(comp.error).toBe('recover.orcidStartFailed');
      expect(comp.orcidLoading).toBe(false);
      expect(sessionStorage.removeItem).toHaveBeenCalledWith('pevo_orcid_return_to');
      expect(sessionStorage.removeItem).toHaveBeenCalledWith('pevo_orcid_mode');
      const warned = warnSpy.mock.calls.find((c) => c[0] === '[recover orcid start]');
      expect(warned).toBeDefined();
      expect(warned[1].message).toBe('Invalid ORCID redirect URL');
      warnSpy.mockRestore();
    });
  });
});

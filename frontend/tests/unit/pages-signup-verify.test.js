import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockVerifyEmail = vi.fn();
const mockResumeSignup = vi.fn();
const mockConfirmAccount = vi.fn();
const mockLinkExistingAccount = vi.fn();
const mockGenerateMnemonic = vi.fn(() => 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12');
const mockValidateMnemonic = vi.fn(() => true);
const mockDeriveAllKeys = vi.fn(() => ({
  owner: { public: 'STM_owner_pub' },
  active: { public: 'STM_active_pub' },
  posting: { public: 'STM_posting_pub', private: 'posting_priv' },
  memo: { public: 'STM_memo_pub', private: 'memo_priv' },
}));
const mockIsKeychainInstalled = vi.fn(() => true);

vi.mock('../../src/api.js', () => ({
  verifyEmail: (...args) => mockVerifyEmail(...args),
  resumeSignup: (...args) => mockResumeSignup(...args),
  confirmAccount: (...args) => mockConfirmAccount(...args),
  linkExistingAccount: (...args) => mockLinkExistingAccount(...args),
}));

vi.mock('../../src/hive-keys.js', () => ({
  generateMnemonic: (...args) => mockGenerateMnemonic(...args),
  validateMnemonic: (...args) => mockValidateMnemonic(...args),
  deriveAllKeys: (...args) => mockDeriveAllKeys(...args),
}));

vi.mock('../../src/keychain.js', () => ({
  isKeychainInstalled: (...args) => mockIsKeychainInstalled(...args),
}));

const mockAuthStore = {
  isConnected: false,
  token: null,
  username: null,
  isAccredited: false,
  accreditation: null,
  custody: null,
  expiresAt: null,
  _saveSession: vi.fn(),
};
const mockRouterStore = { navigate: vi.fn(), query: {}, params: {} };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'auth') return mockAuthStore;
      if (name === 'router') return mockRouterStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initSignupVerifyPage } from '../../src/pages/signup-verify.js';

function createComponent(query = {}) {
  mockRouterStore.query = query;
  initSignupVerifyPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  comp.$watch = vi.fn();
  return comp;
}

describe('signupVerifyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.isConnected = false;
    mockAuthStore.token = null;
    mockAuthStore.username = null;
    mockAuthStore.isAccredited = false;
    mockAuthStore.accreditation = null;
    mockAuthStore.custody = null;
    mockAuthStore.expiresAt = null;
  });

  describe('init', () => {
    it('goes to choose phase when auth_token and email in query', () => {
      const comp = createComponent({ auth_token: 'tok', email: 'e@x.com' });
      comp.init();
      expect(comp.phase).toBe('choose');
      expect(comp.authToken).toBe('tok');
      expect(comp.email).toBe('e@x.com');
    });

    it('goes to error phase when no token in query', () => {
      const comp = createComponent({});
      comp.init();
      expect(comp.phase).toBe('error');
    });

    it('calls verifyToken when email token present', () => {
      mockVerifyEmail.mockResolvedValue({ data: { flow: 'choose', auth_token: 'a', email: 'b@x.com' } });
      const comp = createComponent({ token: 'email-tok' });
      comp.init();
      // verifyToken is called asynchronously
      expect(mockVerifyEmail).toHaveBeenCalledWith('email-tok');
    });
  });

  describe('verifyToken', () => {
    it('sets choose phase on success', async () => {
      mockVerifyEmail.mockResolvedValue({ data: { flow: 'choose', auth_token: 'a', email: 'b@x.com' } });
      const comp = createComponent({});
      comp.phase = 'verifying';

      await comp.verifyToken('tok');

      expect(comp.phase).toBe('choose');
      expect(comp.authToken).toBe('a');
    });

    it('sets error phase on unexpected flow', async () => {
      mockVerifyEmail.mockResolvedValue({ data: { flow: 'other' } });
      const comp = createComponent({});

      await comp.verifyToken('tok');

      expect(comp.phase).toBe('error');
    });

    it('sets error phase on API failure', async () => {
      mockVerifyEmail.mockRejectedValue(new Error('expired'));
      const comp = createComponent({});

      await comp.verifyToken('tok');

      expect(comp.phase).toBe('error');
      expect(comp.error).toBeNull(); // Shows resume form, no error message
    });
  });

  describe('chooseCreate', () => {
    it('generates mnemonic and moves to create-seed phase', () => {
      const comp = createComponent({ auth_token: 'tok', email: 'e@x.com' });
      comp.init();
      comp.chooseCreate();

      expect(mockGenerateMnemonic).toHaveBeenCalled();
      expect(comp.seedWords).toHaveLength(12);
      expect(comp.phase).toBe('create-seed');
    });
  });

  describe('chooseLink', () => {
    it('moves to link-keychain phase', () => {
      const comp = createComponent({ auth_token: 'tok', email: 'e@x.com' });
      comp.init();
      comp.chooseLink();
      expect(comp.phase).toBe('link-keychain');
    });
  });

  describe('proceedToConfirm', () => {
    it('picks random indices and moves to confirm phase', () => {
      const comp = createComponent({ auth_token: 'tok', email: 'e@x.com' });
      comp.init();
      comp.chooseCreate();
      comp.proceedToConfirm();

      expect(comp.confirmIndices).toHaveLength(3);
      expect(comp.phase).toBe('create-confirm');
      // Each index should have an empty input entry
      comp.confirmIndices.forEach((i) => {
        expect(comp.confirmInputs[i]).toBe('');
      });
    });
  });

  describe('confirmCorrect', () => {
    it('returns true when inputs match seed words', () => {
      const comp = createComponent({ auth_token: 'tok', email: 'e@x.com' });
      comp.init();
      comp.chooseCreate();
      comp.proceedToConfirm();

      // Fill in correct answers
      comp.confirmIndices.forEach((i) => {
        comp.confirmInputs[i] = comp.seedWords[i];
      });

      expect(comp.confirmCorrect).toBe(true);
    });

    it('returns false when inputs are wrong', () => {
      const comp = createComponent({ auth_token: 'tok', email: 'e@x.com' });
      comp.init();
      comp.chooseCreate();
      comp.proceedToConfirm();

      comp.confirmIndices.forEach((i) => {
        comp.confirmInputs[i] = 'wrong';
      });

      expect(comp.confirmCorrect).toBe(false);
    });
  });

  describe('submitCreateAccount', () => {
    it('derives keys and calls confirmAccount', async () => {
      mockConfirmAccount.mockResolvedValue({
        data: { token: 'jwt', username: 'alice', expires_at: '2099-01-01', accreditation: null },
      });

      const comp = createComponent({ auth_token: 'tok', email: 'e@x.com' });
      comp.init();
      comp.chooseCreate();
      comp.username = 'alice';
      comp.usernameStatus = 'available';

      await comp.submitCreateAccount();

      expect(mockDeriveAllKeys).toHaveBeenCalledWith(comp.mnemonic, 'alice');
      expect(mockConfirmAccount).toHaveBeenCalledWith('tok', 'alice', {
        owner_public: 'STM_owner_pub',
        active_public: 'STM_active_pub',
        posting_public: 'STM_posting_pub',
        memo_public: 'STM_memo_pub',
        posting_private: 'posting_priv',
        memo_private: 'memo_priv',
      });
      expect(comp.phase).toBe('done');
      expect(mockAuthStore.token).toBe('jwt');
      expect(mockAuthStore.custody).toBe('light');
    });

    // FE-SAVESESSION-API-MISUSE-SWEEP: submitCreateAccount used to pass six
    // positional args to _saveSession(), which the no-arg implementation
    // silently ignored — the call happened to work only because the store
    // fields were already set on the lines above. Lock in the full pre-save
    // state-reset: token/username/isAccredited/accreditation/custody MUST
    // land on the store, AND expiresAt MUST be set before _saveSession() is
    // invoked. Otherwise _restoreSession rejects the persisted entry on
    // next load and the user is silently logged out.
    it('sets full auth state including expiresAt before calling no-arg _saveSession()', async () => {
      mockConfirmAccount.mockResolvedValue({
        data: {
          token: 'jwt-create',
          username: 'alice',
          expires_at: '2099-12-31T00:00:00.000Z',
          accreditation: { some: 'acc-payload' },
        },
      });
      // Snapshot-capturing stub: inspects what _saveSession would persist
      // *at the moment it was called*, locking in the ordering invariant.
      // Final-state assertions (mockAuthStore.<field> after await returns)
      // pass against a refactor that moves `auth.expiresAt = res.data.expires_at`
      // to AFTER _saveSession() — re-introducing the "stale prior expiresAt
      // persisted, user logged out on reload" bug.
      let savedSnapshot;
      mockAuthStore._saveSession = vi.fn(function () {
        savedSnapshot = { ...mockAuthStore };
      });

      const comp = createComponent({ auth_token: 'tok', email: 'e@x.com' });
      comp.init();
      comp.chooseCreate();
      comp.username = 'alice';
      comp.usernameStatus = 'available';

      await comp.submitCreateAccount();

      expect(savedSnapshot).toBeDefined();
      expect(savedSnapshot.token).toBe('jwt-create');
      expect(savedSnapshot.username).toBe('alice');
      expect(savedSnapshot.isConnected).toBe(true);
      expect(savedSnapshot.isAccredited).toBe(true);
      expect(savedSnapshot.accreditation).toEqual({ some: 'acc-payload' });
      expect(savedSnapshot.custody).toBe('light');
      // Load-bearing: expiresAt MUST be on the store BEFORE the no-arg
      // _saveSession() reads from it.
      expect(savedSnapshot.expiresAt).toBe('2099-12-31T00:00:00.000Z');
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith();
    });

    // FE-SAVESESSION-API-MISUSE-SWEEP: handle the null-accreditation
    // default. Backend may omit `accreditation`; the pre-save reset must
    // coerce it to null (not leave a stale value carried over from a prior
    // login-as-different-user).
    it('coerces missing accreditation to null before _saveSession()', async () => {
      mockConfirmAccount.mockResolvedValue({
        data: { token: 'jwt-create2', username: 'alice', expires_at: '2099-01-01' },
      });
      // Simulate a stale prior value on the store.
      mockAuthStore.accreditation = { stale: true };

      const comp = createComponent({ auth_token: 'tok', email: 'e@x.com' });
      comp.init();
      comp.chooseCreate();
      comp.username = 'alice';
      comp.usernameStatus = 'available';

      await comp.submitCreateAccount();

      expect(mockAuthStore.accreditation).toBeNull();
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith();
    });

    it('does nothing with invalid username', async () => {
      const comp = createComponent({ auth_token: 'tok', email: 'e@x.com' });
      comp.init();
      comp.username = 'ab'; // too short
      comp.usernameStatus = 'available';

      await comp.submitCreateAccount();
      expect(mockConfirmAccount).not.toHaveBeenCalled();
    });

    it('does nothing without authToken', async () => {
      const comp = createComponent({});
      comp.phase = 'create-username';
      comp.authToken = null;
      comp.username = 'validname';
      comp.usernameStatus = 'available';
      comp.mnemonic = 'a b c d e f g h i j k l';
      comp.seedWords = comp.mnemonic.split(' ');

      await comp.submitCreateAccount();
      expect(mockConfirmAccount).not.toHaveBeenCalled();
      expect(comp.error).toBe('seedPhrase.credentialsRequired');
    });

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: submitCreateAccount
    // derives keys from the BIP39 mnemonic. Raw err.message must not reach
    // the DOM; it goes to console.warn.
    it('sanitizes failure: generic message to DOM, raw err to console.warn, returns to username phase', async () => {
      const leaky = new Error('creation failed hex=deadbeefcafebabe');
      mockConfirmAccount.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent({ auth_token: 'tok', email: 'e@x.com' });
      comp.init();
      comp.chooseCreate();
      comp.username = 'alice';
      comp.usernameStatus = 'available';

      await comp.submitCreateAccount();

      expect(comp.error).toBe('seedPhrase.createAccountFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(comp.phase).toBe('create-username');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });
  });

  describe('handleLinkAccount', () => {
    it('calls linkExistingAccount and sets auth', async () => {
      mockLinkExistingAccount.mockResolvedValue({
        data: { token: 'jwt2', username: 'bob', expires_at: '2099-01-01', accreditation: null },
      });

      const comp = createComponent({ auth_token: 'tok', email: 'e@x.com' });
      comp.init();
      comp.chooseLink();
      comp.hiveUsername = 'Bob';

      await comp.handleLinkAccount();

      expect(mockLinkExistingAccount).toHaveBeenCalledWith('tok', 'bob');
      expect(comp.phase).toBe('done');
      expect(mockAuthStore.custody).toBe('self');
    });

    // FE-SAVESESSION-API-MISUSE-SWEEP: the link-account path used to pass
    // six positional args to _saveSession() (silently ignored by the
    // no-arg implementation). Lock in the full pre-save state-reset.
    it('sets full auth state including expiresAt before calling no-arg _saveSession()', async () => {
      mockLinkExistingAccount.mockResolvedValue({
        data: {
          token: 'jwt-link',
          username: 'bob',
          expires_at: '2099-06-15T00:00:00.000Z',
          accreditation: { link: 'acc' },
        },
      });
      // Snapshot-capturing stub: see submitCreateAccount full-state spec
      // above for rationale. Catches a refactor that moves any of the
      // pre-save assignments to AFTER _saveSession().
      let savedSnapshot;
      mockAuthStore._saveSession = vi.fn(function () {
        savedSnapshot = { ...mockAuthStore };
      });

      const comp = createComponent({ auth_token: 'tok', email: 'e@x.com' });
      comp.init();
      comp.chooseLink();
      comp.hiveUsername = 'Bob';

      await comp.handleLinkAccount();

      expect(savedSnapshot).toBeDefined();
      expect(savedSnapshot.token).toBe('jwt-link');
      expect(savedSnapshot.username).toBe('bob');
      expect(savedSnapshot.isConnected).toBe(true);
      expect(savedSnapshot.isAccredited).toBe(true);
      expect(savedSnapshot.accreditation).toEqual({ link: 'acc' });
      expect(savedSnapshot.custody).toBe('self');
      // Load-bearing: expiresAt MUST be on the store BEFORE the no-arg
      // _saveSession() reads from it.
      expect(savedSnapshot.expiresAt).toBe('2099-06-15T00:00:00.000Z');
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith();
    });

    it('does nothing without hiveUsername', async () => {
      const comp = createComponent({ auth_token: 'tok', email: 'e@x.com' });
      comp.init();
      comp.hiveUsername = '';
      await comp.handleLinkAccount();
      expect(mockLinkExistingAccount).not.toHaveBeenCalled();
    });

    it('requires keychain installed', async () => {
      mockIsKeychainInstalled.mockReturnValue(false);
      const comp = createComponent({ auth_token: 'tok', email: 'e@x.com' });
      comp.init();
      comp.hiveUsername = 'bob';

      await comp.handleLinkAccount();

      expect(comp.error).toBe('seedPhrase.keychainRequired');
      expect(mockLinkExistingAccount).not.toHaveBeenCalled();
    });

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: failure surfaces a
    // generic localized message; raw err reaches console.warn.
    it('sanitizes failure: generic message to DOM, raw err to console.warn', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      const leaky = new Error('link failed hex=deadbeefcafebabe');
      mockLinkExistingAccount.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent({ auth_token: 'tok', email: 'e@x.com' });
      comp.init();
      comp.chooseLink();
      comp.hiveUsername = 'Bob';

      await comp.handleLinkAccount();

      expect(comp.error).toBe('seedPhrase.linkAccountFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(comp.isSubmitting).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });
  });

  describe('handleResume', () => {
    it('calls resumeSignup and transitions to choose phase', async () => {
      mockResumeSignup.mockResolvedValue({ data: { flow: 'choose', auth_token: 'a2', email: 'x@x.com' } });
      const comp = createComponent({});
      comp.phase = 'error';
      comp.resumeEmail = 'x@x.com';
      comp.resumePassword = 'pass';

      await comp.handleResume();

      expect(mockResumeSignup).toHaveBeenCalledWith('x@x.com', 'pass');
      expect(comp.phase).toBe('choose');
      expect(comp.authToken).toBe('a2');
    });

    it('does nothing when fields empty', async () => {
      const comp = createComponent({});
      comp.resumeEmail = '';
      comp.resumePassword = '';
      await comp.handleResume();
      expect(mockResumeSignup).not.toHaveBeenCalled();
    });

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: failure surfaces a
    // generic localized message; raw err reaches console.warn.
    it('sanitizes failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('bad hex=deadbeefcafebabe');
      mockResumeSignup.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent({});
      comp.resumeEmail = 'x@x.com';
      comp.resumePassword = 'pass';

      await comp.handleResume();

      expect(comp.error).toBe('seedPhrase.resumeFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(comp.isResuming).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });
  });

  // UI-TEARDOWN-GUARD-SWEEP-EXTENSION: post-destroy() async continuations
  // must not write to component state. The create-account path derives keys
  // from a BIP39 mnemonic and makes a multi-second Hive broadcast; the user
  // easily navigates away mid-flight.
  describe('teardown', () => {
    it('verifyToken catch does not flip phase to error after destroy()', async () => {
      let rejectFn;
      mockVerifyEmail.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const comp = createComponent({ token: 'emailtok' });
      expect(comp.phase).toBe('verifying');
      comp.init();
      comp.destroy();
      rejectFn(new Error('late'));
      // Let the rejection + catch settle.
      await Promise.resolve();
      await Promise.resolve();
      // phase stays 'verifying' (not flipped to 'error') after destroy.
      expect(comp.phase).toBe('verifying');
    });

    it('submitCreateAccount catch does not set error after destroy()', async () => {
      let rejectFn;
      mockConfirmAccount.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const comp = createComponent();
      comp.mnemonic = 'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12';
      comp.seedWords = comp.mnemonic.split(' ');
      comp.authToken = 'tok';
      comp.username = 'alice';
      comp.usernameStatus = 'available';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = comp.submitCreateAccount();
      // Give deriveAllKeys a tick to resolve, so we're guaranteed to be
      // waiting on confirmAccount when destroy() fires.
      await Promise.resolve();
      await Promise.resolve();
      comp.destroy();
      rejectFn(new Error('late'));
      await pending;
      expect(comp.error).toBeNull();
      warnSpy.mockRestore();
    });

    it('handleLinkAccount catch does not set error after destroy()', async () => {
      let rejectFn;
      mockLinkExistingAccount.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const comp = createComponent();
      comp.authToken = 'tok';
      comp.hiveUsername = 'alice';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = comp.handleLinkAccount();
      comp.destroy();
      rejectFn(new Error('late'));
      await pending;
      expect(comp.error).toBeNull();
      warnSpy.mockRestore();
    });

    it('handleResume catch does not set error after destroy()', async () => {
      let rejectFn;
      mockResumeSignup.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const comp = createComponent();
      comp.resumeEmail = 'e@x.com';
      comp.resumePassword = 'pass';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = comp.handleResume();
      comp.destroy();
      rejectFn(new Error('late'));
      await pending;
      expect(comp.error).toBeNull();
      warnSpy.mockRestore();
    });
  });
});

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

    it('sets error and returns to username phase on failure', async () => {
      mockConfirmAccount.mockRejectedValue(new Error('creation failed'));

      const comp = createComponent({ auth_token: 'tok', email: 'e@x.com' });
      comp.init();
      comp.chooseCreate();
      comp.username = 'alice';
      comp.usernameStatus = 'available';

      await comp.submitCreateAccount();

      expect(comp.error).toBe('creation failed');
      expect(comp.phase).toBe('create-username');
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

    it('sets error on failure', async () => {
      mockResumeSignup.mockRejectedValue(new Error('bad'));
      const comp = createComponent({});
      comp.resumeEmail = 'x@x.com';
      comp.resumePassword = 'pass';

      await comp.handleResume();

      expect(comp.error).toBe('bad');
      expect(comp.isResuming).toBe(false);
    });
  });
});

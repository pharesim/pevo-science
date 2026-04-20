import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoginWithPassword = vi.fn();
const mockResendVerification = vi.fn();

vi.mock('../../src/api.js', () => ({
  loginWithPassword: (...args) => mockLoginWithPassword(...args),
  resendVerification: (...args) => mockResendVerification(...args),
}));

const mockAuthStore = { loginFromResponse: vi.fn() };
const mockRouterStore = { navigate: vi.fn() };

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
import { initSignInModal } from '../../src/components/sign-in-modal.js';

function createComponent() {
  initSignInModal();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  comp.$store = { auth: mockAuthStore, router: mockRouterStore };
  return comp;
}

describe('signInModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('prompt', () => {
    it('opens modal in choose mode and returns a promise', () => {
      const comp = createComponent();
      const p = comp.prompt();
      expect(comp.open).toBe(true);
      expect(comp.mode).toBe('choose');
      expect(p).toBeInstanceOf(Promise);
    });

    it('resets all fields on prompt', () => {
      const comp = createComponent();
      comp.value = 'old';
      comp.emailValue = 'old@email.com';
      comp.passwordValue = 'secret';
      comp.error = 'old error';
      comp.prompt();
      expect(comp.value).toBe('');
      expect(comp.emailValue).toBe('');
      expect(comp.passwordValue).toBe('');
      expect(comp.error).toBe(null);
    });
  });

  describe('confirm (keychain path)', () => {
    it('resolves with trimmed lowercase username', async () => {
      const comp = createComponent();
      const p = comp.prompt();
      comp.value = '  Alice  ';
      comp.confirm();
      const result = await p;
      expect(result).toBe('alice');
      expect(comp.open).toBe(false);
    });

    it('sets error when username is empty', () => {
      const comp = createComponent();
      comp.prompt();
      comp.value = '   ';
      comp.confirm();
      expect(comp.error).toBe('signIn.usernameEmpty');
      expect(comp.open).toBe(true);
    });
  });

  describe('cancel', () => {
    it('resolves promise with null and closes modal', async () => {
      const comp = createComponent();
      const p = comp.prompt();
      comp.cancel();
      const result = await p;
      expect(result).toBe(null);
      expect(comp.open).toBe(false);
      expect(comp.mode).toBe('choose');
    });
  });

  describe('handleEmailLogin', () => {
    it('sets error when fields are empty', async () => {
      const comp = createComponent();
      comp.emailValue = '';
      comp.passwordValue = '';
      await comp.handleEmailLogin();
      expect(comp.emailError).toBe('signIn.fillAllFields');
      expect(mockLoginWithPassword).not.toHaveBeenCalled();
    });

    it('calls loginWithPassword and stores session on success', async () => {
      mockLoginWithPassword.mockResolvedValue({ data: { token: 'abc' } });
      const comp = createComponent();
      comp.prompt(); // open so _resolve is set
      comp.emailValue = 'test@example.com';
      comp.passwordValue = 'pass123';
      await comp.handleEmailLogin();
      expect(mockLoginWithPassword).toHaveBeenCalledWith('test@example.com', 'pass123');
      expect(mockAuthStore.loginFromResponse).toHaveBeenCalledWith({ token: 'abc' });
      expect(comp.open).toBe(false);
    });

    it('navigates to signup/verify on PENDING_SIGNUP', async () => {
      const err = new Error('Pending');
      err.code = 'PENDING_SIGNUP';
      err.data = { auth_token: 'tok', email: 'e@x.com' };
      mockLoginWithPassword.mockRejectedValue(err);
      const comp = createComponent();
      comp.prompt();
      comp.emailValue = 'e@x.com';
      comp.passwordValue = 'pass';
      await comp.handleEmailLogin();
      expect(mockRouterStore.navigate).toHaveBeenCalledWith(
        expect.stringContaining('/signup/verify')
      );
    });

    it('switches to unverified mode on PENDING_UNVERIFIED', async () => {
      const err = new Error('Unverified');
      err.code = 'PENDING_UNVERIFIED';
      mockLoginWithPassword.mockRejectedValue(err);
      const comp = createComponent();
      comp.emailValue = 'e@x.com';
      comp.passwordValue = 'pass';
      await comp.handleEmailLogin();
      expect(comp.mode).toBe('unverified');
    });

    it('shows generic error for other failures', async () => {
      mockLoginWithPassword.mockRejectedValue(new Error('Bad creds'));
      const comp = createComponent();
      comp.emailValue = 'e@x.com';
      comp.passwordValue = 'pass';
      await comp.handleEmailLogin();
      expect(comp.emailError).toBe('Bad creds');
    });
  });

  describe('handleResendVerification', () => {
    it('calls resendVerification and sets success', async () => {
      mockResendVerification.mockResolvedValue({});
      const comp = createComponent();
      comp.emailValue = 'e@x.com';
      comp.passwordValue = 'pass';
      await comp.handleResendVerification();
      expect(mockResendVerification).toHaveBeenCalledWith('e@x.com', 'pass');
      expect(comp.resendSuccess).toBe(true);
    });

    it('sets error on resend failure', async () => {
      mockResendVerification.mockRejectedValue(new Error('Rate limited'));
      const comp = createComponent();
      comp.emailValue = 'e@x.com';
      comp.passwordValue = 'pass';
      await comp.handleResendVerification();
      expect(comp.emailError).toBe('Rate limited');
    });

    it('does not double-send while resending', async () => {
      let resolveFirst;
      mockResendVerification.mockImplementation(() => new Promise((r) => { resolveFirst = r; }));
      const comp = createComponent();
      comp.emailValue = 'e@x.com';
      comp.passwordValue = 'pass';
      const p1 = comp.handleResendVerification();
      comp.handleResendVerification(); // second call while first is pending
      resolveFirst({});
      await p1;
      expect(mockResendVerification).toHaveBeenCalledTimes(1);
    });
  });
});

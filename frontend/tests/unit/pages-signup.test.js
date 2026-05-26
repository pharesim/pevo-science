import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSubmitSignup = vi.fn();
const mockLoginWithPassword = vi.fn();
const mockResendVerification = vi.fn();
const mockStartOrcid = vi.fn();

vi.mock('../../src/api.js', () => ({
  submitSignup: (...args) => mockSubmitSignup(...args),
  loginWithPassword: (...args) => mockLoginWithPassword(...args),
  resendVerification: (...args) => mockResendVerification(...args),
  startOrcid: (...args) => mockStartOrcid(...args),
}));

const mockAuthStore = { isConnected: false, loginFromResponse: vi.fn() };
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
import { initSignupPage } from '../../src/pages/signup.js';

function createComponent() {
  initSignupPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  // Provide $t stub
  comp.$t = (key) => key;
  return comp;
}

describe('signupPage', () => {
  let localStorageData;
  let sessionStorageData;

  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.stubGlobal('window', { ...globalThis.window, location: { href: '' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('passwordValid', () => {
    it('returns false for short passwords', () => {
      const comp = createComponent();
      comp.password = 'Abc1';
      expect(comp.passwordValid).toBe(false);
    });

    it('returns false without lowercase', () => {
      const comp = createComponent();
      comp.password = 'ABCDEFGH1X';
      expect(comp.passwordValid).toBe(false);
    });

    it('returns false without uppercase', () => {
      const comp = createComponent();
      comp.password = 'abcdefgh1x';
      expect(comp.passwordValid).toBe(false);
    });

    it('returns false without digit', () => {
      const comp = createComponent();
      comp.password = 'Abcdefghxx';
      expect(comp.passwordValid).toBe(false);
    });

    it('returns true for valid password', () => {
      const comp = createComponent();
      comp.password = 'Abcdefgh1x';
      expect(comp.passwordValid).toBe(true);
    });
  });

  describe('canSubmit', () => {
    it('returns truthy when all fields valid', () => {
      const comp = createComponent();
      comp.email = 'test@example.com';
      comp.fullName = 'Jane Doe';
      comp.institution = 'MIT';
      comp.field = 'Physics';
      comp.password = 'Abcdefgh1x';
      comp.passwordConfirm = 'Abcdefgh1x';
      expect(comp.canSubmit).toBeTruthy();
    });

    it('returns falsy with invalid password', () => {
      const comp = createComponent();
      comp.email = 'test@example.com';
      comp.fullName = 'Jane Doe';
      comp.institution = 'MIT';
      comp.field = 'Physics';
      comp.password = 'short';
      comp.passwordConfirm = 'short';
      expect(comp.canSubmit).toBeFalsy();
    });
  });

  describe('handleSubmit', () => {
    it('calls submitSignup with correct data', async () => {
      mockSubmitSignup.mockResolvedValue({});
      const comp = createComponent();
      comp.email = ' test@example.com ';
      comp.fullName = ' Jane Doe ';
      comp.institution = ' MIT ';
      comp.field = ' Physics ';
      comp.password = 'Abcdefgh1x';
      comp.passwordConfirm = 'Abcdefgh1x';

      await comp.handleSubmit();

      expect(mockSubmitSignup).toHaveBeenCalledWith({
        email: 'test@example.com',
        password: 'Abcdefgh1x',
        full_name: 'Jane Doe',
        institution: 'MIT',
        field: 'Physics',
        orcid_token: undefined,
      });
      expect(comp.submitted).toBe(true);
    });

    it('SEC-004: ORCID branch submits password: null (not the password field)', async () => {
      mockSubmitSignup.mockResolvedValue({});
      const comp = createComponent();
      comp.email = 'x@x.com';
      comp.fullName = 'A';
      comp.institution = 'B';
      comp.field = 'C';
      comp.orcidToken = 'orcid-nonce-123';
      // Password fields are hidden on the ORCID branch; these should NOT be sent.
      // (In production they're empty; we set them here to guard against regression.)
      comp.password = 'LeakedPass1x';
      comp.passwordConfirm = 'LeakedPass1x';

      await comp.handleSubmit();

      expect(mockSubmitSignup).toHaveBeenCalledWith({
        email: 'x@x.com',
        password: null,
        full_name: 'A',
        institution: 'B',
        field: 'C',
        orcid_token: 'orcid-nonce-123',
      });
    });

    it('does nothing if canSubmit is false', async () => {
      const comp = createComponent();
      comp.email = '';
      await comp.handleSubmit();
      expect(mockSubmitSignup).not.toHaveBeenCalled();
    });

    it('does nothing if already submitting', async () => {
      const comp = createComponent();
      comp.email = 'x@x.com';
      comp.fullName = 'A';
      comp.institution = 'B';
      comp.field = 'C';
      comp.password = 'Abcdefgh1x';
      comp.passwordConfirm = 'Abcdefgh1x';
      comp.isSubmitting = true;
      await comp.handleSubmit();
      expect(mockSubmitSignup).not.toHaveBeenCalled();
    });

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: unknown-code failures
    // surface a generic localized message; raw err reaches console.warn.
    it('sanitizes generic failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = { message: 'Server error hex=deadbeefcafebabe', code: 'UNKNOWN' };
      mockSubmitSignup.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.email = 'x@x.com';
      comp.fullName = 'A';
      comp.institution = 'B';
      comp.field = 'C';
      comp.password = 'Abcdefgh1x';
      comp.passwordConfirm = 'Abcdefgh1x';

      await comp.handleSubmit();

      expect(comp.error).toBe('signup.submitFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(comp.isSubmitting).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });

    it('handles DUPLICATE by attempting login and navigating to /papers on success', async () => {
      mockSubmitSignup.mockRejectedValue({ message: 'exists', code: 'DUPLICATE' });
      const loginData = { token: 't', username: 'u', expires_at: '2099-01-01' };
      mockLoginWithPassword.mockResolvedValue({ data: loginData });

      const comp = createComponent();
      comp.email = 'x@x.com';
      comp.fullName = 'A';
      comp.institution = 'B';
      comp.field = 'C';
      comp.password = 'Abcdefgh1x';
      comp.passwordConfirm = 'Abcdefgh1x';

      await comp.handleSubmit();

      expect(mockLoginWithPassword).toHaveBeenCalledWith('x@x.com', 'Abcdefgh1x');
      // is_accredited / accreditation explicit overrides prevent cross-user
      // re-login from leaking stale accreditation state per the loginFromResponse
      // preserve-on-undefined contract.
      expect(mockAuthStore.loginFromResponse).toHaveBeenCalledWith({
        ...loginData,
        is_accredited: false,
        accreditation: null,
      });
      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/papers');
    });

    it('routes _resolveExistingAccount PENDING_SIGNUP to /signup/verify resume path', async () => {
      // The login 409 carries only { email } — the auth_token was removed
      // because it is the /confirm + /link row-lookup credential and must not
      // ride in the URL. The redirect drives the user to the resume form
      // (?resume=1), never carries auth_token, and prefills the email hint.
      mockSubmitSignup.mockRejectedValue({ code: 'DUPLICATE' });
      mockLoginWithPassword.mockRejectedValue({
        code: 'PENDING_SIGNUP',
        data: { email: 'x@x.com' },
      });

      const comp = createComponent();
      comp.email = 'x@x.com';
      comp.fullName = 'A';
      comp.institution = 'B';
      comp.field = 'C';
      comp.password = 'Abcdefgh1x';
      comp.passwordConfirm = 'Abcdefgh1x';

      await comp.handleSubmit();

      const navArg = mockRouterStore.navigate.mock.calls[0][0];
      expect(navArg).toContain('/signup/verify?');
      expect(navArg).toContain('resume=1');
      expect(navArg).toContain('email=');
      expect(navArg).not.toContain('auth_token');
    });

    it('falls back to /login for non-PENDING_SIGNUP login errors during DUPLICATE resolution', async () => {
      mockSubmitSignup.mockRejectedValue({ code: 'DUPLICATE' });
      mockLoginWithPassword.mockRejectedValue({ code: 'INVALID_CREDENTIALS' });

      const comp = createComponent();
      comp.email = 'x@x.com';
      comp.fullName = 'A';
      comp.institution = 'B';
      comp.field = 'C';
      comp.password = 'Abcdefgh1x';
      comp.passwordConfirm = 'Abcdefgh1x';

      await comp.handleSubmit();

      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/login');
    });

    it('handles VALIDATION_ERROR without orcid token', async () => {
      mockSubmitSignup.mockRejectedValue({ message: 'need orcid', code: 'VALIDATION_ERROR' });

      const comp = createComponent();
      comp.email = 'x@x.com';
      comp.fullName = 'A';
      comp.institution = 'B';
      comp.field = 'C';
      comp.password = 'Abcdefgh1x';
      comp.passwordConfirm = 'Abcdefgh1x';
      comp.orcidToken = '';

      await comp.handleSubmit();

      expect(comp.error).toBe('signup.orcidOrInstitutional');
    });

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: with an ORCID token
    // present, VALIDATION_ERROR falls through to the generic-message +
    // console.warn sanitization path. Guards against the `&& !orcidToken`
    // being removed from the branch.
    it('sanitizes VALIDATION_ERROR fall-through with orcidToken: generic to DOM, raw to console.warn', async () => {
      const leaky = Object.assign(new Error('server complained hex=deadbeefcafebabe'), { code: 'VALIDATION_ERROR' });
      mockSubmitSignup.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      comp.email = 'x@x.com';
      comp.fullName = 'A';
      comp.institution = 'B';
      comp.field = 'C';
      comp.password = 'Abcdefgh1x';
      comp.passwordConfirm = 'Abcdefgh1x';
      comp.orcidToken = 'tok123';

      await comp.handleSubmit();

      expect(comp.error).toBe('signup.submitFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });
  });

  describe('handleOrcidVerify', () => {
    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: failure surfaces a
    // generic localized message; raw err reaches console.warn.
    it('sanitizes failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('network hex=deadbeefcafebabe');
      mockStartOrcid.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();

      await comp.handleOrcidVerify();

      expect(comp.error).toBe('signup.orcidStartFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(comp.orcidLoading).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });
  });

  describe('handleOrcidSignup', () => {
    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND hold item #3:
    // handleOrcidSignup has its own catch block independent from
    // handleOrcidVerify. Both share the signup.orcidStartFailed i18n key
    // but regress independently, so it needs its own invariant test.
    it('sanitizes failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('start orcid failed hex=deadbeefcafebabe');
      mockStartOrcid.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();

      await comp.handleOrcidSignup();

      expect(comp.error).toBe('signup.orcidStartFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(comp.orcidLoading).toBe(false);
      expect(sessionStorage.removeItem).toHaveBeenCalledWith('pevo_orcid_mode');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });
  });

  describe('handleResendVerification', () => {
    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: failure surfaces a
    // generic localized message; raw err reaches console.warn.
    it('sanitizes failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('fail hex=deadbeefcafebabe');
      mockResendVerification.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.email = 'x@x.com';
      comp.password = 'p';

      await comp.handleResendVerification();

      expect(comp.error).toBe('signup.resendFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(comp.isResending).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });

    it('is a no-op on the ORCID branch (no empty-password POST)', async () => {
      const comp = createComponent();
      comp.email = 'x@x.com';
      comp.password = '';
      comp.orcidToken = 'orcid-token';

      await comp.handleResendVerification();

      expect(mockResendVerification).not.toHaveBeenCalled();
      expect(comp.isResending).toBe(false);
    });
  });

  describe('init', () => {
    it('restores draft from localStorage', () => {
      localStorageData.pevo_signup_draft = JSON.stringify({
        email: 'saved@x.com',
        fullName: 'Saved',
        institution: 'Inst',
        field: 'F',
      });
      const comp = createComponent();
      comp.init();
      expect(comp.email).toBe('saved@x.com');
      expect(comp.fullName).toBe('Saved');
      expect(localStorage.removeItem).toHaveBeenCalledWith('pevo_signup_draft');
    });

    it('SEC-004: does NOT restore password from legacy drafts', () => {
      // Regression guard on the SEC-004 fix: even if an older draft
      // contains password fields (e.g., user had an in-flight round-trip
      // from an older UI), init() must never rehydrate them.
      localStorageData.pevo_signup_draft = JSON.stringify({
        email: 'saved@x.com',
        fullName: 'Saved',
        institution: 'Inst',
        field: 'F',
        password: 'hunter2Leaked',
        passwordConfirm: 'hunter2Leaked',
      });
      const comp = createComponent();
      comp.init();
      expect(comp.email).toBe('saved@x.com');
      expect(comp.password).toBe('');
      expect(comp.passwordConfirm).toBe('');
    });

    it('restores orcid from localStorage', () => {
      localStorageData.pevo_signup_orcid_token = 'orcid-tok';
      localStorageData.pevo_signup_orcid_id = '0000-0002';
      const comp = createComponent();
      comp.init();
      expect(comp.orcidToken).toBe('orcid-tok');
      expect(comp.orcidId).toBe('0000-0002');
    });
  });

  describe('handleOrcidVerify - draft payload (SEC-004)', () => {
    it('persists only non-sensitive fields to pevo_signup_draft', async () => {
      mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth' });
      const comp = createComponent();
      comp.email = 'user@x.com';
      comp.fullName = 'User';
      comp.institution = 'Inst';
      comp.field = 'F';
      comp.password = 'Abcdefgh1x';
      comp.passwordConfirm = 'Abcdefgh1x';

      await comp.handleOrcidVerify();

      expect(localStorage.setItem).toHaveBeenCalledWith(
        'pevo_signup_draft',
        expect.any(String),
      );
      const draft = JSON.parse(localStorageData.pevo_signup_draft);
      expect(draft).toEqual({
        email: 'user@x.com',
        fullName: 'User',
        institution: 'Inst',
        field: 'F',
      });
      // Explicit: password must NOT be persisted.
      expect(draft).not.toHaveProperty('password');
      expect(draft).not.toHaveProperty('passwordConfirm');
    });
  });

  describe('canSubmit - ORCID branch (SEC-004)', () => {
    it('is truthy on ORCID branch even with no password', () => {
      const comp = createComponent();
      comp.email = 'x@x.com';
      comp.fullName = 'A';
      comp.institution = 'B';
      comp.field = 'C';
      comp.orcidToken = 'tok';
      comp.password = '';
      comp.passwordConfirm = '';
      expect(comp.canSubmit).toBeTruthy();
    });

    it('is falsy on non-ORCID branch with no password', () => {
      const comp = createComponent();
      comp.email = 'x@x.com';
      comp.fullName = 'A';
      comp.institution = 'B';
      comp.field = 'C';
      comp.orcidToken = '';
      comp.password = '';
      comp.passwordConfirm = '';
      expect(comp.canSubmit).toBeFalsy();
    });
  });

  // UI-TEARDOWN-GUARD-SWEEP-EXTENSION: post-destroy() async continuations
  // must not write to component state. The DUPLICATE branch is especially
  // sensitive because it chains `_resolveExistingAccount() → loginWithPassword`
  // on top of the already-resolved submitSignup catch.
  describe('teardown', () => {
    it('handleSubmit catch does not set error/submitted after destroy()', async () => {
      let rejectFn;
      mockSubmitSignup.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const comp = createComponent();
      comp.email = 'x@y.com';
      comp.fullName = 'A';
      comp.institution = 'B';
      comp.field = 'C';
      comp.password = 'Abcdefgh1x';
      comp.passwordConfirm = 'Abcdefgh1x';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = comp.handleSubmit();
      comp.destroy();
      rejectFn(new Error('late'));
      await pending;
      expect(comp.error).toBeNull();
      expect(comp.submitted).toBe(false);
      warnSpy.mockRestore();
    });

    it('handleSubmit happy path does not set submitted after destroy()', async () => {
      let resolveFn;
      mockSubmitSignup.mockImplementationOnce(() => new Promise((resolve) => { resolveFn = resolve; }));
      const comp = createComponent();
      comp.email = 'x@y.com';
      comp.fullName = 'A';
      comp.institution = 'B';
      comp.field = 'C';
      comp.password = 'Abcdefgh1x';
      comp.passwordConfirm = 'Abcdefgh1x';
      const pending = comp.handleSubmit();
      comp.destroy();
      resolveFn();
      await pending;
      expect(comp.submitted).toBe(false);
    });

    it('DUPLICATE branch _resolveExistingAccount does not navigate after destroy()', async () => {
      // Signup rejects DUPLICATE → _resolveExistingAccount → loginWithPassword
      // rejects PENDING_SIGNUP. We destroy while loginWithPassword is still
      // pending. The post-await nav to /signup/verify must not fire.
      mockSubmitSignup.mockRejectedValueOnce(Object.assign(new Error('dupe'), { code: 'DUPLICATE' }));
      let rejectLogin;
      mockLoginWithPassword.mockImplementationOnce(() => new Promise((_, reject) => { rejectLogin = reject; }));
      const comp = createComponent();
      comp.email = 'x@y.com';
      comp.fullName = 'A';
      comp.institution = 'B';
      comp.field = 'C';
      comp.password = 'Abcdefgh1x';
      comp.passwordConfirm = 'Abcdefgh1x';
      const pending = comp.handleSubmit();
      // Flush the submit rejection + chained _resolveExistingAccount start.
      await Promise.resolve();
      await Promise.resolve();
      comp.destroy();
      rejectLogin(Object.assign(new Error('pending'), {
        code: 'PENDING_SIGNUP',
        data: { email: 'x@y.com' },
      }));
      await pending;
      expect(Alpine.store('router').navigate).not.toHaveBeenCalled();
    });

    it('handleResendVerification catch does not set error after destroy()', async () => {
      let rejectFn;
      mockResendVerification.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const comp = createComponent();
      comp.email = 'x@y.com';
      comp.password = 'Abcdefgh1x';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = comp.handleResendVerification();
      comp.destroy();
      rejectFn(new Error('late'));
      await pending;
      expect(comp.error).toBeNull();
      expect(comp.resendSuccess).toBe(false);
      warnSpy.mockRestore();
    });
  });
});

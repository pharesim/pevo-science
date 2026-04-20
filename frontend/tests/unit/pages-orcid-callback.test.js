import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockCompleteOrcid = vi.fn();

vi.mock('../../src/api.js', () => ({
  completeOrcid: (...args) => mockCompleteOrcid(...args),
}));

const mockAuthStore = {
  isConnected: true,
  token: '',
  username: '',
  custody: '',
  _saveSession: vi.fn(),
  _checkAccreditation: vi.fn(),
};
const mockRouterStore = { navigate: vi.fn(), query: { code: 'abc123', state: 'xyz' } };
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
import { initOrcidCallbackPage } from '../../src/pages/orcid-callback.js';

let localStorageData;

function createComponent() {
  initOrcidCallbackPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  return comp;
}

describe('orcidCallbackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageData = {};
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => localStorageData[key] ?? null),
      setItem: vi.fn((key, val) => { localStorageData[key] = val; }),
      removeItem: vi.fn((key) => { delete localStorageData[key]; }),
    });
    mockRouterStore.query = { code: 'abc123', state: 'xyz' };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('init - query param validation', () => {
    it('sets error when code is missing', () => {
      mockRouterStore.query = { state: 'xyz' };
      const comp = createComponent();
      comp.init();
      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.missingParams');
    });

    it('sets error when state is missing', () => {
      mockRouterStore.query = { code: 'abc' };
      const comp = createComponent();
      comp.init();
      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.missingParams');
    });

    it('sets error when code is too long (>100)', () => {
      mockRouterStore.query = { code: 'a'.repeat(101), state: 'xyz' };
      const comp = createComponent();
      comp.init();
      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.missingParams');
    });

    it('sets error when state is too long (>256)', () => {
      mockRouterStore.query = { code: 'abc', state: 'x'.repeat(257) };
      const comp = createComponent();
      comp.init();
      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.missingParams');
    });

    it('sets error when code is not a string', () => {
      mockRouterStore.query = { code: 123, state: 'xyz' };
      const comp = createComponent();
      comp.init();
      expect(comp.status).toBe('error');
    });
  });

  describe('init - backPath routing from localStorage mode', () => {
    it('sets backPath to /signup for signup mode', () => {
      localStorageData['pevo_orcid_mode'] = 'signup';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({ data: { mode: 'signup', orcid_token: 't', orcid_id: 'id' } });
      comp.init();
      expect(comp.backPath).toBe('/signup');
    });

    it('sets backPath to /login for login mode', () => {
      localStorageData['pevo_orcid_mode'] = 'login';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({ data: { mode: 'login', token: 't', username: 'u', expires_at: 'e' } });
      comp.init();
      expect(comp.backPath).toBe('/login');
    });

    it('sets backPath to /accreditation for accredit mode', () => {
      localStorageData['pevo_orcid_mode'] = 'accredit';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({ data: { mode: 'accredit', username: 'u' } });
      comp.init();
      expect(comp.backPath).toBe('/accreditation');
    });

    it('sets backPath to /settings for link mode', () => {
      localStorageData['pevo_orcid_mode'] = 'link';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({ data: { mode: 'link' } });
      comp.init();
      expect(comp.backPath).toBe('/settings');
    });

    it('defaults backPath to / for unknown mode', () => {
      localStorageData['pevo_orcid_mode'] = 'unknown';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({ data: { mode: 'accredit', username: 'u' } });
      comp.init();
      expect(comp.backPath).toBe('/');
    });

    it('removes pevo_orcid_mode from localStorage', () => {
      localStorageData['pevo_orcid_mode'] = 'accredit';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({ data: { mode: 'accredit', username: 'u' } });
      comp.init();
      expect(localStorage.removeItem).toHaveBeenCalledWith('pevo_orcid_mode');
    });
  });

  describe('_verify - mode routing', () => {
    it('handles signup mode: stores tokens and navigates', async () => {
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: { mode: 'signup', orcid_token: 'token123', orcid_id: '0000-0001', name: 'Jane' },
      });

      await comp._verify('code', 'state', 'signup');

      expect(localStorage.setItem).toHaveBeenCalledWith('pevo_signup_orcid_token', 'token123');
      expect(localStorage.setItem).toHaveBeenCalledWith('pevo_signup_orcid_id', '0000-0001');
      expect(localStorage.setItem).toHaveBeenCalledWith('pevo_signup_orcid_name', 'Jane');
      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/signup');
    });

    it('handles signup mode with recover return path', async () => {
      localStorageData['pevo_orcid_return_to'] = 'recover';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: { mode: 'signup', orcid_token: 't', orcid_id: 'id' },
      });

      await comp._verify('code', 'state', 'signup');
      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/recover');
    });

    it('handles login mode: sets auth store and navigates', async () => {
      vi.useFakeTimers();
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: { mode: 'login', token: 'jwt', username: 'alice', expires_at: '2025-01-01', custody: 'light' },
      });

      await comp._verify('code', 'state', 'login');

      expect(comp.status).toBe('login-success');
      expect(mockAuthStore.token).toBe('jwt');
      expect(mockAuthStore.username).toBe('alice');
      expect(mockAuthStore.isConnected).toBe(true);
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith('jwt', 'alice', '2025-01-01', false, null, 'light');
      expect(mockAuthStore._checkAccreditation).toHaveBeenCalled();

      vi.advanceTimersByTime(500);
      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/papers');
      vi.useRealTimers();
    });

    it('handles accredit mode: sets success and refreshes accreditation', async () => {
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: { mode: 'accredit', username: 'bob' },
      });

      await comp._verify('code', 'state', 'accredit');

      expect(comp.status).toBe('accredit-success');
      expect(comp.resultUsername).toBe('bob');
      expect(mockAuthStore._checkAccreditation).toHaveBeenCalled();
      expect(mockToastStore.show).toHaveBeenCalledWith('orcid.verificationSuccess', 'success');
    });

    it('handles link mode: sets localStorage flag and navigates to settings', async () => {
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: { mode: 'link' },
      });

      await comp._verify('code', 'state', 'link');

      expect(localStorage.setItem).toHaveBeenCalledWith('pevo_orcid_link_complete', '1');
      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/settings');
    });

    it('sets error for unknown mode', async () => {
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: { mode: 'unknown_mode' },
      });

      await comp._verify('code', 'state', '');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.verificationFailed');
    });
  });

  describe('_verify - error classification', () => {
    it('NO_ACCOUNT sets errorAction to signup', async () => {
      const comp = createComponent();
      const err = new Error('No account');
      err.code = 'NO_ACCOUNT';
      mockCompleteOrcid.mockRejectedValue(err);

      await comp._verify('code', 'state', 'login');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.noAccountFound');
      expect(comp.errorAction).toBe('signup');
    });

    it('VALIDATION_ERROR shows insufficient works message', async () => {
      const comp = createComponent();
      const err = new Error('Validation failed');
      err.code = 'VALIDATION_ERROR';
      mockCompleteOrcid.mockRejectedValue(err);

      await comp._verify('code', 'state', 'signup');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('signup.orcidInsufficientWorks');
      expect(comp.errorAction).toBe('');
    });

    it('generic error uses err.message', async () => {
      const comp = createComponent();
      mockCompleteOrcid.mockRejectedValue(new Error('Server down'));

      await comp._verify('code', 'state', 'accredit');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('Server down');
    });

    it('generic error without message uses i18n fallback', async () => {
      const comp = createComponent();
      mockCompleteOrcid.mockRejectedValue({});

      await comp._verify('code', 'state', 'accredit');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.verificationFailed');
    });
  });
});

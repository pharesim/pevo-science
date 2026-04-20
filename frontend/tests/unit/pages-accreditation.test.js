import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRequestAccreditation = vi.fn();
const mockStartOrcid = vi.fn();
const mockSearchAccounts = vi.fn();

vi.mock('../../src/api.js', () => ({
  requestAccreditation: (...args) => mockRequestAccreditation(...args),
  startOrcid: (...args) => mockStartOrcid(...args),
  searchAccounts: (...args) => mockSearchAccounts(...args),
}));

vi.mock('../../src/components/paper-card.js', () => ({
  formatDate: (d) => d || '',
}));

const mockAuthStore = {
  isConnected: true,
  isAccredited: false,
  username: 'testuser',
  accreditation: null,
  connect: vi.fn(),
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
import { initAccreditationPage } from '../../src/pages/accreditation.js';

function createComponent() {
  initAccreditationPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  return comp;
}

describe('accreditationPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.isConnected = true;
    mockAuthStore.isAccredited = false;
    mockAuthStore.username = 'testuser';
    mockAuthStore.accreditation = null;
    // Stub localStorage for tests that trigger handleOrcidVerify
    if (typeof globalThis.localStorage === 'undefined') {
      globalThis.localStorage = {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };
    }
  });

  describe('methodLabel', () => {
    it('returns email verification key for email', () => {
      const comp = createComponent();
      expect(comp.methodLabel('email')).toBe('researchers.emailVerification');
    });

    it('returns orcid key for orcid', () => {
      const comp = createComponent();
      expect(comp.methodLabel('orcid')).toBe('researchers.orcid');
    });

    it('returns web of trust key for wot', () => {
      const comp = createComponent();
      expect(comp.methodLabel('wot')).toBe('researchers.webOfTrust');
    });

    it('returns raw method string for unknown method', () => {
      const comp = createComponent();
      expect(comp.methodLabel('custom')).toBe('custom');
    });

    it('returns empty string for falsy method', () => {
      const comp = createComponent();
      expect(comp.methodLabel(null)).toBe('');
      expect(comp.methodLabel(undefined)).toBe('');
      expect(comp.methodLabel('')).toBe('');
    });
  });

  describe('handleSubmit', () => {
    it('does nothing when username is empty', async () => {
      const comp = createComponent();
      mockAuthStore.username = '';
      await comp.handleSubmit();
      expect(mockRequestAccreditation).not.toHaveBeenCalled();
    });

    it('does nothing when not connected', async () => {
      const comp = createComponent();
      mockAuthStore.isConnected = false;
      await comp.handleSubmit();
      expect(mockRequestAccreditation).not.toHaveBeenCalled();
    });

    it('sends form data and transitions to success', async () => {
      const comp = createComponent();
      comp.fullName = 'Jane Smith';
      comp.institution = 'MIT';
      comp.field = 'Physics';
      comp.email = 'jane@mit.edu';
      comp.orcid = '0000-0001-2345-6789';

      mockRequestAccreditation.mockResolvedValue({
        data: { message: 'Check your email' },
      });

      await comp.handleSubmit();

      expect(mockRequestAccreditation).toHaveBeenCalledWith({
        full_name: 'Jane Smith',
        institution: 'MIT',
        field: 'Physics',
        email: 'jane@mit.edu',
        orcid: '0000-0001-2345-6789',
      });
      expect(comp.step).toBe('success');
      expect(comp.resultMessage).toBe('Check your email');
    });

    it('sends empty string for orcid when not provided', async () => {
      const comp = createComponent();
      comp.fullName = 'Jane';
      comp.institution = 'MIT';
      comp.field = 'Physics';
      comp.email = 'jane@mit.edu';
      comp.orcid = '';

      mockRequestAccreditation.mockResolvedValue({ data: { message: 'OK' } });
      await comp.handleSubmit();

      expect(mockRequestAccreditation).toHaveBeenCalledWith(
        expect.objectContaining({ orcid: '' })
      );
    });

    it('transitions to error on failure', async () => {
      const comp = createComponent();
      comp.fullName = 'Jane';
      comp.institution = 'MIT';
      comp.field = 'Physics';
      comp.email = 'jane@mit.edu';

      mockRequestAccreditation.mockRejectedValue(new Error('Rate limited'));
      await comp.handleSubmit();

      expect(comp.step).toBe('error');
      expect(comp.errorMessage).toBe('Rate limited');
    });

    it('uses generic i18n key when error has no message', async () => {
      const comp = createComponent();
      comp.fullName = 'Jane';
      comp.institution = 'MIT';
      comp.field = 'Physics';
      comp.email = 'jane@mit.edu';

      mockRequestAccreditation.mockRejectedValue({});
      await comp.handleSubmit();

      expect(comp.step).toBe('error');
      expect(comp.errorMessage).toBe('common.accreditationFailed');
    });

    it('sets step to submitting during request', async () => {
      const comp = createComponent();
      comp.fullName = 'Jane';
      comp.institution = 'MIT';
      comp.field = 'Physics';
      comp.email = 'jane@mit.edu';

      let stepDuringFetch;
      mockRequestAccreditation.mockImplementation(() => {
        stepDuringFetch = comp.step;
        return Promise.resolve({ data: { message: 'OK' } });
      });
      await comp.handleSubmit();
      expect(stepDuringFetch).toBe('submitting');
    });
  });

  describe('handleOrcidVerify', () => {
    it('does nothing when username is empty', async () => {
      const comp = createComponent();
      mockAuthStore.username = '';
      await comp.handleOrcidVerify();
      expect(mockStartOrcid).not.toHaveBeenCalled();
    });

    it('does nothing when not connected', async () => {
      const comp = createComponent();
      mockAuthStore.isConnected = false;
      await comp.handleOrcidVerify();
      expect(mockStartOrcid).not.toHaveBeenCalled();
    });

    it('calls startOrcid with accredit mode', async () => {
      const comp = createComponent();
      // Prevent actual redirect by making startOrcid return a valid orcid.org URL
      mockStartOrcid.mockResolvedValue({
        redirect_url: 'https://orcid.org/oauth/authorize?code=abc',
      });

      await comp.handleOrcidVerify();

      expect(mockStartOrcid).toHaveBeenCalledWith('accredit');
    });

    it('rejects invalid redirect URLs (non-orcid hostname)', async () => {
      const comp = createComponent();
      mockStartOrcid.mockResolvedValue({
        redirect_url: 'https://evil.com/steal',
      });

      await comp.handleOrcidVerify();

      expect(comp.orcidLoading).toBe(false);
      expect(mockToastStore.show).toHaveBeenCalledWith('Invalid ORCID redirect URL', 'error');
    });

    it('shows toast on startOrcid failure and cleans up', async () => {
      const comp = createComponent();
      mockStartOrcid.mockRejectedValue(new Error('Network error'));
      await comp.handleOrcidVerify();

      expect(comp.orcidLoading).toBe(false);
      expect(mockToastStore.show).toHaveBeenCalledWith('Network error', 'error');
    });

    it('sets orcidLoading to true during the call', async () => {
      const comp = createComponent();
      let loadingDuringCall;
      mockStartOrcid.mockImplementation(() => {
        loadingDuringCall = comp.orcidLoading;
        return Promise.reject(new Error('fail'));
      });
      await comp.handleOrcidVerify();
      expect(loadingDuringCall).toBe(true);
      expect(comp.orcidLoading).toBe(false);
    });
  });
});

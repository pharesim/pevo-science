import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchVouchStatus = vi.fn();
const mockNotifyVouch = vi.fn();
const mockNotifyRetractVouch = vi.fn();
const mockBroadcastOps = vi.fn();

vi.mock('../../src/api.js', () => ({
  fetchVouchStatus: (...args) => mockFetchVouchStatus(...args),
  notifyVouch: (...args) => mockNotifyVouch(...args),
  notifyRetractVouch: (...args) => mockNotifyRetractVouch(...args),
}));

vi.mock('../../src/signer.js', () => ({
  broadcastOps: (...args) => mockBroadcastOps(...args),
}));

vi.mock('../../src/config.js', () => ({
  getAppTag: () => 'pevotest',
}));

const mockAuthStore = { isConnected: true, username: 'alice', custody: 'keychain' };
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
import { initVouchSection } from '../../src/components/vouch-section.js';

function createComponent(opts = {}) {
  initVouchSection();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory(opts);
  comp.$t = (key, params) => params ? `${key}:${JSON.stringify(params)}` : key;
  comp.$store = { auth: mockAuthStore, router: mockRouterStore };
  return comp;
}

describe('vouchSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.isConnected = true;
    mockAuthStore.username = 'alice';
    mockAuthStore.custody = 'keychain';
    mockBroadcastOps.mockResolvedValue(undefined);
    mockFetchVouchStatus.mockResolvedValue({ data: { vouches: [] } });
  });

  describe('computed properties', () => {
    it('currentUserHasVouched is false when no vouches', () => {
      const comp = createComponent({ targetUsername: 'bob' });
      comp.vouchStatus = { vouches: [] };
      expect(comp.currentUserHasVouched).toBe(false);
    });

    it('currentUserHasVouched is true when user has vouched', () => {
      const comp = createComponent({ targetUsername: 'bob' });
      comp.vouchStatus = { vouches: [{ voucher: 'alice' }] };
      expect(comp.currentUserHasVouched).toBe(true);
    });

    it('canVouch requires connected, non-light, not self, not already vouched, not accredited', () => {
      const comp = createComponent({ targetUsername: 'bob', isTargetAccredited: false });
      comp.vouchStatus = { vouches: [] };
      expect(comp.canVouch).toBe(true);
    });

    it('canVouch is false for light accounts', () => {
      mockAuthStore.custody = 'light';
      const comp = createComponent({ targetUsername: 'bob' });
      comp.vouchStatus = { vouches: [] };
      expect(comp.canVouch).toBe(false);
    });

    it('canVouch is false when vouching for self', () => {
      const comp = createComponent({ targetUsername: 'alice' });
      comp.vouchStatus = { vouches: [] };
      expect(comp.canVouch).toBe(false);
    });

    it('canVouch is false when target is accredited', () => {
      const comp = createComponent({ targetUsername: 'bob', isTargetAccredited: true });
      comp.vouchStatus = { vouches: [] };
      expect(comp.canVouch).toBe(false);
    });

    it('canRetract is true when user has vouched', () => {
      const comp = createComponent({ targetUsername: 'bob' });
      comp.vouchStatus = { vouches: [{ voucher: 'alice' }] };
      expect(comp.canRetract).toBe(true);
    });

    it('canRetract is false for light accounts', () => {
      mockAuthStore.custody = 'light';
      const comp = createComponent({ targetUsername: 'bob' });
      comp.vouchStatus = { vouches: [{ voucher: 'alice' }] };
      expect(comp.canRetract).toBe(false);
    });
  });

  describe('handleVouch', () => {
    it('broadcasts vouch custom_json and notifies backend', async () => {
      mockNotifyVouch.mockResolvedValue({ data: { accredited: false } });
      const comp = createComponent({ targetUsername: 'bob' });
      comp.vouchStatus = { vouches: [] };
      await comp.handleVouch();

      expect(mockBroadcastOps).toHaveBeenCalledWith('alice', [['custom_json', expect.objectContaining({
        id: 'pevotest',
      })]]);
      const json = JSON.parse(mockBroadcastOps.mock.calls[0][1][0][1].json);
      expect(json.action).toBe('vouch');
      expect(json.voucher).toBe('alice');
      expect(json.vouchee).toBe('bob');
      expect(comp.step).toBe('success');
    });

    it('shows accreditation message when vouch triggers accreditation', async () => {
      mockNotifyVouch.mockResolvedValue({ data: { accredited: true } });
      const comp = createComponent({ targetUsername: 'bob' });
      await comp.handleVouch();
      expect(comp.message).toContain('wot.accreditedViaWot');
    });

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: broadcast failure
    // surfaces a generic localized message; raw err reaches console.warn.
    it('sanitizes broadcast failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('Signing failed hex=deadbeefcafebabe');
      mockBroadcastOps.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent({ targetUsername: 'bob' });
      await comp.handleVouch();
      expect(comp.step).toBe('error');
      expect(comp.message).toBe('wot.vouchFailed');
      expect(comp.message).not.toContain('deadbeef');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });
  });

  describe('handleRetract', () => {
    it('broadcasts retract and notifies backend', async () => {
      mockNotifyRetractVouch.mockResolvedValue({ data: { revocations: [] } });
      const comp = createComponent({ targetUsername: 'bob' });
      comp.vouchStatus = { vouches: [{ voucher: 'alice' }] };
      await comp.handleRetract();

      const json = JSON.parse(mockBroadcastOps.mock.calls[0][1][0][1].json);
      expect(json.action).toBe('retract_vouch');
      expect(comp.step).toBe('success');
      expect(comp.showRetract).toBe(false);
    });

    it('includes revocations in message', async () => {
      mockNotifyRetractVouch.mockResolvedValue({ data: { revocations: ['carol'] } });
      const comp = createComponent({ targetUsername: 'bob' });
      await comp.handleRetract();
      expect(comp.message).toContain('carol');
    });

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: broadcast failure
    // surfaces a generic localized message; raw err reaches console.warn.
    it('sanitizes retract broadcast failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('Signing failed hex=deadbeefcafebabe');
      mockBroadcastOps.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent({ targetUsername: 'bob' });
      comp.vouchStatus = { vouches: [{ voucher: 'alice' }] };
      await comp.handleRetract();
      expect(comp.step).toBe('error');
      expect(comp.message).toBe('wot.retractFailed');
      expect(comp.message).not.toContain('deadbeef');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });
  });
});

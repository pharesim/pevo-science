import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockVerifyAccreditation = vi.fn();

vi.mock('../../src/api.js', () => ({
  verifyAccreditation: (...args) => mockVerifyAccreditation(...args),
}));

const mockRouterStore = { query: { token: 'tok123' }, navigate: vi.fn() };

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
import { initAccreditationVerifyPage } from '../../src/pages/accreditation-verify.js';

function createComponent() {
  initAccreditationVerifyPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  return comp;
}

describe('accreditationVerifyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRouterStore.query = { token: 'tok123' };
  });

  it('shows noToken when token missing', () => {
    mockRouterStore.query = {};
    const comp = createComponent();
    comp.init();
    expect(comp.state).toBe('error');
    expect(comp.errorMessage).toBe('verify.noToken');
  });

  it('transitions to success on successful verification', async () => {
    mockVerifyAccreditation.mockResolvedValue({ data: { username: 'alice' } });
    const comp = createComponent();
    comp.init();
    await vi.waitFor(() => expect(comp.state).toBe('success'));
    expect(comp.resultUsername).toBe('alice');
  });

  // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: failure surfaces a
  // generic localized message; raw err reaches console.warn.
  it('sanitizes failure: generic message to DOM, raw err to console.warn', async () => {
    const leaky = new Error('invalid hex=deadbeefcafebabe');
    mockVerifyAccreditation.mockRejectedValue(leaky);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const comp = createComponent();
    comp.init();

    await vi.waitFor(() => expect(comp.state).toBe('error'));
    expect(comp.errorMessage).toBe('verify.verificationFailed');
    expect(comp.errorMessage).not.toContain('deadbeef');
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][1]).toBe(leaky);
    warnSpy.mockRestore();
  });
});

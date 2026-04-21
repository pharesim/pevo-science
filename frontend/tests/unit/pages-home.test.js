import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRouterStore = { navigate: vi.fn() };
const mockAuthStore = { isConnected: true };

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
import { initHomePage } from '../../src/pages/home.js';

function createComponent() {
  initHomePage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  comp.$store = { auth: mockAuthStore, router: mockRouterStore };
  return comp;
}

describe('homePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes a navigate function', () => {
    const comp = createComponent();
    expect(typeof comp.navigate).toBe('function');
  });

  it('navigate(path) delegates to router store', () => {
    const comp = createComponent();
    comp.navigate('/foo');
    expect(mockRouterStore.navigate).toHaveBeenCalledWith('/foo');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchAccreditations = vi.fn();

vi.mock('../../src/api.js', () => ({
  fetchAccreditations: (...args) => mockFetchAccreditations(...args),
}));

vi.mock('../../src/components/paper-card.js', () => ({
  formatDate: (d) => d || '',
}));

vi.mock('../../src/components/pagination.js', () => ({
  paginationTemplate: '',
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
import { initResearchersPage } from '../../src/pages/researchers.js';
import { titleCaseDiscipline } from '../../src/lib/discipline-display.js';

function createComponent() {
  initResearchersPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  comp.$store = { router: mockRouterStore };
  return comp;
}

describe('researchersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchAccreditations.mockResolvedValue({ data: [], meta: { total: 0, limit: 12 } });
  });

  // Factory-exposure regression guard: the researcher row template renders
  // `r.field` via `titleCaseDiscipline(...)` and would fire a silent
  // ReferenceError at `x-text` evaluation if the helper isn't on the Alpine
  // data factory.
  describe('factory exposes titleCaseDiscipline', () => {
    it('factory().titleCaseDiscipline is identity-equal to the imported helper', () => {
      const comp = createComponent();
      expect(comp.titleCaseDiscipline).toBe(titleCaseDiscipline);
    });
  });

  describe('filter handlers', () => {
    it('onFieldChange resets currentPage to 1 and reloads', () => {
      const comp = createComponent();
      comp.currentPage = 4;
      comp.onFieldChange();
      expect(comp.currentPage).toBe(1);
      expect(mockFetchAccreditations).toHaveBeenCalled();
    });

    it('onInstitutionChange resets currentPage to 1 and reloads', () => {
      const comp = createComponent();
      comp.currentPage = 7;
      comp.onInstitutionChange();
      expect(comp.currentPage).toBe(1);
      expect(mockFetchAccreditations).toHaveBeenCalled();
    });
  });

  describe('goToPage', () => {
    it('updates currentPage and calls loadResearchers for valid page', () => {
      const comp = createComponent();
      comp.totalPages = 5;
      comp.currentPage = 1;
      comp.goToPage(3);
      expect(comp.currentPage).toBe(3);
      expect(mockFetchAccreditations).toHaveBeenCalled();
    });

    it('is a no-op for ellipsis, out-of-range, or below-1 pages', () => {
      const comp = createComponent();
      comp.totalPages = 5;
      comp.currentPage = 2;
      comp.goToPage('...');
      comp.goToPage(0);
      comp.goToPage(-1);
      comp.goToPage(99);
      expect(comp.currentPage).toBe(2);
      expect(mockFetchAccreditations).not.toHaveBeenCalled();
    });
  });

  describe('loadResearchers', () => {
    it('sets researchers and totalPages from response', async () => {
      const comp = createComponent();
      mockFetchAccreditations.mockResolvedValue({
        data: [{ username: 'alice' }],
        meta: { total: 36, limit: 12 },
      });
      await comp.loadResearchers();
      expect(comp.researchers).toEqual([{ username: 'alice' }]);
      expect(comp.totalPages).toBe(3);
      expect(comp.loading).toBe(false);
      expect(comp.error).toBeNull();
    });

    it('passes field and institution filters when set', async () => {
      const comp = createComponent();
      comp.fieldFilter = 'physics';
      comp.institutionFilter = 'MIT';
      await comp.loadResearchers();
      expect(mockFetchAccreditations).toHaveBeenCalledWith({
        page: 1,
        limit: 12,
        field: 'physics',
        institution: 'MIT',
      });
    });

    it('sets sanitized generic error on fetch failure (raw err -> console.warn, leak sentinel absent)', async () => {
      const comp = createComponent();
      const leaky = new Error('boom deadbeef-sentinel');
      mockFetchAccreditations.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await comp.loadResearchers();
      expect(comp.error).toBe('researchers.loadFailed');
      expect(comp.error).not.toContain('deadbeef-sentinel');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      expect(comp.loading).toBe(false);
    });

    it('resets researchers/totalPages/currentPage on fetch failure so retry starts fresh', async () => {
      const comp = createComponent();
      comp.researchers = [{ username: 'stale' }];
      comp.totalPages = 5;
      comp.currentPage = 4;
      mockFetchAccreditations.mockRejectedValue(new Error('boom'));
      await comp.loadResearchers();
      expect(comp.researchers).toEqual([]);
      expect(comp.totalPages).toBe(1);
      expect(comp.currentPage).toBe(1);
    });

    it('pushes a clean URL after fetch failure on /researchers so ?page= stops reflecting stale state', async () => {
      window.history.replaceState(null, '', '/en/researchers?page=4&field=physics');
      const comp = createComponent();
      comp.currentPage = 4;
      comp.fieldFilter = 'physics';
      mockFetchAccreditations.mockRejectedValue(new Error('boom'));
      const push = vi.spyOn(window.history, 'pushState');
      await comp.loadResearchers();
      expect(push).toHaveBeenCalled();
      const url = push.mock.calls[push.mock.calls.length - 1][2];
      expect(url).not.toContain('page=');
      // Causal chain: URL push reflects the reset currentPage=1.
      expect(comp.currentPage).toBe(1);
      expect(url).toContain('field=physics');
    });

    it('clamps totalPages to 1 when meta.limit is 0 (Infinity guard)', async () => {
      const comp = createComponent();
      mockFetchAccreditations.mockResolvedValue({
        data: [{ username: 'a' }],
        meta: { total: 42, limit: 0 },
      });
      await comp.loadResearchers();
      expect(comp.totalPages).toBe(1);
    });

    it('resets totalPages to 1 when response omits meta (empty result after filter change)', async () => {
      const comp = createComponent();
      comp.totalPages = 7;
      mockFetchAccreditations.mockResolvedValue({ data: [] });
      await comp.loadResearchers();
      expect(comp.totalPages).toBe(1);
    });
  });

  describe('URL sync', () => {
    beforeEach(() => {
      window.history.replaceState(null, '', '/en/researchers');
    });

    it('init seeds currentPage, field, institution from URL', () => {
      window.history.replaceState(null, '', '/en/researchers?page=2&field=physics&institution=MIT');
      const comp = createComponent();
      comp.init();
      expect(comp.currentPage).toBe(2);
      expect(comp.fieldFilter).toBe('physics');
      expect(comp.institutionFilter).toBe('MIT');
    });

    it('goToPage pushes ?page=N', () => {
      const comp = createComponent();
      comp.totalPages = 5;
      const push = vi.spyOn(window.history, 'pushState');
      comp.goToPage(3);
      const url = push.mock.calls[push.mock.calls.length - 1][2];
      expect(url).toContain('page=3');
    });

    it('onFieldChange pushes field filter and drops page', () => {
      const comp = createComponent();
      comp.currentPage = 4;
      comp.fieldFilter = 'biology';
      const push = vi.spyOn(window.history, 'pushState');
      comp.onFieldChange();
      const url = push.mock.calls[push.mock.calls.length - 1][2];
      expect(url).toContain('field=biology');
      expect(url).not.toContain('page=');
    });

    it('_pushUrl with currentPage=1 and no filters produces a bare path (no query string)', () => {
      window.history.replaceState(null, '', '/en/researchers?page=4&field=physics');
      const comp = createComponent();
      comp.currentPage = 1;
      comp.fieldFilter = '';
      comp.institutionFilter = '';
      const push = vi.spyOn(window.history, 'pushState');
      comp._pushUrl();
      expect(push).toHaveBeenCalled();
      const url = push.mock.calls[push.mock.calls.length - 1][2];
      expect(url).not.toContain('?');
      expect(url).toBe(window.location.pathname);
    });

    it('popstate re-reads URL and calls loadResearchers without pushing', async () => {
      window.history.replaceState(null, '', '/en/researchers');
      const comp = createComponent();
      comp.init();
      await Promise.resolve();
      mockFetchAccreditations.mockClear();
      const push = vi.spyOn(window.history, 'pushState');

      // Simulate browser back/forward arriving at a different query string.
      window.history.replaceState(null, '', '/en/researchers?page=2&field=bio');
      window.dispatchEvent(new PopStateEvent('popstate'));

      expect(comp.currentPage).toBe(2);
      expect(comp.fieldFilter).toBe('bio');
      expect(mockFetchAccreditations).toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();

      comp.destroy();
    });

    it('popstate handler is inert when pathname has drifted off /researchers', () => {
      window.history.replaceState(null, '', '/en/researchers');
      const comp = createComponent();
      comp.init();
      mockFetchAccreditations.mockClear();

      // SPA router has navigated away before popstate fires.
      window.history.replaceState(null, '', '/en/papers?page=9');
      window.dispatchEvent(new PopStateEvent('popstate'));

      // currentPage must not be clobbered by a popstate for another page.
      expect(comp.currentPage).toBe(1);
      expect(mockFetchAccreditations).not.toHaveBeenCalled();

      comp.destroy();
    });

    it('does not register popstate when mounted off /researchers', () => {
      window.history.replaceState(null, '', '/en/other');
      const comp = createComponent();
      comp.init();
      mockFetchAccreditations.mockClear();

      window.dispatchEvent(new PopStateEvent('popstate'));
      expect(mockFetchAccreditations).not.toHaveBeenCalled();

      comp.destroy();
    });
  });

  describe('methodLabel', () => {
    it('maps each known verification method to its translation key', () => {
      const comp = createComponent();
      expect(comp.methodLabel('email')).toBe('researchers.emailVerification');
      expect(comp.methodLabel('orcid')).toBe('researchers.orcid');
      expect(comp.methodLabel('dao_vote')).toBe('researchers.daoVote');
      expect(comp.methodLabel('wot')).toBe('researchers.webOfTrust');
      expect(comp.methodLabel('web_of_trust')).toBe('researchers.webOfTrust');
      expect(comp.methodLabel('pgp')).toBe('researchers.pgpVerification');
      expect(comp.methodLabel('personal')).toBe('researchers.personalVerification');
    });

    it('returns the raw method when unknown', () => {
      const comp = createComponent();
      expect(comp.methodLabel('mystery')).toBe('mystery');
    });
  });
});

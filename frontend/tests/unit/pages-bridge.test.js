import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchBridgeLookup = vi.fn();
const mockFetchBridgeCheck = vi.fn();
const mockRegisterBridgePaper = vi.fn();

vi.mock('../../src/api.js', () => ({
  fetchBridgeLookup: (...args) => mockFetchBridgeLookup(...args),
  fetchBridgeCheck: (...args) => mockFetchBridgeCheck(...args),
  registerBridgePaper: (...args) => mockRegisterBridgePaper(...args),
}));

const mockAuthStore = {
  isConnected: true,
  isAccredited: true,
  username: 'testuser',
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
import { initBridgePage } from '../../src/pages/bridge.js';

function createComponent() {
  initBridgePage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  return comp;
}

describe('bridgePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.isConnected = true;
    mockAuthStore.isAccredited = true;
    mockAuthStore.username = 'testuser';
  });

  describe('filteredTaxonomy', () => {
    it('returns full taxonomy when search is empty', () => {
      const comp = createComponent();
      comp.disciplineSearch = '';
      const result = comp.filteredTaxonomy;
      expect(result.length).toBeGreaterThan(0);
      // Check that known fields exist
      expect(result.some((g) => g.field === 'Natural Sciences')).toBe(true);
    });

    it('returns full taxonomy when search is only whitespace', () => {
      const comp = createComponent();
      comp.disciplineSearch = '   ';
      expect(comp.filteredTaxonomy.length).toBeGreaterThan(0);
    });

    it('filters by subfield name (case-insensitive)', () => {
      const comp = createComponent();
      comp.disciplineSearch = 'physics';
      const result = comp.filteredTaxonomy;
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].subfields).toContain('Physics');
    });

    it('excludes groups with no matching subfields', () => {
      const comp = createComponent();
      comp.disciplineSearch = 'physics';
      const result = comp.filteredTaxonomy;
      result.forEach((group) => {
        expect(group.subfields.length).toBeGreaterThan(0);
      });
    });

    it('returns empty when no subfields match', () => {
      const comp = createComponent();
      comp.disciplineSearch = 'xyznonexistent';
      expect(comp.filteredTaxonomy).toEqual([]);
    });
  });

  describe('isDuplicate', () => {
    it('returns true when check.exists is true', () => {
      const comp = createComponent();
      comp.check = { exists: true, author: 'a', permlink: 'p' };
      expect(comp.isDuplicate).toBe(true);
    });

    it('returns false when check.exists is false', () => {
      const comp = createComponent();
      comp.check = { exists: false };
      expect(comp.isDuplicate).toBe(false);
    });

    it('returns false when check is null', () => {
      const comp = createComponent();
      comp.check = null;
      expect(comp.isDuplicate).toBeFalsy();
    });
  });

  describe('canRegister', () => {
    it('returns truthy when all conditions met', () => {
      const comp = createComponent();
      comp.lookup = { title: 'Paper' };
      comp.check = { exists: false };
      comp.discipline = 'Physics';
      comp.step = 'idle';
      expect(comp.canRegister).toBeTruthy();
    });

    it('returns falsy when no lookup', () => {
      const comp = createComponent();
      comp.lookup = null;
      comp.discipline = 'Physics';
      comp.step = 'idle';
      expect(comp.canRegister).toBeFalsy();
    });

    it('returns falsy when isDuplicate', () => {
      const comp = createComponent();
      comp.lookup = { title: 'Paper' };
      comp.check = { exists: true };
      comp.discipline = 'Physics';
      comp.step = 'idle';
      expect(comp.canRegister).toBeFalsy();
    });

    it('returns falsy when discipline is empty', () => {
      const comp = createComponent();
      comp.lookup = { title: 'Paper' };
      comp.check = { exists: false };
      comp.discipline = '';
      comp.step = 'idle';
      expect(comp.canRegister).toBeFalsy();
    });

    it('returns falsy when step is not idle', () => {
      const comp = createComponent();
      comp.lookup = { title: 'Paper' };
      comp.check = { exists: false };
      comp.discipline = 'Physics';
      comp.step = 'registering';
      expect(comp.canRegister).toBeFalsy();
    });
  });

  describe('prefillDiscipline', () => {
    it('does nothing when lookup is falsy', () => {
      const comp = createComponent();
      comp.prefillDiscipline(null);
      expect(comp.discipline).toBe('');
    });

    it('uses first subject when subjects exist', () => {
      const comp = createComponent();
      comp.prefillDiscipline({ subjects: ['Neuroscience', 'Biology'] });
      expect(comp.discipline).toBe('Neuroscience');
      expect(comp.disciplineSearch).toBe('Neuroscience');
    });

    it('falls back to normalized source_name when no subjects', () => {
      const comp = createComponent();
      comp.prefillDiscipline({ subjects: [], source_name: 'Journal of the Physics' });
      expect(comp.discipline).toBe('Physics');
    });

    it('strips "Frontiers in" prefix', () => {
      const comp = createComponent();
      comp.prefillDiscipline({ subjects: [], source_name: 'Frontiers in Neuroscience' });
      expect(comp.discipline).toBe('Neuroscience');
    });

    it('strips "Proceedings of the" prefix', () => {
      const comp = createComponent();
      comp.prefillDiscipline({ subjects: [], source_name: 'Proceedings of the ACM' });
      expect(comp.discipline).toBe('ACM');
    });

    it('capitalizes first letter', () => {
      const comp = createComponent();
      comp.prefillDiscipline({ subjects: [], source_name: 'journal of chemistry' });
      expect(comp.discipline).toBe('Chemistry');
    });

    it('does nothing if source_name is empty', () => {
      const comp = createComponent();
      comp.prefillDiscipline({ subjects: [], source_name: '' });
      expect(comp.discipline).toBe('');
    });

    it('does nothing if normalized name is >= 60 chars', () => {
      const comp = createComponent();
      const longName = 'A'.repeat(60);
      comp.prefillDiscipline({ subjects: [], source_name: longName });
      expect(comp.discipline).toBe('');
    });
  });

  describe('handleLookup', () => {
    it('does nothing when identifier is empty', async () => {
      const comp = createComponent();
      comp.identifier = '   ';
      await comp.handleLookup();
      expect(mockFetchBridgeLookup).not.toHaveBeenCalled();
    });

    it('calls both lookup and check in parallel', async () => {
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      mockFetchBridgeLookup.mockResolvedValue({ data: { title: 'Found', subjects: [] } });
      mockFetchBridgeCheck.mockResolvedValue({ data: { exists: false } });
      await comp.handleLookup();
      expect(mockFetchBridgeLookup).toHaveBeenCalledWith('10.1234/test');
      expect(mockFetchBridgeCheck).toHaveBeenCalledWith('10.1234/test');
      expect(comp.lookup).toEqual({ title: 'Found', subjects: [] });
      expect(comp.check).toEqual({ exists: false });
      expect(comp.lookingUp).toBe(false);
    });

    it('sets lookupError on INTERNAL_ERROR', async () => {
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      const err = new Error('fail');
      err.code = 'INTERNAL_ERROR';
      mockFetchBridgeLookup.mockRejectedValue(err);
      mockFetchBridgeCheck.mockResolvedValue({ data: {} });
      await comp.handleLookup();
      expect(comp.lookupError).toBe('bridge.lookupUnavailable');
      expect(comp.lookingUp).toBe(false);
    });

    it('sets generic lookupError for other errors', async () => {
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      mockFetchBridgeLookup.mockRejectedValue(new Error('fail'));
      mockFetchBridgeCheck.mockResolvedValue({ data: {} });
      await comp.handleLookup();
      expect(comp.lookupError).toBe('bridge.lookupFailed');
    });

    it('resets lookup and check before fetching', async () => {
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.lookup = { old: true };
      comp.check = { old: true };
      mockFetchBridgeLookup.mockResolvedValue({ data: { title: 'New' } });
      mockFetchBridgeCheck.mockResolvedValue({ data: { exists: false } });
      // Verify reset happens during the call
      let lookupDuringFetch;
      const origLookup = mockFetchBridgeLookup;
      mockFetchBridgeLookup.mockImplementation(() => {
        lookupDuringFetch = comp.lookup;
        return Promise.resolve({ data: { title: 'New' } });
      });
      await comp.handleLookup();
      expect(lookupDuringFetch).toBeNull();
    });
  });

  describe('handleRegister', () => {
    it('does nothing without username', async () => {
      const comp = createComponent();
      mockAuthStore.username = '';
      comp.discipline = 'Physics';
      await comp.handleRegister();
      expect(mockRegisterBridgePaper).not.toHaveBeenCalled();
    });

    it('does nothing without discipline', async () => {
      const comp = createComponent();
      comp.discipline = '';
      await comp.handleRegister();
      expect(mockRegisterBridgePaper).not.toHaveBeenCalled();
    });

    it('transitions to registering then success', async () => {
      vi.useFakeTimers();
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.discipline = 'Physics';
      comp.keywordsText = 'quantum, optics';
      comp.language = 'en';
      mockRegisterBridgePaper.mockResolvedValue({ data: { author: 'testuser', permlink: 'paper-1' } });

      await comp.handleRegister();
      expect(comp.step).toBe('success');
      expect(mockRegisterBridgePaper).toHaveBeenCalledWith({
        identifier: '10.1234/test',
        discipline: 'Physics',
        keywords: ['quantum', 'optics'],
        language: 'en',
      });
      vi.useRealTimers();
    });

    it('transitions to error on failure', async () => {
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.discipline = 'Physics';
      mockRegisterBridgePaper.mockRejectedValue(new Error('Server error'));
      await comp.handleRegister();
      expect(comp.step).toBe('error');
      expect(comp.errorMessage).toBe('Server error');
    });

    it('omits keywords when empty', async () => {
      vi.useFakeTimers();
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.discipline = 'Physics';
      comp.keywordsText = '';
      comp.language = '';
      mockRegisterBridgePaper.mockResolvedValue({ data: { author: 'testuser', permlink: 'p' } });
      await comp.handleRegister();
      expect(mockRegisterBridgePaper).toHaveBeenCalledWith({
        identifier: '10.1234/test',
        discipline: 'Physics',
        keywords: undefined,
        language: undefined,
      });
      vi.useRealTimers();
    });
  });

  describe('disciplineDisplayValue', () => {
    it('returns disciplineSearch when dropdown is open', () => {
      const comp = createComponent();
      comp.disciplineDropdownOpen = true;
      comp.disciplineSearch = 'phys';
      comp.discipline = 'Physics';
      expect(comp.disciplineDisplayValue).toBe('phys');
    });

    it('returns discipline when dropdown is closed and discipline is set', () => {
      const comp = createComponent();
      comp.disciplineDropdownOpen = false;
      comp.discipline = 'Physics';
      comp.disciplineSearch = 'phys';
      expect(comp.disciplineDisplayValue).toBe('Physics');
    });

    it('returns disciplineSearch when dropdown is closed and no discipline', () => {
      const comp = createComponent();
      comp.disciplineDropdownOpen = false;
      comp.discipline = '';
      comp.disciplineSearch = 'phys';
      expect(comp.disciplineDisplayValue).toBe('phys');
    });
  });
});

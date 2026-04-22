import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDisciplineFilter } from '../../src/lib/discipline-filter.js';

vi.mock('../../src/api.js', () => ({
  fetchDisciplines: vi.fn(),
}));

import { fetchDisciplines } from '../../src/api.js';

describe('createDisciplineFilter', () => {
  beforeEach(() => {
    fetchDisciplines.mockReset();
  });

  describe('initial state', () => {
    it('defaults stateKey to "discipline"', () => {
      const state = createDisciplineFilter();
      expect(state).toHaveProperty('discipline', '');
      expect(state.disciplines).toEqual([]);
      expect(state.disciplinesLoadFailed).toBe(false);
    });

    it('honors a custom stateKey', () => {
      const state = createDisciplineFilter({ stateKey: 'disciplineFilter' });
      expect(state).toHaveProperty('disciplineFilter', '');
      expect(state).not.toHaveProperty('discipline');
    });

    it('keeps state instances independent (no shared arrays across spreads)', () => {
      const a = createDisciplineFilter();
      const b = createDisciplineFilter();
      a.disciplines.push({ canon_name: 'physics' });
      expect(b.disciplines).toEqual([]);
    });
  });

  describe('loadDisciplines', () => {
    it('assigns backend rows verbatim on success', async () => {
      const rows = [
        { canon_name: 'physics', display_name: 'Physics', paper_count: 5 },
        { canon_name: 'biology', display_name: 'Biology', paper_count: 3 },
      ];
      fetchDisciplines.mockResolvedValue({ data: rows });
      const state = createDisciplineFilter();
      await state.loadDisciplines();
      expect(state.disciplines).toEqual(rows);
      expect(state.disciplinesLoadFailed).toBe(false);
    });

    it('treats missing data as empty array', async () => {
      fetchDisciplines.mockResolvedValue({});
      const state = createDisciplineFilter();
      await state.loadDisciplines();
      expect(state.disciplines).toEqual([]);
      expect(state.disciplinesLoadFailed).toBe(false);
    });

    it('flips disciplinesLoadFailed and warns once on rejection (no throw)', async () => {
      const err = new Error('disciplines down');
      fetchDisciplines.mockRejectedValue(err);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const state = createDisciplineFilter();
      await expect(state.loadDisciplines()).resolves.toBeUndefined();
      expect(state.disciplinesLoadFailed).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith('[loadDisciplines]', err);
      warnSpy.mockRestore();
    });

    it('resets a stuck-true disciplinesLoadFailed flag on a subsequent success', async () => {
      const state = createDisciplineFilter();
      state.disciplinesLoadFailed = true;
      fetchDisciplines.mockResolvedValue({
        data: [{ canon_name: 'physics', display_name: 'Physics', paper_count: 1 }],
      });
      await state.loadDisciplines();
      expect(state.disciplinesLoadFailed).toBe(false);
    });

    it('uses the custom stateKey without mutating the wrong field', async () => {
      fetchDisciplines.mockResolvedValue({ data: [] });
      const state = createDisciplineFilter({ stateKey: 'disciplineFilter' });
      await state.loadDisciplines();
      expect(state.disciplineFilter).toBe('');
      expect(state.disciplines).toEqual([]);
    });

    it('bails after teardown when consumer sets _mounted=false (happy path)', async () => {
      let resolve;
      fetchDisciplines.mockReturnValue(new Promise((r) => { resolve = r; }));
      const state = createDisciplineFilter();
      const p = state.loadDisciplines();
      state._mounted = false;
      resolve({ data: [{ canon_name: 'physics', display_name: 'Physics', paper_count: 1 }] });
      await p;
      expect(state.disciplines).toEqual([]);
    });

    it('bails after teardown when consumer sets _mounted=false (error path)', async () => {
      let reject;
      fetchDisciplines.mockReturnValue(new Promise((_, r) => { reject = r; }));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const state = createDisciplineFilter();
      const p = state.loadDisciplines();
      state._mounted = false;
      reject(new Error('boom'));
      await p;
      expect(state.disciplinesLoadFailed).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('_syncDisciplineFromUrl', () => {
    it('lowercases the ?discipline= param into the configured stateKey', () => {
      const state = createDisciplineFilter();
      state._syncDisciplineFromUrl(new URLSearchParams('discipline=PHYSICS'));
      expect(state.discipline).toBe('physics');
    });

    it('writes an empty string when the param is absent', () => {
      const state = createDisciplineFilter();
      state.discipline = 'biology';
      state._syncDisciplineFromUrl(new URLSearchParams(''));
      expect(state.discipline).toBe('');
    });

    it('respects the custom stateKey', () => {
      const state = createDisciplineFilter({ stateKey: 'disciplineFilter' });
      state._syncDisciplineFromUrl(new URLSearchParams('discipline=Chemistry'));
      expect(state.disciplineFilter).toBe('chemistry');
      expect(state).not.toHaveProperty('discipline');
    });
  });

  describe('_pushDisciplineToUrl', () => {
    it('sets ?discipline= lowercased when state is non-empty', () => {
      const state = createDisciplineFilter();
      state.discipline = 'CHEMISTRY';
      const params = new URLSearchParams();
      state._pushDisciplineToUrl(params);
      expect(params.get('discipline')).toBe('chemistry');
    });

    it('omits ?discipline= when state is empty', () => {
      const state = createDisciplineFilter();
      state.discipline = '';
      const params = new URLSearchParams();
      state._pushDisciplineToUrl(params);
      expect(params.has('discipline')).toBe(false);
    });

    it('reads from the custom stateKey', () => {
      const state = createDisciplineFilter({ stateKey: 'disciplineFilter' });
      state.disciplineFilter = 'Biology';
      const params = new URLSearchParams();
      state._pushDisciplineToUrl(params);
      expect(params.get('discipline')).toBe('biology');
    });
  });
});

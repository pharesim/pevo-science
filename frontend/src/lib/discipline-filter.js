import { fetchDisciplines } from '../api.js';

// Shared discipline-filter state + methods for Alpine components.
// Consumed by paper-feed.js (stateKey: 'discipline') and search.js
// (stateKey: 'disciplineFilter'). The two components differ only in
// the state-key name; everything else is identical.
//
// Spread the returned object into an Alpine.data() factory:
//
//   Alpine.data('paperFeed', () => ({
//     ...createDisciplineFilter({ stateKey: 'discipline' }),
//     // ... other state/methods
//     init() {
//       await this.loadDisciplines();
//       // ...
//     },
//     _syncFromUrl() {
//       const params = new URLSearchParams(window.location.search);
//       this._syncDisciplineFromUrl(params);
//       // ... other fields
//     },
//     _pushUrl() {
//       const params = new URLSearchParams();
//       this._pushDisciplineToUrl(params);
//       // ... other fields
//     },
//   }));
//
// Contract-stable fields (see agents/docs/api-contracts/misc.md GET /api/disciplines):
// backend returns `{ canon_name, display_name, paper_count }` and canon_name is
// already lowercased server-side, so this helper stores rows verbatim.
export function createDisciplineFilter({ stateKey = 'discipline' } = {}) {
  return {
    disciplines: [],
    disciplinesLoadFailed: false,
    [stateKey]: '',

    /**
     * Fetch the discipline list and populate `this.disciplines`.
     *
     * Always resolves; sets `this.disciplinesLoadFailed = true` on error.
     * Callers do not need a .catch handler. Pre-extract, both consumers
     * had `loadDisciplines` bodies that threw on fetch failure and were
     * wrapped in a try/catch at the call site. The composable now owns
     * that try/catch internally, so the promise-rejection contract
     * changed from "may reject" to "never rejects". Observable behavior
     * (failure flag set, warning logged) is identical for current
     * consumers; this JSDoc makes the contract shift discoverable.
     */
    async loadDisciplines() {
      // Reset before each attempt so a later retry can clear a
      // previously-set failure flag on success. init-only today, but any
      // future retry path (route revisit, visibility-change reload,
      // user-triggered retry) would otherwise see the flag stuck.
      this.disciplinesLoadFailed = false;
      try {
        const res = await fetchDisciplines();
        // Teardown-race guard: if the consumer also spreads createTimerGuard()
        // and destroy() already fired, bail before writing to a destroyed
        // reactive scope. `=== false` (not just falsy) so consumers that do
        // NOT spread createTimerGuard keep their prior behavior (undefined
        // _mounted → no short-circuit).
        if (this._mounted === false) return;
        this.disciplines = res.data || [];
      } catch (err) {
        if (this._mounted === false) return;
        console.warn('[loadDisciplines]', err);
        this.disciplinesLoadFailed = true;
      }
    },

    _syncDisciplineFromUrl(params) {
      // Canonicalize discipline to lowercase on read so the stored value
      // matches option values populated from loadDisciplines (backend
      // canon_name is lowercase). Existing URLs like ?discipline=Physics
      // continue to resolve since the API is case-insensitive; this
      // normalization is purely a frontend-coherence concern.
      const raw = params.get('discipline') || '';
      this[stateKey] = raw.toLowerCase();
    },

    _pushDisciplineToUrl(params) {
      // _syncDisciplineFromUrl lowercases URL reads; backend canon_name is
      // already lowercase. The .toLowerCase() here catches direct state
      // assignments (e.g. code paths that assign this[stateKey] without
      // going through _syncDisciplineFromUrl).
      //
      // Note: `stateKey` parameterizes only the in-memory field name
      // (consumers disagree: `discipline` vs `disciplineFilter`). The URL
      // param is intentionally hardcoded to `'discipline'` so shareable
      // URLs stay stable across consumers and bookmarked links keep
      // working regardless of which page renders them.
      if (this[stateKey]) params.set('discipline', this[stateKey].toLowerCase());
    },
  };
}

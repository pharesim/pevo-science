# UI-PAPER-FEED-SEARCH-DISCIPLINE-COMPOSABLE — Extract duplicated discipline-filter logic from paper-feed.js and search.js

**Owner:** ui
**Created:** 2026-04-22 (surfaced by FE-PAPERS-BROWSE-DISCIPLINE-OPTION-HYDRATION-RACE review 2026-04-22)
**Priority:** P3

## Context

`frontend/src/components/paper-feed.js` and `frontend/src/pages/search.js` both carry near-identical `loadDisciplines()`, `_syncFromUrl()` (discipline branch), and `_pushUrl()` (discipline branch) logic. They differ only in the state key name (`discipline` vs `disciplineFilter`). Post-FE-DISCIPLINE-DISPLAY-HARDEN migration to `canon_name`/`display_name`, the functions converged further — `loadDisciplines` is now character-for-character identical in both files.

The duplication is:
- `loadDisciplines()` body (fetch + verbatim assignment + failure-flag reset).
- `_syncFromUrl` discipline lowercase + assignment logic.
- `_pushUrl` discipline lowercase + URLSearchParams.set branch.
- `disciplinesLoadFailed` flag state + `data-disciplines-status` binding in the template.

Every future BE-DISCIPLINE-* change that needs a frontend consumer update (shape change, new field, new filter semantic) must land in two places and stay in sync.

## Goal

Extract a shared discipline-filter composable at `frontend/src/lib/discipline-filter.js`:

```js
export function createDisciplineFilter({ stateKey = 'discipline' } = {}) {
  return {
    disciplines: [],
    disciplinesLoadFailed: false,
    [stateKey]: '',
    async _loadDisciplines() {
      this.disciplinesLoadFailed = false;
      try {
        const res = await fetchDisciplines();
        this.disciplines = res.data || [];
      } catch (err) {
        console.warn('[loadDisciplines]', err);
        this.disciplinesLoadFailed = true;
      }
    },
    _syncDisciplineFromUrl(params) {
      const raw = params.get('discipline') || '';
      this[stateKey] = raw.toLowerCase();
    },
    _pushDisciplineToUrl(params) {
      if (this[stateKey]) params.set('discipline', this[stateKey].toLowerCase());
    },
  };
}
```

Then spread into both components:

```js
// paper-feed.js
Alpine.data('paperFeed', () => ({
  ...createDisciplineFilter({ stateKey: 'discipline' }),
  // ... rest
  async init() {
    await this._loadDisciplines();
    // ...
  },
  _syncFromUrl() {
    const params = new URLSearchParams(window.location.search);
    this._syncDisciplineFromUrl(params);
    // ... other fields
  },
}));
```

## Non-goals

- Extracting other filter logic (author, language, keyword, source). Scope is discipline-only.
- Alpine plugin / magic registration. A plain factory function that's spread into state is simpler.
- Co-locating discipline filter template fragments. Alpine templates are embedded in the component JS; extraction is ergonomically expensive and not the source of duplication pain.

## Acceptance

- `frontend/src/lib/discipline-filter.js` exports `createDisciplineFilter`.
- `paper-feed.js` and `search.js` both consume it via spread; the duplicated body is gone from both.
- Unit tests under `frontend/tests/unit/lib-discipline-filter.test.js` cover the factory in isolation.
- Existing per-page unit tests still pass.
- Behavior is pixel-identical to pre-refactor (same URL canonicalization, same dropdown population, same failure flag behavior).

## Alignment with other pending work

- `ui-async-continuation-teardown-guard-sweep` applies `_mounted` guards to `paper-feed.js` + `search.js`'s `_loadDisciplines`. If this composable-extraction task lands first, the guard applies cleanly to the composable's methods. If the teardown sweep lands first, this task re-extracts post-guard. Either order works; coordinate if both are in flight.

## [TODO Architect]

None — self-contained refactor.

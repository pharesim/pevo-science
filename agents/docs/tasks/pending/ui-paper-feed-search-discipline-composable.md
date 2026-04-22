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

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES:**

First-pass `/ce-code-review` on commit `12782d6` (correctness, testing, julik-frontend-races, maintainability, project-standards). The composable extraction genuinely eliminates duplication (42 LoC × 2 → 71 LoC shared). File placement + `create*` naming + JSDoc consistent with repo conventions. Tests mutation-kill-strong. One hold item on documentation; other residuals are pre-existing out-of-scope concerns filed into the teardown-guard-extension task.

1. **P3 → elevated to hold — Document the error-contract change in composable JSDoc** (correctness C2 0.82). Pre-extract, both consumers called `this.loadDisciplines().catch(handler)` — `loadDisciplines` threw on error and the catch handled it. Post-extract, the composable swallows all errors internally and never rejects; callers now call it fire-and-forget. Observable behavior is identical for current consumers, but the promise rejection contract changed silently. Fix: add a one-line note to the composable's `loadDisciplines` JSDoc: `"Always resolves; sets `this.disciplinesLoadFailed = true` on error. Callers do not need a .catch handler."` This makes the contract shift discoverable to a future developer wrapping the method.

**Dismissed from round-1 findings (architect triage):**
- **P3** `paper-feed.js loadPapers` missing `finally` pattern + no generation counter for concurrent fetches (julik JFR-1 0.82): pre-existing; filed into `ui-teardown-guard-sweep-extension.md`.
- **P3** `loadDisciplines` has no `_mounted` check at this commit (correctness C1 0.88): at this commit, `createTimerGuard` wasn't imported by consumers; forward-compat composable `=== false` check is correct. Sibling task `ui-async-continuation-teardown-guard-sweep` round-2 hold addresses it.
- **P3** `stateKey` parameterizes memory key only, URL key hardcoded to `'discipline'` (correctness C3 0.75 + maintainability M2 0.58): document inline or rename; fold into hold-fix commit.
- **P3** `stateKey` option exists only because consumers disagree on name (`discipline` vs `disciplineFilter`) (maintainability M1 0.62): cosmetic; rename search.js's `disciplineFilter → discipline` + drop option if convenient.
- **P3** `_pushDisciplineToUrl` empty-branch test only uses `''` not whitespace (testing T-DISC-1 0.72): dropdown-bounded values; practical risk negligible.
- **P3** Rejection test doesn't assert `this.disciplines` unchanged after error (testing T-DISC-2 0.68): guard against future edit that mutates before failing await.
- **P3** `search.js` popstate registered after `await loadDisciplines` (julik JFR-3 0.65): pre-existing; filed into `ui-teardown-guard-sweep-extension.md` or fold opportunistically.

**Path to re-archive:** (1) UI applies item #1 (JSDoc update) on this task. (2) UI re-review signal block below the hold. (3) Architect re-reviews round-2; archives on clean.

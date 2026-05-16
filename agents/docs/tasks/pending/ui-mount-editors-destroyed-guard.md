# UI-MOUNT-EDITORS-DESTROYED-GUARD — Add `_mounted` check after dynamic `await import('../editor.js')` in `_mountEditors`

**Owner:** ui
**Created:** 2026-05-11 (architect, batch-1 review triage)
**Priority:** P2

## Context

Architect batch-1 review finding JFR-002 (julik-frontend-races, conf 75) identified a teardown-during-init race in both `frontend/src/pages/publish.js:481-527` and `frontend/src/pages/edit.js:692-715`:

Both pages schedule editor mounting via `$nextTick`:
```js
init() {
  // ...
  this.$nextTick(() => this._mountEditors());
}

async _mountEditors() {
  const { createEditor } = await import('../editor.js');  // dynamic import
  this._abstractEditor = createEditor(this.$refs.abstractEditor, ...);
  this._bodyEditor = createEditor(this.$refs.bodyEditor, ...);
}
```

If the user navigates away between the `$nextTick` dispatch and the dynamic import resolving:
1. Alpine calls `destroy()` (component lifecycle teardown).
2. `destroy()` sets `_mounted = false` and nulls out `_abstractEditor` / `_bodyEditor` references.
3. The pending `_mountEditors()` promise resumes when the import finishes.
4. `this.$refs.abstractEditor` and `this.$refs.bodyEditor` are now null or refer to detached DOM nodes.
5. `createEditor` is called on dead refs, returns editor instances (or throws — depends on createEditor's defensive behavior).
6. Instances are stored on `this._abstractEditor` / `this._bodyEditor` — but `destroy()` has already run, so its teardown sequence never sees these new instances.

**Consequences:**
- Memory leak: orphaned editor instances + their DOM event listeners + their tiptap document trees retained for the lifetime of the page.
- Possible console errors depending on `createEditor`'s behavior when refs are null.

Same construct in both `publish.js` and `edit.js` — likely the second was copied from the first.

## Acceptance

1. **Add a single-line `_mounted` guard after the dynamic import in both files:**
   ```js
   async _mountEditors() {
     const { createEditor } = await import('../editor.js');
     if (!this._mounted) return;  // ← add this
     this._abstractEditor = createEditor(this.$refs.abstractEditor, ...);
     this._bodyEditor = createEditor(this.$refs.bodyEditor, ...);
   }
   ```
2. **Apply the same guard pattern to any OTHER `_mountEditors`-style async-init helpers** in the same files. Grep `frontend/src/pages/publish.js` and `frontend/src/pages/edit.js` for other methods that have an `await import(...)` followed by side-effects writing to `this.*`. Add the guard wherever the pattern matches.
3. **Verify the `_mounted` flag is properly maintained.** Confirm `init()` sets `this._mounted = true` early and `destroy()` sets `this._mounted = false`. If the flag isn't already maintained, add the maintenance (the guard is useless without it). The flag may live under a different name in the existing code (`_isMounted`, `_alive`, etc.); use whatever already exists or pick a name and use it consistently across both files.
4. **Audit other pages for the same pattern.** Grep `frontend/src/pages/` for `await import` followed by `this.*` writes. Files like `frontend/src/pages/review.js`, `frontend/src/pages/comment.js`, or similar may have the same teardown race. If found, fix in this same task (the pattern + fix is identical; bundling is cheaper than separate tasks).

## Tests

Add specs to `frontend/tests/unit/pages-publish.test.js` and `frontend/tests/unit/pages-edit.test.js`:

- **`_mountEditors` no-op when component destroyed during import:** test pattern:
  1. Create component, call `init()`.
  2. Immediately call `destroy()` (or whatever the teardown trigger is in the unit harness).
  3. Flush the `$nextTick` queue AND the dynamic-import promise.
  4. Assert that `this._abstractEditor` is null (or whatever the destroyed state is) — NOT a leaked editor instance.

Mocking `import('../editor.js')` may require esm-stub or vitest-mock-import patterns; check existing tests in the same file for the established mock pattern.

## Out of scope

- Refactoring `_mountEditors` to use `Promise.race` against a teardown signal (overkill; the `_mounted` flag check is sufficient).
- Adding a generic `withMountedGuard` helper. The guard is 1 line per call site; an abstraction would obscure the code for negligible gain (PEvO convention: three similar lines beats a premature helper).
- Changing the dynamic import pattern itself (e.g., switching to static import). The dynamic import is intentional code-splitting; preserve it.

## References

- Architect batch-1 review finding JFR-002 (julik-frontend-races). Conf 75.
- Cited line ranges: `frontend/src/pages/publish.js:481-527` and `frontend/src/pages/edit.js:692-715`.

## Priority rationale

P2 because the construct is verified (julik confidence 75), the fix is trivial (1 line per call site), and the failure mode is silent (leaked editor instances bloat memory across a session and may produce confusing dev-console errors). Not P1 because the trigger (fast navigation during page mount) is uncommon in steady-state usage.

## Architect re-review (2026-05-16) — HELD PENDING FIXES — scope broadening (round-1 fix landed in `12c610e` not yet architect-reviewed for round-1, AND a sibling task surfaced an adjacent failure mode that must land in the same patch):

Sibling task `ui-edit-loadpaperdata-concurrent-retry-guard` (archived 2026-05-16) was reviewed and surfaced finding `julik-frontend-races JFR-R4-001` (P2, confidence 100): the destroyed-guard from round-1 closes the `destroy()`-during-`_mountEditors()` race, but a **different shape** of the same `_mountEditors()` lifecycle is still open. Round-1 round was scoped to the unmount-during-mount race; this round broadens scope to also cover the **mount-during-mount** race:

**The newly-surfaced failure mode:** in `frontend/src/pages/edit.js`, `loadPaperData()` clears its `_loadInFlight` mutex in `finally` BEFORE `_mountEditors()` actually starts executing (it's deferred via `$nextTick`, then `await import('../editor.js')`). A Retry click that lands AFTER the `finally` runs but BEFORE the editor.js import resolves passes the `_loadInFlight` guard, fires a fresh fetch, and schedules a second `_mountEditors()`. Both `_mountEditors()` invocations eventually call `createEditor()` on the same `$refs.abstractEditor` / `$refs.bodyEditor`. Each call overwrites `this._abstractEditor` / `this._bodyEditor`. The prior instances are orphaned (never `.destroy()`-ed). Same leak class as the destroyed-during-mount failure but a different trigger: concurrent mount-during-mount.

**Fix direction (in addition to the `_mounted` guard already landed):** Add an idempotency guard at the top of `_mountEditors()`:

```js
async _mountEditors() {
  if (this._editorsInitialized) return;          // ← add this (and a sibling reset in destroy)
  this._editorsInitialized = true;
  const { createEditor } = await import('../editor.js');
  if (!this._mounted) {                          // already landed
    this._editorsInitialized = false;            // ← reset on the early-return path so a later remount can re-init
    return;
  }
  this._abstractEditor = createEditor(this.$refs.abstractEditor, ...);
  this._bodyEditor = createEditor(this.$refs.bodyEditor, ...);
}
```

Apply to both `frontend/src/pages/edit.js:_mountEditors` and `frontend/src/pages/publish.js:_mountEditors`. Reset `_editorsInitialized = false` in `destroy()` (or wherever `_teardownTimers()` flips `_mounted`) so a legitimate later remount (e.g., live-reload, navigation back) can re-mount editors fresh.

**Test addition (alongside the round-1 destroyed-during-mount tests):** in `frontend/tests/unit/pages-edit.test.js` and `frontend/tests/unit/pages-publish.test.js`, add a spec to the existing `_mountEditors teardown-during-init guard` describe block (or a sibling block):

- **Concurrent `_mountEditors` calls are idempotent:** call `_mountEditors()` twice in quick succession (synchronously, before the first dynamic import resolves). Flush the import queue. Assert `createEditor` was called exactly once per editor ref (`vi.mocked(createEditor).mock.calls.length === 2`, not 4 — one for abstract, one for body, NOT doubled). Assert `_abstractEditor` and `_bodyEditor` are the editor instances from the FIRST call, not orphaned-and-replaced.

Mutation-kill: removing `if (this._editorsInitialized) return;` makes `createEditor` get called 4 times and the second pair of instances overwrites `_abstractEditor` / `_bodyEditor`.

**Why fold this into the existing task vs file separately:** the two guards stack and co-locate. A future maintainer touching `_mountEditors`'s control flow benefits from seeing both guards in one diff. The user's triage on the retry-guard review chose this routing (option: "Fold into existing `ui-mount-editors-destroyed-guard`") over filing a separate task.

When all items above land, `git mv` this file back to `tasks/review/`. The next architect re-review will cover BOTH the round-1 destroyed-during-mount guard (commit `12c610e`) and the newly-added idempotency guard in one pass.

Cross-references: archived task `ui-edit-loadpaperdata-concurrent-retry-guard` (source of the broadening); finding julik `JFR-R4-001` in this session's archive notes; implementer commit `12c610e` (round-1 destroyed-guard).

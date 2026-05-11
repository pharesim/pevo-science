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

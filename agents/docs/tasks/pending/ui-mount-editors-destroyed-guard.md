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

## UI re-review signal (2026-05-16, commit `55e21cb`)

Idempotency guard landed in both editor pages plus unit-test coverage for the new invariant.

- **`frontend/src/pages/edit.js:686-706`** — added `if (this._editorsInitialized) return;` + `this._editorsInitialized = true;` as the synchronous prefix of `_mountEditors`, before the `await import('../editor.js')`. The existing destroyed-during-mount guard at the post-await position now also resets `this._editorsInitialized = false;` on the early-return path so a legitimate later remount (live-reload, back-navigation) can re-init.
- **`frontend/src/pages/publish.js:503-523`** — same shape applied identically (the call-site shape is copied between the two files; the guard pair stacks the same way).
- **`destroy()` in both files** — added `this._editorsInitialized = false;` next to the existing editor teardown lines so the idempotency flag clears on component teardown.
- **`frontend/tests/unit/pages-edit.test.js` + `pages-publish.test.js`** — extended the existing `_mountEditors teardown-during-init guard` describe block in each file with two new `it()` cases:
  - `is idempotent when invoked concurrently before the first import resolves` — two synchronous `_mountEditors()` calls before the first dynamic import resolves; asserts `mockCreateEditor.mock.calls.length === 2` (one abstract + one body, NOT doubled to 4) and that `_abstractEditor`/`_bodyEditor` are the first-call instances via `mockCreateEditor.mock.results[0/1].value`. Removing `if (this._editorsInitialized) return;` causes 4 createEditor calls and the second instance pair overwriting the first — mutation killed.
  - `releases the idempotency flag on destroy so a later remount can re-init` — mounts, then destroys, asserts `_editorsInitialized` flips back to `false`. Removing the destroy-time reset breaks the long-term remount path.

Sole production-code change set is the 3-line guard+reset pair in `_mountEditors` and the 1-line reset in `destroy()` (×2 files). The audit "Apply the same guard pattern to any OTHER `_mountEditors`-style async-init helpers" in §1 §2 surfaced no other `await import(...)`-followed-by-`this.*`-write call sites in `pages/publish.js`, `pages/edit.js`, `pages/review.js`, `pages/comment.js`, or any other `frontend/src/pages/` file — the editor lazy-load is the only instance of the pattern (verified via `grep -rn 'await import' frontend/src/pages/`). Unit tests: 41/41 green in pages-edit.test.js, 89/89 green across both pages files (the 3 preexisting unhandled rejections in pages-edit are unrelated to this round and predate the commit). Playwright deferred to the parent's serialized run across the three UI re-review tasks; architect can decide whether to run e2e before archive or rely on CI.

## Architect re-review (2026-05-16) — HELD PENDING FIXES (round-2):

Reviewed via `/ce-code-review` against commits `12c610e` (round-1 destroyed-guard — never previously architect-reviewed) + `55e21cb` (round-2 idempotency guard) with 6 personas (correctness Opus; testing/maintainability/project-standards/julik-frontend-races/ce-learnings-researcher Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). The two stacked guards in `_mountEditors()` (synchronous-prefix idempotency at the top; post-await destroyed-guard with `_editorsInitialized = false` reset on early-return) are correctly designed and correctly placed; `destroy()` resets match across `edit.js` + `publish.js`; the §4 audit grep is verified (no other `await import → this.*` write sites). **However, the round-1 destroyed-during-mount unit tests are structurally vacuous and must be repaired before this task can archive.** 2 items must land before re-review.

1. **P2 — `frontend/tests/unit/pages-edit.test.js:783-801` round-1 destroyed-during-mount test does not kill its claimed mutation.** Testing reviewer (P2/90) with verified mutation trace. The test sets `comp.$refs = { abstractEditor: null, bodyEditor: null }` after `comp.destroy()`, then calls `_mountEditors()` and asserts `expect(mockCreateEditor).not.toHaveBeenCalled()`. The null-ref guards in production at `edit.js:709` (`if (abstractEl)`) and `:719` (`if (bodyEl)`) suppress `createEditor` independently of the destroyed-guard. The mutation "remove the `if (!this._mounted) { ... return; }` block entirely" leaves the assertion green: `_mountEditors` enters, passes the (now-reset-to-false) `_editorsInitialized` check, sets `_editorsInitialized = true`, awaits the import, skips the now-absent mounted check, reads `abstractEl = null` → null-ref guard skips → reads `bodyEl = null` → null-ref guard skips → returns. `mockCreateEditor` never called for the wrong reason. The destroyed-guard is currently completely uncovered by any structurally-valid test. Fix direction: **add `expect(comp._editorsInitialized).toBe(false)` after the `_mountEditors()` call** in the destroyed-during-mount test. The flag reset is ONLY reachable via the mounted-guard early-return branch (the null-ref guards in production return BEFORE setting the flag, and the synchronous prefix sets it `true`). On unmutated code: destroyed-guard fires → flag = false → test passes. On mutated code (mounted-guard removed): no reset path → flag stays `true` → test fails. Clean mutation-kill. One-line addition to the existing test.

2. **P2 — `frontend/tests/unit/pages-publish.test.js:685-703` mirror of item 1.** Testing reviewer (P2/90). Same vacuity, same null-ref guards at `publish.js:527` + `:537`, same fix: add `expect(comp._editorsInitialized).toBe(false)` after the `_mountEditors()` call in the destroyed-during-mount test. Mirror parity with item 1's fix.

When both items are landed, `git mv` this file back to `tasks/review/`.

Dismissed at user triage (audit, not blocking): (P3 julik JFR-R5-001) `_editorsInitialized` not declared in the Alpine data object initializer alongside `_abstractEditor` / `_bodyEditor`; every other private flag (`_draftTimer`, `_initialLoadDone`, `_loadInFlight`, `_storageListener`) is declared there. Works today by JS-undefined-is-falsy on the first read; preemptive per `feedback_dismiss_preemptive_test_hardening.md` and below the anchor-75 confidence gate. (Adversarial dismissals carried by reviewers themselves: JFR-R5-002 `destroy()` ordering — intermediate state is safe because in-flight `_mountEditors` self-resets on the post-await guard; JFR-R5-003 early-return reset dead-code concern — not dead-code; covers the intra-instance re-init edge case where Alpine reuses the instance.)

**`/ce-compound` at archive:** the synchronous-flag-before-await idempotency idiom (set the guard flag BEFORE the first `await` boundary, not after) is a non-obvious learning that no existing `agents/docs/solutions/` entry captures. Learnings-researcher flagged this as independently worth a `/ce-compound` entry. Capture at archive checkpoint, paired with the sibling e2e task's `waitForEditorsMounted + setEditorContent + emitUpdate:false` editor-ready gate pattern (also deferred to archive per its own hold-block note).

Cross-references: `frontend/src/pages/edit.js:684-737` (stacked guards + destroy reset); `frontend/src/pages/publish.js:503-556` (mirror); `agents/docs/solutions/conventions/mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` (the exact failure mode this hold catches — claimed kill that the assertion structurally cannot achieve); `agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` (already cited at round-2 scope-broaden — stacked guards need per-layer canary).

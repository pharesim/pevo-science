---
title: "Tiptap `editor.setContent()` after `initialMarkdown` construction throws 'Applying a mismatched transaction'"
date: 2026-05-16
category: conventions
module: frontend/tests/e2e
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Writing an E2E or unit test that drives content into a Tiptap-bearing page component (publish, edit, review pages today)"
  - "Reviewing a test helper that calls `editor.setContent()` after the editor was constructed with `initialMarkdown`"
  - "Adding a new editor-bearing page and wiring its first E2E spec — apply the editor-ready gate + Alpine-state-write pattern from day one"
  - "Diagnosing a Playwright `RangeError: Applying a mismatched transaction` thrown from inside `page.evaluate(() => editor.setContent(...))`"
tags:
  - testing
  - tiptap
  - e2e
  - playwright
  - alpine
  - editor
  - async
  - transaction
related_components:
  - frontend_stimulus
---

# Tiptap `editor.setContent()` after `initialMarkdown` construction throws 'Applying a mismatched transaction'

When a Tiptap editor is constructed with `initialMarkdown`, the constructor dispatches the initial content-application transaction asynchronously. Calling `editor.setContent(...)` from outside (e.g., a Playwright test helper trying to drive editor state) before that initial transaction has fully landed produces a Tiptap `RangeError: Applying a mismatched transaction`. The imperative replace's transaction is built against a document state that has already been replaced by the constructor's in-progress initial transaction; ProseMirror rejects the application.

The right shape for test-side state-driving is to write the Alpine reactive state only and rely on the editor's own `onUpdate` callback binding to keep state and editor in sync. The editor's `onUpdate` does NOT fire on constructor content-init (Tiptap's `dispatchTransaction` gates the callback to user transactions, not constructor init), so an Alpine-state write does not trigger a backwards round-trip into the editor.

## Context

Surfaced in PEvO's `ui-e2e-edit-paper-flow` task round-2 hold cycle. The first attempt at a `setEditorContent` test helper wrote Alpine state AND called `editor.setContent()` to keep the editor and Alpine reactive state in sync. The expected race was solved by the round-2 `waitForEditorsMounted` gate (which blocks until `_abstractEditor` and `_bodyEditor` are populated post-dynamic-import), but the `setContent()` call still threw the mismatched-transaction RangeError intermittently — specifically when the editor-ready gate landed exactly as Tiptap's initial transaction was still in flight.

The Alpine-state-only shape solves the same problem from the other direction: the editor's `onUpdate` callback is already wired to write `this.abstract = md` / `this.body = md` on every user-driven content change. Tests that need to inject content can write to `this.abstract` / `this.body` directly; the next user-driven change (or assertion read) sees the test-injected value. The editor doesn't need to be told the value changed because the broadcast assertions only care about the markdown strings in Alpine state, which is what the production submit-handler reads anyway.

## Guidance

Test helpers that drive Tiptap-editor-bearing pages should:

1. Wait for the editors to mount before writing state. The dynamic `await import('../editor.js')` resolve is not the same tick as `createEditor()` returning a populated instance. Gate on the populated-instance state:

```js
async function waitForEditorsMounted(page) {
  await page.waitForFunction(() => {
    const root = document.querySelector('[x-data="editPage"]');
    const data = window.Alpine?.$data(root);
    return !!data && !!data._abstractEditor && !!data._bodyEditor;
  });
}
```

2. Write Alpine state ONLY. Do not call `editor.setContent()` after `initialMarkdown` is in play:

```js
async function setEditorContent(page, { abstract, body }) {
  // Alpine state write is sufficient. Calling editor.setContent() after
  // the editor's own initialMarkdown application produces a tiptap
  // "Applying a mismatched transaction" RangeError (the in-progress
  // initial transaction conflicts with the imperative replace), so we
  // avoid the imperative path entirely. The editor's onUpdate does not
  // fire on constructor content-init (tiptap dispatchTransaction gates
  // the callback to user transactions, not constructor init).
  await page.evaluate(({ abstract, body }) => {
    const root = document.querySelector('[x-data="editPage"]');
    const data = window.Alpine.$data(root);
    if (abstract !== undefined) data.abstract = abstract;
    if (body !== undefined) data.body = body;
  }, { abstract, body });
}
```

3. For assertions on the broadcast payload, read Alpine state via `page.evaluate(() => Alpine.$data(root).abstract)` rather than reading from the editor's `.getHTML()` / `.getJSON()`. The broadcast handler reads `this.abstract` / `this.body`; the test should pin the same property the production code reads.

## Why This Matters

The intuition for keeping editor + state in sync is right in general — but Tiptap's transaction model treats the constructor's `initialMarkdown` application as a real transaction that must complete before another transaction can be applied cleanly. The RangeError is loud when it fires, but the timing is fragile: in some test runs the initial transaction lands before `setContent()` is called and the test passes; in other runs the timing flips and the test fails with an unhelpful stack trace pointing inside `dispatchTransaction`. That kind of intermittent failure is the worst class of test bug — wastes hours on "is it the test or is it the editor" investigations.

The Alpine-state-only shape eliminates the race entirely. Production code paths that mutate content (typing, paste, programmatic edit handlers) all flow through Alpine state, so the test's state-write is structurally identical to user input from the editor's perspective. No surprise: the editor is the source of truth for visible content, Alpine state is the source of truth for the broadcast payload, and the test only needs to drive the latter.

## When to Apply

- E2E tests for any page that mounts a Tiptap editor with `initialMarkdown` populated. Today: `publish.js`, `edit.js`, `review.js` (the three editor-bearing pages).
- Unit tests that mount the same components and need to drive content into the editor field.
- Reviewing test-helper PRs that call `editor.setContent()` from outside the editor's own input pipeline.

Do NOT apply when:
- Production code that creates a Tiptap editor WITHOUT `initialMarkdown` — calling `setContent()` to populate it is fine. There is no in-progress initial transaction to conflict with.
- User-driven interactions (typing, paste) — those go through Tiptap's input pipeline (`dispatch` from the editable view), not `setContent()`.
- Tests that need to verify the editor's own behavior (formatting commands, undo/redo) — those need to drive the editor directly through its public API, and the test should accept the timing constraint via explicit `waitForFunction` on whatever post-transaction state the editor exposes.

## Examples

### Before — Alpine state + imperative setContent (intermittent RangeError)

```js
async function setEditorContent(page, { abstract, body }) {
  await page.evaluate(({ abstract, body }) => {
    const root = document.querySelector('[x-data="editPage"]');
    const data = window.Alpine.$data(root);
    if (abstract !== undefined) {
      data.abstract = abstract;
      data._abstractEditor.commands.setContent(abstract);  // ← RangeError when initial txn still in flight
    }
    if (body !== undefined) {
      data.body = body;
      data._bodyEditor.commands.setContent(body);          // ← same
    }
  }, { abstract, body });
}
```

### After — Alpine-state-only (deterministic)

```js
async function setEditorContent(page, { abstract, body }) {
  await page.evaluate(({ abstract, body }) => {
    const root = document.querySelector('[x-data="editPage"]');
    const data = window.Alpine.$data(root);
    if (abstract !== undefined) data.abstract = abstract;
    if (body !== undefined) data.body = body;
  }, { abstract, body });
}
```

### Editor-ready gate that precedes both shapes

```js
async function waitForEditorsMounted(page) {
  await page.waitForFunction(() => {
    const root = document.querySelector('[x-data="editPage"]');
    const data = window.Alpine?.$data(root);
    return !!data && !!data._abstractEditor && !!data._bodyEditor;
  });
}

// Usage in a test:
await page.goto('/edit/alice/paper-permlink');
await waitForEditorsMounted(page);
await setEditorContent(page, { abstract: NEW_ABSTRACT, body: NEW_BODY });
await page.locator('button.btn-submit').click();
```

## Cross-references

- `frontend/tests/e2e/edit-paper.spec.js` — canonical `setEditorContent` + `waitForEditorsMounted` definitions; docblock at `setEditorContent` is the production form of this convention.
- `frontend/src/editor.js` — `createEditor` wrapper that accepts `initialMarkdown` and wires the `onUpdate` callback. The `dispatchTransaction` gating that prevents `onUpdate` firing on constructor init is internal to Tiptap; this doc names the user-visible consequence.
- `frontend/src/pages/edit.js`, `frontend/src/pages/publish.js` — the production mount sites that pass `initialMarkdown` to `createEditor`. Any new editor-bearing page should follow the same shape.
- `agents/docs/solutions/conventions/synchronous-flag-before-await-idempotency-guard-2026-05-16.md` — the production-side companion. The editor-ready gate in `waitForEditorsMounted` complements the synchronous-prefix idempotency guard in `_mountEditors`. Together they pin the lifecycle: mount-side ensures one instance pair lands per mount cycle; test-side waits for that instance pair to be populated before driving state through it.

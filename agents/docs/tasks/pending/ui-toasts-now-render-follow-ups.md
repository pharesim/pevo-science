# Toast follow-ups now that toasts render: narrow phones, untranslated error copy, the doubled queued title

**Owner:** ui
**Created:** 2026-10-07
**Priority:** low

Filed from the architect review of `ui-revoked-session-e2e-real-path` (archived 2026-10-07), with
the user's approval. That task gave the toast container in `frontend/index.html` its `x-data`
root, so toasts render for the first time since the Alpine migration. These three items were
already in the code, but users could not see them until toasts started rendering.

## 1. The toast stack is cut off on phones narrower than 400px

The container is `fixed bottom-4 right-4 ... max-w-sm w-full`. On a fixed element `w-full`
resolves against the viewport, so on a viewport narrower than 25rem (the 24rem `max-w-sm` plus
the 1rem right inset) the stack's left edge sits past the screen's left edge. On a 375px viewport
it is at -16px, and each toast loses its left border and its `px-4` left padding. The review confirmed this by
arithmetic on the classes (Tailwind defaults, no `--container-sm` or `--spacing` override in
`styles.css`); no rendering check was run.

Suggested fix: replace `max-w-sm w-full` with `w-[calc(100%-2rem)] max-w-sm`, keeping
`fixed bottom-4 right-4`. Arbitrary values already work in `index.html`.

## 2. The uncaught-error toast is English in every locale

`showErrorToast` in `frontend/src/error-tracking.js` shows the literal
`'Something went wrong. Please try again.'` for the window `error` and `unhandledrejection`
listeners and the `alpine:error` listener. Read the copy from the i18n messages with that English
string as the fallback. No `common` key holds this string today (`contact.errorGeneric` has the
same text but belongs to the contact page), so add one under the project's locale rules.

Whether uncaught errors should raise a toast at all is the user's decision. Keep the toast unless
the user says otherwise; ask if the change seems to call for it.

## 3. The bridge page shows the queued title twice

`frontend/src/pages/bridge.js` sets `step = 'queued'`, which renders the queued banner with
`$t('bridge.queuedTitle')`, and in the same handler raises a success toast with the same key. Show
it once; the banner carries the position, the ETA and the My imports link, so dropping the toast
is the likely choice. `frontend/src/pages/my-imports.js` also toasts `bridge.queuedTitle`; check
whether anything on that page repeats it before changing it.

If the bridge toast goes, the comment on the rescoped locator in
`frontend/tests/e2e/bridge-import-queue.spec.js` ("The success toast carries the same title, so
the title is read inside the page") stops being true. Delete or narrow it in the same change.

## Acceptance criteria

1. At a 375px viewport the toast stack sits inside the page with a 1rem gutter on both sides;
   its width at desktop sizes is unchanged.
2. The uncaught-error toast shows the active locale's copy, falling back to English.
3. The bridge page shows the queued title once, and no comment or locator still describes a
   toast that is gone.

# A route change drops the composer's pending draft save

**Owner:** ui
**Created:** 2026-10-06
**Priority:** normal

Older than the task that surfaced it: the implementer of `ui-sign-in-modal-has-no-orcid-path` reported it
as an out-of-scope finding, and the architect review of that task confirmed it in the code (2026-10-06).
Verify against the code first.

## Why

On /publish and /edit, a form change reaches storage through a 2 s debounce (`_scheduleDraftSave`).
`destroy()` clears a pending `_draftTimer` without writing it. A route change runs `destroy()`, because
page-mount destroys the old page's tree. So a change made in the last 2 s before an in-app navigation away
from a composer is lost. That includes the sign-in modal's sign-up, reset-password and /login links.

`agents/docs/ARCHITECTURE.md` § 8 says work typed after a session teardown "survives the trip to the
sign-in page". That holds except for this window.

`ui-composer-merge-saves-at-once-and-choice-discard-prefill` handles the citation-merge case of the same
window. This task is the typed-change case.

## Scope

1. On both pages, a `destroy()` with a save pending writes it through `_writeDraft`, so `_writeDraft`'s
   existing refusals still apply. One candidate is `_flushDraftSave()` from `destroy()` when `_draftTimer`
   is set; it was not plant-tested.
2. On an account change, § 8 says the page flushes its pending draft under the key it captured before it
   remounts. Confirm that `destroy()` writes nothing a second time on that path.

## Acceptance criteria

1. On both pages, a form change followed by `destroy()` within 2 s ends up in the stored draft.
2. A landed instance's `destroy()` writes nothing.
3. Each page has a pin in `frontend/tests/unit/composer-drafts-real-editors.test.js` that goes red when its
   `destroy()` change is reverted; list probe and spec in the signal block.
4. New comments follow root `CLAUDE.md` "Comment anchors".

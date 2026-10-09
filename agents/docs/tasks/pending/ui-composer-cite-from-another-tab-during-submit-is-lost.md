# A cite made in another tab while a composer submit is in flight is lost when the submit lands

**Owner:** ui
**Created:** 2026-10-09
**Priority:** normal

Older than the task that surfaced it: the implementer of `ui-composer-merge-saves-at-once-and-choice-discard-prefill`
reported it (2026-10-05), and the architect review of that task confirmed it in the code at 23b67acb. The user
approved the design below at triage (2026-10-09). Verify against the code first.

## Why

On both composer pages the `storage` listener runs `_mergeCitationCollection` when another tab writes
`pevo-citation-collection`, and the merge's guard does not look at `isSubmitting`. A merge appends the entries
to `citations`, drafts the form and removes the collection from storage, so from then on the draft holds the
cite's only copy. A cite merged after the submit has read `citations` for the broadcast is not in the
broadcast, and when the broadcast lands `_markLanded` removes the draft, so the cite is gone. On /publish the
submit reads `citations` when it builds the metadata, after the uploads. On /edit it reads them before its first
await, so every merge during an /edit submit is affected.

## Scope

1. On both pages, the merge is held back while a submit is in flight: the collection stays in storage.
2. When the submit settles without landing, the collection merges into the form as any other merge does.
3. When the submit lands, the collection stays in storage for the next form, as it already does for a landed
   instance.

Accepted at triage: on /publish, a cite made during the uploads now waits for the next form instead of riding
this broadcast.

## Acceptance criteria

1. On both pages, a cite written to the collection by another tab while a submit is in flight: (a) is still in
   the collection after the submit lands; (b) is in the form and in the stored draft after a submit that fails.
   Pins in `frontend/tests/unit/composer-drafts-real-editors.test.js`, each red when its own site is reverted;
   list probe and spec in the signal block.
2. The `_mergeCitationCollection` docblocks on both pages name the states the merge is held back in. They must
   be true of the new guard.
3. The architect updates `agents/docs/ARCHITECTURE.md` § 8 at review; do not edit it.
4. New comments follow root `CLAUDE.md` "Comment anchors".

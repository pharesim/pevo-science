# The canary's docblock points at the store's catalog section for its own learnings

**Owner:** backend
**Created:** 2026-09-23

Filed by the architect from the decision on the canary learning cluster's retrieval shape. The
store now has a catalog, `agents/docs/solutions/README.md`, with a section headed by the path of
`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts` that lists the
entries about the canary's own reader and the question each answers. The canary itself cites none
of them, so an implementer who opens it on a red bar or a suspicious green has no route to that
section.

## Why

Eleven entries in `agents/docs/solutions/conventions/` are about this file's machinery, and each
cites a different subset of the others. The catalog section is the one door. The file every
implementer already opens is the canary, so the canary should say where the door is. It should say
only that: a per-entry list in the docblock would go stale at the next entry, because the author of
that entry is often not backend and the refresh never edits product code. A pointer to the section
is stable across entries.

## Scope

1. Add one short paragraph to the canary's leading docblock, near the KNOWN LIMITS lead-in or
   wherever the author judges a reader arriving from a red bar looks first. It says that the
   learnings about this file's reader (comment blanking, the parser oracle, the fail-closed
   sentinels, the cost probes, the differential triage) are catalogued under the file's own
   heading in `agents/docs/solutions/README.md`, and that the section is read before the reader
   is changed.
2. Cite the catalog by path only. No per-entry filenames, no task slugs, no round numbers, no
   line numbers (root `CLAUDE.md` "Comment anchors"). A `solutions/` path is the convention's
   durable class and passes the pre-commit anchor gate.
3. Nothing else in the file changes.

## Acceptance criteria

1. The docblock carries the paragraph, and it names the catalog's path and the file's own section
   heading.
2. The canary suite is unchanged and green: the canary alone, and all of `tests/eslint`.
3. The pre-commit anchor gate is zero-hit over the added lines, with a firing control.

## Notes

The blocked task about the line-map comment at `typescriptView`'s `starts`/`lineOf` pair touches
the same file. If that one unblocks first, the two edits may ride one commit; they do not depend
on each other.

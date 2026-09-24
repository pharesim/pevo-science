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

## Backend implementation signal (2026-09-24, commit cffe3a4a)

`cffe3a4a` adds the paragraph to the canary's leading docblock, immediately ahead of the
KNOWN LIMITS lead-in, separated from the migrations paragraph by the blank comment line that
already closed it and from KNOWN LIMITS by one new blank comment line. Nine insertions, no
deletions, no modifications: nothing else in the file changes. SHA self-verified reachable
from `main` (`git merge-base --is-ancestor`).

Placement reasoning: everything ahead of that lead-in argues the invariant, everything from
it on describes the reader's machinery and where it stops, so the pointer sits at the hinge
an arriving implementer reaches when they start asking whether the reader misread their line
rather than whether their line is a third writer.

Wording notes, since each was a deliberate choice against an alternative:

- The arrival is widened past the red bar to a green one and a slow run, matching the three
  triggers the catalog section's own lead names.
- `recorded` is used rather than `learnings`: the latter appears nowhere in the file, the
  former twenty-one times, and is already the docblock's verb for a fact held outside the
  code.
- `the parser it is compared with at every line end` is the TypeScript-agreement paragraph's
  own phrasing, so a reader who greps it off this paragraph lands in the matching catalog
  row. `parser oracle` was rejected for appearing in neither the file nor the store.
- `among others` marks the family list non-exhaustive, so a twelfth entry cannot falsify it.
- The section is cited in place of its entries, with the reason stated, so the next author is
  discouraged from expanding the gesture into the per-entry list the shape exists to avoid.
- `none of it about the column` answers the worth-my-time question outright; it is scoped to
  what is recorded about the reader, so it makes no claim about entries not yet written.

Acceptance criteria:

1. Met. The paragraph names the catalog's path, `agents/docs/solutions/README.md`, and
   locates the section as the one headed by this file's own path, which is how the catalog
   heads it.
2. Met. The canary alone: 29 tests passed, exit 0. All of `tests/eslint`: 9 files, 139 tests
   passed, exit 0, identical to the pre-edit baseline. `npm run typecheck` exit 0;
   `npm run lint` exit 0 (one pre-existing warning in `src/lib/author-supersession.ts`, a
   file this task does not touch).
3. Met. The `.githooks/pre-commit` anchor gate returns exit 0 over the added lines. Firing
   control: the same diff plus five rot lines, one per arm (positional, slug, round/hold
   ordinal, line-number cite, and a durable-path line carrying a positional anchor to show
   the `solutions/` exemption does not spare the structural arms), reports exactly five
   violations and exit 1. None of the five is one of the paragraph's own lines, so the
   zero-hit pass is not vacuous. Both runs used a throwaway `GIT_INDEX_FILE`, leaving the
   shared index untouched.

The blocked line-map task named in Notes is still `[BLOCKED by Architect]`, so this edit rides
alone rather than sharing a commit with it.

[TODO Architect] None. The change is confined to `backend/tests/`; no API contract is affected.

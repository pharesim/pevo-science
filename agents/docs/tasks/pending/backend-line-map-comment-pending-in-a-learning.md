# The line-map comment a learning says is pending has never landed

**Owner:** backend
**Created:** 2026-09-23

Surfaced by the `/ce-compound-refresh` pass over the `backend/tests/eslint` learning
cluster. The refresh verified the claim against HEAD and left it alone, since a refresh
does not change product code.

## Why

`agents/docs/solutions/conventions/a-parsers-line-is-not-the-readers-line-unless-built-from-the-same-split.md`
ends its worked example with a prescription:

> The code should carry a one-line comment at `typescriptView`'s `starts`/`lineOf` pair
> saying why the map is built from `lines` rather than from
> `sf.getLineAndCharacterOfPosition`. That comment is pending as of this writing.

At HEAD that comment has not landed. `typescriptView` builds `starts` from
`line.length + 1` and `lineOf` binary-searches it, with no comment on either; the first
comment inside the function is the trivia-scanning one further down.

The sentence is accurate, which is the problem. It is a live TODO parked in a knowledge
doc, and nothing reads a knowledge doc as a work queue. The learning's own subject is a
reviewer proposing to simplify this pair into the parser's line API, so the comment is
the thing that answers that reviewer at the site rather than three files away. Until it
exists, the next reviewer makes the same proposal and the next implementer re-derives the
same argument, which is the cost the learning was written to stop.

## Scope

1. Land the comment at the `starts`/`lineOf` pair. One line, saying why the map is built
   from the reader's own `lines` array rather than from the parser's line table: the two
   count line breaks differently, so a position converted through the parser's numbering
   indexes a different array than the one every consumer here reads.
2. Anchor it per root `CLAUDE.md` "Comment anchors": stable symbol names, no line numbers,
   no SHAs, no task slugs, and no redirect to the learning by filename.
3. The learning's "pending as of this writing" sentence stops being true once the comment
   lands. That file is architect zone, so the edit is not backend's to make. See the
   blocker below.

## Acceptance criteria

1. `typescriptView`'s `starts`/`lineOf` pair carries the comment, and it says why rather
   than what.
2. The canary suite is unchanged and green: the canary alone, and all of `tests/eslint`.
3. The pre-commit anchor gate is zero-hit over the added line, with a firing control.

## [BLOCKED by Architect]

Two decisions belong to the architect before this is worth implementing, because the
prescription and the doc that carries it are both architect-authored:

1. **Is the comment still wanted?** The learning was written the same day the reader was
   rewritten. If the architect has since decided the pair is self-evident, the right fix
   is the opposite one: drop the prescription from the learning, and this task closes
   unimplemented.
2. **Who edits the learning afterwards?** If the comment lands, the "That comment is
   pending as of this writing" sentence is stale in the same commit. Backend does not
   write `agents/docs/solutions/`. Either the architect edits it as a follow-up, or the
   architect authorises a single cross-zone commit carrying both.

Move this file back to `pending/` with the answer, or archive it if the prescription is
being dropped instead.

## Architect decision (2026-10-01), unblocked

1. **The comment is still wanted.** It answers, at the site, the simplification a reviewer
   keeps proposing. Land it per Scope 1 and 2. Re-checked at HEAD before the move: the pair
   is still uncommented. The function has had heavy work today (the canary commits behind
   `backend-head-line-read-silences-fail-closed-backstop`, now in `review/`), so re-read it
   before editing and stage only your hunk.
2. **Backend does not edit the learning.** Commit the comment alone. Once this task is
   archived, the architect runs `/ce-compound-refresh` on
   `a-parsers-line-is-not-the-readers-line-unless-built-from-the-same-split.md` to retire its
   "pending as of this writing" sentence. No cross-zone commit.

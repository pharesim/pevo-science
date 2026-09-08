# Close the password-factor canary's two pre-existing coverage gaps

**Owner:** ui
**Created:** 2026-09-06

Routed out of the round-3 architect review of
`ui-factor-resolver-source-discipline-canary`. Both gaps were raised as findings
against that round's commit and both were rejected by validation as pre-existing
and unaffected by it: the walk root and the star-re-export call are identical at
the round's base commit. They are real properties of the canary, so they are
filed here rather than dismissed, and deliberately kept out of that task's hold
block so its round-3 scope stays what that round introduced.

Neither is urgent. Neither is a live hole today. Both are surfaces the canary
claims to cover more completely than it does.

## Why

### 1. The walk root excludes the entry document

The canary scans `frontend/src`. `frontend/index.html` sits one directory above
that root, is Vite's entry document, carries the global re-auth modal, and holds
around 155 Alpine expression attributes. The canary already treats markup as a
live factor surface. That is the whole reason `pages/settings.js#template` is a
licensed key rather than a pattern exclusion, and why the template literal's
interior resolves to its declaring const instead of module scope.

So the canary's position is that markup can carry a factor decision, but it only
enforces that for markup inside a `.js` template literal. Markup in the entry
document is unscanned and uncensused. The modal that the single-resolver
invariant exists to protect lives there.

`index.html` carries no `hasPassword`, `fetchEmailStatus`, or `emailStatus`
reference today, verified at filing time. The gap is that nothing would notice
when it does.

### 2. The star re-export ban matches per line

The wholesale re-export ban runs through `occurrencesOf`, which matches per line.
Its sibling import-site layer matches against joined file text. So a re-export
written across a line wrap is not seen by the ban, while the same statement on
one line is. Confirmed by execution against the whole tree: the wrapped form
leaves the suite green, the single-line form is a red bar.

This is defence in depth rather than a hole. The occurrence layer still catches
the eventual call site under the re-exported name, which is why it is the smaller
of the two. But the ban exists precisely because a star re-export writes neither
the function's name nor the discriminator, and a line break should not be the
thing that decides whether it is caught.

## Scope

1. Extend the canary to the entry document. Read `frontend/index.html` and assert
   it holds neither the status-fetch identifier nor the password-state
   discriminator. Decide and record whether this becomes a fifth assertion beside
   the four layers or a widening of the walk root, and say which in the WALK
   paragraph of the file docblock. A widened root has to keep the extension
   census honest, since `index.html` would then be a foreign file the walk passes
   over on purpose.
2. Make the star-re-export ban line-break proof. Filter sources by testing the
   pattern against joined file text, as the import-site layer already does. The
   existing regex spans newlines through its own `\s*`, so no pattern change is
   needed. Add a line-broken case to the matcher's self-test, which currently
   feeds it single-line strings only.

## Acceptance criteria

1. A factor read planted in `frontend/index.html` fails the suite.
2. A star re-export of the api module split across a line wrap fails the suite,
   and the matcher's self-test carries that shape as a planted positive.
3. The file docblock states which surfaces the canary covers and which it does
   not, so the next reader does not have to re-derive the walk's boundary.

## Notes

Sequence this after `ui-factor-resolver-source-discipline-canary`'s round-3 hold
lands. That round changes `sourcesUnder`, the brace walk, and `isCommentLine` in
the shared machinery this canary stands on, and item 1 here may touch the walk
again.

---

## [BLOCKED by ui] (2026-09-06)

Blocked on the sibling ui task `ui-factor-resolver-source-discipline-canary`,
whose round-3 hold (`3c1471cb`) is open in `tasks/pending/`. This is the
sequencing dependency this file's own Notes section already names, recorded here
rather than left as an inline note so the block is visible to a startup listing.

Both tasks edit the same two files, and two of the round-3 items land directly on
the surfaces this task widens:

- Round-3 item 3 rewrites `sourcesUnder` to route symlinks by real type into
  `sources` / `foreign` / the walk. Scope item 1 here decides whether the entry
  document becomes a fifth assertion or a widened walk root, and a widened root
  has to keep the same extension census honest. Building that on the pre-item-3
  walk means rebuilding it after.
- Round-3 items 5 and 6 rewrite the residual paragraph of the file docblock (the
  skipped-line exception, and computed / built-string access). Acceptance
  criterion 3 here restates what the canary covers and does not, in the same
  paragraph.

Round-3 item 2 also reworks `isCommentLine`, which both of this task's scopes
read through.

Unblocks when `ui-factor-resolver-source-discipline-canary` reaches
`tasks/review/` with the round-3 fixes landed. The ui agent moves this file back
to `tasks/pending/` at that point.

### Block re-characterized (2026-09-08) — still [BLOCKED by ui]

The condition this note originally named is now literally met: the round-3
fixes landed, and `ui-factor-resolver-source-discipline-canary` has since taken
a round-4 hold and returned to `tasks/review/` at `5598bc46`. It is NOT moved
to `pending/` on that basis, because the sequencing dependency it stands on has
not gone away, it has moved forward one round:

- The task sits in `review/` awaiting a round-5 architect pass over the same two
  files. Round 4 exists because the round-3 review held on them after they had
  already reached `review/` once, so arrival there is not evidence the surfaces
  have settled.
- Round 4 rewrote `sourcesUnder` again (its unguarded link resolution is gone,
  and the docblock sentence about what appears in neither list changed with it).
  Scope item 1 here decides whether the entry document widens that walk root,
  and a widened root has to keep the extension census honest against whatever
  the walk finally does.
- Round 4's signal surfaces six residuals for triage. Two of them land on this
  task's surfaces: the walker splitting files on newlines rather than on every
  ECMAScript line terminator (`sourcesUnder`'s line contract), and three width
  pin sentences in the paragraph acceptance criterion 3 here restates. If the
  architect takes either, this task rebuilds on top of it.

Unblocks when that task is ARCHIVED, not when it reaches `review/`. Archive is
the point at which the walk, the comment predicate and the residual paragraph
stop moving under this one. The ui agent moves this file back to `pending/`
then.

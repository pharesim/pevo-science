# Re-anchor the positional citations in frontend/{src,tests} that the hook's regex cannot see

**Owner:** ui
**Created:** 2026-10-05

Routed out of the architect review of the frontend positional-anchor sweep (archived
2026-10-05, commit 473af3f9). That sweep re-anchored every line the pre-commit hook's
positional regex matches, so the regex now returns zero over `frontend/src` and
`frontend/tests`. Its implementer pointed out that zero says nothing about the forms the
regex cannot see, and listed what is left. This task covers those leftovers.

## Why

The positional arm in `.githooks/pre-commit` is per-line and article-adjacent. It fires on
`the|this|that` sitting directly against a listed structural noun and then `above`/`below`
on ONE line. Three shapes get past it and are still the same rot:

1. **A listed noun split across a line wrap.** Known case:
   `frontend/src/pages/settings.js`, `retryUpgradeBackend`, "beside the subject the guard /
   above just confirmed". The guard is the `_upgradeSubjectDiverged` check right before it.
   The archived sweep fixed the matching sentence in `executeUpgrade` the same way.
2. **Nouns the regex does not list,** such as "the assertion below", "the scrub above" and
   "the stub above".
3. **Plural, counted or bare forms,** such as "the two tests below", "every step below" and
   "see below".

Root `CLAUDE.md` defers the whole-tree-clean gate for these trees until they are swept,
and this residue is what stands in the way. Each bare instance is live rot: if code is
inserted between the citation and its target, the pointer breaks silently.

## Scope

Enumerate from the tree at pickup time, not from a list in this file, because sibling
commits keep moving these files. The implementer's sweep counted roughly 65 forms beyond
case 1. A looser grep on 2026-10-05 returned about 110 comment lines with an article or
quantifier within 30 characters of `above`/`below`, and many of those already carry a
stable name. Search at least for these:

- `above`/`below` within a few words of `the|this|that|these|those|every|each|see`, across
  line wraps (join consecutive comment lines before matching).
- `at the bottom`, `at the top` and `the previous|next <noun>` in comments. The hook's
  header defers the previous/next variant, but this sweep may fix any it finds.

Judge each site on the carve-out's criteria
(`agents/docs/solutions/conventions/positional-anchor-stable-named-container-carve-out-2026-05-20.md`).
A citation is durable when a stable behavioral name rides along in the same container.
A docblock sitting directly on the `describe` or function whose members it counts ("the
two tests below" in the docblock on that `describe`) is a candidate for "left as durable".
Decide each one rather than reflexively rewriting it, and record every "left as durable"
call in the commit message.

## Acceptance criteria

- Case 1 (the `retryUpgradeBackend` line-wrap form) is re-anchored.
- Every other site found by the enumeration is either re-anchored or recorded in the
  commit message as left durable, with the carve-out criterion it meets.
- Every replacement passes the other anchor rules, per
  `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`:
  no task slug, round ordinal, line number, SHA or `tasks-archive` redirect stands in for
  the position.
- Every rewrite is checked against the code it describes. The new name must resolve to
  exactly one target in its file, and the sentence's claim about that target must still
  hold. A citation re-pointed at the wrong target is worse than the bare form it
  replaced.
- Comment-only. No production or test behavior changes, and the frontend unit suite
  stays at its baseline (report the file and test counts and the exit code).

## Not in scope

Widening the hook's positional regex and promoting `frontend/{src,tests}` to a
whole-tree-clean gate. Those are `.githooks/` changes the architect decides after this
sweep lands. The sweep's "left as durable" list is the input to that decision, because
any widened regex has to let those sites through.

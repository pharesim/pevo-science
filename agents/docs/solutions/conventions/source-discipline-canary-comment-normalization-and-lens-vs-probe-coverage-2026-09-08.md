---
title: "A source-scanning canary must normalize comments before it matches, and a prescribed mutation-probe list can only confirm the items it names"
date: 2026-09-08
last_updated: 2026-09-22
category: conventions
module: backend/tests/eslint + code-review process
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "Writing or reviewing a source-discipline canary whose detection is textual (regex over lines) rather than a parse"
  - "The canary's patterns need two tokens adjacent (a column and its `=`, a target list's `)` and its `=`, a keyword and its table) and a comment may sit in that gap"
  - "Several scans in one canary share the same patterns, so one silencing gap disables all of them together"
  - "Deciding whether a guard verified by a prescribed list of mutation probes has been shown to be closed"
  - "Reviewing a scanner that decides what is a comment, a string, or a template, where a wrong decision blanks live code"
symptoms:
  - "A comment between a column and its `=` silences every scan that shares the pattern, not one of them"
  - "A merge-blocking canary stays green for exactly the violation class it exists to catch"
  - "A glob inside a template literal is read as a block-comment opener and blanks the rest of the file"
  - "A parameter placeholder pair, a long docblock, or an apostrophe in template prose puts the scanner into a span or template state it never leaves, switching comment blanking off to the end of the file"
  - "Hundreds of prescribed mutation probes behave exactly as specified while unscripted adversarial search finds dozens of live evasions of the same guard"
root_cause: incomplete_enumeration
resolution_type: workflow_improvement
related_components:
  - development_workflow
  - testing_framework
tags:
  - canary-tests
  - source-discipline
  - comment-normalization
  - mutation-resistance
  - silently-disarmed-guards
  - evasion-enumeration
  - adversarial-review
---

# A source-scanning canary must normalize comments before it matches, and a prescribed mutation-probe list can only confirm the items it names

## Context

`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`
scans `backend/src` and `backend/migrations` as text and asserts that exactly
two statements write `accounts.updated_at`: the finalize UPDATE in each of the
two signup activation handlers. The column is the recency marker both
stuck-recovery lookups in `backend/src/routes/signup-verify.ts` measure
against, and each of those lookups admits a row past the signup
session-binding check. A third writer anywhere in the tree puts finalized rows
back inside a recovery window,
and nothing at the schema layer can refuse it, because a constraint sees a
marker being stamped and not which statement stamped it.

The canary was reviewed against a ten-item hold whose instruction was to verify
every item by mutation in a scratch copy. Doing that confirmed all ten. Running
an unscripted adversarial search alongside it found two classes of defect the
prescribed probes could not reach, and the scanning core was rewritten twice as
a result. Both findings generalize to every textual guard in this repo.

This is the second time the same comment-detection hazard has been hit here
(session history). The frontend sibling canary had already grown a
block-comment region tracker and a whole-file backtick parity pass, and its own
review found that opening a comment region on any line starting with a block
opener swallowed a real closing brace when the opener was markup inside a
template literal. That was recorded as the only genuine regression of its
round. The same review judged the whole-file backtick parity "wrong in
principle but not yet exploitable", and judged the backend canary's total lack
of comment-region tracking a deliberate, accepted divergence. The work
documented here found the exploitable form of the parity problem and reversed
the divergence, because the divergence rested on the assumption that comments
could only cost a canary precision, not silence.

## Guidance

### Normalize comments once, underneath every pattern

Every regex in a scanner like this needs two tokens adjacent: a column and its
`=`, a parenthesised target list's `)` and its `=`, a keyword and the table
after it, a column list's parentheses. SQL admits a comment anywhere it admits
whitespace. So any comment dropped into one of those gaps silences the pattern
that spans it, and because the scans share patterns, one comment silences them
together. Shapes that were green before the fix, each confirmed by mutation:

- a comment between the column and its `=`, in either dialect's spelling
- a comment between a row target list's `)` and its `=`
- a comment carrying parentheses inside a target list, truncating the capture
- a comment carrying a semicolon in prose, ending the statement read early
- a comment naming another table, supplying a nearer and wrong statement head
- a closed block comment ahead of a template literal, dropping the whole line
  from a scan that asked whether a LINE was a comment rather than whether the
  matched position was

The fix is not another pattern. It is a reading layer beneath all of them:
`blankLine` and `blankFile` walk a file from the top and replace every comment
span with spaces of the same length, so reported positions stay true to the
source line, carrying block-comment, template-literal and dollar-quote state
across line boundaries while copying quoted and dollar-quoted VALUES through
untouched. A value keeps its comment markers and its semicolons because it is
part of the statement even though nothing in it is a token. Every scan reads
that one blanked view.

### A scanner that skips what it reads as a comment must UNDER-match

This is the half that matters more than the mechanism. A line wrongly blanked
is a line no scan sees, so the miss is silent and unbounded. A line wrongly
read as live code costs at most a red bar on a statement that was never live,
which is loud and self-limiting. Ambiguity therefore resolves toward reading,
and three live defects came from getting that backwards, each in ordinary code:

- A block comment opener with no closer is not a comment. A Redis key namespace
  ending in a wildcard, written inside a template literal, opened a comment
  that never closed and blanked every following line of its file. `blockCloses`
  now requires a matching closer, and inside a template requires it before the
  template ends. That search runs to the end of the file. The bounded lookahead
  this entry first recorded as the remedy was itself a defect of the same
  family: a bound answers "not a comment" for every block comment longer than
  it, and reads that comment's prose as live source instead. Thirteen block
  comments in the scanned trees run past sixty lines, the longest 159, and a
  `$1..$4` written in the prose of one of them is what opened the phantom span
  in the third bullet below.
- An unescaped backtick in template text ends the template whatever else is
  open there. An apostrophe in prose inside a one-line template was being read
  as opening a string, which swallowed the closing backtick and left the
  template state inverted for the rest of the file. Inside a `${...}`
  interpolation, though, a backtick opens a nested template rather than ending
  the outer one, and applying the rule there inverted the state the other way;
  that is why the interpolation's extent now comes from TypeScript's own parser
  (see `canary-reader-takes-typescript-facts-from-the-parser-not-a-hand-written-lexer.md`).
- A dollar-quote opener has to be an actual dollar-quote opener, and the first
  guard written for this closed only the spelling that had been observed. The
  placeholder-builder idiom this repo writes as a SQL `$` sigil immediately
  followed by an interpolation, `` `$${n}` ``, looks exactly like an opener, and
  reading it as one opened a span that ran to the next literal `$$`, switching
  comment blanking off across the 17 files under `backend/src` that contain the
  idiom. Refusing that one shape left two others live, both ordinary code: a
  parameter placeholder pair, `VALUES ($1,$2)`, reads as a span tagged `$1,$`,
  and `` `${prefix}$1` `` as one tagged `${prefix}$`. Neither tag ever recurs,
  so neither span closes, and blanking was off from there to the end of the file
  in two real modules, 717 lines of one of them. The opener now takes
  PostgreSQL's own tag grammar (empty, or an unquoted identifier) AND requires
  the tag to recur later in the file, the way a block comment must find a
  closer, with the interpolation guard kept alongside both.

The same asymmetry governs smaller decisions: a `--` glued to an identifier on
either side is TypeScript's decrement operator, not a comment, and a comment
marker inside a value is part of the value.

### Assert the reader's terminal state over the real tree

Two of those three defects were first "fixed" against the one spelling that had
been seen, and reasoning about which other spellings exist is what failed both
times. What does not fail is asking the reader itself: walk every scanned file
and assert it ends with no span still open, no block comment, no template, no
quoted span. A file left mid-span had every line after that point copied with
blanking OFF, which is the one defect class that silences all of a guard's
scans together rather than one of them, and the assertion names the file and
the tag it was left holding rather than leaving someone to think of it.

Its reach is worth stating precisely rather than overselling, because the
temptation is to treat it as covering the whole area. It catches the class where
a span never closes. It does NOT catch the bounded-lookahead class above, whose
error direction is over-reading: a comment read as live source leaves no span
open, so the end state is clean while the prose is being scanned as code. Nor
does it catch a state inverted mid-file and put back by a later misread before
the file ends, which leaves the end state clean over every line between. Where
the scanned file is TypeScript, that class is caught by comparing the reader's
template and block state with the TypeScript parser's at every line end, which
names the first line the two disagree at; see `canary-reader-takes-typescript-facts-from-the-parser-not-a-hand-written-lexer.md`.

### A prescribed probe list confirms items; only unscripted search tests closure

Verification ran as five rounds, each with two kinds of agent working in
parallel on isolated copies of the tree.

**Probe agents** were given an explicit list of mutations, each with an expected
outcome ("add a third writer here, expect these two scans red"). Roughly 380
such probes ran. Nearly all behaved exactly as specified. The gaps they found
were almost entirely of the shape "this feature is real but nothing fails
without it", which is dead coverage rather than missing coverage.

**Lens agents** were given no list, only the goal: find a valid statement that
writes the guarded column and leaves the suite green, then prove it by applying
the mutation and running it. Every claim was replayed by an independent agent
that tried to refute it. These found roughly 50 confirmed evasions, several of
them house-style code an author would write by accident, including the phantom
comment region, the inverted template state and the phantom dollar-quoted
span.

The structural reason they find different things: a probe answers "does the
feature I named work", while a lens answers "is the guard closed". A canary is
a claim about everything the tree does not contain, in any valid spelling, so a
finite author-written list can only sample that space. It can confirm the
sampled points behave; it cannot establish that no unsampled point exists. A
checklist does not become a proof by getting longer.

### Check a verification run's summary against its raw record

A multi-agent verification run can report "N raised, N refuted, 0 survivors"
because its verifier agents died before voting, not because the findings were
examined and cleared. "Nobody voted" and "everybody voted no" produce the same
aggregate under a naive majority, so the summary of a damaged run is
indistinguishable from a clean one. This was first recorded here, and it has
since recurred often enough, and grown enough remedy, to have its own entry:
see `rate-limited-fanout-reports-clean-and-the-fix-cannot-live-in-the-script-2026-09-16.md`
for the recurrence record, why a written reading-discipline does not close it,
and the two shapes that do.

The rule to carry from here: reconcile dispatched voters against returned ones
before believing any verdict summary, and read the raw per-agent record after
any interruption.

## Why This Matters

No behavioural test can catch what this canary guards. Reaching either bypass
needs a row already in the narrow post-finalize state plus a valid ownership
proof at the right route, so a rogue third writer changes nothing observable at
the wire until someone exercises a recovery path against a finalized account,
which is the incident and not a failing test. The canary's whole value is the
completeness of its claim, so a comment-matching gap does not make it fail
loudly. It makes it pass while asserting nothing, which is worse than not
having it, because a green bar reads as an active guarantee.

The cost asymmetry is what should drive the design. Over-refusing produces a
red bar someone investigates. Under-reading produces silence that survives
until the incident it was written to prevent.

## When to Apply

- Writing or reviewing any textual canary that scans source for a forbidden or
  licensed shape, and any change to the shared scanning helpers such a canary
  builds on.
- Reviewing a claim that a guard is "verified by mutation": ask whether the
  mutations came from a fixed list. If so, that is confirmation of the named
  items and not evidence the guard is closed. Ask whether an open-ended
  adversarial pass with independent refutation ran too.
- Any time a scanner's patterns need two tokens adjacent in a language that
  admits comments or whitespace between them. Ask what happens when a comment,
  a line break, or a string value sits in the gap.
- Any time a scanner decides that something opens or closes a comment, a
  string, or a template. Audit each decision for direction: the wrong answer
  toward "comment" is silent, the wrong answer toward "code" is loud.
- Triaging any multi-agent verification run whose findings are scored by vote,
  before accepting a clean summary.

## Examples

The reader in the accounts-updated-at writer canary is the worked example.
`blankLine` and `blankAll` are the shared normalization layer, the second
returning the end state the assertion above reads, `statementAt`
reads a whole statement from a head to its terminator over the blanked text,
`targetTable` resolves an assignment to the statement head that actually
reaches its position and fails closed rather than borrowing a nearer
statement's table, and `assignmentIndexes` tallies every write rather than
every line, which is what stops a second write from hiding beside a licensed
one inside the same long route handler. A separate arm refuses any statement
too long to read to a terminator, because a statement the scan could not read
whole is one it cannot clear.

The failure messages carry the invariant rather than the drift. Their shared
rationale constant tells the next author what test a new writer actually has to
meet: not what its WHERE clause says, but whether it can ever bump the marker
on a finalized row.

## Related

- `canary-reader-takes-typescript-facts-from-the-parser-not-a-hand-written-lexer.md`
  is the next rung for this same reader: the TypeScript facts it depends on come
  from the parser, and its carried state is asserted against the parser at every
  line end, which covers the inversion a clean end state cannot show.
- `source-discipline-canary-detection-must-survive-ordinary-authoring-shapes-2026-08-31.md`
  is the closest neighbour and treats comments as a detection-reach hazard, but
  scopes its fix as a per-scan trailing-comment strip whose safe direction it
  decides from scan polarity. That generalization needs narrowing: a comment
  splitting two tokens a pattern needs adjacent under-matches on a forbidden
  scan too, which is the direction that doc treats as safe there.
- `composite-mutation-probe-does-not-cover-its-constituent-branches-2026-09-06.md`
  is the same family on a narrower axis. It shows a probe can prove a mechanism
  exists without covering its branches; this entry shows a whole list of probes
  can pass while the guard stays open.
- `rate-limited-fanout-reports-clean-and-the-fix-cannot-live-in-the-script-2026-09-16.md`
  carries the vote-aggregation material this entry first recorded, promoted out
  so it is findable from the direction a damaged review summary is met from.
- `new-fail-closed-outcome-must-not-reuse-an-existing-sentinel-2026-09-15.md`
  came out of the very run whose summary is described above. It explains why the
  author's own probes could not find the defect; this entry explains why the pass
  that did find it reported nothing.
- `mutation-probes-are-per-site-not-per-fix-2026-08-31.md` and
  `source-discipline-canaries-must-assert-at-call-site-not-file-granularity-2026-08-26.md`
  are earlier rungs of the same ladder, about what a probe covers and what a
  canary collects. Normalization happens before either question.
- `fail-closed-does-not-transfer-from-set-equality-to-pairing-canaries-2026-08-31.md`
  covers the shared symbol-attribution module these canaries build on.
- `static-sql-lint-rule-blind-to-extracted-fragments-2026-06-14.md` is the
  sibling blind spot: a fragment moved out of the statement defeats a static
  text scan the same way a comment moved into it does.

---
title: "Unifying two consumers onto a shared constant stops them drifting from each other, not the constant's own membership from being wrong"
date: 2026-09-16
category: conventions
module: backend/tests/eslint
problem_type: convention
component: testing_framework
severity: high
related_components: [development_workflow]
applies_when:
  - "A fix replaces two separately-maintained enumerations with one shared constant consumed by both"
  - "A canary pairs a live arm that scans the real tree with a fixture helper that mirrors it"
  - "A commit or docblock claims a shared-constant refactor closes a gap, where the gap closed is disagreement between consumers"
  - "Deciding whether a guard is verified because two things that read the same list now agree"
tags: [canary-tests, source-discipline, mutation-resistance, shared-constant, membership-coverage, vacuous-pass, mirrored-consumers]
---

# Unifying two consumers onto a shared constant is not membership coverage

## Context

`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts` is a
source-scanning canary. It reads the repo's own TypeScript and SQL as text and asserts that
`accounts.updated_at` is written by exactly two statements, the `/confirm` and `/link` finalizes in
`backend/src/routes/signup-verify.ts`. Its failure direction is inverted from an ordinary test's: it is supposed
to go red when a third writer appears, so the risk that matters is it going GREEN while that writer
sits in the diff.

One arm, `every accounts statement can be read whole`, backstops the others. A scan asking "does
this SET list carry the column" can only answer for a statement read all the way to a terminator; a
truncated read reports that the statement carries nothing. So that arm walks the set of statement
"head" patterns the other arms anchor on and asserts each statement opened by one closes cleanly. A
fixture helper, `unreadableIn`, mirrors the arm so tests can plant synthetic lines.

The arm learned a second head, `ALTER_ACCOUNTS_RE`. Its mirror did not. Two enumerations of one set
drifted after an edit touched only one of them.

The drift was found while documenting a different defect, and deliberately deferred at the time
because a `/ce-compound` run does not edit source (session history). When it was fixed, the fix was
the shared constant, and the reasoning was recorded in the session:

> The `unreadableIn` drift I fixed structurally rather than by patching the one copy [...] patching
> the mirror would have left the same two-copies shape for the next widening.

That reasoning is sound and the fix is the right one. The constant is now read by both the live arm
and `unreadableIn`:

```ts
const READ_FROM_HEADS = [ACCOUNTS_STATEMENT_RE, ALTER_ACCOUNTS_RE];
```

## Guidance

Name precisely what a unification buys before treating it as coverage. It converts a TWO-PLACE drift
risk, where the arm and its mirror can be wrong relative to each other, into a ONE-PLACE drift risk,
where the constant is wrong and both consumers are wrong together in the same way. It adds no test
that the constant's membership is right.

A test comparing consumer A against consumer B passes trivially the moment both read the same value,
correct or not. That comparison is the only thing a mirror helper exists to let you write, so the
structural fix removes the disagreement AND removes the instrument that would have detected it.

Verify membership by mutation, in an isolated copy, never the shared checkout:

1. Plant a migration with a truncated `ALTER TABLE accounts`, for example an
   `ADD COLUMN ... DEFAULT '...'` whose string wraps onto a continuation line, ahead of an
   `ALTER COLUMN updated_at TYPE ... USING ...`.
2. With `READ_FROM_HEADS` as committed, `every accounts statement can be read whole` reds and names
   the line.
3. Drop `ALTER_ACCOUNTS_RE` from the constant, leaving the planted migration in place. The whole
   suite stays green, exit 0. The truncated ALTER is invisible. (Read the exit code rather than a
   test count: the arm count has grown since this was first measured.)

Three things had to hold at once for that gap, and all three did:

- `unreadableIn` was called once, with a fixture matching `ACCOUNTS_STATEMENT_RE` and never
  `ALTER_ACCOUNTS_RE`. No fixture was positioned to hit a hole in the ALTER coverage.
- The live arm runs only against the real trees, which carry no unreadable ALTER, so it reports an
  empty list either way. An arm that scans a clean tree cannot witness the completeness of the set
  it scans with.
- `accountsColumnAlterations`, the nearest thing that looks like ALTER coverage, matches
  `ALTER_ACCOUNTS_RE` directly and never reads `READ_FROM_HEADS`. Its result is independent of the
  constant, so it cannot stand as a witness for it.

The instance fix is a fixture pinning the ALTER head through `unreadableIn`, so dropping the member
reds by construction. That landed: a wrapped-`DEFAULT` ALTER asserted through the mirror, with the
single-line spelling as its control, and dropping the member now reds. The class fix, still open, is
an assertion that every head pattern a `statementAt` call site reads from is a member of the set, so
widening the readers reaches the assertion without anyone remembering to widen the constant too.

The gap is therefore closed for this constant and this member. What is recorded here is the shape,
which outlives the instance: the sharing that removed the drift is the same act that removed the
instrument, and only a fixture planted against the set itself put one back.

## Why This Matters

The shape recurs wherever two consumers are unified onto a shared value to fix a disagreement: a
constant, a config object, an allowlist, a schema. Unification is real progress and it is easy to
mistake for coverage of whatever the value is FOR.

It is a different failure from ordinary mirror drift, where two copies fall out of sync and a diff
between them tells you something is wrong. Here the copies AGREE. There is no diff to notice. The
failure shows up only as an absence: a scenario the tool was built to catch, passing silently, with
no red bar pointing anywhere.

There is a second, sharper lesson in how this one was reported. The commit that introduced the
constant states a mutation probe as evidence:

> dropping the ALTER head from the shared set turns the wrapped-DEFAULT fixture green, and restoring
> it reds

Session history confirms a probe was run at the time and reported exactly that. It does not
reproduce against the committed tree. Dropping the member leaves the whole suite green, and the
wrapped-DEFAULT fixture asserts through `accountsColumnAlterations`, which never consumes the
constant, so it was green under both spellings and could not red on that mutation at all. The claim
was not reproducible as written, whatever was actually executed. (The fixture that does pin the
member, added later, asserts through `unreadableIn` instead, which is the helper that reads the
constant.)

That makes this the second self-reported "verified load-bearing" claim on this file to fail
re-execution, alongside a reuse-margin measurement in the same docblock that a later refresh found
false and corrected twice. A mutation claim is evidence only when someone other than its author can
re-run it. Prefer committing the probe as a fixture over reporting that you ran it: a fixture reds
for the next reader, a sentence in a commit message does not.

## When to Apply

- Reviewing a fix that unifies two enumerations, allowlists, or pattern sets onto one shared
  constant, specifically when the bug was framed as "these two disagreed".
- Before archiving a task whose fix is described as "named it once, both consumers read it now". Ask
  what test fails if the constant omits a needed member, as distinct from what fails if the two
  consumers disagree.
- When a canary pairs a live arm that runs only against the real, currently clean tree with a
  fixture arm standing in for defects. Check the fixture arm covers every pattern the live arm
  consumes, not only the patterns that existed when it was written.
- Any time a coverage claim rests on comparing two code paths to each other rather than on a planted
  positive fixture. The comparison proves consistency, not correctness.

## Related

- `dedup-shared-constant-defeats-test-value-pin-2026-05-26.md` is the parent pattern: routing a
  test's expected value and the value under test through one symbol removes the ability to detect
  drift in that symbol. That entry works a scalar, where the fix is an independent literal pin. This
  one works an enumerated set, where the fix is a completeness assertion tied to what reads from it.
- `new-fail-closed-outcome-must-not-reuse-an-existing-sentinel-2026-09-15.md` recorded the
  `unreadableIn` drift as an open residual. The shared constant closed that residual, and closing it
  is what exposed the gap documented here. That entry's residual paragraph has been updated to point
  back at this one.
- `composite-mutation-probe-does-not-cover-its-constituent-branches-2026-09-06.md` is the same
  principle one construct over: deleting a whole mechanism proves it is load-bearing, not that each
  branch is covered. Dropping one member while the array survives is the membership analogue.
- `source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage-2026-09-08.md` is an
  earlier round on this same file, and carries the related point that a prescribed probe list
  confirms items while only unscripted search tests closure.

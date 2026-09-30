---
title: A reader's bound restated at N sites reads as sufficient at each one
date: 2026-09-22
last_updated: 2026-09-30
category: conventions
module: backend/tests/eslint
problem_type: convention
component: testing_framework
root_cause: incomplete_enumeration
resolution_type: workflow_improvement
severity: high
applies_when:
  - Writing or reviewing the KNOWN LIMITS list or per-function docblocks of a hand-written lexer, scanner or textual canary
  - A hold, review comment or convention prescribes a sentence to be carried to several sites that describe the same fact
  - A docblock summarises a predicate with more than one branch, an early return, or a guard some branches skip
  - A comment claims a shape is silent, or that a consequence holds nowhere unless some condition
  - Reviewing a prose-only commit on a scanner file, where nothing executes the claims
  - The same multi-part condition has to be mentioned at several sites, and each review pass finds another site carrying only part of it
tags:
  - canary-tests
  - source-discipline
  - hold-block
  - docblock
  - necessary-vs-sufficient
  - adversarial-review
related_components:
  - development_workflow
  - code-review
---

# A reader's bound restated at N sites reads as sufficient at each one

## Context

`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts` is a vitest canary that scans `backend/src` and the migrations textually for anything that writes `accounts.updated_at` outside the licensed writers. Textual means it carries its own reader rather than a parser: `blankLine` and `blankFile` blank comments and record span events, `enclosingQuote` decides which string literal a position sits inside, `statementAt` reads one statement from its head to a terminator, `joinedByPlus` decides whether that statement is concatenated onto more text, and the arms above them (`assembledWrites`, `accountsColumnAlterations`, `unreadableStatements`, and the fail-closed resolution arm over `targetTable`) each ask one question of the result.

A hand-written reader has bounds a parser would not, so the file writes them down. The header ends in a KNOWN LIMITS list, and each scan's docblock restates the bound that governs it. An architect hold prescribed one of those bounds in words: the `+` join is read only where the literal's opening quote shares a line with the head, and a template opened on a line above its head is a silent join. The implementer stated it in the dynamic-SQL KNOWN LIMITS entry and carried the same sentence to six further places that describe the same recognition: header item 4, the `SQL_INTERPOLATION_RE` docblock, the `joinedByPlus` docblock, the `assembledWrites` docblock, a fixture comment in the assembled-write spec, and the `enclosingQuote` docblock, whose own bound is what the entry cites as the mechanism. The `statementAt` docblock was bounded in the same pass for the neighbouring claim it makes, about where the read ends. The change was prose only. No behaviour moved.

Four adversarial verification passes followed, producing the five findings below. Each finding was checked by two independent refuters, and each measurement was a plant and a control run against the real canary in a `git archive` scratch copy. Three of the four passes falsified a sentence this work had itself written one pass earlier:

- The restatements read as **sufficient** conditions. A head whose own literal opens on its line after a template from above closes there satisfies the stated condition and is still silent: `enclosingQuote` reads the head's line from its start with no quote open, so it takes the earlier template's closing backtick for an opener and the head literal's real opening backtick for its close, and returns null. Measured: the plant left the canary at 29 of 29 tests passing; the control with the earlier template closed on its own line reds `[concatenation]`.
- The same pass carried an "are nowhere" clause covering every unrecognised join. A SET-list fragment joined that way reds the fail-closed arm, because the upward walk from the fragment's assignment token finds no head at all, or the nearest head it finds has a read that does not reach the assignment. The walk asks the nearest head only, so a farther head whose read would reach does not rescue it. A carve-out sentence saying an equality inside a `USING` expression or a `CHECK` is read as an assignment was over-broad in the other direction: `COLUMN_ASSIGNMENT_RE` requires the column immediately before the `=`, so `created_at = updated_at` and `updated_at::date = ...` leave the fail-closed arm green.
- The next pass was still sufficient-sounding. The `+` after the quote is looked for past where the **read** stopped, not past where the literal ended, and a literal holding an odd other-quote character carries the read past its own close through `statementAt`'s opaque-value state. That is how a concatenated quoted identifier is spelled, and it is silent in every arm.
- The correction then applied the read-stop condition to the whole join test. But `joinedByPlus` tests the before-quote half first and returns from it, ahead of its `closedAt === -1` guard, so that half needs only a quote found on the head's line and fires whatever the read went on to reach. Measured: a `pre +` join against an unterminated template head still reds `[concatenation]`.
- The last pass found the KNOWN LIMITS entry's own copy of the gate was the one left un-split, and wrong on either reading. Its "reds nowhere unless" list also missed a third catcher: `accountsColumnAlterations` tests the column name against the statement text rather than an assignment.

Every falsified sentence was a correction written in the pass before it. The pattern is not that the original bound was wrong. It is that restating a bound, and then fixing a restatement, each produce a fresh falsifiable claim that nobody had measured.

The same shape then recurred on this file in the prose about the fail-closed walk, and how it ended is the part worth keeping. `targetTable` buckets an assignment under the nearest head's table only when that head's read reaches the assignment, and reaching has two halves: the read did not give up (`SqlStatement.stopped`), and it ended past where the assignment's column token begins. Later review passes kept finding a restatement site that carried less than both. One set of sites promised the bucket where the head's read reached the fragment holding the assignment rather than the assignment itself. The correction to those, "runs on to the assignment", then bucketed a read that passes the assignment and gives up on a later line, which `targetTable` refuses. Each was measured with a plant and a control, and each erred in the loud direction, but patching the sites a pass had named did not converge, because every patch was one more restatement. It converged when the sites stopped restating. Each now states the consequence with the defined verb and defers what reaching asks of a read, by name, to the one KNOWN LIMITS entry that defines it. Even that fix carried a fresh claim in its first draft: it said reach "is defined once" in that entry, and the `targetTable` docblock, which legitimately spells the same two halves beside the code, falsified the count before the change landed.

This file's history already carried the same shape at a smaller scale (session history): a fixture comment in a sibling task claimed "every change to the branch that reds it reds one of these three as well", and an adversarial mutant kept the three asserted spellings matching while missing an unasserted fourth. Earlier rounds also found hold-block and signal-block counts that were wrong the moment someone executed them instead of re-reading them.

## Guidance

When you document a hand-written reader, lexer or scanner, treat each sentence about its bounds as a claim to be measured, not as a copy of a sentence that was already agreed.

1. **A restated bound is N claims, not one.** Carrying a prescribed sentence to seven sites does not carry its truth. Each site sits in a different surrounding paragraph, and that paragraph fixes a different reading: which function the sentence is about, which half of a two-branch test it governs, whether the condition is offered as necessary or as sufficient. Verify the sentence at each site against the code at that site.

2. **A reader's bound is a necessary condition, so write it as one.** "The join is recognised where `enclosingQuote` found that literal's opening quote on the head's line" reads as a rule that fires. What the code has is a condition without which nothing fires, which is a different sentence. When the "where X" form is the natural one, name what else has to hold in the same sentence, or state the bound negatively: where X does not hold, the arm is silent.

3. **A predicate with branches needs a sentence per branch.** `joinedByPlus` has two: one testing the head line's text before the quote it found, one testing the text after where the read stopped. They answer to different things, and the first returns before the second's guard runs. One sentence about "the join test" will be wrong for one of them. Read the control flow for early returns before writing a single-sentence summary.

4. **Describe where the read stopped, not where the source construct ends.** A scanner's observable behaviour is its own stopping position, a property of its state machine rather than of the grammar it imitates. `statementAt` stops at the head literal's delimiter unless an unmatched `'` or `"` inside the literal put it in its opaque-value state first, in which case it runs on to the matching character. A sentence saying "after the literal's closing quote" is about the source. A sentence saying "past where the read stopped" is about the reader, and only the second one is checkable.

5. **Do not close a list you have not enumerated against the code.** "Two layouts do this" and "reds nowhere unless" are closed sets, and a scanner with several arms usually has one more catcher than the sentence remembers. Give examples, signalled as examples, unless you have walked every arm. When you do state a consequence, name each arm that can still fire.

6. **Scope a silence claim to the exact spelling you measured.** The concatenated quoted identifier is silent on one line with nothing joined past its last literal. Wrapped over lines, the read ends inside the value and the every-statement-readable arm reds it by line; with a `+` past its last literal, the join is read. A claim measured on one spelling and stated about a shape is a claim the next spelling falsifies.

7. **Every correction gets its own plant and control.** A fix to a falsified sentence is a new assertion about behaviour that nobody has run. Plant the shape the new sentence says is silent and confirm the suite stays green, then run the control that differs only in the feature the sentence names and confirm both that it reds and which arm reds. A green plant alone does not distinguish "the bound holds" from "the plant was malformed".

8. **Define a multi-part condition in one place and have the other sites defer to it by name.** When the same predicate has to be mentioned at several sites, a site that restates it will sooner or later carry only part of it, and a sweep that patches the sites a review named leaves the next restatement for the next review. State the consequence at the site with the defined verb, and point at the place that defines the verb, restating no part of the condition. Three things keep the deferral honest. Name the definition and do not count it: "defined once" or "only there" is a closed set of the kind item 5 warns about, and a consumer's docblock beside the code may legitimately spell the same condition. Check that the target really defines what the site defers to it, against the code's own expression, term for term. And make the definition anchor each of its own terms: one that says a read "did not give up" without linking where giving up is enumerated sends the reader on a second hop that nothing names.

## Why This Matters

A canary's KNOWN LIMITS list is the only thing standing between it and false confidence. Where the list is accurate, a reader knows which shapes to review by hand and which the scan covers. Where a limit is stated as narrower than it is, the list actively misleads: a reviewer reads "a template opened above its head is the silent case", concludes that their head-on-its-own-line code is covered, and ships a write the canary never saw. That is worse than no list, because the reviewer would otherwise have looked.

The failure compounds through restatement. One prescribed sentence became eight, and each one that read as sufficient was a separate invitation to that wrong conclusion. Prose in a hand-written-reader file is load-bearing in the same way the code is, but nothing runs it, so it only gets checked when someone decides to measure it.

There is also a cheap-verification argument. Each finding cost one plant and one control against a scratch copy, about a minute apiece, and each falsified a sentence that had already passed a careful human read. Reading a sentence about a scanner is a poor test of whether it is true, because the sentence and the reader are both plausible.

## When to Apply

- Writing or reviewing the header, KNOWN LIMITS list, or per-function docblocks of any hand-written lexer, scanner, tokenizer or textual canary, in this repo or another.
- A hold, review comment or convention prescribes a sentence to be carried to several sites. The prescription is a claim about the code, and the sites are where it gets tested. A prescription is itself in scope for correction, as `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` and `hold-prescriptions-prescribe-invariants-not-constructs-2026-06-12.md` already hold for neighbouring cases.
- A docblock summarises a predicate that has more than one branch, an early return, or a guard some branches skip.
- A comment states what a scan does not catch, claims a shape is silent, or says a consequence holds nowhere unless some condition.
- Reviewing a prose-only commit on a scanner file. Prose only does not mean risk free; it means the risk sits entirely in claims nothing executes.
- Following up a correction to such a sentence. The correction has the same standing as what it replaced.
- A review keeps finding one more site that states part of a condition the file already states in full elsewhere. Stop patching the sites and make them defer to the full statement by name.

## Examples

Every snippet below was planted in `backend/src` inside a scratch copy and run against the whole canary.

**Sufficient-sounding restatement, and the layout that falsifies it.** `enclosingQuote` starts each line with no quote open and scans from column 0 to the head's index, so the only quotes it knows about are the ones on that line, read flat:

```js
// PLANT: the head literal's opening backtick IS on the head's line, which is
// what the restated bound asked for, and the join is still silent (29/29).
// The earlier template closes on this line, so that closing backtick reads as
// an opener and the head literal's real opener reads as its close.
const sql = `SELECT 1;
  ` + `ALTER TABLE accounts DROP COLUMN ` + column;

// CONTROL: the only difference is where the earlier template closes. Now
// enclosingQuote finds the head literal's own opener, the read stops at its
// backtick, and the ` + column` past it reds [concatenation].
const sql = `SELECT 1;` +
  `ALTER TABLE accounts DROP COLUMN ` + column;
```

**Read stop versus literal end.** `statementAt` enters its opaque-value state on a `'` or `"` that is not the head literal's own delimiter and consumes everything to the matching character:

```js
// Silent in every arm (29/29). The " opens an opaque value, the literal's own
// closing ' is consumed as data, the read runs on to the " near the end, and
// joinedByPlus looks for its + past THAT, where there is none.
await q('UPDATE accounts SET "' + column + '" = now() WHERE id = $1', [id]);

// CONTROL: drop the stray quotes. The read stops at the first literal's
// closing quote, the + sits right after it, and it reds [concatenation].
await q('UPDATE accounts SET ' + column + ' = now() WHERE id = $1', [id]);
```

**Naming every catcher instead of closing the list.** A join the assembled-write scan does not recognise is not therefore invisible. Two other arms can still fire, and the consequence sentence names all three:

```js
// Reds the fail-closed arm only: the walk up from the fragment's assignment
// token finds no head whose read reaches it. Here it finds none at all, since
// the statement's own head sits on the line below, where the walk never looks.
const setList = 'updated_at = now()';
await q('UPDATE accounts SET '.concat(setList, ' WHERE id = $1'));

// Reds the ALTER arm only: accountsColumnAlterations tests the column NAME
// against the statement text, not an assignment.
await q('ALTER TABLE accounts RENAME COLUMN updated_at TO '.concat(next));

// Green (29/29): the name is in the variable, so no arm has a token to key on.
// Only a read that reached no terminator would put this in front of the
// every-statement-readable arm.
await q('ALTER TABLE accounts '.concat(clause));
```

**Two branches, two sentences.** `joinedByPlus` tests the before-quote half first and returns from it, ahead of the `closedAt === -1` guard. A single sentence gating "the join test" on the read having reached a terminator is wrong for that half: a `pre +` join against an unterminated template head still reds `[concatenation]`. The docblock now says the first half is skipped where no quote was found on the head's line and, being tested first, answers whatever the read reached afterwards, while the second reads past the stop and is false where no terminator was reached.

**Deferring by name instead of restating.** The restated sentence, and the layout that falsifies it:

```js
// "where that nearest head's read runs on to the assignment, the assignment is
// bucketed under that head's table instead"
//
// PLANT: reds the fail-closed arm, where that sentence predicts a bucket under
// widgets. The widgets read passes the assignment and then gives up on the next
// line, which ends inside a value.
export const a = `
  UPDATE widgets
  SET a = 1`
export const b = `
  b = 2,
  updated_at = now(),
  c = 'left open
`;

// CONTROL: close the value (c = 'closed here') and the suite is green. The
// read reaches the assignment and the walk buckets it under widgets.
```

The sentence that replaced it says what happens and leaves the condition to its definition: "where that nearest head's read does reach it, the assignment is bucketed under that head's table instead. What reaching asks of a read is defined in the dynamic-SQL entry under KNOWN LIMITS, which also gives the three buckets." The label's own docblock takes the matching two-disjunct form, one disjunct per `UNRESOLVED_TABLE` return in `targetTable`: the upward walk finds no head at all, or the nearest head it finds has a read that does not reach the write.

## Related

- `canary-reader-takes-typescript-facts-from-the-parser-not-a-hand-written-lexer.md` — the structural answer for the same file: where a hand-written rule cannot be made sound, take the fact from the parser. This entry is for the branches that remain hand-written and have to be described.
- `a-parsers-line-is-not-the-readers-line-unless-built-from-the-same-split.md` — the comment that belongs beside a hand-rolled position-to-line conversion, same file, same day.
- `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` and `hold-prescriptions-prescribe-invariants-not-constructs-2026-06-12.md` — a prescription, and a fix made to satisfy one, are both in scope for review.
- `sibling-docblock-tallies-must-each-state-precisely-what-they-count-2026-09-09.md` — nearby docblocks describing the same-looking fact must each state precisely what they test.
- `comment-sweep-expansion-must-audit-added-clause-behavioral-accuracy-2026-05-20.md` and `completeness-claim-tasks-need-independent-re-enumeration-2026-06-14.md` — the closest prior art on measuring an added clause and re-enumerating a completeness claim.
- `source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage-2026-09-08.md` and `mutation-probes-are-per-site-not-per-fix-2026-08-31.md` — probe discipline these measurements relied on.

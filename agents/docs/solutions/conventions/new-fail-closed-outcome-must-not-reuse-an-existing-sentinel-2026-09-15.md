---
title: "A new fail-closed outcome must not reuse a sentinel that already means the opposite, or the untouched consumer reads it as reaching"
date: 2026-09-15
last_updated: 2026-09-22
category: conventions
module: backend/tests/eslint
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "A reader, parser or resolver gains a new give-up return path that reuses a sentinel it already returns for a different exhaustion condition"
  - "The new outcome means unknown or fail-closed while the existing sentinel means ran-out or keep-going, so one value now carries opposite meanings"
  - "Signing off a reader rewrite whose verification is mutation pins and deletion sweeps scoped to the changed function"
  - "A reader and the arm that reports its failures are maintained separately, so an input can become unreadable without becoming reported"
  - "Reviewing a hardening round, and asking whether it converted a red bar into silence rather than closing a hole"
related_components:
  - development_workflow
  - authentication
tags:
  - canary-tests
  - source-discipline
  - fail-closed
  - consumer-audit
  - sentinel-overloading
  - outcome-vocabulary
  - mutation-testing-limits
---

# Widening a reader's outcome set by re-using an existing sentinel: the damage lands at the consumer, not at the function you changed

## Context

`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts` is a standing source-discipline canary. It asserts that `accounts.updated_at` is written by exactly the two signup finalizes in `backend/src/routes/signup-verify.ts`, plus the one licensed back-fill in the migration that introduces the column, and by nothing else anywhere in `backend/src` or `backend/migrations`. The reason is security-adjacent and spelled out in the file's own `ORDERING_RATIONALE`: both stuck-recovery lookups in `backend/src/routes/signup-verify.ts` admit a row past the signup session-binding check by measuring recency against that marker, and the `/link` lookup additionally conjoins the ordering `upgraded_at <= updated_at` in its stuck-recovery WHERE clause. That ordering only holds while no third statement stamps the marker. A silent pass in this canary is a binding-free session mint, not a style nit.

To decide whether a given `updated_at = NOW()` belongs to an `accounts` statement, the canary reads SQL. `statementAt` reads one statement from a head to its terminator and returns an `SqlStatement`; `targetTable` walks upward from an assignment to the nearest statement head and asks whether that head's statement actually *reaches* the assignment. The reach question is answered from the `SqlStatement` fields.

For a long time `closedAt: -1` meant exactly one thing: the read hit `LITERAL_CAP` (40 lines) or the end of the file without finding a terminator. Semantically that is *"the statement runs on past everything below it"*, so it **does** reach a write further down.

A rewrite of the statement reader (landed on `main` as commit `b901abe7`) added a second, deliberate producer of `closedAt: -1`: a **fail-closed stop**, taken when the dollar-quoted span carrying the head closed before the statement ended, or when a line ended inside an unbalanced value. That answer means the *opposite*: the statement's extent is unknown, so it reaches **nothing**. The reader's own docblock says so in as many words (`statementAt`, in the same file): *"A READ THAT CANNOT REACH ITS OWN TERMINATOR MUST NOT RESOLVE A TABLE... Refusing to resolve is a red bar naming a line; resolving to the wrong table is silence."*

The rewrite did not touch `targetTable`. Its reach expression was still written for the old, single meaning. Two opposite answers now arrived through one sentinel, and the consumer spent the fail-closed one as a reaching one.

### This is the fourth time, not the first (session history)

The same shape has landed in every review round this canary has had, which is
why it is worth a written rule rather than a fix:

- An earlier round hardened `blankLine`'s dollar-quote opener with a recurrence
  guard and an interpolation exclusion. `statementAt`'s opener got neither, so
  the two readers disagreed about what opened a span. The shape was
  not hypothetical: the placeholder idiom the exclusion existed to refuse occurs
  in three figures across `backend/src`. What made it survivable is that no
  statement read reaches a grammatical opener over either tree, so the
  divergence was latent rather than live, which is exactly the condition under
  which a reader drift outlives the round that created it. One function was
  hardened; its sibling reader kept the old semantics.
- An earlier round again: `blockCloses` gave up at a fixed lookahead and
  reported "no closer found", which is the same answer it returns for a comment
  that genuinely never closes. The give-up outcome was already being encoded as
  a genuine negative, two rounds before the `closedAt` collision. That one was
  resolved by removing the bound rather than by naming the outcome, so the
  lesson did not generalise.
- The structural remedies each round reached for were right and local: share one
  opener helper so two readers cannot disagree; make the dialect ride with the
  blanked text rather than threading a flag through every call site. Both are
  instances of this rule. Neither was ever stated as one, so the next round
  re-derived it from scratch.

The existing convention nearest to this ground covers auditing your own
replacement text, not auditing every consumer when a shared function's return
contract changes underneath them. That gap is what this entry fills.

## Guidance

### 1. Treat "this function gained a new outcome" as a consumer-audit trigger, not a local change

When a reader, parser, tokenizer, resolver, lookup or validator gains a new return path, the question that decides correctness is not *"is the new path right?"* It is *"does every existing consumer of the value I reused still read it the way I now mean it?"*

Mechanically: grep for the sentinel's test, not for the function name. `closedAt === -1`, `!== -1`, `=== null`, `== null`, `.length === 0`, `|| 0`. Each hit is a consumer that encoded a meaning at a time when the sentinel had one meaning. For each, decide explicitly which of the two meanings that expression wants. In this canary the grep returned four consumers of `closedAt === -1`, and they wanted different things:

| Consumer | What it asks | Wanted which meaning | Verdict |
|---|---|---|---|
| `targetTable` reach test | does this head's statement reach the assignment | ran-out only | **broken by the fork** |
| `joinedByPlus` | is there text after the terminator | neither; it cannot compute without one | sound, and pinned |
| `every accounts statement can be read whole` | report this statement as unreadable | both | sound, but see rule 5 |
| `unreadableIn` fixture helper | the same question, for fixtures | both | **enumerated one head pattern of its own** |

Note the fourth row. The grep is what surfaced it, and it is the drift rule 5
warns about sitting inside the very change that introduced the rule: a helper
mirroring an arm, updated in the arm and not in the mirror. Three of the four
were fine, and that is the point rather than a footnote: an
audit that finds nothing at two call sites and a live defect at the third is the
audit working. `joinedByPlus` was checked rather than assumed, by planting a
statement that both stops early and interpolates: two arms red on it, so its
bail-out is backstopped, and deleting its guard reds an assertion, so it is
pinned. Clearing a consumer with evidence costs one probe; clearing it by
reasoning is how the third one gets missed.

### 2. Prefer a new named outcome over overloading a sentinel

The fix (landed on `main` as commit `a28b3a69`) did not make the consumer smarter. It made the answer unambiguous by adding a field, so the distinction is in the data rather than in each consumer's head:

```ts
interface SqlStatement {
  text: string;
  lastLine: number;
  closedAt: number;
  quoteAt: number;
  /** Whether the read GAVE UP rather than ran out of room.
   *
   *  Both answers report `closedAt: -1`, and they mean opposite things to
   *  {@link targetTable}. Hitting the cap or the end of the file means the
   *  statement runs on past everything below it, so it does reach a write there.
   *  Giving up ... means its extent is UNKNOWN, and a statement of unknown extent
   *  must lend its table to nothing. Reading the one flag for both is how a
   *  fail-closed answer gets spent as a reaching one. */
  stopped: boolean;
}
```

Each of `statementAt`'s three return sites now states its own answer explicitly (`stopped: false` at the terminator, `stopped: true` at the single give-up return that covers both stop conditions, `stopped: false` at the cap/EOF fallthrough), and the reach test in `targetTable` reads:

```ts
const reaches =
  !reach.stopped &&
  (reach.lastLine > lineIndex ||
    (reach.lastLine === lineIndex && (reach.closedAt === -1 || reach.closedAt > at)));
```

Cost: one boolean field. Benefit: the next consumer added does not have to reconstruct which of two opposite histories produced a `-1`.

A discriminated union is the stronger form of the same move where the shape allows it; a sibling flag is the cheap form when the other fields stay meaningful in both outcomes, which is the case here (`text` and `lastLine` are still what the read got to).

### 3. Pin the new outcome at the CONSUMER's observable, not at the reader's return value

`expect(read.stopped).toBe(true)` is green whether or not `targetTable` honours the flag. It asserts the producer, and the defect was in the consumer. The pin that discriminates asserts the end-to-end effect:

```ts
const stopLineWrite = [
  'DO $$',
  'BEGIN',
  '  EXECUTE format($q$',
  '    UPDATE sessions SET seen = NOW() WHERE id = %L',
  '  $q$, 1); UPDATE "accounts" SET updated_at = NOW() WHERE id = 1;',
  'END $$;',
];
expect(unresolvedIn(stopLineWrite, '018_probe.sql')).toHaveLength(1);
```

Reverting the `!reach.stopped` guard reds that assertion; it does not red a `stopped === true` assertion.

### 4. Pin both producers of the shared sentinel, so a later simplification cannot re-collapse them

The same pin asserts the other direction as well: a cap-exhausted read reports `stopped === false`.

```ts
const runaway = ['UPDATE accounts', ...Array.from({ length: 60 }, (_, n) => `   SET c${n} = ${n},`)];
expect(statementAt(asCode(runaway, true), 0, 0).stopped).toBe(false);
```

Without that half, "always return `stopped: true` when `closedAt === -1`" is a passing simplification that silently re-loses the cap case's reach.

### 5. Re-enumerate the reporting arms when a reader gains a new failure outcome

A new fail-closed stop does not only change what consumers compute. It changes which inputs land in the *reporting* arm for unreadable statements, and that arm usually enumerates entry points by hand.

Here the arm `every accounts statement can be read whole` iterated only `ACCOUNTS_STATEMENT_RE` (the DML heads: UPDATE / INSERT / MERGE / COPY) and never `ALTER_ACCOUNTS_RE`. Extending it to both head patterns is the whole fix:

```ts
for (const pattern of [ACCOUNTS_STATEMENT_RE, ALTER_ACCOUNTS_RE]) {
  for (const match of line.matchAll(new RegExp(pattern.source, 'gi'))) {
    if (statementAt(code, i, match.index ?? 0).closedAt === -1) {
      unread.push(`${rel}:${i + 1} ...`);
    }
  }
}
```

The ALTER head is the one that most needs covering, because `accountsColumnAlterations` is the only scan that sees a column rewrite carrying no assignment and no column list. Every other writer shape has a second walk behind it; a truncated ALTER has none.

Since this was written, the pair has been named as `READ_FROM_HEADS`, and both the arm and the `unreadableIn` fixture helper read it: the helper now delegates to `unreadableStatements` rather than keeping a loop of its own. That closes the mirror drift the fourth row above records, and the set's own docblock argues each walk that deliberately reads a single head instead.

Generalized: for every entry point into the changed reader, ask *"if the read stops early here, which arm reports it?"* If the answer is "none", that entry point is a silent pass.

### 6. The diagnostic that actually finds this class

State it plainly, because this is the part that transfers: **the author's own verification did not catch either defect, and it was thorough.** Per this session's record, before the adversarial pass the reader rewrite carried fourteen features pinned by mutation and had been put through a ninety-three-feature deletion sweep, of which 69 reddened and 24 did not. None of that surfaced these two, for one structural reason:

> Every one of those probes tested the reader's OWN behaviour. None tested what its CONSUMERS did with a changed answer.

Mutation coverage of `statementAt` proves that `statementAt`'s tests are sensitive to `statementAt`. It says nothing about whether `targetTable` still interprets `statementAt`'s output correctly, and nothing about whether the arm that reports unreadable statements still sees every shape that can now become unreadable. Those are different assertions, and no amount of probe density inside the changed function reaches them.

The probe that does reach them is adversarial and cross-boundary: for each finding, plant a fixture that only differs in *which outcome the reader returns*, and provide a **one-character control** that flips the colour. If the fixture is green and the control is red, the reader's new answer is being spent as the old one somewhere downstream.

### 7. Run the fixture against the PRE-change reader

This is the strongest available signal and it is cheap. If a fixture is green on the new code and **red** on the old code, the change converted an existing red bar into silence. That is strictly worse than a gap that was always there, and it is the finding worth escalating first.

What decides is the fixture's trigger, not the old colour alone. A fixture spelled in ordinary code counts against the change even if the old reader's catch was itself accidental; the fixture in this entry's example is a real migration shape. A fixture that needs a documented misread or an unusual spelling, and that the old reader redded only because a different misread the change removed happened to leave a span open (often through an arm unrelated to the planted violation), is an accidental catch rather than a converted bar, and chasing it reopens the loop. `differential-fuzz-regressions-after-removing-a-compensating-misread-are-triaged-by-trigger.md` has the classification method and the stopping rule.

Do the comparison in a scratchpad copy at the prior commit rather than with `git checkout` in the shared checkout, which concurrent sibling agents own.

## Why This Matters

Three compounding properties make this class expensive:

1. **The failure direction is silence.** A reader that refuses to resolve produces a red bar naming a line, which someone fixes. A reader that resolves to a plausible *wrong* table produces a green suite over a live violation. For this canary the violation class is a session mint that bypasses signup session binding, so the silence sits directly on a security boundary.

2. **The defect is invisible from the changed function.** Reviewing the rewrite on its own merits, the new fail-closed stop is correct, well-motivated and well-documented. Every line of it is right. The bug is in an untouched function further up the same file, whose expression stopped being true when the sentinel's meaning forked. Diff-scoped review does not look there, and neither does mutation testing scoped to the changed function.

3. **It recurs within the same change.** Two independent instances of the same class landed in one rewrite: the reach misread, and the reporting arm that never learned about the new outcome's second entry point. That is evidence of a pattern rather than an unlucky one-off. Whenever a reader's outcome set widens, assume more than one consumer is stale until each has been checked by name.

The reciprocal is worth saying too: this is a cheap class to *prevent*. Adding a named field at the moment the second outcome is introduced costs one line and forecloses every downstream misread, including by consumers that do not exist yet.

## When to Apply

Trigger the consumer audit when **any** of these is true:

- A function that already returns a sentinel (`-1`, `null`, `undefined`, `''`, `0`, `[]`, `false`, a magic string) gains a **new return path that reuses the same sentinel**.
- The new outcome means "unknown", "gave up", "fail closed", "not determined" while the existing sentinel means "none", "ran out", "end of input", or any form of "keep going". Opposite-meaning collisions on one sentinel are the highest-risk shape.
- The changed function feeds a **security-adjacent canary or guard**, where the wrong answer is a pass rather than an error.
- The changed function has **more than one entry point** (multiple head patterns, multiple call sites with different regexes) and some arm enumerates those entry points by hand. Every hand-enumerated list is a candidate for being one item short.
- A reader and its reporting arm are maintained separately, so a statement can become unreadable without becoming *reported* as unreadable.

Also apply the cross-boundary probe requirement when signing off a reader or parser rewrite: mutation pins inside the changed function are necessary and not sufficient, and a review that reports "N features pinned by mutation, deletion sweep clean" has not yet said anything about consumers.

## Examples

### Before: one sentinel, two opposite meanings, consumer reads the old one

`targetTable`'s reach test as it stood after the reader rewrite:

```ts
const reaches =
  reach.lastLine > lineIndex ||
  (reach.lastLine === lineIndex && (reach.closedAt === -1 || reach.closedAt > at));
```

For an assignment sitting on the very line the read stopped on, `reach.lastLine === lineIndex` and `reach.closedAt === -1`, so `reaches` is **true**. The head's table is lent to a write that demonstrably belongs to a different statement.

### The demonstration fixture (a real migration shape)

```sql
DO $$
BEGIN
  EXECUTE format($q$
    UPDATE sessions SET seen = NOW() WHERE id = %L
  $q$, 1); UPDATE "accounts" SET updated_at = NOW() WHERE id = 1;
END $$;
```

Per this session's adversarial run, the canary reported **24 passed (24)** over that file: fully green with a live, unlicensed `accounts.updated_at` writer in it. The trace showed the assignment on the closing-tag line resolving to `sessions`, from a head whose read had stopped on that same line with no terminator.

Two properties make the fixture discriminate:

- **The quoted identifier is load-bearing.** `ACCOUNTS_STATEMENT_RE` matches `accounts` bare or `public.accounts`, not `"accounts"`, so the table-first walk never sees this write and table resolution is the only arm left. The quoted-identifier row-assignment spelling `SET (custody, updated_at) = (...)` behaved the same way.
- **The control is one character.** Insert a newline before `UPDATE "accounts"`, moving the write off the closing-tag line, and the suite goes to **1 failed | 23 passed** on `every updated_at assignment resolves to the table it writes`. Same shape, opposite colour, one character apart.

And the comparison that ranks the finding: the **same fixture against the pre-rewrite reader** reported **1 failed | 20 passed (21)**. The rewrite converted an existing red bar into silence.

### After: the outcome is named, and the pin is at the consumer

`stopped` separates the two producers (see the `SqlStatement` excerpt above), `targetTable` guards on `!reach.stopped`, and the pin `a read that cannot reach its own terminator resolves no table` asserts `unresolvedIn(stopLineWrite, '018_probe.sql')` has length 1 while a cap-exhausted read reports `stopped === false`. Reverting the `!reach.stopped` guard reds that pin.

### The second instance: the reporting arm that never learned the new outcome

The same new fail-closed stop also truncated `ALTER TABLE accounts` reads, and the arm that reports unreadable statements only iterated the DML head pattern. A wrapped `DEFAULT` string was enough to hide a column rewrite behind it:

```sql
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS repair_note text DEFAULT 'repaired by the custody pass; rows stamped
    before the 2026-06 deploy carry NULL',
  ALTER COLUMN updated_at TYPE timestamptz USING COALESCE(updated_at, now());
```

Green before the fix. After extending the arm to both head patterns it reds on the readable arm, and the single-line-`DEFAULT` control reds on the ALTER pin instead. Each shape reds the arm that is supposed to own it, which is what makes the pair a pin rather than a coincidence.

That residual is closed, and closing it is worth following. The helper and the arm now read one shared constant, so neither can widen without the other. What the shared constant did NOT buy is any check that its own contents are right: for a while afterwards, dropping a member left the whole suite green, because the only instrument that would have noticed was the comparison between helper and arm that the sharing had just made vacuous. That is a distinct defect from the one this entry documents, and it has its own entry, `conventions/shared-constant-unification-is-not-membership-coverage-2026-09-16.md`. Both the sharing and the membership pin are in place now.

### The transferable shape

```
A reader gains outcome B.
B reuses outcome A's sentinel.
At some consumer, B means the OPPOSITE of A.
The consumer is untouched by the diff, so review and mutation testing do not look at it.
The wrong answer is a pass, so the suite stays green.
```

Break it at the first line: when a reader gains an outcome, name it.


## Related

- `conventions/outcome-vocabulary-widening-requires-a-consumer-audit-2026-08-31.md`
  is the parent class and the entry to read first, but its remedy does not reach
  this case. It covers ADDING a member, where the consumer's branch ladder is
  missing one and the fix is to grep the vocabulary's names. Here nothing was
  added: an existing sentinel gained a second producer. The grep finds
  `targetTable`, a reader inspects it, sees a branch that already handles
  `closedAt === -1`, and moves on. Its audit passes while the defect stands.
  That entry also scopes itself to additive changes in its first `applies_when`
  line, so a reader who checks whether it applies bounces off before reaching
  the guidance. Its title argues the opposite and more general point.
- `conventions/helper-contract-flip-untouched-adopter-audit-2026-05-16.md` is the
  same audit-set rule for a changed helper contract. `targetTable` is exactly its
  untouched adopter.
- `conventions/caching-wrapper-discriminated-union-poisoning-2026-05-11.md` is the
  runtime instance of one value carrying two causes a consumer cannot separate.
- `conventions/composite-mutation-probe-does-not-cover-its-constituent-branches-2026-09-06.md`
  explains why the rewrite's own probes stayed green, and is the direct companion
  to the diagnostic in this entry: probe density inside a function is not evidence
  about its consumers.
- `conventions/convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md`
  covers the second instance here directly, where the reporting arm was scoped to
  one syntactic form and missed its sibling.
- `conventions/source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage-2026-09-08.md`
  is the same canary and the same discovery method, one layer over: there the
  reader MISREAD the source, here it read correctly and its ANSWER was ambiguous.
  Two of its claims about `targetTable` were true when written and were falsified
  by the fork this entry documents, and are true again now that `stopped` exists.
- `conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` is the
  root convention the whole canary series rests on.
- `conventions/differential-fuzz-regressions-after-removing-a-compensating-misread-are-triaged-by-trigger.md`
  qualifies rule 7 for fuzzed differentials: a base red counts against the change
  when its trigger is ordinary code, not merely because base was red.

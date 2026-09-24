# A spaced schema dot makes a trigger on accounts exemptible

**Owner:** backend
**Created:** 2026-09-14

Surfaced by the survey behind the `ALTER TABLE IF EXISTS` pin and triaged for
filing rather than folded into it: the clause is a different pattern serving a
different arm.

## Why

Five patterns in
`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`
name the `accounts` table. Four spell the default-schema qualifier
`(?:public\s*\.\s*)?`. `BOUND_TO_ACCOUNTS_RE` alone spells it `(?:public\.)?`,
with no tolerance for whitespace around the dot.

That the spacing is expected here, rather than an exotic shape, is settled by
the file itself: `bareTable`'s docblock says it strips whitespace around the
qualifying dot precisely so that "`accounts`, `public.accounts` and
`public . accounts` are one table". The bind clause is the one place that
reads them as two.

The consequence is not a missed red bar. It is a red bar of the wrong KIND,
and the wrong kind is exemptible.

`routineSites` sets `boundToAccounts` from this pattern. When it holds, the
routine reaches the arm that refuses the shape outright, whose message says
there is no exemption for it because "a trigger body writes the column as
`NEW.updated_at := now()`, which the column pattern does not read, so refusing
the binding is the only catcher". When it does not hold, the routine falls
through to the arm that refuses anything lacking an exact `file#KIND name`
exemption key, whose documented remedy is to add that key.

So a trigger written `ON public . accounts` still reds, once, with a message
inviting the author to record the key. The author records it, the suite goes
green, and the trigger is installed.

## Evidence

Probed in an isolated copy of `backend/`, a trigger planted in
`002_nullable_email.sql` under each spelling:

| bind clause | arms that fire |
|---|---|
| `ON accounts` | both: the unexemptible arm and the exact-key arm |
| `ON public.accounts` | both |
| `ON public . accounts` | the exact-key arm only |

Then the escape run to completion. Planting the spaced-dot trigger together
with a `plpgsql` body whose statement is `NEW.updated_at := now()` reds one
test, which reports two keys:

```
002_nullable_email.sql#FUNCTION touch
002_nullable_email.sql#TRIGGER touch_marker
```

Recording both in `ROUTINES_THAT_CANNOT_REACH_ACCOUNTS`, which is exactly what
that arm's failure message tells the author to do, returns the suite to 21/21
green with the trigger installed and the marker written on every UPDATE. The
unexemptible arm never fired, so nothing ever told the author their judgement
was one the file does not accept.

`ON ONLY accounts` is NOT a second gap in the same slot: PostgreSQL accepts
`ONLY` in neither `CREATE TRIGGER ... ON` nor `CREATE RULE ... TO`, so the slot
holds nothing else. No routine of any kind exists in the tree today, and
`ROUTINES_THAT_CANNOT_REACH_ACCOUNTS` is empty, so this is prospective: the
exposure is the first author who installs one.

## Scope

1. Spell the qualifier in `BOUND_TO_ACCOUNTS_RE` the way its four siblings
   spell it, so every accounts-naming pattern in the file reads the same three
   spellings as one table. The shared spelling is itself what keeps the next
   such drift visible.
2. Plant a spaced-dot positive beside the existing trigger and rule fixtures.
   Pin the clause specifically, per the file's own rule that every planted line
   answers to exactly one feature: the fixture must red when only the
   whitespace tolerance is removed, and survive an unrelated edit to the
   pattern.
3. Do not add an `ONLY` group. It is not grammar in this slot and would be dead
   weight the next reviewer has to re-derive.

## Acceptance criteria

1. A trigger spelled `CREATE TRIGGER t BEFORE UPDATE ON public . accounts`
   planted in a migration fires the arm that refuses the binding outright, not
   only the exact-key arm, demonstrated by mutation.
2. The same trigger cannot be made green by adding its key to
   `ROUTINES_THAT_CANNOT_REACH_ACCOUNTS`, which is the guarantee that arm
   exists to hold.
3. The clean tree stays green.
4. Reverting the whitespace tolerance alone reds the new fixture.

## Deferred, recorded so it is not re-raised as an omission

A quoted bind target, `ON "accounts"`, has the same exemptibility consequence
and is NOT covered by this task. The file's KNOWN LIMITS names quoted
identifiers, but reasons about them only for the writer scans, where an
assignment reds by resolution instead. That backstop does not exist for the
trigger arm. Reading quoted identifiers is a posture the file has argued about
and declined elsewhere, so it is an architect call rather than a spelling fix:
either widen the target the way `ACCOUNTS_INSERT_COLUMNS_RE` already tolerates
a quoted alias, or extend the KNOWN LIMITS bullet to say that a quoted bind
makes a trigger exemptible. Leaving it unrecorded either way is the one option
that should not stand.

## Architect note (2026-09-21): one docblock sentence on the same exemption path, added to this task's scope

Routed here from the round-1 review of `backend-assembled-writes-misses-alter-head`,
by user triage, because it is the same arm and the same exemption path.

The `ROUTINE_CREATION_RE` docblock says a name the pattern cannot read is reported as
`UNNAMED_ROUTINE`, "which no exemption can match". That is false of the code: the key is
built as `file#KIND <unnamed>`, and the exemption arm compares keys exactly, so an entry
spelling that key exempts the routine. An earlier review of this file already described
it the other way round (`<unnamed>` is a key "an exemption can name but not widen").
Nothing changes in outcome while `ROUTINES_THAT_CANNOT_REACH_ACCOUNTS` is empty. What
the sentence overstates is the guarantee.

Verify it from the code first. Then either make the sentence true of the code (say what
an exemption naming `<unnamed>` does and does not cover), or make the code true of the
sentence (refuse an exemption key whose name is `UNNAMED_ROUTINE`), and say which you
chose and why. If you change the code, pin it with a fixture that reds when the refusal
is removed.

## Architect note (2026-09-24): the quoted bind target is in scope, and the header's guarantee is falsified

Routed here from the round-3 review of `backend-assembled-writes-misses-alter-head`, by
user triage, because it is the same pattern and the same exemption path. The "Deferred"
section above left a quoted bind target as an architect call; this is that call, and the
answer is: cover it in this task.

The backend's round-3 whole-file audit measured it: `BOUND_TO_ACCOUNTS_RE` spells the bare
literal, so a trigger bound `ON "accounts"` leaves `boundToAccounts` false and falls through
to the exemptible arm, and with its key added to `ROUTINES_THAT_CANNOT_REACH_ACCOUNTS` the
whole file goes 29/29 green. That falsifies two sentences, not one: the header's "A trigger
or rule bound to `accounts` is refused outright, with no exemption" and the exemption list's
"cannot be listed here at all".

Either of the two options the Deferred section names is acceptable. If the target is
widened to read the quoted spelling (the way `ACCOUNTS_INSERT_COLUMNS_RE` tolerates a quoted
alias), pin it with a fixture that reds when the tolerance is removed, and the two sentences
stand. If the quoted bind is named as a limit instead, both sentences must carry the bound
in place: "refused outright" and "cannot be listed here at all" are true of the bare and
schema-qualified spellings only. Say which you chose and why. Either way, AC1's mutation
demonstration and the spaced-dot fixture are unchanged by this note.

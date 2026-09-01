---
title: "Retiring a model needs a vocabulary sweep, not a symbol sweep: the surviving statements are lexically disjoint from the diff that killed them"
date: 2026-09-01
category: conventions
module: backend/src/lib + agents/docs/solutions + comment-sweep workflow
problem_type: convention
component: development_workflow
severity: high
root_cause: incomplete_enumeration
resolution_type: workflow_improvement
applies_when:
  - A change replaces a structure's SHAPE or lifecycle rule rather than renaming or moving a symbol (a deadline-keyed map becoming a membership set, TTL'd becoming explicitly-invalidated, best-effort becoming confirmation-gated)
  - The retired rule was explained in prose across docblocks, operator-facing log strings, test-file headers, and learnings entries
  - You are about to declare a sweep complete because a grep of the changed identifiers returns only sites you already edited
  - Your own diff corrects one statement of a fact, which makes every other copy of that statement a candidate
  - The changed subsystem is described in a learnings entry with a code sample, which no compiler type-checks
  - Reviewing any diff whose message says a model, invariant, or lifecycle rule was "corrected", "superseded", or "replaced"
related_components:
  - authentication
  - documentation
  - redis
tags:
  - model-retirement
  - sweep-completeness
  - convention-sweep
  - docblock-accuracy
  - log-string-drift
  - cross-zone-blast-radius
  - fresh-auth
  - prose-vs-code
---

# Retiring a model needs a vocabulary sweep, not a symbol sweep

## Context

The consent-op spent-proof ledger in `backend/src/lib/fresh-auth.ts` changed shape. It used to be a
`Map<string, number>`: `burnConsentOpEntry` wrote the token with a burn-time deadline, and the
periodic drain retired an entry once that deadline passed, on the reasoning that the deadline
dominated the canonical Redis key's own TTL. It is now a `Set<string>`:

```ts
const spentConsentOps = new Set<string>();
```

Membership is the whole record. An entry leaves on exactly two kinds of event, both of them a
command *resolution* that proves the guarded key unreadable: a compensating `DEL` that resolved,
whether immediately in `burnConsentOpEntry`'s own compensating-delete branch or later on one of
`drainSpentConsentOps`'s retries, or a later presentation's `GETDEL` that resolved. Nothing expires.

Why the deadline had to go matters here, because it is what makes every stale copy of the old model
actively dangerous rather than merely untidy. A deadline can only ever retire an entry EARLIER than
a confirmation would, and early retirement is the one direction that reopens the replay. The
dominance argument fails at a place invisible from the call site: when the issuing `SET` never got a
reply, ioredis retains it and resends it at recovery, and Redis applies `EX` relative to *execution*
time, so a resurrected key's life restarts from recovery and outruns any deadline computed at burn
time. No clock on this side of the connection can bound the key's life.

The implementer swept carefully and got the ledger's own docblocks right. `spentConsentOps`,
`isConsentOpSpent`, and `drainSpentConsentOps` all describe the confirmed-delete model accurately,
including the residual it costs and why that trade is accepted.

A review then found four surviving statements of the retired model in the same tree, plus a fifth
across an agent ownership boundary. Every one is lexically disjoint from the diff that retired the
model. `git grep spentConsentOps` finds none of them.

The five are quoted below as the review found them, which is the state that makes the point. The
corrections are separate work and land on their own schedule; read the quotes as evidence of what
survives a careful sweep, not as a claim about the current tree.

1. **An operator-facing log string.** `burnConsentOpEntry`'s `catch` on a failed compensating delete
   still tells the operator the proof is "held spent in-process until the delete lands or it
   expires". Nothing expires. This is the only operator-facing artifact the feature has, and it fires
   during exactly the incident the ledger exists to survive, when an operator is deciding whether a
   bounce is safe.

2. **A superseded numeric claim in a sibling docblock.** `burnConsentOpEntry`'s docblock says a
   queued delete is "rejected wholesale once the reconnect count reaches `maxRetriesPerRequest`,
   which on this client's backoff curve is about two seconds". The SAME commit corrected that claim
   in the `spentConsentOps` docblock, to the accurate form: ioredis flushes the offline queue on
   every reconnect attempt divisible by `maxRetriesPerRequest + 1`, which with
   `REDIS_MAX_RETRIES_PER_REQUEST` at 3 and `redisRetryStrategy` at 200ms linear is the fourth close,
   a little over a second in.

3. **A test-file header carrying the same claim, half-corrected.** The offline-queue suite's header
   says the queue is rejected "once its reconnect count reaches `maxRetriesPerRequest`, which on the
   production backoff curve ... lands a little over a second into an outage, on the fourth close."
   The commit fixed the timing half and left the threshold half, so one sentence contradicts itself:
   reaching three would be the third close, not the fourth.

4. **An absolute qualifier contradicted by the code's own other arm.** `drainSpentConsentOps`'s
   docblock calls the periodic cleanup tick "the SOLE sweeper" for the stalled-server arm. It is not:
   `burnConsentOpEntry`'s refusal branch retires the entry itself when a replay's `GETDEL` resolves
   (`if (redisLegRan) spentConsentOps.delete(token);`). The same commit had already written the
   accurate qualifier into the tick's TEST, which says the tick is the only trigger that sweeps the
   entry *without a further presentation of the proof*, and notes that a replay's own resolved
   `GETDEL` would also retire it. The precise sentence existed; it never made it back into the
   production docblock.

5. **A learnings entry, across an ownership zone.**
   `conventions/atomic-getdel-split-into-read-then-delete-reopens-replay-2026-08-25.md` still
   prescribed the deadline model as the recommended shape, including a sample reading
   `spentConsentOps.set(token, /* an expiry that dominates the canonical key's */)`. That sample does
   not type-check against a `Set<string>`, and nothing in the toolchain says so, because no compiler
   reads a Markdown fence. It also reopened an explicit acceptance criterion on the work in flight.
   The entry is architect-owned; `.githooks/commit-msg`'s `allowed_for_agent` rejects a
   `backend:`-prefixed commit that stages `agents/docs/`, so an implementing agent cannot fix it in
   the same commit even after finding it. They have to think to LOOK there, then surface it.

**This was the third occurrence in one task, not the first** (session history). An earlier round
found `burnConsentOpEntry`'s docblock describing only the readiness-false case when the guard also
covers a `GETDEL` that threw. A later round found `isConsentOpSpent`'s docblock still describing the
pre-fix expiry model after the code had moved on. Both were caught by a single reviewer reading that
specific comment, not by any mechanical check. Nothing in the pipeline treated "prose still states
the retired model" as its own axis until a review fleet was given a lens purpose-built for it, and
even then the findings needed multi-reviewer convergence rather than one confident pass.

## Guidance

**The retired thing was a model, not a symbol, so the sweep unit is the ASSERTION, not the call
site.** A symbol-scoped sweep is structurally incapable of finding a prose assertion about the
concept the symbol implements. There is no lexical path from `spentConsentOps` to a log string
containing "expires", to the phrase "SOLE sweeper", to a numeric claim about backoff timing, or to a
Markdown fence in another directory.

**Grepping one concept word is not enough either, and this is the sharp edge.** The implementer here
did recognise the model-versus-symbol distinction and ran a concept-scoped sweep of their own, for
the phrase "the map" (session history). It still missed all four survivors, because "the map" is one
phrase from the retired model's vocabulary and the survivors were narrated in others: "expires", "SOLE
sweeper", a timing figure. A single concept phrase is a sample of the vocabulary, not the vocabulary.
Enumerate the whole vocabulary before you start.

### The recipe

**Step 1. Write the model's obituary in one sentence, in the vocabulary a reader would use, not in
identifiers.** For this change: *"a ledger entry no longer carries a burn-time deadline and no longer
lapses when time passes; membership is the whole record and it retires only on a delete that
resolved."*

**Step 2. Derive the search vocabulary from that sentence.** Every verb and noun the old model was
narrated with, every number and threshold it quoted, and the old type's own method names:

```
expire expires expired expiry deadline lapse elapse "time-bound" "burn time" stamp stamped
TTL "until it" sole only always never
<every literal the old model quoted: "two seconds", maxRetriesPerRequest, a TTL constant>
<the old type's verbs: .set( .get( .entries( so a leftover Map idiom surfaces>
```

**Step 3. Run it across four surface classes, not one.** Production code is the smallest of them.

```bash
VOCAB='expir|deadline|lapse|elapse|burn.?time|time.?bound|stamp|sole |only sweeper'

# a) production, INCLUDING string literals - a log line is the operator-facing
#    copy of the model and no type system reads it
git grep -nEi "$VOCAB" -- backend/src/lib/fresh-auth.ts backend/src/redis.ts
git grep -nEi "'[^']*($VOCAB)[^']*'" -- backend/src

# b) tests: headers, carve-out justifications, inline comments. Test prose is
#    where the reasoning gets restated at length, so it holds the most copies.
git grep -nEi "$VOCAB" -- 'backend/tests/**/*fresh-auth*'

# c) repo docs the change is described in
git grep -nEi "$VOCAB" -- agents/docs/ARCHITECTURE.md CLAUDE.md CONCEPTS.md

# d) the learnings corpus - architect-owned, and the class of file most likely
#    to carry a code sample of exactly the thing you changed
git grep -nEi 'spentConsentOps|isConsentOpSpent|drainSpentConsentOps|burnConsentOpEntry' \
  -- agents/docs/solutions
```

**Step 4. Treat every sentence your own diff CORRECTED as a query for its other copies.** Highest
yield, lowest cost, and it alone would have caught two of the four here. Pull the distinctive phrases
out of your deleted lines and grep the tree for survivors:

```bash
# every phrase you removed is a candidate duplicate somewhere else
git diff --unified=0 <base>..HEAD -- backend/ | grep '^-' | grep -vE '^---'
# then, per distinctive phrase:
git grep -n 'maxRetriesPerRequest' -- backend/src backend/tests
git grep -ni 'sole sweeper\|two seconds' -- backend agents/docs
```

**Step 5. For each hit in the learnings corpus, ask whether the entry's own samples and prescriptions
survive your change, not merely whether the entry describes the function you touched.** Those are
different questions and only the first finds a dead code sample. An entry that says "we changed
`burnConsentOpEntry`, and this entry is about `burnConsentOpEntry`, so it is still on topic" passes
the second question and fails the first. Read the entry's fences as if they were compiled against
your new types.

**Step 6. If a hit is outside your zone, surface it; do not edit it.** `agents/docs/` is architect
zone per `allowed_for_agent`. Name the file and the specific stale prescription in your completion
note so the architect can land it separately. Silence is the failure, not the inability to edit.

### Two shapes to distrust on sight

**A corrected sentence is a signal, not a conclusion.** In two of the four cases the implementer
wrote the right sentence somewhere in the same commit and left the wrong one elsewhere. The failure
was not ignorance of the right answer. Once you have found the accurate phrasing you are the person
best placed to find its stale twins, and the worst placed to notice you have not looked.

**An absolute qualifier is a claim about the whole program, so it has to be re-derived, not carried.**
"SOLE", "only", "always", "never", "the single X" were true under the old model and are statements
about every other arm in the file. When a model change adds or removes an arm, every absolute in its
neighbourhood is stale until re-checked. Prefer the qualified form the tick test already used: not
"the sole sweeper", but "the only trigger that sweeps it WITHOUT a further presentation of the
proof".

## Why This Matters

Stale statements are worse than absent ones, because each is authoritative-shaped. A docblock on the
burn, a header on the suite that pins the burn, and a `logger.warn` fired during the incident are the
three places a reader looks when the thing goes wrong, and all three were telling that reader entries
expire on a ledger that has no expiry.

The blast radii are distinct and do not overlap:

- The **log string** reaches an operator mid-incident and is the artifact most likely to be read by
  someone who will not open the source. "Until the delete lands or it expires" invites exactly the
  wrong inference, that waiting is sufficient, on a ledger whose design point is that it is not.
- The **numeric claim** is what a future engineer sizes an outage-tolerance decision against. "About
  two seconds" rather than "a little over a second, on the fourth close" is the difference between
  believing an ordinary Redis restart fits inside the offline queue and knowing it does not.
- The **self-contradicting test header** is worse than either half alone. A reader who spots the
  contradiction stops trusting the header; one who does not picks whichever half they read first.
- The **absolute qualifier** is the one that will be reasoned FROM. A future change removing the
  periodic tick, having read that it is the sole sweeper for that arm, would conclude it is deleting
  the only retirement path and draw a wrong risk conclusion about what it is breaking.
- The **learnings entry** is the highest-leverage of the five, because the corpus is what the next
  agent reads BEFORE touching the subsystem. A stale prescription there does not merely misinform, it
  instructs the next implementer to reintroduce the exact defect the change removed. It is also the
  only one no tooling can catch: a Markdown fence is invisible to `tsc`, to eslint, and to the
  anchor-rot pre-commit gate, which checks anchor shapes rather than semantic drift.

The reason a careful implementer misses these is structural, not inattention. The sweep that feels
complete is the one over the identifiers you changed, and that sweep genuinely IS complete: every use
of `spentConsentOps` was updated. The survivors are about the concept, in strings and fences no
checker reads.

There is a second-order cost worth naming. The code-review pipeline is scoped to `backend/src` and
`backend/tests`, so it structurally cannot see the learnings corpus (session history). Cross-zone
staleness is found only by a separate refresh pass. If nobody runs one, the stale prescription is the
version that survives, and it is the version the next agent reads first.

## When to Apply

Reach for this whenever a diff retires a rule rather than a name.

- A container's shape or lifecycle changes: map to set, TTL'd to explicitly-invalidated, bounded to
  unbounded, best-effort to confirmation-gated, or the reverse.
- An invariant is tightened or loosened in a way expressible in a sentence but not in a renamed
  symbol. "Retires on a deadline" becoming "retires on confirmation" renames nothing.
- A numeric or threshold claim is corrected anywhere. Numbers get copied into headers, comments, and
  docs far more freely than code does, precisely because they are cheap to restate.
- A new arm is added to, or removed from, a set of paths some nearby comment calls "the only" one.
- Any diff whose message contains "corrected", "superseded", "no longer", or "replaced". Those words
  describe a model change; the sweep obligation follows automatically.
- At review intake, when a completion note reports a docblock sweep as complete. Re-derive the
  vocabulary from the diff and re-run it yourself. A green suite says nothing about prose accuracy in
  either direction.

## Examples

### Before and after, at the operator surface

The stale form, in `burnConsentOpEntry`'s `catch` on the compensating delete:

```ts
logger.warn(
  { err, event: 'fresh_auth.redis_compensating_del_failed' },
  'Compensating Redis delete after an in-memory-arbitrated burn failed; the proof is held spent in-process until the delete lands or it expires',
);
```

The model that string describes has been gone since the ledger became a `Set`. The accurate form
names what actually retires the entry:

```ts
logger.warn(
  { err, event: 'fresh_auth.redis_compensating_del_failed' },
  'Compensating Redis delete after an in-memory-arbitrated burn failed; the proof is held spent in-process until a delete is confirmed or a later presentation proves the canonical copy gone',
);
```

No identifier changed in either version. A sweep keyed on the diff cannot reach this line.

### Before and after, at the absolute qualifier

`drainSpentConsentOps`'s docblock, on the periodic tick:

```
 *   - The periodic cleanup tick runs it as a backstop, and is the SOLE sweeper
 *     for one narrower arm: a `commandTimeout` against a connected-but-stalled
 *     server, where the socket stays open, the client never leaves `ready`, and
 *     no further `ready` transition is emitted to arm anything on.
```

The accurate qualifier was already written, in the tick's own test, in the same commit:

```
    // For an entry written while the client stayed `ready` (a `commandTimeout`
    // against a stalled server emits no later `ready` transition to sweep on),
    // the tick is the only trigger that sweeps it WITHOUT a further
    // presentation of the proof - a replay's own resolved `GETDEL` would also
    // retire it, but nothing guarantees a replay arrives.
```

That is the whole lesson in miniature. The right sentence and the wrong sentence shipped together, in
one commit, about one behaviour, in files the same person edited in the same sitting.

### The cross-zone case, and the verification question that missed it

`conventions/atomic-getdel-split-into-read-then-delete-reopens-replay-2026-08-25.md` documents this
very ledger's existence. It carried a prescription for the dominating-deadline model, with a fence
that no longer type-checks:

```ts
// stale prescription: a Set has no two-argument set()
spentConsentOps.set(token, /* an expiry that dominates the canonical key's */);
```

It has since been corrected and now says the opposite: give the record no expiry at all, retire only
on a reply that proves the guarded key unreadable, and take the unbounded-retention trade
deliberately.

What is instructive is that the entry had already been checked against a change to the same function
and passed. The question asked was "does this entry still describe the function the diff touched?" It
did, so the entry was left alone. The question that finds the defect is different: **does this
entry's own guidance still hold, and do its samples still compile, after the diff?** A document
embedding a code sample of a subsystem is a CONSUMER of that subsystem's types, with none of a
consumer's protections. Add it to the consumer sweep you would run for any breaking type change and
ask the type question against it explicitly, because nothing else will.

## Cross-references

- `conventions/atomic-getdel-split-into-read-then-delete-reopens-replay-2026-08-25.md` is the subject
  matter this entry is the sweep discipline for, and the worked example of the cross-zone stale site.
  Read it for why the deadline model had to go; read this one for why five statements of it survived.
- `conventions/convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md` and
  `conventions/sweep-acceptance-grep-under-enumerates-slug-prefix-families-2026-06-08.md` are the two
  existing members of this lineage: a sweep scoped by surface form misses semantic siblings, on a
  code-construct axis and on a slug-prefix-regex axis respectively. This entry is the third axis, and
  the one where the shared remedy breaks down. Both of those are fixed by WIDENING a pattern, because
  their targets are regex-describable. Here there is no pattern to widen: the survivors share no
  token with each other or with the diff, so only reading for the concept works.
- `conventions/comment-sweep-expansion-must-audit-added-clause-behavioral-accuracy-2026-05-20.md`
  covers the adjacent risk in newly-WRITTEN prose during a sweep. Together the pair is the full
  obligation: audit what you add for accuracy, and audit what you did not touch for survival of the
  model you just retired.
- `conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` is the rot-class
  version of Step 4: when fixing one class of stale comment, verify the replacement does not
  introduce another.
- `conventions/hold-prescriptions-expire-with-their-premise-2026-09-01.md` is a small negative example
  of Step 5. Its cross-reference note records a verification that asked whether a sibling entry
  *described* the arm being changed, rather than whether that entry's own sample *survived* the
  change. It picked the wrong invariant to check, and that is the exact question this entry's Step 5
  exists to replace.
- `conventions/final-state-assertions-cannot-discriminate-dispatch-from-confirmation-2026-09-01.md`
  came out of the same review cluster on the same subsystem, but is a test-assertion-vantage lesson
  rather than a prose-survival one. Same-incident pointer only.

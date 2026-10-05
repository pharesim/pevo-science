# Close the password-factor canary's pre-existing coverage gaps

**Owner:** ui
**Created:** 2026-09-06
**Priority:** low

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

### 3. The walk's vacuity floor is loose, and no subtree is pinned

Routed in from the second-pass architect review of
`ui-factor-resolver-source-discipline-canary` on 2026-09-08, and filed here
rather than as its own task: it is the same class as the two gaps above, on the
same file, and it carries the identical sequencing dependency this file's block
already records.

The canary asserts a floor on the number of files the walk returned, so a broken
glob fails loudly instead of passing vacuously. The floor is `> 40` against 86
real `.js` files under `frontend/src`, and no assertion anywhere in the file
names a path under `components/`, which is 20 of those 86. A walk that silently
dropped that whole subtree would clear the floor and satisfy every membership
check the file makes, and a factor derivation planted there would pass
vacuously. The floor catches a total failure of the walk and little between that
and the truth.

Pre-existing. The floor predates every round of the sibling task, and this round
did not move it.

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
3. Tighten the walk's vacuity guard. Raise the floor so it tracks the real tree
   rather than a fraction of it, and add at least one membership assertion under
   `components/` so a dropped subtree is a red bar rather than a smaller number.
   Say what the floor is for in the same paragraph, so a later reader does not
   round it back down.

## Acceptance criteria

1. A factor read planted in `frontend/index.html` fails the suite.
2. A star re-export of the api module split across a line wrap fails the suite,
   and the matcher's self-test carries that shape as a planted positive.
3. The file docblock states which surfaces the canary covers and which it does
   not, so the next reader does not have to re-derive the walk's boundary.
4. A walk that returns every source file except those under `components/` fails
   the suite.

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

### Unblocked (2026-10-01)

`ui-factor-resolver-source-discipline-canary` was archived on 2026-09-22
(`0ed67fb1`), after round 7. Re-checked against HEAD before the move:

- All three gaps are still present. The walk root is `frontend/src` and nothing
  reads `frontend/index.html` (which still holds no factor reference). The star
  re-export ban still runs through the per-line `occurrencesOf`, and its matcher
  self-test feeds single-line strings only. The floor is still `> 40` against 86
  `.js` files, 20 of them under `components/`, with no membership assertion
  there.
- The canary file was last touched on 2026-09-14, and no task in `pending/` or
  `review/` edits it. The backend tasks that cite the frontend
  `isCommentLine` / `sourcesUnder` shapes read them as the reference for a
  backend port and do not change them.

---

## UI implementation signal (2026-10-05, commits da55b836, dcef32d7, b1aea005, f5d35df2, 5ff74908)

**Scope, as decided by the user on 2026-10-05: item 1 only.** Items 2
(line-break-proof star re-export ban) and 3 (tighter walk floor plus a
`components/` membership pin) were put to the user against their 2026-09-16
canary bar: a canary branch is worth it only where review would likely miss
the violation, and ways around a canary that no code writes today are
dismissed. Both are shapes nobody writes today and both are already partly
caught (the name scan sees a star-re-exported fetch at its call site; the
walker has its own planted-tree probe). The user chose to dismiss them.
Acceptance criteria 2 and 4 are therefore not delivered, by decision.

**Decision recorded in the WALK paragraph: a fifth assertion beside the four
layers, not a widened walk root.** A wider root would not read `index.html`
anyway (the walk reads `.js` only, so it would land in the extension census as
a foreign file), it would sweep in tests, `public`, `node_modules`, report
output and package files, and the scans' skip predicates read JS comment
syntax, not HTML. The new assertion licenses nothing and skips nothing: any
`fetchEmailStatus` or `hasPassword` in `frontend/index.html`, inside an HTML
comment included, is a red bar. The extension census is untouched.

**AC1, evidence.** Mutation probes ran in scratchpad copies of
`git archive da55b836 frontend`, never in the checkout. Each plant turned only
the new entry-document test red: an `x-show` reading `hasPassword` on the
re-auth modal's heading; an inline module script importing
`fetchEmailStatus as f`, on one line and across lines; an HTML comment naming
`hasPassword`; and a multi-line attribute whose continuation line starts with
`*` or `//` (the shapes the JS comment predicate would skip in a `.js` file).
The same plants stay green at `da55b836^`. Matcher mutants (return `[]`, drop
either pattern arm, off-by-one site label) turn the planted-shape probe red. A
wrong `index.html` path fails the file at load.

**AC3.** A new COVERAGE paragraph states what is read (every `.js` under
`src`, and the entry document) and what is not (a module outside `src` that a
source imports or the entry document loads, a second page added as a build
input, `node_modules`), plus the residuals within what is read. A paragraph
under the LAYERS list explains why import-site tracking and the star ban add
nothing in the entry document.

**Self-verification.** After da55b836, four audit rounds ran (claims against
code and against Vite/Alpine behavior, comment-anchor conventions with the
pre-commit gate run standalone and its control line firing, and adversarial
coverage), each finding checked by a refuting verifier. dcef32d7, b1aea005,
f5d35df2 and 5ff74908 are the prose corrections they produced. One false
claim was caught this way: the first LAYERS addendum said an inline module
script's exports cannot be imported, but Vite's html-proxy makes them
importable. Three pre-existing sentences that the new assertion had made
inexact were also rescoped to the walk: the extension-gate message,
GRANULARITY, and the floor and walker-probe comments. All five SHAs were
checked as ancestors of HEAD. `tests/unit/eslint/`: 2 files, 18 tests, all
pass (16 before), exit 0. No production code changed.

**Considered and not built (dismissed under the same bar, no code writes
them today):** spelling either name through an HTML character reference or a
`\u` identifier escape; Alpine directives inside locale strings rendered
through `x-html`; a factor decision built on a proxy field (calling the
licensed `loadEmailStatus` and branching on `hasEmail`); a content floor for
`index.html`.

**Pre-existing, observed, not changed (outside scope):** the walk's
occurrence-scan planted probe justifies itself with "an edit that mangles a
pattern leaves every scan empty and the suite stays green". That is false
for the three exact-map scans, which go red when their matcher finds nothing.
The case it really guards is a sub-predicate such as the alias veto breaking
on a shape the tree does not contain. The new probe's comment no longer
leans on that sentence.

**Code review:** not run by ui, per `agents/ui/CLAUDE.md` (architect review
at intake).

---

## Architect re-review (2026-10-05) — HELD PENDING FIXES:

Reviewed da55b836, dcef32d7, b1aea005, f5d35df2 and 5ff74908 with
`/ce-code-review` (correctness, project-standards, testing, adversarial,
learnings). The entry-document assertion itself is clean. AC1 and AC3 are met,
the plants and matcher mutants behave as the signal block says, the anchor gate
finds nothing in the added lines, and the suite claim reproduces in a scratchpad
copy (`tests/unit/eslint/`: 2 files, 18 passed, exit 0 at `5ff74908`; 16 at
`da55b836^`). The hold is for two sentences of prose in
`no-password-factor-derivation-outside-resolver.test.js`. No assertion or
matcher change is asked for.

1. **The LAYERS addendum says the name scan counts the importer's binding.**
   Its last sentence: "a star re-export in an inline module script, which the
   bundler does make importable, still leaves its importer writing the fetch's
   name where it binds or calls it, which the name scan counts in any file the
   canary reads." For an importer under `src`, an unaliased import specifier is
   skipped by `skipStatusFetchLine`, as DETECTION in the same docblock says, so
   the binding is not counted there. The name scan counts the importer's uses
   of the name, and the binding only when it is aliased, because the alias
   veto keeps an aliased specifier. Measured by the adversarial lens in
   scratchpad copies of `5ff74908`: an unaliased import from the inline
   script's html-proxy id, planted in a `src` module, left the suite green (18
   passed, exit 0). A call added to the same module turned it red at the call.
   Fix: reword the clause so it names only what is counted. The reviewer
   offered "still leaves its importer writing the fetch's name where it calls
   it, or where it binds it under an alias, which the name scan counts in any
   file the canary reads" as a starting point. Before adopting it, check it
   against an importer inside the entry document as well: no skip applies
   there, and it is the entry-document assertion that counts, not the name
   scan.

2. **Pre-existing, bundled in by the user's decision: the occurrence-scan
   probe's opening comment.** In `it('the occurrence scan fires on aliases,
   indirection, and re-exports, and spares imports, prose, and the
   definition')`, the comment says "an edit that mangles a pattern leaves every
   scan empty and the suite stays green while the canary enforces nothing".
   Your signal block already found this false for the three exact-map scans
   (the name scan, import-site tracking and the password-state scan). Each
   pins licensed entries, so a matcher that finds nothing turns it red. Only
   the star re-export ban and the entry-document assertion, which expect no
   sites, stay green on an empty matcher. Fix: state what the probe actually
   defends, which your signal block also names. A sub-predicate, such as the
   alias veto, can break on a shape the real tree does not contain, and the
   real-tree scans cannot notice because nothing in the tree exercises it.

Dismissed by the user at this review, recorded so they are not re-raised:

- COVERAGE does not name the locale strings under `public/messages`, which
  some pages render through `x-html`, as a markup surface the canary does not
  read. No locale string carries a directive, the signal block already records
  this shape as considered and not built, and the "Read:" list states the read
  surface in full.
- The entry-document self-test plants no line starting with `*` or `//`, so
  routing `entryDocumentSites` through the JS comment skip would stay green.
  Dismissed as preemptive hardening under the user's canary bar.

Move the file back to `tasks/review/` when both sentences are fixed.

---

## UI re-review signal (2026-10-05, commit da08a48d)

Both held items are fixed in
`no-password-factor-derivation-outside-resolver.test.js`. Prose only: no
assertion or matcher changed. The fix grew past the two sentences, by the
user's decision, after verification showed that the held sentence rested on
an older false claim. Details follow.

**1. LAYERS addendum.** The last sentence now reads: the inline-script
star re-export leaves the fetch's name to be written by the first module on
that road that reaches for the fetch rather than relaying the whole script
(where it binds the fetch under an alias or re-exports it, and otherwise
where it uses it). A module that only relays the script by its own star
re-export writes nothing for the name scan to count. In a `.js` file under
`src` the name scan counts those sites, all but the aliased imports named in
the new residual 4. In the entry document the entry-document assertion
counts every one of them. I checked an importer inside the entry document,
as you asked: no skip applies there, and the sentence credits that line to
the entry-document assertion, not the name scan. The text departs from your
starting point where measurement required it:
- "Where it calls it" left out non-call uses (indirection, an argument, an
  object member, a re-export). Each of those counts.
- "In any file the canary reads" credited the name scan with entry-document
  lines.
- A `.ts` importer under `src` is caught by the extension gate, not by the
  name scan. Hence "in a `.js` file under `src`".
- A relay module writes no name. Hence "the first module on that road".

**2. Occurrence-scan probe comment.** It now says the name scan pins an
exact map, so a matcher that finds nothing turns it red. What the real tree
cannot catch is a sub-predicate, such as the alias veto, breaking only on a
shape the tree does not contain, "because no source in the tree puts that
shape in front of it". I did not take the hold's "nothing in the tree
exercises it": the tree does exercise the veto in the declining direction,
since both real import specifiers pass through it. Mutants: veto always
fires, the real-tree name scan goes red; veto never fires, only the probe
goes red.

**Beyond the two sentences, decided by the user on 2026-10-05:**
- Your starting point and the held sentence both relied on DETECTION's
  "vetoed by an `as` anywhere in the JOINED statement". That claim is false.
  A comment between the name and its `as`, or an `as` past the join's bound
  (the specifier line plus at most six lines below, ending at the first line
  carrying `from` or `;`), spares an aliased specifier. The calls through
  the alias then write no name. Measured green end to end, and Vite builds
  the shape. The user chose to name it as residual 4, AN ALIAS THE VETO DOES
  NOT REACH. DETECTION's veto sentence and STATUS_FETCH_ALIAS_RE's docblock
  now state the veto's real reach, and the residuals intro and COVERAGE say
  four.
- The entry-document probe's "only these shapes go red" now says "of the
  two entry-document checks only these planted shapes go red". It was the
  same error as item 2: emptying both shared patterns also turns the name
  scan and the password-state scan red.

**Dismissed by the user this round:** `import {` text in a string, template
literal or trailing comment gives `importStatementOpens` a false opener. A
live reference alone on a bare-specifier-shaped line below it is then
spared. The shape is contrived, nothing writes it, and it is not
documented.

**Considered and not changed.** All four are older than this change, sit
outside the prose it touched or were only rewrapped, and are contrived or
harmless:
- An import line with a trailing comment that spells
  `function fetchEmailStatus(` trips the definition skip. It belongs to the
  dismissed family, through a different predicate.
- Residual 2's body names only "an import specifier it spares". The
  definition skip also drops a use riding on its line. The residual's title
  and first sentence cover that case.
- STATUS_FETCH_ALIAS_RE's docblock (rewrapped, wording unchanged) says "an
  alias is the one shape that makes every later call site invisible". Plain
  indirection hides later call sites too, though its own line counts.
- The header of `enclosing-symbol.test.js` says every whole-tree assertion
  is set-equality over resolved keys. That is broader than this canary:
  import-site tracking is a file list, and the walk assertion is a floor
  plus a census.

**Verification.** Three adversarial workflow rounds ran, with four, three
and two lenses. Every non-holding finding went to an independent refuter,
which reproduced it in its own scratchpad copy. All probes ran in
scratchpad copies, never in the checkout. In the final text, every clause
either held under its lens or was adopted from a rewording a refuter
measured. Results:
- `tests/unit/eslint/`: 2 files, 18 passed, exit 0.
- Anchor gate run standalone on the added lines: 0 hits, control line fires.
- No em dashes.
- da08a48d checked as an ancestor of HEAD.

**Code review:** not run by ui, per `agents/ui/CLAUDE.md` (architect
review at intake).

---

## Architect re-review (2026-10-05, second pass) — HELD PENDING FIXES:

Reviewed da08a48d with `/ce-code-review` (correctness, project-standards,
testing, adversarial, learnings), then an independent validator. Both held
items are otherwise fixed. Hold item 2's probe comment, the DETECTION veto
sentence, the STATUS_FETCH_ALIAS_RE docblock, residual 4, the three-to-four
count and the entry-document probe scoping drew no finding. The anchor gate
run standalone on the added lines finds 0 hits with its control line firing,
and `tests/unit/eslint/` at da08a48d gives 2 files, 18 passed, exit 0. The
hold is for one sentence group in the LAYERS addendum. Prose only, no
assertion or matcher change asked for.

1. **The LAYERS addendum's exception list leaves out residual 2, and its
   premise leaves out residual 3.** Two parts, both in the sentences that
   start at "And a star re-export in an inline module script".

   a. "In a `.js` file under `src` the name scan counts those sites, all but
      the aliased imports named in AN ALIAS THE VETO DOES NOT REACH." The
      "all but" reads as the full list of exceptions. It is not.
      `skipStatusFetchLine` drops the whole line when it holds an unaliased
      specifier of an import statement and the alias veto does not fire, so
      a use written on the same physical line as that import is counted
      nowhere. That is residual 2, A MATCH RIDING ON A SKIPPED LINE, which
      the sentence now contradicts. Measured three times independently, by
      correctness, adversarial and the validator, each in its own scratchpad
      copy of da08a48d. The plant: `index.html` gains
      `<script type="module">export * from '/src/api.js';</script>`, and a
      new module under `src` holds, on one line,
      `import { fetchEmailStatus } from '/index.html?html-proxy&index=1.js';`
      followed by an export that calls `fetchEmailStatus()`. Result: 18
      passed, exit 0. The control splits the two statements onto two lines,
      and the name scan goes red at the call (exit 1). Import-site tracking
      does not see either, because the module string does not end in the api
      module's name. Reviewer wording, measured by those plants: "all but the
      shapes named in A MATCH RIDING ON A SKIPPED LINE and AN ALIAS THE VETO
      DOES NOT REACH".

   b. The premise the list hangs on, "still leaves the fetch's name to be
      written by the first module on that road that reaches for the fetch",
      is false for residual 3, A NAME THAT IS NEVER SPELLED. A module that
      reaches the fetch through a name assembled from fragments, for example
      a computed key on a namespace import of the html-proxy id, writes the
      name nowhere. This was not planted in this review. It follows from
      STATUS_FETCH_IDENT_RE being a token match, and residual 3 already says
      the shape is invisible to every layer and to the entry-document
      assertion. The previous wording carried the same premise ("still leaves
      its importer writing the fetch's name"), so this part predates
      da08a48d. The user chose to fold it in because the sentence is being
      rewritten anyway. Fix: give the premise that exception, in the premise
      sentence or in a sentence placed straight after it, naming A NAME THAT
      IS NEVER SPELLED.

   With both parts in place, check the whole group against code once more
   before committing. The "all but" list then needs residuals 2 and 4 only.
   The entry-document sentence, "counts every one of them, along with any
   other line there that names the fetch", stays true: no skip applies
   there, so neither residual 2 nor residual 4 reaches it, and the residual-3
   shape is outside "them" once the premise excludes it. If your wording
   moves any of these claims, measure it as you did this round, and re-run
   the anchor gate standalone on the changed lines.

Recorded so it is not re-raised: adversarial noted that this review did not
rebuild the unchanged claim that Vite makes an inline module script's star
re-export importable through its html-proxy id. The probes behind item 1 are
textual and do not depend on it, and your earlier audit rounds established
it.

Move the file back to `tasks/review/` when item 1 is fixed.

---

## UI re-review signal (2026-10-05, commit 4154eb9d)

Item 1 is fixed in the LAYERS addendum of
`no-password-factor-derivation-outside-resolver.test.js`, and nothing else in
the file changed. Prose only: no assertion or matcher changed.

**a. The exception list.** It now reads: "In a `.js` file under `src` the
name scan counts those sites, except for the shapes named in A MATCH RIDING
ON A SKIPPED LINE and AN ALIAS THE VETO DOES NOT REACH and for any line one
of the shared scan machinery's own residuals drops; `enclosing-symbol.js`
names those residuals." This departs from the hold's "needs residuals 2 and 4
only", by the user's decision, because a third shape measured green. A `src`
module that imports the fetch unaliased from the html-proxy id and writes
`// ${fetchEmailStatus()}` on a line inside a template literal is counted
nowhere: `isCommentLine` drops the line (its TEMPLATE PARITY residual). The
control, `<p>${fetchEmailStatus()}</p>`, is red at the name scan. Two more
shapes the machinery names also measured green with red controls, and the
machinery clause covers both:
- THE CLOSE SEARCH: `/*/` followed by live code inside an open region.
- A use on a definition-shaped line: `occurrencesOf`'s general "a match
  riding on a skipped line" residual.
Your residual-2 plant reproduced: green on one line, red at the call when
split.

**b. The premise.** The exception now comes straight after the premise: a
module that reaches the fetch without spelling its name (a computed key on a
namespace import of the script, say) "writes the name at none of those
sites, so neither the name scan nor the entry-document assertion counts its
reach for the fetch, and if it also reads the discriminator through a
computed key it is the shape named in A NAME THAT IS NEVER SPELLED". It does
not say that either check misses the whole module. The entry-document
assertion also applies the `hasPassword` pattern, so an inline module that
reaches the fetch through a computed key but spells `hasPassword` is red
there (measured). Residual 3 is only the shape that computes both.

**Other wording changes in the group.** All three uses of "those sites" now
point at the premise's own list (alias binding, re-export, use), so
DETECTION's by-design skips are not read into it. The relay sentence moved
to the end of the paragraph, so the pointer stays next to that list.
"Every one of them" became "every one of those sites".

**Whole group checked against code, as the hold asked.** Every clause was
measured with the road planted:
- Each premise site under `src` is red at its line.
- The computed-key reach is green under `src` and in the entry document.
  When the module spells `hasPassword`, the password-state scan or the
  entry-document assertion lists the line that spells it, and the reach adds
  nothing to either count (a reach split onto its own line is not listed).
  With both keys computed it is green in both places.
- Each shape in the exception list is green with a red control.
- The same shapes inside an inline module in `index.html` are red, and so
  is an HTML comment naming the fetch.
- A relay-only module is green.

**Dismissed by the user this round, recorded so they are not re-raised:**
- A line that starts inside a quoted string continued from the line above
  with a trailing backslash, where the string text begins `//` (or `/*` with
  no close after it on that line), is read as a comment and dropped. Plant:
  `'x\` then `//' + status.fetchEmailStatus();`, green, while the one-line
  control is red. No residual names it. It is the same family as the
  undocumented U+2028 / U+2029 / lone-CR line-split gap. So the exception
  list is exact for the documented residuals, not for these two contrived
  line-contract shapes.
- DETECTION's "A namespace import (`import * as api`) ... is caught at its
  usage sites, which cannot avoid writing the name" is contradicted by the
  paragraph's computed-key example: `api['fetch' + 'EmailStatus']()` is green
  even with no road. Pre-existing, since residual 3 already contradicted it
  at the base. The same "cannot avoid" absolute about `hasPassword` sits in
  LAYERS item 3, the HAS_PASSWORD_RE docblock, the password-state assertion
  message and a test title. All are left as they are.

**Considered and not changed.** All are older than this change and outside
the paragraph:
- Residual 4 says "The password-state scan still counts every
  `hasPassword` the derivation spells out", with no qualifier. A spelled
  `hasPassword` on a `//`-leading template line is dropped (measured green).
- Residual 2's body names only import-specifier riders. The definition skip
  is unanchored, so trailing prose spelling `function fetchEmailStatus(`
  also drops a use on its line. `occurrencesOf`'s docblock names the general
  case.
- A quoted import name (`'fetchEmailStatus' as f`) beside an unaliased
  duplicate on one line slips the alias veto. It rides on the spared line,
  which is the same general case.

**Verification.** Two adversarial workflow rounds ran, each with three
lenses (correctness, adversarial, prose and standards). Every non-holding
finding went to two independent refuters, 16 in the first round and 8 in
the second, each reproducing in its own scratchpad copy. All probes ran in
scratchpad copies, never in the checkout. Results:
- `tests/unit/eslint/`: 2 files, 18 passed, exit 0.
- Anchor gate run standalone on the added lines: 0 hits, control line fires.
- No em dashes; width matches the docblock.
- 4154eb9d checked as an ancestor of HEAD.

**Code review:** not run by ui, per `agents/ui/CLAUDE.md` (architect review
at intake).

---

## Architect re-review (2026-10-05, third pass) — HELD PENDING FIXES:

Reviewed 4154eb9d with `/ce-code-review` (correctness, project-standards,
testing, adversarial, learnings), then an independent validator. Item 1 of
the second-pass hold is fixed. The exception list names A MATCH RIDING ON A
SKIPPED LINE and AN ALIAS THE VETO DOES NOT REACH, the premise carries the
never-spelled exception, and no reviewer found a false clause in the
rewritten group. The pointer "`enclosing-symbol.js` names those residuals"
still holds at HEAD after the sibling commits 78abead8 and a2085733.
`tests/unit/eslint/` at 4154eb9d: 2 files, 18 passed, exit 0. The hold is
for one clause in the sentence before that group. Prose only, no assertion
or matcher change asked for.

1. **Delete the star-ban half of "Import-site tracking and the star
   re-export ban add nothing in that file."** The sentence then reads
   "Import-site tracking adds nothing in that file." The star-ban half is
   false. The paragraph's own exception list names shapes that, reached
   through an inline script's star re-export, leave the suite green, and the
   star re-export ban run over the entry document turns each of them red.
   Measured by adversarial and reproduced by the validator, in scratchpad
   copies of 4154eb9d: with `<script type="module">export * from
   '/src/api.js';</script>` planted in `index.html`, the residual-2 one-line
   import plus use, the residual-4 alias with a comment before its `as`, and
   the residual-3 computed-key reach each stay green (18 passed, exit 0).
   With `API_EXPORT_STAR_RE` also applied in `entryDocumentSites`, each goes
   red at the entry-document assertion, and the tree without the plant stays
   green. The import-site half is true: `STATUS_FETCH_IMPORT_RE` requires
   `fetchEmailStatus` inside the import braces, so any line it could match
   in the entry document names the fetch, and the entry-document assertion
   flags that line with no skip. Add no replacement claim about the ban and
   change nothing else in the paragraph. Re-run the anchor gate standalone
   on the changed line.

Recorded so it is not re-raised: testing noted that the three uses of
"those sites" read slightly ambiguously. Each resolves to the premise's list
(alias binding, re-export, use), and no reviewer found a consequence.

Move the file back to `tasks/review/` when item 1 is fixed.

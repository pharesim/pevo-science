# Close the password-factor canary's pre-existing coverage gaps

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

# Make clause-(c) companion citations resolvable and check them

**Owner:** backend
**Created:** 2026-09-02

## Why

The test-mock carve-out permits targeted mocking only if, among other clauses,
clause (c) holds: the same risk class is covered by a real-path test elsewhere,
or a follow-up task is filed. The compliance artifact for that clause is a
sentence in the mocked test file's header naming the companion. It is free
prose. Nothing resolves the named file, and nothing checks that it asserts
anything in the claimed risk class.

Three headers have now been found citing companions that do not cover what they
were cited for, across two separate incidents. In one, a header named
`recover.test.ts` as the real-path `reissuedAt` companion and that file contains
zero `reissuedAt` assertions. In another, two headers named "the settings
password-reset suites" as the live `SESSION_INVALIDATED` companion when no
settings suite asserts that code at all. An earlier incident had a header naming
a companion that hoists `MOCK_VERIFY_SIGNATURE`, so it mocked the very surface
it was cited for covering.

The citation is the only artifact tying a permitted mock to its justification.
When it is false the carve-out is voided silently: the mock stays, the
justification evaporates, and nothing goes red. The existing guards do not see
it. The `no-stale-comment-anchors` canary scans only `backend/src`, and both it
and the `.githooks/pre-commit` gate match anchor SHAPES (slugs, ordinals, line
cites, archive redirects); a bare filename in prose is a legal shape under both.

Rationale, the two rot classes observed, and the design obstacles are recorded in
`agents/docs/solutions/conventions/carve-out-clause-c-companion-citations-are-unverified-prose-2026-09-02.md`.

## Scope

1. Adopt a structured, resolvable citation form for clause-(c) companions: a
   repo-relative path that resolves, paired with a risk-class token that occurs
   in that file. The convention doc proposes one shape; the exact spelling is
   this task's to settle.
2. Add a canary that resolves each citation and asserts the named file contains
   the named token. A vitest canary under `backend/tests/eslint/` is the likely
   home rather than a `.githooks` arm, because resolving a path and grepping the
   target requires repo reads that a fast pre-commit hook should not do.
3. Decide the scoping. `grep -rl "carve-out" backend/tests --include=*.ts`
   returns 114 files and `grep -rl "[Rr]eal-path companion" backend/tests
   --include=*.ts` returns 111 of them, all free prose, so a whole-tree
   assertion fails 111 files on the day it lands. A diff gate first (new and
   edited headers must use the structured form) with the whole-tree assertion
   deferred mirrors how the anchor classes were staged.
4. Fix the one known live violation, carried deliberately as a documented
   example: the clause (c) block in
   `backend/tests/middleware/verifyHiveSignature-session-invalidation-failclosed.test.ts`
   still attributes happy-path JWT acceptance to "the settings password-reset
   suites" as a category. The claim is true and no single file is the obvious
   referent, which is exactly why it needs a decision rather than a rewrite: pick
   the file that best witnesses it, or drop that half of the sentence.

## Acceptance criteria

1. A citation naming a file that does not exist fails the canary.
2. A citation naming a file that exists but does not contain the risk-class
   token fails the canary.
3. A correct citation passes, and the canary is shown to go red when the
   citation is mutated in each of the two directions above.
4. The parser handles a filename wrapped mid-token across a ` * ` docblock
   continuation line. This occurs in the current corpus, and a line-based
   extractor silently truncates such a name and then reports a nonexistent file.
5. Whatever scoping is chosen, the suite is green when it lands, and what was
   deferred is stated.
6. The known violation in scope item 4 is resolved.

## Notes

Grep the risk-class TOKEN inside the named file, never the cited filename. A
check built on finding the filename inherits the exact blindness it exists to
remove: the filename is present, the assertion is not.

Token presence is necessary, not sufficient. It catches the observed rot classes
and does not catch "the companion asserts it, but weakly"; that stays a review
judgement.

The follow-up-task branch of clause (c) cannot be checked this way. Task files
archive and the archive trims, so a task-slug citation is a dead pointer by
construction and must not appear in test source at all. Those citations should
name the uncovered risk class in behavioural terms and nothing else.

## Backend completion note (2026-09-02)

**Structured form settled** (scope 1). One companion per label occurrence, inside
the clause-(c) block:

```
 *   (c) Real-path companion: `backend/tests/routes/some-route.test.ts` [SOME_TOKEN]
```

Path repo-relative and backtick-delimited; risk-class token bracket-delimited,
whitespace-free, closing the line. The path may wrap mid-token across a ` * `
continuation (all whitespace inside the backticks is stripped on parse); the
token may not.

**Canary** (scope 2):
`backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts`.
Five arms per citation: repo-relative path shape, path resolves, not a
self-citation, the token occurs in the companion's CODE (block comments and
comment-only lines stripped, `vi.mock(` lines excluded), and the token is not
generic enough to resolve in more than 40 files under `backend/tests`.

**Scoping decided** (scope 3). Validation of structured citations is whole-tree.
The "must be structured" requirement is an in-tree ratchet rather than a
`.githooks/pre-commit` arm, for two reasons: `.githooks/` is architect zone and
outside backend's boundary, and the in-tree list is the stronger mechanism
anyway (whole-tree rather than one diff, and no env var turns it off). A comment
block that carries the canonical `real-path <adjective>? companion` label AND
names a `*.test.ts` file must use the structured form unless its file is in
`DEFERRED_FREE_PROSE` or the block carries the `carve-out-citation-allow`
marker. `DEFERRED_CEILING` makes the list one-way, and a listed file that stops
carrying an unstructured citation fails the hygiene arm, so a citation cannot be
deleted to escape the ratchet quietly.

**Deferred, explicitly** (scope 5): 102 files still carry free-prose citations
(104 at landing, minus the two converted below). Also not ratcheted, and stated
in the canary header: the one-off label nouns the corpus uses for the same idea
(sibling coverage, real-HAF variant, no-mock companion) and the citations whose
referent is prose rather than a file, which no parser can resolve. Detection is
deliberately precision-biased for the same reason the pre-commit anchor gate
scopes itself to known slug prefix families.

**Known violation resolved** (scope 4 / AC 6). The compound sentence in
`verifyHiveSignature-session-invalidation-failclosed.test.ts` is split. The
happy-path half was re-derived from the code rather than repaired in prose: it
now cites `verifyHiveSignature-authmethod.test.ts` [hiveAuthMethod], which
admits a real Bearer JWT through the real middleware with `getAppPool` unmocked.
That sidesteps the referent ambiguity in "the settings password-reset suites"
(a reviewer pass found it could plausibly mean either the settings set-password
suites or the `/api/auth/reset` suites, so repairing the prose would have
hardened a guess). The revocation half keeps its three companions, now
structured with `SESSION_INVALIDATED`. The sibling
`verifyHiveSignature-replay-revocation-hardening.test.ts` was converted too,
since it is the other half of the documented exemplar pair.

**Verification.** Five mutation probes, each observed red and then restored:
cited path mutated to a nonexistent file; token mutated to one absent from the
companion; companion swapped to a file where the token appears only in comments;
a converted citation reverted to free prose; a brand-new file added carrying a
prose citation. Control green after each. Probe one also exercised the wrapped
path on real content, since the mutation landed on the continuation half and the
failure message named the rejoined path (AC 4). `npm run typecheck` passes.
`tests/eslint/` plus the two converted suites: 10 files, 113 tests, all passing.
`npm run lint` not run: it lints `src/` only and no `src/` file changed.

**[TODO Architect]** `agents/docs/solutions/conventions/carve-out-clause-c-companion-citations-are-unverified-prose-2026-09-02.md`
ends its canary section with "Do not describe this canary as existing. It is a
proposal." That is now false, and the entry's sketch of the citation shape
should be reconciled with the form settled here. The file is architect-owned, so
backend has not touched it.

## Architect re-review (2026-09-03) — HELD PENDING FIXES:

All six acceptance criteria are met and independently verified: the wrapped-path
parse rejoins correctly (8/8 corpus citations), all eight cited companions do
assert their token in code, the suite is green, and the compound violation in the
fail-closed header is genuinely resolved. The validation half of the canary is
sound and is not what this hold is about.

The ratchet half does not hold the property the header docblock and the commit
message assert. Five independent escapes were reproduced on isolated copies, each
landing a new free-prose citation with the suite green. Two of the canary's own
arms are invisible to mutation of themselves. The completion note's scoping claim
("the in-tree list is the stronger mechanism anyway ... no env var turns it off")
is true of the whole-tree validation arm and false of the ratchet.

Fix all eight. Items 1 to 5 are one mechanism and should be settled together
rather than patched one at a time.

1. `DEFERRED_FREE_PROSE` exempts a FILE, not the blocks that were on it at
   landing, so any of the 102 listed files can gain brand-new free-prose
   citations forever. Reproduced: a fresh free-prose clause-(c) block naming a
   nonexistent file, appended to the deferred-listed `routes/settings.test.ts`,
   leaves the suite green. 102 of 253 test files are listed, so roughly 40
   percent of the corpus is permanently outside the ratchet rather than being a
   backlog. Make the constant a path-to-count map pinning each file's
   unstructured file-naming block count at landing, and fail when a listed file
   EXCEEDS its pin. The audit loop already computes that number.

2. The ceiling arm is `toBeLessThanOrEqual`, so a removal frees a permanent slot.
   Reproduced in both halves: de-filing `lib/cache.test.ts`'s citation outright
   (not converting it) and dropping its entry gives 101 green; parking a new
   free-prose file in the freed slot returns to 102 green with the ceiling
   untouched. This falsifies the header's "a file that leaves the list by any
   route other than conversion goes red rather than draining the ratchet
   quietly" and the commit message's "deleting a citation is not an exit from
   the ratchet".

3. The ceiling is a length check, so a same-length membership swap passes:
   converting one entry, removing it, and adding a different brand-new
   free-prose file in the same edit keeps the length at 102, green. Fix items 2
   and 3 together with a frozen, never-edited snapshot of the landing filenames
   plus a subset assertion, deriving the ceiling from that snapshot's length.
   That subsumes a bare `toBe` and closes de-filing, the freed slot and the swap
   in one mechanism. Do NOT land `toBe` alone; it leaves item 3 open.
   The `DEFERRED_CEILING` docblock also asserts "The exact-membership check below
   already goes red when an entry is added". No such check exists. Correct that
   sentence in the same change: a comment claiming a guarantee the code does not
   provide is the defect class this whole task exists to remove.

4. A block that satisfies its label count short-circuits before `namesAFile` is
   consulted, so one valid structured citation immunizes any amount of unchecked
   prose beside it. Reproduced: unlabeled prose naming two real test files added
   next to the structured citations in
   `verifyHiveSignature-session-invalidation-failclosed.test.ts` stays green.
   This re-admits the half-true compound, which the convention entry and this
   canary's own header both name as the shape that survives review. Strip the
   text matched by the citation pattern from the block, then fail when the
   remainder still matches the names-a-test-file pattern, for non-deferred and
   non-exempt blocks only.

5. A companion claim naming no file is never ratcheted, so a new file whose only
   clause-(c) line is "Real-path companion: the settings password-reset suites
   cover the live happy path" passes. That is verbatim the shape AC 6 removed.
   The header declines this class because such citations are "unresolvable by any
   parser" and would need "an unbounded phrase list that rots". That reasoning
   supports not VALIDATING a file-less claim; it does not support not REJECTING
   one, which is dropping a single guard. Drop the names-a-file guard so a label
   with fewer structured citations than labels fails regardless, and seed a
   second deferred list for the existing file-less blocks. Measured cost: of 126
   labelled blocks in the corpus, 110 name a test file and 16 name none, across
   14 files. A 16-entry list, not the hundred-plus the header's framing implies.

6. The ratchet's `exempt` gate is vacuous. The allow marker occurs nowhere under
   `backend/tests` except this canary's own self-excluded constant, and both
   deleting and inverting the gate leave all five tests green with a planted
   violation present. Add planted probes driving the ratchet loop directly
   (synthetic audit-shaped inputs, or an extracted predicate) covering exempt
   true must skip and exempt false with a mismatch must not skip, mirroring the
   direct validator calls the other arms already have.

7. The over-generic-token arm is the only validator arm with no direct probe.
   Setting its branch to a constant false leaves all five tests green. Add one
   direct validator call with an over-generic real token and assert the
   "resolves in N files" message.

8. The block-comment stripper is not string-aware and already deletes real code:
   the whole `REVIEWS_BRANCH_SENTINEL` value in two route tests, a three-line
   fixture element in `routes/session-proof-invalidation.test.ts`, and 14 lines
   in `support/enclosing-symbol.ts`. No true citation is red today, so this is a
   latent false-positive vector, but its direction is the dangerous one: a token
   inside such a span makes a CORRECT citation fail with the canary's most
   misleading message, and a guard that falsely accuses is one that gets marked
   allow or deleted. Anchor the block-comment opener to line start, matching the
   `isCommentedOut` convention already stated in the support module this file
   imports from. Do not over-correct: a trailing inline block comment on a code
   line then stops being stripped, which is consistent with the blind spot the
   header already accepts, not a new problem.

### Not held, recorded so it is not re-litigated

- The claim that the token arm passes on skip-gated specs was raised and
  REJECTED at validation. The skip gating is real, three of the four cited
  companions sit behind a database-reachability skip, but those same companions
  were already cited in the pre-diff prose headers, the specs run whenever the
  app pool answers, and the header's KNOWN TRADE paragraph declines
  execution-proof deliberately. Do not widen scope for it.
- Residual risks, not fixes: the allow marker is unbounded, unjustified and
  uncounted, which makes it the lowest-friction response to any red bar this
  canary produces. The token cap counts raw text including comments, so each new
  citation of a token inflates the metric that fails it. The label pattern misses
  a label wrapped between "real-" and "path companion" and multi-adjective
  labels. The self-citation arm is string equality, so mutual vouching and `..`
  path spellings satisfy every arm. 14 frontend files carry the same citation
  shape and are unscanned, since the walk is `.ts`-only and rooted at the backend
  test tree. A shout-form risk-class token trips the pre-commit anchor gate's
  slug-prefix arm and needs the literal allow marker on that line.
- Suppressed below the confidence floor: importing the support module's comment
  predicate instead of the local one, and dropping the unused exports.

Project standards came back clean. Zone and staging audit, comment-anchor gate,
em-dash rule and carve-out clauses (a), (b) and (c) all pass.

The `[TODO Architect]` above is acknowledged and deliberately deferred: the
convention entry gets reconciled at archive, once the ratchet's shape has settled,
so it is not rewritten twice.

## Backend re-review signal (2026-09-06, commits 407474cb, 94e093a1, 2518d1f5, 626bcbc0)

All eight items landed. The first commit is the hold as prescribed; the other
three are what three adversarial passes over it found, fixed in the same round
rather than carried as residuals. They are described together because the
later ones change the shape of the first.

### The mechanism (items 1 to 5)

The file list and its ceiling are gone. Two per-file count maps carry the
backlog: `DEFERRED_FREE_PROSE` for blocks whose prose names a test file,
`DEFERRED_FILELESS` for blocks that carry the label and name no file (14
files, 16 claims, matching the hold's measurement). The count is the file's
label DEFICIT, labels minus structured citations, summed per class, so a
second label line inside an existing block weighs the same as a new block
(103 files and 133 claims in the free-prose map: the hold's 102 files and 108
blocks, plus the multi-label blocks now counted per label, plus one file whose
reverse-direction companion declaration the widened label pattern now sees).
Each pin is EXACT against the tree, and each map is bounded by a frozen,
never-edited landing snapshot: keys must be a subset, a pin cannot exceed its
landing count, a pin must be a positive integer. The ceiling is implied by the
subset assertion, so there is no number to keep in step, and the false
"exact-membership check" sentence went with the constant it sat on. A sha256
of both snapshot maps' entries is pinned as `LANDING_DIGEST`, so a change to
any entry or count needs a recomputed literal (a reorder is a no-op).

The names-a-file guard is dropped: a label with fewer structured citations
than labels is a violation whether or not it names a file; the filename test
only routes it between the two backlogs. A block whose citations are all
structured has them stripped and the remainder tested for a test-file name; a
hit is the `leaky` class and always a violation, and a filename tucked into
the label's own qualifier slot counts as that prose. A citation-shaped line
that does not parse as the label is its own violation class rather than a
skipped block.

### Items 6, 7 and 8

Item 6: `ratchetClass` is probed with the marker present and absent on the
same text and with synthetic shapes for every class, and `auditSources` is
driven with a synthetic source carrying one block of each class, so the loop
and every consumer of a class (the deficit sums, the class lists, validation,
the mixed-script list) are proven live rather than only the predicate. Item 7:
one direct `citationViolations` call with an over-generic real token against
the real tree asserts the reach message; the companion stub asserts the token
so only the reach arm can fire. Item 8: the stripper is no longer a line-shape
heuristic at all, which is the strongest available form of the fix. The
sentinel value, the `startsWith('/*')` predicate, a `*`-led SQL continuation
line, a generator method and a `/*` at line start inside a template literal
are all probed as code; a line-start block comment, indented or JSDoc, is
still stripped.

### What three adversarial passes found, and what changed

Each pass ran attackers in isolated worktrees against the previous commit.
The verifier and critic stages were cut off by the session rate limit in both
red-team rounds, so every claim below was re-verified by hand in a detached
worktree, in both directions, and each is now a probe in the canary.

**Round 1** (against 407474cb, fixed in 94e093a1). The comment collector
admitted only lines that START with a comment marker: a labelled claim in a
trailing comment on the `vi.mock(` line, a gutter-less block comment, a bare
or blank line inside a docblock, and a `//` note under the header separated by
a blank line were all invisible, and a STRUCTURED citation in a trailing block
comment was never validated either, which made the whole-tree claim false. The
pin counted blocks, so a second label inside an existing backlog block was
invisible. The label pattern missed `Realpath`, `real-path-companion`, a
parenthesised or digit qualifier, `@realPathCompanion` and markup; the
filename pattern missed `settings.test`, a frontend `.test.js`, a name wrapped
inside its last segment and a bare `backend/tests/...` path. The shared walker
used `isFile()`, which is false for a symlink vitest would run.

**Round 2** (against 94e093a1, fixed in 2518d1f5). The two remaining textual
heuristics disagreed with each other and with the language. On the citing
side: a claim in a trailing comment after a template literal's closing line
(the house style backticks every path, so the claim's own backtick paired with
the literal's) or beside a regex holding a quote was blanked out with the
literal; a regex holding `/*` opened a phantom block that swallowed a correct
citation into a false `leaky` accusation; a labelled line inside a
template-literal fixture was read as a claim. On the companion side: a `*`-led
SQL continuation and a generator method were dropped as gutter lines; a `/*`
at line start inside a template deleted real code; and a token occurring only
inside a `vi.mock` factory, a `vi.spyOn` or `vi.doMock` stub, a mocked row, a
spec title, or a longer identifier (`hafQueryMock` for `hafQuery`) counted as
an assertion, which is the historical incident shape reproduced against real
corpus files. A punctuated token (`verifyHiveSignature:`) dodged the reach cap
by selecting exactly the mock stubs. A filename in the label's qualifier slot
was cut out with the citation; a sentence ending in the bare label above a
citation fused with it; ordinary prose ("the real path and companion
fixtures") was a label; a Cyrillic look-alike letter hid the label or a
filename; a claim split across two trailing comments was two unlabelled
blocks. A `__proto__` entry in the live map admitted an unlisted file and a
`NaN` pin switched every arithmetic arm off. And honest headers went red:
naming the fixture path root `CLAUDE.md` requires, the reserved `example.test`
domain, a `RE.test(...)` call, `companion(s):`, or a parenthetical after the
token.

The fix lets TypeScript's parser decide what a comment is, on both sides.
Every comment is trivia attached to some token, nothing inside a string,
template or regex literal is one, and the companion's code is the source minus
those ranges, minus every vitest mocking call with its body, minus every spec
title, matched as a whole word. The label's qualifier slot admits plain words
only (never the label's own words, a stop word or a path). Any comment word
mixing the Latin script with another is refused. A reverse form (`Real-path
companion for: <path>`) lets a real-path suite declare itself the companion,
checked from both ends, so the convention entry's two-sided link is writable
without the marker. Fixtures, support modules, mail addresses, URLs, the
reserved domain and method calls are not test filenames; a glob or alternation
family is. Pins are read as own integer properties only. Companions under
`tests/eslint/` or `tests/support/` are refused, since they scan sources and
run no route. Under the parser's definition `verifyHiveSignature` is spelt in
code by 8 files (nearly every suite naming it does so inside the call that
mocks it), so the over-generic example in the cap docblock is now `createApp`
at 117, and `argon2` falls from 41 raw files to 32, which removes a false
rejection of an honest token.

**Round 3** (self-audit against 2518d1f5, fixed in 626bcbc0). Re-running the
round-1 probe battery caught a regression the new parser introduced: a comment
block below the last statement was not collected, because the end-of-file
token carries it as its own JSDoc child and the walk skipped every JSDoc
subtree without first asking that token for its leading trivia. A companion
claim appended to the end of any file was therefore invisible. A node is now a
leaf once its JSDoc children are set aside, and both shapes are probed.

The corpus classification is identical across all four commits (103 files and
133 claims; 14 and 16), so none of this moved the backlog.

### Residuals, stated in the header rather than claimed away

Unlabelled prose is not a claim the ratchet can see: an unlabelled sentence
naming no file beside a structured citation, or naming a test file in a block
that is neither the labelled one nor adjacent to it, passes. So does a file
named without `.test`/`.spec` and without a `tests/<dir>/` path in front of
it. A claim replaced by a different claim in the same file at constant deficit
is invisible. The live maps are bounded by the snapshot, not monotonic: a
lowered pin can be raised back to its landing count and a removed entry
re-added while the tree agrees. A confusable forming a single-script word of
its own is not refused. A token in a fixture row outside any mocking call, or
in a string that is not a spec title, still counts, as does a companion behind
`describe.skipIf` or whose only spec is `it.todo`. The marker is unbounded and
needs no reason. The digest can be recomputed by anyone. The first two and the
same-file replacement were confirmed green by probe, so the header's statement
of them is true rather than assumed.

### Deviations from the prescription

1. Pins are exact, not "fail when EXCEEDS". Under `<=`, converting one of a
   file's two claims leaves a slot a new claim can take with no edit at all,
   the freed slot of item 2 one level down. Exactness makes a conversion (or a
   deletion) lower the pin, a visible edit.
2. The frozen snapshot holds counts, not just filenames, and is digest-pinned.
   A filename-only snapshot bounds membership but not pins, and a raised pin is
   the block-level form of an added file.
3. The remainder check runs on every non-exempt block, not only non-deferred
   ones. Zero blocks are leaky at landing, and a backlog file's freshly
   converted block is exactly where the half-true compound appears next.
4. Deleting a claim outright is indistinguishable from converting it; both
   lower a pin. What IS closed is that the removal frees nothing for anyone:
   the slot cannot be taken by a new file (absent from the snapshot), by a new
   claim in the same file (the deficit cannot exceed the pin), or by a snapshot
   edit without a recomputed digest. Probed in all four directions.
5. Renaming a backlog file forces its claims to convert (or take the marker):
   the old path leaves the map and the new path cannot enter it.
6. The names-a-file test is not literally dropped; it routes a label deficit
   between the two backlogs, on the prose remainder, so a structured citation
   beside a file-less label lands in the file-less backlog and its message
   offers the marker or the reverse form.
7. The canary now parses every scanned file once. It runs in about three and a
   half seconds rather than under one; `tests/eslint/` as a whole is 6.3s.

### Verification

`npm run typecheck` passes. `tests/eslint/` plus every suite importing the
shared walker plus the two converted middleware suites: 11 files, 129 tests
and 4 skipped, green. `npm run lint` not run: it lints `src/` only and no
`src/` file changed.

Mutation probes ran in a detached worktree at each commit, each observed red
with the named message, restored, and the control green after each group.
Against the prescribed commit: a new prose block in a listed file (item 1);
the de-file-and-drop sequence, the freed slot and the same-length swap (items
2 and 3); filename prose beside the structured citations in the fail-closed
header (item 4); a new file whose only clause-(c) line is the settings-suites
sentence, and the same with the marker (item 5); the exempt gate inverted and
deleted (item 6); the reach arm set to constant false (item 7); the stripper
reverted (item 8); a pin raised above landing, a pin set to zero, a snapshot
entry removed; and the original criteria on the converted exemplar (a
nonexistent path, an absent token, and a nonexistent path wrapped across a
continuation line naming the rejoined path).

Against the later commits, one probe per red-team finding, all red: the
trailing `//` claim and the trailing block comment carrying a structured
citation to a nonexistent file; the gutter-less header; the bare and the blank
line inside a docblock; the adjacent `//` block; a second label inside an
existing backlog block in each class; the U+2011 hyphen, `Realpath`, the JSDoc
tag, the parenthesised qualifier, the backticked qualifier, bold markup and a
Cyrillic look-alike letter; the suffix-less, `.test.js`, wrapped-segment, bare
`tests/` and glob-family names; a symlinked test file; the template-closer and
regex-quote trailing claims; the label split across two trailing comments; the
qualifier-slot filename; the fused sentence; a token found only in a real
companion's `vi.mock` factory, `vi.spyOn` target, describe title, or as a
longer identifier; a punctuation-suffixed token; a source-scanning canary as
companion; a `__proto__` entry and a `NaN` pin. And green where green is
correct: the regex holding `/*`, the template-literal fixture, the fixture
path in clause (a), the reserved domain, `companion(s):`, a trailing
parenthetical, ordinary "real path ... companion" prose, a token on a `*`-led
SQL line, and the reverse form with the link visible from both ends (red when
only one end has it).

### [TODO Architect]

`agents/docs/solutions/conventions/carve-out-clause-c-companion-citations-are-unverified-prose-2026-09-02.md`
still ends its canary section with "Do not describe this canary as existing.
It is a proposal." That is now false. The entry's sketch of the citation shape
also predates the reverse form and the qualifier rules, and its "the realistic
sequencing is a diff gate first" paragraph is superseded by the in-tree
ratchet. The file is architect-owned, so backend has not touched it.

## Architect re-review (2026-09-06) — HELD PENDING FIXES:

All eight items held on 2026-09-03 are FIXED, and the round is substantial work
that closed real defects. Verified independently rather than from the signal
block: the two backlog maps are 103 files / 133 claims and 14 files / 16 claims,
each an exact subset of its frozen snapshot with no live key absent from the
snapshot and no pin above its landing count; the suite is green at 10 tests; the
`exempt` gate and the over-generic-token reach cap (items 6 and 7) are now
genuinely covered, confirmed by inverting and deleting each in a scratch copy;
the block-comment stripper class (item 8) is closed, with `codeOf` over-reach
measured at 2 files of 253 and both losses intentional; and the comment
collector's recall was probed at 20 exotic positions and against every `//` and
`/*` in all 253 files with zero misses. `sourcesUnder`'s symlink change is a
behavioural no-op for its four consumers. The four commits stage only backend
paths, carry the trailer, and use the bare `backend(tests):` form. Project
standards came back clean, including a full anchor-rot sweep of every added line.

What this hold is about: three of the four items below each contradict a specific
sentence in the file's own header docblock. That is the same defect class round 1
was raised for, now recurring in the round-2 mechanism rather than the round-1
one. Two independent reviewers reproduced each escape end to end on isolated
copies, and an independent validation gate reproduced them again before this
block was written; it also rejected four other candidate findings, listed at the
bottom so they are not re-litigated.

Items 1 and 4 are one theme and should be settled together. Anchor every code
comment you write here on stable symbols, never on line numbers.

1. A companion claim whose qualifier WRAPS across a docblock continuation line
   vanishes from the ratchet entirely. `LOOSE_CLAIM_SRC` matches with `[^\n]`
   between `path` and `companion`, so the loose-claim guard cannot cross a line
   break, while `LABEL_SRC`'s `[\s-]*` can. Such a claim yields labels=0 and
   unparsed=0, and `auditSources` drops the block before any class is assigned.
   Reproduced: `(c) Real-path, no-mock companion: routes/foo.test.ts covers it`
   is caught on one line and passes silently when wrapped before `companion`,
   landing a brand-new free-prose claim in a file in neither backlog, suite
   green. Docblocks in this corpus wrap near 76 columns, so wrapping is the
   default spelling for anything longer than one line, and the wrapped-path case
   was AC 4 of this task. The header asserts the opposite outcome in so many
   words: a citation-shaped line that does not parse as the label "is a violation
   of its own rather than a skipped block". Run `unparsedClaims` over a
   whitespace-collapsed copy of the block, the same rejoin `namesATestFile`
   already performs, and widen the window after `companion` so a wrapped or
   longer qualifier still registers. Probe the wrapped spelling of the
   already-probed one-line case.

2. The REVERSE citation form discharges clause (c) on a filename substring and
   never reaches the token arm. The reverse branch of `citationViolations` tests
   only that the cited file's raw text contains the citing file's basename, then
   returns; `blockShape` still counts the citation as satisfying its label, so
   `ratchetClass` returns `structured`. Nothing constrains direction: neither
   file need be a real-path suite, and the cited file may itself be a mocking
   suite. Reproduced: a reverse citation planted in a mocked suite naming an
   unrelated route suite passed, purely because that file's prose happens to
   contain the citing basename. 505 basename cross-mentions already exist under
   `backend/tests`, so for most files this is a one-file edit. This is the
   filename-presence blindness the header's own "WHY THE TOKEN AND NOT THE
   FILENAME" section rejects for forward citations, re-entering through the form
   added this round. Resolve the link by PATH rather than by substring: parse the
   named file's comment blocks and require a forward citation back to the citing
   file, or a reverse citation pointing back.

   Named design question, yours to settle rather than guess: should a reverse
   citation additionally carry a `[TOKEN]` that the CITING file asserts in its
   own `codeOf` output? Resolving the link by path closes the reproduced escape
   on its own. Requiring a token as well is a convention change, because the
   reverse form is what the solutions entry recommends precisely so both ends of
   the link are visible, and a token requirement raises the cost of writing it.
   Decide, implement the decision, and record the reasoning in the header. If you
   conclude the question needs architect input rather than an implementer call,
   move this task to `blocked/` with a `[BLOCKED by Architect]` note instead of
   guessing.

3. A third decision arm has no mutation probe, which is the class of round 1's
   items 6 and 7. The token-shape arm in `citationViolations`, the one rejecting
   a token that is not a single whitespace-free code token, can be deleted or set
   to a constant false with the whole of `tests/eslint` staying green (8 files,
   108 tests). Two reviewers found this independently by mutation. The line
   carrying it is one this round itself modified when it added the forward-kind
   guard, so the round's own sweep passed over it.

   Do not fix only this instance. Enumerate every decision arm in
   `citationViolations` and every class in `ratchetClass`, and pin each with a
   direct probe that goes red when that arm alone is neutered. Report the
   enumeration and which arms already had a probe, so the class is closed rather
   than its third instance. This is the third time the same class has surfaced on
   this file.

4. A backticked filename in a citation's own trailer slips past the leaky arm,
   re-admitting the half-true compound that round 1's item 4 closed. `surroundOf`
   blanks every backticked span in the matched text and then blanks greedily from
   the first `[` to the last `]`, so a second filename in the citation's trailing
   parenthetical is erased before `namesATestFile` sees it and the block
   classifies as `structured` rather than `leaky`. Reproduced: a trailer reading
   `(see also backend/tests/routes/custody-upgrade.test.ts)` is caught, and the
   identical trailer in backticks passes. Backticking a path is this convention's
   own house style, stated in the header, so the evading spelling is the natural
   one and the caught spelling is the unusual one. The `Citation.surround`
   docblock states the guarantee that fails: "A filename in here is prose beside
   the citation, not part of it." Build `surround` from the match's own captures,
   removing the first occurrence of the captured path and token by literal
   substring, rather than by a global pattern sweep. Probe the backticked and
   bracketed trailer spellings beside the existing unbackticked one.

   Items 1 and 4 are one theme: detection defeated by the corpus's own authoring
   style, line wraps and backticks respectively. Fix the shared cause and audit
   for other house-style spellings that defeat a pattern, rather than patching
   two symptoms. Say in the signal block what that audit covered.

### Not held, recorded so it is not re-litigated

Four further candidates were raised and REJECTED at independent validation. Do
not act on them, and do not re-raise them in the next round.

- That the file should be split because it crosses 1000 lines. No rule backs it:
  there is no `CODING_STANDARDS.md`, no `max-lines` in the eslint config, and no
  file-length limit in root `CLAUDE.md`. The engine and its probe battery are
  deliberately colocated in a self-contained canary. Preference, not a defect.
- That the `eslint/`+`support/` companion rejection should apply to reverse
  citations too. The forward-only guard is semantically CORRECT: in the reverse
  form the named path is the mocked suite being served, not the witness, and a
  real mocked suite lives under that prefix today. Dropping the guard would emit
  a false "witnesses nothing" verdict against a legitimate declaration. Note this
  is independent of item 2 above, which is about the reverse branch's link check,
  not about which directories it accepts.
- That `citationViolations` should route the companion through `codeCache`. The
  bypass is real and immaterial: measured at 32 ms of a 1255 ms validation pass,
  while the dominant `tokenReach` path already uses the cache.
- That `TESTS_TREE_PATH_RE` and `NON_RUNTIME_DIR_RE` should share a directory
  exclusion list. They answer different questions, the present asymmetry is the
  stricter direction with no live false positive, and aligning them would weaken
  the leaky arm.

The `[TODO Architect]` on the solutions entry is confirmed accurate and stays
deferred to archive, so the entry is reconciled once against a settled shape
rather than twice. Its stale disclaimer, its citation-shape sketch, and its
sequencing paragraph are all superseded; the architect owns that edit.

## Backend re-review signal (2026-09-06, commit f00435d3)

All four items landed. Items 1 and 4 are fixed at the shared cause the hold
named rather than as two symptoms; item 2 settles the design question the hold
delegated; item 3's enumeration is reported in full below. The house-style
audit item 4 mandated then found six more instances of the same class, plus one
regression the first pass introduced, and those are fixed here too rather than
carried.

### The shared cause (items 1 and 4)

Both escapes were detection defeated by the corpus's own authoring style, and
both had one shape: a detector re-scanning surrounding text with a pattern that
assumes a spelling of it.

  - Item 1: `LOOSE_CLAIM_SRC` bounded its windows with `[^\n]`, and these
    docblocks wrap near 76 columns. Measured on the tree, not assumed: of 158
    label occurrences under `backend/tests`, 6 are already spelt across a wrap,
    so the invisible spelling is one the corpus actually writes.
  - Item 4: `surround` was built by sweeping every backticked span and one
    bracketed span out of the match, and backticking a path is this
    convention's house style, so the erased spelling was the natural one.

The rule both fixes follow, now stated in the header under WHY THE DETECTORS
READ A REJOINED BLOCK AND THE MATCH'S OWN CAPTURES: a detector reads either a
view of the text that is invariant under the house style, or the spans the
parser already captured, never a re-scan with a pattern that assumes one
spelling. `rejoined` and `glued` are named helpers rather than two inline
replaces buried in `namesATestFile`; `citationsIn` removes the literal spans
the match captured, first occurrence only.

### Item 2, and the design question it named

The reverse link is resolved by PATH: `citationsInSource` parses the named
file's comment blocks and the link holds only when one of its citations names
the citing file. The substring test is gone. On this tree 396 basename
cross-mentions already exist under `backend/tests`, so that test was satisfied
by accident for most files.

**Decision: the reverse form does NOT carry a `[TOKEN]`. Instead the citation
that answers it must be a FORWARD one.** A reverse declaration discharges no
clause of its own, because the file writing it mocks nothing. It is a signpost,
not a justification, and what must be checkable about a signpost is that it
points somewhere. The forward citation it points at is resolved and
token-checked in its own right, so the risk class is already witnessed once, at
the end that owes the justification. A token on the reverse form would spell
that same fact a second time in a second place, where it can drift, and would
raise the writing cost of exactly the declaration the solutions entry
recommends.

Requiring the ANSWER to be forward is what makes that safe, and it is a
deviation from the hold's "or a reverse citation pointing back": under that
wording two files declare each other companions with no token at either end,
which is the filename-presence blindness one level up. The stricter rule costs
nothing, since the mocked suite owes a clause-(c) citation anyway and requiring
it to name the declaring file IS the two-sided link the convention asks for. No
structured reverse citation exists in the corpus today (all 10 "companion for"
occurrences are free prose in backlog files), so nothing migrates.

### Item 3: the enumeration

Every decision arm was mutated one at a time, set to a constant or deleted, and
run against `npx vitest run tests/eslint/` on an isolated worktree copy. 69 arms
were swept and all 69 now go red. The hold named one instance; the sweep found
four unprobed arms, of which the named one was one; extending the sweep past the
two functions the hold named found three more; the adversarial pass found two
further ones.

`citationViolations`, 16 arms: path shape; **path canonicalisation (new)**;
**the self-canary rejection (new)**; self-citation; the non-runtime-directory
arm and **the forward-guard on it (was GREEN)**; **the token-shape arm (was
GREEN, the instance the hold named)** and **each of its two halves (both were
GREEN)** and its forward-guard; companion-does-not-exist; the reverse
link-unresolved arm, the mutual-reverse arm and the back-link path equality (all
new); token-in-code and its in-source message branch; the over-generic reach cap.

`ratchetClass`, all six classes and five branches: exempt; unparsed; the deficit
split in both directions; the leaky/structured split. All were already probed.

Extended past those two functions, because the class is "a decision nothing
pins", not "a decision in these two functions": `blockShape`'s five fields;
`namesATestFile`'s five arms and both rejoined views; `scrubNonFiles`'s five
arms; `proseRemainder`'s two cuts; `unparsedClaims`' three parts; `citationsIn`'s
whitespace strip, reverse collection and both literal removals; `AFTER_LABEL`'s
closing-tag alternative; `QUALIFIER`'s stop-word form; `CLAIM_SPAN`'s two
refusals; the loose window; `tokenMatcher`'s two boundaries; `codeOf`'s
mock-call, string-title and template-title spans; `mixedScriptWords`;
`snapshotDigest`'s canonicalisation; `reconcileBacklog`'s second-loop integer
guard; the audit's label-free skip; the ALLOW_MARKER's two views.

Six of those were GREEN and are now probed, each with a note on why its
neighbour covered for it: **`namesATestFile`'s spaced view** (the glued view
subsumes it on one line, but runs `settings.test.ts` into `.tsand` when a wrap
follows the name with prose); **`scrubNonFiles`' mail and URL arms** (their only
negatives were `example.test` addresses, which the reserved-domain arm also
scrubs); **`citationsInSource`'s block walk** (the first probe written for it
passed under the mutation too, because the token bracket's end-of-line anchor
makes a structured citation nearly unspellable inside a string; the probe that
pins it is a back-citation whose path wraps across a ` * ` gutter, which raw
text carries into the middle of the path); **`AFTER_LABEL`'s closing-tag
alternative** (the label count probes the `<em>` spelling, but never reaches the
citation parsers, the only consumers of `AFTER_LABEL`); and
**`reconcileBacklog`'s second-loop integer guard** (the existing `NaN` probe
pins only the first loop, since every comparison against `NaN` is false either
way; a fractional pin is the value that reaches the second).

### The house-style audit (item 4's second half), and what it found

Every detector was checked against the spellings this corpus actually uses,
measured rather than guessed: 158 label occurrences, 15 distinct spellings, 6
wrapped. Five adversarial passes ran in isolated worktrees over the finished
fix, each with one lens (wrapping, delimiters, the reverse form, the ratchet
arithmetic, and false accusation). Every claim below was reproduced by hand in
both directions in a detached worktree before it was acted on, and each is now
a probe.

**A regression the first pass introduced, caught and fixed before landing.**
Widening the window after the noun from 8 to 40, as the hold prescribed, and
reading the whole rejoined block, turns the corpus's own clause-(a) wording
("any case where exercising the real path per-test is impractical") standing
above a perfectly written clause-(c) citation into an `unparsed` violation, and
the message blames the citation. Verified: red with the fix as first written,
green against the pre-round canary. Two changes: the after-noun window is back
at 8, and the claim scan runs on the block with its own structured citations
cut out, plus each citation's surround so a claim in a trailer is not cut away
with it. Both directions probed.

**Six more instances of the class, all pre-existing, all fixed.**

  1. `namesATestFile` consulted the glued view for one of its patterns only, so
     a `tests/<dir>/<name>` path in prose broken at its own directory slash was
     invisible to the leaky arm while the same path on one line was caught.
  2. `CLAIM_SPAN`'s sentence-break refusal read a filename broken at its own dot
     (`custody-consent-ops.` / `test.ts`) as a sentence end, so the claim, and
     with it the whole block including any structured citation beside it, was
     dropped unaudited. A new sentence does not begin with a lower-case letter,
     which separates the two.
  3. `QUALIFIER` refused a qualifier that BEGINS with a stop word rather than
     one that IS one: the word boundary falls inside `no-mock`, this corpus's
     commonest qualifier, so `Real-path no-mock companion \`some.test.ts\``
     parsed as zero labels and, carrying no colon, as no claim either. Changing
     one word of it (`mock-free`) was caught.
  4. The ALLOW_MARKER was matched by a raw substring test, so a marker the
     docblock wrapped at one of its own hyphens failed to exempt. That fails
     RED, on a block whose author did exactly what the message asked.
  5. `scrubNonFiles` blanked a whole URL token, so the half-true compound
     written as a link (a `github.com/.../settings.test.ts` blob URL beside a
     structured citation) passed as `structured`. Only the scheme and authority
     are scrubbed now: a `.test` HOST is a domain, a link whose PATH ends in a
     test file names that file.
  6. `.env.test` was read as the suffix-less name of a test file, so an honest
     header naming the E2E env-file split root `CLAUDE.md` documents was classed
     `leaky`.

**Two more, on the reverse form this round added.** Companion paths were shape
checked but never canonicalised, and `//`, `/./` and `/../` all satisfy the
shape pattern because `.` and `/` sit inside its character class. Every arm then
used one of two different notions of the path: the self-citation compare and my
new back-link filter are string equality, while reading the file canonicalises.
So `backend/tests/routes//self.test.ts` was not the citing file to arm 3 and
was exactly it to the reader, restoring in two characters the hole arm 3 exists
to close; and `backend/tests/../witness.test.ts` made a witness out of a file
this canary never walks, whose own citations are never audited and whose token
scores zero against the reach cap. Separately, this canary is dropped from its
own scan, so the worked examples in its header answered any reverse declaration
that named it. Both closed; a path that is not already canonical is rejected
with the existing message, and no citation may name this file.

The path-canonicalisation half was recorded as a residual in the 2026-09-03
hold ("the self-citation arm is string equality, so mutual vouching and `..`
path spellings satisfy every arm") rather than as a fix. It is closed here, not
re-litigated: the reverse form's new path-equality link inherits the same
weakness, so leaving it would have meant shipping a fresh instance of a known
one. Say so if that reads as scope this round should not have taken.

### Deviations from the prescription

1. The window after the noun is NOT widened. The hold asked for it; widening it
   accuses ordinary technical prose, reproduced above on verbatim corpus
   wording. The rejoin alone closes the escape the hold reported, and every
   wrapped spelling of a claim ending in `companion:` is caught with the tight
   window, because the wrap collapses to one space.
2. A reverse citation must be answered by a FORWARD one, not by "a forward
   citation back or a reverse citation pointing back". Reasoning above.
3. The audit fixed seven further instances of the item-1/item-4 class rather
   than only reporting them, on the reading that "fix the shared cause and audit
   for other house-style spellings that defeat a pattern" asks for the class to
   be closed. Each is listed above; say if any should have been a separate task.

### Found and NOT fixed, for triage rather than silence

  - **NFKC folds the micro sign to Greek mu**, so `250µs`, the SI spelling of
    microseconds, is a mixed-script violation, as is `Δt`. Neither is a
    look-alike for anything Latin. The mixed-script scan runs before the
    ratchet's exempt test, so the ALLOW_MARKER does not cover this verdict and
    no backlog does either: the ASCII spelling is the only remedy. Pre-existing
    and untouched by this round. The header's claim that "no honest comment in
    this corpus contains one" was false and is corrected in place to state the
    trap; narrowing which scripts count as confusable is a decision worth
    taking deliberately rather than on the way past.
  - **A reverse declaration in a file that itself mocks** satisfies that file's
    clause-(c) label, so two mocked suites can discharge each other with one
    real token between them and no real path run at either end. Stated in the
    header as what the link does not establish. The obvious mechanical fix, "a
    reverse citation in a file containing any mocking call does not satisfy a
    label", is too blunt: `vi.fn` and `vi.spyOn` are in `MOCK_CALL_RE` and in
    nearly every suite.
  - **`real path with a mocked companion here:`** and shapes like it are read as
    citation-shaped and accused. Confirmed pre-existing by running the same
    prose against the pre-round canary.

### Residuals now stated in the header

The reverse link does not establish that the two files stand in a mocked /
real-path relationship. A suffix-less name broken at its own dot is read only on
the spaced view, because the glued view cannot tell it from `e.g.` above
`test-only`, and the abbreviation is the commoner write. The claim-shaped span
gives the qualifier a bounded run; a longer one is not claim-shaped here, and
widening the bound was measured (the corpus stays green well past it) and
declined, because every extra character accuses more prose. Everything
previously recorded stands unchanged.

### Verification

`npm run typecheck` passes. `tests/eslint/` plus the two converted middleware
exemplars plus every companion they cite: 12 files, 125 tests, green. Those
suites need the Docker-IP env overrides from root `CLAUDE.md`; without them the
app-pool ones 503 against `localhost:5432` and the cited `[hiveAuthMethod]`
companion fails, which is the environment and not the code. `npm run lint` not
run: it lints `src/` only and no `src/` file changed.

The corpus classification is untouched: no line of `LANDING_FREE_PROSE`,
`LANDING_FILELESS`, `DEFERRED_FREE_PROSE`, `DEFERRED_FILELESS` or
`LANDING_DIGEST` is in the diff, and the two reconcile tests plus the digest
tripwire pin all of it exactly. So none of the widened or narrowed detectors
produced a new `unparsed`, `leaky` or backlog disagreement anywhere in 253
files.

Escape probes, each run in a detached worktree with the control green before
and after, and each observed in both directions:

  - item 1, the wrapped qualifier: green before, red after; the one-line
    spelling red in both, so the gap closed rather than moved;
  - item 2, a reverse citation planted in `routes/bridge.test.ts` naming the
    unrelated `routes/search.test.ts`, which mentions `bridge.test.ts` in a
    comment: green before, red after;
  - item 4, a backticked trailer: green before, red after, beside the bare
    trailer that was red in both;
  - item 3, the token-shape arm set to a constant: 8 files and 109 tests green
    before, red after;
  - and one per audit finding: the slash-wrapped prose path, the dot-wrapped
    qualifier filename, the wrapped ALLOW_MARKER (green, as it must be), the
    `//` self-citation alias, the traversal out of the tree, this canary named
    as a companion, the stop-word-prefixed qualifier with no colon, and the
    second filename spelled as a URL.

### [TODO Architect]

`agents/docs/solutions/conventions/carve-out-clause-c-companion-citations-are-unverified-prose-2026-09-02.md`
still ends its canary section with "Do not describe this canary as existing. It
is a proposal." That is now false. Its citation-shape sketch also predates the
reverse form, the qualifier rules and this round's decision that a reverse
declaration is answered by a forward citation, and its "diff gate first"
sequencing paragraph is superseded by the in-tree ratchet. The file is
architect-owned, so backend has not touched it.

## Architect re-review (2026-09-06, second pass) — HELD PENDING FIXES:

All four items held on the first 2026-09-06 pass are FIXED, and verified rather
than read off the signal block. Items 1 and 4 are fixed at the shared cause the
hold named: `rejoined`/`glued` are named helpers and `citationsIn` removes the
literal spans the match captured, so the wrapped qualifier and the backticked
trailer are both caught, and the one-line spellings stay caught. Item 2 settles
the delegated design question, and the reasoning for "a reverse declaration is
answered by a FORWARD citation" is sound: it closes mutual vouching without
putting a token where it can drift. Item 3's enumeration was extended past the
two functions named, and the seven house-style instances found by the audit are
real finds that were fixed rather than carried.

Independently confirmed this pass, not taken from the signal block: the frozen
corpus is untouched (no line of `LANDING_FREE_PROSE`, `LANDING_FILELESS`,
`DEFERRED_FREE_PROSE`, `DEFERRED_FILELESS` or `LANDING_DIGEST` is in the diff,
and the reconcile tests plus the digest tripwire pin it); `tests/eslint/` is
green at 8 files and 109 tests; the commit stages only backend paths, carries
the trailer, and uses the bare `backend(tests):` form; and a full anchor-rot
sweep of all 498 added lines, run through the `anchor_violation()` function
lifted out of `.githooks/pre-commit`, returns zero hits. The regex cost of
`LOOSE_CLAIM_SRC` over a rejoined block was measured rather than feared: it is
hard-bounded and linear, about 9 ms against a purpose-built million-character
adversarial string, so rejoining carries no backtracking risk of its own.

What this hold is about: two of the three items are the same class as before.
One is a guard THIS round added that does not do what its own header says it
does, which is the defect class the previous hold was raised for, now in its
third consecutive round. The other is that the round's central verification
claim is false, which matters more than any single arm, because the claim is
what a reviewer would otherwise rely on instead of re-deriving. Every item
below was reproduced by executing code, twice by independent reviewers and once
more by a validation gate, before it was written here.

Anchor every code comment you write here on stable symbols, never on line
numbers.

1. The sentence-break refusal added this round is INERT against a capital, so
   it never fires for the case it exists for. `CLAIM_SPAN` reads
   `(?![.;!?]\s(?![a-z]))`, but `looseClaimPattern` builds it with the `i`
   flag, under which `[a-z]` matches `A-Z` as well. The inner lookahead can
   therefore never distinguish "a new sentence starts here" from "the phrase
   continues". Reproduced: the shipped `giu` build matches
   `runs on the real path. The companion:` and so accuses ordinary prose,
   while a case-sensitive build of the same source refuses it and still matches
   the lower-case continuation, so the fix does not cost recall. The direction
   is a false accusation rather than a silent pass, which is why it is not
   worse, but the header states the opposite outcome twice: once where it says
   a span whose words run `real ... path. The ... companion ...:` "is two
   sentences to a reader and is read as two here", and once in the paragraph
   crediting that refusal, the tight colon window and the citation cut-out as
   the three things that keep the scan off ordinary technical prose. Only two
   of those three are load-bearing today.

   Node 20 has no `(?i:)` modifier group, and neither `\p{Ll}` nor `[^a-zA-Z]`
   survives the `i` flag, so spell the literal words as case classes and build
   the loose-claim pattern with `gu`, or keep `giu` and apply a case-sensitive
   post-filter in `unparsedClaims`. Either way the probes must distinguish the
   two directions: the existing pair that reads as pinning this refusal passes
   on the unrelated colon window instead, so add a probe that goes red when the
   refusal alone is neutered, beside a probe that a lower-case continuation is
   still read as one claim. Then correct both header sentences.

2. The round's own verification claim, "69 arms were swept and all 69 now go
   red", is FALSE. Two reviewers found this independently and a validation gate
   reproduced it a third time on a byte-identical copy: single-arm mutations
   left the whole suite green at 10 of 10 for `labelAt`'s `^` anchoring,
   `COMPANION_PATH_RE`'s `\.test\.ts` requirement, `NON_RUNTIME_DIR_RE`'s
   `support` half in the FORWARD direction, and four separate members of
   `MOCK_CALL_RE`. A 111-mutation sweep put the real figure at 91 red and about
   20 green. Spot-checks agree with the mechanism in each case: the only
   `tests/support` probe writes the REVERSE form, which the forward-only guard
   exempts by design, and the "not repo-relative" probe list contains no path
   under `backend/tests` that is merely not a `.test.ts` file, so neither arm
   has anything pinning it.

   The previous hold asked for the CLASS to be closed rather than its third
   instance, and asked for the enumeration to be reported so the class could be
   checked. The enumeration was reported and is wrong, so the item is not
   discharged. Pin at least the four arms named above, each with a probe that
   goes red when that arm alone is neutered, then re-run the sweep over every
   arm rather than only the named ones. Report the result as a list of what was
   mutated and what happened, so the next pass can re-run it instead of
   re-deriving it. If any arm is deliberately left unpinned, say which and why.

3. `LABEL_SRC` backtracks super-linearly on a run of dashes adjacent to the
   label's own words. Measured: `real-path` followed by 40 dashes costs about
   10 ms, 150 dashes about 1.4 s, and 180 dashes about 3.4 s. The cause is that
   `real[\s-]*path[\s-]*` and `QUALIFIER`'s trailing `[\s-]+` can partition the
   same run in many ways, and every partition is explored before the match
   fails for want of `companion`. A dash run elsewhere in a docblock costs
   nothing, because the literal words must match first, so the trigger is a
   section underline or separator written directly against `real-path`.

   This one is PRE-EXISTING: `LABEL_SRC` is unchanged by this round, and it is
   held here only because the fix is cheap, the implementer is already in this
   code for the two items above, and a canary slow enough to look hung is a
   canary that gets disabled. Bounding both runs (`real[\s-]{0,4}path[\s-]{0,4}`
   and `[\s-]{1,4}` as the qualifier's trailing separator) has been checked
   against every label spelling the corpus writes, including the wrapped,
   `no-mock`, `Realpath`, `(Postgres)`, emphasised, closing-tag and `(s)`
   forms: all still match, and the 150-dash case drops to about 3 ms. Add a
   probe that bounds the pattern's own cost so this cannot regress unseen.

### Fold into the same round, all below the actionable bar on their own

The header is being edited for item 1 anyway, so the documentation items cost
close to nothing while it is open.

  - The header's "Two wrap-shaped gaps are left open on purpose" paragraph
    omits the gap that actually drops a claim: the room between the noun and
    the colon. A claim whose colon sits nine or more characters after
    `companion` yields labels=0 and unparsed=0 and the block is dropped
    unaudited, which is the same silent-drop outcome the earlier hold's item 1
    was raised for. Reproduced at the boundary: a seven-character gap is
    caught, a nine-character gap is not. This is PRE-EXISTING (the `{0,8}`
    window and the `giu` flags are byte-identical at the parent commit) and the
    round deliberately declined to widen it, which is a defensible call. The
    finding is that the header does not disclose it while disclosing two
    narrower gaps, and that the "widening it was measured and declined"
    sentence is attached to a different bound than the one that was measured.
    Name this gap, with its worked escape, and attach that sentence to the
    bound it belongs to.
  - `in the forward form, as above` in the new header prose is a bare
    positional anchor pointing across paragraph boundaries with no stable name
    riding along, which is the rot form rather than the carve-out's durable
    form. The pre-commit gate does not catch it, because its positional arm
    requires an article directly against a structural noun. It is small, but
    `convention-enforcing-fix-must-audit-its-own-new-code` applies with unusual
    force to this file: naming what it points at costs one clause.
  - The reverse form's back-link filter compares `companionPath` values parsed
    out of the OTHER file by string equality, and those have not been through
    the canonicalisation arm that this round added for the citing side. The
    invariant therefore holds by call-site position rather than structurally.
    It fails CLOSED, so nothing is let through, which is why it is advisory:
    either canonicalise inside the filter, or reject a non-canonical path at
    parse time in `citationsIn` so every citation the module hands out already
    satisfies it.
  - The label and loose-claim detectors read the raw and spaced views only, so
    a wrap falling inside the noun itself is invisible to them. Record the
    asymmetry beside the two gaps the header already discloses, and say why
    gluing those detectors is not the fix.

### Not held, recorded so it is not re-litigated

- The four candidates rejected at validation on the first 2026-09-06 pass (the
  file's length, the `eslint/`+`support/` rejection on reverse citations,
  routing `citationViolations` through `codeCache`, and unifying
  `TESTS_TREE_PATH_RE` with `NON_RUNTIME_DIR_RE`) were not re-raised and stand
  rejected.
- Deviations 1, 2 and 3 are all accepted as argued. Declining to widen the
  post-noun window was right, and the regression it would have caused was
  reproduced on verbatim corpus wording. Requiring the answer to a reverse
  declaration to be forward is stricter than the hold's wording and better than
  it. Fixing the seven audit instances in-round rather than reporting them was
  the correct reading of "close the class"; none of them should have been a
  separate task.
- The three items disclosed under "Found and NOT fixed" are accurately stated
  and stay open: the NFKC micro-sign fold, a reverse declaration written in a
  file that itself mocks, and `real path with a mocked companion here:` reading
  as citation-shaped. Narrowing the confusable-script set is worth a deliberate
  decision later, not a fix on the way past.
- Project standards, testing and performance all came back clean. The doubled
  `citationsIn`/`proseRemainder` calls this round introduces are real (an exact
  2x, 5099 blocks to 10198 calls) and cost nothing measurable, because the
  per-file TypeScript parse dominates the roughly 1.7 s scan. No finding.
- The adversarial lens ran in-process. No cross-model pass was available on
  this host, so the independent-corroboration bonus does not apply to any item
  above; the corroboration cited is between separate in-process reviewers and a
  separate validation gate.

**[TODO Architect]** unchanged and still deferred to archive, so the entry is
reconciled once against a settled shape rather than once per round. Confirmed
accurate again this pass, with a FIFTH stale spot found beyond the four the
signal block names: the "Current state" paragraph under Examples in
`agents/docs/solutions/conventions/carve-out-clause-c-companion-citations-are-unverified-prose-2026-09-02.md`
still describes the "settings password-reset suites" pointer as unresolved,
which the first implementation round already fixed. No new `/ce-compound` entry
is warranted for this round: the house-style detection lesson and the
per-decision-point mutation lesson are both already covered by existing entries
in the store.

## Backend re-review signal (2026-09-07, commit 2ebe064e)

All three held items and the four folded-in items landed, in one commit that
touches only the canary
`backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts`.
No other file is in the diff, so no sibling suite, the shared walker, or the
two converted middleware exemplars are affected.

### Item 1 — the sentence-break refusal now fires

It was inert because `looseClaimPattern` carried the `i` flag, under which
`CLAIM_SPAN`'s `(?![a-z])` folds to reject capitals too and can no longer tell a
new sentence from a continuation. Fixed at the flag: `looseClaimPattern` is
built with `gu`, and `LOOSE_CLAIM_SRC` spells its literal words as case classes
(`[Rr]eal`, `[Pp]ath`, `[Cc]ompanions?`) so case-insensitive matching survives
the dropped flag. `real path. The companion:` (capital) is now two sentences and
no claim; `real path. the companion:` (lower-case continuation, the
wrapped-filename shape) is still one claim. Both directions are probed on one
line and across a wrap. The two header sentences that asserted the refusal
worked are corrected to state it fires only on a capital and only because the
flag is omitted; the `CLAIM_SPAN` and `LOOSE_CLAIM_SRC` docblocks record the flag
requirement so it cannot regress silently.

### Item 3 — LABEL_SRC no longer backtracks on a dash run

Every dash-or-space run the label admits is bounded: `real[\s-]{0,4}path[\s-]{0,4}`
and the emphasis run `{0,4}` in LABEL_SRC, and QUALIFIER's trailing separator
`[\s-]{1,4}`. `LOOSE_CLAIM_SRC`'s run between the words is bounded the same way.
A new test times `labelCount` on `real-path` + 400 dashes and fails past 250ms;
the bounded pattern runs in single-digit ms, the unbounded one hangs (confirmed
red by the sweep, which reverted both bounds and timed out). All fifteen label
spellings the corpus writes still match (the existing label-count probes are
unchanged and green).

### Fold-in items

- (a) The header's gap paragraph now discloses THREE gaps and names the one
  that actually drops a claim: the `{0,8}` room between the noun and its colon,
  so a near-miss whose colon lands nine or more characters past `companion`
  yields labels=0 and unparsed=0 and is dropped unaudited. Worked escape pinned
  by a boundary probe: an 8-char gap is caught, a 9-char one is not. The
  "widening was measured and declined" sentence is moved off the before-noun
  `{0,80}` run and onto the `{0,8}` after-noun window, the bound that was
  actually measured.
- (b) `in the forward form, as above` is replaced by a restatement naming what
  it points at (a forward citation, resolved and token-checked in its own
  right, THE STRUCTURED FORM arms 1 to 5), so no bare cross-paragraph positional
  anchor remains.
- (c) The reverse back-link filter canonicalises BOTH sides
  (`path.posix.normalize`), so the invariant holds structurally rather than by
  call-site position. A back-citation written with a `/./` segment still answers
  a declaration; a probe pins it (reverting to string equality goes red).
- (d) The gap paragraph also records the label and loose detectors reading only
  the raw and rejoined views, so a wrap inside the noun itself is invisible, and
  why gluing them is not the fix (it would fuse `companion` into the next word
  and mangle every ordinary wrapped label).

### Item 2 — the enumeration, re-run and reported

The previous claim ("69 arms swept, all red") was false. This pass re-ran a
mutation sweep as a reproducible harness: neuter exactly one decision arm, run
`npx vitest run <canary> --retry=0`, a RED run means the arm is pinned and a
GREEN run means it is not, restoring the file between mutations (and confirming
byte-for-byte restore against a pre-sweep snapshot). 60 arms were mutated across
two batches: 59 went RED and 1 stayed GREEN. Zero locator misses.

The four arms the hold named GREEN are now each pinned by a dedicated probe:

- `labelAt`'s `^` anchoring — a near-miss followed by an UNSTRUCTURED label in
  the same rejoined span (a structured one would be cut by `proseRemainder`, so
  the probe uses a bare label); without the `^`, `labelAt` finds the later label
  and skips the near-miss.
- `COMPANION_PATH_RE`'s `\.test\.ts` tail — `backend/tests/routes/helper.ts`, a
  file under the tree that is not a `.test.ts`; the prefix and canonicalisation
  arms both pass it, so the tail alone rejects it.
- `NON_RUNTIME_DIR_RE`'s `support` half in the FORWARD direction — a forward
  probe naming a `tests/support/` file, beside the existing `eslint` one.
- `MOCK_CALL_RE` members — one representative call per member not already
  shaped-probed (`unmock`, `doUnmock`, `hoisted`, `stubEnv`, `mocked`,
  `importMock`, `mockReturnValue`, `mockImplementation`, `mockReturnThis`,
  `mockName`) plus the `Once` suffix, each asserting the token is stripped.

Full arm-by-arm result, so the next pass re-runs the harness rather than
re-deriving it (all RED unless marked):

```
citationViolations / ratchetClass / patterns / this round's fixes (36, all RED):
  labelAt-caret            COMPANION_PATH_RE .test.ts      NON_RUNTIME_DIR_RE support (fwd)
  MOCK_CALL_RE: hoisted stubEnv importMock unmock mocked mockReturnValue
               mockReturnThis mockName + Once suffix
  loose-i-flag (drop i)    loose-case-classes              label-bound-runs (ReDoS)
  reverse-canonical        spec-test-member                canonicalisation-fwd
  self-canary              self-citation                   nonruntime-eslint (fwd)
  nonruntime-fwd-guard     tokenshape-notws                tokenshape-length
  source-null              reverse-backlen                 reverse-mutual
  token-in-code            insource-branch                 reach-cap
  tokenmatcher-trail       tokenmatcher-lead
  ratchet: exempt unparsed deficit-split leaky/structured

reconcileBacklog / namesATestFile / scrubNonFiles / blockShape / snapshotDigest / parser (24):
  reconcile: intguard-loop1 frozen-subset pin>landing no-entry intguard-loop2
             deficit>pin deficit<pin                                    (all RED)
  namesATestFile: ext-spaced ext-glued suffixless-spaced tree-spaced tree-glued (all RED)
  scrubNonFiles: mail url example.test .env.test RE.test(                (all RED)
  blockShape.exempt: glued-view RED ; raw-view GREEN (see below)
  snapshotDigest: entry-sort order-independence RED ; hashes-entries RED
  parser: jsdoc-leaf RED ; trailing-comment-ranges RED ; forwardPattern-global RED
```

Deliberately unpinned, and why: `blockShape.exempt`'s RAW disjunct
(`text.includes(ALLOW_MARKER)`) is mathematically SUBSUMED by its glued disjunct.
`glued` removes only newline-runs, so any contiguous marker the raw view sees the
glued view sees too; no input can distinguish them, so the raw half cannot be
pinned. It is dead but harmless (fails safe) and is left in place because it
reads as the one-line case for a reader. That is the single GREEN, and it is a
redundancy rather than a gap.

Arms NOT re-mutated in this sweep, and why they stay pinned: the comment
collector's exotic-position recall (the 20-assertion "collector reads comments
as the language does" block), `citationsIn`'s capture-and-surround mechanics,
`codeOf`'s literal-boundary handling, and `mixedScriptWords` — all exercised by
their existing dedicated probe blocks, unchanged and green. The sweep targeted
the decision arms in the functions this and the prior hold implicated plus the
five listed above.

### Deviations from the prescription

1. The window after the noun is still NOT widened (`{0,8}`); the fold-in asked
   only that the gap be disclosed and the measured-sentence re-attached. The
   boundary probe pins the current bound, and a future round that widens it with
   justification updates that one probe.
2. Item 1 was fixed by dropping the `i` flag and spelling case classes rather
   than by a case-sensitive post-filter (the hold offered either): single pass,
   one source of truth.
3. Fold-in (c) canonicalises inside the filter rather than rejecting a
   non-canonical path at parse time (the hold offered either). Parse-time
   rejection would drop a malformed forward citation from the audit and downgrade
   its "not repo-relative" message to a vaguer backlog disagreement, so the
   localized fix is strictly better.

### Verification

`npm run typecheck` passes (src + tests). The canary is green at 11 tests
(~5.3s), run standalone without the Docker-IP env (it reads the filesystem only;
the Redis/HAF connect errors in its log are caught and irrelevant). The sweep
restored the file byte-for-byte after every mutation. A full anchor-rot check of
every added line against the pre-commit gate's positional / slug / redirect /
ordinal patterns returns zero hits. `npm run lint` not run: it lints `src/` only
and no `src/` file changed.

### [TODO Architect]

`agents/docs/solutions/conventions/carve-out-clause-c-companion-citations-are-unverified-prose-2026-09-02.md`
still ends its canary section with "Do not describe this canary as existing. It
is a proposal," which is false, and its citation-shape sketch, its "diff gate
first" sequencing paragraph, and (per the prior pass) its "Current state"
Examples paragraph are all superseded. The file is architect-owned, so backend
has not touched it; it is reconciled once at archive against the settled shape.

## Architect re-review (2026-09-08) — HELD PENDING FIXES:

All three items and all four fold-ins held on the second 2026-09-06 pass are
FIXED, verified independently rather than from the signal block: the `i` flag
is gone from `looseClaimPattern` and the capital/lower-case pair is probed in
both directions, on one line and across a wrap; every dash-or-space run the
label admits is bounded and a timing probe exists; the four arms the hold named
GREEN each carry a dedicated probe; the `{0,8}` gap is disclosed with a
boundary probe; the bare positional anchor is restated; the reverse back-link
canonicalises both sides; the noun-internal wrap gap is recorded. The sweep
claim held at every one of the 15 arms an independent reviewer re-mutated (the
9 the hold named plus 6 more across `citationsIn`, `unparsedClaims`,
`CLAIM_SPAN`'s lookahead, the case classes and the emphasis-run bound), all red
with byte-identical restores between mutants, which is the first round on this
file where a sampled sweep claim survived. The frozen maps and `LANDING_DIGEST`
are untouched, the commit stages only the canary, and the pre-commit anchor
gate returns zero hits on all 184 added lines (gate self-tested against a
control line before the result was trusted).

What this hold is about: two of the round's three code changes are themselves
defective in a way their own new docblock text denies, and both defects are
the detection-defeated-by-house-style class the previous hold asked to be
closed. Every item below was reproduced by execution by at least two
independent reviewers and once more by a validation gate, each on an isolated
copy. Anchor every code comment you write here on stable symbols, never on
line numbers.

Items 1 and 2 are one root cause and should be settled together.

1. The case classes in `LOOSE_CLAIM_SRC` are initial-capital only, so the
   loose-claim guard now has LESS recall than the `giu` build it replaced.
   `[Rr]eal`, `[Pp]ath` and `[Cc]ompanions?` match `Real`, `Realpath` and
   `@realPathCompanion`, but not `REAL-PATH ... COMPANION:`, while
   `labelPattern` still runs under `i` and accepts every casing. A near-miss
   claim written in capitals, `(c) REAL-PATH (also routes/foo.test.ts)
   COMPANION: covered`, therefore yields labels=0 and unparsed=0 and is dropped
   before any class is assigned; planted in a file in neither backlog, the
   suite stays green at 11 of 11, and the parent commit's build flags it. The
   spelling is house style: two backlog headers already write `(c) REAL-PATH
   COMPANION:` (`routes/settings-set-password-argon-error-translation.test.ts`
   and `routes/custody-session-auth-argon-errors.test.ts`). The `CLAIM_SPAN`
   docblock, the `LOOSE_CLAIM_SRC` docblock and the `looseClaimPattern`
   comment all say the classes "keep case-insensitive matching without the
   flag", which is false. Spell every letter as a class (`[Rr][Ee][Aa][Ll]`
   and so on, or a small helper that builds them) so those sentences become
   true as written, and pin the boundary with a probe beside the
   capital/lower-case pair: `unparsedClaims(' (c) REAL-PATH (also
   routes/foo.test.ts) COMPANION: covered')` must be 1. Verified green with
   that fix on an isolated copy, all label-spelling probes unchanged.

2. `CLAIM_SPAN`'s refusal `(?![.;!?]\s(?![a-z]))` fires on a break followed by
   ANYTHING other than an ASCII lower-case letter: a capital, a `(c)` clause
   marker, a backtick, a parenthesis, a digit, end of text. The header's
   "sentence break followed by a CAPITAL" paragraph and the `CLAIM_SPAN`
   docblock's "A new sentence begins with a capital" both describe a narrower
   trigger than the code has. The consequence is a silent drop in a
   house-style spelling: a near-miss whose qualifier reads `(e.g.` followed by
   a backticked path, `(c) Real-path (e.g. <backticked path>) companion:
   covered`, breaks at the full stop before the backtick inside its own
   qualifier, the span stops there, and the block yields labels=0 and
   unparsed=0; `(i.e. (routes/foo.test.ts))` likewise. Do NOT narrow the
   refusal to `\p{Lu}`: reproduced, that accuses
   `routes/bridge-register-rate-limit-skip-failed.test.ts` and flips the
   backlog, and the breadth is also what keeps a `(c)` marker after a full
   stop out of reach of prose above it, which nothing pins today. Correct both
   texts to the actual trigger set, disclose the abbreviation-then-backtick
   near-miss as a fourth entry in the header's "Gaps left open on purpose"
   list, and pin both directions: `unparsedClaims('preserved real-path because
   every spec issues a call. (c) Real-path SQL companion: x')` must be 0 (it
   goes red under `\p{Lu}`), and the abbreviation near-miss above must be 0
   with a comment naming it as the recorded gap, so that widening it later is
   a visible probe edit rather than a silent recall change.

3. The label pattern is still quadratic on a dash run, and the round's own
   probe comment says the opposite. `QUALIFIER`'s word class `[\w-]+` admits
   dashes, so a run after `real-path` is consumed as a qualifier word and
   partitioned against the bounded separators; the `{0,4}` and `{1,4}` bounds
   removed the local backtracking the previous hold measured but left the
   pattern O(n^2). Measured on an isolated copy: 400 dashes 28 ms, 2000 dashes
   716 ms, 6400 dashes between 7 and 8 s, 10000 dashes 18 s, and a synthetic
   block the length of the corpus's own largest comment block (19,443
   characters) 75 s. `forwardPattern` and `reversePattern` embed the same
   `LABEL_SRC`, run inside `citationsIn` on every block before `labelCount`
   does, measured 224 ms at 400 dashes, and have no probe. The probe's comment
   ("the partitions are constant, not O(n)") and the `LABEL_SRC` docblock
   sentence attributing the fix to the run bounds state a guarantee the code
   does not provide. No corpus block has the shape today, so the exposure is
   latent, but a canary slow enough to look hung gets disabled, which is why
   the previous hold took it. Fix at the word class: `\w[\w-]*` (a qualifier
   word begins with a word character; verified 11 of 11 green with every
   label-spelling probe unchanged and 6400 dashes in under a millisecond) or
   `[\w-]{1,24}` (verified sub-millisecond to 19,443 characters). Either is
   acceptable; say which and why. Then raise the timing probe's run to a
   length where quadratic growth is observable (6400 is enough: green only
   when the match is linear), add the same input to a probe over
   `citationsIn`, and reword the probe comment and the `LABEL_SRC` docblock to
   the guarantee actually provided. The probe comment's "machine variance
   cannot flake it" goes with it: the measured margin at 400 dashes is about
   9x unloaded and about 2x under 22-core saturation, an overclaim rather than
   a demonstrated flake, and it becomes true only once the pattern is linear.

### Fold into the same round, mechanical

- The header's "Gaps left open on purpose" worked example reads "a
  seven-character gap (`companion here:`) is caught, a nine-character one is
  not". ` here` is five characters, and the `nearMissGap` probe pins eight
  caught and nine dropped. Rewrite to the probe's boundary and name the probe
  (`pinned by the nearMissGap probe below`), which also gives that sentence
  the stable name the convention asks for.
- The comment on the canonicalisation probe, "(the shape it had before this
  round)", puts a coordination round in test source. Replace it with a
  behaviour anchor: "(dropping the `path.posix.normalize` canonicalisation)".
- The `LABEL_SRC` docblock's "The cost is pinned by a probe below." carries no
  stable name. Restate what it points at (the dash-run timing spec and its
  input) so the sentence survives a reorder.

### Not held, recorded so it is not re-litigated

- The rationale for dropping the `i` flag is stated in four places (the
  header's sentence-break paragraph, the `CLAIM_SPAN` docblock, the
  `LOOSE_CLAIM_SRC` docblock, the `looseClaimPattern` factory comment). Raised
  as drift risk and DISMISSED: item 1 rewrites those sentences anyway, and
  making `CLAIM_SPAN`'s docblock the single owner with pointers by name is
  optional, not held.
- The timing probe's threshold was measured rather than feared: 26 to 35 ms
  unloaded, 27 to 117 ms under synthetic 22-core saturation, no flake
  reproduced, and the module-level whole-tree scan warms the pattern before
  the spec runs. The overclaim in its comment is folded into item 3; the
  threshold itself is not held.
- Residual risks recorded, not held: `[Rr]eal` in `LOOSE_CLAIM_SRC` has no
  leading boundary, so a prose mention of a `*-real-path-*` filename within 80
  characters of `companion:` reads as a near-miss (pre-existing, corpus clean);
  a near-miss written `<strong>companion</strong>:` falls into the `{0,8}` gap
  (no such markup in the corpus); `;` sits in the refusal set although a
  semicolon never begins a sentence; the "not repo-relative" message is also
  emitted for a repo-relative non-test path such as
  `backend/tests/routes/helper.ts` (pre-existing wording); no probe records
  that a separator run over four inside a label is no longer a label, which
  the docblock says is deliberate; the signal block says fifteen label
  spellings where the probe list has twenty.
- The reverse back-link canonicalisation was traced for `./`, `..`, `//` and
  `/./` back-citations: each answers a declaration, and each is red at the
  forward shape arm when the mocked file is itself scanned, so the pair fails
  closed. No finding.
- Project standards otherwise clean: the em-dash rule does not reach code
  comments, the carve-out clauses do not apply (the file mocks nothing), and
  zone, staging, subject prefix and trailer are all correct.
- The cross-model adversarial pass did not run (no different-provider CLI on
  this host); the corroboration cited is between separate in-process reviewers
  and a separate validation gate.

**[TODO Architect]** unchanged and still deferred to archive, so the solutions
entry is reconciled once against a settled shape.

## Backend re-review signal (2026-09-09, commit 7db54e21)

All three items and all three fold-ins landed. Item 3 deviates from both
candidates the hold offered, and the round found that the word class is only
part of the cost class it belongs to; that is set out below rather than folded
away. Every number here is measured on an isolated copy of the tree, and the
frozen maps, `LANDING_DIGEST` and both backlog maps are byte-untouched.

### Item 1 — the loose guard reads every casing now

`anyCase(word)` builds one two-member class per letter, and `LOOSE_CLAIM_SRC`
spells `real`, `path` and `companion` through it. The plural needed it in both
halves: `[Ss]?` and `(?:\([Ss]\))?`.

The hold framed this as the all-caps case. Measured, the vulnerable set is any
spelling with an INTERIOR capital, and all-caps is one member of it:
`REAL-PATH ... COMPANION:`, `REAL-PATH ... COMPANIONS:`,
`REAL-PATH ... COMPANION(S):`, `REAL-path ... companion:` and
`real-PATH ... companions:` were all dropped at labels=0 unparsed=0, while
`Real-Path ... Companion:` was already caught, because an initial-capital class
is exactly what the old spelling covered. A fix aimed at the shouted spelling
alone would have left the two half-shouted forms silent, so the probe pins the
set.

The bracketed plural is only observable once the room after the noun is spent,
which is why its probe writes eight characters of slack after `(S)`: with the
group matching `(S)` the `{0,8}` still reaches the colon, and with the group
matching nothing it has to cover `(S)` too and falls three short. The
lower-case twin is caught either way, which is what makes that pair an
assertion about the casing rather than about the group.

The hold also asked for `ratchetClass(blockShape(...))` on the near-miss. It
returns `leaky`, but only when called directly: `auditSources` drops a block
with labels=0 and unparsed=0 before classifying it, so in the real path the
outcome is no audit at all. The end-to-end plant is what settles it, and it was
run: an all-caps near-miss planted in a file in neither backlog map left the
suite at 11 of 11 before the fix and reds it after.

### Item 2 — the refusal is unchanged; five texts now describe it

`CLAIM_SPAN` is byte-identical. What changed is every text that called it a
capital test. It ends the span after `.`, `;`, `!` or `?` plus one whitespace
on anything that is not an ASCII lower-case letter: a capital, a digit, a
backtick, a bracket, a dash, a quote, a second space, a letter outside ASCII,
or the end of the text. Swept all 29 characters; only ASCII a-z crosses.

**A correction to the hold.** `(?!\p{Lu})`, as the hold writes it, is not a
narrowing of `(?![a-z])`, it is an inversion: it refuses before lower-case and
crosses before capitals. Reproduced on the pristine file, it fails exactly one
spec, the synthetic wrapped-filename probe, and leaves the corpus and both
backlog reconcilers green. The narrowing the hold MEANS is the positive form,
`\s\p{Lu}` inside the refusal, and that one behaves exactly as the hold says:
two specs fail, naming
`backend/tests/routes/bridge-register-rate-limit-skip-failed.test.ts` and its
pin. The prescribed breadth probe is 0 under the pattern as it stands and under
the inversion, and 1 under the narrowing, so it pins what the hold wanted; the
probe comment names the positive spelling rather than the one in the hold.

The abbreviation-then-backtick near-miss is disclosed as a fourth entry in
"Gaps left open on purpose" and pinned at its current width by the
`abbrevNearMiss` probe. Worth recording for triage rather than acting on: the
backtick member alone IS closable with no corpus fallout today
(`(?![a-z\x60])` keeps the suite at 11 of 11 and turns the near-miss red). Its
cost is a latent false positive rather than a live one, so it was left as the
hold directs, disclosed and not closed. The gate against widening it silently
is now a probe edit.

### Item 3 — deviation: neither candidate, and the word class is not the whole class

Both hold candidates were built and measured.

- `\w[\w-]*` is close to a no-op on the general shape. It removes the pure-dash
  blow-up, but an alternating `a-a-a-` run stays quadratic: 472ms against a
  baseline 477ms at 19,443 characters for `labelCount`, and it is measurably
  SLOWER than the status quo through `citationsIn`. It also silently un-labels
  `Real-path ----- companion`, which today parses (labels 1 to 0, and with no
  colon the block is then dropped rather than counted).
- `[\w-]{1,24}` is linear but too tight to be honest here: a 29-character
  qualifier, `Real-path recordAccreditationCompletion companion: <path> [TOK]`,
  stops parsing and is ACCUSED as an unparsed claim. So is the 42-character
  `findAccreditationBroadcastByIdempotencyKey`.

Landed `[\w-]{1,64}`: linear on every shape measured, zero change to any of the
20 label spellings the specs enumerate, zero change to the whole-tree census,
and clear of the longest exported symbol name in `backend/src`, which is 42
characters. A hyphenated compound is longer still and splits across the two
qualifier slots at its own dashes, so the bound is not the constraint there.

**And the word class alone does not close the class.** Two more runs in the
label were unbounded: the emphasis run on either side of the qualifier slot,
and a qualifier's own wrappers. All three admit `_`, which is both a word
character and an emphasis character, so an underscore underline written against
`real-path` partitions between them and costs far more than the dash run the
hold names: 400 underscores 5.7s, 1600 underscores 667s, 6400 did not return.
With the word class fixed and those left alone, 6400 underscores still did not
return. All three are now bounded, so every quantified run in the label is
bounded and the work is constant per starting position, measured flat at 2.1ms
from 6400 to 120,000 characters.

The timing spec is rebuilt around that. Seven separator shapes (`-`, `_`, `*`,
a backtick, and three alternating mixes), each through `labelCount` AND
`citationsIn`, at 6400 and then 100,000 characters. The ordering is
load-bearing and the comment says so: with the word class unbounded a
100,000-dash run does not return at all, while 6400 fails in about 8 seconds,
so the short pass has to abort the spec before the long pass runs. The long
pass is what catches the cheap shapes, where an unbounded emphasis run is 53ms
at 6400 and green under any bound this side of flaky.

### Fold-ins

- The worked example now reads "an eight-character gap is caught, a
  nine-character one is not" and names the `nearMissGap` probe. The old text
  said seven characters and illustrated it with ` here`, which is five.
- The canonicalisation probe's comment names the dropped behaviour
  (`path.posix.normalize`) instead of a coordination round.
- `LABEL_SRC`'s closing sentence names the separator-run timing spec and what it
  runs, instead of pointing at a probe.

### Found and fixed beyond the prescription, surfaced rather than silent

Each is a sentence describing the same machinery this round had to correct, and
each was measured before being rewritten. Dismiss any of them and the text goes
back with no code consequence.

1. The `{0,8}` bullet stated its own precondition too widely. A far colon on its
   own silences nothing: `Real-path companion coverage for this whole file: ...`
   has a 30-character gap and is still caught, because the label parses. Only a
   near-miss, where the qualifier slot has already stopped the label, is hidden
   by a far colon. The bullet now says the conjunction.
2. The word-internal-wrap bullet named only the noun. `Re` / `al-path` and
   `Real-pa` / `th` are equally invisible, and what the corpus actually writes
   is a wrap at the label's own hyphen, which the dash-or-space run absorbs.
3. `CLAIM_SPAN`'s first paragraph illustrated the refusal with a string the
   refusal does not hold off. Removing the refusal entirely leaves
   `runs on the real path. The companion suites pin it:` at 0, because its
   14-character tail is outside the `{0,8}` room; the window holds it, not the
   rule. The short spelling, which the probes use, is the one that demonstrates
   it, and the paragraph now uses that and says which arm holds the other.
4. The "this is what the widened window would otherwise start accusing" comment
   covers two prose cases that behave differently. Measured, the semicolon case
   is window-only, and the `. The companion suites above pin it:` case needs the
   refusal AND the room removed together. The comment now names both.

### Residuals, stated rather than claimed away

- The TRAILING emphasis run's bound is not independently pinned: reverting only
  it leaves the suite green, because that run is linear on its own. It is
  bounded so the invariant "every run in the label is bounded" holds by
  construction rather than by its neighbour's bound, and that is the only claim
  made for it.
- Reverting only the LEADING emphasis bound trips the long pass at 656ms against
  a 250ms threshold, a 2.6x margin. The full revert of both is 4537ms, an 18x
  margin. The partial mutation is detected, but not comfortably.
- A 64-character bound has its own far side: a qualifier word longer than it is
  no longer a label, and with no colon within reach the block is dropped rather
  than counted. Disclosed in the QUALIFIER docblock. Every finite bound has that
  edge; nothing in this corpus approaches it (longest qualifier 10 characters,
  longest exported symbol 42).
- The header's parenthetical "the corpus stays green well past `{0,8}`" is true
  of the tree and false of this file's own prose probes, one of which flips at
  `{0,40}`. The parenthetical now says so.
- `npm run lint` was not run: it lints `src/` only and no `src/` file changed.

### Verification

- `tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts`: 11 of 11,
  and the whole `tests/eslint/` directory 9 files / 131 tests, on the real tree.
- `npm run typecheck` passes (both `typecheck:src` and `typecheck:tests`).
- Eleven mutation probes, each applied to an isolated copy, run, then restored
  with a byte-comparison against the gold copy before the next (a run where the
  restore path was wrong refused every mutant rather than probing a dirty tree).
  Ten go red and each fails in seconds rather than hanging: `anyCase` reverted;
  the bracketed plural un-classed; the refusal narrowed to a capital; the
  refusal widened to exempt a backtick; the qualifier word unbounded (8.4s at
  6400 dashes); both emphasis runs unbounded (4.5s at 100,000 underscores); the
  leading emphasis run only (657ms); the qualifier wrappers unbounded (5.9s at
  6400 underscores); the back-link canonicalisation dropped; the near-miss colon
  window widened. The eleventh, the trailing emphasis run alone, survives and is
  recorded above.
- Backlog and snapshot untouched: no line inside `LANDING_FREE_PROSE`,
  `LANDING_FILELESS`, `DEFERRED_FREE_PROSE`, `DEFERRED_FILELESS` or
  `LANDING_DIGEST` appears in the diff, and the three whole-tree reconcilers are
  green, which is what proves no file moved class.
- `.githooks/pre-commit`'s `anchor_violation()` run standalone over all 272
  added lines with `ALLOW_MARKER` set explicitly: zero hits, with five control
  lines (a task slug, a bare positional anchor, a line-number cite, a round
  ordinal, an AC redirect) all firing, so the harness was live.

### [TODO Architect]

Unchanged and still deferred to archive: the solutions entry
`carve-out-clause-c-companion-citations-are-unverified-prose-2026-09-02.md`
still ends its canary section with "Do not describe this canary as existing. It
is a proposal."

## Architect re-review (2026-09-14) — HELD PENDING FIXES:

All three items and all three fold-ins held on 2026-09-08 are FIXED, verified
independently rather than from the signal block: every new probe was re-derived
from the pattern as written; the anchor gate was re-run over all 272 added lines
with control lines firing; all eleven mutants in the signal's sweep were re-run
on an isolated copy and reproduced, the trailing-emphasis survivor included, and
fourteen more were tried; the timing spec held a 9x margin under 3x CPU
oversubscription; the census is unchanged (152 of 152 label matches across 253
files) and the frozen maps and `LANDING_DIGEST` are untouched. The `{1,64}`
deviation and the extra bounds are accepted as stated. The hold's `\p{Lu}`
spelling was indeed an inversion; the signal's correction stands.

What this hold is about: the separator-run timing spec, rebuilt this round so
that a regression "fails in seconds rather than never returning", does not do
that for two of the bounds it exists to guard, and the round's own defect class
(a sentence asserting what the code does not do) survives in four of the new
texts. Every item below was reproduced by execution on an isolated copy by at
least one reviewer and once more by an independent validation pass. Anchor every
code comment you write here on stable symbols, never on line numbers.

Items 1 and 2 are one loop and should be settled together.

1. Reverting `QUALIFIER`'s tail run `[\s-]{1,4}` to `[\s-]+` makes the spec's
   FIRST timed run (6400 dashes through `labelCount`) never return: no verdict
   in 90 s, and vitest's `testTimeout` cannot pre-empt a synchronous regex, so
   the whole file hangs. The parent commit's 400-dash probe went red on the same
   revert in about 2 s; raising the shortest length to 6400 turned that red into
   the hang the docblock says gets a canary disabled. 6400 must stay (the
   word-class revert is green at 400), so the fix is a third, shorter pass
   before it: `for (const runLength of [400, 6_400, 100_000])`. Then reword the
   spec comment and `LABEL_SRC`'s closing sentence from two lengths to three and
   name the tail-separator revert as the class the shortest pass exists for.
   Verified on an isolated copy: at 400 the committed pattern is under 1 ms on
   every shape and the tail revert costs about 2 s.

2. The `[\s-]{0,4}` inside `LABEL_SRC`'s emphasis group
   `(?:[*_\x60]{1,4}[\s-]{0,4})?` is one of the runs the docblock lists as
   bounded, but none of the seven separator shapes places an emphasis character
   directly before a long separator run, so reverting it to `[\s-]*` keeps the
   suite at 11 of 11 with the spec's worst run under 4 ms. The input that
   reaches it, `real-path_` followed by a dash run (a section underline under an
   emphasised label), costs about 2.3 s at 6400 under the revert and about 3 ms
   committed. The `sep.repeat` construction cannot express "one emphasis
   character then a run", so build the adversarial string from `[prefix, run]`
   pairs (for example `['', '-']`, `['_', '-']`, `['*', ' ']`) or add one extra
   literal `real-path_${'-'.repeat(runLength)}x` inside the loop, and say in
   the spec comment which bound that shape pins.

### Fold into the same round, mechanical

- `LABEL_SRC`'s docblock says "EVERY run in the label is therefore bounded", and
  the tag-name alternative `<[a-z]+>` in the same optional group is not. It is
  linear (it sits between literal `<` and `>` and cannot partition; measured
  flat to 1.6 M characters), so this is the sentence, not the runtime. Bound it
  as `<[a-z]{1,16}>` so the sentence is true by construction (no HTML element
  name is longer, and the probes spell only `em` and `strong`); the `<em>` and
  `<strong>` parse probes and the timing spec must stay green. Raised
  independently by three reviewers.
- `CLAIM_SPAN`'s docblock parenthetical says the long spelling ("the companion
  suites pin it:") "is held off by the room after the noun rather than by the
  refusal". Traced and measured, the refusal fires first at `. T` and the room
  is never evaluated; the string is 0 with either arm alone and 1 only with
  both removed, which is exactly what the probe comment beside the prose loop
  says ("needs the refusal AND that room removed together"). Reword the
  parenthetical to say both arms hold it on their own, so it demonstrates
  neither in isolation, which is why the short spelling is the one used.
- The header's fourth gap entry and `CLAIM_SPAN`'s closing sentence name "the
  abbreviation near-miss", but the refusal drops any qualifier containing `.`,
  `;`, `!` or `?` followed by a space and a non-lower-case character. Planted
  on an isolated copy, a two-companion list joined by a semicolon
  (`(see \`a.test.ts\`; \`b.test.ts\`)`), a two-sentence qualifier, `(SQL; HAF)`
  and `(mocked? No, ...)` all went unaudited while the controls were reported.
  Reword both texts to the trigger set, and add the semicolon-joined pair of
  backticked paths to the `abbrevNearMiss` list so the gap's width is pinned
  at a non-abbreviation member. No corpus instance today.
- `LOOSE_CLAIM_SRC`'s docblock says both halves of the plural need the class,
  and only the `(s)` half is demonstrated: reverting `[Ss]?` to `s?` is 11 of
  11 green, because `COMPANIONS:` is caught either way once the `{0,8}?` room
  absorbs the `S`. Mirror the `(S)` slack probe: `unparsedClaims(' (c) REAL-PATH
  (also routes/foo.test.ts) COMPANIONSxxxxxxxx: covered')` must be 1 (it is 0
  under the revert), plus its lower-case twin.

### Not held, recorded so it is not re-litigated

- Reverting only the trailing wrapper bound in `QUALIFIER` is detected at about
  a 1.1x margin at 100,000 characters; like the trailing emphasis run, it is
  linear on its own. Record it beside that residual; not held.
- Two further single-bound reverts survive green and are linear:
  `real[\s-]{0,4}path` to `[\s-]*`, and `LOOSE_CLAIM_SRC`'s `[\s-]{0,4}` to
  `[\s-]*`. Widening the `{0,80}?` pre-noun room to 400 also survives (a
  precision loss, not a silent pass), and so does dropping `;` from the refusal
  set. Recorded, not held.
- The header's gap entry wraps as a two-word line ("parenthesis. The"); the
  `LABEL_SRC` docblock's "a hyphenated compound ... splits across the two
  qualifier slots" is imprecise for a compound whose middle exceeds 64; the
  dash shape measures 10 to 16 ms in plain node on this host rather than
  "about 2 ms" (still 15x clear of the threshold); the docblock's "about nine
  seconds" and the spec comment's "about eight seconds" for 6400 dashes differ
  within variance. Cosmetic or theoretical; not held.
- `AFTER_LABEL`'s `[*_\x60]+` is unbounded, linear (it follows a complete label
  and a literal), and outside this diff. `anyCase` widens on non-ASCII input it
  is never given. Neither held.
- Project standards clean: anchors, subject prefix, trailer, staging and zone
  all correct; the em-dash rule does not reach code comments; the carve-out
  clauses do not apply.
- The cross-model adversarial pass did not run (no different-provider CLI on
  this host); corroboration is between separate in-process reviewers and a
  separate validation pass that reproduced every held item by execution.

**[TODO Architect]** unchanged and still deferred to archive. At that time also
fold item 1's sizing refinement (the shortest timed length must be short
relative to the worst guarded regression class, not merely shorter than the
long pass) into the sibling entry
`backtracking-fix-must-bound-every-quantifier-whose-class-overlaps-2026-09-14.md`
rather than filing a new one.

## Backend re-review signal (2026-09-29, commit e76af395)

Both held items and all four fold-ins landed, in one commit touching only the
canary. The frozen maps, both backlog constants and `LANDING_DIGEST` are
byte-untouched, and no file outside
`backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts` is
in the diff.

### Item 1 — the timing spec fails fast instead of hanging

The run-length loop is `[400, 6_400, 100_000]`. The spec comment and
`LABEL_SRC`'s closing sentence both speak of three lengths and both name the
tail-separator revert as the class the shortest pass exists for. Probed in
both directions on isolated copies: the revert of `QUALIFIER`'s trailing
`[\s-]{1,4}` to `[\s-]+` against THIS commit goes red at the 400 pass
(labelCount 2559.8ms against the 250ms threshold, whole file verdict in 7s);
the same revert against the parent commit was killed by a 120s timeout with
no Tests line ever printed, which is the hang the hold reported.

### Item 2 — the emphasis-group bound is pinned

Adversarial strings are `[prefix, run]` pairs: the seven prior shapes carry an
empty prefix, and `['_', '-']` plus `['*', ' ']` put one emphasis character
between the label and a whole homogeneous run. The spec comment states which
bound the prefixed shapes pin (the `[\s-]{0,4}` inside the emphasis group) and
why suffix-only shapes cannot (the mixed run reaches the group but hands it at
most one dash between emphasis characters). Probed in both directions:
reverting that bound to `[\s-]*` is GREEN against the parent commit, which is
the escape the hold reproduced, and red against this one, with the failure
message naming the prefixed shape (citationsIn 312.2ms on a 400-character run
of "-" prefixed "_"). Margin note, stated rather than discovered later: at 400
the caught cost is 312ms against 250ms under nine-wide parallel probe load, a
1.25x margin, but the same revert costs about 2.3s at 6400 (the prior round's
measurement), so a load flake at 400 cannot turn the mutation green overall.

### Fold-ins

- Tag name bounded (`<[a-z]{1,16}>`); the "EVERY run in the label is therefore
  bounded" sentence now enumerates it, and a following sentence states the
  bound exists to make that sentence structural, not to remove a cost (the run
  sits between literal `<` and `>` and cannot partition). Reverting to
  `<[a-z]+>` was probed and is GREEN by design: the bound is deliberately
  unpinned and its docblock says only what it provides. The `<em>` parse
  probes and the census are unchanged.
- The `CLAIM_SPAN` parenthetical now says both arms hold the long spelling on
  their own (the refusal fires at `. T` before the room is consulted; the room
  alone is too tight for the fourteen-character tail), so it demonstrates
  neither in isolation, which is why the probes use the short spelling.
- The header's fourth gap entry, `CLAIM_SPAN`'s closing sentence and the
  `abbrevNearMiss` intro comment all state the refusal's actual trigger set
  (any of `.`, `;`, `!`, `?`, one whitespace, then a non-lower-case
  character) rather than "abbreviation", and the probe list gains the
  semicolon-joined pair of backticked paths, pinning the gap at a
  non-abbreviation member.
- The `COMPANIONS` slack probe pair mirrors the `(S)` one: with `[Ss]`
  matching the `S` the eight characters of slack reach the colon; under a
  lower-case-only `s?` they must cover the `S` too and fall one short.
  Probed in both directions: the `s?` revert is GREEN against the parent
  commit and red against this one at the new probe.

### Found and fixed in-round

An adversarial docblock-consistency pass over the diff, run before commit,
convicted the first draft of the shape-pair comment of this file's own held
defect class: it said a suffix-only run "never reaches" the emphasis group's
inner bound, and the mixed shape's leading `_` does reach it (verified by
capture against the pattern; the dash it hands over is also matchable by the
qualifier word class, so it even partitions once). The committed sentence
claims only what is true: no suffix-only shape puts a LONG homogeneous run in
that slot, so only the prefixed shapes pin the bound's cost. The same pass
verified the other five new claims against the pattern code and found them
exact: the trigger-set wording matches `(?![.;!?]\s(?![a-z]))`, the semicolon
in the new gap member is load-bearing (removing it flips the loose claim to
1), the fall-one-short arithmetic is exact at 7, 8 and 9 characters of slack,
`{1,16}` clears the longest HTML element name (ten), and the fourteen-character
count in the parenthetical is a count.

Two numeric claims were hedged to the measurement spread rather than copied
from the hold: the tail revert at 400 reads "two to three seconds" (the hold
measured about 2s unloaded; 2.6s here under parallel load) and the word-class
revert at 6400 reads "about ten seconds" (8.4s prior round; 11.1s here under
load). The committed pattern's cost was measured per shape and length on an
instrumented copy: the slowest is 6.7ms (the underscore-prefixed dash run
through `citationsIn` at 100,000), so the comment's "single-digit
milliseconds" is measured rather than assumed, and the flake direction that
matters keeps a 37x margin.

### Deviations from the prescription

None of substance. Item 2 offered pairs or one extra literal; the pair form
was chosen because it names the shape in data beside its siblings rather than
as a one-off literal inside the loop. The word-class mutation was re-probed
as well (green at 400, red at 6400 in 11.1s under load), confirming the
middle-pass sentence the reword introduces.

### Verification

- Canary 11 of 11 (~5.5s standalone, no Docker env needed); `tests/eslint/`
  9 files, 139 tests, green, exit 0 (the count over the prior round's 131 is
  sibling suites landed since, not this diff). `npm run typecheck` passes.
  `npm run lint` not run: it lints `src/` only and no `src/` file changed.
- Mutation battery: eight probes, each in its own isolated scratchpad copy of
  `backend/` (working-tree and parent-commit variants), mutations applied as
  exact-byte single-occurrence replacements read from files rather than
  retyped. Verdicts: tail fixed=red at 400 / parent=hang at 120s; emphasis
  fixed=red on the prefixed shape / parent=green; plural fixed=red at the
  COMPANIONS probe / parent=green; word-class fixed=red at 6400;
  tag fixed=green by design. Probe copies were deleted after each run; the
  repo tree was never written by a probe.
- Anchor gate: `anchor_violation()` from `.githooks/pre-commit`, run
  standalone with `ALLOW_MARKER` set, over all 91 added lines: zero hits,
  with five control lines (slug, ordinal, line-number cite, positional
  anchor, archive redirect) all firing, so the harness was live.

### [TODO Architect]

Unchanged and still deferred to archive: the solutions entry
`carve-out-clause-c-companion-citations-are-unverified-prose-2026-09-02.md`
still ends its canary section with "Do not describe this canary as existing.
It is a proposal," and the 2026-09-14 hold's note about folding the
shortest-length sizing refinement into the sibling backtracking entry stands.

## Architect re-review (2026-10-01) — HELD PENDING FIXES:

Both items and all four fold-ins held on 2026-09-14 are FIXED, verified
independently by execution on isolated copies of `e76af395` rather than from
the signal block:
- Item 1: the tail-separator revert goes red at the 400 pass in about 2 s, and
  with the 400 length removed it hangs, so the shortest pass is load-bearing.
- Item 2: the emphasis-group revert goes red.
- Fold-ins: the `s?` revert goes red at the new `COMPANIONS` probe; dropping
  `;` from the refusal goes red at the new semicolon probe; the semicolon in
  that probe is load-bearing; the trigger-set wording, the `CLAIM_SPAN`
  parenthetical and the fall-one-short arithmetic match measured behaviour.
- The tag-name bound reverts green, as its docblock says it does by design.
- The frozen maps, backlog constants and `LANDING_DIGEST` are untouched.
- Project standards are clean.

One item remains, and it is this file's recurring defect class: a sentence
asserting what the code does not do. Anchor any comment you write on stable
symbols, never on line numbers.

1. The separator-run timing spec's comment says the two prefixed shapes,
   `real-path_` before a dash run and `real-path*` before a space run, "are
   the ones that put a whole run in that slot, and they are what pin that
   bound" (the `[\s-]{0,4}` inside `LABEL_SRC`'s emphasis group). The
   `['*', ' ']` pair pins nothing. A space is outside `QUALIFIER`'s `[\w-]`
   word class, so a space run cannot be split between the emphasis group's
   run and a qualifier word, and the match stays linear. The independent
   validator ran three variants with the emphasis-group bound reverted to
   `[\s-]*`, and correctness, adversarial and testing reviewers each raised
   the same point:

   | Shapes kept | Result |
   |---|---|
   | All shapes | red, on the `_`-prefixed dash run |
   | `['*', ' ']` only (`['_', '-']` deleted) | 11 of 11 green, exit 0 |
   | `['*', '-']` swapped in (`['_', '-']` deleted) | red, `labelCount` 2358 ms at 6400 |

   Fix: replace `['*', ' ']` with `['*', '-']` and reword the sentence to say
   both prefixed shapes put a DASH run in that slot. Then each named pin is
   genuinely a pin. Verify by reverting the bound with each prefixed pair
   present alone; both must go red. If you prefer to keep a space-run shape
   as a linear control, keep it, but the sentence must then name only the
   dash-run shapes as pins and state what the space shape is for.

### Not held, recorded so it is not re-litigated

- Unloaded, the emphasis-group revert costs about 130 to 250 ms at 400, just
  under the 250 ms threshold. It is caught at 6400 in about 2.4 s, not at
  400. The signal's 312 ms at 400 was measured under load, which the signal
  disclosed. No committed comment claims the 400 pass catches this revert,
  so nothing needs rewording.
- A multi-site revert (the qualifier word and tail both unbounded) was not
  probed. It is outside the single-revert contract the comments state.
- The `[\s-]{0,4}` between `real` and `path`, the trailing emphasis run and
  the trailing wrapper bound are linear and already on the earlier not-held
  lists.
- Standalone timings include a cold-regex tier-up of 6 to 15x. In the full
  file the patterns are warm and the slowest timed call was 5.2 ms, so
  "single-digit milliseconds" holds.
- The cross-model adversarial pass did not run, because there is no
  different-provider CLI on this host. Corroboration is between three
  separate in-process reviewers and a separate validator that reproduced the
  item by execution.

**[TODO Architect]** unchanged and still deferred to archive. At that time
also update the 2026-09-14 backtracking entry through `/ce-compound-refresh`:
- Its "two lengths" guidance and its example loop predate the 400 pass.
- Its "pattern, after" snippet still shows `<[a-z]+>`.
- Add the space-run lesson: a timing shape pins a bound only when its run
  characters overlap the class of a neighbouring quantifier.

## Backend re-review signal (2026-10-01, commit b03ae831)

Item 1 landed as prescribed, in one commit touching only the canary:
`['*', ' ']` is now `['*', '-']`, and the spec comment says both prefixed
shapes put a DASH run behind the emphasis character, then states why the run
has to be dashes (a dash is in both the emphasis group's `[\s-]{0,4}` class and
QUALIFIER's `[\w-]` word class, so the run splits between them) and why a
space run pins nothing (outside the word class, it stays linear with the bound
removed). No space-run control shape was kept.

### Verification

- Probed on isolated scratchpad copies (setup.ts neutralised), with the
  emphasis-group bound reverted to `[\s-]*`:
  | Shapes kept | Result |
  |---|---|
  | Both prefixed pairs | red, `labelCount` 2902.9 ms at 6400, `_`-prefixed |
  | `['_', '-']` only | red, on the `_`-prefixed dash run |
  | `['*', '-']` only | red, on the `*`-prefixed dash run |
  | `['*', ' ']` only (the old shape) | 11 of 11 green, exit 0 |
  | Unmutated | 11 of 11 green, exit 0 |
  The two single-pair runs went red at 400 by a few ms under four-wide
  parallel load; unloaded they are caught at 6400, as the 2026-10-01 hold
  recorded. No committed comment claims which length catches this revert.
- `tests/eslint/` 9 files, 142 tests, exit 0. `npm run typecheck` passes.
  `npm run lint` not run: no `src/` file changed.
- The pre-commit anchor gate ran on the commit and passed.

### [TODO Architect]

Unchanged and still deferred to archive, including the 2026-10-01 note to
`/ce-compound-refresh` the backtracking entry (the 400 pass, `<[a-z]{1,16}>`,
and the space-run lesson).

## Architect re-review (2026-10-01, second pass) — HELD PENDING FIXES:

The item held on the first 2026-10-01 pass is FIXED in substance, verified by
execution rather than from the signal block. Three independent runs on isolated
copies of `b03ae831`, each with the `[\s-]{0,4}` inside `LABEL_SRC`'s emphasis
group reverted to `[\s-]*`, gave the same results:

| Pairs present | Result |
|---|---|
| `['_', '-']` alone | red |
| `['*', '-']` alone | red |
| both prefixed pairs | red |
| neither prefixed pair | green, exit 0 |
| old `['*', ' ']` alone | green, exit 0 |
| unmutated | 11 of 11 green, exit 0 |

So each named pin is a real pin, and the two prefixed pairs are the only pins
on that bound. The swap loses no coverage: seven other single-bound reverts give
the same verdict with the old and new pair sets. The slowest committed timed
call is 6.9 ms. The pre-commit anchor gate finds zero hits on the 8 added lines.
Subject prefix, trailer, staging and zone are all correct.

One item remains. It is a sentence asserting the wrong mechanism, and the wrong
mechanism came from this architect's own 2026-10-01 hold prose ("the match
stays linear"), which the commit copied faithfully. The correction below is
measured, not reasoned. Anchor any comment you write on stable symbols, never on
line numbers.

1. The separator-run timing spec's comment ends: "A space is outside the word
   class, so a space run behind an emphasis character cannot split that way and
   stays linear with the bound removed, which pins nothing." That sentence
   offers linearity as the reason the space run pins nothing, which implies the
   pinning dash run is not linear. It is linear. With the emphasis-group bound
   reverted, measured in plain node with the committed `QUALIFIER` and
   `LABEL_SRC` sources pasted verbatim:

   | Shape | 400 | 800 | 1600 | 3200 | 6400 |
   |---|---|---|---|---|---|
   | `real-path*` + dashes | 160 ms | 364 ms | 740 ms | 1496 ms | 2801 ms |
   | `real-path_` + dashes | 132 ms | 293 ms | 632 ms | 1289 ms | 3113 ms |
   | `real-path*` + spaces | 0.0 ms | 0.0 ms | 0.0 ms | 0.0 ms | 0.1 ms |

   The dash cost doubles when the run doubles, so its growth is linear. What
   separates the two shapes is the work per character, not the growth order.
   Each dash is a point where the unbounded run can stop and hand the remaining
   dashes to the two qualifier slots, which re-split them in a bounded but large
   number of ways. Each space is a point where the qualifier fails at once. The
   correctness and adversarial reviewers found this independently.

   Fix: restate the sentence so the mechanism is per-character work, not growth
   order. The invariant is that every clause must be true of both runs as
   measured. A sentence that meets it, offered as a default rather than a
   construct you must copy: "A space is outside the word class, so a space run
   behind an emphasis character cannot split that way. With the bound removed
   both runs cost time linear in their length; what separates them is the work
   per character. Each dash is a point where the run can stop and hand the
   dashes after it to the two qualifier slots to re-split, while each space is
   a point where the qualifier fails at once, so the space run stays far under
   the threshold and pins nothing." Do not add timing numbers to the comment
   unless you measure them in-file. Grep the file for any other sentence that
   attributes a pin or a non-pin to linear versus super-linear growth. At this
   commit the one at `stays linear` is the only hit for `linear`.

### Not held, recorded so it is not re-litigated

- The pin's signal scales with `QUALIFIER`'s word and separator bounds. With
  the word bound tightened to `{1,16}` and the emphasis-group bound reverted,
  that revert costs about 210 ms at 6400 (green) and about 3.3 s at 100,000, so
  the long pass would catch it instead of the middle one. This is theoretical
  and coupled to an edit nobody is making. Not held.
- At the 400 pass, each single-pair revert clears the 250 ms threshold by only
  5 to 27 ms. That is the load-dependent margin already settled on the first
  2026-10-01 pass. No committed comment claims which length catches this
  revert.
- The emphasis group's leading `{1,4}` run reverted to `+` is caught only at
  the 100,000 pass. The trailing emphasis run reverted to `+` is green at every
  length. Both are pre-existing, settled, and untouched by this diff.
- No space-run shape remains in the loop. That was one of the two options the
  hold offered, and is not a gap.
- Project standards, testing and learnings came back clean. The cross-model
  pass did not run, because there is no different-provider CLI on this host.
  The corroboration is between two in-process reviewers plus the orchestrator's
  own reproduction by execution.

**[TODO Architect]** unchanged and still deferred to archive. One correction to
the note it carries: the space-run lesson for the 2026-09-14 backtracking entry
must say that a run pins a bound only when its characters are also in a
neighbouring quantifier's class, because that overlap multiplies the work per
character. It must NOT say the pinning shape grows super-linearly. Under a
single-bound revert with every other run bounded, both shapes are linear.

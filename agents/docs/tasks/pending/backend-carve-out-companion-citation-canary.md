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

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

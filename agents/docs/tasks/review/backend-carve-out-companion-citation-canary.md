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

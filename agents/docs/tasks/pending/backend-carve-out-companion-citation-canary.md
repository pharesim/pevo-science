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

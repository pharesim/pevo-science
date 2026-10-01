# The loose-claim guard accuses the prose its own docblock cites as protected

**Owner:** backend
**Created:** 2026-10-01

## Why

The `LOOSE_CLAIM_SRC` docblock in
`backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts`
reads: "The room after the noun stays tight: prose about a real code path and
some unrelated companion thing ("running on the real path with a mocked
companion here:") is common, and every extra character of slack there accuses
more of it." A reader takes that example as prose the tight room protects.

It is not protected. Measured on 2026-10-01 against an isolated copy of HEAD,
on the normalised text:

| Input | `labelCount` | `unparsedClaims` | `ratchetClass(blockShape(...))` |
|---|---|---|---|
| `running on the real path with a mocked companion here: the pool is stubbed` | 0 | `["real path with a mocked companion here:"]` | `unparsed` |
| `This drives the real path with a mocked companion: getAppPool is stubbed.` | 0 | `["real path with a mocked companion:"]` | `unparsed` |

The window after the noun is `{0,8}`, and ` here` is five characters, so the
colon is in reach. A block carrying either sentence is an `unparsed` violation.
The ALLOW_MARKER exempts it, so an author has a way through, but the docblock
gives no hint that the marker is needed. No corpus file contains this shape
today. The previous implementation round recorded it as found and not fixed,
and confirmed it predates that round.

The finding here is the sentence, not only the behaviour. A docblock that
implies a guarantee the code does not provide is the defect class this canary
has been held for in nearly every round.

## Scope

1. Correct the `LOOSE_CLAIM_SRC` docblock to measured behaviour. Either its
   example becomes one the guard actually refuses, or the docblock says
   plainly that this prose shape is accused and names the marker as the
   author's remedy.
2. Decide whether to narrow the guard so that prose shaped like the example is
   not accused. The constraint is recall: every existing near-miss probe must
   keep its current `unparsedClaims` count. Note that the obvious filter,
   refusing a span whose filler's first word is a stop word, would drop the
   pinned near-miss `(c) REAL-PATH (also routes/foo.test.ts) COMPANION: covered`
   (one of the casing-recall probes, pinned at 1), whose filler's first word
   is `also`. If no narrowing preserves every near-miss
   probe and the corpus census, keep the behaviour, fix the docblock, and add
   this shape to the header's list of known precision costs.

## Acceptance criteria

1. The docblock's example and wording match measured behaviour, and a probe
   pins the example at its stated count: 0 if the guard now refuses it, 1 if
   the docblock names it as accused.
2. If the guard is narrowed, every existing `unparsedClaims` near-miss probe
   returns its current count, the whole-tree census is unchanged, and the new
   arm has a probe that goes red when the arm alone is neutered.
3. The canary is green. `LANDING_FREE_PROSE`, `LANDING_FILELESS`, both
   deferred maps and `LANDING_DIGEST` are untouched.

## Notes

This task and two sibling tasks edit the same canary file:
`backend-carve-out-canary-mixed-script-confusable-set` and
`backend-carve-out-canary-reverse-declaration-in-mocking-file`. Land them one
at a time. Anchor any comment you write on stable symbols, never on line
numbers, task slugs or round numbers.

Reproduce on a probe copy built per the backend probe recipe, never in the
shared checkout. Apply `normalizeCommentText` before calling `unparsedClaims`,
`labelCount` or `blockShape`, as `auditSources` does. Console output is
silenced in this suite, so write results to a file with the already-imported
`writeFileSync`.

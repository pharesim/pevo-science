# Add a reciprocal port pointer to backend/tests/support/enclosing-symbol.ts

**Owner:** backend
**Created:** 2026-09-01

Routed out of the architect review of the first frontend source-discipline canary
(`ui-factor-resolver-source-discipline-canary`). The architect has ratified that the
two `enclosing-symbol` implementations stay as deliberate dialect divergence rather
than a shared cross-zone module; this task adds the one cheap mitigation that
decision needs.

## Why

`frontend/tests/unit/eslint/enclosing-symbol.js` is a hand-port of
`backend/tests/support/enclosing-symbol.ts`. Roughly 65-70 of its non-docblock lines
are a near-literal, dialect-adjusted copy, including the closing-brace / indentation
walk (the highest bug-risk region). The two files legitimately diverge (the frontend
adds Alpine method-shorthand and template-literal declaration shapes and a per-key
occurrence tally; the backend has `isCommentedOut` the frontend dropped), so a shared
module is not warranted.

The one real cost of the divergence is that a future bugfix to the shared brace-walk
logic has no forcing function to reach the sibling copy. The frontend docblock already
acknowledges the port one-directionally; the backend file has no pointer back.

## Scope

1. Add a one-line pointer in `backend/tests/support/enclosing-symbol.ts`'s docblock
   naming `frontend/tests/unit/eslint/enclosing-symbol.js` as a hand-ported sibling,
   so a future change to the shared closing-brace / indent walk prompts checking the
   frontend copy. Anchor it on the file path and the shared-algorithm description, not
   on this task's slug.

## Acceptance criteria

1. `backend/tests/support/enclosing-symbol.ts` carries a docblock note pointing at the
   frontend sibling and naming the shared walk as the thing to keep in sync.

## Notes

Docblock-only, no code change. This is the backend-zone half of a decision recorded in
full on the canary task; the frontend canary itself needs no change for this item.

## Backend implementation note (2026-09-06)

Landed as one paragraph at the tail of the file docblock in
`backend/tests/support/enclosing-symbol.ts`. It names the sibling by path and
names the shared walk (the upward declaration scan plus the
closing-brace-at-or-left-of-indent test) as the thing to keep in sync.

One item beyond the literal scope, surfaced and user-approved before it landed.
The same docblock claimed `enclosingSymbol` is "exercised by planted positives
and negatives in its own test file". No such file exists and none ever did: the
planted probes live in three consuming canaries
(`no-session-proof-mint-outside-reauth-routes`,
`no-custody-claim-derivation-outside-helper`,
`no-session-consume-without-revocation-epoch`), and the frontend hand-port
already carries the corrected wording. The sentence now reads "in the canaries
that consume it". It is the same false-citation class the new pointer exists to
warn about, and the correction demonstrably failed to travel back across the
port, so it was fixed in the same edit rather than deferred.

The `{@link isCommentedOut}` divergence clause was re-checked against the
frontend copy after ui commit 7aa6a31e added `blockCommentInterior` there. That
function is not a renamed equivalent: it filters less where `isCommentedOut`
filters more (its `insideRegion` argument only disambiguates a leading `*`,
behind a shape gate that already returned false for a block-toggled live line),
and the frontend's own `isCommentLine` docblock states a commented-out walk is
absent there and "needs a commented-out walk of its own, re-derived, not
inherited". The clause is accurate as written.

Verification: `npm run typecheck` (src + tests) clean; `npm run lint` clean
apart from a pre-existing unrelated warning in `src/lib/author-supersession.ts`;
`tests/eslint/` plus `tests/routes/session-proof-invalidation.test.ts` green (9
files, 124 tests); the `.githooks/pre-commit` anchor gate exits 0 against the
staged diff. Docblock-only, no code change, so no test was added; the added
lines are prose and the canaries that exercise the module are the replacement
verification. The frontend file was not touched.

---

**Architect note (2026-09-08):** the `{@link isCommentedOut}` divergence re-check above was done
against ui commit `7aa6a31e`. The frontend canary's round-3 tail commit `72dbaa69` subsequently
added the template-literal-state and close-follows guards to `blockCommentInterior` and a
mid-line-close re-read to the brace walk, and a round-4 hold now adds a `//`-arm fix and
per-branch probes on the same module. Re-confirm the clause against the frontend file at its
then-HEAD at this task's review intake; the divergence itself (backend filters more, frontend
filters less) is expected to stand.

## Architect re-review (2026-09-08) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on `ffc2d476` (correctness, adversarial, project-standards,
testing, learnings). The correction half is a strict improvement and is accepted: planted
positive AND negative probes really do live in the consuming canaries, so
"in the canaries that consume it" is accurate where "in its own test file" was not.
Project-standards came back clean: no anchor-rot class in the added lines, and the
pre-commit anchor gate passes.

The new "Hand-ported sibling." paragraph is held. It describes a synchronization state that
was already false when it was written, which is the same defect class the paragraph exists to
warn about. Both items below are one paragraph and one rewrite; decide the shape once.

1. **The pointer aims outbound while the drift is inbound.** The closing sentence says a change
   to the walk *here* is a prompt to read the other copy. The frontend walk carries
   block-comment-region state (`inBlockComment`, seeded from `blockCommentInterior`) that this
   walk has no equivalent of: `enclosingSymbol` here skips any line whose trimmed text starts
   with `*` or `//`. Run both on a `*/` that shares its line with the real closing brace and
   they disagree, with this copy returning the inner symbol where the frontend returns the
   correct outer one. That miss resolves INWARD, the direction this file's own fail-closed
   argument says set-equality cannot catch. The frontend hardening landed before `ffc2d476`, so
   the sentence was inaccurate on arrival. Make it bidirectional and name the frontend copy as
   currently ahead on the comment walk.

2. **The divergence enumeration understates the split, and one verb is wrong.** All four stated
   facts are individually true, but the frontend also exports `blockCommentInterior`, takes an
   `insideRegion` argument on `isCommentLine`, counts template-literal backticks inside the
   brace walk, and returns `{ sources, foreign }` from `sourcesUnder` where this module returns
   a bare array. Read as an exhaustive list, the paragraph tells a maintainer the walk is in
   sync and that this copy is the more comment-aware one. Neither is true.

   **Preferred shape: replace the per-feature inventory with the shared invariant plus an
   explicit "the sibling's walk has already grown guards this one has not."** Per
   `agents/docs/solutions/conventions/comment-sweep-expansion-must-audit-added-clause-behavioral-accuracy-2026-05-20.md`,
   an enumerated clause is a stale-by-default anchor: nothing fails when a future edit to
   either file makes one listed fact false, and no mechanical gate screens for that drift.
   Extending the list instead is acceptable if you would rather keep the detail, but then it
   has to name the region pass and the `foreign` census, and it inherits the re-verify cost on
   every future edit to either file.

   Separately, fix the verb regardless of which shape you pick: `git log -S 'isCommentedOut'`
   on the frontend path returns no commits, so that copy never carried it and then removed it.
   "which that copy dropped" should read "which that copy has no equivalent of".

Anchor the rewritten paragraph on the sibling's path and on exported symbol names. No commit
SHAs, no task slugs, no round numbers, and no line numbers in the docblock text itself.

**Dismissed, do not action:** a probe asserting the cited sibling path still resolves on disk
(anchor 50, theoretical; the frontend's own suite imports that exact path and would break
first). **Out of scope, ui-zone:** the frontend docblock cites "the backend port" with no path,
so the reciprocity is still asymmetric. That is a ui-slug edit and is not required for this
task to archive.

**Routed out, not yours to fix here:** the review surfaced a live detection hole in
`isCommentLine` and a reachable counterexample to the SET-EQUALITY fail-closed argument. Both
are pre-existing and are filed separately as `backend-comment-predicate-region-awareness`. Do
not widen this task to cover them.

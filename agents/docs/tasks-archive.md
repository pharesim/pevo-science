## The publish spec never pins the $nextTick mount routing or the template x-ref names (archived 2026-10-05) — clean review at afa2237b; edit-spec observation moot at HEAD

### Architect archive note (2026-10-05)

Review of afa2237b with /ce-code-review (full: correctness, project-standards, testing,
adversarial in-process, julik-frontend-races, learnings). Reviewers read git-show copies
of the reviewed tree, because five later ui(drafts) commits rewrote publish.js and
extended the spec after afa2237b. Zero findings at any severity. The architect
re-measured every signal-block claim in isolated copies at afa2237b: spec 81 passed /
exit 0 / no Errors line; full unit suite 87 files / 1977 tests / exit 0; the $nextTick
unwrap fails `builds one editor per ref present when init runs` with "expected spy to
be called 1 times, but got 0 times", and each x-ref rename fails `declares the x-ref
names _mountEditors reads in the template`. At HEAD c3e921ff the spec runs 99 passed,
the unwrap mutant is still killed, and publish.js still holds exactly one $nextTick
call site and both x-refs, so the count comment's invariant still holds.

Residual, accepted and not filed: the count pins the number of dispatches, not what
runs inside the callback (an inline mount beside an unrelated $nextTick stays green).
The implementer disclosed this survivor class, the comment claims only the count, and
the mount reads $refs after its dynamic import, so production impact is nil.

The implementer's observation about the edit spec's "refs assigned afterwards are inert"
sentence is moot: 4882cd42 replaced edit.js's _editorsInitialized latch with a
mount-generation counter and removed that sentence along with its describe (now `the
form mounts the editors on every render`). Nothing filed. No /ce-compound.

### Task file

**Owner:** ui
**Created:** 2026-09-28

Measured during the architect re-review of the edit-spec mount-coverage
task, by probes in isolated copies (pages-publish spec baseline 76 passed /
exit 0):

- `frontend/src/pages/publish.js` holds exactly one `$nextTick(` call site,
  which schedules `_mountEditors()`, and its template carries the same
  `x-ref="abstractEditor"` / `x-ref="bodyEditor"` pair `_mountEditors`
  reads.
- Unwrapping that `$nextTick` block to a bare `this._mountEditors()`
  SURVIVED the publish spec: 76 passed, exit 0.
- Renaming the template's `x-ref="abstractEditor"` likewise SURVIVED.

This is the twin of the two pins the edit spec now carries in its
`a successful load mounts the editors` describe: the exact-count `$nextTick`
routing assertion and the template `toContain` case over both x-ref names.
`pages-publish.test.js` already has the `_mountEditors teardown-during-init
guard` describe and the mocked `createEditor` harness, but nothing drives
the real mount-scheduling path and nothing reads the template. Mirror the
edit spec's two pins, adapted to publish.js's own structure:

1. A case on the real mount-scheduling path asserting the mount effect
   (`createEditor` once per present ref, `_editorsInitialized` true) AND the
   `$nextTick` routing. Before pinning an exact call count, verify
   publish.js's `$nextTick` call-site inventory on the tested path, and
   state the invariant the count rests on in the comment, no broader than
   what the assertion enforces.
2. A template case asserting the publish page's exported template carries
   both `x-ref` names `_mountEditors` reads.

## Constraints

- `frontend/tests/unit/pages-publish.test.js` only; nothing under
  `frontend/src/`.
- Check the publish spec's harness first: if its component factory does not
  already mock `$nextTick` as a synchronous spy the way the edit spec's
  `createComponent` does, mirror that harness shape; the mock stays
  synchronous either way.
- Comment anchors on stable symbols (`_mountEditors`, `$nextTick`, the
  template export name), never task slugs, hold ordinals, line numbers or
  SHAs; the pre-commit anchor gate refuses otherwise.
- Proof-first in isolated scratchpad copies, never the shared checkout: show
  both mutants surviving before the change and killed after, one fresh copy
  per probe.

## Acceptance criteria

1. Unwrapping the `$nextTick` mount-scheduling block in a scratchpad copy of
   `publish.js` fails at least one test; cite the failing case name and
   message in the signal block.
2. Renaming either template `x-ref` in a scratchpad copy of `publish.js`
   fails the template case.
3. `npx vitest run tests/unit/pages-publish.test.js` reports no Errors line
   and exits 0, with no existing test removed or weakened.
4. The full frontend unit suite exits 0 in an isolated two-level copy.

UI implementation signal (2026-09-30, commit afa2237b):

Landed in `afa2237b` (`frontend/tests/unit/pages-publish.test.js` only; an
ancestor of main, verified with `git merge-base --is-ancestor`). A new
`init mounts the editors` describe holds both pins.

Harness check: the publish spec's `createComponent` already mocks
`$nextTick` as a synchronous spy (`vi.fn((fn) => fn && fn())`), the same
shape as the edit spec's, so the harness is unchanged.

`$nextTick` inventory on the tested path: `init` holds publish.js's only
`$nextTick` call site, and nothing init reaches (`createTimerGuard`,
`_mergeCitationCollection`, `_loadAccreditedDirectory`) calls it. The only
other `nextTick` hits under `frontend/src` are in `edit.js` and the
`getting-started.js` template. The comment on the count states only that
init dispatches through `$nextTick` exactly once.

Probes, one fresh scratchpad copy each. The baseline spec at HEAD before
the change ran 79 cases (not the 76 measured when this task was filed; no
case was removed or weakened, the diff is additive plus one import).

- AC 1, `$nextTick` block unwrapped to a bare `this._mountEditors()`:
  before 79 passed / exit 0 (survived); after exit 1, failing case
  `publishPage > init mounts the editors > builds one editor per ref
  present when init runs`, message `AssertionError: expected "spy" to be
  called 1 times, but got 0 times`.
- AC 2, `x-ref="abstractEditor"` renamed: before survived; after exit 1,
  failing case `publishPage > init mounts the editors > declares the x-ref
  names _mountEditors reads in the template`, message `expected '…' to
  contain 'x-ref="abstractEditor"'`. `x-ref="bodyEditor"` renamed: same
  case, same shape of message for `bodyEditor`.
- AC 3, `npx vitest run tests/unit/pages-publish.test.js`: 81 passed,
  exit 0, no Errors line (also five consecutive runs, all exit 0).
- AC 4, full unit suite in an isolated two-level copy: 87 files / 1977
  tests passed, exit 0, no Errors line.

Further mutants killed by the init case: deleting the block, duplicating
it, adding a second empty `$nextTick`, swapping which ref feeds which
editor, renaming either code-side `$refs` read. One known survivor, outside
the acceptance criteria: replacing the block with an empty
`this.$nextTick(() => {})` beside an inline `this._mountEditors()`. The
count assertion pins the number of dispatches, not what runs inside the
callback, and the comment is worded to claim no more than that.

Observation for the architect, not acted on (edit spec is out of this
task's scope): the edit spec's `a successful load mounts the editors`
comment says refs assigned after the load are inert because of the
`_editorsInitialized` latch. In publish.js the equivalent claim is false:
`_mountEditors` reads `$refs` only after its dynamic import resolves, so
refs assigned right after `init()` are still picked up (probe: moving the
`$refs` assignment after `comp.init()` stayed green). The publish comment
therefore does not carry that sentence. Whether the edit spec's sentence
holds for `loadPaperData` was not measured here.

## Add a reciprocal port pointer to backend/tests/support/enclosing-symbol.ts (archived 2026-10-05) — clean re-review at 2f27df71; declared deviation accepted; two HEAD-drift follow-ups filed

### Architect archive note (2026-10-05)

Re-review of 2f27df71 with /ce-code-review (full: correctness, adversarial in-process,
project-standards, learnings). Reviewers read scratchpad copies of both files at
2f27df71 and at HEAD 9e731556, because five later commits from the comment-predicate
task (146ce7de, 71217d5f, d0c7f771, 431cca4a, 301be50f) edited the same file, this
paragraph included. No defect in 2f27df71. Hold items 1 and 2 and the verb fix are met
(two-way obligation, inventory replaced by "neither is a subset" plus "read the
sibling", "has no equivalent", anchors on the path and exported symbols only).

User decision 2026-10-05: the declared deviation is accepted. At 2f27df71 the shared
helpers were identical in both copies (AST comparison after transpile; a 40,000-source
fuzz found 0 divergences), because a8000291 had already ported the frontend's region
handling, so "the frontend copy is currently ahead" would have been false. This ruling
supersedes the "has to say which copy is currently ahead" sentence in the Why section
below and the same ask in hold item 1: the paragraph names no direction and sends the
reader to the sibling, which is the durable form since the direction has flipped twice.

HEAD-state drift, not this task's: since 146ce7de the backend walk takes a `}` after a
read comment close at any indentation, so the paragraph's closing-brace parenthetical
no longer describes this copy, and the frontend walk resolves two such shapes INWARD.
Routed (user decision 2026-10-05): backend-enclosing-symbol-brace-gloss-and-suite-citation
(the parenthetical, plus the planted-probe sentence that omits enclosing-symbol.test.ts)
and ui-enclosing-symbol-after-close-brace-port (port chosen over decline, plus the
frontend docblock's "IS handled" sentence, its SET-EQUALITY "never a silent pass", and
its path-less mention of the backend copy). Dismissed: a cross-zone parity spec running
both copies over one fixture list (the copies diverge by design, so it needs a curated
fixture list; the shapes are latent; the reciprocal docblock pointers are the agreed
mechanism). No /ce-compound.

### Task file

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
walk (the highest bug-risk region). The two files legitimately diverge, so a shared
module is not warranted. That decision is ratified and is not reopened here.

**Corrected at review (2026-09-08).** This section originally described the divergence
as "the frontend adds Alpine method-shorthand and template-literal declaration shapes
and a per-key occurrence tally; the backend has `isCommentedOut` the frontend dropped".
That is wrong in two ways, and it is the same wrong framing the hold block at the end of
this file asks you to fix in the docblock, so it is corrected here rather than left one
screen above the instruction. `isCommentedOut` was never ported into the frontend copy
and then removed, so nothing was "dropped" (`git log -S 'isCommentedOut'` on that path
returns no commits). And the list is not exhaustive: the frontend also exports
`blockCommentInterior`, takes an `insideRegion` argument on `isCommentLine`, counts
template-literal backticks inside the brace walk, and returns `{ sources, foreign }`
from `sourcesUnder` where the backend returns a bare array.

The cost of the divergence is also not purely prospective. A bugfix to the shared
brace-walk logic has no forcing function to reach the sibling copy, and that has already
happened at least once: the frontend walk carries block-comment-region state the backend
walk has no equivalent of, and that hardening landed before this task's implementation
commit. So the pointer this task adds has to describe a two-way obligation and has to say
which copy is currently ahead. The frontend docblock acknowledges the port
one-directionally and without a path; the backend file had no pointer back at all.

## Scope

1. Add a one-line pointer in `backend/tests/support/enclosing-symbol.ts`'s docblock
   naming `frontend/tests/unit/eslint/enclosing-symbol.js` as a hand-ported sibling,
   so a change to the shared closing-brace / indent walk on EITHER side prompts reading
   the other copy. Anchor it on the file path and the shared-algorithm description, not
   on this task's slug. The originally-written "so a future change ... prompts checking
   the frontend copy" was outbound-only; see the 2026-09-08 hold block at the end of this
   file for what the wording now has to carry.

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

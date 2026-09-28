## The canary's docblock points at the store's catalog section for its own learnings (archived 2026-09-28)

Architect review (2026-09-28): CLEAN, archived without a hold. /ce-code-review on cffe3a4a
(correctness, project-standards, learnings vs the eleven-entry corpus): zero findings.
All three ACs re-verified independently by the architect: canary 29/29 and tests/eslint
139/139 both exit 0, typecheck and lint clean, anchor gate zero-hit over the added lines
with armed firing controls, and every factual claim in the paragraph checked true against
the catalog section it cites. A sibling commit (bd8e7d06) landed on the same docblock
mid-review; the reviewed paragraph is byte-identical at HEAD and the sibling's edits were
reviewed separately under their own task.


**Owner:** backend
**Created:** 2026-09-23

Filed by the architect from the decision on the canary learning cluster's retrieval shape. The
store now has a catalog, `agents/docs/solutions/README.md`, with a section headed by the path of
`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts` that lists the
entries about the canary's own reader and the question each answers. The canary itself cites none
of them, so an implementer who opens it on a red bar or a suspicious green has no route to that
section.

## Why

Eleven entries in `agents/docs/solutions/conventions/` are about this file's machinery, and each
cites a different subset of the others. The catalog section is the one door. The file every
implementer already opens is the canary, so the canary should say where the door is. It should say
only that: a per-entry list in the docblock would go stale at the next entry, because the author of
that entry is often not backend and the refresh never edits product code. A pointer to the section
is stable across entries.

## Scope

1. Add one short paragraph to the canary's leading docblock, near the KNOWN LIMITS lead-in or
   wherever the author judges a reader arriving from a red bar looks first. It says that the
   learnings about this file's reader (comment blanking, the parser oracle, the fail-closed
   sentinels, the cost probes, the differential triage) are catalogued under the file's own
   heading in `agents/docs/solutions/README.md`, and that the section is read before the reader
   is changed.
2. Cite the catalog by path only. No per-entry filenames, no task slugs, no round numbers, no
   line numbers (root `CLAUDE.md` "Comment anchors"). A `solutions/` path is the convention's
   durable class and passes the pre-commit anchor gate.
3. Nothing else in the file changes.

## Acceptance criteria

1. The docblock carries the paragraph, and it names the catalog's path and the file's own section
   heading.
2. The canary suite is unchanged and green: the canary alone, and all of `tests/eslint`.
3. The pre-commit anchor gate is zero-hit over the added lines, with a firing control.

## Notes

The blocked task about the line-map comment at `typescriptView`'s `starts`/`lineOf` pair touches
the same file. If that one unblocks first, the two edits may ride one commit; they do not depend
on each other.

## Backend implementation signal (2026-09-24, commit cffe3a4a)

`cffe3a4a` adds the paragraph to the canary's leading docblock, immediately ahead of the
KNOWN LIMITS lead-in, separated from the migrations paragraph by the blank comment line that
already closed it and from KNOWN LIMITS by one new blank comment line. Nine insertions, no
deletions, no modifications: nothing else in the file changes. SHA self-verified reachable
from `main` (`git merge-base --is-ancestor`).

Placement reasoning: everything ahead of that lead-in argues the invariant, everything from
it on describes the reader's machinery and where it stops, so the pointer sits at the hinge
an arriving implementer reaches when they start asking whether the reader misread their line
rather than whether their line is a third writer.

Wording notes, since each was a deliberate choice against an alternative:

- The arrival is widened past the red bar to a green one and a slow run, matching the three
  triggers the catalog section's own lead names.
- `recorded` is used rather than `learnings`: the latter appears nowhere in the file, the
  former twenty-one times, and is already the docblock's verb for a fact held outside the
  code.
- `the parser it is compared with at every line end` is the TypeScript-agreement paragraph's
  own phrasing, so a reader who greps it off this paragraph lands in the matching catalog
  row. `parser oracle` was rejected for appearing in neither the file nor the store.
- `among others` marks the family list non-exhaustive, so a twelfth entry cannot falsify it.
- The section is cited in place of its entries, with the reason stated, so the next author is
  discouraged from expanding the gesture into the per-entry list the shape exists to avoid.
- `none of it about the column` answers the worth-my-time question outright; it is scoped to
  what is recorded about the reader, so it makes no claim about entries not yet written.

Acceptance criteria:

1. Met. The paragraph names the catalog's path, `agents/docs/solutions/README.md`, and
   locates the section as the one headed by this file's own path, which is how the catalog
   heads it.
2. Met. The canary alone: 29 tests passed, exit 0. All of `tests/eslint`: 9 files, 139 tests
   passed, exit 0, identical to the pre-edit baseline. `npm run typecheck` exit 0;
   `npm run lint` exit 0 (one pre-existing warning in `src/lib/author-supersession.ts`, a
   file this task does not touch).
3. Met. The `.githooks/pre-commit` anchor gate returns exit 0 over the added lines. Firing
   control: the same diff plus five rot lines, one per arm (positional, slug, round/hold
   ordinal, line-number cite, and a durable-path line carrying a positional anchor to show
   the `solutions/` exemption does not spare the structural arms), reports exactly five
   violations and exit 1. None of the five is one of the paragraph's own lines, so the
   zero-hit pass is not vacuous. Both runs used a throwaway `GIT_INDEX_FILE`, leaving the
   shared index untouched.

The blocked line-map task named in Notes is still `[BLOCKED by Architect]`, so this edit rides
alone rather than sharing a commit with it.

[TODO Architect] None. The change is confined to `backend/tests/`; no API contract is affected.

## Eleven learnings name one canary, and the cite graph between them is partial (archived 2026-09-23) — decided: catalog README, no suffix on new filenames; no implementer rounds

### Architect decision (2026-09-23)

Shape chosen: a catalog `README.md` at `agents/docs/solutions/README.md`, with a section for the
canary listing the eleven and the question each answers, ordered by date. Not a hub entry: a hub is
a refresh candidate every pass, fits neither track template, and duplicates the `CONCEPTS.md` term
"Source-discipline canary", which already carries the cluster's substance in prose. Not a header
block in the canary: the file is backend zone, the newest entries came from all three roles, and
the refresh never edits product code, so the author of entry twelve usually could not maintain it.
The catalog is the one artifact in the store the refresh maintains mechanically (rows rewritten on
rename, move, consolidate, delete). `/ce-compound` has no catalog handling, so the obligation to
add a row lives in root `CLAUDE.md` "Documented Solutions", which every run reads: the run that
writes the entry appends the row in the same commit, and the architect reconciles at each refresh.
A backend task (`backend-canary-docblock-points-at-solutions-catalog`) adds a stable pointer from
the canary's docblock to the catalog section, by path only, so it never changes when an entry lands.

Category shape: not a signal. One artifact attracting many entries is the norm in a flat store of
224; `routes/papers.ts` is named in 61 and the canary in 11, rank 15. Directory moves would break
code citations the refresh does not rewrite. The decision is written in the README's header, which
is where a refresh meets it; the observation itself stays report-only and is dismissed against it.

Filename suffix: new entries carry none, per the creation skill's explicit rule (plugin updated
2026-08-31; the five undated names all date 2026-09-22, and a dated one landed today, which is the
flip-flop). The 219 dated names are not renamed. No citation anywhere used the wrong spelling for
any of the five. Recorded in the README and in `CLAUDE.md`.

Graph evidence: 55 pairs among the eleven, 8 mutual, 15 one-way, 32 silent; one hop from a door
reaches a median of 3 siblings; following links transitively reaches 9 or 10 from every door but
the oldest, which cites none of the others. The frontmatter already groups the set (`module`
containing `backend/tests/eslint` on 13 entries in five spellings; tag `canary-tests` on 15); the
spellings were left alone, the catalog names them as query keys.

**Owner:** architect
**Created:** 2026-09-23

Filed by backend out of the `/ce-compound-refresh` pass over the `backend/tests/eslint`
cluster, at the user's direction. Two investigation batches raised it independently and
neither would recommend a shape, because neither had evidence for one. The refresh applied
its per-doc edits and left this open.

## Why

Eleven entries under `agents/docs/solutions/conventions/` name
`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`. That
is the most-documented artifact in the store, out of 224 convention entries, and it is
still accreting at roughly one entry per review round.

Each entry is individually well-differentiated. The refresh tested every merge candidate
against the retrieval-value test and every one failed it: the entries answer genuinely
different questions about the same file (should this fact be hand-lexed, how are the
parser's per-line answers consumed, how is a cost probe read, how is a bound described in
prose, what does a differential's regression list mean, which assertion shape is
fail-closed, and so on). Consolidation is the wrong instrument here and the refresh did
not apply it.

What is weak is retrieval and the cross-reference graph, not the content:

- A maintainer who arrives with "why is my canary green" meets eleven doors into one room,
  and the door they pick decides which siblings they learn about, because each entry
  cross-references a different subset.
- The graph is partial in both directions. The refresh closed two gaps it had evidence
  for, and left others standing: the fail-closed sentinel entry and the restated-bound
  entry describe the same reader's machinery and are mutually silent.
- Three of the eleven landed within the last week, so whatever shape is chosen has to
  survive the next round rather than describe this one.

## Scope

1. Decide whether this cluster wants a shape beyond per-entry cross-links, and say which
   on the evidence rather than on taste. The two candidates the refresh surfaced are a hub
   entry for the file's learning ladder, and a standing "read these together" block in the
   canary's own header. They are not equivalent: a hub is one more entry that can itself go
   stale, while a header block sits in the file every implementer already opens and is
   maintained by whoever edits the canary.
2. If the answer is neither, say so in a form later refreshes can read, so the question is
   not re-raised every pass. The category-shape observation is report-only for a refresh,
   which means it returns until something settles it.
3. Whichever shape is chosen, decide who maintains it when entry twelve lands, and where
   that obligation is written down.
4. Consider whether this is a category-shape signal rather than a per-file one. If one
   artifact can accrete eleven entries in a directory of 224, the question of when
   `conventions/` wants sub-structure is the general form, and it is the architect's to
   answer.

## Acceptance criteria

1. A decision is recorded where the next refresh will meet it, naming which shape was
   chosen and why the alternatives were not.
2. If a shape is adopted, it exists: the hub entry, or the header block, with the eleven
   entries reachable from it.
3. The decision says what happens when the next entry on this file lands.

## Notes

The eleven at filing time:

- `a-parsers-line-is-not-the-readers-line-unless-built-from-the-same-split`
- `a-readers-bound-restated-at-n-sites-reads-as-sufficient-at-each`
- `backtracking-probe-terminator-must-defeat-the-pattern-tail`
- `belt-and-braces-guard-absorbs-upstream-mutation-pins`
- `canary-reader-takes-typescript-facts-from-the-parser-not-a-hand-written-lexer`
- `differential-fuzz-regressions-after-removing-a-compensating-misread-are-triaged-by-trigger`
- `new-fail-closed-outcome-must-not-reuse-an-existing-sentinel`
- `shared-constant-unification-is-not-membership-coverage`
- `source-discipline-canaries-must-assert-at-call-site-not-file-granularity`
- `source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage`
- `sql-grammar-questions-are-settled-against-a-nonexistent-relation`

A related observation, same pass, that may or may not belong with this decision: five of
the 224 convention entries carry no date suffix in their filename, all written on
2026-09-22, by all three roles. The `/ce-compound` skill instructs no suffix while the
corpus overwhelmingly carries one, nothing enforces either, and each run's context
analyzer resolves the conflict on its own. Cross-links are by filename, so the store now
has two spellings a citation can take.

## UI-HASPASSWORD-FACTOR-RESOLUTION-DIVERGENCE — Reconcile the hasPassword re-auth factor resolution across surfaces (archived 2026-09-23) — 5 rounds; consolidation at 5cd378dc + 6a1ac9f1; holds landed at ab5a2fac + bc3d6095 (r2), 46463131 (r3), e8948317 + a8e54b2b + 44f7b27b + 9d617808 (r4); round-5 re-review clean ✓

### Architect archive note (2026-09-23, round 5)

Reviewed via `/ce-code-review` on `e8948317`, `a8e54b2b`, `44f7b27b`, `9d617808`
(frontend paths only): correctness, project-standards, testing, security,
in-process adversarial, frontend-races, learnings, plus one independent validator.
Every probe ran in an isolated copy of the reviewed head, never the shared tree.

**Both round-4 items are verified genuinely landed.** Independently confirmed, not
taken from the signal: the retirement is exactly "second consecutive UNAUTHORIZED
under an observed factor" (reachable only past the first catch's non-UNAUTHORIZED
throw and the assumed-branch return), sits after the teardown check, and is
inherited by all three mint surfaces because the only `reauthModal` prompt in
`src/` lives inside `mintViaPasswordFactor`, so no re-prompt ladder can bypass it.
`clearPasswordFactorMemo` has exactly the two production callers the docblock
names. Write-on-success is asserted on all three surfaces. All five disclosed
mutation kill sets reproduced exactly (three reviewers, independently); baseline
186 across the six named suites; full suite 83 files / 1847 tests and a clean
build in an isolated archive (the three unhandled rejections are the disclosed
pre-existing `pages/edit.js` ones). Standards clean (anchor gate replayed over
all 212 added lines); security clean (every producer of `UNAUTHORIZED` at the
retry mint traced; both factors verified server-side per § 6.5 #2, so a stale or
retired memo is neither an oracle nor a bypass). The `_adoptSubject` same-subject
claim in the auth.js comment is accurate.


# The updated_at canary's scan roots miss two surfaces that can reach the database

**Owner:** backend
**Created:** 2026-09-09

Routed out of the round-3 architect review of the `accounts.updated_at` writer
canary. Pre-existing, and raised independently by two lenses in that review.

## Why

The canary scans `backend/src` (`.ts`, plus `.sql` resources) and the top-level
`backend/migrations/*.sql`. Two surfaces sit outside both:

- `backend/scripts/` ships in the Docker image and opens a pool against
  `APP_DATABASE_URL`. A maintenance script that touches `accounts.updated_at`
  is unscanned. Nothing there writes the column today, but the boundary is not
  stated anywhere in the file's scope description, so the next author has no
  signal that the tree is exempt.
- `sourcesUnder` collects `.ts` only. `.mts` and `.cts` modules under `src/`
  are compiled, emitted, and shipped, and are never walked.

Neither is reachable on today's tree, which is why this is a scope-statement
task rather than a bug. The value is that a scan whose roots do not match the
set of code that can reach the database is a guard with an unstated edge, and
the edge is exactly where a future writer would be invisible.

## Scope

Decide per surface, and state the decision in the canary's docblock either way:

1. `backend/scripts/`: either add it to the source roots (the shared walker
   needs no change), or record it as an explicit KNOWN LIMITS bullet naming the
   directory and why it is out of scope.
2. Non-`.ts` module extensions: either admit `.mts` / `.cts` in a local walker
   mirroring the existing SQL-resource walker, or record the extension set as a
   stated limit.
3. If the root set grows, raise the `sources.length` plausibility guard so it
   still means something.

## Acceptance criteria

1. Whichever way each surface is decided, the canary's docblock states the
   scanned set and the excluded set explicitly. A reader can tell from the file
   which trees are covered without reading the walker.
2. If a root is added, a writer planted in it turns the canary red,
   demonstrated by mutation.
3. The clean tree stays green.

## Note

Do not widen this into a general audit of every canary's roots. The question
here is scoped to the surfaces that can reach `accounts`.

## Backend implementation signal (2026-09-29, commit 67361efe):

Decision per surface, stated in the canary docblock's WHAT THE ROOTS ARE
paragraph and the `backend/scripts` KNOWN LIMITS bullet:

1. `backend/scripts/` stays outside the roots, recorded as an explicit KNOWN
   LIMITS bullet. Adding it to the `.ts`-only shared walker would scan zero
   files (the tree is `.js` + `.sh` today), which is coverage that reads real
   and is not. One premise correction against the task's Why: the Dockerfile
   copies `scripts/` into the build stage only (for the academic-domain
   fetch); the runtime image never ships it. The tree's one DB client
   (`reset-test-db.js`, run by Playwright's global-setup) refuses any database
   whose name does not end `_test` and only TRUNCATEs. The bullet states the
   re-open condition: a script there that writes app-DB rows is a new root,
   and admitting it means a walker that collects that script's own extension.
2. `.mts` / `.cts` admitted via a local `moduleResourcesUnder` walker
   mirroring `sqlResourcesUnder`, per the task's suggested shape. The shared
   `sourcesUnder` helper is untouched, so no sibling canary's roots widen.
   `.tsx` is admitted alongside them: adversarial review probe-verified (with
   the repo's own tsc and tsconfig) that a JSX-free `.tsx` under `src`
   compiles into the shipped `dist` (`include: ["src"]`, no `jsx` option), so
   leaving it out was the same unstated edge in a third spelling. The
   docblock states the one-way containment: everything the build can ship is
   scanned; a file scanned in vain (JSX-bearing `.tsx`, declaration files)
   errs loud at worst, never silent.
3. Plausibility guard unchanged, with reasoning: the module walker returns an
   empty list on today's tree, so `sources.length` did not move; raising the
   bound cannot detect an empty-returning walker, and a throwing one fails
   module load loudly. The guard keeps its original meaning.

Acceptance criteria:

- AC1: the docblock's WHAT THE ROOTS ARE paragraph states scanned and
  excluded sets; the `backend/scripts` bullet under KNOWN LIMITS carries the
  exclusion's why and re-open condition.
- AC2 (mutation): planted `UPDATE accounts SET updated_at = NOW()` writers as
  `.mts`, `.cts`, and `.tsx` probe files under `backend/src`. Before the
  change the canary was green with probes present (the gap demonstrated);
  after it, the column-first and table-first arms both red, naming each probe
  as `file#symbol` with its line. Probes deleted before commit.
- AC3: clean tree green — the canary 29/29, the whole `tests/eslint/`
  directory 9 files / 139 tests, `npm run typecheck` and `npm run lint` pass
  (the one lint warning is pre-existing in `src/lib/author-supersession.ts`,
  untouched by this task).

Verification beyond the ACs: three-lens adversarial review (factual claims vs
tree, comment-anchor/pre-commit-gate conventions on added lines, acceptance
refutation). Conventions lens replicated the pre-commit anchor gate against
all added lines: zero trips. Facts lens verified every claim in the added
prose against the Dockerfile, tsconfig, scripts tree, and walker code; its
one confirmed finding (the `.tsx` gap) is fixed as item 2 above. Residual
nit dismissed as pre-existing class: the local walkers do not follow
symlinks while the shared `sourcesUnder` does (no symlinks exist under
`backend/src`; same shape as the accepted `sqlResourcesUnder`).

## Architect re-review (2026-09-29) — HELD PENDING FIXES:

Round 1. Five-lens review plus an independent validation pass; all four items
below validated with scratch-copy reproduction. The change itself is sound:
AC1-AC3 re-verified independently (plants red on head for all three
spellings, green on base, clean tree green, docblock facts all true). The
items are residuals of the task's own genre: the new prose states universals
broader than the walker set, and the new walker has no standing pin. Items
1, 2 and 4 are one docblock pass. Prose fixes were chosen over walker
hardening at triage; do not widen walker traversal under this hold.

1. **JSON-module shape falsifies the roots universal.** `tsconfig` sets
   `resolveJsonModule`, so a `.json` under `src` imported by compiled code is
   emitted verbatim into the shipped `dist`, and no walker collects `.json`.
   Probe-verified: a planted `q.json` carrying the UPDATE plus an opaque
   `pool.query(q.touch)` consumer stays green while tsc emits it. In the
   WHAT THE ROOTS ARE paragraph, narrow "Every module the build can compile
   into the `dist` the image runs is in that set" so it no longer covers
   shapes nothing scans, and add a KNOWN LIMITS bullet naming
   `resolveJsonModule` with the re-open condition: a tracked `.json` under
   `src` holding statement text read by application code is a new root, and
   admitting it means a collector for that extension feeding the scanned
   set. (An empty `.json` walker today was rejected at triage for the same
   reason the task rejected an empty `backend/scripts` root.)

2. **Symlink qualification.** `moduleResourcesUnder` and the pre-existing
   `sqlResourcesUnder` gate on Dirent `isFile()`/`isDirectory()`, both false
   for symlinks, while the shared `sourcesUnder` statSyncs through them.
   Probe-verified by three lenses: a writer module behind a file or
   directory symlink under `src` is compiled and shipped by tsc yet stays
   green; the same shape as `.ts` goes red. State in the canary docblock
   (the WHAT THE ROOTS ARE paragraph or the local walkers' own docblocks)
   that the two local walkers read regular files only and do not follow
   links, that no symlink exists under `backend/src` today, and the re-open
   condition (a symlinked module or directory under `src`). Prose only; the
   walker-traversal change was dismissed at triage as hardening, consistent
   with the signal block's own `sqlResourcesUnder` dismissal.

3. **Standing pin for the module walker.** On today's tree the walker
   legitimately returns an empty list, so the walk-plausibility arm cannot
   distinguish it from a gutted extension predicate, a lost recursion, or a
   dropped spread in the `sources` merge: each of those mutations leaves the
   canary green (reproduced twice). Add a tmpdir fixture test: extract a
   combiner (e.g. `codeSourcesUnder(root)` returning the `sourcesUnder` +
   `moduleResourcesUnder` union), build `sources` from it, write a fixture
   tree with nested `writer.{ts,mts,cts,tsx}` plus a decoy non-compiled
   `.js`, and assert both the collected rel set and that the writer arms
   name each plant as `file#symbol`. Cover `sqlResourcesUnder` with a
   planted `.sql` in the same fixture (closes the identical pre-existing
   gap). The sibling companion-citation canary already pins its walker with
   this shape. Validated: red under emptied predicate, extension typo,
   dropped `.tsx`, unwired combiner and non-recursive walk; green clean.

4. **Exclusion dichotomy overclaims.** "Excluded, deliberately: every tree
   that does not ship" is false as a dichotomy: the Dockerfile production
   stage copies `backend/data` (plus `public/` and production
   `node_modules`) into the runtime image, all outside every root. Restate
   the clause: excluded trees either do not ship (tests, scripts) or ship
   only non-module data no scan reads as statements; only `backend/src`
   modules and `backend/migrations` reach the database as executable
   statements.

5. **Stated limit, not an arm (dismissal record).** Module-side runtime DDL
   (CREATE FUNCTION / CREATE TRIGGER text targeting `accounts` inside a
   scanned module's SQL string) is caught by no arm; the routine arm walks
   migrations only. Add one KNOWN LIMITS sentence acknowledging it, leaning
   on the existing accident-not-evasion scope statement. Extending
   `routineSites` over `sources` was considered and dismissed at triage;
   do not add it under this hold.

NOTE (coordination): the working tree currently carries unstaged sibling
docblock edits on the canary file, in regions outside this task's hunks.
Before any probe-restore (`git checkout --` or `git show >`), require
`git status` clean for the file per the committed-baseline discipline, and
land your docblock edits on top of whatever the sibling has committed by
then rather than rebuilding from an older blob.

## Backend re-review signal (2026-09-29, commits 35b3a3bb and 50a582dc):

Both SHAs verified as ancestors of `main`. All five items are addressed in
the canary file; no walker traversal changed, no `.json` collector added,
`routineSites` still reads migrations only.

1. WHAT THE ROOTS ARE now scopes the universal to TypeScript modules and
   points to a new `resolveJsonModule` KNOWN LIMITS entry. The entry gives
   the no-`.json`-today fact, why an empty collector is not added, and the
   re-open condition the hold prescribed.
2. New KNOWN LIMITS entry: the two local walkers read regular files and
   directories only and do not follow links, the shared `.ts` walker does,
   no symlink exists under `backend/src` today, and the re-open condition.
   The roots paragraph cross-references it.
3. `codeSourcesUnder(root)` combiner builds `sources`. A new spec plants
   `a/b/writer.{ts,mts,cts,tsx}`, a decoy `writer.js` and `writer.sql` in a
   tmpdir. It asserts the exact rel sets from `codeSourcesUnder` and
   `sqlResourcesUnder`, and exact `countsOf` maps from `columnAssignments`
   and `accountsColumnWriters` (`file#touch`, `writer.sql#<module>`).
   Mutation table, each run in a scratch copy: RED for emptied module
   predicate, `.mts` typo, dropped `.tsx`, dropped `.cts`, combiner
   dropping either spread, non-recursive module walk, non-recursive `.sql`
   walk, emptied `.sql` predicate. Two survivors are stated rather than
   pinned: `sources` pointed back at `sourcesUnder` alone, and
   `sqlResourcesUnder` dropped from `migrations`. Both are call-site wiring
   lines that no fixture can pin short of a tautology, and the second is a
   pre-existing merge the hold did not name. The `codeSourcesUnder`
   docblock records both. The first commit's message overclaimed "unwired
   merge" coverage; 50a582dc corrects the prose it describes.
4. Exclusions restated: excluded trees either do not ship (`backend/tests`,
   `backend/scripts`) or ship only data the application reads or serves
   (`backend/data`, `backend/public`, production `node_modules`). Only
   `backend/src` modules and `backend/migrations` reach the database as
   executable statements.
5. KNOWN LIMITS entry for runtime DDL in a module, leaning on the
   accident-not-evasion scope entry. Narrowed in 50a582dc after
   verification: module-side ALTERs and routine bodies spelling the
   assignment ARE read (the ALTER and writer arms span `sources`). The
   entry names the one silent shape: a trigger or rule bound to `accounts`
   whose function writes `NEW.updated_at`.

Verification: a four-lens adversarial workflow (hold fidelity, facts,
conventions, mutation), with two refuters per finding, ran on 35b3a3bb in
scratch copies. Three findings survived: the item-5 overclaim, the fixture
coverage overclaim, and a ragged wrap. All three are fixed in 50a582dc.
Refuted findings included "emitted verbatim" pedantry (tsc re-serialises
JSON) and node_modules being code rather than data; neither changes what
any scan reads. Clean tree: `tests/eslint/` 9 files / 140 tests green,
`npm run typecheck` passes, `npm run lint` has only its one existing
warning, and the pre-commit anchor gate passed on both commits.

## Architect re-review (2026-09-30) — HELD PENDING FIXES:

Round 2, on commits 35b3a3bb and 50a582dc. All five round-1 items are
verified FIXED: four reviewers each rebuilt the file from 50a582dc in their
own copy and reproduced the clean tree (canary 30/30, `tests/eslint/` 9
files / 140 tests), every RED row of the signal's mutation table, both
stated survivors, the symlink and module-DDL probes, and zero anchor-gate
hits with the control line firing. The round-1 limits held: no walker
traversal changed, no `.json` collector, `routineSites` reads migrations
only. What is left is one prose pass of three sentences, each an added
claim that does not match what the file does. Prose only under this hold:
no walker, arm, or fixture-assertion change.

1. **Three added sentences state something the file does not do.**

   a. The module-DDL KNOWN LIMITS entry names the silent shape as a
      `CREATE TRIGGER ... ON accounts` "(or a rule) whose function writes
      `NEW.updated_at := now()`". A rule has no function. A rule bound to
      `accounts` that writes the column has to spell its action as a
      statement (`UPDATE accounts SET updated_at = ...`), and the writer
      arms read that from a module like any other statement text
      (probe-verified red by the correctness lens; three lenses raised it
      independently). The entry overstates what stays green. The invariant:
      the entry names exactly the shapes no arm reads. Either drop the rule
      parenthetical, or say what a rule does and why it is read.

   b. The walker-fixture spec's opening comment says the plausibility spec
      cannot tell an honestly empty local walker from "a union in
      `codeSourcesUnder` that dropped one of its walkers". That is true of
      one walker only. Dropping `sourcesUnder` from the union empties
      `sources` and the plausibility spec goes red (probe: four failures);
      dropping `moduleResourcesUnder` is the mutation it cannot see. Name
      the walker.

   c. 50a582dc's message and the signal block both say the ragged wrap in
      the roots paragraph was reflowed. The short orphan line was fixed,
      and the reflow produced a 93-column line in its place ("this
      statement of the roots exists to close. Excluded, deliberately: every
      other tree, and") in a paragraph wrapped near 78. Rewrap the
      paragraph so no line runs past its neighbours.

DISMISSED at triage (recorded so they are not picked up under this hold):

- **Call-site wiring pin.** The lines that build `sources` and `migrations`
  stay unpinned, as the `codeSourcesUnder` docblock already says, and that
  disclosure stands as written. A pin was judged preemptive hardening:
  tripping it needs the spread dropped AND a `.sql` / `.mts` writer landing
  under `src` afterwards, and neither exists today. One correction to the
  signal block, for the record and not a code change: "no fixture can pin
  short of a tautology" is wrong. A builder returning both scanned sets from
  `(srcRoot, migrationsRoot)`, called by the fixture with the planted tree
  plus a separate tmp migrations dir, went red on both survivors in three
  independent prototypes and stayed green clean. Do not add it here, and do
  not restate the tautology claim in the next signal.
- The narrowed roots universal still literally covers a symlinked `.mts`:
  qualified two sentences later in the same paragraph.
- "the two local ones do not" follow links, while `migrationSources` is a
  third local reader that does: the KNOWN LIMITS entry names both walkers.
- "Only the modules under `backend/src` and the files under
  `backend/migrations` reach the database as executable statements": the
  round-1 hold's own wording, scoped by the paragraph's subject (what the
  image runs).
- "emitted verbatim" for an imported `.json` (tsc re-serialises it):
  already dismissed at the round-1 triage.
- The `.json` collector is refused as empty coverage while two empty local
  walkers are admitted: the difference (the fixture pins them, and the
  reader already reads their spellings) is unstated, and stays so.

## Backend re-review signal (2026-09-30, commit 078550bc):

SHA verified as an ancestor of `main`. Prose only: comment-stripped output
and the parser leaf stream are identical before and after the change. No
walker, arm, or fixture assertion changed, and no DISMISSED item was
picked up.

a. The module-DDL KNOWN LIMITS entry no longer lists a rule as a silent
   shape. It says a rule whose action spells the `UPDATE accounts SET
   updated_at = ...` statement is read by the writer arms like any other
   statement text, and names the trigger whose function writes
   `NEW.updated_at := now()` as what no arm reads. The entry's opening
   sentence was reworded with it: "a trigger or rule installed at runtime
   from a MODULE's SQL string is judged by no arm" carried the same
   overclaim, and now says the routine arm's refusal does not reach one.
b. The walker-fixture comment names `moduleResourcesUnder` as the dropped
   walker the plausibility spec cannot see, and notes that a union that
   dropped `sourcesUnder` is the one it does see.
c. The roots paragraph is rewrapped. Its longest line is the untouched
   opening line at 78 columns, and its words are unchanged.

Verification: a four-lens adversarial workflow (rule facts, walker
mutations, conventions and hold fidelity, cold read) with two refuters per
finding ran in scratch copies on the first draft. One finding survived
both refuters and is fixed in the commit: the draft said a rule is always
read and the trigger is the only shape left. Probes showed a module rule
with an `ON UPDATE TO` event and an unreadable action head (quoted
identifier, variable table) stays green, because the event clause reads as
an earlier statement head and lends its table, where the same statement
outside a rule fails closed. The committed wording claims only the plainly
spelled rule and defers the unread spellings to the list's other entries,
where the quoted-identifier entry records that lend-its-table edge. The
final wording was not re-run through the workflow; it narrows the draft to
claims the probes had already confirmed.

[TODO Architect] Triage call, not acted on here: whether the rule
event-clause edge deserves its own sentence in the quoted-identifier
entry. A rule with an UPDATE event always supplies the earlier readable
head, so the fail-closed resolution arm is bypassed for that shape.

Clean tree: `tests/eslint/` 9 files / 140 tests green with exit 0,
`npm run typecheck` passes, `npm run lint` has only its one existing
warning, and the anchor-gate patterns replicated over the added lines gave
zero hits with control lines firing.

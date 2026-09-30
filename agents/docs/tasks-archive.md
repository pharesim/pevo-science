## The updated_at canary's scan roots miss two surfaces that can reach the database (archived 2026-09-30) — three rounds, archived clean

### Architect archive note (2026-09-30)

Round 3 (commit 078550bc, prose only) reviewed clean: all three round-2 items (1a rule
parenthetical, 1b fixture comment names `moduleResourcesUnder`, 1c roots paragraph rewrap) are
FIXED, each probe-verified in scratch copies (18 plainly spelled module rules red, the
`NEW.updated_at := now()` trigger green, both walker-drop mutations as stated, parser leaf stream
identical base to head, canary 30/30 exit 0, anchor gate zero hits with control firing).
The `[TODO Architect]` question is DISMISSED at triage: a module rule with an `ON UPDATE TO`
event and an unreadable action head stays green because the event clause lends its table. The
quoted-identifier KNOWN LIMITS entry covers it by its stated condition (a readable head opening
earlier in the same quoted text), so the deferral is true as written; no sentence and no
`NOT_A_TABLE` change were filed. Noted, not raised, both pre-existing: a table swap
(`CREATE TABLE ... LIKE accounts`, copy, `RENAME TO accounts`) is read by no arm in modules or
`.sql`, and the `NEW.updated_at = now()` spelling is as silent as the `:=` form the entry names.
Final state: `backend/scripts` excluded as a stated limit; `.mts` / `.cts` / `.tsx` admitted via
`moduleResourcesUnder`; walkers pinned by a tmpdir fixture; call-site wiring lines unpinned by
decision. Full task text follows and is cut by the 250-line trim; git history has the rest.


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

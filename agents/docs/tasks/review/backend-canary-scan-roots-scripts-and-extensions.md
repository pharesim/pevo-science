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

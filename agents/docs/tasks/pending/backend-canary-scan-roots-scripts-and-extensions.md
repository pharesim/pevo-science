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
